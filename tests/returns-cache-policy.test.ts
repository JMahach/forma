import type { SavedReturnView } from '../src/data/view-store.ts';
import type { ChartInput } from '../src/domain/chart-composition.ts';
import { deferred } from './helpers/deferred.ts';
import type { CycleEvent, CycleEventsResult, CycleChartResult } from '../shared/cycles-format.ts';
import type { TestCyclesOptions, TestReturnsOptions } from './fixtures/returns.ts';
import type {LegacyReturnStorage as ReturnStorage} from './fixtures/returns.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createCyclesClient } from './fixtures/returns.ts';
import { createReturnStorage } from '../src/data/return-storage.ts';
import {createAccountLibraryStore} from '../src/data/account-library-store.ts';
import { createMemoryCache, estimateBytes } from '../src/data/memory-cache.ts';
import { createReturnsController } from './fixtures/returns.ts';
import { CYCLE_BODIES, DEFAULT_CYCLE_BODIES } from '../src/domain/cycles.ts';
import { libraryRecordAtMinute } from './fixtures/natal-day.ts';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.ts';
import type { CycleInput } from '../shared/cycles-format.ts';

const revision = 'a'.repeat(64), tick = () => new Promise(setImmediate);
const input = { birthUtc: '2000-01-01T00:00:00Z', body: 'moon', fromAge: 0, toAge: 100 };
const packet = (value: CycleInput) => ({ range: { fromAge: value.fromAge ?? 0, toAge: value.toAge ?? 100 }, events: [] });
const natal = () => libraryRecordAtMinute(natalDayFixture({ date: '2000-01-01' }), 0, personalChartFixture({ id: 'saved-natal' }));
// These doubles preserve raw reads and absent write receipts. The client validates
// stored data and ignores receipts; only the fixture-to-port boundary is narrowed.
type StorageDouble = Partial<{
  [K in 'getEvents' | 'putEvents' | 'removeEvents' | 'getChart' | 'putChart' | 'removeChart']:
    (...args: Parameters<ReturnStorage[K]>) => Promise<unknown>;
}>;
function storageDouble<T extends StorageDouble>(value: T) {
  return value as unknown as Omit<T, keyof ReturnStorage> & Partial<ReturnStorage>;
}

function device() {
  const records = new Map<string, unknown>(), reads: string[] = [], writes: string[] = [];
  return storageDouble({ records, reads, writes,
    async getEvents(key: string) { reads.push(JSON.parse(key)[2]); return records.get(key); },
    async putEvents(key: string, value: CycleInput, data: CycleEventsResult) { writes.push(value.body); records.set(key, data); },
    async getChart(key: string) { return records.get(key); }, async putChart(key: string, data: unknown) { records.set(key, data); },
  });
}

test('all standalone body dates reuse RAM without persistent writes', async () => {
  const storage = device(), calls: string[] = [];
  const options: TestCyclesOptions = { returnStorage: storage, request: async (_url, { body }) => {
    const value = JSON.parse(body as string); calls.push(value.body); return packet(value);
  } };
  const first = createCyclesClient(options);
  for (const { id: body } of CYCLE_BODIES) {
    const value = { ...input, body }, ready = await first.events(value);
    assert.equal(await first.events({ ...value, timezone: 'Europe/Moscow' }), ready);
  }
  await tick();
  assert.equal(calls.length, 13);
  assert.deepEqual(new Set(storage.reads), new Set(DEFAULT_CYCLE_BODIES));
  assert.deepEqual(storage.writes, []);
  assert.equal(storage.records.size, 0);
  const reload = createCyclesClient(options);
  for (const { id: body } of CYCLE_BODIES) await reload.events({ ...input, body });
  assert.equal(calls.length, 13 + CYCLE_BODIES.length);
});

test('extra body dates share the byte LRU across clients and lose reuse only after eviction', async () => {
  const ready = packet(input), size = estimateBytes(ready), memory = createMemoryCache({ maxBytes: size * 2 });
  let calls = 0;
  const options: TestCyclesOptions = { memory, returnStorage: device(), request: async () => { calls++; return packet(input); } };
  const first = createCyclesClient(options), second = createCyclesClient(options);
  const moon = await first.events(input), mercuryInput = { ...input, body: 'mercury' };
  await first.events(mercuryInput);
  assert.equal(await second.events(input), moon, 'a second owner reads the same memory result');
  memory.put('transit-day:pressure', new ArrayBuffer(size));
  assert.equal(await second.events(input), moon, 'recently used Moon survives unrelated data pressure');
  await first.events(mercuryInput);
  assert.equal(calls, 3, 'evicted non-default data is searched again, without persistent fallback');
  assert.ok(memory.bytes <= size * 2);
});

