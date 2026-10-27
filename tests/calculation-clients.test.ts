import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createCalculationClients } from '../src/data/calculation-clients.ts';
import { createCalculationCache } from '../src/data/calculation-cache.ts';
import { createMemoryCache, TAB_CACHE_BYTES } from '../src/data/memory-cache.ts';
import { encodeNatalDay } from '../server/packets/encode.ts';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.ts';
import { deferred } from './helpers/deferred.ts';

const version='a'.repeat(64),chart=personalChartFixture(),tick=()=>new Promise(setImmediate);
const key=`natal-day:${version}:1:${chart.birthDate}:${chart.cityId}`;
const bytes=()=>encodeNatalDay({...natalDayFixture(),calculationVersion:version}).buffer;
const response=()=>({ok:true,arrayBuffer:async()=>bytes()});
const cycleInput={birthUtc:'2000-01-01T00:00:00Z',body:'saturn',fromAge:0,toAge:100};
const cycleResult=()=>({range:{fromAge:0,toAge:100},events:[]});

test('one early owner shares RAM and IDB while personal reset preserves transit and its retention',async t=>{
  const indexedDB=new IDBFactory(),memory=createMemoryCache({maxBytes:400_000});let natalCalls=0;
  const owner=createCalculationClients({cacheOptions:{indexedDB},memory,
    natal:{calculationVersion:version,fetch:async()=>{natalCalls++;return response();}},
    cycles:{cacheVersion:version,request:async()=>cycleResult()}});t.after(()=>owner.close());
  assert.equal(TAB_CACHE_BYTES,64*1024*1024);assert.equal(owner.transit.memory,memory);
  const transit={numbers:new ArrayBuffer(100)},release=memory.retain('transit-day:current',transit);
  const day=await owner.natal.getDay(chart),oldRelease=owner.natal.retainDay(day);
  await owner.cycles.events(cycleInput);await tick();
  const cleanup=owner.resetPersonal();
  assert.equal(owner.natal.peekDay(chart),null,'personal RAM disappears synchronously');
  assert.equal(memory.get('transit-day:current'),transit);
  assert.equal((await cleanup).status,'cleared');
  const fresh=await owner.natal.getDay(chart),newRelease=owner.natal.retainDay(fresh);
  oldRelease();memory.put('pressure',new ArrayBuffer(400_000));
  assert.equal(owner.natal.peekDay(chart),fresh,'old release cannot unpin the new generation');
  assert.equal(natalCalls,2);newRelease();release();
});

test('reset cancels old natal and cycle calls immediately; late replies cannot refill either cache',async t=>{
  const indexedDB=new IDBFactory(),natalReply=deferred(),cycleReply=deferred(),arrived=deferred();
  const signals:AbortSignal[]=[];let calls=0;
  const owner=createCalculationClients({cacheOptions:{indexedDB},
    natal:{calculationVersion:version,fetch:async(_url,{signal})=>{signals.push(signal);if(++calls===2)arrived.resolve!();return natalReply.promise;}},
    cycles:{cacheVersion:version,request:async(_url,{signal})=>{signals.push(signal!);if(++calls===2)arrived.resolve!();return cycleReply.promise;}}});t.after(()=>owner.close());
  const natal=owner.natal.getDay(chart),cycles=owner.cycles.events(cycleInput);
  const rejected=Promise.all([assert.rejects(natal,{name:'AbortError'}),assert.rejects(cycles,{name:'AbortError'})]);
  await arrived.promise;const cleanup=owner.resetPersonal();
  assert.ok(signals.every(signal=>signal.aborted));await rejected;
  natalReply.resolve!(response());cycleReply.resolve!(cycleResult());await cleanup;await tick();
  assert.equal(owner.natal.peekDay(chart),null);
  const disk=createCalculationCache({indexedDB});t.after(()=>disk.close());
  assert.equal(await disk.get('natal',key),null);assert.deepEqual(await disk.catalogue('return-events'),[]);
});

test('failed cleanup closes old persistence and a calculation begun in RAM never adopts a later persistent port',async t=>{
  const indexedDB=new IDBFactory(),late=deferred(),arrived=deferred();let calls=0;
  const owner=createCalculationClients({cacheOptions:{indexedDB},memory:createMemoryCache({maxBytes:400_000}),natal:{calculationVersion:version,fetch:async()=>{
    if(++calls===2){arrived.resolve!();return late.promise;}return response();}}});t.after(()=>owner.close());
  await owner.natal.getDay(chart);await tick();
  const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args){if(this.transaction.db.name==='forma-calculation-cache' && this.name==='control')throw new Error('Unavailable');return original.apply(this,args);};
  let result;try{result=await owner.resetPersonal();}finally{IDBObjectStore.prototype.put=original;}
  assert.equal(result.status,'unavailable');
  const calculating=owner.natal.getDay(chart);await arrived.promise;
  assert.equal((await owner.retryPersonalCleanup()).status,'cleared');
  late.resolve!(response());const ready=await calculating;await tick();
  assert.equal(owner.natal.peekDay(chart),ready);
  const disk=createCalculationCache({indexedDB});t.after(()=>disk.close());
  assert.equal(await disk.get('natal',key),null,'an already running RAM-only client must never switch storage');
  const release=owner.natal.retainDay(ready);owner.memory.put('pressure',new ArrayBuffer(400_000));
  assert.equal(owner.natal.peekDay(chart),ready,'a RAM-only result keeps the client that owns its retention after promotion');
  release();owner.memory.put('pressure',new ArrayBuffer(400_000));assert.equal(owner.natal.peekDay(chart),null);
});

