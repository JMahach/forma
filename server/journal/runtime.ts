import path from 'node:path';
import { completeJournalEvent, browserJournalEvent, type JournalEvent } from './events.ts';
import type { ClientReport } from '../../shared/client-report-contract.ts';
import type { JournalResult } from './policy.ts';
import { createServerReporter } from './report.ts';
import { createJournalWriter } from './writer.ts';
import { MAIL_BUFFER_LIMITS } from './mail-buffer.ts';
import { createMailBufferClient } from './mail-buffer-client.ts';

export interface JournalRuntimeOptions {
 clientReservedBytes?:number;
 directory:string; environment:JournalEvent['environment']; now?:()=>number;
}
/** Owns the handoff, not the mail or account outcome. Both durable stores run off the HTTP thread. */
export function createJournalRuntime({directory,environment,clientReservedBytes=0,now=Date.now}:JournalRuntimeOptions) {
 if(!Number.isSafeInteger(clientReservedBytes) || clientReservedBytes<0)throw new RangeError('Invalid client journal reservation');
 const writer=createJournalWriter({directory:path.join(directory,'archive'),now,
  externalReservedBytes:MAIL_BUFFER_LIMITS.reservedBytes+clientReservedBytes});
 const buffer=createMailBufferClient({filename:path.join(directory,'mail-pending','pending.sqlite'),now});
 const report=createServerReporter({environment,now,write:writer.write});
 let closed=false,requested=false,scheduled:NodeJS.Immediate|undefined,draining:Promise<number>|undefined;
 let closing:Promise<void>|undefined;
 function schedule() {
  if(closed)return;
  if(draining){requested=true;return;}
  if(!scheduled)scheduled=setImmediate(()=>{scheduled=undefined;void drainOnce();});
 }
 function drainOnce():Promise<number> {
  if(closed)return Promise.resolve(0);
  if(draining)return draining;
  requested=false;
  draining=(async()=>{
   let removed=0;
   try{
    const events=await buffer.batch();
    // The durable buffer bounds this batch. Admit it together so the writer can
    // use its bounded worker batch; acknowledge each exact event only after its own ACK.
    const results=await Promise.allSettled(events.map(async event=>{
     if(closed)return false;
     const result=await writer.write(event);
     return !closed && result.status==='accepted' && await buffer.acknowledge(event);
    }));
    removed=results.filter(result=>result.status==='fulfilled' && result.value).length;
   }catch{/* Diagnostics cannot break account or mail work. */}
   return removed;
  })();
  const current=draining;
  void current.then(removed=>{
   draining=undefined;
   // Continue a real backlog without making a failed destination a busy loop.
   if(!closed && (removed>0 || requested))schedule();
  });
  return current;
 }
 const timer=setInterval(schedule,60_000);timer.unref();
 schedule();
 return {
  receiveClient(input:ClientReport,deliveryIp:string):Promise<JournalResult> {
   if(closed)return Promise.resolve({status:'retryable',reason:'journal_unavailable'});
   const event=browserJournalEvent(input,deliveryIp);
   if(!event)return Promise.resolve({status:'invalid',reason:'invalid_event'});
   return writer.write(event);
  },
  report(fact:unknown):Promise<boolean>{return closed?Promise.resolve(false):report(fact);},
  async handoffMailReport(fact:unknown):Promise<{status:'buffered'|'unavailable'}> {
   if(closed)return{status:'unavailable'};
   try{
    // Terminal source facts must contain their own immutable ID and time.
    const event=completeJournalEvent(fact,{environment,occurredAt:now(),eventId:'unidentified'});
    if(!event || (await buffer.stage(event)).status!=='buffered')return{status:'unavailable'};
    if(!closed)schedule();
    return{status:'buffered'};
   }catch{return{status:'unavailable'};}
  },
  async flushMail() {
   // A caller may have staged work after the current batch took its snapshot.
   if(draining)await draining;
   return drainOnce();
  },
  async usage(){return{journal:await writer.usage(),mail:await buffer.usage()};},
  close():Promise<void> {
   if(closing)return closing;
   closed=true;clearInterval(timer);if(scheduled)clearImmediate(scheduled);
   closing=Promise.allSettled([buffer.close(),(async()=>{
    // Ordinary actions never wait for diagnostics. Shutdown gives admitted facts
    // a bounded chance to become durable before the abrupt writer close.
    let deadline:NodeJS.Timeout|undefined;
    try{
     await Promise.race([writer.drain(),new Promise<void>(resolve=>{deadline=setTimeout(resolve,5_000);})]);
    }finally{
     if(deadline)clearTimeout(deadline);
     await writer.close();
    }
   })()]).then(()=>undefined);
   return closing;
  },
 };
}
