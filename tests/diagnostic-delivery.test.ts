import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createDiagnosticQueue } from '../src/data/diagnostic-queue.ts';
import { createDiagnosticDelivery } from '../src/data/diagnostic-delivery.ts';
import type { ClientReport } from '../shared/client-report-contract.ts';
function expectStatus<T extends {status:string}, S extends T['status']>(value:T,status:S):Extract<T,{status:S}> {
  assert.equal(value.status,status);return value as Extract<T,{status:S}>;
}
const id=(n:number)=>`${n.toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`;
const report=(n:number,accountId:string|null=null):ClientReport=>({schemaVersion:1,eventId:id(n),occurredAt:1,
  environment:'production',source:'browser',event:'client_failed',level:'error',outcome:'failed',accountId,appVersion:'test-1',
  contextId:id(500),action:'calculate',component:'calculator',stage:'request',reason:'connection_failed'});
const accepted=(...reports:ClientReport[])=>({schemaVersion:1,results:reports.map(report=>({eventId:report.eventId,status:'accepted',receivedAt:10,duplicate:false}))});
const deferred=()=>{let resolve!:(value:unknown)=>void;const promise=new Promise(resolveValue=>{resolve=resolveValue;});return {promise,resolve};};
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<200;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('Condition did not settle');}
async function fixture(t:test.TestContext){const indexedDB=new IDBFactory();let time=1000,online=false;
  const queue=createDiagnosticQueue({indexedDB,now:()=>time});t.after(()=>queue.close());const state=expectStatus(await queue.state(),'ready');await queue.activate(state.epoch,()=>true);
  return {indexedDB,queue,now:()=>time,connection:()=>online?'online' as const:'offline' as const,
    advance(ms:number){time+=ms;},online(){online=true;},offline(){online=false;}};
}
test('a durable enqueue sends immediately, while an empty queue causes no requests',async t=>{
  const h=await fixture(t);h.online();const calls:unknown[]=[];
  const sender=createDiagnosticDelivery({...h,send:async body=>{calls.push(body);return accepted(...body.reports);}});t.after(()=>sender.close());
  await sender.wake();assert.equal(calls.length,0);
  await h.queue.enqueue(report(1));await until(async()=>expectStatus(await h.queue.state(),'ready').count===0);
  assert.equal(calls.length,1);await sender.wake();await sender.wake();assert.equal(calls.length,1);
});
test('two tabs share one sender and a surviving tab resumes after its owner closes',async t=>{
  const h=await fixture(t),other=createDiagnosticQueue({indexedDB:h.indexedDB,now:h.now});t.after(()=>other.close());const state=expectStatus(await other.state(),'ready');await other.activate(state.epoch,()=>true);
  await h.queue.enqueue(report(1));h.online();const pending=deferred();let first=0,second=0;
  const a=createDiagnosticDelivery({...h,newId:()=>id(800),send:async()=>{first++;return pending.promise;}});
  await until(()=>first===1);
  const b=createDiagnosticDelivery({...h,queue:other,newId:()=>id(801),send:async body=>{second++;return accepted(...body.reports);}});t.after(()=>b.close());
  await b.wake();assert.equal(second,0);
  await a.close();h.advance(1000);await b.wake();await until(async()=>expectStatus(await other.state(),'ready').count===0);
  assert.equal(first,1);assert.equal(second,1);pending.resolve(accepted(report(1)));
});
test('partial ACK deletes only terminal IDs; ownership failures remain original and do not block new reports',async t=>{
  const h=await fixture(t);await h.queue.enqueue(report(1,'17'));await h.queue.enqueue(report(2));await h.queue.enqueue(report(3,'18'));
  const seen:ClientReport[][]=[];let calls=0;
  const sender=createDiagnosticDelivery({...h,send:async body=>{seen.push([...body.reports]);calls++;
    return calls===1?{schemaVersion:1,results:[{eventId:id(1),status:'retryable',reason:'ownership_unverified'},
      {eventId:id(2),status:'accepted',receivedAt:20,duplicate:true},{eventId:id(3),status:'invalid',final:true,reason:'invalid_report'}]}:accepted(...body.reports);
  }});t.after(()=>sender.close());h.online();await sender.wake();
  assert.equal(expectStatus(await h.queue.state(),'ready').count,1);
  await h.queue.enqueue(report(4,'19'));await sender.wake();assert.deepEqual(seen[1],[report(4,'19')]);
  h.advance(1000);await sender.wake();assert.deepEqual(seen[2],[report(1,'17')]);assert.equal(expectStatus(await h.queue.state(),'ready').count,0);
});
test('a lost response retries exactly the same snapshots with increasing shared pauses',async t=>{
  const h=await fixture(t);await h.queue.enqueue(report(1));const calls:string[]=[];let succeeds=false;
  const sender=createDiagnosticDelivery({...h,send:async body=>{calls.push(JSON.stringify(body));if(!succeeds)throw Object.assign(new Error('Unauthorized'),{status:401});return accepted(...body.reports);}});
  t.after(()=>sender.close());h.online();await sender.wake();assert.equal(calls.length,1);
  await sender.wake();h.advance(999);await sender.wake();assert.equal(calls.length,1);
  h.advance(1);await sender.wake();assert.equal(calls.length,2);
  h.advance(4999);await sender.wake();assert.equal(calls.length,2);
  h.advance(1);succeeds=true;await sender.wake();assert.equal(calls.length,3);
  assert.equal(new Set(calls).size,1);assert.equal(expectStatus(await h.queue.state(),'ready').count,0);
});
test('malformed responses and acknowledgements for unrelated IDs never clear a report',async t=>{
  for(const response of [{error:'auth_required'},{schemaVersion:1,results:[{eventId:id(99),status:'accepted',receivedAt:1,duplicate:false}]},
    {schemaVersion:1,results:[{eventId:id(1),status:'invalid',reason:'invalid_report'}]}]){
    const h=await fixture(t);await h.queue.enqueue(report(1));h.online();const sender=createDiagnosticDelivery({...h,send:async()=>response});
    await sender.wake();assert.equal(expectStatus(await h.queue.state(),'ready').count,1);await sender.close();
  }
});
test('a transport ignoring abort is bounded, and late acceptance cannot undo the queue retry',async t=>{
  const h=await fixture(t);await h.queue.enqueue(report(1));h.online();const pending=deferred();let signal:AbortSignal|undefined;
  const sender=createDiagnosticDelivery({...h,timeoutMs:5,send:async(_body,options)=>{signal=options.signal;return pending.promise;}});t.after(()=>sender.close());
  await sender.wake();assert.equal(signal?.aborted,true);assert.equal(expectStatus(await h.queue.state(),'ready').count,1);
  pending.resolve(accepted(report(1)));await new Promise(resolve=>setTimeout(resolve,5));assert.equal(expectStatus(await h.queue.state(),'ready').count,1);
});
test('online logout makes one shared attempt without waiting for ACK and fences the new queue',async t=>{
  const h=await fixture(t),other=createDiagnosticQueue({indexedDB:h.indexedDB,now:h.now});t.after(()=>other.close());const state=expectStatus(await other.state(),'ready');await other.activate(state.epoch,()=>true);
  await h.queue.enqueue(report(1,'17'));const pending=deferred(),calls:{body:unknown;exit:boolean}[]=[];
  const send=async(body:unknown,options:{exit:boolean})=>{calls.push({body,exit:options.exit});return pending.promise;};
  const a=createDiagnosticDelivery({...h,send}),b=createDiagnosticDelivery({...h,queue:other,send});
  t.after(async()=>{await Promise.all([a.close(),b.close()]);});h.online();
  const exits=await Promise.all([a.leave(),b.leave()]);assert.equal(exits.filter(result=>result.status==='cleared').length,1);
  assert.equal(calls.length,1);assert.equal(calls[0].exit,true);
  const fresh=createDiagnosticQueue({indexedDB:h.indexedDB,now:h.now});t.after(()=>fresh.close());const freshState=expectStatus(await fresh.state(),'ready');await fresh.activate(freshState.epoch,()=>true);await fresh.enqueue(report(2,'18'));
  pending.resolve(accepted(report(1,'17')));await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(expectStatus(await fresh.state(),'ready').count,1);assert.equal((await h.queue.enqueue(report(3,'17'))).status,'stale');
});
test('offline logout makes one attempt and clears without waiting; unavailable storage is not claimed cleared',async t=>{
  const h=await fixture(t);await h.queue.enqueue(report(1));let calls=0;
  const sender=createDiagnosticDelivery({...h,send:async()=>{calls++;return null;}});t.after(()=>sender.close());
  assert.equal((await sender.leave()).status,'cleared');assert.equal(calls,1);
  await sender.leave();await sender.wake();assert.equal(calls,1);
  const absent=createDiagnosticQueue({indexedDB:null});t.after(()=>absent.close());
  const unavailable=createDiagnosticDelivery({...h,queue:absent,send:async()=>null});t.after(()=>unavailable.close());
  assert.equal((await unavailable.leave()).status,'unavailable');
});
test('a failed durable ACK removal keeps the report and still backs off instead of flooding the server',async t=>{
  const h=await fixture(t);await h.queue.enqueue(report(1));let calls=0;
  const sender=createDiagnosticDelivery({...h,send:async body=>{calls++;return accepted(...body.reports);}});t.after(()=>sender.close());
  const original=IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete=function(...args){if(this.name==='reports')throw new DOMException('Temporary failure','UnknownError');return original.apply(this,args);};
  try{h.online();await sender.wake();assert.equal(calls,1);assert.equal(expectStatus(await h.queue.state(),'ready').count,1);
    await sender.wake();assert.equal(calls,1);
  }finally{IDBObjectStore.prototype.delete=original;}
  h.advance(999);await sender.wake();assert.equal(calls,1);
  h.advance(1);await sender.wake();assert.equal(calls,2);assert.equal(expectStatus(await h.queue.state(),'ready').count,0);
});
test('background teardown allows the one exit attempt to finish, while forced close cancels the same bounded work',async t=>{
  const h=await fixture(t);await h.queue.enqueue(report(1));const pending=deferred();let signal:AbortSignal|undefined;
  const sender=createDiagnosticDelivery({...h,send:async(_body,options)=>{signal=options.signal;return pending.promise;}});t.after(()=>sender.close());
  h.online();await sender.leave();assert.equal(signal?.aborted,false);
  const graceful=sender.close({finishExit:true});assert.equal(signal?.aborted,false);
  const forced=sender.close();assert.equal(graceful,forced);assert.equal(signal?.aborted,true);await forced;
  pending.resolve(accepted(report(1)));
});


