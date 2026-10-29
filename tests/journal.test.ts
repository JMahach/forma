import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createJournal } from '../src/journal.ts';
import type { DiagnosticRequest, DiagnosticTransport } from '../src/data/diagnostic-client.ts';
import type { ClientReport, ClientContextStep } from '../shared/client-report-contract.ts';

function present<T>(value:T|null):T {assert.ok(value!==null);return value;}
import { createDiagnosticQueue } from '../src/data/diagnostic-queue.ts';
const action={action:'calculate',component:'calculator'} as const;
const failure={stage:'request',reason:'connection_failed'} as const;
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<250;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('Condition did not settle');}
async function stored(factory:IDBFactory){const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=factory.open('forma-diagnostics');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  try{return await new Promise<{accountId:unknown}[]>((resolve,reject)=>{const tx=db.transaction('reports','readonly');const request:IDBRequest<{body:Uint8Array}[]>=tx.objectStore('reports').getAll();
    tx.oncomplete=()=>resolve(request.result.map(row=>{const report:unknown=JSON.parse(new TextDecoder().decode(row.body));assert.ok(report && typeof report==='object' && 'accountId' in report);return report;}));tx.onabort=()=>reject(tx.error);});}finally{db.close();}}
async function fixture(t:test.TestContext,options:Partial<Parameters<typeof createJournal>[0]>={}) {
  const indexedDB=new IDBFactory();let online=false,time=1000;
  const calls:DiagnosticRequest[]=[];
  const journal=createJournal({indexedDB,appVersion:'test-1',environment:'production',
    connection:()=>online?'online':'offline',now:()=>time,send:async body=>{calls.push(body);return {schemaVersion:1,results:body.reports.map(report=>({eventId:report.eventId,status:'accepted',receivedAt:10,duplicate:false}))};},...options});
  t.after(()=>journal.close());await journal.wake();
  return {journal,indexedDB,calls,online(){online=true;},advance(ms:number){time+=ms;}};
}
test('guest login and expiry preserve queued attribution while clearing old action handles',async t=>{
  const h=await fixture(t),oldGuest=h.journal.begin(action);
  assert.equal(present(await h.journal.begin(action).reportFailure(failure)).queued,true);
  h.journal.setAccount('17');assert.equal(await oldGuest.reportFailure(failure),null);
  assert.equal(present(await h.journal.begin(action).reportFailure(failure)).queued,true);
  const oldPrivate=h.journal.begin(action);h.journal.setAccount(null);
  assert.equal(await oldPrivate.reportFailure(failure),null);
  assert.equal(present(await h.journal.begin(action).reportFailure(failure)).queued,true);
  assert.deepEqual((await stored(h.indexedDB)).map(report=>report.accountId).sort(),[null,null,'17'].sort());
  assert.equal(h.calls.length,0);h.online();await h.journal.wake();assert.equal((await stored(h.indexedDB)).length,0);
});
test('a different account after expiry clears the old queue before admitting new reports',async t=>{
  const h=await fixture(t,{accountId:'17'});await h.journal.begin(action).reportFailure(failure);
  h.journal.setAccount(null);await h.journal.begin(action).reportFailure(failure);
  const old=h.journal.begin(action);h.journal.setAccount('18');assert.equal(await old.reportFailure(failure),null);
  const early=await h.journal.begin(action).reportFailure(failure);assert.equal(present(early).queued,false);
  await h.journal.wake();await h.journal.wake();
  assert.equal(present(await h.journal.begin(action).reportFailure(failure)).queued,true);
  assert.deepEqual((await stored(h.indexedDB)).map(report=>report.accountId),['18']);assert.equal(h.calls.length,1);
  assert.deepEqual(h.calls[0].reports.map(report=>report.accountId),['17',null]);
});
test('explicit leave clears RAM immediately and makes one nonblocking exit attempt',async t=>{
  let resolve!:(value:unknown)=>void;const pending=new Promise<unknown>(done=>{resolve=done;}),calls:{body:DiagnosticRequest;options:Parameters<DiagnosticTransport>[1]}[]=[];
  const h=await fixture(t,{accountId:'17',send:async(body,options)=>{calls.push({body,options});return pending;}});
  await h.journal.begin(action).reportFailure(failure);const old=h.journal.begin(action);h.online();
  assert.deepEqual(h.journal.leave(),{status:'pending'});assert.equal(await old.reportFailure(failure),null);
  await until(()=>calls.length===1);assert.equal(calls[0].options.exit,true);assert.equal(calls[0].options.signal.aborted,false);
  assert.equal((await stored(h.indexedDB)).length,0);await h.journal.wake();await h.journal.wake();
  h.journal.setAccount('18'); // Explicit leave forgot the former account; this is a new login.
  resolve({schemaVersion:1,results:[]});await h.journal.close();assert.equal(calls.length,1);
});
test('failed logout clear blocks new admission and retries only local clear without a second exit send',async t=>{
  const h=await fixture(t,{accountId:'17'});await h.journal.begin(action).reportFailure(failure);
  const original=IDBObjectStore.prototype.clear;let failures=0;
  IDBObjectStore.prototype.clear=function(...args){if(this.name==='reports'){failures++;throw new DOMException('Temporary failure','UnknownError');}return original.apply(this,args);};
  try{h.online();h.journal.setAccount('18');await h.journal.wake();assert.equal(failures,1);
    assert.equal(present(await h.journal.begin(action).reportFailure(failure)).queued,false);
    await h.journal.wake();assert.equal(failures,1);assert.equal(h.calls.length,0);
  }finally{IDBObjectStore.prototype.clear=original;}
  h.advance(1000);await h.journal.wake();await h.journal.wake();assert.equal((await stored(h.indexedDB)).length,0);
  assert.equal(present(await h.journal.begin(action).reportFailure(failure)).queued,true);
  await until(()=>h.calls.length===1);assert.equal(h.calls[0].reports[0].accountId,'18');
});
test('late initial readiness cannot revive or clear an unknown generation',async t=>{
  const indexedDB=new IDBFactory(),calls:DiagnosticRequest[]=[];
  const journal=createJournal({indexedDB,accountId:'17',appVersion:'test-1',environment:'stand',connection:()=> 'offline',send:async body=>{calls.push(body);return null;}});
  t.after(()=>journal.close());const old=journal.begin(action);journal.setAccount('18');
  assert.equal(await old.reportFailure(failure),null);await journal.wake();await journal.wake();await journal.wake();
  assert.equal(present(await journal.begin(action).reportFailure(failure)).queued,false);
  assert.deepEqual((await stored(indexedDB)),[]);assert.equal(calls.length,0);
});
test('cold leave reports unavailable and never clears a later queue belonging to another tab',async t=>{
  const indexedDB=new IDBFactory(),journal=createJournal({indexedDB,accountId:'17',appVersion:'test-1',environment:'stand',connection:()=> 'offline'});
  t.after(()=>journal.close());assert.deepEqual(journal.leave(),{status:'unavailable'});
  const other=createDiagnosticQueue({indexedDB});t.after(()=>other.close());const before=await other.state();assert.ok(before.status==='ready');await other.activate(before.epoch,()=>true);await other.clearForExit(false);
  const fresh=createDiagnosticQueue({indexedDB});t.after(()=>fresh.close());const current=await fresh.state();assert.ok(current.status==='ready');await fresh.activate(current.epoch,()=>true);
  const report:ClientReport={schemaVersion:1,eventId:crypto.randomUUID(),occurredAt:1,environment:'stand',source:'browser',event:'client_failed',level:'error',outcome:'failed',
    accountId:'18',appVersion:'test-1',contextId:crypto.randomUUID(),action:'calculate',component:'calculator',stage:'request',reason:'connection_failed'};
  assert.equal((await fresh.enqueue(report)).status,'queued');await journal.wake();await journal.wake();
  const after=await fresh.state();assert.ok(after.status==='ready');assert.equal(after.count,1);assert.deepEqual((await stored(indexedDB)).map(report=>report.accountId),['18']);
});
test('closing revokes actions and never clears a durable backlog or creates a logout attempt',async t=>{
  const h=await fixture(t,{accountId:'17'});await h.journal.begin(action).reportFailure(failure);const old=h.journal.begin(action);
  const first=h.journal.close(),second=h.journal.close();assert.equal(first,second);await first;
  assert.equal(await old.reportFailure(failure),null);assert.equal((await stored(h.indexedDB)).length,1);assert.equal(h.calls.length,0);
});
test('a browser storage security exception never escapes construction, reporting or explicit leave',async()=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'indexedDB');let journal:ReturnType<typeof createJournal>|undefined;
  Object.defineProperty(globalThis,'indexedDB',{configurable:true,get(){throw new DOMException('Storage disabled','SecurityError');}});
  try{
    assert.doesNotThrow(()=>{journal=createJournal({appVersion:'test-1',environment:'production'});});
    assert.equal(present(await journal!.begin(action).reportFailure(failure)).queued,false);
    assert.deepEqual(journal!.leave(),{status:'unavailable'});
  }finally{if(original)Object.defineProperty(globalThis,'indexedDB',original);else Reflect.deleteProperty(globalThis,'indexedDB');await journal?.close();}
});
test('reportError keeps one handle and never copies private exception data or invokes its getters',async t=>{
  const h=await fixture(t);let touched=0;
  const error=Object.assign(new Error('private@example.org'),{code:'invalid_response',details:{note:'private note'}});
  Object.defineProperty(error,'stack',{get(){touched++;return 'private stack';}});
  const work=h.journal.begin(action),result=present(await work.reportError(error,{stage:'response'}));
  assert.equal(result.report.reason,'invalid_response');assert.equal(result.queued,true);
  assert.equal(JSON.stringify(result.report).includes('private'),false);assert.equal(touched,0);
  assert.equal(await work.reportFailure(failure),null);
  const unknown=Object.defineProperty({message:'private'},'code',{get(){touched++;return 'timeout';}});
  assert.equal(present(await h.journal.begin(action).reportError(unknown,{stage:'response'})).report.reason,'unclassified_error');
  assert.equal(touched,0);
  // Accessor-backed input must reach the runtime guard unchanged, without reading stage.
  const accessorStep=Object.defineProperty({},'stage',{enumerable:true,get(){touched++;return 'response';}}) as Omit<ClientContextStep,'reason'>;
  assert.equal(await h.journal.begin(action).reportError(error,accessorStep),null);
  assert.equal(touched,0);
});
test('reportError normalizes unknown writes and suppresses native abort and ordinary access changes',async t=>{
  const h=await fixture(t);
  const unknown=present(await h.journal.begin(action).reportError({code:'write_unknown',message:'private'}, {stage:'commit'}));
  assert.equal(unknown.report.reason,'outcome_unknown');assert.equal(unknown.report.outcome,'unknown');assert.equal(unknown.report.event,'client_outcome_unknown');
  for(const error of [new DOMException('private','AbortError'),Object.assign(new Error('private'),{name:'AbortError'}),
    {code:'offline'},{code:'cancelled'},{code:'account_changed'}])assert.equal(await h.journal.begin(action).reportError(error,{stage:'request'}),null);
  assert.equal((await stored(h.indexedDB)).length,1);
});
test('an immediate startup report awaits its own IDB readiness but never waits for network delivery',{timeout:1000},async t=>{
  const indexedDB=new IDBFactory();let calls=0;
  const journal=createJournal({indexedDB,appVersion:'test-1',environment:'stand',send:async()=>{calls++;return new Promise(()=>{});}});
  t.after(()=>journal.close());
  const result=present(await journal.begin({action:'startup',component:'startup'}).reportError(new Error('private startup error'),{stage:'restore'}));
  assert.equal(result.queued,true);assert.equal((await stored(indexedDB)).length,1);await until(()=>calls===1);
});
test('an early report cannot follow a replacement owner while its initial IDB open is pending',async t=>{
  for(const boundary of ['leave','switch'] as const) {
    const indexedDB=new IDBFactory(),journal=createJournal({indexedDB,accountId:'17',appVersion:'test-1',environment:'stand',connection:()=> 'offline'});
    t.after(()=>journal.close());const pending=journal.begin(action).reportError(new Error('private'),{stage:'restore'});
    if(boundary==='leave')journal.leave();else journal.setAccount('18');
    assert.equal(present(await pending).queued,false);await journal.wake();assert.equal((await stored(indexedDB)).length,0);
  }
});


