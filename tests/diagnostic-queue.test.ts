import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore, IDBDatabase } from 'fake-indexeddb';
import { createDiagnosticQueue, DIAGNOSTIC_QUEUE_RETENTION_MS } from '../src/data/diagnostic-queue.ts';
import { clientReportBytes, DIAGNOSTIC_BATCH_MAX_BYTES, type ClientReport, type ClientContextStep } from '../shared/client-report-contract.ts';
function expectStatus<T extends {status:string}, S extends T['status']>(value:T,status:S):Extract<T,{status:S}> {
  assert.equal(value.status,status);return value as Extract<T,{status:S}>;
}
const id=(n:number)=>`${n.toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`;
const owner=id(900),other=id(901),start=Date.parse('2026-10-26T12:00:00Z');
const report=(n:number,extra:Partial<ClientReport>={}):ClientReport=>({schemaVersion:1,eventId:id(n),occurredAt:1700000000000,
  environment:'production',source:'browser',event:'client_failed',level:'error',outcome:'failed',accountId:null,appVersion:'test-1',
  contextId:id(500),action:'calculate',component:'calculator',stage:'request',reason:'connection_failed',...extra} as ClientReport);
async function queues(t:test.TestContext,options:Parameters<typeof createDiagnosticQueue>[0]={}){const indexedDB=new IDBFactory();let now=start;
  const a=createDiagnosticQueue({indexedDB,now:()=>now,...options}),b=createDiagnosticQueue({indexedDB,now:()=>now,...options});
  t.after(()=>{a.close();b.close();});await Promise.all([activate(a),activate(b)]);return {a,b,indexedDB,setNow(value:number){now=value;}};
}
async function activate(queue:ReturnType<typeof createDiagnosticQueue>){const state=expectStatus(await queue.state(),'ready');assert.equal(state.status,'ready');assert.equal(await queue.activate(state.epoch,()=>true),true);}
test('concurrent tabs share one byte budget and evict oldest creation rather than last use',async t=>{
  const size=clientReportBytes(report(1))+256,h=await queues(t,{maxBytes:1024+2*size+8});
  await h.a.enqueue(report(1));await h.b.enqueue(report(2));
  assert.equal(expectStatus(await h.a.enqueue(report(1)),'queued').duplicate,true);
  await h.b.enqueue(report(3));
  const batch=expectStatus(await h.a.claim(owner),'batch');assert.equal(batch.status,'batch');
  assert.deepEqual(batch.entries.map(entry=>entry.eventId),[id(2),id(3)]);
  assert.ok(expectStatus(await h.a.state(),'ready').bytes<=1024+2*size+8);
  const fresh=await queues(t,{maxBytes:1024+2*size+8});
  await Promise.all([fresh.a.enqueue(report(1)),fresh.b.enqueue(report(2)),fresh.a.enqueue(report(3))]);
  assert.equal(expectStatus(await fresh.a.state(),'ready').count,2);assert.ok(expectStatus(await fresh.a.state(),'ready').bytes<=1024+2*size+8);
});
test('report bytes are immutable, conflicting IDs are rejected and retries never renew seven days',async t=>{
  const h=await queues(t);await h.a.enqueue(report(1));h.setNow(start+6*86400000);
  assert.deepEqual(await h.b.enqueue(report(1)),{status:'queued',duplicate:true});
  assert.equal((await h.b.enqueue(report(1,{reason:'timeout'}))).status,'conflict');
  const batch=expectStatus(await h.a.claim(owner),'batch');assert.deepEqual(batch.entries[0].report,report(1));
  await h.a.finish(batch.token,batch.entries,[],'transport');h.setNow(start+DIAGNOSTIC_QUEUE_RETENTION_MS);
  assert.equal((await h.b.claim(other)).status,'empty');assert.equal(expectStatus(await h.b.state(),'ready').bytes,1024);
});
test('error clocks do not define the local queue retention clock',async t=>{
  const h=await queues(t);await h.a.enqueue(report(1,{occurredAt:0}));await h.a.enqueue(report(2,{occurredAt:8e15}));
  assert.equal(expectStatus(await h.a.state(),'ready').count,2);h.setNow(start+DIAGNOSTIC_QUEUE_RETENTION_MS);
  assert.equal(expectStatus(await h.a.state(),'ready').count,0);
});
test('partial acknowledgements remove only exact records and later entries bypass deferred reports',async t=>{
  const h=await queues(t);for(let i=1;i<=34;i++)await h.a.enqueue(report(i));
  const first=expectStatus(await h.a.claim(owner),'batch');assert.equal(first.entries.length,32);
  await h.a.finish(first.token,first.entries,[id(1),id(2),id(999)],'partial');
  const next=expectStatus(await h.b.claim(other),'batch');assert.deepEqual(next.entries.map(entry=>entry.eventId),[id(33),id(34)]);
  await h.b.finish(next.token,next.entries,[id(33),id(34)],'none');
  assert.equal(expectStatus(await h.a.state(),'ready').count,30);assert.equal((await h.a.claim(owner)).status,'waiting');
  h.setNow(start+1000);const retry=expectStatus(await h.a.claim(owner),'batch');
  assert.deepEqual(retry.entries.map(entry=>entry.report),Array.from({length:30},(_,i)=>report(i+3)));
});
test('a sender lease excludes other tabs and recovers after its owner disappears',async t=>{
  const h=await queues(t);await h.a.enqueue(report(1));const first=expectStatus(await h.a.claim(owner),'batch');
  assert.equal((await h.b.claim(other)).status,'waiting');h.setNow(start+30001);
  const recovered=expectStatus(await h.b.claim(other),'batch');assert.equal(recovered.status,'batch');
  const late=await h.a.finish(first.token,first.entries,[id(1)],'none');assert.ok('owned' in late);assert.equal(late.owned,false);
  assert.equal(expectStatus(await h.b.state(),'ready').count,0);
});
test('logout takes one shared bounded snapshot, clears old reports, and fences late acknowledgements and inserts',async t=>{
  const h=await queues(t);for(let i=1;i<=35;i++)await h.a.enqueue(report(i,{accountId:i===1?null:'17'}));
  const pending=expectStatus(await h.a.claim(owner),'batch');
  const outcomes=await Promise.all([h.a.clearForExit(true),h.b.clearForExit(true)]);
  const cleared=outcomes.find(value=>value.status==='cleared');assert.equal(outcomes.filter(value=>value.status==='cleared').length,1);
  assert.ok(cleared);assert.equal(cleared.entries.length,32);assert.equal(cleared.entries[0].report.accountId,null);
  assert.equal((await h.a.enqueue(report(40))).status,'stale');
  const fresh=createDiagnosticQueue({indexedDB:h.indexedDB,now:()=>start});t.after(()=>fresh.close());
  await activate(fresh);await fresh.enqueue(report(1,{accountId:'18'}));
  assert.equal((await h.a.finish(pending.token,pending.entries,[id(1)],'none')).status,'stale');
  assert.equal(expectStatus(await fresh.state(),'ready').count,1);assert.equal(expectStatus(await fresh.claim(other),'batch').entries[0].report.accountId,'18');
});
test('late acknowledgement cannot remove a newly enqueued reused ID after pressure eviction',async t=>{
  const h=await queues(t);await h.a.enqueue(report(1));const old=expectStatus(await h.a.claim(owner),'batch');
  assert.equal(await h.b.discardForSpace(),'released');await h.b.enqueue(report(1,{reason:'timeout'}));
  await h.a.finish(old.token,old.entries,[id(1)],'none');
  assert.equal(expectStatus(await h.b.state(),'ready').count,1);
});
test('a real quota exception does not acknowledge enqueue or corrupt accounting',async t=>{
  const h=await queues(t);await h.a.state();const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args){if(this.name==='reports')throw new DOMException('Full','QuotaExceededError');return original.apply(this,args);};
  try{assert.equal((await h.a.enqueue(report(1))).status,'unavailable');}finally{IDBObjectStore.prototype.put=original;}
  assert.equal(expectStatus(await h.a.state(),'ready').count,0);assert.equal(expectStatus(await h.a.state(),'ready').bytes,1024);
  assert.equal((await h.a.enqueue(report(1))).status,'queued');
});
test('unavailable storage remains optional and offline exit makes no retained delivery snapshot',async t=>{
  const absent=createDiagnosticQueue({indexedDB:null});t.after(()=>absent.close());
  assert.equal((await absent.enqueue(report(1))).status,'unavailable');
  const h=await queues(t);await h.a.enqueue(report(1));const result=await h.a.clearForExit(false);
  assert.ok(result.status==='cleared');assert.deepEqual(result.entries,[]);assert.equal(result.status,'cleared');
});
async function raw<T>(factory:IDBFactory,mode:IDBTransactionMode,action:(store:IDBObjectStore)=>IDBRequest<T>) {
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{const open=factory.open('forma-diagnostics');open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
  try{return await new Promise<T>((resolve,reject)=>{const tx=db.transaction('reports',mode),request=action(tx.objectStore('reports'));
    tx.oncomplete=()=>resolve(request.result);tx.onabort=tx.onerror=()=>reject(tx.error);});}finally{db.close();}
}
test('closing and reopening preserves the exact queued snapshot, without extending its original creation',async t=>{
  const h=await queues(t),input={...report(1)};await h.a.enqueue(input);input.reason='timeout';h.a.close();h.b.close();
  const reopened=createDiagnosticQueue({indexedDB:h.indexedDB,now:()=>start+DIAGNOSTIC_QUEUE_RETENTION_MS-1});t.after(()=>reopened.close());
  await activate(reopened);assert.deepEqual(expectStatus(await reopened.claim(owner),'batch').entries[0].report,report(1));
  const expired=createDiagnosticQueue({indexedDB:h.indexedDB,now:()=>start+DIAGNOSTIC_QUEUE_RETENTION_MS});t.after(()=>expired.close());
  assert.equal(expectStatus(await expired.state(),'ready').count,0);
});
test('quiet TTL cleanup removes bytes from IndexedDB without reads, new reports or network',async t=>{
  const indexedDB=new IDBFactory();let offset=start-Date.now();
  const queue=createDiagnosticQueue({indexedDB,now:()=>Date.now()+offset});t.after(()=>queue.close());await activate(queue);
  await queue.enqueue(report(1));offset+=DIAGNOSTIC_QUEUE_RETENTION_MS-30;
  await queue.enqueue(report(1)); // The duplicate changes no timestamp; it reschedules the real cleanup timer.
  await new Promise(resolve=>setTimeout(resolve,70));
  assert.equal(await raw(indexedDB,'readonly',store=>store.count()),0);
});
test('batch byte bounds apply independently of the count limit',async t=>{
  const h=await queues(t),context=Array.from({length:10},():ClientContextStep=>({stage:'validate',reason:'engine_unavailable',durationMs:1000,
    wait:{kind:'calculation_queue',durationMs:1000},operationId:id(400),requestId:id(401),taskId:id(402)}));
  for(let i=1;i<=32;i++)assert.equal((await h.a.enqueue(report(i,{context}))).status,'queued');
  const batch=expectStatus(await h.a.claim(owner),'batch'),bytes=new TextEncoder().encode(JSON.stringify({schemaVersion:1,reports:batch.entries.map(entry=>entry.report)})).byteLength;
  assert.ok(batch.entries.length<32);assert.ok(bytes<=DIAGNOSTIC_BATCH_MAX_BYTES);
});
test('corrupt persisted reports are discarded without sending private or unsupported content',async t=>{
  const h=await queues(t);await h.a.enqueue(report(1));
  const row=await raw(h.indexedDB,'readonly',store=>store.get(id(1)));
  row.body=new TextEncoder().encode(JSON.stringify({...report(1),email:'private@example.org'}));
  await raw(h.indexedDB,'readwrite',store=>store.put(row));
  assert.equal((await h.a.claim(owner)).status,'empty');assert.equal(expectStatus(await h.a.state(),'ready').bytes,1024);
});
test('a sender identity cannot smuggle an unbounded string into the budget ledger',async t=>{
  const h=await queues(t);await h.a.enqueue(report(1));
  assert.equal((await h.a.claim('x'.repeat(500000))).status,'unavailable');
  assert.equal((await h.a.claim(owner)).status,'batch');
});
test('a cold enqueue cannot wait through logout and adopt the next account epoch',async t=>{
  const h=await queues(t);await h.a.enqueue(report(1,{accountId:'17'}));
  const cold=createDiagnosticQueue({indexedDB:h.indexedDB,now:()=>start});t.after(()=>cold.close());
  const pending=cold.enqueue(report(2,{accountId:'17'}));
  await h.a.clearForExit(false);
  assert.equal((await pending).status,'unavailable');
  assert.equal((await cold.enqueue(report(3,{accountId:'17'}))).status,'stale');
  const fresh=createDiagnosticQueue({indexedDB:h.indexedDB,now:()=>start});t.after(()=>fresh.close());
  assert.equal(expectStatus(await fresh.state(),'ready').count,0);
});
test('quiet TTL cleanup retries a temporary storage failure without any new action',async t=>{
  const indexedDB=new IDBFactory();let offset=start-Date.now();
  const queue=createDiagnosticQueue({indexedDB,now:()=>Date.now()+offset});t.after(()=>queue.close());await activate(queue);
  await queue.enqueue(report(1));offset+=DIAGNOSTIC_QUEUE_RETENTION_MS-30;await queue.enqueue(report(1));
  await new Promise(resolve=>setTimeout(resolve,5));
  const original=IDBDatabase.prototype.transaction;let failed=false;
  IDBDatabase.prototype.transaction=function(...args){if(!failed && args[1]==='readwrite'){failed=true;throw new DOMException('Temporary failure','UnknownError');}return original.apply(this,args);};
  try{await new Promise(resolve=>setTimeout(resolve,1150));assert.equal(failed,true);
    assert.equal(await raw(indexedDB,'readonly',store=>store.count()),0);
  }finally{IDBDatabase.prototype.transaction=original;}
});
test('a separate cold tab cannot adopt a logout epoch through state reads without explicit live-scope activation',async t=>{
  const h=await queues(t);await h.a.enqueue(report(1,{accountId:'17'}));
  // Separate module state models another JS realm; there are no same-realm peers
  // and no delivered BroadcastChannel notification to supply the security fence.
  const isolated=await import(new URL('../src/data/diagnostic-queue.ts?isolated-cold-tab',import.meta.url).href) as typeof import('../src/data/diagnostic-queue.ts');
  const cold=isolated.createDiagnosticQueue({indexedDB:h.indexedDB,now:()=>start});t.after(()=>cold.close());
  const previous=expectStatus(await h.a.state(),'ready'),pending=cold.enqueue(report(2,{accountId:'17'}));let live=true;
  live=false;await h.a.clearForExit(false);
  assert.equal((await pending).status,'unavailable');
  const current=expectStatus(await cold.state(),'ready');assert.equal(current.epoch,previous.epoch+1);assert.equal(current.active,false);
  assert.equal((await cold.enqueue(report(3,{accountId:'17'}))).status,'unavailable');
  assert.equal(await cold.activate(previous.epoch,()=>true),false);
  assert.equal(await cold.activate(current.epoch,()=>live),false);
  const fresh=createDiagnosticQueue({indexedDB:h.indexedDB,now:()=>start});t.after(()=>fresh.close());
  await activate(fresh);assert.equal((await fresh.enqueue(report(4,{accountId:'18'}))).status,'queued');
  assert.equal(expectStatus(await fresh.state(),'ready').count,1);
});
test('revoking an activated access generation immediately denies late report admission',async t=>{
  const indexedDB=new IDBFactory(),queue=createDiagnosticQueue({indexedDB,now:()=>start});t.after(()=>queue.close());
  let live=true;const snapshot=expectStatus(await queue.state(),'ready');assert.equal(snapshot.active,false);
  assert.equal(await queue.activate(snapshot.epoch,()=>live),true);assert.equal((await queue.enqueue(report(1))).status,'queued');
  live=false;assert.equal((await queue.enqueue(report(2))).status,'stale');assert.equal((await queue.claim(owner)).status,'stale');
  // Logout can still clear its bound old epoch after access has been revoked.
  assert.equal((await queue.clearForExit(false)).status,'cleared');
});


test('cold exit matches the original login and cannot clear a later login of the same account',async t=>{
  const indexedDB=new IDBFactory(),options={indexedDB,now:()=>start};
  const first=createDiagnosticQueue(options);t.after(()=>first.close());
  let state=expectStatus(await first.state(),'ready');assert.equal(state.status,'ready');
  assert.equal(await first.activate(state.epoch,()=>true,'session-A1'),true);
  await first.enqueue(report(81,{accountId:'17'}));first.close();
  const cold=createDiagnosticQueue(options);t.after(()=>cold.close());
  const exit=await cold.clearForExit(true,['session-A1']);assert.equal(exit.status,'cleared');
  assert.deepEqual(exit.entries.map(entry=>entry.eventId),[id(81)]);
  const next=createDiagnosticQueue(options);t.after(()=>next.close());state=expectStatus(await next.state(),'ready');
  assert.equal(await next.activate(state.epoch,()=>true,'session-A2'),true);
  assert.equal((await next.enqueue(report(82,{accountId:'17'}))).status,'queued');
  const late=createDiagnosticQueue(options);t.after(()=>late.close());
  assert.equal((await late.clearForExit(true,['session-A1'])).status,'stale');
  assert.equal(expectStatus(await next.state(),'ready').count,1);
  assert.deepEqual(expectStatus(await next.claim(owner),'batch').entries.map(entry=>entry.eventId),[id(82)]);
});


for(const version of [1,2])test(`queue upgrade preserves legacy reports and fences a version-${version} writer`,async t=>{
  const indexedDB=new IDBFactory(),body=new TextEncoder().encode(JSON.stringify(report(91,{accountId:'17'})));
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{
    const opened=indexedDB.open('forma-diagnostics',version);
    opened.onupgradeneeded=()=>{const reports=opened.result.createObjectStore('reports',{keyPath:'eventId'});
      reports.createIndex('sequence','sequence');reports.createIndex('createdAt','createdAt');
      opened.result.createObjectStore('control',{keyPath:'key'});};
    opened.onsuccess=()=>resolve(opened.result);opened.onerror=()=>reject(opened.error);
  });
  await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(['reports','control'],'readwrite');
    tx.objectStore('reports').put({eventId:id(91),sequence:1,epoch:0,createdAt:start,bytes:body.byteLength+256,body,nextAttemptAt:0,failures:0});
    tx.objectStore('control').put({key:'queue',epoch:0,bytes:1024+body.byteLength+256,count:1,sequence:1,retryAt:0,failures:0,lease:null});
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
  });
  db.onversionchange=()=>db.close();t.after(()=>db.close());
  const queue=createDiagnosticQueue({indexedDB,now:()=>start});t.after(()=>queue.close());
  const state=expectStatus(await queue.state(),'ready');assert.ok(state.status==='ready');assert.equal(state.count,1);
  assert.equal(await queue.activate(state.epoch,()=>true,'session-A'),true);
  const batch=expectStatus(await queue.claim(owner),'batch');assert.ok(batch.status==='batch');
  assert.deepEqual(batch.entries.map(entry=>entry.report),[report(91,{accountId:'17'})]);
  const name=await new Promise<string>((resolve,reject)=>{const opened=indexedDB.open('forma-diagnostics',version);
    opened.onerror=()=>resolve(opened.error!.name);opened.onsuccess=()=>{opened.result.close();reject(new Error('Old writer reopened'));};});
  assert.equal(name,'VersionError');
  const next=createDiagnosticQueue({indexedDB,now:()=>start}),late=createDiagnosticQueue({indexedDB,now:()=>start});
  t.after(()=>{next.close();late.close();});
  await next.activate(state.epoch,()=>true,'session-B');
  assert.equal((await late.clearForExit(true,['session-A'])).status,'stale');
  const kept=await next.state();assert.ok(kept.status==='ready');assert.equal(kept.count,1,
    'A late exit cannot guess which earlier login produced an unscoped legacy report');
});