test('a pending device miss notices another client that populated common RAM during the read', async () => {
  const disk = deferred<CycleEventsResult | null>(), memory = createMemoryCache(), value = { ...input, body: 'saturn' }; let calls = 0;
  const request = async () => { calls++; return packet(value); };
  const waiting = createCyclesClient({ memory, returnStorage: { getEvents: () => disk.promise }, request });
  const reading = waiting.events(value); await tick();
  const ready = await createCyclesClient({ memory, returnStorage: null, request }).events(value);
  disk.resolve!(null);
  assert.equal(await reading, ready);
  assert.equal(calls, 1);
});

test('all full return charts reuse RAM while only basic bodies survive fresh client memory', async t => {
  const indexedDB = new IDBFactory(), storage = createReturnStorage({ indexedDB }); t.after(() => storage.close());
  const library=createAccountLibraryStore({indexedDB});t.after(()=>library.close());
  let calls = 0;
  const options: TestCyclesOptions = { returnStorage: storage, library, request: async (_url, { body }) => {
    const value = JSON.parse(body as string); calls++;
    return { chart: { ...natal(), utc: value.eventUtc, timezone: value.timezone } };
  } };
  const first = createCyclesClient(options);
  for (const { id: body } of CYCLE_BODIES) {
    const query={birthUtc:input.birthUtc,body,eventUtc:'2030-01-01T00:00:00.123456Z',timezone:'UTC'};
    const ready=await first.chart(query);assert.equal(await first.chart(query),ready);
  }
  assert.equal(calls,CYCLE_BODIES.length);
  const reload = createCyclesClient(options);
  for (const { id: body } of CYCLE_BODIES) {
    await reload.chart({ birthUtc: input.birthUtc, body, eventUtc: '2030-01-01T00:00:00.123456Z', timezone: 'UTC' });
  }
  assert.equal(calls, CYCLE_BODIES.length*2-DEFAULT_CYCLE_BODIES.length);
});

test('migration removes old extra-body dates and charts while preserving basic calculations', async t => {
  const indexedDB = new IDBFactory(),eventUtc='2030-01-01T00:00:00.123456Z';
  const chartKey=(body:string)=>JSON.stringify(['chart',revision,input.birthUtc,body,eventUtc,'UTC']);
  const chart={chart:{...natal(),utc:eventUtc,timezone:'UTC'}};
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('bodygraph-return-events', 2);
    request.onupgradeneeded=()=>{request.result.createObjectStore('events',{keyPath:'key'});request.result.createObjectStore('charts',{keyPath:'key'});};
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['events','charts'], 'readwrite');
    for(const body of ['moon','saturn']) {
      tx.objectStore('events').put({key:`old-${body}`,body,birthUtc:input.birthUtc,...packet(input)});
      tx.objectStore('charts').put({key:chartKey(body),data:chart});
    }
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  db.close();
  const storage=createReturnStorage({indexedDB});t.after(()=>storage.close());
  assert.equal(await storage.getEvents('old-moon'),null);assert.equal(await storage.getChart(chartKey('moon')),null);
  assert.deepEqual(await storage.getEvents('old-saturn'),packet(input));assert.deepEqual(await storage.getChart(JSON.stringify(['chart',input.birthUtc,'saturn',eventUtc,'UTC'])),chart);
  const migrated=await new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open('bodygraph-return-events',3);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  t.after(()=>migrated.close());
  for(const [store,key]of [['events','old-moon'],['charts',chartKey('moon')]])assert.equal(await new Promise(resolve=>{
    const request=migrated.transaction(store).objectStore(store).get(key);request.onsuccess=()=>resolve(request.result);
  }),undefined,'obsolete extra-body payloads are physically removed');
});

test('active body lists are accounted and pinned until their natal changes, not until filters close', async () => {
  const memory = createMemoryCache({ maxBytes: 1 }); let calls = 0;
  const client = createCyclesClient({ memory, request: async (_url, { body }) => { calls++; return packet(JSON.parse(body as string)); } });
  const control = createReturnsController({ client });
  await control.select(natal()); await control.setBodies(CYCLE_BODIES.map(body => body.id));
  assert.equal(memory.size, CYCLE_BODIES.length);
  assert.ok(memory.bytes > 1, 'all active lists remain counted despite being larger than the idle reuse budget');
  control.close(); control.exit(); await control.setBodies([]);
  assert.equal(memory.size, CYCLE_BODIES.length);
  const range = control.state.range;
  await client.events({ ...input, birthUtc: natal().utc, ...range });
  assert.equal(calls, CYCLE_BODIES.length);
  control.select(null);
  assert.equal(memory.size, 0, 'leaving the natal releases every active list so eviction can proceed');
});

