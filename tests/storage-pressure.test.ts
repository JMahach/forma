import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoragePressure} from '../src/data/storage-pressure.ts';
import {createCalculationCache} from '../src/data/calculation-cache.ts';
import {createAccountLibraryStore} from '../src/data/account-library-store.ts';
import {createIndexedDatabase} from '../src/data/indexed-db.ts';
import {IDBFactory,IDBObjectStore,forceCloseDatabase} from 'fake-indexeddb';
import {createJournal} from '../src/journal.ts';
import {accountChart,chartId} from './helpers/account-chart.ts';

test('pressure retries after one release and stops as soon as the original write fits',async()=>{
 const pressure=createStoragePressure({locks:null}),removed:string[]=[];let days=12,returns=12,cards=11;
 pressure.setSources({diagnostics:async()=>{if(removed.includes('diagnostics'))return 'empty';removed.push('diagnostics');return 'released';},
  natalDays:async keep=>{if(days<=keep)return 'empty';days--;removed.push('day');return 'released';},
  returnCharts:async keep=>{if(returns<=keep)return 'empty';returns--;removed.push('return');return 'released';},
  charts:async keep=>{if(cards<=keep)return 'empty';cards--;removed.push('card');return 'released';}});
 const result=await pressure.write(async()=>removed.length===4?{status:'complete',value:'written'}:{status:'quota'});
 assert.deepEqual(result,{status:'complete',value:'written'});
 assert.deepEqual(removed,['diagnostics','day','day','return']);assert.equal(returns,11);assert.equal(cards,11);
});
test('after ten days and ten returns only cards may fall below ten; an unavailable owner blocks later deletion',async()=>{
 const pressure=createStoragePressure({locks:null});let cards=11;const keeps:number[]=[];
 pressure.setSources({diagnostics:async()=> 'empty',natalDays:async keep=>{assert.equal(keep,10);return 'empty';},
  returnCharts:async keep=>{assert.equal(keep,10);return 'empty';},charts:async keep=>{keeps.push(keep);if(cards<=keep)return 'empty';cards--;return 'released';}});
 assert.deepEqual(await pressure.write(async()=>cards===1?{status:'complete',value:true}:{status:'quota'}),{status:'complete',value:true});
 assert.equal(cards,1);assert.ok(keeps.includes(0));
 pressure.setSources({diagnostics:async()=> 'unavailable'});const before=keeps.length;
 assert.deepEqual(await pressure.write(async()=>({status:'quota'})),{status:'quota'});assert.equal(keeps.length,before);
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
test('library relief persists last use, preserves protected targets and does not change server identity or notes',async t=>{
 const indexedDB=new IDBFactory();let now=10;
 const store=createAccountLibraryStore({indexedDB,now:()=>now++});t.after(()=>store.close());
 const active=await store.activate('1');assert.equal(active.status,'stored');if(active.status!=='stored')return;
 await store.put(active.lease,Array.from({length:11},(_,n)=>accountChart(n+1)));
 const get=IDBObjectStore.prototype.get,put=IDBObjectStore.prototype.put;
 let numericReads=0,numericWrites=0;
 IDBObjectStore.prototype.get=function(...args){if(this.name==='charts')numericReads++;return get.apply(this,args);};
 IDBObjectStore.prototype.put=function(...args){if(this.name==='charts')numericWrites++;return put.apply(this,args);};
 try { assert.equal(await store.touch(active.lease,chartId(1)),true); }
 finally {IDBObjectStore.prototype.get=get;IDBObjectStore.prototype.put=put;}
 assert.equal(numericReads,0,'recording an opening does not read the numerical card');
 assert.equal(numericWrites,0,'recording an opening does not rewrite its prepared numbers');
 assert.equal(await store.evictForSpace(10,[chartId(2)]),'released');
 const snapshot=await store.read();assert.equal(snapshot!.charts.length,10);assert.equal(snapshot!.charts.some(c=>c.id===chartId(3)),false);
 assert.deepEqual(snapshot!.lease,active.lease);assert.equal('_accessedAt' in snapshot!.charts[0]!,false);
 assert.equal(await store.evictForSpace(10,[]),'empty');
 for(let i=0;i<9;i++)assert.equal(await store.evictForSpace(0,[chartId(1)]),'released');
 assert.equal(await store.evictForSpace(0,[chartId(1)]),'empty');assert.deepEqual((await store.read())!.charts.map(c=>c.id),[chartId(1)]);
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
  returnCharts:async()=>assert.fail('returns must survive'),charts:async()=>assert.fail('library must survive')});
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

test('an older library owner cannot reclaim the replacement account after another tab signs in',async t=>{
 const indexedDB=new IDBFactory(),a=createAccountLibraryStore({indexedDB}),b=createAccountLibraryStore({indexedDB});
 t.after(()=>{a.close();b.close();});await a.activate('1');const active=await b.activate('2');assert.equal(active.status,'stored');if(active.status!=='stored')return;
 await b.put(active.lease,[accountChart(1,'2')]);assert.equal(await a.evictForSpace(0,[]),'unavailable');
 assert.equal((await b.read())!.charts.length,1);
});

test('library keeps its own deletion generation for pressure and clears admission on logout',async t=>{
 const store=createAccountLibraryStore({indexedDB:new IDBFactory()});t.after(()=>store.close());
 const active=await store.activate('1');assert.equal(active.status,'stored');if(active.status!=='stored')return;
 await store.put(active.lease,[accountChart(1),accountChart(2)]);
 const removed=await store.remove(active.lease,chartId(1));assert.equal(removed.status,'stored');if(removed.status!=='stored')return;
 assert.equal(await store.evictForSpace(0),'released');
 assert.equal(await store.clear(removed.lease),'cleared');assert.equal(await store.evictForSpace(0),'empty');
 const next=await store.activate('1');assert.equal(next.status,'stored');
 assert.equal(await store.clearAccount('1'),'cleared');assert.equal(await store.evictForSpace(0),'empty');
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
 assert.deepEqual(await store.read(),{lease:{accountId:'1',generation:'legacy'},charts:[accountChart(1)]});
 assert.equal(await store.evictForSpace(0),'released');assert.deepEqual((await store.read())!.charts,[]);
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
    returnCharts: async () => assert.fail('returns must remain untouched'),
    charts: async () => assert.fail('saved cards must remain untouched')});
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
  assert.deepEqual(await b.read(), {lease: second.lease, charts: [replacement]});
});
