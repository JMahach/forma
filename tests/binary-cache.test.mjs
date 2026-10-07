import test from 'node:test';
import assert from 'node:assert/strict';
import { createBinaryCache } from '../src/data/binary-cache.js';
import { createNatalDayClient } from '../src/data/natal-day-client.js';
import { NATAL_DAY_VERSION } from '../shared/day-packets/natal-format.js';
import { encodeNatalDay } from '../server/packets/encode.mjs';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.mjs';

// Exercise asynchronous transaction completion and eviction with a small
// IndexedDB-compatible in-memory adapter, without requiring a browser session.
function databaseHarness() {
  const records = new Map(), metadata = new Map();
  const stores = new Map([['packets', records]]), names = [], operations = [];
  let opens = 0, version = 1;
  function transaction() {
    const tx = {};
    let pending = 0, completed = false, aborted = false;
    const finish = () => queueMicrotask(() => {
      if (!pending && !completed && !aborted) { completed = true; tx.oncomplete?.(); }
    });
    function request(store, operation, action) {
      const result = {};
      pending++;
      queueMicrotask(() => {
        if (!aborted) {
          try { operations.push([store, operation]); result.result = action(); result.onsuccess?.(); }
          catch { aborted = true; tx.onerror?.(); }
        }
        pending--; finish();
      });
      return result;
    }
    tx.abort = () => { aborted = true; tx.onabort?.(); };
    tx.objectStore = name => {
      const entries = stores.get(name);
      return {
        get: key => request(name, 'get', () => structuredClone(entries.get(key))),
        put: entry => request(name, 'put', () => entries.set(entry.key, structuredClone(entry))),
        delete: key => request(name, 'delete', () => entries.delete(key)),
        getAll: () => request(name, 'getAll', () => structuredClone([...entries.values()])),
        openCursor() {
          const keys = [...entries.keys()], result = {};
          let index = 0;
          pending++;
          function next() {
            queueMicrotask(() => {
              if (index < keys.length) {
                const key = keys[index++];
                result.result = { value: structuredClone(entries.get(key)), continue: next };
                result.onsuccess?.();
              } else { result.result = null; result.onsuccess?.(); pending--; finish(); }
            });
          }
          next(); return result;
        },
      };
    };
    finish(); return tx;
  }
  const database = {
    objectStoreNames: { contains: name => stores.has(name) }, close() {}, transaction,
    createObjectStore(name) { stores.set(name, metadata); return {}; },
  };
  return {
    records, metadata, operations, database, names, get opens() { return opens; },
    indexedDB: { open(name, requestedVersion) {
      names.push(name); opens++;
      const request = { result: database };
      queueMicrotask(() => {
        if (requestedVersion > version) {
          const previousVersion = version; version = requestedVersion;
          request.transaction = transaction();
          request.transaction.oncomplete = () => request.onsuccess?.();
          request.onupgradeneeded?.({ oldVersion: previousVersion });
        } else request.onsuccess?.();
      });
      return request;
    } },
  };
}

test('device cache retains only a bounded LRU collection of binary packets and expires old entries', async () => {
  const h = databaseHarness();
  let timestamp = 100;
  const cache = createBinaryCache({ databaseName: 'test-packets', indexedDB: h.indexedDB, capacity: 2, maxAgeMs: 1000, now: () => timestamp });
  await cache.put('v:date:city-a', new ArrayBuffer(20)); timestamp++;
  await cache.put('v:date:city-b', new ArrayBuffer(30)); timestamp++;
  assert.equal((await cache.get('v:date:city-a')).byteLength, 20); timestamp++;
  await cache.put('v:date:city-c', new ArrayBuffer(40));
  assert.deepEqual([...h.records.keys()].sort(), ['v:date:city-a', 'v:date:city-c']);
  assert.equal(h.opens, 1);
  assert.equal(h.records.get('v:date:city-a').bytes.byteLength, 20);
  timestamp += 1001;
  assert.equal(await cache.get('v:date:city-a'), null);
  assert.equal(h.records.has('v:date:city-a'), false);
  await cache.put('v:date:city-d', new ArrayBuffer(10));
  assert.deepEqual([...h.records.keys()], ['v:date:city-d']);
});