test('abandoned date preparation never pins a late result for the replacement natal', async () => {
  const jobs: (ReturnType<typeof deferred<CycleEventsResult>> & { value: CycleInput; signal?: AbortSignal })[] = [], retained: { value: CycleInput; data: CycleEventsResult }[] = [];
  const control = createReturnsController({ client: {
    events(value, signal) { const job = { value, signal, ...deferred<CycleEventsResult>() }; jobs.push(job); return job.promise; },
    retainEvents(value, data) { retained.push({ value, data }); return () => {}; },
  } });
  control.select(natal()); await tick(); control.select(null);
  jobs.forEach(job => job.resolve(packet(job.value))); await tick();
  assert.equal(retained.length, 0);
  assert.equal(control.state.available, false);
});

test('switching saved natals releases active ownership while reusable extra-body dates remain in RAM', async () => {
  let calls = 0;
  const client = createCyclesClient({ request: async (_url, { body }) => { calls++; return packet(JSON.parse(body as string)); } });
  const control = createReturnsController({ client }), first = natal(), second = { ...first, id: 'second', utc: '2001-01-01T00:00:00Z' };
  for (const value of [first, second, first] as const) { await control.select(value); await control.setBodies(CYCLE_BODIES.map(body => body.id)); }
  assert.equal(calls, CYCLE_BODIES.length * 2, 'changing selection does not delete reusable lists');
});

const selectedEvent = { body: 'saturn', utc: '2030-02-01T00:00:00.123456Z', cycle: 1, pass: 1, direction: 'direct' as const } as CycleEvent;
selectedEvent.id = `${selectedEvent.body}:${selectedEvent.utc}`; selectedEvent.cycleId = 'saturn:1';
selectedEvent.age = (Date.parse(selectedEvent.utc) - Date.parse(input.birthUtc) + 0.456) / (365.2425 * 86400000);
const chartInput = { birthUtc: input.birthUtc, body: selectedEvent.body, eventUtc: selectedEvent.utc, timezone: 'UTC' };
const chartPacket = () => ({ chart: { ...natal(), utc: selectedEvent.utc, timezone: 'UTC' } as CycleChartResult['chart'] });

test('cache-only chart restoration uses its validated event metadata and bypasses unfinished dates', async () => {
  const storage = device(), options = { returnStorage: storage, request: async () => chartPacket() };
  await createCyclesClient(options).chart(chartInput, undefined, { event: selectedEvent }); await tick();
  const jobs: ReturnType<typeof deferred>[] = [];
  const reload = createCyclesClient({ ...options, request: async () => { const job = deferred(); jobs.push(job); return job.promise; } });
  const control = createReturnsController({ client: reload });
  control.select(natal()); await tick();
  const saved = { opened: false, bodies: [selectedEvent.body], eventId: selectedEvent.id, event: { ...selectedEvent, cycle: 99, cycleId: 'saturn:99' } };
  const restoring = control.restore(saved as unknown as SavedReturnView);
  const done = await Promise.race([restoring, tick().then(() => 'pending')]);
  const shown = control.state;
  control.select(null); jobs.forEach(job => job.resolve!(packet(input))); await restoring;
  assert.deepEqual(shown.selectedEvent, selectedEvent);
  assert.equal(shown.current!.utc, selectedEvent.utc);
  assert.equal(done, true, 'a ready complete calculation never waits for body searches');
});

test('cache-only chart lookup never requests a missing chart or a body list', async () => {
  const storage = device(), first = createCyclesClient({ returnStorage: storage, request: async () => chartPacket() });
  await first.chart(chartInput, undefined, { event: selectedEvent }); await tick();
  const reload = createCyclesClient({ returnStorage: storage, request: () => assert.fail('readChart is cache-only') });
  const ready = await reload.readChart(chartInput);
  assert.deepEqual(ready!.event, selectedEvent); assert.deepEqual(ready!.chart, chartPacket().chart);
  assert.equal(await reload.readChart({ ...chartInput, body: 'venus' }), null);

});

test('ordinary opening enriches an old chart-only result without another calculation', async () => {
  const storage = device(); let calls = 0;
  const options: TestCyclesOptions = { returnStorage: storage, request: async () => { calls++; return chartPacket(); } };
  const first = createCyclesClient(options); await first.chart(chartInput); await tick();
  assert.equal(await first.readChart(chartInput), null, 'chart-only bytes do not prove old session ordinals');
  await first.chart(chartInput, undefined, { event: selectedEvent }); await tick();
  const restored = await createCyclesClient(options).readChart(chartInput);
  assert.deepEqual(restored!.event, selectedEvent); assert.equal(calls, 1);
});

test('a descriptor from another event cannot make cached chart-only bytes authoritative', async () => {
  const client = createCyclesClient({ returnStorage: device(), request: async () => chartPacket() });
  await client.chart(chartInput, undefined, { event: { ...selectedEvent, body: 'sun' } });
  assert.equal(await client.readChart(chartInput), null);
});