test('cold exit sends the old account once and admits a new login without waiting for the response', async t=>{
  const indexedDB=new IDBFactory(),sent:DiagnosticRequest[]=[];
  const options={indexedDB,appVersion:'test-1',environment:'stand' as const,connection:()=> 'offline' as const};
  const seed=createJournal({...options,accountId:'17',sessionId:'session-A'});
  assert.equal(present(await seed.begin(action).reportFailure(failure)).queued,true);
  await seed.close();
  const journal=createJournal({...options,accountId:'17',sessionId:'session-A',send:async body=>{
    sent.push(body);return new Promise(()=>{});
  }});
  t.after(()=>journal.close());
  const late=journal.begin(action).reportFailure(failure);
  journal.leave(['session-A']);journal.setAccount('18','session-B');
  assert.equal(present(await late).queued,false);
  for(let i=0;i<5;i++)await journal.wake();
  assert.equal(present(await journal.begin(action).reportFailure(failure)).queued,true);
  assert.deepEqual(sent.flatMap(body=>body.reports.map(report=>report.accountId)),['17']);
  assert.deepEqual((await stored(indexedDB)).map(report=>report.accountId),['18']);
  await journal.wake();assert.equal(sent.length,1);
});


test('journal captures proof with the report owner, retains it across expiry, then forgets it on exit',async t=>{
 const proof=`v1.17.${'a'.repeat(32)}.${'A'.repeat(43)}`,calls:{body:DiagnosticRequest;proof?:string}[]=[];
 const h=await fixture(t,{send:async(body,options)=>{calls.push({body,proof:options.diagnosticProof});return null;}});
 h.journal.setAccount('17','a'.repeat(32),proof);
 assert.equal(present(await h.journal.begin(action).reportFailure(failure)).queued,true);
 h.journal.setAccount(null);await h.journal.begin(action).reportFailure(failure);
 h.journal.leave(['a'.repeat(32)]);h.journal.setAccount('18','b'.repeat(32),`v1.18.${'b'.repeat(32)}.${'B'.repeat(43)}`);
 await until(()=>calls.length===1);
 assert.equal(calls[0].proof,proof);assert.deepEqual(calls[0].body.reports.map(r=>r.accountId),['17',null]);
 assert.equal(JSON.stringify(calls[0].body).includes(proof),false);
});


