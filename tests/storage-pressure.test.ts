import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoragePressure} from '../src/data/storage-pressure.ts';
import {createCalculationCache} from '../src/data/calculation-cache.ts';
import {createAccountLibraryStore} from '../src/data/account-library-store.ts';
import {createIndexedDatabase} from '../src/data/indexed-db.ts';
import {IDBFactory,IDBObjectStore,IDBIndex,forceCloseDatabase} from 'fake-indexeddb';
import {createJournal} from '../src/journal.ts';
import {accountChart,chartId} from './helpers/account-chart.ts';
import {commitQuota} from './helpers/commit-quota.ts';

for(const required of [2,Infinity])test(`commit-time card quota uses bounded atomic replacement: ${required}`,async t=>{
 const store=createAccountLibraryStore({indexedDB:new IDBFactory(),now:()=>1000});t.after(()=>store.close());
 const active=await store.activate('1');assert.equal(active.status,'stored');if(active.status!=='stored')return;
 const cards=Array.from({length:5},(_,i)=>accountChart(i+1));await store.put(active.lease,cards);
 const incoming=accountChart(6),attempts=commitQuota(t,{store:'charts',id:incoming.id},required);
 assert.equal(await store.touch(active.lease,incoming.id,incoming),Number.isFinite(required));
 assert.deepEqual(attempts.map(rows=>rows.length),required===2?[0,1,2]:[0,1,2,4,5]);
 const saved=(await store.read())!.charts;
 assert.deepEqual(saved,required===2?[...cards.slice(2),incoming]:cards,'failed commits preserve every old payload');
});

test('pressure retries after one release and stops as soon as the original write fits',async()=>{
 const pressure=createStoragePressure({locks:null}),removed:string[]=[];let days=12,returns=12;
 pressure.setSources({diagnostics:async()=>{if(removed.includes('diagnostics'))return 'empty';removed.push('diagnostics');return 'released';},
  natalDays:async keep=>{if(days<=keep)return 'empty';days--;removed.push('day');return 'released';},
  returnCharts:async keep=>{if(returns<=keep)return 'empty';returns--;removed.push('return');return 'released';}});
 const result=await pressure.write(async()=>removed.length===4?{status:'complete',value:'written'}:{status:'quota'});
 assert.deepEqual(result,{status:'complete',value:'written'});
 assert.deepEqual(removed,['diagnostics','day','day','return']);assert.equal(returns,11);
});
test('an exhausted calculation cache cannot release account cards outside atomic placement',async()=>{
 const pressure=createStoragePressure({locks:null});let discarded=0;
 const sources={diagnostics:async()=> 'empty' as const,natalDays:async()=> 'empty' as const,returnCharts:async()=> 'empty' as const,
  charts:async()=>{discarded++;return 'released' as const;}};pressure.setSources(sources);
 const result=await pressure.write(async()=>discarded?{status:'complete',value:true}:{status:'quota'});
 assert.deepEqual(result,{status:'quota'});assert.equal(discarded,0);
});
test('ordinary refusal, success and blocked storage never remove unrelated data',async()=>{
 const pressure=createStoragePressure({locks:null});let calls=0;
 pressure.setSources({diagnostics:async()=>{calls++;return 'released';}});
 for(const value of [{status:'complete' as const,value:null},{status:'complete' as const,value:true},{status:'unavailable' as const}])
  assert.deepEqual(await pressure.write(async()=>value),value);
 assert.equal(calls,0);
});
test('two failing writers recheck after serialization instead of evicting twice for the same released room',async()=>{
 const pressure=createStoragePressure({locks:null});let room=false,removed=0;
 pressure.setSources({diagnostics:async()=>{removed++;await new Promise(r=>setImmediate(r));room=true;return 'released';}});
 const attempt=async()=>room?{status:'complete' as const,value:true}:{status:'quota' as const};
 assert.deepEqual(await Promise.all([pressure.write(attempt),pressure.write(attempt)]),[{status:'complete',value:true},{status:'complete',value:true}]);
 assert.equal(removed,1);
});
test('calculation relief is atomic across owners, uses last access, keeps ten and never removes transit or event lists',async t=>{
 const indexedDB=new IDBFactory(),a=createCalculationCache({indexedDB,legacySources:[]}),b=createCalculationCache({indexedDB,legacySources:[]});
 t.after(()=>{a.close();b.close();});
 for(let n=0;n<11;n++)await a.put('natal',String(n),new Uint8Array([n]));
 await a.get('natal','0');await a.put('return-events','dates',{events:[]});
 await a.setTransitWindow({dates:['2026-10-26'],expiresAt:Date.now()+100000});
 await a.put('transit','today',new Uint8Array([1]),{date:'2026-10-26'});
 const results=await Promise.all([a.evictForSpace('natal',10),b.evictForSpace('natal',10)]);
 assert.deepEqual(results.sort(),['empty','released']);assert.equal(await a.get('natal','1'),null);assert.ok(await a.get('natal','0'));
 assert.ok(await a.get('transit','today'));assert.ok(await a.get('return-events','dates'));
 assert.equal((await a.catalogue('natal'))!.length,10);
});
test('indexed adapter reports quota only after rollback and separates arbitrary aborts from full storage',async t=>{
 const db=createIndexedDatabase({indexedDB:new IDBFactory(),databaseName:'quota',version:1,stores:['data'],upgrade(d){d.createObjectStore('data');}});
 t.after(()=>db.close());
 const result=await db.transactionResult<boolean>('readwrite',(tx,done,fail)=>{
  tx.objectStore('data').put('temporary','key');queueMicrotask(()=>fail(new DOMException('full','QuotaExceededError')));done(true);
 });
 assert.deepEqual(result,{status:'quota'});
 const read=await db.transaction('readonly',(tx,done)=>{const r=tx.objectStore('data').get('key');r.onsuccess=()=>done(r.result??null);});assert.equal(read,null);
 assert.deepEqual(await db.transactionResult('readwrite',()=>{throw new Error('other');}),{status:'unavailable'});
});