test('only default dates prepare initially; extra bodies start on demand and reuse their completed lists', async () => {
  const calls: unknown[] = [], control = createReturnsController({ client: { events: async value => { calls.push(value.body); return packet(value); } } });
  await control.select(natal());
  assert.deepEqual(calls, DEFAULT_CYCLE_BODIES);
  await control.setBodies(['moon']); await control.setBodies([]); await control.setBodies(['moon']);
  assert.deepEqual(calls, [...DEFAULT_CYCLE_BODIES, 'moon']);
  await control.restore({ opened: false, bodies: [], eventId: 'venus:2030-01-01T00:00:00Z' } as unknown as SavedReturnView);
  assert.deepEqual(calls, [...DEFAULT_CYCLE_BODIES, 'moon', 'venus'], 'a restored extra body is prepared even when filtered out');
});

test('a cached chart clears an earlier chart failure and retry no longer recomputes it', async () => {
  let calls = 0;
  const control = createReturnsController({ client: {
    events: async value => ({ ...packet(value), events: value.body === selectedEvent.body ? [selectedEvent] : [] }),
    chart: async () => { calls++; throw new Error('Earlier chart failed'); },
    readChart: async () => ({ ...chartPacket(), event: selectedEvent }),
  } });
  await control.select(natal()); await control.setBodies([selectedEvent.body]); await control.selectEvent(selectedEvent.id);
  assert.equal(control.state.chartError, 'Earlier chart failed');
  assert.equal(await control.restore({ opened: false, bodies: [selectedEvent.body], eventId: selectedEvent.id } as unknown as SavedReturnView), true);
  assert.equal(control.state.chartError, '');
  await control.retry(); assert.equal(calls, 1);
});

for (const stop of ['close', 'reset', 'select'] as const) test(`late cached chart cannot restore ownership after ${stop}`, async () => {
  const waiting = deferred<CycleChartResult & { event: CycleEvent }>(); let signal: AbortSignal | undefined, pins = 0;
  const control = createReturnsController({ client: {
    events: async value => packet(value), readChart: (_input, options) => { signal = options!.signal; return waiting.promise; },
    retainChart: () => { pins++; return () => {}; },
  } });
  await control.select(natal());
  const restoring = control.restore({ opened: false, bodies: [], eventId: selectedEvent.id } as unknown as SavedReturnView); await tick();
  if (stop === 'select') control.select(null); else control[stop]();
  waiting.resolve!({ ...chartPacket(), event: selectedEvent });
  assert.equal(await restoring, false); assert.equal(signal!.aborted, true); assert.equal(control.current, null); assert.equal(pins, 0);
});

test('existing persisted exact chart keys can be enumerated after reload without reading chart payloads',async t=>{
 const storage=createReturnStorage({indexedDB:new IDBFactory()}),selected=selectedEvent;t.after(()=>storage.close());
 const query={birthUtc:input.birthUtc,body:selected.body,eventUtc:selected.utc,timezone:'UTC'};
 const first=createCyclesClient({returnStorage:storage,request:async()=>chartPacket()});
 await first.chart(query,undefined,{event:selected});await tick();
 const reload=createCyclesClient({returnStorage:storage,request:async()=>assert.fail('enumeration never calculates')});
 let reads=0;const getChart=storage.getChart;t.mock.method(storage,'getChart',async (key:string)=>{reads++;return getChart(key);});
 assert.deepEqual(await reload.preparedChartInputs({birthUtc:query.birthUtc,timezone:'UTC'}),[query]);assert.equal(reads,0);
 assert.ok(await reload.readChart(query));assert.equal(reads,1);
});


test('offline availability drops an exact return after its unpinned cache entry is evicted',async()=>{
 const memory=createMemoryCache({maxBytes:1_000_000});let online=true,calls=0;
 const client=createCyclesClient({memory,returnStorage:null,
  request:async(url,{body})=>{
   assert.equal(online,true,'offline availability must never calculate');calls++;
   if(url.endsWith('/chart'))return chartPacket();
   const value=JSON.parse(body as string);
   return {...packet(value),events:value.body===selectedEvent.body?[selectedEvent]:[]};
  }});
 const control=createReturnsController({client,connection:()=>online?'online':'offline'});
 try {
  await client.chart(chartInput,undefined,{event:selectedEvent});
  await control.select(natal());online=false;
  await control.refreshAvailability();
  assert.ok(control.state.readyEvents.includes(selectedEvent.id));
  const before=calls;
  // Active lists stay pinned; the unopened full chart loses ordinary RAM ownership.
  memory.put('pressure',new ArrayBuffer(1_000_001));
  assert.equal(await client.readChart(chartInput),null);
  await control.refreshAvailability();
  assert.equal(control.state.readyEvents.includes(selectedEvent.id),false);
  assert.equal(calls,before);
 } finally {await control.select(null);client.close();}
});
