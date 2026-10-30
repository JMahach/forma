import type { StorageRelief } from './storage-pressure.ts';
import { parseDiagnosticProof } from '../../shared/account-contract.ts';
import { createIndexedDatabase } from './indexed-db.ts';
import { parseClientReport, CLIENT_REPORT_MAX_BYTES, DIAGNOSTIC_BATCH_MAX_BYTES, DIAGNOSTIC_BATCH_MAX_COUNT,
  type ClientReport } from '../../shared/client-report-contract.ts';

export const DIAGNOSTIC_QUEUE_BYTES=5_000_000;
export const DIAGNOSTIC_QUEUE_RETENTION_MS=7*86400000;
const CONTROL_BYTES=1024,ROW_BYTES=256,LEASE_MS=30_000;
const attemptDelay=(attempt:number)=>attempt<2?1000:attempt===2?5000:60_000;
const newOccasion=(at:number|undefined,deadline:number,time:number)=>at!==undefined && Number.isFinite(at) && at>=deadline && at<=time;
interface Control {key:'queue';epoch:number;bytes:number;count:number;sequence:number;retryAt:number;failures:number;
  lease:{owner:string;until:number}|null;scope?:string|null;accountId?:string|null;serverRetryAt?:number}
interface Stored {diagnosticProof?:string;eventId:string;sequence:number;epoch:number;scope?:string|null;createdAt:number;bytes:number;body:Uint8Array;nextAttemptAt:number;failures:number}
export interface DiagnosticQueueEntry {diagnosticProof?:string;eventId:string;sequence:number;report:ClientReport}
export interface DiagnosticBatchToken {epoch:number;owner:string}
export type DiagnosticBatch={status:'batch';token:DiagnosticBatchToken;entries:DiagnosticQueueEntry[]}
  |{status:'waiting'|'paused';retryAt:number}|{status:'empty'|'stale'|'unavailable'};
interface Options {indexedDB?:IDBFactory|null;databaseName?:string;timeoutMs?:number;now?:()=>number;maxBytes?:number}
export type DiagnosticQueue=ReturnType<typeof createDiagnosticQueue>;
const request=<T>(value:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});
async function* rows(source:IDBObjectStore|IDBIndex){const opened=source.openCursor();let cursor=await request(opened);
  while(cursor){yield cursor;const next=request(opened);cursor.continue();cursor=await next;}}
type Change={clearedEpoch?:number};
const localChanges=new WeakMap<IDBFactory,Map<string,Set<(change?:Change)=>void>>>();
const validTime=(value:number)=>Number.isSafeInteger(value) && value>=0 && value<=8.64e15-DIAGNOSTIC_QUEUE_RETENTION_MS;

function deliveryWait(value:Control,owner:string,time:number,wakeAt:number|undefined):DiagnosticBatch|null {
  if(value.failures>=3 && !newOccasion(wakeAt,value.retryAt,time))return {status:'paused',retryAt:value.retryAt};
  const until=Math.max(value.retryAt,value.serverRetryAt??0,value.lease && value.lease.owner!==owner?value.lease.until:0);
  return until>time?{status:'waiting',retryAt:until}:null;
}
// Reserve before HTTP: losing the ACK commit must not give the next sender a
// free attempt. Report bytes and their original creation time remain unchanged.
function reserve(tx:IDBTransaction,value:Control,selected:Stored[],time:number) {
  value.failures=value.failures>=3?1:value.failures+1;value.retryAt=time+attemptDelay(value.failures);
  for(const row of selected){row.failures=row.failures>=3?1:row.failures+1;
    row.nextAttemptAt=time+attemptDelay(row.failures);tx.objectStore('reports').put(row);}
}
function serverPause(value:Control,retryAfterMs:number,time:number) {
  if(Number.isFinite(retryAfterMs) && retryAfterMs>0)value.serverRetryAt=Math.max(value.serverRetryAt??0,time+Math.min(retryAfterMs,8.64e15-time));
}
async function deferRemaining(tx:IDBTransaction,token:DiagnosticBatchToken,allowed:Map<string,number>,accepted:Set<string>,time:number) {
  for(const [id,sequence]of allowed){if(accepted.has(id))continue;
    const row=await request(tx.objectStore('reports').get(id)) as Stored|undefined;
    if(row && row.epoch===token.epoch && row.sequence===sequence){const deadline=time+attemptDelay(row.failures);
      if(deadline>row.nextAttemptAt){row.nextAttemptAt=deadline;tx.objectStore('reports').put(row);}}}
}

