import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { attachOfflinePage } from '../src/offline/page-coordinator.ts';

const old='a'.repeat(64),next='b'.repeat(64);
const settle=()=>new Promise(resolve=>setTimeout(resolve,15));
function fixture(options:{prepare?:()=>boolean|Promise<boolean>;restored?:()=>boolean;controlled?:boolean;activeVersion?:string;waitingVersion?:string}={}) {
 const container=new EventTarget() as EventTarget & {controller:any},events=new EventTarget(),visibility=Object.assign(new EventTarget(),{hidden:false});
 const calls:any[]=[],registration=Object.assign(new EventTarget(),{active:null as any,waiting:null as any,installing:null as any});
 let held=0,reloads=0,ready=true,accepted=true;let activationWait:Promise<void>|null=null;const ownerListeners=new Set<()=>void>();
 const worker=(version:string)=>Object.assign(new EventTarget(),{state:'activated',postMessage(data:any,ports:MessagePort[]){
  calls.push({worker:version,...data});const result={type:'forma-offline',action:data.action,version,ready,accepted:data.action==='activate-approved-version'?accepted:true,previousVersions:[old]};
  if(data.action==='activate-approved-version'&&activationWait)void activationWait.then(()=>ports[0].postMessage(result));else ports[0].postMessage(result);
 }});
 registration.active=worker(options.activeVersion??old);
 container.controller=options.controlled===false?null:registration.active;
 if(options.waitingVersion)registration.waiting=Object.assign(worker(options.waitingVersion),{state:'installed'});
 const page=attachOfflinePage({registration:registration as unknown as ServiceWorkerRegistration,
  serviceWorker:container as unknown as ServiceWorkerContainer,events,visibility,loadedVersion:old,timeoutMs:50,
  owner:{prepare:options.prepare??(()=>true),restored:options.restored??(()=>true),subscribe(listener:()=>void){ownerListeners.add(listener);return()=>{ownerListeners.delete(listener);};}},
  hold:()=>{held++;let done=false;return()=>{if(!done){done=true;held--;}};},reload:()=>{reloads++;}});
 async function ask(action:string,requestId='attempt-1',version=next,source=registration.waiting){
  const channel=new MessageChannel();const result=new Promise<any>(resolve=>{channel.port1.onmessage=event=>resolve(event.data);});
  container.dispatchEvent(Object.assign(new Event('message'),{data:{type:'forma-offline-tab',action,requestId,version},source,ports:[channel.port2]}));
  if(action==='cancel-tab-update'){channel.port1.close();channel.port2.close();return;}
  const reply=await result;channel.port1.close();channel.port2.close();return reply;
 }
 const cancel=(requestId='attempt-1')=>container.dispatchEvent(Object.assign(new Event('message'),{data:{type:'forma-offline-tab',action:'cancel-tab-update',requestId,version:next},source:registration.waiting,ports:[]}));
 return {page,calls,container,registration,worker,events,visibility,ask,cancel,setActivationWait:(v:Promise<void>|null)=>{activationWait=v;},setAccepted:(v:boolean)=>{accepted=v;},notifyOwner(){for(const listener of ownerListeners)listener();},setReady:(v:boolean)=>{ready=v;},get held(){return held;},get reloads(){return reloads;}};
}
test('unwritten snapshot never approves a transition or keeps input held',async t=>{
 const f=fixture({prepare:()=>false});t.after(()=>f.page.dispose());f.registration.waiting=f.worker(next);
 const reply=await f.ask('prepare-tab');assert.equal(reply.ready,false);assert.equal(f.held,0);assert.equal(f.reloads,0);
});
test('a cancelled asynchronous preparation cannot later approve or re-lock the page',async t=>{
 let finish!:(value:boolean)=>void;const f=fixture({prepare:()=>new Promise(resolve=>{finish=resolve;})});
 t.after(()=>f.page.dispose());f.registration.waiting=f.worker(next);
 const reply=f.ask('prepare-tab');await settle();assert.equal(f.held,1);f.cancel();assert.equal(f.held,0);
 finish(true);assert.equal((await reply).ready,false);assert.equal(f.held,0);
});
test('wrong cancellation does not release another prepared attempt',async t=>{
 const f=fixture();t.after(()=>f.page.dispose());f.registration.waiting=f.worker(next);
 assert.equal((await f.ask('prepare-tab')).ready,true);assert.equal(f.held,1);
 f.cancel('wrong');assert.equal(f.held,1);f.cancel();assert.equal(f.held,0);
});
test('knowing the active worker version never proves that the page restored new code',async t=>{
 const f=fixture();t.after(()=>f.page.dispose());f.registration.active=f.worker(next);
 const reply=await f.ask('verify-restored-tab','proof',next,f.registration.active);
 assert.equal(reply.ready,false);assert.equal(reply.loadedVersion,old);
});
test('matching page code still waits for completed restoration before retiring files',async t=>{
 const f=fixture({restored:()=>false});t.after(()=>f.page.dispose());
 const reply=await f.ask('verify-restored-tab','proof',old,f.registration.active);
 assert.equal(reply.ready,false);await f.page.check();assert.equal(f.calls.some(c=>c.action==='retire-approved-version'),false);
});
test('new controller reloads only after durable snapshot, exactly once',async t=>{
 const f=fixture();t.after(()=>f.page.dispose());f.container.controller=f.registration.active=f.worker(next);
 await f.page.check();await f.page.check();assert.equal(f.reloads,1);
});
test('storage refusal leaves the old loaded page usable under a newer controller',async t=>{
 const f=fixture({prepare:()=>false});t.after(()=>f.page.dispose());f.container.controller=f.registration.active=f.worker(next);
 await f.page.check();assert.equal(f.reloads,0);assert.equal(f.held,0);
});
test('a waiting bundle is asked to activate only after it is complete and the page restored',async t=>{
 const f=fixture();t.after(()=>f.page.dispose());f.registration.waiting=f.worker(next);f.setReady(false);
 await f.page.check();assert.equal(f.calls.some(c=>c.action==='activate-approved-version'),false);
 f.setReady(true);await f.page.check();assert.equal(f.calls.some(c=>c.action==='activate-approved-version'),true);
});