test('a separate device cache preserves existing natal client records without expiring immutable data', async t => {
  const natal = databaseHarness(), cycles = databaseHarness(); let now = 0;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: natal.indexedDB });
  t.after(() => previous ? Object.defineProperty(globalThis, 'indexedDB', previous) : delete globalThis.indexedDB);
  const chart = personalChartFixture(), key = `${NATAL_DAY_VERSION}:${chart.birthDate}:${chart.cityId}`;
  natal.records.set(key, { key, bytes: encodeNatalDay(natalDayFixture()).buffer, createdAt: Date.now(), accessedAt: Date.now() });
  const client = createNatalDayClient({ fetch: () => { throw new Error('Existing natal packet must not need a request'); } });
  assert.equal((await client.getDay(chart)).date, chart.birthDate);
  const cache = createBinaryCache({ indexedDB: cycles.indexedDB, databaseName: 'bodygraph-cycles', maxAgeMs: Infinity, now: () => now });
  await cache.put('version:birth:event', new ArrayBuffer(12)); now = 10 * 365 * 86400000;
  assert.equal((await cache.get('version:birth:event')).byteLength, 12);
  assert.deepEqual(natal.names, ['bodygraph-chart-days']); assert.deepEqual(cycles.names, ['bodygraph-cycles']);
});

test('device cache enforces a byte budget, rejects oversized records and handles version invalidation', async () => {
  const h = databaseHarness();
  let timestamp = 100;
  const cache = createBinaryCache({ databaseName: 'test-packets', indexedDB: h.indexedDB, capacity: 4, maxBytes: 60, now: () => timestamp });
  await cache.put('a', new ArrayBuffer(30)); timestamp++;
  await cache.put('b', new ArrayBuffer(40));
  assert.deepEqual([...h.records.keys()], ['b']);
  await cache.put('large', new ArrayBuffer(61));
  assert.equal(h.records.has('large'), false);
  await cache.remove('b');
  assert.equal(h.records.size, 0);
  h.database.onversionchange();
  await cache.get('a');
  assert.equal(h.opens, 2);
});

