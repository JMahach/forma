import net from 'node:net';
import {parseJournalEvent,type JournalEvent} from './events.ts';
import {canonicalJSON,bufferReserve,JOURNAL_POLICY,type JournalResult} from './policy.ts';
import {readWriterResult,readWriterUsage,WRITER_REPLY_BYTES,WRITER_DEADLINE_MS,type WriterUsage} from './writer-protocol.ts';

export const JOURNAL_CLIENT_RESERVED_BYTES=2*1024*1024;
const maxCommands=128,maxBytes=256*1024,maxConnections=4;
const unavailable:JournalResult={status:'retryable',reason:'journal_unavailable'};
interface Command {
 kind:'write'|'usage';bytes:Buffer;expires:number;fallback:unknown;finish:(value:unknown)=>void;
}

/** One bounded delivery attempt. No files, timer while idle, replay queue or embedded writer. */
class WriterClient {
 private socketPath:string;
 private queue:Command[]=[];
 private active=new Map<net.Socket,()=>void>();
 private bytes=0;
 private closed=false;
 private idle:Promise<void>|undefined;
 private resolveIdle:(()=>void)|undefined;
 constructor(socketPath:string) {this.socketPath=socketPath;}
 private settled() {
  if(this.queue.length || this.active.size)return;
  const resolve=this.resolveIdle;this.resolveIdle=undefined;this.idle=undefined;resolve?.();
 }
 private send<T>(kind:Command['kind'],bytes:Buffer,fallback:T):Promise<T> {
  if(this.closed)return Promise.resolve(fallback);
  if(this.queue.length+this.active.size>=maxCommands || this.bytes+bytes.length>maxBytes) {
   return Promise.resolve(kind==='write'?{status:'retryable',reason:'journal_queue_full'} as T:fallback);
  }
  this.bytes+=bytes.length;
  const result=new Promise<T>(resolve=>this.queue.push({kind,bytes,fallback,
   expires:performance.now()+WRITER_DEADLINE_MS,finish:value=>resolve(value as T)}));
  this.pump();return result;
 }
 private pump() {
  while(!this.closed && this.queue.length && this.active.size<maxConnections) {
   const command=this.queue.shift()!;
   if(performance.now()>=command.expires) {this.bytes-=command.bytes.length;command.finish(command.fallback);continue;}
   this.deliver(command);
  }
  this.settled();
 }
 private deliver(command:Command) {
  let socket:net.Socket;
  try {socket=net.createConnection({path:this.socketPath});}
  catch {this.bytes-=command.bytes.length;command.finish(command.fallback);return;}
  let reply=Buffer.alloc(0),done=false;
  const finish=(value:unknown)=>{
   if(done)return;done=true;clearTimeout(timer);this.active.delete(socket);this.bytes-=command.bytes.length;
   socket.destroy();command.finish(value);this.pump();
  };
  const fail=()=>finish(command.fallback);
  const timer=setTimeout(fail,Math.max(1,command.expires-performance.now()));
  this.active.set(socket,fail);
  socket.once('connect',()=>socket.write(command.bytes));socket.once('error',fail);socket.once('close',fail);
  socket.on('data',chunk=>{
   if(reply.length+chunk.length>WRITER_REPLY_BYTES){fail();return;}
   reply=Buffer.concat([reply,chunk]);const end=reply.indexOf(10);if(end<0)return;
   if(end!==reply.length-1){fail();return;}
   let value:unknown=null;
   try {const decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(reply));
    value=command.kind==='write'?readWriterResult(decoded):readWriterUsage(decoded);
   } catch {/* Invalid peer replies never become an acceptance. */}
   finish(value??command.fallback);
  });
 }
 write(input:JournalEvent):Promise<JournalResult> {
  if(this.closed)return Promise.resolve(unavailable);
  let event:JournalEvent|null;
  try {event=parseJournalEvent(input);}catch {event=null;}
  if(!event)return Promise.resolve({status:'invalid',reason:'invalid_event'});
  const payload=canonicalJSON({...event});
  if(Buffer.byteLength(payload)>JOURNAL_POLICY.maxEventBytes)return Promise.resolve({status:'invalid',reason:'event_too_large'});
  return this.send('write',Buffer.from('{"kind":"write","event":'+payload+'}\n'),unavailable);
 }
 usage():Promise<WriterUsage> {
  const missing:WriterUsage={ready:false,diskBytes:null,externalBytes:null,bufferReservedBytes:bufferReserve(JOURNAL_POLICY),pendingBytes:0,pendingCount:0};
  return this.send('usage',Buffer.from('{"kind":"usage"}\n'),missing);
 }
 drain():Promise<void> {
  if(!this.queue.length && !this.active.size)return Promise.resolve();
  if(!this.idle)this.idle=new Promise(resolve=>{this.resolveIdle=resolve;});return this.idle;
 }
 async close() {
  this.closed=true;
  for(const command of this.queue.splice(0)){this.bytes-=command.bytes.length;command.finish(command.fallback);}
  for(const fail of [...this.active.values()])fail();this.settled();
 }
}
export function createJournalWriterClient({socketPath}:{socketPath:string}) {
 const client=new WriterClient(socketPath);
 return {write:client.write.bind(client),usage:client.usage.bind(client),drain:client.drain.bind(client),close:client.close.bind(client)};
}