test('a real failed calculation write releases diagnostics then one day, retries atomically, and preserves other categories',async t=>{
 const indexedDB=new IDBFactory(),pressure=createStoragePressure({locks:null}),cache=createCalculationCache({indexedDB,legacySources:[],pressure});
 const journal=createJournal({indexedDB,appVersion:'0.2',environment:'stand',connection:()=> 'offline'});
 t.after(async()=>{cache.close();await journal.close();});await journal.wake();
 await journal.begin({action:'calculate',component:'calculator'}).reportFailure({stage:'request',reason:'connection_failed'});
 for(let n=0;n<11;n++){await cache.put('natal',String(n),new Uint8Array([n]));await cache.put('return-charts',String(n),new Uint8Array([n]));}
 let full=true;
 pressure.setSources({diagnostics:journal.discardForSpace,natalDays:async(keep,exclude)=>{const result=await cache.evictForSpace('natal',keep,exclude);if(result==='released')full=false;return result;},
  returnCharts:async()=>assert.fail('returns must survive')});
 const original=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(value:unknown,key?:IDBValidKey){
  if(full && this.name==='payloads' && (value as {id?:string}).id==='["natal","new"]')throw new DOMException('full','QuotaExceededError');
  return key===undefined?original.call(this,value):original.call(this,value,key);
 };
 try{assert.equal(await cache.put('natal','new',new Uint8Array([99])),true);}finally{IDBObjectStore.prototype.put=original;}
 assert.deepEqual(await cache.get('natal','new'),new Uint8Array([99]));assert.equal(await cache.get('natal','0'),null);
 assert.equal((await cache.catalogue('return-charts'))!.length,11);assert.equal(await journal.discardForSpace(),'empty');
});
test('a library page that cannot fit still preserves a leading usable card and stops before evicting it again',async t=>{
 const store=createAccountLibraryStore({indexedDB:new IDBFactory()});t.after(()=>store.close());
 const active=await store.activate('1');assert.equal(active.status,'stored');if(active.status!=='stored')return;
 const original=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(value:unknown,key?:IDBValidKey){
  if(this.name==='charts' && (value as {id?:string}).id!==chartId(1))throw new DOMException('full','QuotaExceededError');
  return key===undefined?original.call(this,value):original.call(this,value,key);
 };
 try{assert.equal((await store.put(active.lease,[accountChart(1),accountChart(2),accountChart(3)])).status,'partial');}
 finally{IDBObjectStore.prototype.put=original;}
 assert.deepEqual((await store.read())!.charts.map(c=>c.id),[chartId(1)]);
});
test('logout revokes queued pressure and an awaited owner must not delete data of the replacement account',async()=>{
 const pressure=createStoragePressure({locks:null});let entered!:()=>void,release!:()=>void,deleted=0;
 const begun=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 pressure.setSources({diagnostics:async valid=>{entered();await gate;if(!valid!())return 'unavailable';deleted++;return 'released';}});
 const write=pressure.write(async()=>({status:'quota'}));await begun;pressure.invalidate();release();
 assert.deepEqual(await write,{status:'quota'});assert.equal(deleted,0);
});

