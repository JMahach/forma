import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {completeJournalEvent, type ServiceFailure} from './events.ts';

// Bounded transport only. It never opens an archive or keeps a retry queue.
const frameBytes=1024, deadlineMs=1000;
export const SERVICE_INPUT_RESERVED_BYTES=256*1024;
export const serviceSocketPath=(directory:string)=>path.join(directory,'run','services.sock');

function fact(value:unknown) {
 if(!value || typeof value!=='object' || Array.isArray(value))return null;
 const fields=Object.getOwnPropertyDescriptors(value);
 if(!fields.eventId || !fields.occurredAt || fields.event?.value!=='service_failed')return null;
 const event=completeJournalEvent(value,{environment:'stand',occurredAt:0,eventId:'missing'});
 if(!event)return null;
 const {schemaVersion:_,environment:__,source:___,level:____,outcome:_____,...result}=event;
 return result;
}

export function createServiceInput({directory,report}:{directory:string;report:(value:unknown)=>Promise<boolean>}) {
 const filename=serviceSocketPath(directory),connections=new Set<net.Socket>();
 let closed=false;
 const server=net.createServer({allowHalfOpen:true,highWaterMark:frameBytes},socket=>{
  connections.add(socket);let bytes=Buffer.alloc(0),submitted=false;
  const timeout=setTimeout(()=>socket.destroy(),deadlineMs);
  socket.on('close',()=>{clearTimeout(timeout);connections.delete(socket);});
  socket.on('error',()=>{});
  socket.on('end',()=>{if(!submitted)socket.destroy();});
  socket.on('data',chunk=>{
   if(submitted || bytes.length+chunk.length>frameBytes){socket.destroy();return;}
   bytes=Buffer.concat([bytes,chunk]);const end=bytes.indexOf(10);if(end<0)return;
   if(end!==bytes.length-1){socket.destroy();return;}
   submitted=true;socket.pause();
   let value:ReturnType<typeof fact>=null;
   try{value=fact(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}catch{}
   bytes=Buffer.alloc(0);
   if(!value){socket.end('0\n');return;}
   void Promise.resolve().then(()=>report(value)).then(ok=>{
    if(!socket.destroyed)socket.end(ok?'1\n':'0\n');
   },()=>{if(!socket.destroyed)socket.end('0\n');});
  });
 });
 server.maxConnections=4;
 server.on('error',()=>{});
 const ready=(async()=>{
  try{
   const parent=path.dirname(filename);await fs.mkdir(parent,{recursive:true,mode:0o700});
   const info=await fs.lstat(parent);
   if(!info.isDirectory() || info.mode&0o077 || info.uid!==process.getuid?.())return false;
   const previous=await fs.lstat(filename).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;return null;});
   if(previous){
    if(!previous.isSocket() || previous.uid!==process.getuid?.())return false;
    const stale=await new Promise<boolean>(resolve=>{
     const probe=net.createConnection(filename);let done=false;
     const finish=(result:boolean)=>{if(done)return;done=true;clearTimeout(timeout);probe.destroy();resolve(result);};
     const timeout=setTimeout(()=>finish(false),deadlineMs);
     probe.once('connect',()=>finish(false));
     probe.once('error',(error:NodeJS.ErrnoException)=>finish(error.code==='ECONNREFUSED'));
    });
    if(!stale)return false;
    const current=await fs.lstat(filename);
    if(current.ino!==previous.ino || current.dev!==previous.dev)return false;
    await fs.unlink(filename);
   }
   if(closed)return false;
   await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);server.listen(filename,()=>{server.off('error',reject);resolve();});
   });
   await fs.chmod(filename,0o600);return true;
  }catch{return false;}
 })();
 return {ready,async close(){
  closed=true;await ready;
  for(const socket of connections)socket.destroy();
  // Node unlinks the bound pathname itself. External rename/unlink of a live
  // socket in our private directory is unsupported; await close before replacing
  // its owner. A post-close inode check cannot protect an externally replaced path.
  if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
 }};
}

/** One attempt, one fixed fact; a stopped site or timeout never changes the caller's work. */
export async function reportServiceFailure(socketPath:string,value:ServiceFailure):Promise<boolean> {
 try{
  const valueToSend={event:'service_failed',...value,eventId:randomUUID(),occurredAt:Date.now()};
  if(!fact(valueToSend))return false;
  const bytes=Buffer.from(JSON.stringify(valueToSend)+'\n');if(bytes.length>frameBytes)return false;
  return await new Promise<boolean>(resolve=>{
   const socket=net.createConnection(socketPath);let reply='',done=false;
   const finish=(result:boolean)=>{if(done)return;done=true;clearTimeout(timeout);socket.destroy();resolve(result);};
   const timeout=setTimeout(()=>finish(false),deadlineMs);
   socket.once('connect',()=>socket.write(bytes));socket.once('error',()=>finish(false));socket.once('close',()=>finish(false));
   socket.on('data',chunk=>{reply+=chunk.toString();if(reply==='1\n')finish(true);else if(reply.includes('\n') || reply.length>2)finish(false);});
  });
 }catch{return false;}
}