test('pending legacy deletion is exposed and cannot grant the new generation persistent access',async t=>{
  const indexedDB=new IDBFactory();
  await new Promise<void>((resolve,reject)=>{const open=indexedDB.open('bodygraph-chart-days',2);
    open.onupgradeneeded=()=>{open.result.createObjectStore('packets',{keyPath:'key'});open.result.createObjectStore('metadata',{keyPath:'key'});};
    open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('packets','readwrite');
      tx.objectStore('packets').put({key:'private-legacy',bytes:new ArrayBuffer(100)});tx.oncomplete=()=>{db.close();resolve();};};});
  const owner=createCalculationClients({cacheOptions:{indexedDB},natal:{calculationVersion:version,fetch:async()=>response()}});t.after(()=>owner.close());
  const original=IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete=function(...args){if(this.transaction.db.name==='bodygraph-chart-days')throw new Error('Unavailable');return original.apply(this,args);};
  try{assert.equal((await owner.resetPersonal()).status,'pending');await owner.natal.getDay(chart);await tick();}
  finally{IDBObjectStore.prototype.delete=original;}
  assert.equal((await owner.retryPersonalCleanup()).status,'cleared');
  const disk=createCalculationCache({indexedDB});t.after(()=>disk.close());
  assert.equal(await disk.get('natal',key),null);assert.equal(await disk.get('natal','private-legacy'),null);
});

test('caller cancellation remains independent while facade calls share the same underlying calculation',async t=>{
  const reply=deferred(),arrived=deferred();let signal:AbortSignal|undefined,calls=0;
  const owner=createCalculationClients({cacheOptions:{indexedDB:null},natal:{calculationVersion:version,fetch:async(_url,options)=>{
    calls++;signal=options.signal;arrived.resolve!();return reply.promise;}}});t.after(()=>owner.close());
  const cancelled=new AbortController(),first=owner.natal.getDay(chart,{signal:cancelled.signal}),second=owner.natal.getDay(chart);
  const rejected=assert.rejects(first,{name:'AbortError'});await arrived.promise;cancelled.abort();await rejected;
  assert.equal(signal!.aborted,false);reply.resolve!(response());assert.ok(await second);assert.equal(calls,1);
});

test('reset between a ready inner result and facade delivery still rejects the old result',async t=>{
  const owner=createCalculationClients({cacheOptions:{indexedDB:null},natal:{calculationVersion:version,fetch:async()=>response()}});t.after(()=>owner.close());
  await owner.natal.getDay(chart);
  const ready=owner.natal.getDay(chart),rejected=assert.rejects(ready,{name:'AbortError'});
  queueMicrotask(()=>void owner.resetPersonal());await rejected;
  assert.equal(owner.natal.peekDay(chart),null);
});

test('caller abort between a ready inner result and facade delivery still rejects the result',async t=>{
  const owner=createCalculationClients({cacheOptions:{indexedDB:null},natal:{calculationVersion:version,fetch:async()=>response()}});t.after(()=>owner.close());
  await owner.natal.getDay(chart);const controller=new AbortController();
  const ready=owner.natal.getDay(chart,{signal:controller.signal}),rejected=assert.rejects(ready,{name:'AbortError'});
  queueMicrotask(()=>controller.abort());await rejected;
  assert.ok(owner.natal.peekDay(chart),'consumer cancellation does not delete reusable data');
});

test('successive resets cannot activate a stale personal generation',async t=>{
  const indexedDB=new IDBFactory(),owner=createCalculationClients({cacheOptions:{indexedDB},
    natal:{calculationVersion:version,fetch:async()=>response()}});t.after(()=>owner.close());
  await owner.status();const first=owner.resetPersonal(),second=owner.resetPersonal();
  const [a,b]=await Promise.all([first,second]);assert.ok(b.generation>a.generation);assert.equal(b.status,'cleared');
  await owner.natal.getDay(chart);await tick();
  const disk=createCalculationCache({indexedDB});t.after(()=>disk.close());
  assert.ok(await disk.get('natal',key));
});

test('version and window snapshots stay explicit and cannot be mutated through status',async t=>{
  const indexedDB=new IDBFactory(),owner=createCalculationClients({cacheOptions:{indexedDB},natal:{calculationVersion:version}});t.after(()=>owner.close());
  assert.deepEqual((await owner.status()).versions,{});
  await owner.confirmVersions({natal:version});
  const window={version,dates:['2026-10-26'],expiresAt:Date.now()+86400000};await owner.setTransitWindow(window);
  const state=await owner.status();state.versions.natal='b'.repeat(64);state.window.dates.push('2026-10-27');
  const unchanged=await owner.status();assert.equal(unchanged.versions.natal,version);assert.deepEqual(unchanged.window.dates,['2026-10-26']);
});