test('library metadata upgrade preserves version-one charts, owner and notes',async t=>{
 const indexedDB=new IDBFactory(),databaseName='library-v1';
 await new Promise<void>((resolve,reject)=>{const request=indexedDB.open(databaseName,1);
  request.onupgradeneeded=()=>{const db=request.result;db.createObjectStore('charts',{keyPath:'id'});db.createObjectStore('context',{keyPath:'key'});};
  request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction(['charts','context'],'readwrite');
   tx.objectStore('charts').put(accountChart(1));tx.objectStore('context').put({key:'owner',accountId:'1',generation:'legacy'});
   tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};
 });
 const store=createAccountLibraryStore({indexedDB,databaseName});t.after(()=>store.close());
 assert.deepEqual(await store.read(),{lease:{accountId:'1',generation:'legacy'},charts:[accountChart(1)],minimumMarker:'0'});
 assert.equal(await store.clear({accountId:'1',generation:'legacy'}),'cleared');assert.deepEqual((await store.read())!.charts,[]);
});


test('a library write recovers through the shared pressure owner when reopening hits quota', async t => {
  const native = new IDBFactory(), pressure = createStoragePressure({locks: null});
  let full = false, released = 0, connection: IDBDatabase | undefined;
  const indexedDB = {open(...args: Parameters<IDBFactory['open']>) {
    if (full) throw new DOMException('Full', 'QuotaExceededError');
    const request = native.open(...args);
    request.addEventListener('success', () => { connection = request.result; });
    return request;
  }} as IDBFactory;
  const store = createAccountLibraryStore({indexedDB, pressure}); t.after(() => store.close());
  const active = await store.activate('1'); assert.equal(active.status, 'stored'); if (active.status !== 'stored') return;
  await store.put(active.lease, [accountChart(1)]);
  forceCloseDatabase(connection! as unknown as Parameters<typeof forceCloseDatabase>[0]);
  await new Promise(resolve => setImmediate(resolve)); full = true;
  pressure.setSources({diagnostics: async () => { released++; full = false; return 'released'; },
    natalDays: async () => assert.fail('enough space has already been released'),
    returnCharts: async () => assert.fail('returns must remain untouched')});
  const result = await store.put(active.lease, [accountChart(2)]);
  assert.equal(result.status, 'stored'); assert.equal(released, 1);
  assert.deepEqual((await store.read())!.charts.map(chart => chart.id).sort(), [chartId(1), chartId(2)].sort());
});


