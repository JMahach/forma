import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application/application.ts';
import type {BackgroundRequest} from '../src/application/background-work.ts';
import {createBackgroundCoordinator} from '../src/platform/browser/background-coordinator.ts';
import {createAccountLibraryStore} from '../src/data/account-library-store.ts';
import {IDBFactory} from 'fake-indexeddb';
import {accountChart} from './helpers/account-chart.ts';
import {libraryRecordEntry} from '../src/state/library-reconciliation.ts';
import type {FillReceipt} from '../src/application/library-fill.ts';
import type {LibraryAuditPage} from '../src/domain/library-maintenance.ts';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('application children pause fill and local audit and discard their late results after stop',async t=>{
 const store=createAccountLibraryStore({indexedDB:new IDBFactory()});t.after(()=>store.close());
 const active=await store.activate('1');if(active.status!=='stored')throw Error('owner');
 const scope={lease:active.lease,sessionId:'session',catalogMarker:'1',visible:true,foreground:false,online:true},chart=accountChart();
 let fillSignal:AbortSignal|undefined,auditSignal:AbortSignal|undefined,receives=0,pages=0;
 let finishFill!:(reply:FillReceipt)=>void,finishAudit!:(page:LibraryAuditPage)=>void;
 const app=createApplication({runtimeId:'A',route:()=>assert.fail('no route'),libraryFill:{
  scope:()=>scope,entries:()=>[libraryRecordEntry(chart)],control:store.fill,inventory:store.maintenance.inventory,
  present:async()=>false,receive:async(_candidate,signal)=>{receives++;fillSignal=signal;return new Promise<FillReceipt>(resolve=>{finishFill=resolve;});},
  place:async()=>assert.fail('a retired child cannot place its late packet'),
 },libraryAudit:{scope:()=>scope,store:{...store.maintenance,
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
 const target={key:'app',scope:{kind:'app' as const}},controller=new AbortController();
 const authority={permit:{key:'app',token:'t',owner:'A',startedAt:1,expiresAt:30001},signal:controller.signal,current:async()=>!controller.signal.aborted};
 const application=createApplication({runtimeId:'A',route:()=>assert.fail('no route'),background:{
  coordinator:{start(listener){receive=listener;},update(){updates++;},stop(){controller.abort();stops++;}},
  tasks:()=>[{target,async run(){calls++;return {outcome:{kind:'success'}};}}],
 }});
 application.start();receive({kind:'check',target,authority,finish(result){answer=result;}});await tick();
 assert.equal(calls,1);assert.deepEqual(answer,{outcome:{kind:'success'}});
 application.send({type:'BackgroundChanged'});assert.equal(updates,2);
 await application.stop();await application.stop();assert.equal(stops,1);
 receive({kind:'check',target,authority,finish(){}});await tick();assert.equal(calls,1);
});
test('unavailable coordination admits one initial library read per confirmed session and no retry on resume',async()=>{
 let receive:(request:BackgroundRequest)=>void=()=>{},sessionId='first',reads=0;
 const signal=new AbortController().signal;
 const application=createApplication({runtimeId:'A',route:()=>assert.fail('no route'),background:{
  coordinator:{start(listener){receive=listener;},update(){receive({kind:'unavailable',signal});},stop(){}},
  tasks:()=>[{target:{key:'library:1',scope:{kind:'library',accountId:'1'},sessionId},run:async()=>assert.fail('no shared permission'),
   initial:async()=>{reads++;throw new Error('unavailable');}}],
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
 const application=createApplication({runtimeId:'A',route:()=>assert.fail('no route'),background:{coordinator,
  tasks:()=>[{target:{key:'app',scope:{kind:'app'}},initial:async()=>{installs++;},run:async()=>assert.fail('no shared update')}],
 }});
 application.start();await tick();assert.equal(installs,0);
 active=true;notify();await tick();assert.equal(installs,1);
 active=false;notify();active=true;notify();await tick();assert.equal(installs,1);
 await application.stop();notify();await tick();assert.equal(installs,1);
});

test('a pending first install excludes a simultaneous shared release check',async()=>{
 let receive:(request:BackgroundRequest)=>void=()=>{},finishInstall!:()=>void,updates=0;
 const target={key:'app',scope:{kind:'app' as const}},signal=new AbortController().signal;
 const authority={permit:{key:'app',token:'t',owner:'A',startedAt:1,expiresAt:30001},signal,current:async()=>true};
 const application=createApplication({runtimeId:'A',route:()=>assert.fail('no route'),background:{
  coordinator:{start(listener){receive=listener;},update(){receive({kind:'foreground',signal});},stop(){}},
  tasks:()=>[{target,initial:()=>new Promise<void>(resolve=>{finishInstall=resolve;}),
   run:async()=>{updates++;return {outcome:{kind:'success'}};}}],
 }});
 application.start();let answer:unknown;
 receive({kind:'check',target,authority,finish(result){answer=result;}});await tick();
 assert.equal(updates,0);assert.deepEqual(answer,{outcome:{kind:'cancelled'}});
 finishInstall();await tick();
 receive({kind:'check',target,authority,finish(result){answer=result;}});await tick();
 assert.equal(updates,1);assert.deepEqual(answer,{outcome:{kind:'success'}});await application.stop();
});