/** One transactional queue and sender lease for every tab. No report is acknowledged in RAM. */
export function createDiagnosticQueue({indexedDB:factory,databaseName='forma-diagnostics',timeoutMs=1000,
  now=Date.now,maxBytes=DIAGNOSTIC_QUEUE_BYTES}:Options={}) {
  if(!Number.isSafeInteger(maxBytes) || maxBytes<CONTROL_BYTES || maxBytes>DIAGNOSTIC_QUEUE_BYTES)throw new RangeError('Invalid diagnostic budget');
  const database=createIndexedDatabase({indexedDB:factory,databaseName,timeoutMs,version:3,stores:['reports','control'],upgrade(db){
    // The same queue and bytes survive; versionchange retires writers that do
    // not reserve the finite retry budget. Only an
    // explicit exit may clear their remainder before a login scope was recorded.
    if(!db.objectStoreNames.contains('reports')){const reports=db.createObjectStore('reports',{keyPath:'eventId'});
      reports.createIndex('sequence','sequence');reports.createIndex('createdAt','createdAt');}
    if(!db.objectStoreNames.contains('control'))db.createObjectStore('control',{keyPath:'key'});
  }});
  let closed=false,boundEpoch:number|undefined,setupWork:Promise<boolean>|null=null,timer:ReturnType<typeof setTimeout>|undefined,cleanupFailures=0;
  let scopeCurrent:(()=>boolean)|null=null,boundScope:string|null|undefined,boundAccount:string|null|undefined;
  const active=()=>{try{return !closed && boundEpoch!==undefined && boundEpoch>=0 && scopeCurrent?.()===true;}catch{return false;}};
  const listeners=new Set<()=>void>(),actualFactory=factory===undefined?globalThis.indexedDB:factory;
  let peers:Set<(change?:Change)=>void>|undefined;
  if(actualFactory){if(!localChanges.has(actualFactory))localChanges.set(actualFactory,new Map());const names=localChanges.get(actualFactory)!;
    if(!names.has(databaseName))names.set(databaseName,new Set());peers=names.get(databaseName)!;}
  const channel=typeof window!=='undefined' && typeof BroadcastChannel!=='undefined'?new BroadcastChannel(databaseName):null;
  function atomic<T>(action:(tx:IDBTransaction)=>Promise<T>):Promise<T|null> {
    if(closed)return Promise.resolve(null);
    return database.transaction<T>('readwrite',(tx,result)=>{void action(tx).then(result,()=>{try{tx.abort();}catch{}});});
  }
  const readControl=(tx:IDBTransaction)=>request(tx.objectStore('control').get('queue')) as Promise<Control|undefined>;
  const save=(tx:IDBTransaction,value:Control)=>tx.objectStore('control').put(value);
  function setup():Promise<boolean> {
    if(setupWork)return setupWork;
    setupWork=atomic(async tx=>{let value=await readControl(tx);
      if(!value){value={key:'queue',epoch:0,bytes:CONTROL_BYTES,count:0,sequence:0,retryAt:0,failures:0,lease:null};save(tx,value);}return value.epoch;
    }).then(epoch=>{
      if(epoch===null){setupWork=null;return false;}return true;
    });return setupWork;
  }
  function remove(tx:IDBTransaction,value:Control,row:Stored){tx.objectStore('reports').delete(row.eventId);value.bytes-=row.bytes;value.count--;}
  async function prune(tx:IDBTransaction,value:Control,time:number) {
    const before=JSON.stringify(value);
    for await(const cursor of rows(tx.objectStore('reports').index('createdAt'))){const row=cursor.value as Stored;
      if(row.createdAt+DIAGNOSTIC_QUEUE_RETENTION_MS>time)break;remove(tx,value,row);
    }
    if(!value.count){value.retryAt=0;value.failures=0;value.lease=null;}
    return JSON.stringify(value)!==before;
  }
  async function nextExpiry(tx:IDBTransaction){const cursor=await request(tx.objectStore('reports').index('createdAt').openCursor());
    return cursor?(cursor.value as Stored).createdAt+DIAGNOSTIC_QUEUE_RETENTION_MS:null;}
  async function state() {
    if(!await setup() || !validTime(now()))return {status:'unavailable' as const};
    const result=await atomic(async tx=>{const value=(await readControl(tx))!;
      if(boundEpoch!==undefined && boundEpoch!==value.epoch)return {status:'stale' as const,epoch:value.epoch};
      const count=value.count;if(await prune(tx,value,now()))save(tx,value);
      return {status:'ready' as const,active:active(),epoch:value.epoch,bytes:value.bytes,count:value.count,retryAt:value.retryAt,
        leaseUntil:value.lease?.until??0,nextExpiry:await nextExpiry(tx),removed:count-value.count};
    });return result??{status:'unavailable' as const};
  }
  function schedule(expiresAt:number|null){clearTimeout(timer);if(closed || expiresAt===null)return;
    timer=setTimeout(()=>void refreshTimer(),Math.max(0,Math.min(2**31-1,expiresAt-now())));
    (timer as unknown as {unref?():void})?.unref?.();
  }
  async function refreshTimer(){const snapshot=await state();
    if(snapshot.status==='unavailable'){cleanupFailures++;if(cleanupFailures<3)schedule(now()+attemptDelay(cleanupFailures));return;}
    cleanupFailures=0;schedule(snapshot.status==='ready'?snapshot.nextExpiry:null);
    if(snapshot.status==='ready' && snapshot.removed)for(const listener of listeners)try{listener();}catch{}
  }
  function changed(change?:Change){
    // This handle existed when the notification was published. Its first open
    // may already have observed the new epoch; that never authorizes adoption.
    if(change?.clearedEpoch!==undefined)boundEpoch=-1;
    void refreshTimer();for(const listener of listeners)try{listener();}catch{}
  }
  peers?.add(changed);if(channel)channel.onmessage=event=>{
    const epoch=event.data?.clearedEpoch;changed(Number.isSafeInteger(epoch) && epoch>=0?{clearedEpoch:epoch}:undefined);
  };
  function publish(change?:Change){for(const peer of peers??[])peer(change);channel?.postMessage(change??{changed:true});}
  void refreshTimer();
  async function batch(tx:IDBTransaction,value:Control,includeDeferred=false,include:(row:Stored)=>boolean=()=>true,wakeAt?:number) {
    const entries:DiagnosticQueueEntry[]=[],selected:Stored[]=[];let bytes=128,nextAttemptAt=Infinity;
    let batchProof:string|undefined,hasAccount=false;
    for await(const cursor of rows(tx.objectStore('reports').index('sequence'))){const row=cursor.value as Stored;
      if(!include(row))continue;
      let report:ClientReport|null=null;
      try{if(row.body instanceof Uint8Array && row.body.byteLength<=CLIENT_REPORT_MAX_BYTES)report=parseClientReport(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(row.body)));}catch{}
      if(!report || report.eventId!==row.eventId || row.epoch!==value.epoch){remove(tx,value,row);continue;}
      const proof=row.diagnosticProof===undefined?null:parseDiagnosticProof(row.diagnosticProof);
      if(row.diagnosticProof!==undefined && (!proof || proof.accountId!==report.accountId || row.scope!=null && proof.sessionId!==row.scope)){remove(tx,value,row);continue;}
      if(!includeDeferred && row.failures>=3 && !newOccasion(wakeAt,row.nextAttemptAt,now()))continue;
      if(!includeDeferred && row.nextAttemptAt>now()){nextAttemptAt=Math.min(nextAttemptAt,row.nextAttemptAt);continue;}
      // One origin per HTTP header; legacy unsigned reports never borrow another login's proof.
      if(report.accountId!==null && hasAccount && row.diagnosticProof!==batchProof)continue;
      if(entries.length===DIAGNOSTIC_BATCH_MAX_COUNT || bytes+row.body.byteLength+1>DIAGNOSTIC_BATCH_MAX_BYTES)break;
      if(report.accountId!==null){hasAccount=true;batchProof=row.diagnosticProof;}
      entries.push({eventId:row.eventId,sequence:row.sequence,report,...(row.diagnosticProof?{diagnosticProof:row.diagnosticProof}:{})});bytes+=row.body.byteLength+1;
      selected.push(row);
    }
    return {entries,selected,nextAttemptAt};
  }
  return {
    state,
    /** Composition captures state().epoch, confirms its access generation is still
     * live, then activates. A read alone never admits reports. Keep isCurrent bound
     * to that exact generation; clearing/switching access revokes it synchronously. */
    async activate(expectedEpoch:number,isCurrent:()=>boolean,scope?:string|null,accountId?:string|null) {
      const live=()=>{try{return !closed && boundEpoch!==-1 && isCurrent()===true;}catch{return false;}};
      if(accountId!=null && !/^[1-9][0-9]{0,19}$/.test(accountId))return false;
      if(!Number.isSafeInteger(expectedEpoch) || expectedEpoch<0 || !live() || !await setup())return false;
      const confirmed=await atomic(async tx=>{const value=(await readControl(tx))!;
        if(!live() || value.epoch!==expectedEpoch || boundEpoch!==undefined && (boundEpoch!==expectedEpoch || value.scope!==boundScope))return null;
        // An early guest shell cannot relabel an existing login or its legacy
        // backlog. Account composition supplies the public login ID once known.
        if(scope!==undefined && (scope!==null || value.scope===undefined && value.count===0)){
          if(value.scope!==scope){value.lease=null;value.retryAt=0;value.failures=0;value.accountId=accountId??null;}
          else if(accountId!=null)value.accountId=accountId;
          value.scope=scope;save(tx,value);
        }
        return {scope:value.scope,accountId:value.accountId};
      });
      if(!confirmed || !live())return false;
      boundEpoch=expectedEpoch;boundScope=confirmed.scope;boundAccount=confirmed.accountId;scopeCurrent=isCurrent;publish();return true;
    },
    async enqueue(input:ClientReport,diagnosticProof?:string) {
      // Admission cannot straddle initial opening and a logout in another tab.
      // Startup opens in the background; a cold report explicitly remains unqueued.
      if(boundEpoch===undefined)return {status:'unavailable' as const};
      if(!active())return {status:'stale' as const};
      let report:ClientReport|null;try{report=parseClientReport(input);}catch{report=null;}
      if(!report)return {status:'invalid' as const};
      const proof=diagnosticProof===undefined?null:parseDiagnosticProof(diagnosticProof);
      if(diagnosticProof!==undefined && (!proof || proof.accountId!==report.accountId || boundScope!=null && proof.sessionId!==boundScope))return {status:'invalid' as const};
      const body=new TextEncoder().encode(JSON.stringify(report)),size=body.byteLength+ROW_BYTES+(diagnosticProof?.length??0);
      if(body.byteLength>CLIENT_REPORT_MAX_BYTES || size+CONTROL_BYTES>maxBytes)return {status:'too_large' as const};
      if(!await setup() || !validTime(now()))return {status:'unavailable' as const};
      const result=await atomic(async tx=>{const value=(await readControl(tx))!;if(!active() || value.epoch!==boundEpoch || value.scope!==boundScope)return {status:'stale' as const};
        const time=now();await prune(tx,value,time);
        const old=await request(tx.objectStore('reports').get(report.eventId)) as Stored|undefined;
        if(!active()){tx.abort();return {status:'stale' as const};}
        if(old){save(tx,value);return old.body.byteLength===body.byteLength && old.body.every((byte,i)=>byte===body[i])
          ?{status:'queued' as const,duplicate:true}:{status:'conflict' as const};}
        for await(const cursor of rows(tx.objectStore('reports').index('sequence'))){if(value.bytes+size<=maxBytes)break;remove(tx,value,cursor.value as Stored);}
        const row:Stored={...(diagnosticProof?{diagnosticProof}:{}),eventId:report.eventId,sequence:++value.sequence,epoch:value.epoch,scope:boundScope??null,createdAt:time,bytes:size,body,nextAttemptAt:0,failures:0};
        if(!active()){tx.abort();return {status:'stale' as const};}
        tx.objectStore('reports').put(row);value.bytes+=size;value.count++;save(tx,value);return {status:'queued' as const,duplicate:false};
      });if(result?.status==='queued')publish();return result??{status:'unavailable' as const};
    },
    async claim(owner:string,wakeAt?:number):Promise<DiagnosticBatch> {
      if(typeof owner!=='string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner))return {status:'unavailable'};
      if(!active())return {status:boundEpoch===undefined?'unavailable':'stale'};
      if(!await setup() || !validTime(now()))return {status:'unavailable'};
      return await atomic(async tx=>{const value=(await readControl(tx))!;if(!active() || value.epoch!==boundEpoch || value.scope!==boundScope)return {status:'stale' as const};
        const time=now(),pruned=await prune(tx,value,time);
        if(!value.count){if(pruned)save(tx,value);return {status:'empty' as const};}
        const wait=deliveryWait(value,owner,time,wakeAt);if(wait){if(pruned)save(tx,value);return wait;}
        const {entries,selected,nextAttemptAt}=await batch(tx,value,false,row=>row.scope==null || row.scope===boundScope || boundAccount!=null && parseDiagnosticProof(row.diagnosticProof)?.accountId===boundAccount,wakeAt);
        if(!entries.length){value.lease=null;save(tx,value);return value.count
          ?{status:Number.isFinite(nextAttemptAt)?'waiting' as const:'paused' as const,retryAt:nextAttemptAt}:{status:'empty' as const};}
        if(!active()){tx.abort();return {status:'stale' as const};}
        reserve(tx,value,selected,time);
        value.lease={owner,until:time+LEASE_MS};save(tx,value);
        return {status:'batch' as const,token:{epoch:value.epoch,owner},entries};
      })??{status:'unavailable'};
    },
    async finish(token:DiagnosticBatchToken,entries:readonly DiagnosticQueueEntry[],acknowledged:readonly string[],retry:'none'|'transport'|'partial',retryAfterMs=0) {
      if(!await setup())return {status:'unavailable' as const};
      const allowed=new Map(entries.map(entry=>[entry.eventId,entry.sequence]));
      const result=await atomic(async tx=>{const value=(await readControl(tx))!;
        if(value.epoch!==token.epoch || value.epoch!==boundEpoch)return {status:'stale' as const};
        const owned=value.lease?.owner===token.owner,accepted=new Set(acknowledged);
        for(const id of acknowledged){const sequence=allowed.get(id);if(sequence===undefined)continue;
          const row=await request(tx.objectStore('reports').get(id)) as Stored|undefined;
          if(row && row.epoch===token.epoch && row.sequence===sequence)remove(tx,value,row);
        }
        if(owned && retry!=='none')await deferRemaining(tx,token,allowed,accepted,now());
        await prune(tx,value,now());
        if(owned){value.lease=null;serverPause(value,retryAfterMs,now());if(retry==='transport' && value.count){value.retryAt=Math.max(value.retryAt,now()+attemptDelay(value.failures),value.serverRetryAt??0);}
          else{value.failures=0;value.retryAt=0;}}
        save(tx,value);return {status:'finished' as const,owned,count:value.count,retryAt:value.retryAt};
      });publish();return result??{status:'unavailable' as const};
    },
    async release(owner:string,retryAfterMs=0){if(!await setup())return;
      const changed=await atomic(async tx=>{const value=(await readControl(tx))!;
        if(value.epoch!==boundEpoch || value.lease?.owner!==owner)return false;
        value.lease=null;serverPause(value,retryAfterMs,now());save(tx,value);return true;});if(changed)publish();},
    async clearForExit(includeBatch:boolean,scopes?:readonly (string|null)[]) {
      if(!await setup())return {status:'unavailable' as const};
      const result=await atomic(async tx=>{const value=(await readControl(tx))!;
        if(boundEpoch!==undefined && value.epoch!==boundEpoch)return {status:'stale' as const};
        if(boundEpoch===undefined && !scopes?.length)return {status:'stale' as const};
        const exits=scopes?.length?scopes:boundScope===undefined?undefined:[boundScope];
        if(value.scope!==undefined && (!exits || !exits.includes(value.scope))) {
          if(!exits)return {status:'stale' as const};
          // A new login may already be writing. Remove only the old login's
          // rows; its late exit must neither clear nor invalidate the new queue.
          // Legacy rows have no login ID. A delayed exit cannot infer that
          // they belong to it rather than a newer login before the upgrade.
          const belongs=(row:Stored)=>row.scope!==undefined && exits.includes(row.scope);
          await prune(tx,value,now());
          const entries=includeBatch?(await batch(tx,value,true,belongs)).entries:[];
          let removed=0;
          for await(const cursor of rows(tx.objectStore('reports'))){const row=cursor.value as Stored;
            if(belongs(row)){remove(tx,value,row);removed++;}}
          if(!value.count){value.retryAt=0;value.failures=0;value.lease=null;}
          save(tx,value);
          return removed||entries.length?{status:'cleared' as const,epoch:value.epoch,nextEpoch:value.epoch,rotated:false,entries}
            :{status:'stale' as const};
        }
        await prune(tx,value,now());const entries=includeBatch?(await batch(tx,value,true)).entries:[];
        const epoch=value.epoch;value.epoch++;value.scope=null;value.accountId=null;value.bytes=CONTROL_BYTES;value.count=0;value.retryAt=0;value.failures=0;value.lease=null;
        tx.objectStore('reports').clear();save(tx,value);return {status:'cleared' as const,epoch,nextEpoch:value.epoch,rotated:true,entries};
      });if(result?.status==='cleared' && result.rotated)publish({clearedEpoch:result.epoch});else publish();return result??{status:'unavailable' as const};
    },
    /** The storage-pressure owner may discard diagnostics before touching calculations or personal copies. */
    async discardForSpace(isCurrent:()=>boolean=()=>true):Promise<StorageRelief>{if(!await setup())return 'unavailable';
      const result=await atomic(async tx=>{const value=(await readControl(tx))!;if(value.epoch!==boundEpoch || value.scope!==boundScope || !isCurrent())return 'unavailable' as const;
        if(!value.count)return 'empty' as const;
        tx.objectStore('reports').clear();value.bytes=CONTROL_BYTES;value.count=0;value.retryAt=0;value.failures=0;value.lease=null;save(tx,value);return 'released' as const;});
      if(result==='released')publish();return result??'unavailable';
    },
    subscribe(listener:()=>void){listeners.add(listener);return ()=>listeners.delete(listener);},
    close(){if(closed)return;closed=true;clearTimeout(timer);peers?.delete(changed);channel?.close();listeners.clear();database.close();},
  };
}
