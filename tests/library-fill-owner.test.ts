import test from 'node:test';
import assert from 'node:assert/strict';
import {createActor} from 'xstate';
import {createLibraryFill,type FillReceipt,type FillPlacement} from '../src/application/library-fill.ts';
import type {FillControl,FillControlStore,FillCandidate} from '../src/domain/library-fill.ts';
import type {LibraryInventory} from '../src/domain/library-maintenance.ts';
import type {LibraryCatalogEntry} from '../shared/library-catalog-contract.ts';
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(){
 let now=10000,serial=0,visible=true,foreground=false,online=true,sessionId='s',writes=0,inventoryReads=0,maxActive=0,active=0,hold=false,failing=false,placement:FillPlacement='stored';
 const timers=new Map<number,{at:number;run():void}>(),state:FillControl={flight:null,budgets:{}},lease={accountId:'1',generation:'g'};
 const entries:LibraryCatalogEntry[]=[{id:'1',revision:1,name:'one',birthDate:'2000-01-01',birthTime:'12:00',source:'calculated',packages:{card:{kind:'card',sourceKey:'one'},day:{ready:true,ref:{kind:'day',sourceKey:'day'}},majorReturns:null}}];
 const inventory:LibraryInventory={lease,cards:[],packages:[],usage:[]},received:FillCandidate[]=[],placed:FillCandidate[]=[],signals:AbortSignal[]=[];
 let release:((value:FillReceipt)=>void)|null=null,offlineOnReceive=false,errorValue:unknown=Error('unavailable'),controlUnavailable=false,notReady=false,leaveDuringPlace=false,leaveAfterReceive=false,leaveAfterGrant=false,holdPlacement=false;let releasePlacement:((value:FillPlacement)=>void)|null=null,notices=0;
 const control:FillControlStore={async read(){return structuredClone(state);},async update(_lease,change){if(controlUnavailable)return null;const before=JSON.stringify(state),result=change(state);if(before!==JSON.stringify(state))writes++;if(leaveAfterGrant && (result as {kind?:string})?.kind==='acquired')online=false;return structuredClone(result);}};
 const ports={scope:()=>({lease,sessionId,visible,foreground,online}),entries:()=>entries,control,inventory:async()=>{inventoryReads++;return inventory;},present:async(candidate:FillCandidate)=>candidate.ref.kind==='card'?inventory.cards.some(row=>row.id===candidate.chartId && row.revision>=candidate.revision):inventory.packages.some(row=>row.id===candidate.key && row.present && !row.evicted),
  async receive(candidate:FillCandidate,signal:AbortSignal):Promise<FillReceipt>{received.push(candidate);signals.push(signal);active++;maxActive=Math.max(maxActive,active);
   try{if(hold)return await new Promise<FillReceipt>(resolve=>{release=resolve;});if(failing)throw errorValue;if(offlineOnReceive)online=false;if(leaveAfterReceive)visible=false;if(notReady)return {kind:'not-ready',retryAfterMs:2000};return {kind:'ready',payload:{key:candidate.key}};}finally{active--;}
  },
  async place(candidate:FillCandidate,_payload:unknown,authority:{signal:AbortSignal}){assert.equal(authority.signal.aborted,false);placed.push(candidate);if(placement==='stored'){
   if(candidate.ref.kind==='card')inventory.cards.push({id:candidate.chartId,revision:candidate.revision});
   else inventory.packages.push({id:candidate.key,ref:candidate.ref,chartIds:[candidate.chartId],present:true,evicted:false});
  }if(leaveDuringPlace)visible=false;if(holdPlacement)return new Promise<FillPlacement>(resolve=>{releasePlacement=resolve;});return placement;},accepted(){notices++;},
  clock:{now:()=>now,after(ms:number,run:()=>void){const id=++serial;timers.set(id,{at:now+ms,run});return()=>{timers.delete(id);};}},id:()=>`id-${++serial}`};
 const make=()=>createActor(createLibraryFill(ports)).start(),actor=make();
 async function advance(ms:number){const end=now+ms;for(let i=0;i<100;i++){await flush();const first=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!first){now=end;await flush();return;}timers.delete(first[0]);now=first[1].at;first[1].run();}throw Error('unbounded fill');}
 return {actor,entries,peer:make,received,placed,signals,state,inventory,advance,wake(reason:'lifecycle'|'hourly'|'library'|'use'|'space'='lifecycle'){actor.send({type:'FillWake',at:now,reason});},
  change(value:{visible?:boolean;foreground?:boolean;online?:boolean;sessionId?:string}){visible=value.visible??visible;foreground=value.foreground??foreground;online=value.online??online;sessionId=value.sessionId??sessionId;actor.send({type:'FillChanged'});},
  hold(){hold=true;},unhold(){hold=false;},release(value:FillReceipt){hold=false;release?.(value);},fail(error:unknown=Error('unavailable')){failing=true;errorValue=error;},recover(){failing=false;},failControl(){controlUnavailable=true;},holdPlacement(){holdPlacement=true;},releasePlacement(){holdPlacement=false;releasePlacement?.('stored');},leaveAfterReceive(){leaveAfterReceive=true;},leaveAfterGrant(){leaveAfterGrant=true;},leaveDuringPlace(){leaveDuringPlace=true;},notReady(){notReady=true;},placement(value:FillPlacement){placement=value;},quota(){placement='quota';},space(){placement='stored';},offlineAfterReceive(){offlineOnReceive=true;},
  get inventoryReads(){return inventoryReads;},get notices(){return notices;},get writes(){return writes;},get maxActive(){return maxActive;},get timers(){return timers.size;},get now(){return now;}};
}
test('fill starts only on a shared external occasion, downloads one at a time, and visits cards before days',async()=>{
 const f=fixture();await f.advance(1000);assert.equal(f.received.length,0);f.wake();await f.advance(0);
 assert.deepEqual(f.placed.map(row=>row.ref.kind),['card','day']);assert.equal(f.maxActive,1);assert.equal(f.timers,0);
 f.wake('hourly');await f.advance(0);assert.equal(f.received.length,2);f.actor.stop();
});
test('a downloaded packet may be placed after the network disappears, then later downloads stop',async()=>{
 const f=fixture();f.offlineAfterReceive();f.wake();await f.advance(0);assert.equal(f.received.length,1);assert.equal(f.placed.length,1);assert.equal(f.timers,0);f.actor.stop();
});
test('foreground or hidden cancellation rejects a late packet and does not grant a second tab a parallel download',async()=>{
 const f=fixture(),peer=f.peer();f.hold();f.wake();await f.advance(0);peer.send({type:'FillWake',at:f.now,reason:'hourly'});await f.advance(0);assert.equal(f.received.length,1);
 f.change({foreground:true});assert.equal(f.signals[0].aborted,true);f.release({kind:'ready',payload:{}});await f.advance(0);assert.equal(f.placed.length,0);assert.equal(f.timers,0);
 f.change({foreground:false,visible:false});f.wake();await f.advance(100000);assert.equal(f.received.length,1);f.actor.stop();peer.stop();
});
test('failures stop after three attempts and handoff cannot reset the durable budget',async()=>{
 const f=fixture();f.fail();f.wake();await f.advance(120000);assert.equal(f.received.length,3);assert.equal(f.timers,0);
 const peer=f.peer();peer.send({type:'FillWake',at:10000,reason:'hourly'});await f.advance(1000);assert.equal(f.received.length,3);
 peer.send({type:'FillWake',at:f.now,reason:'hourly'});await f.advance(10000);assert.equal(f.received.length,6);f.actor.stop();peer.stop();
});
test('quota suspends fill across ordinary wakes; real space relief allows a bounded new attempt',async()=>{
 const f=fixture();f.quota();f.wake();await f.advance(0);assert.equal(f.received.length,1);assert.ok(f.state.quota);
 await f.advance(3600000);f.wake('hourly');await f.advance(0);assert.equal(f.received.length,1);
 f.space();f.wake('space');await f.advance(0);assert.equal(f.placed.length,3);assert.equal(f.state.quota,undefined);f.actor.stop();
});