test('reload keeps the input fence until pagehide, rather than releasing before navigation commits',async t=>{
 const f=fixture();t.after(()=>f.page.dispose());f.container.controller=f.registration.active=f.worker(next);
 await f.page.check();assert.equal(f.reloads,1);assert.equal(f.held,1);
 f.events.dispatchEvent(new Event('pagehide'));assert.equal(f.held,0);
});
test('finishing an operation retries a waiting update without requiring tab switching',async t=>{
 const f=fixture();t.after(()=>f.page.dispose());f.registration.waiting=f.worker(next);f.setAccepted(false);
 await f.page.check();assert.equal(f.calls.filter(c=>c.action==='activate-approved-version').length,1);
 f.setAccepted(true);f.notifyOwner();await settle();assert.equal(f.calls.filter(c=>c.action==='activate-approved-version').length,2);
});

test('operation completion during the worker reply is not lost and does not retry without a change',async t=>{
 let finish!:()=>void;const f=fixture();t.after(()=>f.page.dispose());
 f.registration.waiting=f.worker(next);f.setAccepted(false);f.setActivationWait(new Promise<void>(resolve=>{finish=resolve;}));
 const checking=f.page.check();await settle();assert.equal(f.calls.filter(c=>c.action==='activate-approved-version').length,1);
 f.setActivationWait(null);f.setAccepted(true);f.notifyOwner();finish();await checking;await settle();
 assert.equal(f.calls.filter(c=>c.action==='activate-approved-version').length,2);
 await settle();assert.equal(f.calls.filter(c=>c.action==='activate-approved-version').length,2);
});
test('cancelled navigation releases the input fence and permits another explicit check',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();t.after(()=>f.page.dispose());
 f.container.controller=f.registration.active=f.worker(next);await f.page.check();assert.equal(f.held,1);
 t.mock.timers.tick(10001);assert.equal(f.held,0);
 await f.page.check();assert.equal(f.reloads,2);
});

test('waking a tab checks the server for a new worker, rather than only asking the cached one',async t=>{
 const f=fixture();t.after(()=>f.page.dispose());let updates=0;
 Object.assign(f.registration,{async update(){updates++;f.registration.waiting=f.worker(next);}});
 f.visibility.dispatchEvent(new Event('visibilitychange'));await settle();assert.equal(updates,0);
 await f.page.refresh();await settle();
 assert.equal(updates,1);assert.ok(f.calls.some(c=>c.action==='activate-approved-version'&&c.worker===next));
});


test('an already waiting worker reloads an uncontrolled page on activation without a controllerchange or manual check',async t=>{
 const f=fixture({controlled:false,waitingVersion:next});t.after(()=>f.page.dispose());
 const waiting=f.registration.waiting;
 assert.equal(f.registration.installing,null);assert.equal(f.container.controller,null);
 await f.page.check();assert.equal(f.reloads,0);
 assert.equal(f.calls.filter(c=>c.action==='activate-approved-version').length,1);
 f.registration.waiting=null;f.registration.active=waiting;waiting.state='activated';
 waiting.dispatchEvent(new Event('statechange'));await settle();
 assert.equal(f.reloads,1);assert.equal(f.held,1);
 waiting.dispatchEvent(new Event('statechange'));
 f.container.controller=waiting;f.container.dispatchEvent(new Event('controllerchange'));await settle();
 assert.equal(f.reloads,1,'worker state and controller events must not reload twice');
});

