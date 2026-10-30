import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {createAccountLibraryStore} from '../src/data/account-library-store.ts';
import {natalDaySourceKey,returnSourceKey,type MajorReturnsPackage,type PackageRef} from '../shared/library-package-contract.ts';
import {mainReturnRange} from '../shared/chart-return-contract.ts';
import {cycleAge} from '../shared/cycles-format.ts';
import {encodeNatalDay} from '../server/packets/encode.ts';
import {decodeNatalDay} from '../shared/day-packets/decode.ts';
import {natalDayFixture} from './fixtures/natal-day.ts';
import {accountNatalChart} from './helpers/account-chart.ts';

const chart={...accountNatalChart(),source:'calculated' as const,timezone:'UTC',designArcResidualDegrees:1e-9};
const dayRef:PackageRef={kind:'day',sourceKey:natalDaySourceKey({date:chart.birthDate,timezone:chart.timezone})};
function dayBytes(){return encodeNatalDay(natalDayFixture({date:chart.birthDate})).slice().buffer;}
function family(){
 const source={birthUtc:chart.utc,timezone:chart.timezone},body='saturn' as const;
 const events=Array.from({length:5},(_,index)=>{
  const utc=`${2010+index*10}-01-01T12:00:00.123456Z`,cycle=index+1;
  return {utc,body,id:`${body}:${utc}`,age:cycleAge(utc,source.birthUtc),cycle,cycleId:`${body}:${cycle}`,pass:1,direction:'direct' as const};
 });
 const value:MajorReturnsPackage={source,family:body,dates:{range:mainReturnRange(source.birthUtc)!,events},
  charts:events.map(event=>({chart:{...chart,utc:event.utc,designUtc:'2009-10-01T12:00:00Z'}}))};
 value.charts[0].chart.activations=structuredClone(chart.activations);
 value.charts[0].chart.activations.personality[0].longitude=-0;
 const ref:PackageRef={kind:'major-returns',sourceKey:returnSourceKey(source),family:body};
 return {ref,value};
}
async function setup(t:TestContext,indexedDB=new IDBFactory()){
 const store=createAccountLibraryStore({indexedDB});t.after(()=>store.close());
 const active=await store.activate('1');assert.equal(active.status,'stored');if(active.status!=='stored')throw Error('owner');
 await store.put(active.lease,[chart]);return {store,lease:active.lease,indexedDB};
}

test('only a complete validated family becomes durable and exact numbers survive reopening',async t=>{
 const {store,lease,indexedDB}=await setup(t),{ref,value}=family();
 assert.equal(await store.putPackage(lease,chart,ref,{...value,charts:value.charts.slice(0,2)}),'invalid');
 assert.equal(await store.readPackage(lease,ref),null);
 assert.equal(await store.putPackage(lease,chart,ref,value),'stored');
 const reopened=createAccountLibraryStore({indexedDB});t.after(()=>reopened.close());
 assert.deepEqual(await reopened.readPackage(lease,ref),value);
 assert.equal(await reopened.putPackage(lease,chart,ref,value),'no-op');
});

test('a shared full day is written once and survives removal of one card link',async t=>{
 const {store,lease}=await setup(t),other=accountNatalChart(2),bytes=dayBytes();
 await store.put(lease,[other]);
 assert.equal(await store.putPackage(lease,chart,dayRef,bytes),'stored');
 const put=IDBObjectStore.prototype.put;let payloadWrites=0;
 IDBObjectStore.prototype.put=function(...args){if(this.name==='packages')payloadWrites++;return put.apply(this,args);};
 try{assert.equal(await store.putPackage(lease,other,dayRef,bytes),'no-op');}finally{IDBObjectStore.prototype.put=put;}
 assert.equal(payloadWrites,0,'adding a link does not rewrite prepared numbers');
 const removed=await store.remove(lease,chart.id);if(removed.status!=='stored')throw Error('remove');
 assert.deepEqual(decodeNatalDay(await store.readPackage(removed.lease,dayRef)),decodeNatalDay(bytes));
 const third=accountNatalChart(3);await store.put(removed.lease,[third]);
 const second=await store.remove(removed.lease,other.id);if(second.status!=='stored')throw Error('second remove');
 assert.deepEqual(await store.readPackage(second.lease,dayRef),bytes,'later same-source card adds only a reference');
 const last=await store.remove(second.lease,third.id);if(last.status!=='stored')throw Error('last remove');
 assert.equal(await store.readPackage(last.lease,dayRef),null);
});

