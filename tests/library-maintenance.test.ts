import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {createAccountLibraryStore} from '../src/data/account-library-store.ts';
import {accountNatalChart} from './helpers/account-chart.ts';
import {natalDayFixture} from './fixtures/natal-day.ts';
import {encodeNatalDay} from '../server/packets/encode.ts';
import {natalDaySourceKey} from '../shared/library-package-contract.ts';
import type {LibraryAuditCursor} from '../src/domain/library-maintenance.ts';
import {libraryPackageId} from '../src/data/library-package-store.ts';
const card=accountNatalChart(),ref={kind:'day' as const,sourceKey:natalDaySourceKey({date:card.birthDate,timezone:card.timezone!})};
const bytes=()=>encodeNatalDay(natalDayFixture({date:card.birthDate,samples:10})).slice().buffer;
async function fixture(t:TestContext){
 const factory=new IDBFactory(),store=createAccountLibraryStore({indexedDB:factory,now:()=>1234});t.after(()=>store.close());
 const active=await store.activate('1');assert.equal(active.status,'stored');if(active.status!=='stored')throw Error('owner');
 await store.put(active.lease,[card,accountNatalChart(2)]);await store.putPackage(active.lease,card,ref,bytes());
 const request=factory.open('forma-account-library');const db=await new Promise<IDBDatabase>(resolve=>{request.onsuccess=()=>resolve(request.result);});t.after(()=>db.close());
 const change=(run:(tx:IDBTransaction)=>void)=>new Promise<void>((resolve,reject)=>{const tx=db.transaction(['charts','context','packages','packageMetadata','usage'],'readwrite');tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);run(tx);});
 return {store,lease:active.lease,db,change};
}
test('inventory reads only keys, refs and use; retained eviction is not presented as payload',async t=>{
 const f=await fixture(t);assert.ok(f.store.maintenance,'same-library maintenance facade');
 await f.store.touch(f.lease,card.id);
 await f.change(tx=>{tx.objectStore('packages').delete(libraryPackageId(ref));tx.objectStore('packageMetadata').put({id:libraryPackageId(ref),ref,chartIds:[card.id],evicted:true});});
 const original=IDBObjectStore.prototype.getAll;
 IDBObjectStore.prototype.getAll=function(...args){assert.ok(!['charts','packages'].includes(this.name),'no numerical getAll');return original.apply(this,args);};
 try {
  const inventory=await f.store.maintenance.inventory(f.lease);assert.ok(inventory);
  assert.deepEqual(inventory.cards.map(row=>row.id),[card.id,accountNatalChart(2).id]);
  assert.deepEqual(inventory.usage.find(row=>row.id===card.id),{id:card.id,openedAt:1234});
  assert.deepEqual(inventory.packages,[{id:libraryPackageId(ref),ref,chartIds:[card.id],evicted:true,present:false}]);
  assert.equal(JSON.stringify(inventory).includes('activations'),false);
 }finally{IDBObjectStore.prototype.getAll=original;}
});
test('audit is bounded, sees current replacements, and marks completion only after the full walk',async t=>{
 const f=await fixture(t);assert.ok(f.store.maintenance);
 await f.change(tx=>tx.objectStore('charts').put({...accountNatalChart(2),accountId:'foreign'}));
 const first=await f.store.maintenance.auditPage(f.lease,null,1);assert.equal(first?.checked,1);assert.ok(first?.next);
 assert.equal(await f.store.maintenance.readAuditCheckpoint(f.lease),null);
 // A valid replacement lands after the preceding page, before this row is examined.
 await f.change(tx=>tx.objectStore('charts').put({...accountNatalChart(2),revision:2}));
 let cursor:LibraryAuditCursor|null=first!.next,removed=0,checked=1;
 while(cursor){const page=await f.store.maintenance.auditPage(f.lease,cursor,1);assert.ok(page);assert.ok(page.checked<=1);removed+=page.removed;checked+=page.checked;cursor=page.next;}
 assert.equal(removed,0);assert.ok(checked>=4);assert.equal((await f.store.read())?.charts.find(row=>row.id===accountNatalChart(2).id)?.revision,2);
 const checkpoint={runId:'run',cursor:null,completedAt:1234};
 assert.equal(await f.store.maintenance.saveAuditCheckpoint(f.lease,null,checkpoint),'stored');
 assert.deepEqual(await f.store.maintenance.readAuditCheckpoint(f.lease),checkpoint);
 assert.equal(await f.store.maintenance.saveAuditCheckpoint(f.lease,null,{...checkpoint,runId:'late'}),'superseded');
});
test('audit discards confirmed corruption while keeping intentional eviction and current-account data',async t=>{
 const f=await fixture(t);assert.ok(f.store.maintenance);
 await f.change(tx=>{tx.objectStore('packages').put({id:libraryPackageId(ref),payload:new ArrayBuffer(3)});tx.objectStore('charts').put({...accountNatalChart(2),accountId:'foreign'});});
 let cursor=null,removed=0;
 do{const page=await f.store.maintenance.auditPage(f.lease,cursor,2);assert.ok(page);removed+=page.removed;cursor=page.next;}while(cursor);
 assert.equal(removed,2);assert.equal(await f.store.readPackage(f.lease,ref),null);assert.equal((await f.store.read())?.charts.length,1);
 const second=await f.store.activate('2');if(second.status!=='stored')throw Error('owner');await f.store.put(second.lease,[accountNatalChart(3,'2')]);
 assert.equal(await f.store.maintenance.auditPage(f.lease,null,20),null);assert.equal((await f.store.read())?.charts.length,1);
});

