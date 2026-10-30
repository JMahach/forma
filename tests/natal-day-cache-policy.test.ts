import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createNatalDayStorage } from '../src/data/natal-day-storage.ts';
import { createCalculationCache } from '../src/data/calculation-cache.ts';
import { createNatalDayClient } from '../src/data/natal-day-client.ts';
import { createMemoryCache } from '../src/data/memory-cache.ts';
import { createNatalDayExplorer } from '../src/state/natal-day.ts';
import { encodeNatalDay } from '../server/packets/encode.ts';
import { decodeNatalDay } from '../shared/day-packets/decode.ts';
import { natalDayMinute } from '../src/domain/natal-day.ts';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.ts';

const tick = () => new Promise(setImmediate);
const packet = (day = natalDayFixture()) => encodeNatalDay(day).buffer;
const response = (bytes: ArrayBuffer) => ({ ok: true, arrayBuffer: async () => bytes });
const disk = (indexedDB: IDBFactory) => createNatalDayStorage({ indexedDB, legacyDatabaseName: 'bodygraph-chart-days' });

test('natal device days survive count, byte and old timestamp limits across connections', async () => {
  const indexedDB = new IDBFactory(), first = disk(indexedDB);
  for (let i = 0; i < 65; i++) await first.put(`day-${i}`, new ArrayBuffer(16));
  await first.put('large-day', new ArrayBuffer(9 * 1024 * 1024));
  const reload = disk(indexedDB);
  for (let i = 0; i < 65; i++) assert.equal((await reload.get(`day-${i}`))?.byteLength, 16);
  assert.equal((await reload.get('large-day'))?.byteLength, 9 * 1024 * 1024);
});

test('version-one migration rekeys the original natal day and never recalculates its numbers', async () => {
  const indexedDB = new IDBFactory(), chart = personalChartFixture(), legacyKey = `1:${chart.birthDate}:${chart.cityId}`;
  const legacyBytes = encodeNatalDay(natalDayFixture()).buffer;
  await new Promise<void>((resolve, reject) => {
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
  const fetch = async () => { calls++; return response(packet()); };
  const ready = await createNatalDayClient({ persistentCache, fetch }).getDay(chart);
  assert.deepEqual(ready.columns, decodeNatalDay(legacyBytes).columns); await tick();
  assert.equal(Object.hasOwn(ready, 'calculationVersion'), false);
  const restored = await createNatalDayClient({ persistentCache: disk(indexedDB), fetch }).getDay(chart);
  assert.deepEqual(restored, ready); assert.equal(calls, 0);
  assert.equal(await persistentCache.get(legacyKey), null);
  assert.deepEqual(await persistentCache.get(`natal-day:${legacyKey}`), legacyBytes);
});

test('a real quota exception leaves the loaded day usable in the common memory budget', async t => {
  const indexedDB = new IDBFactory(), persistentCache = disk(indexedDB), memory = createMemoryCache();
  let failures = 0, calls = 0;
  t.mock.method(IDBObjectStore.prototype, 'put', function () { failures++; throw new DOMException('Full', 'QuotaExceededError'); });
  const client = createNatalDayClient({ persistentCache, memory,
    fetch: async () => { calls++; return response(packet()); } });
  const day = await client.getDay(personalChartFixture()); await tick();
  assert.equal(await client.getDay(personalChartFixture()), day);
  assert.ok(memory.bytes > 24 * 1440 * 8); assert.equal(calls, 1); assert.ok(failures > 0);
});

test('a natal RAM hit refreshes the shared persistent LRU without fetching or rewriting payload', async t => {
  const indexedDB=new IDBFactory(),owner=createCalculationCache({indexedDB,maxBytes:9500});t.after(()=>owner.close());
  const persistent=createNatalDayStorage({cache:owner}),memory=createMemoryCache(),chart=personalChartFixture();
  const key=`natal-day:1:${chart.birthDate}:${chart.cityId}`;
  await persistent.put(key,new ArrayBuffer(1500));await owner.put('return-charts','older',new ArrayBuffer(1500));
  const value=natalDayFixture();memory.put(key,value);
  let touched:Promise<unknown>|undefined;
  const client=createNatalDayClient({memory,persistentCache:{...persistent,
    touch(key){touched=persistent.touch(key);return touched;}},fetch(){throw new Error('RAM hit must not fetch');}});
  assert.equal(await client.getDay(chart),value);await touched;
  await owner.put('return-events','newer',new ArrayBuffer(1500));
  assert.ok(await persistent.get(key));assert.equal(await owner.get('return-charts','older'),null);
});

test('active natal day is retained in the common budget and released on close or natal change', async () => {
  const memory = createMemoryCache({ maxBytes: 1 }); let calls = 0;
  const client = createNatalDayClient({ memory, persistentCache: null,
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
    await createNatalDayClient({ persistentCache: disk(indexedDB), fetch: async () => response(bytes) }).getDay(chart); await tick();
    const restored = await createNatalDayClient({ persistentCache: disk(indexedDB), fetch: () => { throw Error('Unexpected request'); } }).getDay(chart);
    assert.equal(natalDayMinute(restored, input.minute).utc, input.utc);
    assert.deepEqual(restored.columns, decodeNatalDay(bytes).columns);
  }
});
