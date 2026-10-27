import { Worker } from 'node:worker_threads';
import { parseJournalEvent, type JournalEvent } from './events.ts';
import { bufferReserve, canonicalJSON, journalPolicy, validReservedBytes,
  type JournalPolicy, type JournalResult, type JournalUsage, type JournalWorkerReply,
  type JournalWorkerRequest } from './policy.ts';

export interface JournalWriterOptions {
  directory:string;now?:()=>number;policy?:Partial<JournalPolicy>;
  /** Guaranteed reservation for all external pending-mail bytes, not a racy sample of current usage. */
  externalReservedBytes:number|(()=>number|Promise<number>);
}
interface Pending {size:number;resolve:(result:JournalResult)=>void}
interface Queued {id:number;bytes:ArrayBuffer}
/** Creation is immediate. Startup scanning and all archive/SQLite I/O run off the server thread. */
export function createJournalWriter(options:JournalWriterOptions) {
  const policy=journalPolicy(options.policy),now=options.now??Date.now;
  let worker:Worker|undefined, ready=false, busy=false, closed=false, failed=false, cleanupPending=false;
  let maintenanceDue=false,lastWork:'batch'|'maintain'='maintain',closing:Promise<void>|undefined;
  let sequence=0,pendingBytes=0,externalBytes:number|null=null;
  let lastUsage:JournalUsage|null=null;
  let idle:Promise<void>|undefined,resolveIdle:(()=>void)|undefined;
  const pending=new Map<number,Pending>(),queue:Queued[]=[];
  const unavailable:JournalResult={status:'retryable',reason:'journal_unavailable'};
  function settle(id:number,result:JournalResult) {
    const entry=pending.get(id);if(!entry)return;
    pending.delete(id);pendingBytes-=entry.size;entry.resolve(result);
    if(!pending.size){const resolve=resolveIdle;idle=undefined;resolveIdle=undefined;resolve?.();}
  }
  function fail() {
    failed=true;ready=false;queue.length=0;
    for(const id of pending.keys())settle(id,unavailable);
    clearInterval(timer);void worker?.terminate();
  }
  async function reservation() {
    const value=await (typeof options.externalReservedBytes==='function'?options.externalReservedBytes():options.externalReservedBytes);
    if(!validReservedBytes(value))throw new RangeError('Invalid external journal reservation');
    externalBytes=value;return value;
  }
  async function dispatch(maintenance=false) {
    if(maintenance)maintenanceDue=true;
    if(!ready || busy || closed || failed || !queue.length && !maintenanceDue && !cleanupPending)return;
    busy=true;worker!.ref();
    try {
      const reserved=await reservation();
      if(closed || failed)return;
      let message:JournalWorkerRequest;
      const transfer:ArrayBuffer[]=[];
      // A due cleanup survives a busy worker. When both kinds need work, each gets one bounded turn.
      if((maintenanceDue || cleanupPending) && (!queue.length || lastWork!=='maintain')) {
        maintenanceDue=false;lastWork='maintain';
        message={kind:'maintain',now:now(),externalReservedBytes:reserved};
      } else {
        const entries:Queued[]=[];let size=0;
        while(queue.length && size+queue[0].bytes.byteLength<=policy.maxBatchBytes) {
          const entry=queue.shift()!;size+=entry.bytes.byteLength;entries.push(entry);transfer.push(entry.bytes);
        }
        lastWork='batch';
        message={kind:'batch',entries,now:now(),externalReservedBytes:reserved};
      }
      worker!.postMessage(message,transfer);
    } catch {fail();}
  }
  const timer=setInterval(()=>void dispatch(true),policy.maintenanceMs);timer.unref();
  async function start() {
    try {
      const reserved=await reservation();
      if(closed)return;
      worker=new Worker(new URL('./worker.ts',import.meta.url),{
        workerData:{directory:options.directory,policy,now:now(),externalReservedBytes:reserved},
      });
      worker.on('error',fail);
      worker.on('exit',()=>{if(!closed)fail();});
      worker.on('message',(message:JournalWorkerReply)=>{
        if(closed || failed)return;
        if(message.kind==='failed'){fail();return;}
        lastUsage=message.usage;busy=false;
        if(message.kind==='ready')ready=true;
        if(message.kind==='ready' || message.kind==='maintained')cleanupPending=message.more;
        if(message.kind==='batch')for(const entry of message.results)settle(entry.id,entry.result);
        if(queue.length || maintenanceDue || cleanupPending)void dispatch();
        else worker!.unref();
      });
    } catch {fail();}
  }
  void start();
  return {
    write(input:JournalEvent):Promise<JournalResult> {
      if(closed || failed)return Promise.resolve(unavailable);
      let event:JournalEvent|null;
      try{event=parseJournalEvent(input);}catch{return Promise.resolve({status:'invalid',reason:'invalid_event'});}
      if(!event)return Promise.resolve({status:'invalid',reason:'invalid_event'});
      const bytes=new TextEncoder().encode(canonicalJSON({...event}));
      if(bytes.byteLength>policy.maxEventBytes)return Promise.resolve({status:'invalid',reason:'event_too_large'});
      if(pending.size>=policy.maxPendingCount || pendingBytes+bytes.byteLength>policy.maxPendingBytes) {
        return Promise.resolve({status:'retryable',reason:'journal_queue_full'});
      }
      const id=++sequence;pendingBytes+=bytes.byteLength;
      const result=new Promise<JournalResult>(resolve=>pending.set(id,{size:bytes.byteLength,resolve}));
      queue.push({id,bytes:bytes.buffer});void dispatch();return result;
    },
    /** Wait for the existing bounded queue; callers stop admission before draining for shutdown. */
    drain():Promise<void> {
      if(!pending.size)return Promise.resolve();
      if(!idle)idle=new Promise<void>(resolve=>{resolveIdle=resolve;});
      return idle;
    },
    async usage() {
      return {ready,diskBytes:lastUsage?.diskBytes??null,bufferReservedBytes:bufferReserve(policy),externalBytes,
        pendingBytes,pendingCount:pending.size};
    },
    /** Unconfirmed work becomes retryable; recovery determines whether an interrupted append was durable. */
    close():Promise<void> {
      if(closing)return closing;
      closed=true;ready=false;clearInterval(timer);queue.length=0;
      for(const id of pending.keys())settle(id,unavailable);
      closing=worker?worker.terminate().then(()=>{}):Promise.resolve();
      return closing;
    },
  };
}
