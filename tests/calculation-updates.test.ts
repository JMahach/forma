import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createCalculationUpdates } from '../src/data/calculation-updates.ts';
import { createCalculationClients } from '../src/data/calculation-clients.ts';
import { createCalculationCache } from '../src/data/calculation-cache.ts';
import { configureTransportSimulation } from '../src/data/http-transport.ts';
import { createLocalDayTimeline } from '../src/domain/day-timeline.ts';
import { encodeTransitDay } from '../server/packets/encode.ts';
import { natalDayFixture } from './fixtures/natal-day.ts';
import { deferred } from './helpers/deferred.ts';

const expected={calculationVersion:'a'.repeat(64),cyclesVersion:'b'.repeat(64)};
const newer={calculationVersion:'c'.repeat(64),cyclesVersion:'d'.repeat(64)};
const initialNow=Date.parse('2026-10-26T12:00:00Z');
function fixture(t:test.TestContext) {
  const indexedDB=new IDBFactory();let now=initialNow;
  const clients=createCalculationClients({cacheOptions:{indexedDB,now:()=>now},
    transit:{calculationVersion:expected.calculationVersion,fetch:async url=>{
      const date=new URL(url,'http://test').searchParams.get('date')!;
      return {ok:true,arrayBuffer:async()=>encodeTransitDay({...natalDayFixture({date}),calculationVersion:expected.calculationVersion}).buffer};
    }},natal:{calculationVersion:expected.calculationVersion},cycles:{cacheVersion:expected.cyclesVersion}});
  const disk=createCalculationCache({indexedDB,now:()=>now});t.after(async()=>{disk.close();await clients.close();});
  return {clients,disk,timeline:createLocalDayTimeline(now,'UTC'),setNow(value:number){now=value;}};
}

test('only explicit refresh requests versions and admits hot pre-window days through the existing cache',async t=>{
  const h=fixture(t),calls:{url:string;options:RequestInit}[]=[];
  const hot=await h.clients.transit.getDay(h.timeline.packetDates[0]);await h.clients.transit.days.flush();
  assert.equal(await h.disk.get('transit',`${expected.calculationVersion}:${hot.date}`),null);
  const updates=createCalculationUpdates({clients:h.clients,expected,timeline:h.timeline,request:async(url,options)=>{calls.push({url,options});return expected;}});t.after(()=>updates.close());
  assert.equal((await updates.syncWindow()).status,'unconfirmed');assert.equal(calls.length,0);
  const result=await updates.refresh();assert.equal(result.status,'confirmed');assert.equal(result.window.status,'applied');
  assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/versions');assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.cache,'no-store');
  assert.deepEqual((await h.clients.status()).versions,{natal:expected.calculationVersion,returns:expected.cyclesVersion});
  assert.ok(await h.disk.get('transit',`${expected.calculationVersion}:${hot.date}`));
  assert.equal(h.clients.transit.peekDay(hot.date),hot);
});

test('an incompatible response never confirms a new hash or presents old clients as updated',async t=>{
  const h=fixture(t),updates=createCalculationUpdates({clients:h.clients,expected,timeline:h.timeline,request:async()=>newer});t.after(()=>updates.close());
  const before=await h.clients.status(),result=await updates.refresh();
  assert.equal(result.status,'incompatible');assert.deepEqual(result.versions,newer);
  const after=await h.clients.status();assert.deepEqual(after.versions,before.versions);assert.equal(after.window,null);
  assert.equal((await updates.syncWindow()).status,'unconfirmed');
});

test('invalid and unavailable responses leave cache control unchanged and never schedule another request',async t=>{
  for(const payload of [null,[],{...expected,cyclesVersion:'wrong'},undefined]){
    const h=fixture(t);let calls=0;
    const updates=createCalculationUpdates({clients:h.clients,expected,timeline:h.timeline,request:async()=>{calls++;if(payload===undefined)throw new TypeError('Offline');return payload;}});t.after(()=>updates.close());
    assert.equal((await updates.refresh()).status,payload===undefined?'unavailable':'invalid');
    await new Promise(setImmediate);assert.equal(calls,1);assert.deepEqual((await h.clients.status()).versions,{});
  }
});

