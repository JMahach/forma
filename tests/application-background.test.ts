import test,{type TestContext} from 'node:test';
import {createActor} from 'xstate';
import {createAccountLibrary,type LibraryRefreshResult} from '../src/state/account-library.ts';
import {createBackgroundWork} from '../src/application/background-work.ts';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application/application.ts';
import type {BackgroundRequest} from '../src/application/background-work.ts';
import {createBackgroundCoordinator} from '../src/platform/browser/background-coordinator.ts';
import {createAccountLibraryStore} from '../src/data/account-library-store.ts';
import {IDBFactory} from 'fake-indexeddb';
import {createIndexedDatabase} from '../src/data/indexed-db.ts';
import {createLibraryLocalChanges,trackLibraryChanges} from '../src/data/library-local-changes.ts';
import type {LibraryLocalNotice} from '../src/domain/library-maintenance.ts';
import {accountChart} from './helpers/account-chart.ts';
import {libraryRecordEntry} from '../src/state/library-reconciliation.ts';
import type {FillReceipt} from '../src/application/library-fill.ts';
import type {LibraryAuditPage} from '../src/domain/library-maintenance.ts';
const clock={now:Date.now,after(ms:number,run:()=>void){const t=setTimeout(run,ms);return()=>clearTimeout(t);}};
const defaults={clock,id:()=>crypto.randomUUID(),environment:{visible:()=>true,online:()=>true,connected:()=>true,busy:()=>false,transitTimeZone:()=>undefined},release:null,journal:null,local:{changed(){},broadcast(){}}};
const libraryDefaults={session:null,workingLease:null,completeCatalog:null,async load(){return {status:'inactive' as const};},cancelCatalogReads(){},async markOpened(){},async receive(){},async refreshLocal(){}};
const idleCoordinator={start(){},update(){},stop(){}};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('application children pause fill and local audit and discard their late results after stop',async t=>{
 const store=createAccountLibraryStore({indexedDB:new IDBFactory()});t.after(()=>store.close());
 const active=await store.activate('1');if(active.status!=='stored')throw Error('owner');
 const scope={lease:active.lease,sessionId:'session',catalogMarker:'1',visible:true,foreground:false,online:true},chart=accountChart();
 let fillSignal:AbortSignal|undefined,auditSignal:AbortSignal|undefined,receives=0,pages=0;
 let finishFill!:(reply:FillReceipt)=>void,finishAudit!:(page:LibraryAuditPage)=>void;
 const app=createApplication({runtimeId:'A',background:{...defaults,coordinator:idleCoordinator,environment:{...defaults.environment,busy:()=>scope.foreground},library:{...libraryDefaults,session:{accountId:'1',sessionId:'session'},workingLease:active.lease,completeCatalog:null}},libraryFill:{clock,id:defaults.id,
  entries:()=>[libraryRecordEntry(chart)],control:store.fill,inventory:store.maintenance.inventory,
  present:async()=>false,receive:async(_candidate,signal)=>{receives++;fillSignal=signal;return new Promise<FillReceipt>(resolve=>{finishFill=resolve;});},
  place:async()=>assert.fail('a retired child cannot place its late packet'),
 },libraryAudit:{clock,id:defaults.id,store:{...store.maintenance,
  auditPage:async(_lease,_cursor,_limit,signal)=>{pages++;auditSignal=signal;return new Promise<LibraryAuditPage>(resolve=>{finishAudit=resolve;});},
 }}});t.after(()=>app.stop());app.start();
 app.send({type:'FillWake',at:Date.now(),reason:'library'});app.send({type:'AuditWake',at:Date.now()});
 for(let i=0;i<50 && (!fillSignal || !auditSignal);i++)await tick();
 assert.equal(receives,1);assert.equal(pages,1);
 scope.foreground=true;app.send({type:'FillChanged'});app.send({type:'AuditChanged'});
 assert.equal(fillSignal?.aborted,true);assert.equal(auditSignal?.aborted,true);
 await app.stop();scope.foreground=false;finishFill({kind:'ready',payload:chart});finishAudit({checked:0,removed:0,next:null});
 app.send({type:'FillChanged'});app.send({type:'AuditWake',at:Date.now()});await tick();await tick();
 assert.equal(receives,1);assert.equal(pages,1);assert.deepEqual((await store.read())?.charts,[]);
});
test('the application owns background lifetime and dispatches only a current admitted task',async()=>{
 let receive:(request:BackgroundRequest)=>void=()=>{},updates=0,stops=0,calls=0,answer:unknown;
 const target={key:'app',scope:{kind:'app' as const},instance:'release'},controller=new AbortController();
 const authority={permit:{key:'app',token:'t',owner:'A',startedAt:1,expiresAt:30001},signal:controller.signal,current:async()=>!controller.signal.aborted};
 const application=createApplication({runtimeId:'A',background:{...defaults,
  coordinator:{start(listener){receive=listener;},update(){updates++;},stop(){controller.abort();stops++;}},
  release:{async check(){calls++;},observe(){},stop(){}},
 }});
 application.start();receive({kind:'check',target,authority,finish(result){answer=result;}});await tick();
 assert.equal(calls,1);assert.deepEqual(answer,{outcome:{kind:'success'},data:{checked:true}});
 application.send({type:'BackgroundChanged'});assert.equal(updates,2);
 await application.stop();await application.stop();assert.equal(stops,1);
 receive({kind:'check',target,authority,finish(){}});await tick();assert.equal(calls,1);
});
test('unavailable coordination admits one initial library read per confirmed session and no retry on resume',async()=>{
 let receive:(request:BackgroundRequest)=>void=()=>{},sessionId='first',reads=0;
 const signal=new AbortController().signal;
 const application=createApplication({runtimeId:'A',background:{...defaults,
  coordinator:{start(listener){receive=listener;},update(){receive({kind:'unavailable',signal});},stop(){}},
  library:{...libraryDefaults,get session(){return {accountId:'1',sessionId};},load:async()=>{reads++;throw new Error('unavailable');}},
 }});
 application.start();await tick();assert.equal(reads,1);
 application.send({type:'BackgroundChanged'});receive({kind:'unavailable',signal});await tick();assert.equal(reads,1);
 sessionId='second';application.send({type:'BackgroundChanged'});await tick();assert.equal(reads,2);
 await application.stop();
});

