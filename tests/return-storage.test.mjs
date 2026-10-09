import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createMemoryCache } from '../src/data/memory-cache.js';
import { chartAtMinute } from '../src/domain/natal-day.js';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.mjs';
import { createReturnStorage } from '../src/data/return-storage.js';
import { createCyclesClient } from '../src/data/cycles-client.js';
const revision = 'a'.repeat(64), tick = () => new Promise(setImmediate);
const input = { birthUtc: '2000-01-01T00:00:00Z', body: 'saturn', fromAge: 0, toAge: 100 };
const event = { body: 'saturn', utc: '2028-07-21T12:36:05.920740Z', cycle: 1, pass: 1, direction: 'direct' };
event.id = `${event.body}:${event.utc}`; event.cycleId = 'saturn:1'; event.age = (Date.parse(event.utc) - Date.parse(input.birthUtc) + 0.740) / (365.2425 * 86400000);
const data = { range: { fromAge: 0, toAge: 100 }, events: [event] };
function open(factory) { return new Promise((resolve, reject) => { const req = factory.open('bodygraph-return-events', 2); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }

test('device dates retain microseconds and more than forty complete or empty datasets across a new connection', async t => {
  const indexedDB = new IDBFactory(), first = createReturnStorage({ indexedDB }); t.after(() => first.close());
  for (let index = 0; index < 65; index++) await first.putEvents(`natal-${index}`, input, index % 2 ? { ...data, events: [] } : data);
  const reload = createReturnStorage({ indexedDB }); t.after(() => reload.close());
  for (let index = 0; index < 65; index++) assert.deepEqual(await reload.getEvents(`natal-${index}`), index % 2 ? { ...data, events: [] } : data);
  const db = await open(indexedDB); t.after(() => db.close());
  const record = await new Promise(resolve => { const request = db.transaction('events').objectStore('events').get('natal-0'); request.onsuccess = () => resolve(request.result); });
  assert.deepEqual(Object.keys(record.events[0]).sort(), ['cycle', 'direction', 'pass', 'utc']);
  assert.equal(record.events[0].utc, event.utc); assert.equal(record.chart, undefined);
});

test('two tabs writing finished body packets keep each other’s records intact', async t => {
  const indexedDB = new IDBFactory(), first = createReturnStorage({ indexedDB }), second = createReturnStorage({ indexedDB });
  t.after(() => { first.close(); second.close(); });
  await Promise.all([first.putEvents('saturn', input, data), second.putEvents('chiron', { ...input, body: 'chiron' }, { ...data, events: [] }), second.putEvents('saturn', input, data)]);
  assert.deepEqual(await first.getEvents('saturn'), data); assert.deepEqual(await first.getEvents('chiron'), { ...data, events: [] });
});

test('client reads a stored empty result without a new search and isolates numerical revisions', async t => {
  const indexedDB = new IDBFactory(), storage = createReturnStorage({ indexedDB }); t.after(() => storage.close());
  let calls = 0; const request = async () => { calls++; return { ...data, events: [] }; };
  const options = { returnStorage: storage, cacheVersion: revision, request };
  await createCyclesClient(options).events(input); await tick();
  await createCyclesClient(options).events({ ...input, timezone: 'Europe/Moscow', id: 'renamed' });
  assert.equal(calls, 1);
  await createCyclesClient({ ...options, cacheVersion: 'b'.repeat(64) }).events(input);
  assert.equal(calls, 2);
});

test('a ready body packet is read while another natal request is still unfinished', async t => {
  const indexedDB = new IDBFactory(), storage = createReturnStorage({ indexedDB }); t.after(() => storage.close());
  let finish; const waiting = new Promise(resolve => { finish = resolve; });
  let calls = 0;
  const options = { cacheVersion: revision, returnStorage: storage, request: async (_url, { body }) => { calls++; return JSON.parse(body).body === 'moon' ? waiting : data; } };
  await createCyclesClient(options).events(input); await tick();
  const client = createCyclesClient(options), pending = client.events({ ...input, body: 'moon' });
  await tick(); assert.deepEqual(await client.events(input), data); assert.equal(calls, 2);
  finish({ ...data, events: [] }); await pending;
});

test('unavailable storage remains optional', async () => {
  const storage = createReturnStorage({ indexedDB: null });
  assert.equal(await storage.getEvents('missing'), null); await storage.putEvents('one', input, data); storage.close();
});

test('compact dates preserve valid ordering for two roots inside the same millisecond', async t => {
  const { validCycleResult } = await import('../shared/cycles-format.js');
  const indexedDB = new IDBFactory(), storage = createReturnStorage({ indexedDB }); t.after(() => storage.close());
  const rows = ['2028-07-21T12:36:05.920100Z', '2028-07-21T12:36:05.920200Z'].map((utc, index) => ({ ...event, utc,
    id: `saturn:${utc}`, pass: index + 1, age: (Date.parse(utc) - Date.parse(input.birthUtc) + (index + 1) / 10) / (365.2425 * 86400000) }));
  const packet = { ...data, events: rows };
  assert.equal(validCycleResult('events', packet, input), true);
  await storage.putEvents('sub-ms', input, packet); const restored = await storage.getEvents('sub-ms');
  assert.equal(validCycleResult('events', restored, input), true);
  assert.deepEqual(restored.events.map(row => row.utc), rows.map(row => row.utc));
});


const exactChart = () => ({ chart: { ...chartAtMinute(natalDayFixture({ date: '2028-07-21' }), 0, personalChartFixture()), utc: event.utc } });

test('upgrading existing date storage preserves its records and adds independent full charts', async t => {
  const indexedDB = new IDBFactory();
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('bodygraph-return-events', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('events', { keyPath: 'key' });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('events', 'readwrite');
      tx.objectStore('events').put({ key: 'legacy-dates', birthUtc: input.birthUtc, body: input.body, range: data.range,
        events: data.events.map(({ utc, cycle, pass, direction }) => ({ utc, cycle, pass, direction })) });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
    };
  });
  const storage = createReturnStorage({ indexedDB }); t.after(() => storage.close());
  assert.deepEqual(await storage.getEvents('legacy-dates'), data);
  const chart = exactChart(); await storage.putChart('exact-return', chart);
  assert.deepEqual(await storage.getChart('exact-return'), chart);
  assert.equal(await storage.getEvents('exact-return'), null);
  assert.equal(await storage.getChart('legacy-dates'), null);
  assert.deepEqual(await storage.getEvents('legacy-dates'), data);
});