test('the version CAS uses the snapshot taken before HTTP and rejects a late older response',async t=>{
  const h=fixture(t),reply=deferred(),arrived=deferred();
  await h.clients.confirmVersions({natal:expected.calculationVersion,returns:expected.cyclesVersion});
  const updates=createCalculationUpdates({clients:h.clients,expected,timeline:h.timeline,request:async()=>{arrived.resolve!();return reply.promise;}});t.after(()=>updates.close());
  const refreshing=updates.refresh();await arrived.promise;
  await h.disk.confirmVersions({natal:newer.calculationVersion,returns:newer.cyclesVersion},{previous:{natal:expected.calculationVersion,returns:expected.cyclesVersion}});
  reply.resolve!(expected);assert.equal((await refreshing).status,'stale');
  assert.deepEqual((await h.clients.status()).versions,{natal:newer.calculationVersion,returns:newer.cyclesVersion});
  assert.equal((await h.clients.status()).window,null);
});

test('the pre-request window CAS cannot overwrite a different window committed by another tab',async t=>{
  const h=fixture(t),reply=deferred(),arrived=deferred();
  const initial=await h.clients.setTransitWindow({version:expected.calculationVersion,dates:h.timeline.packetDates,expiresAt:h.timeline.endUtc});
  const updates=createCalculationUpdates({clients:h.clients,expected,timeline:h.timeline,request:async()=>{arrived.resolve!();return reply.promise;}});t.after(()=>updates.close());
  const refreshing=updates.refresh();await arrived.promise;
  const other=createLocalDayTimeline(initialNow,'Europe/Moscow');
  await h.disk.setTransitWindow({version:expected.calculationVersion,dates:other.packetDates,expiresAt:other.endUtc},{expectedRevision:initial.revision});
  reply.resolve!(expected);const result=await refreshing;assert.equal(result.window.status,'stale');
  assert.deepEqual((await h.clients.status()).window.dates,other.packetDates);
});

test('a changed timeline is read at response time; later local-day changes need no HTTP',async t=>{
  const h=fixture(t),reply=deferred(),arrived=deferred();let calls=0;
  const updates=createCalculationUpdates({clients:h.clients,expected,timeline:h.timeline,request:async()=>{calls++;arrived.resolve!();return reply.promise;}});t.after(()=>updates.close());
  const refreshing=updates.refresh();await arrived.promise;
  const changed=createLocalDayTimeline(initialNow,'America/New_York');
  assert.equal((await updates.onTimelineChanged(changed)).status,'unconfirmed');
  reply.resolve!(expected);assert.equal((await refreshing).window.status,'applied');
  assert.deepEqual((await h.clients.status()).window.dates,changed.packetDates);
  h.setNow(initialNow+86400000);const next=createLocalDayTimeline(initialNow+86400000,'America/New_York');
  assert.equal((await updates.onTimelineChanged(next)).status,'applied');assert.equal(calls,1);
  assert.deepEqual((await h.clients.status()).window.dates,next.packetDates);
});

test('a timeline change during a window write is applied after that write using a fresh window snapshot',async t=>{
  const h=fixture(t),gate=deferred(),writing=deferred();let writes=0;
  const clients={...h.clients,setTransitWindow:async(...args:Parameters<typeof h.clients.setTransitWindow>)=>{
    if(++writes===1){writing.resolve!();await gate.promise;}return h.clients.setTransitWindow(...args);
  }};
  const updates=createCalculationUpdates({clients,expected,timeline:h.timeline,request:async()=>expected});t.after(()=>updates.close());
  const refreshing=updates.refresh();await writing.promise;
  const changed=createLocalDayTimeline(initialNow,'Europe/Moscow'),syncing=updates.onTimelineChanged(changed);
  gate.resolve!();await refreshing;assert.equal((await syncing).status,'applied');
  assert.deepEqual((await h.clients.status()).window.dates,changed.packetDates);
});