test('blocked, denied or missing IndexedDB never fails the day-loading path', async t => {
  for (const indexedDB of [null, { open() { throw new Error('Denied'); } }, { open() {
    const request = {}; queueMicrotask(() => request.onblocked?.()); return request;
  } }]) {
    const cache = createBinaryCache({ databaseName: 'test-packets', indexedDB });
    assert.equal(await cache.get('a'), null);
    await cache.put('a', new ArrayBuffer(10));
    await cache.remove('a');
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stalled = createBinaryCache({ databaseName: 'test-packets', indexedDB: { open: () => ({}) }, timeoutMs: 100 });
  const pending = stalled.get('a');
  for (let i = 0; i < 4; i++) await Promise.resolve();
  t.mock.timers.tick(100);
  assert.equal(await pending, null);
});


test('cache hits touch metadata without rewriting the binary payload', async () => {
  const h = databaseHarness();
  const cache = createBinaryCache({ databaseName: 'packets', indexedDB: h.indexedDB });
  await cache.put('day', new ArrayBuffer(276906));
  h.operations.length = 0;
  assert.equal((await cache.get('day')).byteLength, 276906);
  assert.equal(h.operations.filter(([store, op]) => store === 'packets' && op === 'put').length, 0);
});

test('eviction never loads existing binary payloads', async () => {
  const h = databaseHarness();
  const cache = createBinaryCache({ databaseName: 'packets', indexedDB: h.indexedDB, capacity: 2 });
  await cache.put('a', new ArrayBuffer(100));
  await cache.put('b', new ArrayBuffer(100));
  h.operations.length = 0;
  await cache.put('c', new ArrayBuffer(100));
  assert.equal(h.records.size, 2);
  assert.equal(h.operations.filter(([store, op]) => store === 'packets' && ['getAll', 'get', 'openCursor'].includes(op)).length, 0);
});

test('version-one migration preserves original creation time and expiry', async () => {
  const h = databaseHarness();
  h.records.set('old', { key: 'old', bytes: new ArrayBuffer(15), createdAt: 20, accessedAt: 30 });
  let timestamp = 100;
  const cache = createBinaryCache({ databaseName: 'packets', indexedDB: h.indexedDB, maxAgeMs: 100, now: () => timestamp });
  assert.equal((await cache.get('old')).byteLength, 15);
  timestamp = 121;
  assert.equal(await cache.get('old'), null);
  assert.equal(h.records.has('old'), false);
  assert.equal(h.metadata.has('old'), false);
});

test('corrupt and orphaned cache halves are discarded together', async () => {
  const h = databaseHarness();
  const cache = createBinaryCache({ databaseName: 'packets', indexedDB: h.indexedDB });
  await cache.put('missing-payload', new ArrayBuffer(10));
  h.records.delete('missing-payload');
  assert.equal(await cache.get('missing-payload'), null);
  assert.equal(h.metadata.has('missing-payload'), false);
  await cache.put('missing-metadata', new ArrayBuffer(10));
  h.metadata.delete('missing-metadata');
  assert.equal(await cache.get('missing-metadata'), null);
  assert.equal(h.records.has('missing-metadata'), false);
  await cache.put('wrong-size', new ArrayBuffer(10));
  h.records.set('wrong-size', { key: 'wrong-size', bytes: new ArrayBuffer(11) });
  assert.equal(await cache.get('wrong-size'), null);
  assert.equal(h.metadata.has('wrong-size'), false);
  assert.equal(h.records.has('wrong-size'), false);
});

test('a stalled transaction is aborted at its deadline and does not become a late successful hit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let aborted = false, transaction;
  const database = { close() {}, transaction() {
    transaction = { objectStore: () => ({ get: () => ({}) }), abort() { aborted = true; transaction.onabort?.(); } };
    return transaction;
  } };
  const indexedDB = { open() { const request = { result: database }; queueMicrotask(() => request.onsuccess()); return request; } };
  const cache = createBinaryCache({ databaseName: 'packets', indexedDB, timeoutMs: 100 });
  const result = cache.get('stalled');
  for (let i = 0; i < 6; i++) await Promise.resolve();
  t.mock.timers.tick(100);
  assert.equal(await result, null);
  assert.equal(aborted, true);
  transaction.oncomplete();
});

test('blocked upgrades return promptly and close a late connection', async () => {
  let closed = 0, request;
  const cache = createBinaryCache({ databaseName: 'packets', indexedDB: { open() {
    request = { result: { close() { closed++; } } };
    queueMicrotask(() => request.onblocked()); return request;
  } } });
  assert.equal(await cache.get('a'), null);
  request.onsuccess();
  assert.equal(closed, 1);
});

for (const blocked of [true, false]) test(`${blocked ? 'blocked' : 'timed-out'} open stays singular until the browser settles it, then can recover`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const healthy = databaseHarness();
  let opens = 0, request, closed = 0;
  const cache = createBinaryCache({ databaseName: 'packets', timeoutMs: 100, indexedDB: { open(...args) {
    if (++opens > 1) return healthy.indexedDB.open(...args);
    request = { result: { close() { closed++; } } };
    if (blocked) queueMicrotask(() => request.onblocked());
    return request;
  } } });
  const first = cache.get('a');
  for (let i = 0; i < 4; i++) await Promise.resolve();
  if (!blocked) t.mock.timers.tick(100);
  assert.equal(await first, null);
  for (let i = 0; i < 10; i++) assert.equal(await cache.get('a'), null);
  assert.equal(opens, 1, 'no additional physical open while the first is unresolved');
  if (blocked) request.onerror();
  else { request.onsuccess(); assert.equal(closed, 1, 'late connection is closed'); }
  await cache.put('a', new ArrayBuffer(12));
  assert.equal((await cache.get('a')).byteLength, 12);
  assert.equal(opens, 2, 'retry only after the original open has actually settled');
});