test('birth changes remove only obsolete package links and an old lease cannot publish into another account',async t=>{
 const {store,lease}=await setup(t),bytes=dayBytes();
 assert.equal(await store.putPackage(lease,{...chart,accountId:'2'},dayRef,bytes),'invalid');
 assert.equal(await store.putPackage(lease,chart,dayRef,bytes),'stored');
 const edited={...chart,revision:2,birthDate:'2000-01-02',utc:'2000-01-02T12:00:00Z'};
 await store.put(lease,[edited]);assert.equal(await store.readPackage(lease,dayRef),null);
 assert.equal(await store.putPackage(lease,chart,dayRef,bytes),'stale');
 await store.clear(lease);const restored=await store.activate('1');if(restored.status!=='stored')throw Error('restore');
 await store.put(restored.lease,[chart]);
 assert.equal(await store.putPackage(lease,chart,dayRef,bytes),'stale','signing back into the same account never revives a captured old lease');
 assert.equal(await store.readPackage(restored.lease,dayRef),null);
 const next=await store.activate('2');if(next.status!=='stored')throw Error('account');
 assert.equal(await store.putPackage(lease,chart,dayRef,bytes),'stale');
 assert.equal(await store.readPackage(lease,dayRef),null);
 assert.equal(await store.readPackage(next.lease,dayRef),null);
});

