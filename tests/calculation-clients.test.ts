import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createCalculationClients } from '../src/data/calculation-clients.ts';
import { createCalculationCache } from '../src/data/calculation-cache.ts';
import { createMemoryCache, TAB_CACHE_BYTES } from '../src/data/memory-cache.ts';
import { encodeNatalDay, encodeTransitDay } from '../server/packets/encode.ts';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.ts';
import { deferred } from './helpers/deferred.ts';
import {accountNatalChart} from './helpers/account-chart.ts';
import {natalDaySourceKey,returnSourceKey,type PackageRef} from '../shared/library-package-contract.ts';

const chart=personalChartFixture(),tick=()=>new Promise(setImmediate);
const key=`natal-day:1:${chart.birthDate}:${chart.cityId}`;
const bytes=()=>encodeNatalDay(natalDayFixture()).buffer;
const response=()=>({ok:true,arrayBuffer:async()=>bytes()});
const cycleInput={birthUtc:'2000-01-01T00:00:00Z',body:'saturn',fromAge:0,toAge:100};
const cycleResult=()=>({range:{fromAge:0,toAge:100},events:[]});

test('shared calculation clients preserve observation-only package reads without storage repair',async t=>{
 const indexedDB=new IDBFactory(),saved=accountNatalChart();
 const clients=createCalculationClients({cacheOptions:{indexedDB},natal:{fetch:async()=>assert.fail('observation never requests HTTP')},cycles:{request:async()=>assert.fail('observation never requests HTTP')}});
 t.after(()=>clients.close());const active=await clients.library.activate(saved.accountId);
 if(active.status!=='stored')throw Error('owner');await clients.library.put(active.lease,[saved]);
 const refs:Exclude<PackageRef,{kind:'card'}>[]=[
  {kind:'day',sourceKey:natalDaySourceKey({date:saved.birthDate,timezone:saved.timezone!})},
  {kind:'major-returns',sourceKey:returnSourceKey({birthUtc:saved.utc,timezone:saved.timezone!}),family:'saturn'},
 ];
 const open=indexedDB.open('forma-account-library'),db=await new Promise<IDBDatabase>(resolve=>{open.onsuccess=()=>resolve(open.result);});t.after(()=>db.close());
 await new Promise<void>((resolve,reject)=>{const tx=db.transaction('packages','readwrite');for(const ref of refs)tx.objectStore('packages').put({id:JSON.stringify(ref),payload:{broken:true}});tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});
 const writes:string[]=[],put=IDBObjectStore.prototype.put,remove=IDBObjectStore.prototype.delete;
 t.mock.method(IDBObjectStore.prototype,'put',function(this:IDBObjectStore,...args:Parameters<typeof put>){writes.push(this.name);return put.apply(this,args);});
 t.mock.method(IDBObjectStore.prototype,'delete',function(this:IDBObjectStore,...args:Parameters<typeof remove>){writes.push(this.name);return remove.apply(this,args);});
 assert.equal(await clients.natal.readStoredDay(saved,{observeOnly:true,opened:true}),null);
 assert.equal(await clients.cycles.readFamily({birthUtc:saved.utc,timezone:saved.timezone,body:'saturn'},
  {chartId:saved.id,expectedAccountId:saved.accountId,record:saved},{observeOnly:true,opened:true}),null);
 assert.deepEqual(writes,[],'availability checks cannot delete broken packages, migrate legacy parts or record use');
});

