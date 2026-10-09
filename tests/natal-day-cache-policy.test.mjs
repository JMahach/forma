import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createBinaryCache } from '../src/data/binary-cache.js';
import { createNatalDayClient } from '../src/data/natal-day-client.js';
import { createMemoryCache } from '../src/data/memory-cache.js';
import { createNatalDayExplorer } from '../src/state/natal-day.js';
import { encodeNatalDay } from '../server/packets/encode.mjs';
import { decodeNatalDay } from '../shared/day-packets/decode.js';
import { natalDayMinute } from '../src/domain/natal-day.js';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.mjs';

const revision = 'a'.repeat(64), nextRevision = 'b'.repeat(64), tick = () => new Promise(setImmediate);
const packet = (day = natalDayFixture(), calculationVersion = revision) => encodeNatalDay({ ...day, calculationVersion }).buffer;
const response = bytes => ({ ok: true, arrayBuffer: async () => bytes });
const disk = indexedDB => createBinaryCache({ indexedDB, databaseName: 'bodygraph-chart-days' });

test('natal device days survive count, byte and old timestamp limits across connections', async () => {
  const indexedDB = new IDBFactory(), first = disk(indexedDB);
  for (let i = 0; i < 65; i++) await first.put(`day-${i}`, new ArrayBuffer(16));
  await first.put('large-day', new ArrayBuffer(9 * 1024 * 1024));
  const reload = disk(indexedDB);
  for (let i = 0; i < 65; i++) assert.equal((await reload.get(`day-${i}`))?.byteLength, 16);
  assert.equal((await reload.get('large-day'))?.byteLength, 9 * 1024 * 1024);
});

test('version-one migration preserves old bytes but a revised client requests attested data', async () => {
  const indexedDB = new IDBFactory(), chart = personalChartFixture(), legacyKey = `1:${chart.birthDate}:${chart.cityId}`;
  const legacyBytes = encodeNatalDay(natalDayFixture()).buffer;
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('bodygraph-chart-days', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('packets', { keyPath: 'key' });
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result, tx = db.transaction('packets', 'readwrite');
      tx.objectStore('packets').put({ key: legacyKey, bytes: legacyBytes, createdAt: 0, accessedAt: 0 });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
    };
  });
  const persistentCache = disk(indexedDB); let calls = 0;
  const fetch = async (_url, options) => { calls++; assert.equal(JSON.parse(options.body).r, revision); return response(packet()); };
  const ready = await createNatalDayClient({ persistentCache, calculationVersion: revision, fetch }).getDay(chart);
  assert.equal(ready.calculationVersion, revision); await tick();
  assert.deepEqual(await persistentCache.get(legacyKey), legacyBytes);
  const restored = await createNatalDayClient({ persistentCache: disk(indexedDB), calculationVersion: revision, fetch }).getDay(chart);
  assert.deepEqual(restored, ready); assert.equal(calls, 1);
  await createNatalDayClient({ persistentCache, calculationVersion: nextRevision, fetch: async () => { calls++; return response(packet(undefined, nextRevision)); } }).getDay(chart);
  assert.equal(calls, 2);
});

test('wrong or absent response revision cannot enter RAM or device storage', async () => {
  for (const oldVersion of [undefined, nextRevision]) {
    let writes = 0;
    const bytes = encodeNatalDay({ ...natalDayFixture(), calculationVersion: oldVersion }).buffer;
    const memory = createMemoryCache();
    const client = createNatalDayClient({ calculationVersion: revision, memory,
      persistentCache: { get: async () => bytes, put: () => { writes++; }, remove() {} }, fetch: async () => response(bytes) });
    await assert.rejects(client.getDay(personalChartFixture()), /[Вв]ерси/);
    assert.equal(writes, 0); assert.equal(memory.size, 0);
  }
});