test('quota eviction retains an explicit card marker and successful acquisition clears it without inventing use',async t=>{
 const f=await fixture(t),incoming=accountNatalChart(3);await f.store.touch(f.lease,accountNatalChart(2).id);
 const originalPut=IDBObjectStore.prototype.put,originalDelete=IDBObjectStore.prototype.delete,freed=new WeakSet<IDBTransaction>();
 IDBObjectStore.prototype.delete=function(key){if(this.name==='charts')freed.add(this.transaction);return originalDelete.call(this,key);};
 IDBObjectStore.prototype.put=function(value,...args){if(this.name==='charts' && value.id===incoming.id && !freed.has(this.transaction))throw new DOMException('full','QuotaExceededError');return originalPut.call(this,value,...args);};
 try{assert.equal(await f.store.touch(f.lease,incoming.id,incoming),true);}finally{IDBObjectStore.prototype.put=originalPut;IDBObjectStore.prototype.delete=originalDelete;}
 const evicted=await f.store.maintenance.inventory(f.lease);assert.ok(evicted);assert.equal(evicted.cards.some(row=>row.id===card.id),false);
 assert.deepEqual(evicted.usage.find(row=>row.id===card.id),{id:card.id,openedAt:0,evicted:true});
 await f.store.put(f.lease,[card]);const restored=await f.store.maintenance.inventory(f.lease);assert.ok(restored);
 assert.deepEqual(restored.usage.find(row=>row.id===card.id),{id:card.id,openedAt:0});
});

test('a lost payload is repaired as a miss, an intentional miss stays marked, and orphan bytes are retired',async t=>{
 const f=await fixture(t),id=libraryPackageId(ref);const otherRef={kind:'day' as const,sourceKey:'["2000-01-02","UTC"]'},otherId=libraryPackageId(otherRef);
 await f.change(tx=>{
  tx.objectStore('packages').delete(id);
  tx.objectStore('packageMetadata').put({id,ref,chartIds:[card.id,accountNatalChart(2).id],evicted:true});
  tx.objectStore('packages').put({id:otherId,payload:bytes()});
 });
 const page=await f.store.maintenance.auditPage(f.lease,null,100);assert.equal(page?.next,null);assert.equal(page?.removed,1);
 const inventory=await f.store.maintenance.inventory(f.lease);assert.equal(inventory?.packages[0]?.evicted,true);
 await f.change(tx=>tx.objectStore('packageMetadata').put({id,ref,chartIds:[card.id]}));
 const lost=await f.store.maintenance.auditPage(f.lease,null,100);assert.equal(lost?.removed,1);
 assert.equal((await f.store.maintenance.inventory(f.lease))?.packages.length,0);
});
test('failed checkpoint persistence cannot rewrite numbers or erase the previous completed audit',async t=>{
 const f=await fixture(t),first={runId:'previous',cursor:null,completedAt:100};
 assert.equal(await f.store.maintenance.saveAuditCheckpoint(f.lease,null,first),'stored');
 const original=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(value,...args){if(this.name==='context' && value.key==='library-audit')throw new DOMException('full','QuotaExceededError');assert.ok(!['charts','packages'].includes(this.name));return original.call(this,value,...args);};
 try{assert.equal(await f.store.maintenance.saveAuditCheckpoint(f.lease,first,{runId:'next',cursor:{phase:'charts'},completedAt:100}),'unavailable');}finally{IDBObjectStore.prototype.put=original;}
 assert.deepEqual(await f.store.maintenance.readAuditCheckpoint(f.lease),first);
 assert.deepEqual(await f.store.readPackage(f.lease,ref),bytes());
});