test('one early owner shares RAM and IDB while personal reset preserves transit and its retention',async t=>{
  const indexedDB=new IDBFactory(),memory=createMemoryCache({maxBytes:400_000});let natalCalls=0;
  const owner=createCalculationClients({cacheOptions:{indexedDB},memory,
    natal:{fetch:async()=>{natalCalls++;return response();}},
    cycles:{request:async()=>cycleResult()}});t.after(()=>owner.close());
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
    natal:{fetch:async(_url,{signal})=>{signals.push(signal);if(++calls===2)arrived.resolve!();return natalReply.promise;}},
    cycles:{request:async(_url,{signal})=>{signals.push(signal!);if(++calls===2)arrived.resolve!();return cycleReply.promise;}}});t.after(()=>owner.close());
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
  const owner=createCalculationClients({cacheOptions:{indexedDB},memory:createMemoryCache({maxBytes:400_000}),natal:{fetch:async()=>{
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
  const owner=createCalculationClients({cacheOptions:{indexedDB},natal:{fetch:async()=>response()}});t.after(()=>owner.close());
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
  const owner=createCalculationClients({cacheOptions:{indexedDB:null},natal:{fetch:async(_url,options)=>{
    calls++;signal=options.signal;arrived.resolve!();return reply.promise;}}});t.after(()=>owner.close());
  const cancelled=new AbortController(),first=owner.natal.getDay(chart,{signal:cancelled.signal}),second=owner.natal.getDay(chart);
  const rejected=assert.rejects(first,{name:'AbortError'});await arrived.promise;cancelled.abort();await rejected;
  assert.equal(signal!.aborted,false);reply.resolve!(response());assert.ok(await second);assert.equal(calls,1);
});

test('reset between a ready inner result and facade delivery still rejects the old result',async t=>{
  const owner=createCalculationClients({cacheOptions:{indexedDB:null},natal:{fetch:async()=>response()}});t.after(()=>owner.close());
  await owner.natal.getDay(chart);
  const ready=owner.natal.getDay(chart),rejected=assert.rejects(ready,{name:'AbortError'});
  queueMicrotask(()=>void owner.resetPersonal());await rejected;
  assert.equal(owner.natal.peekDay(chart),null);
});

test('caller abort between a ready inner result and facade delivery still rejects the result',async t=>{
  const owner=createCalculationClients({cacheOptions:{indexedDB:null},natal:{fetch:async()=>response()}});t.after(()=>owner.close());
  await owner.natal.getDay(chart);const controller=new AbortController();
  const ready=owner.natal.getDay(chart,{signal:controller.signal}),rejected=assert.rejects(ready,{name:'AbortError'});
  queueMicrotask(()=>controller.abort());await rejected;
  assert.ok(owner.natal.peekDay(chart),'consumer cancellation does not delete reusable data');
});

test('successive resets cannot activate a stale personal generation',async t=>{
  const indexedDB=new IDBFactory(),owner=createCalculationClients({cacheOptions:{indexedDB},
    natal:{fetch:async()=>response()}});t.after(()=>owner.close());
  await owner.status();const first=owner.resetPersonal(),second=owner.resetPersonal();
  const [a,b]=await Promise.all([first,second]);assert.ok(b.generation>a.generation);assert.equal(b.status,'cleared');
  await owner.natal.getDay(chart);await tick();
  const disk=createCalculationCache({indexedDB});t.after(()=>disk.close());
  assert.ok(await disk.get('natal',key));
});

test('transit window snapshots stay explicit and cannot be mutated through status',async t=>{
  const indexedDB=new IDBFactory(),owner=createCalculationClients({cacheOptions:{indexedDB}});t.after(()=>owner.close());
  const window={dates:['2026-10-26'],expiresAt:Date.now()+86400000};await owner.syncTransitWindow(window);
  const state=await owner.status();assert.ok('window' in state && state.window);Reflect.set(state.window.dates,1,'2026-10-27');
  const after=await owner.status();assert.ok('window' in after && after.window);assert.deepEqual(after.window.dates,['2026-10-26']);
});

test('retry before any reset is a no-op and preserves existing private RAM and disk',async t=>{
  const indexedDB=new IDBFactory(),owner=createCalculationClients({cacheOptions:{indexedDB},natal:{fetch:async()=>response()}});t.after(()=>owner.close());
  const value=await owner.natal.getDay(chart);await tick();const before=await owner.status();
  const disk=createCalculationCache({indexedDB});t.after(()=>disk.close());assert.ok(await disk.get('natal',key));
  assert.equal(await owner.retryPersonalCleanup(),null);
  assert.equal(owner.natal.peekDay(chart),value);const after=await owner.status();assert.ok('personalEpoch' in before && 'personalEpoch' in after);assert.equal(after.personalEpoch,before.personalEpoch);
  assert.ok(await disk.get('natal',key));
});


test('shared calculation owner preserves the personal chart scope for return dates', async t => {
  const requests:{url:string;body:unknown}[]=[];
  const owner=createCalculationClients({cacheOptions:{indexedDB:new IDBFactory()},
    cycles:{request:async(url,options)=>{requests.push({url,body:JSON.parse(String(options.body))});return cycleResult();}}});
  t.after(()=>owner.close());
  await owner.cycles.events(cycleInput,undefined,{owner:{chartId:'123',expectedAccountId:'7'}});
  assert.deepEqual(requests,[{url:'/api/charts/123/returns/events',body:{...cycleInput,timezone:'UTC',expectedAccountId:'7'}}]);
});

test('promoting a fresh generation to IDB keeps its active RAM-only return calculation alive',async t=>{
  const indexedDB=new IDBFactory(),reply=deferred(),arrived=deferred();let signal:AbortSignal|undefined;
  const owner=createCalculationClients({cacheOptions:{indexedDB},cycles:{request:async(_url,options)=>{signal=options.signal!;arrived.resolve!();return reply.promise;}}});t.after(()=>owner.close());
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
  const ready={...cycleResult(),proof:'v1.'+'b'.repeat(43)};
  const owner=createCalculationClients({cacheOptions:{indexedDB},cycles:{request:async(url,options)=>{
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
 const owner=createCalculationClients({cacheOptions:{indexedDB},cycles:{request:async()=>{requests++;return cycleResult();}}});
 t.after(()=>owner.close());
 assert.equal(await owner.cycles.readEvents(cycleInput),null);assert.equal(requests,0);
 await owner.cycles.events(cycleInput);assert.deepEqual((await owner.cycles.readEvents(cycleInput))?.events,[]);
 await owner.resetPersonal();assert.equal(await owner.cycles.readEvents(cycleInput),null);assert.equal(requests,1);
});

test('prepared chart enumeration follows the revocable personal generation without retaining cleared identities',async t=>{
 const owner=createCalculationClients({cacheOptions:{indexedDB:new IDBFactory(),legacySources:[]},cycles:{}});t.after(()=>owner.close());
 const input={birthUtc:cycleInput.birthUtc,body:'saturn',eventUtc:'2028-07-21T12:36:05Z',timezone:'UTC'};
 owner.memory.put(`return-chart:${JSON.stringify(['chart',input.birthUtc,input.body,input.eventUtc,input.timezone])}`,{});
 assert.deepEqual(await owner.cycles.preparedChartInputs(input),[input]);
 const pending=owner.cycles.preparedChartInputs(input),rejected=assert.rejects(pending,{name:'AbortError'});
 await owner.resetPersonal();await rejected;
 assert.deepEqual(await owner.cycles.preparedChartInputs(input),[]);
 await owner.close();await assert.rejects(owner.cycles.preparedChartInputs(input),{name:'AbortError'});
});


function transitFixture(t:test.TestContext) {
  const indexedDB=new IDBFactory(),now=Date.parse('2026-10-26T12:00:00Z');let calls=0;
  const owner=createCalculationClients({cacheOptions:{indexedDB,now:()=>now},transit:{fetch:async url=>{
    calls++;const date=new URL(url,'http://test').searchParams.get('date')!;
    return {ok:true,json:async()=>assert.fail('no JSON on a successful binary packet'),arrayBuffer:async()=>encodeTransitDay(natalDayFixture({date})).buffer};
  }}});
  const disk=createCalculationCache({indexedDB,now:()=>now});t.after(async()=>{disk.close();await owner.close();});
  return {owner,disk,window:{dates:['2026-10-26'],expiresAt:now+86400000},calls:()=>calls};
}

test('local transit synchronization admits an early packet without a version request',async t=>{
  const h=transitFixture(t),date=h.window.dates[0],hot=await h.owner.transit.getDay(date);
  await h.owner.transit.days.flush();assert.equal(await h.disk.get('transit',date),null);
  assert.equal((await h.owner.syncTransitWindow(h.window)).status,'applied');
  assert.ok(await h.disk.get('transit',date));assert.equal(h.owner.transit.peekDay(date),hot);
  assert.equal(h.calls(),1,'only the missing packet uses transport');
  assert.equal(Object.hasOwn(await h.owner.status(),'versions'),false);
});

test('unchanged transit windows skip payload rewrites but re-admit an evicted hot day once',async t=>{
  const h=transitFixture(t),date=h.window.dates[0];await h.owner.transit.getDay(date);
  await h.owner.syncTransitWindow(h.window);await tick();
  const put=IDBObjectStore.prototype.put;let payloadWrites=0;
  t.mock.method(IDBObjectStore.prototype,'put',function(this:IDBObjectStore,...args:Parameters<typeof put>){
    if(this.name==='payloads')payloadWrites++;return put.apply(this,args);
  });
  for(let i=0;i<10;i++)assert.equal((await h.owner.syncTransitWindow(h.window)).status,'applied');
  assert.equal(payloadWrites,0);
  await h.disk.remove('transit',date);
  assert.equal((await h.owner.syncTransitWindow(h.window)).status,'applied');
  assert.equal(payloadWrites,1);assert.ok(await h.disk.get('transit',date));assert.equal(h.calls(),1);
});

test('a new transit window queued during a write uses the committed snapshot and wins last',async t=>{
  const h=transitFixture(t),changed={dates:['2026-10-25','2026-10-26'],expiresAt:h.window.expiresAt-3600000};
  const put=IDBObjectStore.prototype.put;let next:ReturnType<typeof h.owner.syncTransitWindow>|undefined;
  t.mock.method(IDBObjectStore.prototype,'put',function(this:IDBObjectStore,...args:Parameters<typeof put>){
    if(this.name==='control' && args[0].key==='budget' && args[0].window && !next)next=h.owner.syncTransitWindow(changed);
    return put.apply(this,args);
  });
  assert.equal((await h.owner.syncTransitWindow(h.window)).status,'stale');
  assert.ok(next);assert.equal((await next).status,'applied');
  const after=await h.owner.status();assert.ok('window' in after && after.window);assert.deepEqual(after.window.dates,changed.dates);assert.equal(h.calls(),0);
});

test('superseded and closed transit window work cannot commit later',async t=>{
  const h=transitFixture(t),changed={dates:['2026-10-25'],expiresAt:h.window.expiresAt};
  const first=h.owner.syncTransitWindow(h.window),latest=h.owner.syncTransitWindow(changed);
  changed.dates[0]='2026-10-24';
  assert.equal((await first).status,'stale');assert.equal((await latest).status,'applied');
  const after=await h.owner.status();assert.ok('window' in after && after.window);assert.deepEqual(after.window.dates,['2026-10-25'],'caller mutation cannot replace the queued window');
  const pending=h.owner.syncTransitWindow(h.window);await h.owner.close();
  assert.equal((await pending).status,'cancelled');assert.equal(h.calls(),0);
});

test('today transit window belongs to the client owner and skips repeated UI updates',async t=>{
 const now=Date.parse('2026-10-26T12:00:00Z'),indexedDB=new IDBFactory();let observations=0;
 const owner=createCalculationClients({cacheOptions:{indexedDB,now:()=>now},observe:()=>{observations++;return undefined;}});t.after(()=>owner.close());
 await owner.status();
 const put=IDBObjectStore.prototype.put;let unavailable=true;
 t.mock.method(IDBObjectStore.prototype,'put',function(this:IDBObjectStore,...args:Parameters<typeof put>){
  if(unavailable && this.name==='control' && args[0].key==='budget' && args[0].window)
   throw new DOMException('temporary storage failure','UnknownError');
  return put.apply(this,args);
 });
 assert.equal((await owner.syncTodayTransitWindow('Europe/Moscow',now))?.status,'unavailable');
 unavailable=false;
 const retry=owner.syncTodayTransitWindow('Europe/Moscow',now);
 assert.ok(retry,'a failed attempt cannot suppress the next ordinary call');
 assert.equal(owner.syncTodayTransitWindow('Europe/Moscow',now),retry,'concurrent calls share the actual attempt');
 assert.equal((await retry)?.status,'applied');const before=observations;
 for(let i=0;i<100;i++)assert.equal(owner.syncTodayTransitWindow('Europe/Moscow',now+i),undefined);
 assert.equal(observations,before);const snapshot=await owner.status();
 assert.ok('window' in snapshot);assert.deepEqual(snapshot.window?.dates,['2026-10-25','2026-10-26']);
 await owner.syncTodayTransitWindow('Europe/Moscow',now,true);assert.equal(observations,before+1);
 await owner.syncTodayTransitWindow('Europe/Moscow',now+86400000);assert.equal(observations,before+2);
 await owner.close();assert.equal(owner.syncTodayTransitWindow('UTC',now),undefined);
});
