import {spawn} from 'node:child_process';

/** Bounded datagram/stream/socket/control buffers; Python RSS is measured separately. */
export const SYSTEM_SOURCE_RESERVED_BYTES=1024*1024;
export interface SystemSourceOptions {python:string;script:string;socketPath:string;env?:NodeJS.ProcessEnv}

function watchReady(stream:NodeJS.ReadableStream,accept:()=>void,reject:()=>void) {
 let bytes=Buffer.alloc(0),received=false;
 stream.on('data',(chunk:Buffer)=>{
  if(received || bytes.length+chunk.length>6){reject();return;}
  bytes=Buffer.concat([bytes,chunk]);if(bytes.length<6)return;
  if(bytes.toString()!=='READY\n'){reject();return;}
  received=true;accept();
 });
}

/** The journal service owns this child; only systemd restarts their shared tree. */
export function createSystemSource(options:SystemSourceOptions & {writerPath:string}) {
 const child=spawn(options.python,[options.script,'listen','--socket',options.socketPath,'--writer',options.writerPath],
  {stdio:['ignore','pipe','ignore'],env:options.env??process.env});
 let resolveReady!:(value:boolean)=>void,resolveStopped!:()=>void,closed=false;
 let force:NodeJS.Timeout|undefined;
 const ready=new Promise<boolean>(resolve=>{resolveReady=resolve;});
 const stopped=new Promise<void>(resolve=>{resolveStopped=resolve;});
 const timeout=setTimeout(()=>{resolveReady(false);void close();},5000);
 function close():Promise<void> {
  if(closed)return stopped;closed=true;resolveReady(false);clearTimeout(timeout);
  if(child.exitCode===null && child.signalCode===null && child.pid) {
   child.kill('SIGTERM');force=setTimeout(()=>child.kill('SIGKILL'),1000);
  }
  return stopped;
 }
 child.once('error',()=>{resolveReady(false);void close();});
 child.once('close',()=>{closed=true;clearTimeout(timeout);if(force)clearTimeout(force);resolveReady(false);resolveStopped();});
 watchReady(child.stdout,()=>{clearTimeout(timeout);resolveReady(true);},()=>{void close();});
 return {ready,stopped,close};
}
