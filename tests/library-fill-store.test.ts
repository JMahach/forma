import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {createAccountLibraryStore} from '../src/data/account-library-store.ts';
import {reserveFill,finishFill,fillPackageKey,type FillCandidate} from '../src/domain/library-fill.ts';
import {accountNatalChart} from './helpers/account-chart.ts';
import {natalDayFixture} from './fixtures/natal-day.ts';
import {encodeNatalDay} from '../server/packets/encode.ts';
import {natalDaySourceKey} from '../shared/library-package-contract.ts';
async function fixture(t:TestContext){
 const factory=new IDBFactory();let now=10000;const store=createAccountLibraryStore({indexedDB:factory,now:()=>now});t.after(()=>store.close());
 const active=await store.activate('1');if(active.status!=='stored')throw Error('owner');const lease=active.lease;
 const card=accountNatalChart(),ref={kind:'day' as const,sourceKey:natalDaySourceKey({date:card.birthDate,timezone:card.timezone!})};
 await store.put(lease,[card]);const bytes=()=>encodeNatalDay(natalDayFixture({date:card.birthDate,samples:10})).slice().buffer;
 const grant=async(candidate:FillCandidate,token='one')=>{const result=await store.fill.update(lease,state=>reserveFill(state,{candidate,lease,owner:'a',token,sessionId:'s',now,occasion:now}));if(result?.kind!=='acquired')throw Error('grant');return result.permit;};
 return {factory,store,lease,card,ref,bytes,grant,advance(ms:number){now+=ms;},candidate:{key:fillPackageKey(ref),chartId:card.id,revision:card.revision,ref}};
}
test('fill uses one account control row, no-op admission writes nothing and budgets survive a new store instance',async t=>{
 const f=await fixture(t),permit=await f.grant(f.candidate);await f.store.fill.update(f.lease,state=>finishFill(state,permit,{kind:'failed'},10000));
 const peer=createAccountLibraryStore({indexedDB:f.factory,now:()=>10000});t.after(()=>peer.close());
 const control=await peer.fill.read(f.lease);assert.equal(control?.budgets[f.candidate.key].attempts,1);
 const original=IDBObjectStore.prototype.put;let writes=0;IDBObjectStore.prototype.put=function(...args){writes++;return original.apply(this,args);};
 try{const result=await peer.fill.update(f.lease,state=>reserveFill(state,{candidate:f.candidate,lease:f.lease,owner:'b',token:'two',sessionId:'s',now:10001,occasion:10001}));assert.deepEqual(result,{kind:'wait',at:11000});assert.equal(writes,0);}finally{IDBObjectStore.prototype.put=original;}
});
test('saved bytes require the current fill token and an unexpired signal inside their own transaction',async t=>{
 const f=await fixture(t),permit=await f.grant(f.candidate),control=new AbortController();
 await f.store.fill.update(f.lease,state=>{state.flight={...permit,token:'successor'};return true;});
 assert.equal(await f.store.putPackage(f.lease,f.card,f.ref,f.bytes(),{authority:{permit,signal:control.signal}}),'stale');
 assert.equal(await f.store.readPackage(f.lease,f.ref),null);
 const successor={...permit,token:'successor'};control.abort();assert.equal(await f.store.putPackage(f.lease,f.card,f.ref,f.bytes(),{authority:{permit:successor,signal:control.signal}}),'stale');
 f.advance(30000);assert.equal(await f.store.putPackage(f.lease,f.card,f.ref,f.bytes(),{authority:{permit:successor,signal:new AbortController().signal}}),'stale');
});
test('filled cards use existing admission, reject stale rights and stop at quota without evicting an older card',async t=>{
 const f=await fixture(t),incoming=accountNatalChart(3),candidate={key:'card3',chartId:incoming.id,revision:1,ref:{kind:'card' as const,sourceKey:'three'}},permit=await f.grant(candidate);
 const authority={permit,signal:new AbortController().signal};
 const wrong={...authority,permit:{...permit,token:'wrong'}};assert.equal((await f.store.put(f.lease,[incoming],undefined,wrong)).status,'stale');
 const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,...args){if(this.name==='charts' && value.id===incoming.id)throw new DOMException('full','QuotaExceededError');return original.call(this,value,...args);};
 try{assert.equal((await f.store.put(f.lease,[incoming],undefined,authority)).status,'quota');}finally{IDBObjectStore.prototype.put=original;}
 assert.deepEqual((await f.store.maintenance.inventory(f.lease))?.cards.map(row=>row.id),[f.card.id]);
 assert.equal((await f.store.put(f.lease,[incoming],undefined,authority)).status,'stored');
 assert.equal((await f.store.maintenance.readCard(f.lease,incoming.id) as typeof incoming)?.id,incoming.id);
});
test('an account boundary invalidates old fill updates and an aborted queued placement writes nothing',async t=>{
 const f=await fixture(t),permit=await f.grant(f.candidate),controller=new AbortController(),original=IDBObjectStore.prototype.get;
 IDBObjectStore.prototype.get=function(key){const result=original.call(this,key);if(this.name==='context' && key==='library-fill')queueMicrotask(()=>controller.abort());return result;};
 try{assert.equal(await f.store.putPackage(f.lease,f.card,f.ref,f.bytes(),{authority:{permit,signal:controller.signal}}),'unavailable');}finally{IDBObjectStore.prototype.get=original;}
 assert.equal(await f.store.readPackage(f.lease,f.ref),null);await f.store.activate('2');
 assert.equal(await f.store.fill.update(f.lease,()=>true),null);assert.equal(await f.store.fill.read(f.lease),null);
});
test('a fill right cannot be reused to write another card or a different numerical package',async t=>{
 const f=await fixture(t),permit=await f.grant(f.candidate),authority={permit,signal:new AbortController().signal};
 assert.equal((await f.store.put(f.lease,[accountNatalChart(2)],undefined,authority)).status,'stale');
 const other={...f.card,birthDate:'2000-01-02',revision:2},otherRef={kind:'day' as const,sourceKey:natalDaySourceKey({date:other.birthDate,timezone:other.timezone!})};
 await f.store.put(f.lease,[other]);const bytes=encodeNatalDay(natalDayFixture({date:other.birthDate,samples:10})).slice().buffer;
 assert.equal(await f.store.putPackage(f.lease,other,otherRef,bytes,{authority}),'stale');
});
test('a failed reservation commit grants nothing and corrupt control cannot become a fresh unlimited budget',async t=>{
 const f=await fixture(t),original=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(value,...args){if(this.name==='context' && value.key==='library-fill')throw new DOMException('full','QuotaExceededError');return original.call(this,value,...args);};
 try{assert.equal(await f.store.fill.update(f.lease,state=>reserveFill(state,{candidate:f.candidate,lease:f.lease,owner:'a',token:'one',sessionId:'s',now:10000,occasion:10000})),null);}finally{IDBObjectStore.prototype.put=original;}
 assert.deepEqual(await f.store.fill.read(f.lease),{flight:null,budgets:{}});
 const open=f.factory.open('forma-account-library'),db=await new Promise<IDBDatabase>(resolve=>{open.onsuccess=()=>resolve(open.result);});t.after(()=>db.close());
 await new Promise<void>(resolve=>{const tx=db.transaction('context','readwrite');tx.objectStore('context').put({key:'library-fill',accountId:'1',value:{flight:null,budgets:{bad:{attempts:100}}}});tx.oncomplete=()=>resolve();});
 assert.equal(await f.store.fill.read(f.lease),null);let called=false;
 assert.equal(await f.store.fill.update(f.lease,()=>{called=true;return true;}),null);assert.equal(called,false);
});
test('a still-live fill token from a retired library generation cannot write through a newly acquired lease',async t=>{
 const f=await fixture(t),incoming={...f.card,revision:2},candidate={key:'card',chartId:f.card.id,revision:1,ref:{kind:'card' as const,sourceKey:'card'}},permit=await f.grant(candidate);
 const removed=await f.store.remove(f.lease,accountNatalChart(9).id);if(removed.status!=='stored')throw Error();
 assert.equal((await f.store.put(removed.lease,[incoming],undefined,{permit,signal:new AbortController().signal})).status,'stale');
 assert.equal((await f.store.maintenance.readCard(removed.lease,f.card.id))?.revision,1);
});
test('neither a caller nor stored metadata may extend the other side of the fill deadline',async t=>{
 for(const side of ['caller','stored'] as const){
  const f=await fixture(t),permit=await f.grant(f.candidate),early={...permit,expiresAt:10000};
  if(side==='stored')await f.store.fill.update(f.lease,state=>{state.flight={...early,startedAt:9999};return true;});
  assert.equal(await f.store.putPackage(f.lease,f.card,f.ref,f.bytes(),{authority:{permit:side==='caller'?early:permit,signal:new AbortController().signal}}),'stale');
  assert.equal(await f.store.readPackage(f.lease,f.ref),null);
 }
});
test('corrupt persisted fill authority denies placement without throwing or authorizing new numbers',async t=>{
 const f=await fixture(t),permit=await f.grant(f.candidate),open=f.factory.open('forma-account-library');
 const db=await new Promise<IDBDatabase>(resolve=>{open.onsuccess=()=>resolve(open.result);});t.after(()=>db.close());
 await new Promise<void>(resolve=>{const tx=db.transaction('context','readwrite');tx.objectStore('context').put({key:'library-fill',accountId:'1',value:null});tx.oncomplete=()=>resolve();});
 assert.equal(await f.store.putPackage(f.lease,f.card,f.ref,f.bytes(),{authority:{permit,signal:new AbortController().signal}}),'stale');
 assert.equal(await f.store.readPackage(f.lease,f.ref),null);
});