test('without bootstrap revision neither legacy RAM nor disk is reused or accumulated', async () => {
  let calls = 0, reads = 0, writes = 0; const memory = createMemoryCache();
  const client = createNatalDayClient({ memory, persistentCache: { get() { reads++; return packet(); }, put() { writes++; } },
    fetch: async () => { calls++; return response(packet()); } });
  await client.getDay(personalChartFixture()); await client.getDay(personalChartFixture()); await tick();
  assert.equal(calls, 2); assert.equal(reads, 0); assert.equal(writes, 0); assert.equal(memory.size, 0);
});

test('a real quota exception leaves the loaded day usable in the common memory budget', async t => {
  const indexedDB = new IDBFactory(), persistentCache = disk(indexedDB), memory = createMemoryCache();
  let failures = 0, calls = 0;
  t.mock.method(IDBObjectStore.prototype, 'put', function () { failures++; throw new DOMException('Full', 'QuotaExceededError'); });
  const client = createNatalDayClient({ persistentCache, memory, calculationVersion: revision,
    fetch: async () => { calls++; return response(packet()); } });
  const day = await client.getDay(personalChartFixture()); await tick();
  assert.equal(await client.getDay(personalChartFixture()), day);
  assert.ok(memory.bytes > 24 * 1440 * 8); assert.equal(calls, 1); assert.equal(failures, 1);
});

test('active natal day is retained in the common budget and released on close or natal change', async () => {
  const memory = createMemoryCache({ maxBytes: 1 }); let calls = 0;
  const client = createNatalDayClient({ calculationVersion: revision, memory, persistentCache: null,
    fetch: async () => { calls++; return response(packet()); } });
  const explorer = createNatalDayExplorer({ dayClient: client });
  explorer.select(personalChartFixture()); await explorer.open();
  assert.ok(memory.bytes > 1, 'the current day is pinned even if larger than the remaining budget');
  explorer.scrub(700); explorer.close();
  assert.equal(memory.bytes, 0); assert.equal(explorer.state.day, null);
  await explorer.open(); assert.equal(calls, 2);
  explorer.select(personalChartFixture({ id: 'second' })); assert.equal(memory.bytes, 0);
});

test('persisted local days preserve repeated folds and historical second offsets after reload', async () => {
  const inputs = [
    { date: '2024-11-03', timezone: 'America/New_York', samples: 1500, segments: [
      { index: 0, startUtc: '2024-11-03T04:00:00Z', offsetSeconds: -14400, utcOffset: 'UTC−04:00', fold: 0 },
      { index: 120, startUtc: '2024-11-03T06:00:00Z', offsetSeconds: -18000, utcOffset: 'UTC−05:00', fold: 1 },
      { index: 180, startUtc: '2024-11-03T07:00:00Z', offsetSeconds: -18000, utcOffset: 'UTC−05:00', fold: 0 },
    ], minute: 150, utc: '2024-11-03T06:30:00Z' },
    { date: '1900-01-01', timezone: 'Europe/Paris', segments: [
      { index: 0, startUtc: '1899-12-31T23:50:39Z', offsetSeconds: 561, utcOffset: 'UTC+00:09:21', fold: 0 },
    ], minute: 1, utc: '1899-12-31T23:51:39Z' },
  ];
  for (const input of inputs) {
    const indexedDB = new IDBFactory(), chart = personalChartFixture({ birthDate: input.date, timezone: input.timezone });
    const bytes = packet(natalDayFixture(input));
    await createNatalDayClient({ calculationVersion: revision, persistentCache: disk(indexedDB), fetch: async () => response(bytes) }).getDay(chart); await tick();
    const restored = await createNatalDayClient({ calculationVersion: revision, persistentCache: disk(indexedDB), fetch: () => { throw Error('Unexpected request'); } }).getDay(chart);
    assert.equal(natalDayMinute(restored, input.minute).utc, input.utc);
    assert.deepEqual(restored.columns, decodeNatalDay(bytes).columns);
  }
});