test('an active worker finishing activation wakes an uncontrolled page without an installing worker',async t=>{
 const f=fixture({controlled:false,activeVersion:next});t.after(()=>f.page.dispose());
 const active=f.registration.active;active.state='activating';f.setReady(false);
 await f.page.check();assert.equal(f.reloads,0);
 f.setReady(true);active.state='activated';active.dispatchEvent(new Event('statechange'));await settle();
 assert.equal(f.reloads,1);
});

test('activation while its approval reply is pending is observed after the check finishes',async t=>{
 const f=fixture({controlled:false,waitingVersion:next});t.after(()=>f.page.dispose());
 let finish!:()=>void;f.setActivationWait(new Promise<void>(resolve=>{finish=resolve;}));
 const waiting=f.registration.waiting,checking=f.page.check();await settle();
 assert.equal(f.calls.filter(c=>c.action==='activate-approved-version').length,1);
 f.registration.waiting=null;f.registration.active=waiting;waiting.state='activated';
 waiting.dispatchEvent(new Event('statechange'));finish();await checking;await settle();
 assert.equal(f.reloads,1);
});

test('worker activation still requires a durable snapshot before an uncontrolled page reloads',async t=>{
 let writable=false;const f=fixture({controlled:false,waitingVersion:next,prepare:()=>writable});t.after(()=>f.page.dispose());
 const waiting=f.registration.waiting;await f.page.check();
 f.registration.waiting=null;f.registration.active=waiting;waiting.state='activated';
 waiting.dispatchEvent(new Event('statechange'));await settle();
 assert.equal(f.reloads,0);assert.equal(f.held,0);
 writable=true;f.notifyOwner();await settle();assert.equal(f.reloads,1);
 assert.equal(f.calls.filter(c=>c.action==='activate-approved-version').length,1);
});

test('dispose removes observation of existing and newly discovered workers',async t=>{
 const f=fixture({waitingVersion:next});t.after(()=>f.page.dispose());
 const active=f.registration.active,waiting=f.registration.waiting,installing=f.worker('c'.repeat(64));
 f.registration.installing=installing;f.registration.dispatchEvent(new Event('updatefound'));
 for(const worker of [active,waiting,installing])assert.equal(getEventListeners(worker,'statechange').length,1);
 f.page.dispose();
 for(const worker of [active,waiting,installing]){
  assert.equal(getEventListeners(worker,'statechange').length,0);
  worker.dispatchEvent(new Event('statechange'));
 }
 f.registration.dispatchEvent(new Event('updatefound'));f.container.dispatchEvent(new Event('controllerchange'));
 await f.page.check();await settle();assert.equal(f.calls.length,0);assert.equal(f.reloads,0);assert.equal(f.held,0);
 for(const worker of [active,waiting,installing])assert.equal(getEventListeners(worker,'statechange').length,0);
});

test('replaced workers detach their state listeners while current workers and a prepared handshake remain observed', async t => {
 const f=fixture();t.after(()=>f.page.dispose());const workers:any[]=[];
 for(let i=0;i<30;i++){
  const worker=f.worker(next);workers.push(worker);f.registration.installing=worker;
  f.registration.dispatchEvent(new Event('updatefound'));
 }
 assert.equal(workers.slice(0,-1).filter(worker=>getEventListeners(worker,'statechange').length).length,0);
 assert.equal(getEventListeners(workers.at(-1),'statechange').length,1);
 const preparing=f.worker(next);f.registration.waiting=preparing;f.registration.dispatchEvent(new Event('updatefound'));
 assert.equal((await f.ask('prepare-tab','kept',next,preparing)).ready,true);
 f.registration.waiting=f.worker(next);f.registration.dispatchEvent(new Event('updatefound'));
 assert.equal(getEventListeners(preparing,'statechange').length,1,'an active preparation still owns its worker');
 f.events.dispatchEvent(new Event('pagehide'));
 assert.equal(getEventListeners(preparing,'statechange').length,0);
 f.page.dispose();assert.equal(getEventListeners(workers.at(-1),'statechange').length,0);
});

test('a replaced worker stays observed only until its active status exchange finishes',async t=>{
 const f=fixture();t.after(()=>f.page.dispose());let reply!:MessagePort;
 const pending=Object.assign(f.worker(old),{postMessage(_data:unknown,ports:MessagePort[]){reply=ports[0];}});
 f.registration.active=f.container.controller=pending;const checking=f.page.check();
 f.registration.active=f.container.controller=f.worker(old);f.registration.dispatchEvent(new Event('updatefound'));
 assert.equal(getEventListeners(pending,'statechange').length,1);
 reply.postMessage({type:'forma-offline',action:'status',ready:false});await checking;
 assert.equal(getEventListeners(pending,'statechange').length,0);
});

test('disposing before a queued native update starts prevents the network call',async()=>{
 const f=fixture();let updates=0;
 Object.assign(f.registration,{update:async()=>{updates++;}});
 const pending=f.page.refresh();f.page.dispose();await pending;assert.equal(updates,0);
});