test('origin proof survives reopening and is removed with the old reports after one cold exit',async t=>{
 const h=await fixture(t),proof=`v1.17.${'a'.repeat(32)}.${'A'.repeat(43)}`;
 await h.queue.enqueue(report(1,'17'),proof);h.queue.close();
 const queue=createDiagnosticQueue({indexedDB:h.indexedDB,now:h.now});t.after(()=>queue.close());
 const state=expectStatus(await queue.state(),'ready');await queue.activate(state.epoch,()=>true);
 const calls:{proof?:string;exit:boolean;body:unknown}[]=[];
 const sender=createDiagnosticDelivery({...h,queue,send:async(body,options)=>{calls.push({proof:options.diagnosticProof,exit:options.exit,body});throw Error('offline');}});
 t.after(()=>sender.close());await sender.leave();await sender.leave();
 assert.deepEqual(calls,[{proof,exit:true,body:{schemaVersion:1,reports:[report(1,'17')]}}]);
 const fresh=createDiagnosticQueue({indexedDB:h.indexedDB,now:h.now});t.after(()=>fresh.close());
 assert.equal(expectStatus(await fresh.state(),'ready').count,0);
});

test('different origins use distinct batches; an old report never borrows a new login proof',async t=>{
 const h=await fixture(t),a=`v1.17.${'a'.repeat(32)}.${'A'.repeat(43)}`,b=`v1.18.${'b'.repeat(32)}.${'B'.repeat(43)}`;
 await h.queue.enqueue(report(1,'17'),a);await h.queue.enqueue(report(2));await h.queue.enqueue(report(3,'18'),b);
 const calls:{proof?:string;owners:(string|null)[]}[]=[];
 const sender=createDiagnosticDelivery({...h,send:async(body,options)=>{calls.push({proof:options.diagnosticProof,owners:body.reports.map(r=>r.accountId)});return accepted(...body.reports);}});
 t.after(()=>sender.close());h.online();await sender.wake();
 assert.deepEqual(calls,[{proof:a,owners:['17',null]},{proof:b,owners:['18']}]);
 assert.equal(expectStatus(await h.queue.state(),'ready').count,0);
});