test('two cold exits share one snapshot even when their handles have never activated',async t=>{
  const indexedDB=new IDBFactory(),options={indexedDB,now:()=>start};
  const original=createDiagnosticQueue(options);t.after(()=>original.close());
  const state=expectStatus(await original.state(),'ready');assert.ok(state.status==='ready');
  await original.activate(state.epoch,()=>true,'session-A');await original.enqueue(report(92,{accountId:'17'}));
  original.close();
  const a=createDiagnosticQueue(options),b=createDiagnosticQueue(options);t.after(()=>{a.close();b.close();});
  const exits=await Promise.all([a.clearForExit(true,['session-A']),b.clearForExit(true,['session-A'])]);
  assert.equal(exits.filter(exit=>exit.status==='cleared').length,1);
  assert.deepEqual(exits.flatMap(exit=>exit.status==='cleared'?exit.entries.map(entry=>entry.eventId):[]),[id(92)]);
  const after=await a.state();assert.ok(after.status!=='unavailable');
  const check=createDiagnosticQueue(options);t.after(()=>check.close());
  const current=await check.state();assert.ok(current.status==='ready');assert.equal(current.count,0);
});


test('a late exit removes only its old rows when the new login has already started writing',async t=>{
  const indexedDB=new IDBFactory(),options={indexedDB,now:()=>start};
  const old=createDiagnosticQueue(options);t.after(()=>old.close());
  let state=expectStatus(await old.state(),'ready');assert.ok(state.status==='ready');
  await old.activate(state.epoch,()=>true,'session-A1');await old.enqueue(report(93,{accountId:'17'}));
  const next=createDiagnosticQueue(options);t.after(()=>next.close());state=expectStatus(await next.state(),'ready');assert.ok(state.status==='ready');
  await next.activate(state.epoch,()=>true,'session-A2');await next.enqueue(report(94,{accountId:'17'}));
  const late=createDiagnosticQueue(options);t.after(()=>late.close());
  const exit=await late.clearForExit(true,['session-A1']);assert.equal(exit.status,'cleared');
  assert.deepEqual(exit.entries.map(entry=>entry.eventId),[id(93)]);
  assert.equal((await old.enqueue(report(95,{accountId:'17'}))).status,'stale');
  assert.equal((await next.enqueue(report(96,{accountId:'17'}))).status,'queued');
  const batch=expectStatus(await next.claim(owner),'batch');assert.ok(batch.status==='batch');
  assert.deepEqual(batch.entries.map(entry=>entry.eventId),[id(94),id(96)]);
  assert.equal((await late.clearForExit(true,['session-A1'])).status,'stale');
});


