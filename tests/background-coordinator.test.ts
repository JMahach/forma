import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackgroundCoordinator} from '../src/platform/browser/background-coordinator.ts';
import type {BackgroundControl,BackgroundStore,CheckTarget} from '../src/domain/background-check.ts';
import {HOUR} from '../src/domain/background-policy.ts';
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const app:CheckTarget={key:'app',scope:{kind:'app'}},library:CheckTarget={key:'library:1',scope:{kind:'library',accountId:'1'},sessionId:'s'};
function fixture(unavailable=false){
 let now=10000,id=0,writes=0;const timers=new Map<number,{at:number;fn:()=>void}>();
 const clock={now:()=>now,after(ms:number,fn:()=>void){const key=++id;timers.set(key,{at:now+ms,fn});return()=>{timers.delete(key);};}};
 let state:BackgroundControl={leader:null,checks:{}};
 let queue=Promise.resolve();
 const storage:BackgroundStore={read:async()=>unavailable?null:structuredClone(state),update(change){
  const result=queue.then(()=>{if(unavailable)return null;const next=structuredClone(state),result=change(next);if(JSON.stringify(next)!==JSON.stringify(state))writes++;state=next;return result;});
  queue=result.then(()=>{});return result;
 }};
 const channels=new Set<EventTarget>();
 let holdResults=false;const messages:(()=>void)[]=[];
 const channel=()=>{const events=new EventTarget();channels.add(events);return {addEventListener(type:'message',listener:(event:MessageEvent)=>void){events.addEventListener(type,listener as EventListener);},removeEventListener(type:'message',listener:(event:MessageEvent)=>void){events.removeEventListener(type,listener as EventListener);},postMessage(data:unknown){for(const target of channels)if(target!==events){
  const deliver=()=>target.dispatchEvent(new MessageEvent('message',{data:structuredClone(data)}));
  if(holdResults && (data as {kind:string}).kind==='result')messages.push(deliver);else queueMicrotask(deliver);
 }},close(){channels.delete(events);}};};
 const counts:Record<string,number>={app:0,'library:1':0},running=new Map<string,unknown>();
 const tab=(owner:string,targets:CheckTarget[]=[app,library])=>{
  let active=true,frozen=false,notify:(returned:boolean)=>void=()=>{};const received:unknown[]=[];
  const lifecycle={get active(){return active;},subscribe(listener:(returned:boolean)=>void){notify=listener;return()=>{notify=()=>{};};}};
  const coordinator=createBackgroundCoordinator({owner,store:storage,lifecycle,channel:channel(),clock:{...clock,after(ms,fn){return clock.after(ms,()=>{if(!frozen)fn();});}},id:()=>`${owner}-${++id}`});
  coordinator.start(request=>{if(request.kind!=='check'){received.push(request);return;}counts[request.target.key]=(counts[request.target.key]??0)+1;
   if(running.has(request.target.key)){running.set(request.target.key,request);return;}
   request.finish({outcome:{kind:'success'}});
  });
  coordinator.update(targets);
  return {coordinator,received,freeze(){frozen=true;},hide(){active=false;notify(false);},show(){active=true;notify(true);},return(){notify(true);}};
 };
 async function advance(ms:number){const end=now+ms;for(let n=0;n<200;n++){
  await flush();const entry=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
  if(!entry){now=end;await flush();return;}
  timers.delete(entry[0]);now=entry[1].at;entry[1].fn();
 }throw new Error('timer loop');}
 return {tab,advance,counts,running,broadcast(value:unknown){const sender=channel();sender.postMessage(value);sender.close();},restoreStorage(){unavailable=false;},holdResults(){holdResults=true;},releaseResults(){holdResults=false;for(const deliver of messages.splice(0))queueMicrotask(deliver);},get state(){return state;},get writes(){return writes;},get timerCount(){return timers.size;}};
}
test('two tabs make one pass at startup and at the hour, with no work during 59 idle minutes',async()=>{
 const f=fixture(),a=f.tab('A'),b=f.tab('B');await f.advance(100);
 assert.deepEqual(f.counts,{app:1,'library:1':1});const writes=f.writes;
 await f.advance(59*60000);assert.deepEqual(f.counts,{app:1,'library:1':1});assert.equal(f.writes,writes);
 await f.advance(60000);assert.deepEqual(f.counts,{app:2,'library:1':2});
 a.coordinator.stop();b.coordinator.stop();await flush();assert.equal(f.timerCount,0);
});
test('a candidate takes over a frozen scheduler at its published lease deadline, without polling',async()=>{
 const f=fixture(),a=f.tab('A'),b=f.tab('B');await f.advance(100);const writes=f.writes;a.freeze();
 await f.advance(HOUR);assert.equal(f.counts.app,1);assert.equal(f.writes,writes);
 await f.advance(30000);assert.equal(f.counts.app,2);assert.equal(f.state.leader?.owner,'B');
 a.coordinator.stop();b.coordinator.stop();
});
test('the same public ID uses one request and a delayed result cannot cross a hidden participant lifetime',async()=>{
 const publicTarget:CheckTarget={key:'public:1234567890',scope:{kind:'public',chartId:'1234567890'},instance:'selection'};
 const f=fixture();f.running.set(publicTarget.key,null);const a=f.tab('A',[publicTarget]),b=f.tab('B',[publicTarget]);await f.advance(100);
 assert.equal(f.counts[publicTarget.key],1);
 f.holdResults();const request=f.running.get(publicTarget.key) as {finish(value:unknown):void};request.finish({outcome:{kind:'success'},data:{value:'old'}});await flush();
 b.hide();b.show();await f.advance(100);f.releaseResults();await flush();assert.equal(b.received.length,0);
 a.coordinator.stop();b.coordinator.stop();
});
test('accepting current public absence can remove the executor source without losing the peer result',async()=>{
 const source:CheckTarget={key:'public:1234567890',scope:{kind:'public',chartId:'1234567890'},instance:'selection'};
 const f=fixture();f.running.set(source.key,null);const a=f.tab('A',[source]),b=f.tab('B',[source]);await f.advance(100);
 const request=f.running.get(source.key) as {finish(value:unknown):void};
 a.coordinator.update([]);request.finish({outcome:{kind:'success'},data:{missing:'1234567890',revision:1}});await f.advance(100);
 assert.equal(b.received.length,1);assert.equal(f.state.checks[source.key].lastSuccessAt!==null,true);
 a.coordinator.stop();b.coordinator.stop();
});
test('return at 50 minutes replaces the hour, and all hidden tabs sleep without accumulating work',async()=>{
 const f=fixture(),a=f.tab('A'),b=f.tab('B');await f.advance(100);await f.advance(50*60000);
 b.return();await f.advance(100);assert.equal(f.counts.app,2);
 await f.advance(10*60000);assert.equal(f.counts.app,2);
 a.hide();b.hide();await f.advance(3*HOUR);assert.equal(f.counts.app,2);
 a.show();b.show();await f.advance(100);assert.equal(f.counts.app,3);
 a.coordinator.stop();b.coordinator.stop();
});
test('hidden executor loses permission even when a late transport ignores cancellation',async()=>{
 const f=fixture();f.running.set('library:1',null);const a=f.tab('A');await f.advance(100);
 const request=f.running.get('library:1') as {authority:{current():Promise<boolean>;signal:AbortSignal};finish(value:unknown):void};
 assert.equal(await request.authority.current(),true);a.hide();assert.equal(request.authority.signal.aborted,true);
 assert.equal(await request.authority.current(),false);request.finish({outcome:{kind:'success'}});await flush();
 assert.equal(f.state.checks['library:1'].lastSuccessAt,null);a.coordinator.stop();
});
test('unavailable shared coordination pauses automatic work until a real return can acquire it',async()=>{
 const f=fixture(true),a=f.tab('A'),b=f.tab('B');await f.advance(3*HOUR);
 assert.deepEqual(f.counts,{app:0,'library:1':0});assert.equal(f.timerCount,0);
 f.restoreStorage();a.return();b.return();await f.advance(100);assert.deepEqual(f.counts,{app:1,'library:1':1});
 a.coordinator.stop();b.coordinator.stop();
});
test('the scheduler delegates distinct currently open sources to their own participants',async()=>{
 const x:CheckTarget={key:'public:1234567890',scope:{kind:'public',chartId:'1234567890'},instance:'X'};
 const y:CheckTarget={key:'public:2345678901',scope:{kind:'public',chartId:'2345678901'},instance:'Y'};
 const f=fixture(),a=f.tab('A',[app,x]),b=f.tab('B',[app,y]);await f.advance(100);
 assert.equal(f.counts.app,1);assert.equal(f.counts[x.key],1);assert.equal(f.counts[y.key],1);
 b.coordinator.update([app]);await f.advance(100);await f.advance(HOUR);
 assert.equal(f.counts.app,2);assert.equal(f.counts[x.key],2);assert.equal(f.counts[y.key],1);
 a.coordinator.stop();b.coordinator.stop();
});

test('malformed peer scopes and assignments cannot add work',async()=>{
 const f=fixture(),a=f.tab('A');await f.advance(100);
 const envelope={version:1,owner:'foreign',epoch:'foreign-epoch'};
 for(const targets of [null,[null],[{key:'app'}],[{...library,key:'library:2'}],[{...app,instance:3}]]){
  f.broadcast({...envelope,kind:'presence',targets});
 }
 const current=f.state.checks.app.permit;
 for(const assignment of [null,{}, {executor:'A',epoch:'wrong',target:app,permit:current,recipients:{} }])f.broadcast({...envelope,kind:'execute',assignment});
 f.broadcast({...envelope,kind:'result',key:'app',recipients:{A:'old:selection'},data:'late'});
 await f.advance(100);assert.deepEqual(f.counts,{app:1,'library:1':1});assert.equal(a.received.length,0);
 a.coordinator.stop();
});