test('failed package writes preserve old data and a metadata row cannot make corrupt bytes ready',async t=>{
 const {store,lease,indexedDB}=await setup(t),bytes=dayBytes(),{ref,value}=family();
 await store.putPackage(lease,chart,dayRef,bytes);
 const put=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(...args){if(this.name==='packages')throw new DOMException('full','QuotaExceededError');return put.apply(this,args);};
 try{assert.equal(await store.putPackage(lease,chart,ref,value),'quota');}finally{IDBObjectStore.prototype.put=put;}
 assert.equal(await store.readPackage(lease,ref),null);
 assert.deepEqual(await store.readPackage(lease,dayRef),bytes);
 const open=indexedDB.open('forma-account-library');const db=await new Promise<IDBDatabase>((resolve,reject)=>{open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
 await new Promise<void>((resolve,reject)=>{const tx=db.transaction('packages','readwrite');tx.objectStore('packages').put({id:JSON.stringify(dayRef),payload:new ArrayBuffer(4)});tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});db.close();
 assert.equal(await store.readPackage(lease,dayRef),null);
 assert.equal(await store.putPackage(lease,chart,dayRef,bytes),'stored','a verified corrupt packet can be replaced');
 const reopen=indexedDB.open('forma-account-library');
 const damaged=await new Promise<IDBDatabase>(resolve=>{reopen.onsuccess=()=>resolve(reopen.result);});
 await new Promise<void>(resolve=>{const tx=damaged.transaction('packages','readwrite');tx.objectStore('packages').delete(JSON.stringify(dayRef));tx.oncomplete=()=>resolve();});damaged.close();
 assert.equal(await store.readPackage(lease,dayRef),null);
 assert.equal(await store.putPackage(lease,chart,dayRef,bytes),'stored','orphan metadata cannot suppress replacement of missing bytes');
 assert.deepEqual(await store.readPackage(lease,dayRef),bytes);
});

test('the real natal client stores an owned full day once and a new client restores it without HTTP',async t=>{
 const {createNatalDayClient}=await import('../src/data/natal-day-client.ts');
 const {store,lease}=await setup(t),bytes=dayBytes();let requests=0;
 const first=createNatalDayClient({library:store,persistentCache:null,fetch:async()=>{requests++;return new Response(bytes);}});
 const ready=await first.getDay(chart);
 // Reads share the account transaction queue with the preceding optional save.
 assert.deepEqual(await first.readStoredDay(chart),ready);
 const reopened=createNatalDayClient({library:store,persistentCache:null,fetch:async()=>assert.fail('ready owned day must not request HTTP')});
 const put=IDBObjectStore.prototype.put;let uses=0;
 IDBObjectStore.prototype.put=function(...args){if(this.name==='usage')uses++;return put.apply(this,args);};
 try{assert.deepEqual(await reopened.getDay(chart),ready);}finally{IDBObjectStore.prototype.put=put;}
 assert.equal(requests,1);assert.equal(uses,1,'opening an existing whole day records actual use once');
 await store.clear(lease);
 assert.equal(await first.readStoredDay(chart),null,'RAM never proves a new owned offline action after deletion');
});

test('an owned day response arriving after account change stays out of the new account storage',async t=>{
 const {createNatalDayClient}=await import('../src/data/natal-day-client.ts');
 const {store}=await setup(t),bytes=dayBytes();let finish!:(value:any)=>void,started!:()=>void;
 const began=new Promise<void>(resolve=>{started=resolve;});
 const client=createNatalDayClient({library:store,persistentCache:null,fetch:()=>{started();return new Promise(resolve=>{finish=resolve;});}});
 const pending=client.getDay(chart);await began;
 const next=await store.activate('2');if(next.status!=='stored')throw Error('account');
 finish({ok:true,arrayBuffer:async()=>bytes});await pending;
 assert.equal(await store.readPackage(next.lease,dayRef),null);
});

test('an owned RAM-only day never enables a new offline action or starts HTTP while offline',async t=>{
 const {createNatalDayClient}=await import('../src/data/natal-day-client.ts');
 const {createNatalDayExplorer}=await import('../src/state/natal-day.ts');
 const {store}=await setup(t),bytes=dayBytes();let calls=0,mode:'online'|'offline'='online';
 const client=createNatalDayClient({library:store,persistentCache:null,fetch:async()=>{calls++;return new Response(bytes);}});
 const explorer=createNatalDayExplorer({dayClient:client,connection:()=>mode});explorer.select({...chart,createdAt:'2026-10-30T00:00:00Z',updatedAt:'2026-10-30T00:00:00Z'});
 const put=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(...args){if(this.name==='packages')throw new DOMException('full','QuotaExceededError');return put.apply(this,args);};
 try {assert.equal(await explorer.open(),true);await client.readStoredDay(chart);}finally{IDBObjectStore.prototype.put=put;}
 explorer.close();mode='offline';await explorer.refreshAvailability();
 assert.equal(explorer.state.canOpen,false);
 assert.equal(await explorer.open(),false);assert.equal(calls,1);
 mode='online';assert.equal(await explorer.open(),true);
 assert.ok(await client.readStoredDay(chart),'reopening reconsiders the RAM packet without repeating HTTP');assert.equal(calls,1);
});

for(const [fits,used,tie] of [[true,false,false],[false,false,false],[true,true,false],[true,false,true]])test(`a new whole family can replace only lower-priority families, preserving cards and days: fits=${fits}, used=${used}, tie=${tie}`,async t=>{
 const {store,lease,indexedDB}=await setup(t),bytes=dayBytes(),original=family();
 const second=accountNatalChart(2);second.birthTime=tie?'11:00':'13:00';second.utc=`2000-01-01T${second.birthTime}:00Z`;
 await store.put(lease,[second]);await store.putPackage(lease,chart,dayRef,bytes);await store.putPackage(lease,chart,original.ref,original.value);
 if(used)await store.readPackage(lease,original.ref,{opened:true});
 const admitted=fits && !used && !tie;
 const next=structuredClone(original);next.value.source.birthUtc=second.utc;next.ref.sourceKey=returnSourceKey(next.value.source);
 next.value.dates.events.forEach(event=>{event.age=cycleAge(event.utc,second.utc);});
 const put=IDBObjectStore.prototype.put,remove=IDBObjectStore.prototype.delete,removed=new WeakSet<IDBTransaction>(),deletions:string[]=[];
 IDBObjectStore.prototype.delete=function(key){if(this.name==='packages'){removed.add(this.transaction);deletions.push(String(key));}return remove.call(this,key);};
 IDBObjectStore.prototype.put=function(value,...args){if(this.name==='packages' && value.id===JSON.stringify(next.ref) && (!fits || !removed.has(this.transaction)))throw new DOMException('full','QuotaExceededError');return put.call(this,value,...args);};
 try{assert.equal(await store.putPackage(lease,second,next.ref,next.value,{opened:!used && !tie}),admitted?'stored':'quota');}
 finally{IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.delete=remove;}
 assert.deepEqual((await store.read())!.charts,[chart,second]);assert.deepEqual(await store.readPackage(lease,dayRef),bytes);
 assert.deepEqual(deletions,used || tie?[]:[JSON.stringify(original.ref)]);
 assert.deepEqual(await store.readPackage(lease,original.ref),admitted?null:original.value);
 assert.deepEqual(await store.readPackage(lease,next.ref),admitted?next.value:null);
 const open=indexedDB.open('forma-account-library');
 const keys=await new Promise<IDBValidKey[]>(resolve=>{open.onsuccess=()=>{
  const tx=open.result.transaction('packageMetadata'),read=tx.objectStore('packageMetadata').getAllKeys();
  tx.oncomplete=()=>{open.result.close();resolve(read.result);};
 };});
 assert.deepEqual(keys.sort(),[JSON.stringify(dayRef),JSON.stringify(admitted?next.ref:original.ref)].sort(),'committed eviction leaves no orphan package links');
});

test('an opened card releases a lower-tier day before any existing card',async t=>{
 const {store,lease}=await setup(t),bytes=dayBytes();await store.putPackage(lease,chart,dayRef,bytes);
 const incoming=accountNatalChart(2),put=IDBObjectStore.prototype.put,remove=IDBObjectStore.prototype.delete,freed=new WeakSet<IDBTransaction>();
 const removed:string[]=[];
 IDBObjectStore.prototype.delete=function(key){removed.push(this.name);if(this.name==='packages')freed.add(this.transaction);return remove.call(this,key);};
 IDBObjectStore.prototype.put=function(value,...args){if(this.name==='charts' && value.id===incoming.id && !freed.has(this.transaction))throw new DOMException('full','QuotaExceededError');return put.call(this,value,...args);};
 try{assert.equal(await store.touch(lease,incoming.id,incoming),true);}finally{IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.delete=remove;}
 assert.equal(removed.includes('charts'),false);assert.equal((await store.read())!.charts.length,2);
 assert.equal(await store.readPackage(lease,dayRef),null);
});

test('background acquisition places a higher-tier card without opening it or deleting an existing card',async t=>{
 const {store,lease}=await setup(t),bytes=dayBytes();await store.putPackage(lease,chart,dayRef,bytes);
 const incoming=accountNatalChart(2),put=IDBObjectStore.prototype.put,remove=IDBObjectStore.prototype.delete,freed=new WeakSet<IDBTransaction>();
 const deleted:string[]=[],uses:string[]=[];
 IDBObjectStore.prototype.delete=function(key){deleted.push(this.name);if(this.name==='packages')freed.add(this.transaction);return remove.call(this,key);};
 IDBObjectStore.prototype.put=function(value,...args){if(this.name==='usage')uses.push(value.id);if(this.name==='charts' && value.id===incoming.id && !freed.has(this.transaction))throw new DOMException('full','QuotaExceededError');return put.call(this,value,...args);};
 let result;
 try{result=await store.put(lease,[incoming]);}finally{IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.delete=remove;}
 assert.equal(result.status,'stored');assert.deepEqual(uses,[]);assert.equal(deleted.includes('charts'),false);
 assert.equal((await store.read())!.charts.length,2);assert.equal(await store.readPackage(lease,dayRef),null);
});

test('a failed use mark does not hide a complete stored package or evict numerical data',async t=>{
 const {store,lease}=await setup(t),{ref,value}=family();await store.putPackage(lease,chart,ref,value);
 const put=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(...args){if(this.name==='usage')throw new DOMException('full','QuotaExceededError');return put.apply(this,args);};
 try {assert.deepEqual(await store.readPackage(lease,ref,{opened:true}),value);}finally{IDBObjectStore.prototype.put=put;}
 assert.deepEqual(await store.readPackage(lease,ref),value);
});

test('an existing legacy whole day moves into the account owner without HTTP and is removed only after success',async t=>{
 const {createNatalDayClient}=await import('../src/data/natal-day-client.ts');
 const {createCalculationCache}=await import('../src/data/calculation-cache.ts');
 const {createNatalDayStorage}=await import('../src/data/natal-day-storage.ts');
 const {store,lease,indexedDB}=await setup(t),bytes=dayBytes(),cache=createCalculationCache({indexedDB});t.after(()=>cache.close());
 const legacy=createNatalDayStorage({cache}),key=`natal-day:1:${chart.birthDate}:${chart.cityId}`;
 await legacy.put(key,bytes);
 const client=createNatalDayClient({library:store,persistentCache:legacy,fetch:async()=>assert.fail('legacy complete day should not refetch')});
 assert.deepEqual(await client.readStoredDay(chart),decodeNatalDay(bytes));
 assert.deepEqual(await store.readPackage(lease,dayRef),bytes);assert.equal(await legacy.get(key),null);
});

test('early calculation clients and the account library share one persistent package owner',async t=>{
 const {createCalculationClients}=await import('../src/data/calculation-clients.ts');
 const indexedDB=new IDBFactory(),bytes=dayBytes();let requests=0;
 const first=createCalculationClients({cacheOptions:{indexedDB},natal:{fetch:async()=>{requests++;return new Response(bytes);}}});t.after(()=>first.close());
 const active=await first.library.activate('1');if(active.status!=='stored')throw Error('owner');await first.library.put(active.lease,[chart]);
 const ready=await first.natal.getDay(chart);assert.deepEqual(await first.natal.readStoredDay(chart),ready);
 const second=createCalculationClients({cacheOptions:{indexedDB},natal:{fetch:async()=>assert.fail('reopened library should reuse full day')}});t.after(()=>second.close());
 await second.library.read();assert.deepEqual(await second.natal.getDay(chart),ready);assert.equal(requests,1);
});