test('without BroadcastChannel initial offline installation waits for visibility and never repeats on return',async()=>{
 let active=false,notify:()=>void=()=>{},installs=0;
 const coordinator=createBackgroundCoordinator({owner:'A',channel:null,
  store:{read:async()=>null,update:async()=>null},
  lifecycle:{get active(){return active;},subscribe(listener){notify=()=>listener(true);return()=>{};}},
 });
 const application=createApplication({runtimeId:'A',background:{...defaults,coordinator,
  release:{async install(){installs++;},check:async()=>assert.fail('no shared update'),observe(){},stop(){}},
 }});
 application.start();await tick();assert.equal(installs,0);
 active=true;notify();await tick();assert.equal(installs,1);
 active=false;notify();active=true;notify();await tick();assert.equal(installs,1);
 await application.stop();notify();await tick();assert.equal(installs,1);
});

test('a pending first install excludes a simultaneous shared release check',async()=>{
 let receive:(request:BackgroundRequest)=>void=()=>{},finishInstall!:()=>void,updates=0;
 const target={key:'app',scope:{kind:'app' as const},instance:'release'},signal=new AbortController().signal;
 const authority={permit:{key:'app',token:'t',owner:'A',startedAt:1,expiresAt:30001},signal,current:async()=>true};
 const application=createApplication({runtimeId:'A',background:{...defaults,
  coordinator:{start(listener){receive=listener;},update(){receive({kind:'foreground',signal});},stop(){}},
  release:{install:()=>new Promise<void>(resolve=>{finishInstall=resolve;}),check:async()=>{updates++;},observe(){},stop(){}},
 }});
 application.start();let answer:unknown;
 receive({kind:'check',target,authority,finish(result){answer=result;}});await tick();
 assert.equal(updates,0);assert.deepEqual(answer,{outcome:{kind:'cancelled'}});
 finishInstall();await tick();
 receive({kind:'check',target,authority,finish(result){answer=result;}});await tick();
 assert.equal(updates,1);assert.deepEqual(answer,{outcome:{kind:'success'},data:{checked:true}});await application.stop();
});