test('a new login sends its own reports without waiting for the old sender lease',async t=>{
  const indexedDB=new IDBFactory(),options={indexedDB,now:()=>start};
  const old=createDiagnosticQueue(options),next=createDiagnosticQueue(options);t.after(()=>{old.close();next.close();});
  const state=expectStatus(await old.state(),'ready');assert.ok(state.status==='ready');
  await old.activate(state.epoch,()=>true,'session-A');await old.enqueue(report(97,{accountId:'17'}));
  const sending=await old.claim(owner);assert.ok(sending.status==='batch');
  await next.activate(state.epoch,()=>true,'session-B');await next.enqueue(report(98,{accountId:'18'}));
  const batch=expectStatus(await next.claim(id(999)),'batch');assert.ok(batch.status==='batch');
  assert.deepEqual(batch.entries.map(entry=>entry.eventId),[id(98)]);
  await old.finish(sending.token,sending.entries,[],'transport');
  assert.equal((await old.claim(owner)).status,'stale');
  const late=createDiagnosticQueue(options);t.after(()=>late.close());
  const exit=await late.clearForExit(true,['session-A']);assert.ok(exit.status==='cleared');
  assert.deepEqual(exit.entries.map(entry=>entry.eventId),[id(97)]);
  await next.finish(batch.token,batch.entries,[id(98)],'none');
  assert.equal((await next.claim(id(999))).status,'empty');
});