test('relogin of the same account sends an older signed report with its original proof after another reload',async t=>{
 const indexedDB=new IDBFactory(),scopeA='a'.repeat(32),scopeB='b'.repeat(32);
 const proofA=`v1.17.${scopeA}.${'A'.repeat(43)}`,proofB=`v1.17.${scopeB}.${'B'.repeat(43)}`;
 const options={indexedDB,appVersion:'test-1',environment:'production' as const};
 const a=createJournal({...options,accountId:'17',sessionId:scopeA,diagnosticProof:proofA,connection:()=> 'offline'});
 await a.begin(action).reportFailure(failure);a.setAccount(null);a.setAccount('17',scopeB,proofB);
 await a.wake();await a.begin(action).reportFailure(failure);await a.close();
 const sent:string[]=[];
 const restored=createJournal({...options,send:async(body,options)=>{sent.push(options.diagnosticProof!);
  return {schemaVersion:1,results:body.reports.map(report=>({eventId:report.eventId,status:'accepted',receivedAt:1,duplicate:false}))};}});
 t.after(()=>restored.close());await restored.wake();
 assert.deepEqual(sent,[proofA,proofB]);assert.equal((await stored(indexedDB)).length,0);
});

test('public journal relief discards pending diagnostics, reports no further space, and admits later errors',async t=>{
 const h=await fixture(t);await h.journal.begin(action).reportFailure(failure);
 assert.equal((await stored(h.indexedDB)).length,1);
 assert.equal(await h.journal.discardForSpace(),'released');assert.equal((await stored(h.indexedDB)).length,0);
 assert.equal(await h.journal.discardForSpace(),'empty');
 assert.equal(present(await h.journal.begin(action).reportFailure(failure)).queued,true);
 assert.equal((await stored(h.indexedDB)).length,1);
});