for (const waitingAttempt of [1, 2]) test(`logout before pressure admission revokes a library write waiting at attempt ${waitingAttempt}`, async t => {
  const native = new IDBFactory(), pressure = createStoragePressure({locks: null});
  let quota = false, attempts = 0, connection: IDBDatabase | undefined, finish!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), cleanupGuards: boolean[] = [];
  const indexedDB = {open(...args: Parameters<IDBFactory['open']>) {
    if (quota) {
      const failed = {error: new DOMException('Full', 'QuotaExceededError'), onerror: null as (() => void) | null};
      if (++attempts === waitingAttempt) { finish = () => failed.onerror?.(); entered(); }
      else queueMicrotask(() => failed.onerror?.());
      return failed as unknown as IDBOpenDBRequest;
    }
    const request = native.open(...args);
    request.addEventListener('success', () => { connection = request.result; });
    return request;
  }} as IDBFactory;
  const a = createAccountLibraryStore({indexedDB, pressure}), b = createAccountLibraryStore({indexedDB: native, pressure});
  t.after(() => { a.close(); b.close(); });
  const first = await a.activate('1'); assert.equal(first.status, 'stored'); if (first.status !== 'stored') return;
  await a.put(first.lease, [accountChart(1)]); await b.read();
  forceCloseDatabase(connection! as unknown as Parameters<typeof forceCloseDatabase>[0]);
  await new Promise(resolve => setImmediate(resolve)); quota = true;
  pressure.setSources({diagnostics: async guard => { cleanupGuards.push(guard()); quota = false; return 'released'; }});
  const pending = a.put(first.lease, [accountChart(2)]); await waiting;
  pressure.invalidate(); assert.equal(await b.clearAccount('1'), 'cleared');
  const second = await b.activate('2'); assert.equal(second.status, 'stored'); if (second.status !== 'stored') return;
  const replacement = accountChart(3, '2'); assert.equal((await b.put(second.lease, [replacement])).status, 'stored');
  finish(); const result = await pending;
  assert.deepEqual(cleanupGuards, [], 'an old write must not acquire cleanup permission after logout');
  assert.equal(result.status, 'stale');
  assert.deepEqual(await b.read(), {lease: second.lease, charts: [replacement], minimumMarker: '0'});
});


for(const [total,fitsAfterDeletion,failureMode] of [[50,true,'call'],[50,false,'call'],[1,true,'call'],[1,true,'request'],[1,false,'unavailable']] as const)test(`opening an absent card replaces a lower-priority card atomically: cards=${total}, fits=${fitsAfterDeletion}, failure=${failureMode}`,async t=>{
  const pressure=createStoragePressure({locks:null}),order:string[]=[];
  pressure.setSources({diagnostics:async()=>{order.push('diagnostics');return 'empty';}});
  const store=createAccountLibraryStore({indexedDB:new IDBFactory(),now:()=>1000,pressure});t.after(()=>store.close());
  const active=await store.activate('1');assert.equal(active.status,'stored');if(active.status!=='stored')return;
  const cards=Array.from({length:total},(_,n)=>accountChart(n+1));await store.put(active.lease,cards);
  const opened=Math.min(20,total-1);
  for(let n=1;n<=opened;n++)await store.touch(active.lease,chartId(n));
  const incoming=accountChart(total+1),removed=new WeakMap<IDBTransaction,number>();let deleteRequests=0;
  const put=IDBObjectStore.prototype.put,remove=IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete=function(...args){
    if(this.name==='charts'){order.push('victim');deleteRequests++;removed.set(this.transaction,(removed.get(this.transaction)??0)+1);}
    return remove.apply(this,args);
  };
  IDBObjectStore.prototype.put=function(value,...args){
    if(this.name==='charts' && value.id===incoming.id && (!fitsAfterDeletion || !removed.get(this.transaction))){
      if(failureMode==='unavailable')throw new Error('Storage cannot write');
      if(failureMode==='request'){
        // A real failing IDB request exercises preventDefault/transaction continuation.
        const request=this.add(cards[0]);
        return new Proxy(request,{
          get:(target,key)=>key==='error'?new DOMException('No room','QuotaExceededError'):Reflect.get(target,key,target),
          set:(target,key,value)=>Reflect.set(target,key,value,target),
        });
      }
      throw new DOMException('No room for the incoming card','QuotaExceededError');
    }
    return put.call(this,value,...args);
  };
  try {assert.equal(await store.touch(active.lease,incoming.id,incoming),fitsAfterDeletion);}
  finally {IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.delete=remove;}
  const saved=(await store.read())!.charts;
  assert.equal(saved.length,total);
  assert.ok(deleteRequests<=total,'one failed placement must not repeatedly revisit the same victims');
  if(failureMode==='unavailable')assert.deepEqual(order,[],'ordinary storage refusal never starts deletion');
  else assert.ok(order.indexOf('diagnostics')>=0 && order.indexOf('diagnostics')<order.indexOf('victim'),'disposable service data is considered before library victims');
  if(fitsAfterDeletion){
    assert.ok(saved.some(chart=>chart.id===incoming.id));
    assert.equal(saved.some(chart=>chart.id===chartId(opened+1)),false);
    for(let n=1;n<=opened;n++)assert.ok(saved.some(chart=>chart.id===chartId(n)));
  }else assert.deepEqual(saved,cards,'every candidate victim survives failed placement');
});


