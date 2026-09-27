import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartDayCache } from '../src/data/natal-day-cache.js';

// Exercise asynchronous transaction completion and eviction with a small
// IndexedDB-compatible in-memory adapter, without requiring a browser session.
function databaseHarness() {
  const records = new Map();
  let opens = 0;
  const database = {
    objectStoreNames: { contains: () => true }, close() {},
    transaction() {
      const tx = {};
      let pending = 0;
      function request(action) {
        const result = {};
        pending++;
        queueMicrotask(() => {
          try { result.result = action(); result.onsuccess?.(); }
          catch { tx.onerror?.(); }
          pending--;
          queueMicrotask(() => { if (!pending) tx.oncomplete?.(); });
        });
        return result;
      }
      tx.objectStore = () => ({
        get: key => request(() => records.get(key)),
        put: entry => request(() => records.set(entry.key, structuredClone(entry))),
        delete: key => request(() => records.delete(key)),
        getAll: () => request(() => [...records.values()]),
      });
      return tx;
    },
  };
  return {
    records, database, get opens() { return opens; },
    indexedDB: { open() { opens++; const request = { result: database }; queueMicrotask(() => request.onsuccess?.()); return request; } },
  };
}

test('device cache retains only a bounded LRU collection of binary packets and expires old entries', async () => {
  const h = databaseHarness();
  let timestamp = 100;
  const cache = createChartDayCache({ indexedDB: h.indexedDB, capacity: 2, maxAgeMs: 1000, now: () => timestamp });
  await cache.put('v:date:city-a', new ArrayBuffer(20)); timestamp++;
  await cache.put('v:date:city-b', new ArrayBuffer(30)); timestamp++;
  assert.equal((await cache.get('v:date:city-a')).byteLength, 20); timestamp++;
  await cache.put('v:date:city-c', new ArrayBuffer(40));
  assert.deepEqual([...h.records.keys()].sort(), ['v:date:city-a', 'v:date:city-c']);
  assert.equal(h.opens, 1);
  assert.deepEqual(Object.keys(h.records.get('v:date:city-a')).sort(), ['accessedAt', 'bytes', 'createdAt', 'key']);
  timestamp += 1001;
  assert.equal(await cache.get('v:date:city-a'), null);
  assert.equal(h.records.has('v:date:city-a'), false);
  await cache.put('v:date:city-d', new ArrayBuffer(10));
  assert.deepEqual([...h.records.keys()], ['v:date:city-d']);
});

test('device cache enforces a byte budget, rejects oversized records and handles version invalidation', async () => {
  const h = databaseHarness();
  let timestamp = 100;
  const cache = createChartDayCache({ indexedDB: h.indexedDB, capacity: 4, maxBytes: 60, now: () => timestamp });
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
    const cache = createChartDayCache({ indexedDB });
    assert.equal(await cache.get('a'), null);
    await cache.put('a', new ArrayBuffer(10));
    await cache.remove('a');
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stalled = createChartDayCache({ indexedDB: { open: () => ({}) }, timeoutMs: 100 });
  const pending = stalled.get('a');
  for (let i = 0; i < 4; i++) await Promise.resolve();
  t.mock.timers.tick(100);
  assert.equal(await pending, null);
});