function browserEvent(type:string,field:'error'|'reason',value:unknown) {
 const event=new Event(type);Object.defineProperty(event,field,{value});return event;
}
test('unexpected browser failures enter the same durable queue with bounded environment metadata',async t=>{
 const h=await fixture(t),target=new EventTarget();
 const navigator={userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1 secret-marker'};
 assert.equal(typeof h.journal.attachBrowser,'function','the running browser must have a journal source');
 h.journal.attachBrowser(target,navigator);
 const privateError=Object.assign(new Error('private form content'),{code:'invalid_response'});
 Object.defineProperty(privateError,'stack',{get(){throw new Error('Do not inspect private stack');}});
 target.dispatchEvent(browserEvent('error','error',privateError));
 target.dispatchEvent(browserEvent('unhandledrejection','reason',new Error('private rejection')));
 await until(async()=> (await stored(h.indexedDB)).length===2);
 const reports=await stored(h.indexedDB) as ClientReport[];
 assert.deepEqual(reports.sort((a,b)=>a.stage.localeCompare(b.stage)).map(r=>[r.action,r.component,r.stage,r.reason]),[
  ['runtime','runtime','render','invalid_response'],['runtime','runtime','wait','unclassified_error']]);
 for(const report of reports){assert.deepEqual(report.browser,{name:'safari',version:'18.0'});assert.equal(report.os,'ios');assert.equal(report.device,'phone');}
 assert.doesNotMatch(JSON.stringify(reports),/private|secret-marker|Mozilla|userAgent|stack/);
});

test('browser sources replace subscriptions, leave ordinary cancellation silent and detach on close',async t=>{
 const h=await fixture(t),first=new EventTarget(),second=new EventTarget();
 assert.equal(typeof h.journal.attachBrowser,'function');
 const detach=h.journal.attachBrowser(first,{userAgent:'unknown'});
 h.journal.attachBrowser(first,{userAgent:'unknown'});
 detach(); // A stale disposer must not remove the replacement subscription.
 first.dispatchEvent(browserEvent('error','error',new Error('one')));
 await until(async()=> (await stored(h.indexedDB)).length===1);
 h.journal.attachBrowser(second,{userAgent:'unknown'});
 first.dispatchEvent(browserEvent('error','error',new Error('old target')));
 second.dispatchEvent(new Event('error')); // Resource error carries a URL, not an exception fact.
 second.dispatchEvent(browserEvent('unhandledrejection','reason',new DOMException('Cancelled','AbortError')));
 second.dispatchEvent(browserEvent('unhandledrejection','reason',{code:'offline'}));
 second.dispatchEvent(browserEvent('error','error',new Error('two')));
 await until(async()=> (await stored(h.indexedDB)).length===2);
 await h.journal.close();
 second.dispatchEvent(browserEvent('error','error',new Error('closed')));
 assert.equal((await stored(h.indexedDB)).length,2);
});

test('browser environment belongs to the original report and unavailable hints stay absent',async t=>{
 const h=await fixture(t),target=new EventTarget();
 assert.equal(typeof h.journal.attachBrowser,'function');
 h.journal.attachBrowser(target,{userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.1.0'});
 const original=h.journal.begin(action);
 h.journal.attachBrowser(target,{get userAgent():string{throw new Error('unavailable');}});
 const first=present(await original.reportFailure(failure)).report;
 assert.deepEqual(first.browser,{name:'edge',version:'130.0.1.0'});assert.equal(first.os,'windows');assert.equal(first.device,'desktop');
 const second=present(await h.journal.begin(action).reportFailure(failure)).report;
 for(const key of ['browser','os','device'])assert.equal(Object.hasOwn(second,key),false);
});


test('one browser subscription follows a new account without replaying the former account failure',async t=>{
 const h=await fixture(t,{accountId:'17',sessionId:'first'}),target=new EventTarget();
 h.journal.attachBrowser(target,{userAgent:'unknown'});
 target.dispatchEvent(browserEvent('error','error',new Error('old')));
 await until(async()=> (await stored(h.indexedDB)).length===1);
 h.journal.leave(['first']);h.journal.setAccount('18','second');
 for(let i=0;i<4;i++)await h.journal.wake();
 target.dispatchEvent(browserEvent('error','error',new Error('new')));
 await until(async()=> (await stored(h.indexedDB)).length===1);
 assert.deepEqual(h.calls.flatMap(body=>body.reports.map(report=>report.accountId)),['17']);
 assert.deepEqual((await stored(h.indexedDB)).map(report=>report.accountId),['18']);
});