test('update preparation blocks new background work and waits for actual usage writes',async t=>{
 let finish!:()=>void,uses=0,prepared=false,checkpoints=0,checks=0,receive:(request:BackgroundRequest)=>void=()=>{};
 const control=new AbortController();
 const library={...libraryDefaults,session:{accountId:'1',sessionId:'s'},workingLease:{accountId:'1',generation:'g'},completeCatalog:null,
  markOpened(){uses++;return new Promise<void>(resolve=>{finish=resolve;});},async load(){return {status:'unchanged' as const,durable:false};}};
 const app=createApplication({runtimeId:'barrier',startup:{
  library:{get:()=>null,open:async()=>{}},view:{interrupted:false,savedSelection:undefined,restore:async()=>true,resume(){},flush(){}},
  form:{pending:null,opened:false,clearPending(){},restore(){}},report(){},changed(){},
 },background:{...defaults,library,
  coordinator:{start(fn){receive=fn;},update(){},stop(){}},release:{async check(){checks++;},observe(){},stop(){}}},
  update:{restored:()=>true,ready:()=>true,selection:()=> 'current-transit',
   sources:{temporaryId:null,publicId:null,hasOwn:()=>false,canRestore:()=>false},checkpoint(){checkpoints++;return true;}}});
 t.after(async()=>{finish?.();control.abort();await app.stop();});
 app.start();await app.whenRestored();app.send({type:'LibraryUsed',id:'one'});assert.equal(uses,1);
 const preparation=Promise.resolve(app.prepareUpdate(control.signal)).then(value=>{prepared=true;return value;});
 app.send({type:'LibraryUsed',id:'two'});assert.equal(uses,1);await tick();assert.equal(prepared,false);assert.equal(checkpoints,0);
 const authority={permit:{key:'app',owner:'A',token:'p',startedAt:1,expiresAt:30000},signal:new AbortController().signal,current:async()=>true};
 const check=()=>receive({kind:'check',target:{key:'app',scope:{kind:'app'},instance:'release'},authority,finish(){}});
 check();await tick();assert.equal(checks,0);
 finish();assert.equal(await preparation,true);assert.equal(checkpoints,1);
 app.send({type:'LibraryUsed',id:'two'});check();await tick();assert.equal(uses,1);assert.equal(checks,0);
 control.abort();app.send({type:'LibraryUsed',id:'two'});assert.equal(uses,2);finish();
});

test('cancelling update preparation preserves the consumed first-install allowance',async t=>{
 let installs=0,updates=0,receive:(request:BackgroundRequest)=>void=()=>{};
 const signal=new AbortController().signal,control=new AbortController();
 const app=createApplication({runtimeId:'allowance',startup:{
  library:{get:()=>null,open:async()=>{}},view:{interrupted:false,savedSelection:undefined,restore:async()=>true,resume(){},flush(){}},
  form:{pending:null,opened:false,clearPending(){},restore(){}},report(){},changed(){},
 },background:{...defaults,
  coordinator:{start(fn){receive=fn;},update(){updates++;receive({kind:'unavailable',signal});},stop(){}},
  release:{async install(){installs++;},async check(){},observe(){},stop(){}}},
  update:{restored:()=>true,ready:()=>true,selection:()=> 'current-transit',
   sources:{temporaryId:null,publicId:null,hasOwn:()=>false,canRestore:()=>false},checkpoint:()=>true}});
 t.after(async()=>{control.abort();await app.stop();});
 app.start();await app.whenRestored();await tick();assert.equal(installs,1);
 assert.equal(await app.prepareUpdate(control.signal),true);
 receive({kind:'foreground',signal});await tick();assert.equal(installs,1);
 const before=updates;control.abort();await tick();assert.ok(updates>before);assert.equal(installs,1);
});

async function cancelledCatalogFixture(t:TestContext,second:'complete'|'failed'='complete'){
 let reads=0,installs=0,wakes=0,preparing=false,notify:()=>void=()=>{},release:()=>void=()=>{};
 const store=createAccountLibraryStore({indexedDB:new IDBFactory()});
 const library=createAccountLibrary({storage:store,online:()=>true,client:{
  async catalog(){
   reads++;if(reads===1)await new Promise<void>(resolve=>{release=resolve;});
   if(second==='failed' && reads>1)throw Error('network failure');
   return {kind:'page',accountId:'1',marker:'1',entries:[],nextCursor:null};
  },async confirmCatalog(){return {kind:'confirmed',accountId:'1',marker:'1'};},async own(){assert.fail('no card fetch');}
 }});
 await library.connect({accountId:'1',sessionId:'one'});
 const coordinator=createBackgroundCoordinator({owner:'proposal',channel:null,store:{read:async()=>null,update:async()=>null},
  lifecycle:{active:true,subscribe(listener){notify=()=>listener(true);return()=>{};}}});
 const work=createBackgroundWork({library,coordinator,clock:{now:Date.now},
  environment:{visible:()=>true,online:()=>true,connected:()=>true,busy:()=>false,transitTimeZone:()=>undefined},
  release:{async install(){installs++;},async check(){assert.fail('no shared check');},observe(){},stop(){}},journal:null,local:{changed(){},broadcast(){}}},
  {state:()=>({running:true,restored:true,accountReady:true,opening:false,writing:false,preparingUpdate:preparing}),publicTask:()=>null,changed(){},
   wake(_at,reason){if(reason==='library')wakes++;},environmentChanged(){}});
 const actor=createActor(work.logic);t.after(()=>{actor.stop();release();library.close();});
 return {library,actor,start(){actor.start();},counts:()=>({reads,installs,wakes}),prepare(value:boolean){preparing=value;actor.send({type:'BackgroundChanged'});},
  notify(){notify();actor.send({type:'BackgroundChanged'});},release(){release();},setLoad(fn:()=>LibraryRefreshResult){library.load=async()=>{reads++;return fn();};}};
}
for(const timing of ['settle-first','gate-first'])for(const outcome of ['complete','failed'] as const)test(`cancelled first catalogue resumes once: ${timing}, then ${outcome}`,async t=>{
 const f=await cancelledCatalogFixture(t,outcome);f.start();
 for(let i=0;i<50 && f.counts().reads===0;i++)await tick();
 assert.equal(f.counts().reads,1);f.prepare(true);
 if(timing==='settle-first'){
  for(let i=0;i<5;i++)await tick();
  assert.deepEqual(f.counts(),{reads:1,installs:1,wakes:0});
 }
 f.prepare(false);
 for(let i=0;i<50 && (f.counts().reads<2 || outcome==='complete'&&!f.library.completeCatalog);i++)await tick();
 assert.equal(f.counts().reads,2);assert.equal(f.counts().installs,1);
 assert.equal(f.library.completeCatalog!==null,outcome==='complete');
 assert.equal(f.counts().wakes,outcome==='complete'?1:0);
 for(let i=0;i<6;i++){f.notify();await tick();}
 assert.equal(f.counts().reads,2,'neither a successful nor failed retry is renewed by return events');
 f.release();await tick();assert.equal(f.counts().reads,2);
});
for(const outcome of ['failed','superseded'])test(`a completed ${outcome} first attempt is not restored by preparation`,async t=>{
 const f=await cancelledCatalogFixture(t);f.setLoad(()=>{if(outcome==='failed')throw Error('failed');return {status:'superseded'};});f.start();
 await tick();assert.equal(f.counts().reads,1);f.prepare(true);f.prepare(false);
 for(let i=0;i<6;i++){f.notify();await tick();}
 assert.deepEqual(f.counts(),{reads:1,installs:1,wakes:0});
});