test('origin proof is validated, charged to the existing byte budget and expires with its row',async t=>{
 const h=await queues(t),proof=`v1.17.${'a'.repeat(32)}.${'A'.repeat(43)}`,input=report(1,{accountId:'17'});
 const before=expectStatus(await h.a.state(),'ready').bytes;
 assert.equal((await h.a.enqueue(input,proof)).status,'queued');
 assert.equal(expectStatus(await h.a.state(),'ready').bytes-before,clientReportBytes(input)+256+proof.length);
 const row=await raw(h.indexedDB,'readonly',store=>store.get(id(1)));
 assert.equal(row.diagnosticProof,proof);assert.equal(new TextDecoder().decode(row.body).includes(proof),false);
 for(const invalid of ['bad',proof.replace('v1.17.','v1.18.')])assert.equal((await h.a.enqueue(report(2,{accountId:'17'}),invalid)).status,'invalid');
 assert.equal((await h.a.enqueue(report(2),proof)).status,'invalid');
 h.setNow(start+DIAGNOSTIC_QUEUE_RETENTION_MS);assert.equal(expectStatus(await h.b.state(),'ready').count,0);
 assert.equal(await raw(h.indexedDB,'readonly',store=>store.count()),0);
});

test('legacy unsigned reports keep their old body and cannot borrow a signed batch origin',async t=>{
 const h=await queues(t),proof=`v1.17.${'a'.repeat(32)}.${'A'.repeat(43)}`;
 await h.a.enqueue(report(1,{accountId:'17'}));await h.a.enqueue(report(2,{accountId:'17'}),proof);
 const legacy=await h.a.claim(owner);assert.equal(legacy.status,'batch');
 assert.deepEqual(legacy.entries.map(e=>e.eventId),[id(1)]);assert.equal(legacy.entries[0].diagnosticProof,undefined);
 await h.a.finish(legacy.token,legacy.entries,[],'partial');
 const fresh=await h.a.claim(owner);assert.equal(fresh.status,'batch');assert.equal(fresh.entries[0].diagnosticProof,proof);
 assert.deepEqual(fresh.entries[0].report,report(2,{accountId:'17'}));
});