test('401 blocks the account across ordinary wakes and only a confirmed new session may resume',async()=>{
 const f=fixture();f.fail({status:401});f.wake();await f.advance(3600000);assert.equal(f.received.length,1);assert.equal(f.timers,0);
 f.wake('hourly');await f.advance(0);assert.equal(f.received.length,1);f.recover();f.change({sessionId:'new'});f.wake();await f.advance(0);
 assert.equal(f.placed.length,2);f.actor.stop();
});
test('no durable grant means no network, and service notices cannot restart exhausted work',async()=>{
 const missing=fixture();missing.failControl();missing.wake();await missing.advance(100000);assert.equal(missing.received.length,0);assert.equal(missing.timers,0);missing.actor.stop();
 const f=fixture();f.fail();f.wake();await f.advance(120000);f.actor.send({type:'FillChanged'});await f.advance(120000);assert.equal(f.received.length,3);assert.equal(f.timers,0);f.actor.stop();
});
test('an unresponsive transport reaches one finite deadline, leaving shared pause and no background loop',async()=>{
 const f=fixture();f.hold();f.wake();await f.advance(120000);assert.equal(f.received.length,1);assert.equal(f.signals[0].aborted,true);assert.equal(f.timers,0);assert.equal(f.placed.length,0);
 f.release({kind:'ready',payload:{}});await f.advance(0);assert.equal(f.placed.length,0);f.wake();await f.advance(0);assert.equal(f.placed.length,2);f.actor.stop();
});
test('a not-ready or intentionally evicted higher tier prevents lower-tier requests',async()=>{
 const f=fixture();f.entries[0].packages.day!.ready=false;f.entries[0].packages.majorReturns={sourceKey:'returns',readyFamilies:['saturn']};f.wake();await f.advance(0);
 assert.deepEqual(f.received.map(row=>row.ref.kind),['card']);f.actor.stop();
 const other=fixture();other.inventory.usage.push({id:'1',openedAt:10,evicted:true});other.wake();await other.advance(0);assert.equal(other.received.length,0);other.actor.stop();
});