test('only committed payload notices wake space locally and across the current library scope',async t=>{
 let now=10000;const times:number[]=[];
 const lease={accountId:'1',generation:'current'},wakes:string[]=[],sent:LibraryLocalNotice[]=[],accepted:unknown[]=[];
 const work=createBackgroundWork({...defaults,clock:{now:()=>now},coordinator:idleCoordinator,library:{...libraryDefaults,session:{accountId:'1',sessionId:'login'},workingLease:lease},
  local:{changed(change){accepted.push(change);},broadcast(notice){sent.push(notice);}}},
  {state:()=>({running:true,restored:true,accountReady:true,opening:false,writing:false,preparingUpdate:false}),publicTask:()=>null,changed(){},wake(at,reason){wakes.push(reason);times.push(at);},environmentChanged(){}});
 const actor=createActor(work.logic).start(),local=createLibraryLocalChanges(()=>now);
 const db=createIndexedDatabase({databaseName:'committed-payload-notices',version:1,stores:['records'],upgrade(db){db.createObjectStore('records',{keyPath:'id'});},indexedDB:new IDBFactory()});
 local.subscribeLocal(change=>actor.send({type:'LibraryLocalChanged',change}));t.after(()=>{actor.stop();local.close();db.close();});
 const write=async(payloadStored?:true,abort=false)=>db.transactionResult('readwrite',(tx,done,fail)=>{
  const mark=trackLibraryChanges(tx,local.changed(lease),payloadStored);tx.objectStore('records').put({id:'card',payload:'actual data'});
  mark('card');mark('card');assert.equal(wakes.length,0,'uncommitted data must not resume fill');
  if(abort)fail(Error('rollback'));else done(true);
 });
 await write(true,true);assert.deepEqual(wakes,[]);assert.equal(sent.length,0);
 await write();assert.deepEqual(wakes,[]);assert.equal(sent.length,1);assert.equal(sent[0].payloadStoredAt,undefined);
 await write(true);assert.deepEqual(wakes,['space']);assert.equal(sent.length,2);assert.equal(sent[1].payloadStoredAt,10000);assert.deepEqual(sent[1].keys,['card']);
 now=20000;actor.send({type:'LibraryReceived',data:sent[1]});await tick();assert.deepEqual(wakes,['space','space']);assert.deepEqual(times,[10000,10000],'a delayed peer delivery is the same storage occasion');assert.equal(sent.length,2,'a peer notice is not rebroadcast');
 const before=accepted.length;
 for(const data of [{...sent[1],sessionId:'previous'},{...sent[1],lease:{...lease,generation:'previous'}},{...sent[1],payloadStoredAt:'true'}])actor.send({type:'LibraryReceived',data});
 await tick();assert.equal(accepted.length,before);assert.deepEqual(wakes,['space','space']);
});
