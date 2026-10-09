import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createCyclesClient } from '../src/data/cycles-client.js';
import { createReturnStorage } from '../src/data/return-storage.js';
import { createMemoryCache, estimateBytes } from '../src/data/memory-cache.js';
import { createReturnsController } from '../src/state/returns.js';
import { CYCLE_BODIES, DEFAULT_CYCLE_BODIES } from '../src/domain/cycles.js';
import { chartAtMinute } from '../src/domain/natal-day.js';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.mjs';

const revision = 'a'.repeat(64), tick = () => new Promise(setImmediate);
const input = { birthUtc: '2000-01-01T00:00:00Z', body: 'moon', fromAge: 0, toAge: 100 };
const packet = value => ({ range: { fromAge: value.fromAge ?? 0, toAge: value.toAge ?? 100 }, events: [] });
const natal = () => chartAtMinute(natalDayFixture({ date: '2000-01-01' }), 0, personalChartFixture({ id: 'saved-natal' }));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function device() {
  const records = new Map(), reads = [], writes = [];
  return { records, reads, writes,
    async getEvents(key) { reads.push(JSON.parse(key)[3]); return records.get(key); },
    async putEvents(key, value, data) { writes.push(value.body); records.set(key, data); },
    async getChart(key) { return records.get(key); }, async putChart(key, data) { records.set(key, data); },
  };
}

test('all body dates reuse RAM; only default body dates survive a fresh client memory', async () => {
  const storage = device(), calls = [];
  const options = { cacheVersion: revision, returnStorage: storage, request: async (_url, { body }) => {
    const value = JSON.parse(body); calls.push(value.body); return packet(value);
  } };
  const first = createCyclesClient(options);
  for (const { id: body } of CYCLE_BODIES) {
    const value = { ...input, body }, ready = await first.events(value);
    assert.equal(await first.events({ ...value, timezone: 'Europe/Moscow' }), ready);
  }
  await tick();
  assert.equal(calls.length, 13);
  assert.deepEqual(new Set(storage.reads), new Set(DEFAULT_CYCLE_BODIES));
  assert.deepEqual(new Set(storage.writes), new Set(DEFAULT_CYCLE_BODIES));
  assert.equal(storage.records.size, DEFAULT_CYCLE_BODIES.length);
  const reload = createCyclesClient(options);
  for (const { id: body } of CYCLE_BODIES) await reload.events({ ...input, body });
  assert.equal(calls.length, 13 + CYCLE_BODIES.length - DEFAULT_CYCLE_BODIES.length);
});

test('extra body dates share the byte LRU across clients and lose reuse only after eviction', async () => {
  const ready = packet(input), size = estimateBytes(ready), memory = createMemoryCache({ maxBytes: size * 2 });
  let calls = 0;
  const options = { cacheVersion: revision, memory, returnStorage: device(), request: async () => { calls++; return packet(input); } };
  const first = createCyclesClient(options), second = createCyclesClient(options);
  const moon = await first.events(input), mercuryInput = { ...input, body: 'mercury' };
  await first.events(mercuryInput);
  assert.equal(await second.events(input), moon, 'a second owner reads the same versioned memory result');
  memory.put('transit-day:pressure', new ArrayBuffer(size));
  assert.equal(await second.events(input), moon, 'recently used Moon survives unrelated data pressure');
  await first.events(mercuryInput);
  assert.equal(calls, 3, 'evicted non-default data is searched again, without persistent fallback');
  assert.ok(memory.bytes <= size * 2);
  await createCyclesClient({ ...options, cacheVersion: 'b'.repeat(64) }).events(input);
  assert.equal(calls, 4, 'numerical revisions cannot share dates in RAM');
});

test('a pending device miss notices another client that populated common RAM during the read', async () => {
  const disk = deferred(), memory = createMemoryCache(), value = { ...input, body: 'saturn' }; let calls = 0;
  const request = async () => { calls++; return packet(value); };
  const waiting = createCyclesClient({ cacheVersion: revision, memory, returnStorage: { getEvents: () => disk.promise }, request });
  const reading = waiting.events(value); await tick();
  const ready = await createCyclesClient({ cacheVersion: revision, memory, returnStorage: null, request }).events(value);
  disk.resolve(null);
  assert.equal(await reading, ready);
  assert.equal(calls, 1);
});

