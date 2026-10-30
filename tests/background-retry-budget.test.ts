import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {createDiagnosticQueue} from '../src/data/diagnostic-queue.ts';
import {createDiagnosticDelivery} from '../src/data/diagnostic-delivery.ts';
import {createDiagnosticClient} from '../src/data/diagnostic-client.ts';
import {createJournal} from '../src/journal.ts';
import type {ClientReport} from '../shared/client-report-contract.ts';
const id=(n:number)=>`${n.toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`;
const report=(n:number):ClientReport=>({schemaVersion:1,eventId:id(n),occurredAt:1,environment:'production',source:'browser',
 event:'client_failed',level:'error',outcome:'failed',accountId:null,appVersion:'test',contextId:id(100),
 action:'calculate',component:'calculator',stage:'request',reason:'connection_failed'});
const settle=async()=>{for(let i=0;i<40;i++)await new Promise<void>(resolve=>setImmediate(resolve));};
async function fixture(t:test.TestContext){
 let time=1000,visible=true,serial=800;
 const timers=new Map<ReturnType<typeof setTimeout>,{at:number;run:()=>void}>();
 t.mock.method(globalThis,'setTimeout',((run:()=>void,delay=0)=>{const handle={unref(){}} as ReturnType<typeof setTimeout>;
  timers.set(handle,{at:time+delay,run});return handle;}) as typeof setTimeout);
 t.mock.method(globalThis,'clearTimeout',(handle:ReturnType<typeof setTimeout>)=>{timers.delete(handle);});
 const indexedDB=new IDBFactory(),senders:ReturnType<typeof createDiagnosticDelivery>[]=[];
 const queues:ReturnType<typeof createDiagnosticQueue>[]=[];
 async function open(){const queue=createDiagnosticQueue({indexedDB,now:()=>time});queues.push(queue);
  const state=await queue.state();assert.equal(state.status,'ready');assert.ok('epoch' in state);await queue.activate(state.epoch,()=>true);return queue;}
 const queue=await open();await queue.enqueue(report(1));
 const calls:{at:number;body:string;exit:boolean}[]=[];
 function sender(q=queue,send:Parameters<typeof createDiagnosticDelivery>[0]['send']=async()=>{throw Error('Unavailable');}){
  const value=createDiagnosticDelivery({queue:q,now:()=>time,newId:()=>id(++serial),connection:()=> 'online',visible:()=>visible,
   send:async(body,options)=>{calls.push({at:time,body:JSON.stringify(body),exit:options.exit});return send(body,options);}});senders.push(value);return value;}
 t.after(async()=>{for(const sender of senders)await sender.close();for(const queue of queues)queue.close();});
 return {queue,indexedDB,calls,sender,open,now:()=>time,hide(){visible=false;},show(){visible=true;},
  pendingWithin(ms:number){return [...timers.values()].filter(timer=>timer.at<=time+ms).length;},
  async advance(ms:number){const target=time+ms;await settle();let count=0;
   while(true){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>target)break;
    assert.ok(++count<1000,'timer work must remain bounded');timers.delete(next[0]);time=next[1].at;next[1].run();await settle();}
   time=target;await settle();}};
}
test('three shared attempts wait 1/5 seconds, then a timer, peer and enqueue cannot start a new series',async t=>{
 const h=await fixture(t),sender=h.sender();await sender.wake();assert.equal(h.calls.length,1);
 await h.advance(999);assert.equal(h.calls.length,1);await h.advance(1);assert.equal(h.calls.length,2);
 await h.advance(4999);assert.equal(h.calls.length,2);await h.advance(1);assert.equal(h.calls.length,3);
 await sender.wake();await sender.wake();await h.advance(60_000);assert.equal(h.calls.length,3);
 await h.queue.enqueue(report(2));await settle();assert.equal(h.calls.length,3);
 const peer=h.sender(await h.open());await settle();assert.equal(h.calls.length,3,'opening another sender is not a new external occasion');
 await peer.wake();assert.equal(h.calls.length,4,'a genuinely later external wake may begin one series');
 await sender.wake();await peer.wake();assert.equal(h.calls.length,4);
 await h.advance(1000);assert.equal(h.calls.length,5);await h.advance(5000);assert.equal(h.calls.length,6);
 await h.advance(5000);await h.queue.enqueue(report(3));await settle();assert.equal(h.calls.length,6);
 await h.advance(55_000);assert.equal(h.calls.length,6,'a renewed series has the same finite budget');
});
test('handoff and hide preserve the charged attempt and its common delay',async t=>{
 const h=await fixture(t),a=h.sender();await a.wake();await a.close();const b=h.sender(await h.open());
 await b.wake();assert.equal(h.calls.length,1);await h.advance(1000);assert.equal(h.calls.length,2);
 h.hide();await b.wake();await h.advance(60_000);assert.equal(h.calls.length,2);
 h.show();await b.wake();assert.equal(h.calls.length,3);await h.advance(60_000);assert.equal(h.calls.length,3);
 assert.equal(new Set(h.calls.map(call=>call.body)).size,1);
});
test('hidden delivery makes no request, including an enqueue and expired retry timer',async t=>{
 const h=await fixture(t);h.hide();const sender=h.sender();await sender.wake();await h.queue.enqueue(report(2));await settle();
 await h.advance(5000);assert.equal(h.calls.length,0);h.show();await sender.wake();assert.equal(h.calls.length,1);
 h.hide();await sender.wake();await h.advance(5000);assert.equal(h.calls.length,1);
});
test('Retry-After is shared across a reopened sender and dominates each short delay',async t=>{
 const h=await fixture(t),a=h.sender(undefined,async()=>{throw Object.assign(Error('Busy'),{retryAfterMs:120_000});});
 await a.wake();await a.close();const b=h.sender(await h.open());await b.wake();
 await h.advance(119_999);assert.equal(h.calls.length,1);await h.advance(1);assert.equal(h.calls.length,2);
});
test('a lost durable ACK consumes the shared budget even after three owner replacements',async t=>{
 const h=await fixture(t),original=IDBObjectStore.prototype.delete;
 IDBObjectStore.prototype.delete=function(...args){if(this.name==='reports')throw new DOMException('Unavailable','UnknownError');return original.apply(this,args);};
 try{
  for(let i=0;i<3;i++){
   const sender=h.sender(i?await h.open():h.queue,async body=>({schemaVersion:1,results:body.reports.map(r=>({eventId:r.eventId,status:'accepted',receivedAt:1,duplicate:true}))}));
   await sender.wake();assert.equal(h.calls.length,i+1);await sender.close();
   if(i===2){await h.queue.enqueue(report(2));const early=h.sender(await h.open());await early.wake();assert.equal(h.calls.length,3);await early.close();}
   await h.advance(i===0?1000:i===1?5000:60_000);
  }
  const replacement=h.sender(await h.open());await settle();await h.advance(300_000);assert.equal(h.calls.length,3);
  assert.equal(new Set(h.calls.map(call=>call.body)).size,1);
  const snapshot=await h.queue.state();assert.ok('count' in snapshot);assert.equal(snapshot.count,2);
  await replacement.wake();assert.equal(h.calls.length,4);
 }finally{IDBObjectStore.prototype.delete=original;}
});
test('partial failures retain their own exhausted budget while later reports are acknowledged',async t=>{
 const h=await fixture(t),sender=h.sender(undefined,async body=>({schemaVersion:1,results:body.reports.map(r=>r.eventId===id(1)
  ?{eventId:r.eventId,status:'retryable',reason:'ownership_unverified'}:{eventId:r.eventId,status:'accepted',receivedAt:1,duplicate:false})}));
 await sender.wake();await h.queue.enqueue(report(2));await settle();assert.equal(h.calls.length,2);
 await h.advance(1000);assert.equal(h.calls.length,3);await h.advance(5000);assert.equal(h.calls.length,4);
 await h.advance(60_000);await h.queue.enqueue(report(3));await settle();assert.equal(h.calls.length,5);
 const retried=h.calls.filter(call=>JSON.parse(call.body).reports.some((r:ClientReport)=>r.eventId===id(1)));assert.equal(retried.length,3);
 await sender.wake();assert.equal(h.calls.length,6);
 await h.advance(1000);assert.equal(h.calls.length,7);await h.advance(5000);assert.equal(h.calls.length,8);
 await h.advance(60_000);assert.equal(h.calls.length,8);
});
test('the diagnostic HTTP boundary retains Retry-After without reading the failed body',async()=>{
 const client=createDiagnosticClient({fetch:async()=>new Response('not JSON',{status:503,headers:{'Retry-After':'120'}})});
 await assert.rejects(client({schemaVersion:1,reports:[report(1)]},{signal:new AbortController().signal,exit:false}),
  (error:unknown)=>!!error&&typeof error==='object'&&'retryAfterMs' in error&&error.retryAfterMs===120_000);
});
test('journal composition suspends a hidden sender and restores it only on a visible occasion',async t=>{
 const h=await fixture(t),visibility=Object.assign(new EventTarget(),{hidden:true});let calls=0;
 const journal=createJournal({appVersion:'test',environment:'production',indexedDB:h.indexedDB,now:h.now,
  visibility,connection:()=> 'online',send:async()=>{calls++;throw Error('Unavailable');}});t.after(()=>journal.close());
 await journal.wake();await h.advance(10_000);assert.equal(calls,0);
 const admission=await journal.begin({action:'calculate',component:'calculator'}).reportError(Error('Unavailable'),{stage:'request'});
 assert.equal(admission?.queued,true,'hidden pauses delivery, not local capture');
 visibility.hidden=false;visibility.dispatchEvent(new Event('visibilitychange'));await settle();assert.equal(calls,1);
 visibility.hidden=true;visibility.dispatchEvent(new Event('visibilitychange'));await h.advance(10_000);assert.equal(calls,1);
 visibility.hidden=false;visibility.dispatchEvent(new Event('visibilitychange'));await settle();assert.equal(calls,2);
 await h.advance(5000);assert.equal(calls,3);await h.advance(60_000);assert.equal(calls,3);
});
test('failed attempt reservations send nothing and local storage recovery is finite',async t=>{
 const h=await fixture(t),original=IDBObjectStore.prototype.put;let reservations=0;
 IDBObjectStore.prototype.put=function(...args){if(this.name==='reports'){reservations++;throw new DOMException('Full','QuotaExceededError');}return original.apply(this,args);};
 try{const sender=h.sender();await sender.wake();assert.equal(reservations,1);
  await h.advance(999);assert.equal(reservations,1);await h.advance(1);assert.equal(reservations,2);
  await h.advance(4999);assert.equal(reservations,2);await h.advance(1);assert.equal(reservations,3);
  await sender.wake(false);await sender.wake();assert.equal(reservations,3);
  assert.equal(h.pendingWithin(60_000),0,'exhaustion does not schedule an expiry wake');
  await h.advance(300_000);assert.equal(reservations,3);assert.equal(h.calls.length,0);
  await sender.wake(false);assert.equal(reservations,3);
  await sender.wake();assert.equal(reservations,4);assert.equal(h.calls.length,0);
  await h.advance(1000);assert.equal(reservations,5);await h.advance(5000);assert.equal(reservations,6);
  await h.advance(60_000);assert.equal(reservations,6);
 }finally{IDBObjectStore.prototype.put=original;}
});
test('hide interrupts a transport that ignores abort and retains a bounded final logout attempt',async t=>{
 const h=await fixture(t);let signal:AbortSignal|undefined;
 const sender=h.sender(undefined,async(_body,options)=>{signal=options.signal;return new Promise(()=>{});});
 await settle();assert.equal(h.calls.length,1);h.hide();await sender.wake();assert.equal(signal?.aborted,true);
 await h.advance(60_000);assert.equal(h.calls.length,1);
 await sender.leave();assert.equal(h.calls.length,2);assert.equal(h.calls[1]!.exit,true);
 await sender.leave();await h.advance(60_000);assert.equal(h.calls.length,2);
});
test('server pause survives a failed report update and admission of a different login',async t=>{
 const h=await fixture(t),original=IDBObjectStore.prototype.put;let rejectReports=false;
 IDBObjectStore.prototype.put=function(...args){if(this.name==='reports'&&rejectReports)throw new DOMException('Full','QuotaExceededError');return original.apply(this,args);};
 try{const a=h.sender(undefined,async()=>{rejectReports=true;throw Object.assign(Error('Busy'),{retryAfterMs:120_000});});
  await a.wake();await a.close();rejectReports=false;
  const next=await h.open(),state=await next.state();assert.ok('epoch' in state);await next.activate(state.epoch,()=>true,'another-session','17');
  await next.enqueue(report(2));const b=h.sender(next);await b.wake();
  await h.advance(119_999);assert.equal(h.calls.length,1);await h.advance(1);assert.equal(h.calls.length,2);
 }finally{IDBObjectStore.prototype.put=original;}
});
test('an earlier queued occasion and invalid future timestamps cannot reopen an exhausted queue',async t=>{
 const h=await fixture(t),sender=h.sender();await sender.wake();await h.advance(1000);await h.advance(5000);
 const early=h.now();await h.advance(60_000);assert.equal(h.calls.length,3);
 for(const at of [early,h.now()+1,NaN,Infinity]){await sender.wake(at);assert.equal(h.calls.length,3);}
 await sender.wake();assert.equal(h.calls.length,4);
});
test('invalid server delays do not disable finite local retry timing',async t=>{
 const h=await fixture(t),delays=[Infinity,-1,NaN];let attempt=0;
 const sender=h.sender(undefined,async()=>{throw Object.assign(Error('Busy'),{retryAfterMs:delays[attempt++]});});
 await sender.wake();await h.advance(1000);assert.equal(h.calls.length,2);await h.advance(5000);assert.equal(h.calls.length,3);
 await h.advance(60_000);assert.equal(h.calls.length,3);
});
test('journal initialization stops local storage retries until a new allowed occasion',async t=>{
 const h=await fixture(t);await settle();const original=IDBObjectStore.prototype.get;let reads=0,sent=0;
 IDBObjectStore.prototype.get=function(...args){if(this.name==='control'){reads++;throw new DOMException('Unavailable','UnknownError');}return original.apply(this,args);};
 const journal=createJournal({appVersion:'test',environment:'production',indexedDB:h.indexedDB,now:h.now,
  connection:()=> 'online',send:async()=>{sent++;throw Error('must not send');}});
 try{await journal.wake();await settle();const first=reads;
  await h.advance(999);assert.equal(reads,first);await h.advance(1);assert.ok(reads>first);const second=reads;
  await h.advance(4999);assert.equal(reads,second);await h.advance(1);assert.ok(reads>second);const exhausted=reads;
  await journal.wake(false);await journal.wake();assert.equal(h.pendingWithin(60_000),0);
  await h.advance(300_000);assert.equal(reads,exhausted);
  await journal.wake(false);assert.equal(reads,exhausted);await journal.wake();await settle();assert.ok(reads>exhausted);
  const resumed=reads;await h.advance(999);assert.equal(reads,resumed);await h.advance(1);assert.ok(reads>resumed);assert.equal(sent,0);
 }finally{await journal.close();IDBObjectStore.prototype.get=original;}
});
test('an unchanged empty queue wakes without writing its control again',async t=>{
 const h=await fixture(t);await h.queue.discardForSpace();await settle();const original=IDBObjectStore.prototype.put;let puts=0;
 IDBObjectStore.prototype.put=function(...args){if(this.name==='control')puts++;return original.apply(this,args);};
 try{const sender=h.sender();await sender.wake();await sender.wake();await settle();await h.queue.state();
  assert.equal(h.calls.length,0);assert.equal(puts,0);
 }finally{IDBObjectStore.prototype.put=original;}
});
test('the sender remembers Retry-After when every attempt to persist the response fails',async t=>{
 const h=await fixture(t),original=IDBObjectStore.prototype.put;let unavailable=false;
 IDBObjectStore.prototype.put=function(...args){if(this.name==='control'&&unavailable)throw new DOMException('Unavailable','UnknownError');return original.apply(this,args);};
 try{const sender=h.sender(undefined,async()=>{unavailable=true;throw Object.assign(Error('Busy'),{retryAfterMs:120_000});});
  await sender.wake();unavailable=false;
  await h.advance(119_999);assert.equal(h.calls.length,1);await h.advance(1);assert.equal(h.calls.length,2);
 }finally{unavailable=false;IDBObjectStore.prototype.put=original;}
});