test('retry before any reset is a no-op and preserves existing private RAM and disk',async t=>{
  const indexedDB=new IDBFactory(),owner=createCalculationClients({cacheOptions:{indexedDB},natal:{calculationVersion:version,fetch:async()=>response()}});t.after(()=>owner.close());
  const value=await owner.natal.getDay(chart);await tick();const before=await owner.status();
  const disk=createCalculationCache({indexedDB});t.after(()=>disk.close());assert.ok(await disk.get('natal',key));
  assert.equal(await owner.retryPersonalCleanup(),null);
  assert.equal(owner.natal.peekDay(chart),value);assert.equal((await owner.status()).personalEpoch,before.personalEpoch);
  assert.ok(await disk.get('natal',key));
});


test('shared calculation owner preserves the personal chart scope for return dates', async t => {
  const requests:{url:string;body:unknown}[]=[];
  const owner=createCalculationClients({cacheOptions:{indexedDB:new IDBFactory()},
    cycles:{cacheVersion:version,request:async(url,options)=>{requests.push({url,body:JSON.parse(String(options.body))});return cycleResult();}}});
  t.after(()=>owner.close());
  await owner.cycles.events(cycleInput,undefined,{owner:{chartId:'123',expectedAccountId:'7'}});
  assert.deepEqual(requests,[{url:'/api/charts/123/returns/events',body:{...cycleInput,timezone:'UTC',expectedAccountId:'7'}}]);
});

test('promoting a fresh generation to IDB keeps its active RAM-only return calculation alive',async t=>{
  const indexedDB=new IDBFactory(),reply=deferred(),arrived=deferred();let signal:AbortSignal|undefined;
  const owner=createCalculationClients({cacheOptions:{indexedDB},cycles:{cacheVersion:version,
    request:async(_url,options)=>{signal=options.signal!;arrived.resolve!();return reply.promise;}}});t.after(()=>owner.close());
  await owner.status();const cleanup=owner.resetPersonal();
  const calculating=owner.cycles.events(cycleInput);const observed=calculating.then(value=>({value}),error=>({error}));
  await arrived.promise;assert.equal(signal!.aborted,false);
  assert.equal((await cleanup).status,'cleared');
  reply.resolve!(cycleResult());const outcome=await observed;
  assert.equal('error' in outcome,false,'cleanup promotion must not revoke the new generation');
  assert.equal(signal!.aborted,false);
  assert.ok('value' in outcome);assert.deepEqual(outcome.value,cycleResult());
  const disk=createCalculationCache({indexedDB});t.after(()=>disk.close());
  assert.deepEqual(await disk.catalogue('return-events'),[],'an existing RAM-only calculation never switches persistence');
  assert.equal(await owner.cycles.events(cycleInput),outcome.value,'its result is reusable by the current client');
});

test('an attachment from the retired RAM port survives promotion but is cancelled by the next actual logout',async t=>{
  const indexedDB=new IDBFactory(),arrived=deferred();let signal:AbortSignal|undefined,accepts=0;
  const ready={...cycleResult(),proof:'v1.'+version+'.'+'b'.repeat(43)};
  const owner=createCalculationClients({cacheOptions:{indexedDB},cycles:{cacheVersion:version,request:async(url,options)=>{
    if(!url.endsWith('/accept'))return ready;
    accepts++;signal=options.signal!;arrived.resolve!();
    return new Promise((_,reject)=>signal!.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true}));
  }}});t.after(()=>owner.close());await owner.status();
  const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args){if(this.transaction.db.name==='forma-calculation-cache' && this.name==='control')throw new Error('Unavailable');return original.apply(this,args);};
  try{assert.equal((await owner.resetPersonal()).status,'unavailable');}finally{IDBObjectStore.prototype.put=original;}
  await owner.cycles.events(cycleInput);
  await owner.cycles.events(cycleInput,undefined,{owner:{chartId:'123',expectedAccountId:'7'}});
  await arrived.promise;
  const promoted=await owner.retryPersonalCleanup();assert.ok(promoted);assert.equal(promoted.status,'cleared');
  assert.equal(signal!.aborted,false,'changing storage availability is not logout');
  const cleanup=owner.resetPersonal();assert.equal(signal!.aborted,true,'logout must revoke retired transports as well');
  await cleanup;await tick();assert.equal(accepts,1,'there is no automatic attachment retry');
});

test('cache-only return readiness uses the current personal generation and never starts a calculation',async t=>{
 const indexedDB=new IDBFactory();let requests=0;
 const owner=createCalculationClients({cacheOptions:{indexedDB},cycles:{cacheVersion:version,request:async()=>{requests++;return cycleResult();}}});
 t.after(()=>owner.close());
 assert.equal(await owner.cycles.readEvents(cycleInput),null);assert.equal(requests,0);
 await owner.cycles.events(cycleInput);assert.deepEqual((await owner.cycles.readEvents(cycleInput))?.events,[]);
 await owner.resetPersonal();assert.equal(await owner.cycles.readEvents(cycleInput),null);assert.equal(requests,1);
});