test('audit rejects malformed ownership metadata and removes obsolete source links without deleting a good shared packet',async t=>{
 const f=await fixture(t),id=libraryPackageId(ref);
 await f.change(tx=>{
  tx.objectStore('charts').put({...accountNatalChart(2),birthDate:'2000-01-02',revision:2});
  tx.objectStore('packageMetadata').put({id,ref,chartIds:[card.id,accountNatalChart(2).id]});
  for(const [index,value] of [null,{ref:null},{ref,chartIds:[]},{ref:{kind:'major-returns',family:'moon',sourceKey:ref.sourceKey},chartIds:[card.id]},
   {ref,chartIds:[card.id],evicted:'yes'},{ref:{kind:'day',sourceKey:'not-json'},chartIds:[card.id]}].entries()){
   const key=index===5?'\u007b"kind":"day","sourceKey":"not-json"\u007d':'invalid-'+index;
   tx.objectStore('packageMetadata').put({...value,id:key});
  }
 });
 const page=await f.store.maintenance.auditPage(f.lease,null,100);assert.equal(page?.next,null);assert.equal(page?.removed,6);
 assert.deepEqual((await f.store.maintenance.inventory(f.lease))?.packages[0]?.chartIds,[card.id]);
 assert.deepEqual(await f.store.readPackage(f.lease,ref),bytes());
});
test('maintenance bounds input and captures its account generation before an asynchronous read',async t=>{
 const f=await fixture(t);
 for(const limit of [0,-1,101,NaN])assert.throws(()=>f.store.maintenance.auditPage(f.lease,null,limit),TypeError);
 const seen={...f.lease},read=f.store.maintenance.inventory(seen);seen.accountId='2';assert.equal((await read)?.lease.accountId,'1');
 const next=await f.store.activate('2');assert.equal(next.status,'stored');
 assert.equal(await f.store.maintenance.saveAuditCheckpoint(f.lease,null,{runId:'old',cursor:null,completedAt:1234}),'stale');
});

test('invalid source references in eviction markers are removed instead of becoming permanent missing packages',async t=>{
 const f=await fixture(t);
 await f.change(tx=>{
  for(const sourceKey of ['not-json','{}','["only"]','["a",1]']){
   const bad={kind:'day' as const,sourceKey};tx.objectStore('packageMetadata').put({id:libraryPackageId(bad),ref:bad,chartIds:[card.id],evicted:true});
  }
 });
 const result=await f.store.maintenance.auditPage(f.lease,null,100);assert.equal(result?.removed,4);assert.equal((await f.store.maintenance.inventory(f.lease))?.packages.length,1);
});

test('a corrupt card loses its package link in the same bounded page and invalid continuation cannot choose a store',async t=>{
 const f=await fixture(t);
 assert.throws(()=>f.store.maintenance.auditPage(f.lease,{phase:'elsewhere'} as never,1),TypeError);
 await f.change(tx=>tx.objectStore('charts').put({...card,accountId:'foreign'}));
 const page=await f.store.maintenance.auditPage(f.lease,null,1);assert.equal(page?.removed,1);
 const inventory=await f.store.maintenance.inventory(f.lease);assert.deepEqual(inventory?.packages[0]?.chartIds,[accountNatalChart(2).id]);
});

test('audit cancellation aborts a queued transaction without deleting a corrupt record',async t=>{
 const f=await fixture(t);await f.change(tx=>tx.objectStore('charts').put({...card,accountId:'foreign'}));
 const controller=new AbortController(),original=IDBObjectStore.prototype.get;
 IDBObjectStore.prototype.get=function(key){const request=original.call(this,key);if(this.name==='charts')queueMicrotask(()=>controller.abort());return request;};
 try{assert.equal(await f.store.maintenance.auditPage(f.lease,null,1,controller.signal),null);}finally{IDBObjectStore.prototype.get=original;}
 const tx=f.db.transaction('charts','readonly'),read=tx.objectStore('charts').get(card.id);
 const value=await new Promise<any>(resolve=>{read.onsuccess=()=>resolve(read.result);});assert.equal(value.accountId,'foreign');
 const stopped=new AbortController();stopped.abort();
 assert.equal(await f.store.maintenance.saveAuditCheckpoint(f.lease,null,{runId:'late',cursor:null,completedAt:1234},stopped.signal),'unavailable');
 assert.equal(await f.store.maintenance.readAuditCheckpoint(f.lease),null);
});
test('audit ownership survives checkpoint persistence and malformed leases cannot be accepted',async t=>{
 const f=await fixture(t),value={runId:'r',cursor:{phase:'charts' as const},completedAt:0,lease:{owner:'tab',expiresAt:30000}};
 assert.equal(await f.store.maintenance.saveAuditCheckpoint(f.lease,null,value),'stored');
 assert.deepEqual(await f.store.maintenance.readAuditCheckpoint(f.lease),value);
 for(const lease of [null,{}, {owner:'',expiresAt:1},{owner:'a',expiresAt:-1}]){
  assert.throws(()=>f.store.maintenance.saveAuditCheckpoint(f.lease,value,{...value,lease} as never),TypeError);
 }
});

test('a stale audit owner cannot inspect or remove rows after another tab takes its cursor',async t=>{
 const f=await fixture(t),first={runId:'r',cursor:{phase:'charts' as const},completedAt:0,lease:{owner:'old',expiresAt:100}},second={runId:'r',cursor:{phase:'charts' as const},completedAt:0,lease:{owner:'new',expiresAt:50000}};
 await f.store.maintenance.saveAuditCheckpoint(f.lease,null,first);
 await f.store.maintenance.saveAuditCheckpoint(f.lease,first,second);
 await f.change(tx=>tx.objectStore('charts').put({...card,accountId:'foreign'}));
 assert.equal(await f.store.maintenance.auditPage(f.lease,null,1,undefined,first),null);
 const page=await f.store.maintenance.auditPage(f.lease,null,1,undefined,second);assert.equal(page?.removed,1);
});