test('superseding refresh, cancellation, close and deadline discard late responses without retries',async t=>{
  const h=fixture(t),first=deferred(),arrived=deferred();let calls=0;
  const updates=createCalculationUpdates({clients:h.clients,expected,timeline:h.timeline,timeoutMs:10,request:async()=>{
    if(++calls===1){arrived.resolve!();return first.promise;}return expected;
  }});t.after(()=>updates.close());
  const old=updates.refresh();await arrived.promise;assert.equal((await updates.refresh()).status,'confirmed');
  assert.equal((await old).status,'cancelled');first.resolve!(newer);await new Promise(setImmediate);assert.equal(calls,2);
  const stalled=createCalculationUpdates({clients:h.clients,expected,timeoutMs:5,request:()=>new Promise(()=>{})});t.after(()=>stalled.close());
  assert.equal((await stalled.refresh()).status,'unavailable');
  const controller=new AbortController(),cancelled=stalled.refresh({signal:controller.signal});controller.abort();
  assert.equal((await cancelled).status,'cancelled');
  const closing=stalled.refresh();stalled.close();assert.equal((await closing).status,'cancelled');
});

test('a new global numerical version prevents an old offline coordinator from extending its window',async t=>{
  const h=fixture(t),updates=createCalculationUpdates({clients:h.clients,expected,timeline:h.timeline,request:async()=>expected});t.after(()=>updates.close());
  await updates.refresh();const before=(await h.clients.status()).window;
  await h.disk.confirmVersions({natal:newer.calculationVersion,returns:newer.cyclesVersion},{previous:{natal:expected.calculationVersion,returns:expected.cyclesVersion}});
  assert.equal((await updates.onTimelineChanged(createLocalDayTimeline(initialNow,'Europe/Moscow'))).status,'incompatible');
  assert.deepEqual((await h.clients.status()).window,before);
});

test('default refresh uses the shared transport gate without bypassing an offline stand',async t=>{
  const h=fixture(t);let calls=0;
  const connection={current:'offline' as 'offline'|'online',subscribe(){return ()=>{};}};
  configureTransportSimulation(connection,async()=>{calls++;return Response.json(expected);});t.after(()=>configureTransportSimulation(null));
  const updates=createCalculationUpdates({clients:h.clients,expected,timeline:h.timeline});t.after(()=>updates.close());
  assert.equal((await updates.refresh()).status,'unavailable');assert.equal(calls,0);
  connection.current='online';assert.equal((await updates.refresh()).status,'confirmed');assert.equal(calls,1);
});

test('a local window write cannot extend an old version when versions changed after its snapshot',async t=>{
  const h=fixture(t),gate=deferred(),writing=deferred();let hold=false;
  const clients={...h.clients,setTransitWindow:async(...args:Parameters<typeof h.clients.setTransitWindow>)=>{
    if(hold){writing.resolve!();await gate.promise;}return h.clients.setTransitWindow(...args);
  }};
  const updates=createCalculationUpdates({clients,expected,timeline:h.timeline,request:async()=>expected});t.after(()=>updates.close());
  await updates.refresh();const before=(await h.clients.status()).window;hold=true;
  const syncing=updates.onTimelineChanged(createLocalDayTimeline(initialNow,'Europe/Moscow'));await writing.promise;
  await h.disk.confirmVersions({natal:newer.calculationVersion,returns:newer.cyclesVersion},{previous:{natal:expected.calculationVersion,returns:expected.cyclesVersion}});
  gate.resolve!();assert.equal((await syncing).status,'stale');
  assert.deepEqual((await h.clients.status()).window,before);
});