test('an opening waiting for its revision lookup cannot borrow a later cleanup permission',async t=>{
  const pressure=createStoragePressure({locks:null}),store=createAccountLibraryStore({indexedDB:new IDBFactory(),pressure});
  t.after(()=>store.close());const active=await store.activate('1');assert.equal(active.status,'stored');if(active.status!=='stored')return;
  const original=IDBIndex.prototype.getKey;
  t.mock.method(IDBIndex.prototype,'getKey',function(this:IDBIndex,...args:Parameters<IDBIndex['getKey']>){
    const request=original.apply(this,args);request.addEventListener('success',()=>pressure.invalidate());return request;
  });
  pressure.setSources({diagnostics:async()=>assert.fail('revoked opening cannot release service data')});
  assert.equal(await store.touch(active.lease,chartId(1),accountChart(1)),false);
  assert.deepEqual((await store.read())!.charts,[]);
});


test('another tab changing account during service cleanup rejects the subsequent placement',async t=>{
  const indexedDB=new IDBFactory(),pressure=createStoragePressure({locks:null});
  const a=createAccountLibraryStore({indexedDB,pressure}),b=createAccountLibraryStore({indexedDB});t.after(()=>{a.close();b.close();});
  const active=await a.activate('1');assert.equal(active.status,'stored');if(active.status!=='stored')return;
  await a.put(active.lease,[accountChart(1)]);
  const put=IDBObjectStore.prototype.put;
  t.mock.method(IDBObjectStore.prototype,'put',function(this:IDBObjectStore,value:unknown,key?:IDBValidKey){
    if(this.name==='charts' && (value as {id?:string}).id===chartId(2))throw new DOMException('Full','QuotaExceededError');
    return key===undefined?put.call(this,value):put.call(this,value,key);
  });
  pressure.setSources({diagnostics:async()=>{
    const next=await b.activate('2');assert.equal(next.status,'stored');if(next.status!=='stored')throw Error('account');
    await b.put(next.lease,[accountChart(3,'2')]);return 'empty';
  }});
  assert.equal(await a.touch(active.lease,chartId(2),accountChart(2)),false);
  assert.deepEqual((await b.read())!.charts,[accountChart(3,'2')]);
});

test('an older visible revision never evicts cards or repeats placement for a failed use mark',async t=>{
  const store=createAccountLibraryStore({indexedDB:new IDBFactory()});t.after(()=>store.close());
  const active=await store.activate('1');assert.equal(active.status,'stored');if(active.status!=='stored')return;
  const rows=[accountChart(1,'1',3),accountChart(2)];await store.put(active.lease,rows);
  const put=IDBObjectStore.prototype.put;let marks=0;
  t.mock.method(IDBObjectStore.prototype,'put',function(this:IDBObjectStore,value:unknown,key?:IDBValidKey){
    if(this.name==='usage'){marks++;throw new DOMException('Full','QuotaExceededError');}
    return key===undefined?put.call(this,value):put.call(this,value,key);
  });
  assert.equal(await store.touch(active.lease,chartId(1),accountChart(1)),false);
  assert.equal(marks,1,'already ready numbers do not justify another placement attempt');
  assert.deepEqual((await store.read())!.charts,rows);
});