test('not-ready replies have a finite server-respecting retry budget and never reach placement',async()=>{
 const f=fixture();f.notReady();f.wake();await f.advance(1999);assert.equal(f.received.length,1);await f.advance(1);assert.equal(f.received.length,2);
 await f.advance(120000);assert.equal(f.received.length,3);assert.equal(f.placed.length,0);assert.equal(f.timers,0);f.actor.stop();
});
test('local placement failure does not repeatedly download the same packet; stale placement does not publish success',async()=>{
 for(const result of ['unavailable','stale','invalid'] as const){
  const f=fixture();f.placement(result);f.wake();await f.advance(120000);assert.equal(f.received.length,1);assert.equal(f.placed.length,1);assert.equal(f.timers,0);f.actor.stop();
 }
});

test('a scope lost at the placement boundary cannot publish a late readiness notification',async()=>{
 const f=fixture();f.leaveDuringPlace();f.wake();await f.advance(0);assert.equal(f.placed.length,1);assert.equal(f.notices,0);assert.equal(f.timers,0);f.actor.stop();
});

test('online lifecycle notices keep a live download; going offline cancels download but preserves lawful local placement',async()=>{
 const downloading=fixture();downloading.hold();downloading.wake();await downloading.advance(0);
 downloading.change({online:true});assert.equal(downloading.signals[0].aborted,false);
 downloading.change({online:false});assert.equal(downloading.signals[0].aborted,true);downloading.release({kind:'ready',payload:{}});await downloading.advance(0);assert.equal(downloading.placed.length,0);downloading.actor.stop();
 const placing=fixture();placing.holdPlacement();placing.wake();await placing.advance(0);assert.equal(placing.placed.length,1);
 placing.change({online:false});assert.equal(placing.signals[0].aborted,false);placing.releasePlacement();await placing.advance(0);
 assert.equal(placing.notices,1);assert.equal(placing.received.length,1);assert.equal(placing.timers,0);placing.actor.stop();
});
test('scope is checked again after grant and after receipt even before a lifecycle notice arrives',async()=>{
 const afterGrant=fixture();afterGrant.leaveAfterGrant();afterGrant.wake();await afterGrant.advance(0);assert.equal(afterGrant.received.length,0);afterGrant.actor.stop();
 const afterReceive=fixture();afterReceive.leaveAfterReceive();afterReceive.wake();await afterReceive.advance(0);assert.equal(afterReceive.received.length,1);assert.equal(afterReceive.placed.length,0);afterReceive.actor.stop();
});