test('more than forty opened full charts survive a new connection without time or count eviction', async t => {
  const indexedDB = new IDBFactory(), first = createReturnStorage({ indexedDB }); t.after(() => first.close());
  const chart = exactChart();
  for (let index = 0; index < 65; index++) await first.putChart(`chart-${index}`, chart);
  const reload = createReturnStorage({ indexedDB }); t.after(() => reload.close());
  for (let index = 0; index < 65; index++) assert.deepEqual(await reload.getChart(`chart-${index}`), chart);
});

test('an actual quota exception in the chart transaction does not prevent rendering or reuse in shared RAM', async t => {
  const indexedDB = new IDBFactory(), storage = createReturnStorage({ indexedDB }); t.after(() => storage.close());
  const originalPut = IDBObjectStore.prototype.put; let quotaFailures = 0;
  t.mock.method(IDBObjectStore.prototype, 'put', function (...args) {
    if (this.name === 'charts') { quotaFailures++; throw new DOMException('Storage is full', 'QuotaExceededError'); }
    return originalPut.apply(this, args);
  });
  let requests = 0; const ready = exactChart();
  const client = createCyclesClient({ cacheVersion: revision, returnStorage: storage, memory: createMemoryCache(), request: async () => { requests++; return ready; } });
  const query = { birthUtc: input.birthUtc, body: input.body, eventUtc: event.utc, timezone: 'UTC' };
  assert.equal(await client.chart(query), ready); await tick();
  assert.equal(await storage.getChart('missing'), null);
  assert.equal(await client.chart(query), ready); assert.equal(requests, 1); assert.equal(quotaFailures, 1);
  await storage.putEvents('dates', input, data); assert.deepEqual(await storage.getEvents('dates'), data);
});
