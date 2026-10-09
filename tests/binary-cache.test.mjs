import test from 'node:test';
import assert from 'node:assert/strict';
import { createBinaryCache } from '../src/data/binary-cache.js';
// Exercise asynchronous transaction completion and access with a small
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

test('explicit removal and version changes retain the surviving days and reopen the connection', async () => {
  const h = databaseHarness();
  const cache = createBinaryCache({ databaseName: 'test-packets', indexedDB: h.indexedDB });
  await cache.put('a', new ArrayBuffer(30));
  await cache.put('b', new ArrayBuffer(40));
  await cache.remove('b');
  assert.deepEqual([...h.records.keys()], ['a']);
  h.database.onversionchange();
  assert.equal((await cache.get('a')).byteLength, 30);
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


test('cache hits do not rewrite payloads or legacy metadata', async () => {
  const h = databaseHarness();
  const cache = createBinaryCache({ databaseName: 'packets', indexedDB: h.indexedDB });
  await cache.put('day', new ArrayBuffer(276906));
  h.operations.length = 0;
  assert.equal((await cache.get('day')).byteLength, 276906);
  assert.deepEqual(h.operations, [['packets', 'get']]);
});

test('adding a day never scans or evicts existing packets', async () => {
  const h = databaseHarness();
  const cache = createBinaryCache({ databaseName: 'packets', indexedDB: h.indexedDB });
  await cache.put('a', new ArrayBuffer(100));
  await cache.put('b', new ArrayBuffer(100));
  h.operations.length = 0;
  await cache.put('c', new ArrayBuffer(100));
  assert.equal(h.records.size, 3);
  assert.deepEqual(h.operations, [['packets', 'put']]);
});

test('legacy timestamps and missing metadata never expire intact bytes; invalid values remain a miss', async () => {
  const h = databaseHarness();
  h.records.set('old', { key: 'old', bytes: new ArrayBuffer(15), createdAt: 0, accessedAt: 0 });
  const cache = createBinaryCache({ databaseName: 'packets', indexedDB: h.indexedDB });
  assert.equal((await cache.get('old')).byteLength, 15);
  assert.equal(h.records.has('old'), true);
  assert.equal(h.metadata.size, 0);
  h.records.set('bad', { key: 'bad', bytes: 'not binary' });
  assert.equal(await cache.get('bad'), null);
  assert.equal(await cache.get('missing'), null);
  await cache.put('bad', 'still not binary');
  assert.equal(await cache.get('bad'), null);
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