test('a foreground departure cancels the finite retry continuation and repeated in-flight wakes do not duplicate successful downloads',async()=>{
 const f=fixture();f.fail();f.wake();await f.advance(0);assert.equal(f.received.length,1);f.change({foreground:true});assert.equal(f.timers,0);
 await f.advance(120000);assert.equal(f.received.length,1);f.actor.stop();
 const other=fixture();other.hold();other.wake();await other.advance(0);other.wake('hourly');other.wake('library');
 other.release({kind:'ready',payload:{}});await other.advance(0);assert.equal(other.received.length,2);assert.equal(other.notices,2);assert.equal(other.timers,0);other.actor.stop();
});

for(const pause of ['foreground','hidden','offline'] as const)test(`fill resumes an interrupted ${pause} pass without a new occasion or retry budget`,async()=>{
 const f=fixture();f.fail();f.wake();await f.advance(0);
 const key=f.received[0].key;assert.equal(f.state.budgets[key].attempts,1);
 f.change(pause==='foreground'?{foreground:true}:pause==='hidden'?{visible:false}:{online:false});
 await f.advance(120000);assert.equal(f.received.length,1);
 f.change({foreground:false,visible:true,online:true});await f.advance(10000);
 assert.equal(f.received.length,3);assert.equal(f.state.budgets[key].occasion,10000);assert.equal(f.state.budgets[key].attempts,3);
 f.change({foreground:true});await f.advance(120000);f.change({foreground:false});await f.advance(120000);
 assert.equal(f.received.length,3);assert.equal(f.timers,0);f.actor.stop();
});
test('late cancelled HTTP cannot place data or start a second continuation after a quick foreground pause',async()=>{
 const f=fixture();f.hold();f.wake();await f.advance(0);
 f.change({foreground:true});f.unhold();f.change({foreground:false});await f.advance(10000);
 assert.deepEqual(f.placed.map(row=>row.ref.kind),['card','day']);assert.equal(f.received.length,3);assert.equal(f.notices,2);
 const writes=f.writes;f.release({kind:'ready',payload:{late:true}});await f.advance(120000);
 assert.equal(f.received.length,3);assert.equal(f.placed.length,2);assert.equal(f.writes,writes);assert.equal(f.timers,0);f.actor.stop();
});
test('an interrupted fill cannot resume into a replacement session or lease',async()=>{
 for(const replacement of ['session','lease'] as const){
  const f=fixture();f.fail();f.wake();await f.advance(0);f.change({foreground:true});await f.advance(0);
  if(replacement==='lease')f.inventory.lease.generation='new';
  f.change({foreground:false,...(replacement==='session'?{sessionId:'new'}:{})});await f.advance(120000);
  assert.equal(f.received.length,1);assert.equal(f.timers,0);f.actor.stop();
 }
});
test('quota, completed work, and disposal never gain a continuation from scope notices',async()=>{
 const quota=fixture();quota.quota();quota.wake();await quota.advance(0);quota.space();
 quota.change({foreground:true});await quota.advance(120000);quota.change({foreground:false});await quota.advance(120000);
 assert.equal(quota.received.length,1);assert.ok(quota.state.quota);quota.actor.stop();
 const complete=fixture();complete.wake();await complete.advance(0);const writes=complete.writes;
 complete.change({foreground:true});complete.change({foreground:false});await complete.advance(120000);
 assert.equal(complete.received.length,2);assert.equal(complete.writes,writes);complete.actor.stop();
 const stopped=fixture();stopped.fail();stopped.wake();await stopped.advance(0);stopped.change({foreground:true});stopped.actor.stop();
 stopped.change({foreground:false});await stopped.advance(120000);assert.equal(stopped.received.length,1);assert.equal(stopped.timers,0);
});

test('invalid occasions and an offline scope do not even read fill inventory',async()=>{
 const f=fixture();f.actor.send({type:'FillWake',at:NaN,reason:'hourly'});await f.advance(0);
 assert.equal(f.inventoryReads,0);f.change({online:false});f.wake();await f.advance(0);
 assert.equal(f.inventoryReads,0);assert.equal(f.received.length,0);f.actor.stop();
});
