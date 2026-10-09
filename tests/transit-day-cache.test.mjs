import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createTransitDayCache } from '../src/data/transit-day-cache.js';
import { createMemoryCache } from '../src/data/memory-cache.js';
const version = 'a'.repeat(64), other = 'b'.repeat(64);
const start = Date.parse('2026-10-09T00:00:00Z');
function day(offset = 0) {
  const ms = start + offset * 86400000, date = new Date(ms).toISOString().slice(0, 10);
  return { version: '2', calculationVersion: version, date, startUtc: `${date}T00:00:00Z`, samples: 1440, stepSeconds: 60,
    engine: 'test', ephemeris: 'test', timezoneDatabase: 'test', nodeModel: 'true', zodiac: 'tropical-geocentric-apparent',
    columns: Array.from({ length: 24 }, (_, c) => Float64Array.from({ length: 1440 }, (_, i) => c < 22 ? (c + i / 100) % 360 : c === 22 ? ms / 1000 - 88 * 86400 + i * 60 : 1e-10)) };
}
function cache(t, options = {}) {
  const c = createTransitDayCache({ indexedDB: new IDBFactory(), ...options });
  t.after(() => c.close()); return c;
}
async function open(indexedDB) {
  return new Promise((resolve, reject) => { const request = indexedDB.open('forma-moments', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
async function edit(db, action) {
  return new Promise((resolve, reject) => { const tx = db.transaction(['packets', 'catalogue'], 'readwrite'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); action(tx); });
}
test('a full day survives reload; coverage is available before reading its numbers', async t => {
  const indexedDB = new IDBFactory(), first = cache(t, { indexedDB }), value = day();
  first.putDay(value); await first.flush();
  assert.equal(first.peekDay(value.date, version), value, 'RAM retains one decoded object without copying its columns');
  const second = cache(t, { indexedDB }); await second.prepare(version);
  assert.equal(second.hasMinute(start + 751 * 60000, version), true);
  assert.equal(second.peekDay(value.date, version), null);
  const loaded = await second.getDay(value.date, version);
  assert.deepEqual(loaded, value);
  assert.equal(loaded.columns[0].buffer, loaded.columns[23].buffer, 'IDB data is exposed through views, not copied twice');
  assert.equal(await second.getDay(value.date, other), null);
  assert.equal(second.hasMinute(start + 1000, version), false);
});
test('all received full days remain on disk after RAM eviction and an old timestamp', async t => {
  const indexedDB = new IDBFactory(), memory = createMemoryCache({ maxBytes: 300000 });
  const first = cache(t, { indexedDB, memory });
  for (let i = 0; i < 10; i++) { first.putDay(day(i)); await first.flush(); }
  assert.equal(memory.size, 1); assert.equal(first.peekDay(day().date, version), null);
  const db = await open(indexedDB); t.after(() => db.close());
  await edit(db, tx => { const key = `${version}:${day().date}`, request = tx.objectStore('packets').get(key); request.onsuccess = () => tx.objectStore('packets').put({ ...request.result, createdAt: 0, accessedAt: 0 }); });
  const second = cache(t, { indexedDB }); await second.prepare(version);
  for (let i = 0; i < 10; i++) assert.deepEqual(await second.getDay(day(i).date, version), day(i));
});
test('legacy sparse packets are ignored and preserved', async t => {
  const indexedDB = new IDBFactory(), first = cache(t, { indexedDB }); await first.prepare(version);
  const db = await open(indexedDB); t.after(() => db.close());
  const key = `${version}:${day().date}`;
  await edit(db, tx => {
    tx.objectStore('packets').put({ key, date: day().date, version, offsets: new Uint32Array([0]), values: new Float64Array(24) });
    tx.objectStore('catalogue').put({ key, date: day().date, version, full: 0 });
  });
  const second = cache(t, { indexedDB }); await second.prepare(version);
  assert.equal(second.hasMinute(start, version), false);
  assert.equal(await second.getDay(day().date, version), null);
  const exists = await new Promise(resolve => { const request = db.transaction('packets').objectStore('packets').get(key); request.onsuccess = () => resolve(request.result); });
  assert.ok(exists);
});
test('quota failure retains RAM but never advertises a saved day after eviction', async t => {
  const indexedDB = new IDBFactory(), memory = createMemoryCache({ maxBytes: 300000 });
  const first = cache(t, { indexedDB, memory }); await first.prepare(version);
  const db = await open(indexedDB); t.after(() => db.close());
  const prototype = Object.getPrototypeOf(db.transaction('packets').objectStore('packets'));
  const original = prototype.put;
  prototype.put = function() { throw new DOMException('Full', 'QuotaExceededError'); };
  try { first.putDay(day()); await first.flush(); }
  finally { prototype.put = original; }
  assert.equal(first.hasMinute(start, version), true);
  memory.put('return-chart:other', new Uint8Array(300000));
  assert.equal(first.hasMinute(start, version), false);
  assert.equal(await first.getDay(day().date, version), null);
});
test('active full days stay within the common ownership policy and release under pressure', async t => {
  const memory = createMemoryCache({ maxBytes: 300000 }), first = cache(t, { indexedDB: null, memory });
  const value = day(), release = first.retainDay(value);
  memory.put('return-chart:a', new Uint8Array(100000));
  assert.equal(first.peekDay(value.date, version), value);
  assert.equal(memory.get('return-chart:a'), null);
  release(); memory.put('return-chart:b', new Uint8Array(300000));
  assert.equal(first.peekDay(value.date, version), null);
});
test('an aborted coverage scan cannot advertise partial records', async t => {
  const indexedDB = new IDBFactory(), first = cache(t, { indexedDB }); first.putDay(day()); await first.flush();
  const db = await open(indexedDB); t.after(() => db.close());
  const prototype = Object.getPrototypeOf(db.transaction('catalogue').objectStore('catalogue').index('full'));
  const original = prototype.openCursor;
  prototype.openCursor = function(...args) {
    const request = original.apply(this, args);
    request.addEventListener('success', () => { if (request.result === null) this.objectStore.transaction.abort(); });
    return request;
  };
  const second = cache(t, { indexedDB });
  try { await second.prepare(version); } finally { prototype.openCursor = original; }
  assert.equal(second.hasMinute(start, version), false);
});
test('coverage can recover after an unavailable database open', async t => {
  const native = new IDBFactory(); const writer = cache(t, { indexedDB: native }); writer.putDay(day()); await writer.flush();
  let attempts = 0;
  const indexedDB = { open(...args) { if (++attempts > 1) return native.open(...args); const request = {}; queueMicrotask(() => request.onerror()); return request; } };
  const reader = cache(t, { indexedDB }); await reader.prepare(version);
  assert.equal(reader.hasMinute(start, version), false);
  await reader.prepare(version);
  assert.equal(reader.hasMinute(start, version), true);
});
test('an overlapping fresh day wins over an older disk miss even with zero spare RAM', async t => {
  const indexedDB = new IDBFactory(), memory = createMemoryCache({ maxBytes: 0 });
  const c = cache(t, { indexedDB, memory }); await c.prepare(version);
  const pending = c.getDay(day().date, version), input = day();
  c.putDay(input);
  assert.ok(await pending === input);
  await c.flush();
});