test('all full return charts, including extra bodies, persist independently of dates', async t => {
  const indexedDB = new IDBFactory(), storage = createReturnStorage({ indexedDB }); t.after(() => storage.close());
  let calls = 0;
  const options = { cacheVersion: revision, returnStorage: storage, request: async (_url, { body }) => {
    const value = JSON.parse(body); calls++;
    return { chart: { ...natal(), utc: value.eventUtc, timezone: value.timezone } };
  } };
  const first = createCyclesClient(options);
  for (const { id: body } of CYCLE_BODIES) {
    await first.chart({ birthUtc: input.birthUtc, body, eventUtc: '2030-01-01T00:00:00.123456Z', timezone: 'UTC' });
  }
  const reload = createCyclesClient(options);
  for (const { id: body } of CYCLE_BODIES) {
    await reload.chart({ birthUtc: input.birthUtc, body, eventUtc: '2030-01-01T00:00:00.123456Z', timezone: 'UTC' });
  }
  assert.equal(calls, CYCLE_BODIES.length);
});

test('date storage rejects extra-body writes and ignores their old records without deleting them', async t => {
  const indexedDB = new IDBFactory(), storage = createReturnStorage({ indexedDB }); t.after(() => storage.close());
  for (const { id: body } of CYCLE_BODIES) await storage.putEvents(body, { ...input, body }, packet(input));
  for (const { id: body } of CYCLE_BODIES) assert.deepEqual(await storage.getEvents(body), DEFAULT_CYCLE_BODIES.includes(body) ? packet(input) : null);
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('bodygraph-return-events', 2);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  t.after(() => db.close());
  await new Promise((resolve, reject) => {
    const tx = db.transaction('events', 'readwrite');
    tx.objectStore('events').put({ key: 'old-moon', body: 'moon', birthUtc: input.birthUtc, ...packet(input) });
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  assert.equal(await storage.getEvents('old-moon'), null);
  const old = await new Promise(resolve => {
    const request = db.transaction('events').objectStore('events').get('old-moon'); request.onsuccess = () => resolve(request.result);
  });
  assert.equal(old.body, 'moon', 'an old database is retained without destructive migration');
});

test('active body lists are accounted and pinned until their natal changes, not until filters close', async () => {
  const memory = createMemoryCache({ maxBytes: 1 }); let calls = 0;
  const client = createCyclesClient({ memory, request: async (_url, { body }) => { calls++; return packet(JSON.parse(body)); } });
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
  const jobs = [], retained = [];
  const control = createReturnsController({ client: {
    events(value, signal) { const job = { value, signal, ...deferred() }; jobs.push(job); return job.promise; },
    retainEvents(value, data) { retained.push({ value, data }); return () => {}; },
  } });
  control.select(natal()); await tick(); control.select(null);
  jobs.forEach(job => job.resolve(packet(job.value))); await tick();
  assert.equal(retained.length, 0);
  assert.equal(control.state.available, false);
});

test('switching saved natals releases active ownership while reusable extra-body dates remain in RAM', async () => {
  let calls = 0;
  const client = createCyclesClient({ request: async (_url, { body }) => { calls++; return packet(JSON.parse(body)); } });
  const control = createReturnsController({ client }), first = natal(), second = { ...first, id: 'second', utc: '2001-01-01T00:00:00Z' };
  for (const value of [first, second, first]) { await control.select(value); await control.setBodies(CYCLE_BODIES.map(body => body.id)); }
  assert.equal(calls, CYCLE_BODIES.length * 2, 'changing selection does not delete reusable lists');
});

const selectedEvent = { body: 'moon', utc: '2000-02-01T00:00:00.123456Z', cycle: 1, pass: 1, direction: 'direct' };
selectedEvent.id = `${selectedEvent.body}:${selectedEvent.utc}`; selectedEvent.cycleId = 'moon:1';
selectedEvent.age = (Date.parse(selectedEvent.utc) - Date.parse(input.birthUtc) + 0.456) / (365.2425 * 86400000);
const chartInput = { birthUtc: input.birthUtc, body: selectedEvent.body, eventUtc: selectedEvent.utc, timezone: 'UTC' };
const chartPacket = () => ({ chart: { ...natal(), utc: selectedEvent.utc, timezone: 'UTC' } });

test('cache-only chart restoration uses its validated event metadata and bypasses unfinished dates', async () => {
  const storage = device(), options = { cacheVersion: revision, returnStorage: storage, request: async () => chartPacket() };
  await createCyclesClient(options).chart(chartInput, undefined, { event: selectedEvent }); await tick();
  const jobs = [];
  const reload = createCyclesClient({ ...options, request: async () => { const job = deferred(); jobs.push(job); return job.promise; } });
  const control = createReturnsController({ client: reload });
  control.select(natal()); await tick();
  const saved = { opened: false, bodies: ['moon'], eventId: selectedEvent.id, event: { ...selectedEvent, cycle: 99, cycleId: 'moon:99' } };
  const restoring = control.restore(saved);
  const done = await Promise.race([restoring, tick().then(() => 'pending')]);
  const shown = control.state;
  control.select(null); jobs.forEach(job => job.resolve(packet(input))); await restoring;
  assert.deepEqual(shown.selectedEvent, selectedEvent);
  assert.equal(shown.current.utc, selectedEvent.utc);
  assert.equal(done, true, 'a ready complete calculation never waits for body searches');
});

test('cache-only chart lookup preserves revision and never requests a missing chart or a body list', async () => {
  const storage = device(), first = createCyclesClient({ cacheVersion: revision, returnStorage: storage, request: async () => chartPacket() });
  await first.chart(chartInput, undefined, { event: selectedEvent }); await tick();
  const reload = createCyclesClient({ cacheVersion: revision, returnStorage: storage, request: () => assert.fail('readChart is cache-only') });
  const ready = await reload.readChart(chartInput);
  assert.deepEqual(ready.event, selectedEvent); assert.deepEqual(ready.chart, chartPacket().chart);
  assert.equal(await reload.readChart({ ...chartInput, body: 'venus' }), null);
  const revised = createCyclesClient({ cacheVersion: 'b'.repeat(64), returnStorage: storage, request: () => assert.fail('revision miss is cache-only') });
  assert.equal(await revised.readChart(chartInput), null);
});

test('ordinary opening enriches an old chart-only result without another calculation', async () => {
  const storage = device(); let calls = 0;
  const options = { cacheVersion: revision, returnStorage: storage, request: async () => { calls++; return chartPacket(); } };
  const first = createCyclesClient(options); await first.chart(chartInput); await tick();
  assert.equal(await first.readChart(chartInput), null, 'chart-only bytes do not prove old session ordinals');
  await first.chart(chartInput, undefined, { event: selectedEvent }); await tick();
  const restored = await createCyclesClient(options).readChart(chartInput);
  assert.deepEqual(restored.event, selectedEvent); assert.equal(calls, 1);
});

test('a descriptor from another event cannot make cached chart-only bytes authoritative', async () => {
  const client = createCyclesClient({ cacheVersion: revision, returnStorage: device(), request: async () => chartPacket() });
  await client.chart(chartInput, undefined, { event: { ...selectedEvent, body: 'sun' } });
  assert.equal(await client.readChart(chartInput), null);
});

test('only default dates prepare initially; extra bodies start on demand and reuse their completed lists', async () => {
  const calls = [], control = createReturnsController({ client: { events: async value => { calls.push(value.body); return packet(value); } } });
  await control.select(natal());
  assert.deepEqual(calls, DEFAULT_CYCLE_BODIES);
  await control.setBodies(['moon']); await control.setBodies([]); await control.setBodies(['moon']);
  assert.deepEqual(calls, [...DEFAULT_CYCLE_BODIES, 'moon']);
  await control.restore({ opened: false, bodies: [], eventId: 'venus:2030-01-01T00:00:00Z' });
  assert.deepEqual(calls, [...DEFAULT_CYCLE_BODIES, 'moon', 'venus'], 'a restored extra body is prepared even when filtered out');
});

test('a cached chart clears an earlier chart failure and retry no longer recomputes it', async () => {
  let calls = 0;
  const control = createReturnsController({ client: {
    events: async value => ({ ...packet(value), events: value.body === 'moon' ? [selectedEvent] : [] }),
    chart: async () => { calls++; throw new Error('Earlier chart failed'); },
    readChart: async () => ({ ...chartPacket(), event: selectedEvent }),
  } });
  await control.select(natal()); await control.setBodies(['moon']); await control.selectEvent(selectedEvent.id);
  assert.equal(control.state.chartError, 'Earlier chart failed');
  assert.equal(await control.restore({ opened: false, bodies: ['moon'], eventId: selectedEvent.id }), true);
  assert.equal(control.state.chartError, '');
  await control.retry(); assert.equal(calls, 1);
});

for (const stop of ['close', 'reset', 'select']) test(`late cached chart cannot restore ownership after ${stop}`, async () => {
  const waiting = deferred(); let signal, pins = 0;
  const control = createReturnsController({ client: {
    events: async value => packet(value), readChart: (_input, options) => { signal = options.signal; return waiting.promise; },
    retainChart: () => { pins++; return () => {}; },
  } });
  await control.select(natal());
  const restoring = control.restore({ opened: false, bodies: [], eventId: selectedEvent.id }); await tick();
  if (stop === 'select') control.select(null); else control[stop]();
  waiting.resolve({ ...chartPacket(), event: selectedEvent });
  assert.equal(await restoring, false); assert.equal(signal.aborted, true); assert.equal(control.current, null); assert.equal(pins, 0);
});
