import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, forceCloseDatabase } from 'fake-indexeddb';
import { createBinaryCache } from '../src/data/binary-cache.ts';
import { createTransitDayCache } from '../src/data/transit-day-cache.ts';
import { createMemoryCache } from '../src/data/memory-cache.ts';

const version = 'a'.repeat(64), date = '2026-10-09';
const day = { calculationVersion: version, version: '2', date, startUtc: `${date}T00:00:00Z`, samples: 1440, stepSeconds: 60,
  engine: 'Swiss Ephemeris', ephemeris: 'test', timezoneDatabase: 'test', nodeModel: 'true', zodiac: 'tropical-geocentric-apparent',
  columns: Array.from({ length: 24 }, (_, column) => Float64Array.from({ length: 1440 }, (_, minute) =>
    column < 22 ? 1 : column === 22 ? Date.parse(date) / 1000 - 88 * 86400 + minute * 60 : 1e-10)) };
const kinds = {
  binary(options: { databaseName?: string; indexedDB?: IDBFactory|null; timeoutMs?: number; }|undefined) {
    const cache = createBinaryCache({ databaseName: 'binary', ...options });
    return { read: () => cache.get('key'), write: () => cache.put('key', new ArrayBuffer(12)) };
  },
  days(options) {
    const cache = createTransitDayCache({ databaseName: 'days', memory: createMemoryCache({ maxBytes: 0 }), ...options });
    return { read: () => cache.getDay(date, version), write: async () => { cache.putDay(day); await cache.flush(); }, close: () => cache.close() };
  },
};

for (const [kind, create] of Object.entries(kinds)) {
  test(`${kind}: a denied open can recover on the next attempt`, async t => {
    const healthy = new IDBFactory(); let attempts = 0;
    const cache = create({ indexedDB: { open(...args) {
      if (++attempts === 1) throw new Error('Temporarily denied');
      return healthy.open(...args);
    } } });
    t.after(() => cache.close?.());
    assert.equal(await cache.read(), null);
    await cache.write();
    assert.ok(await cache.read()); assert.equal(attempts, 2);
  });

  for (const blocked of [true, false] as const) test(`${kind}: ${blocked ? 'blocked' : 'timed-out'} open retries only after the native request settles`, async t => {
    const healthy = new IDBFactory(); let attempts = 0, request: IDBOpenDBRequest, closed = 0;
    const cache = create({ timeoutMs: 50, indexedDB: { open(...args) {
      if (++attempts > 1) return healthy.open(...args);
      request = { result: { close() { closed++; } } };
      if (blocked) queueMicrotask(() => request.onblocked!());
      return request;
    } } });
    t.after(() => cache.close?.());
    assert.equal(await cache.read(), null);
    for (let i = 0; i < 3; i++) assert.equal(await cache.read(), null);
    assert.equal(attempts, 1, 'never accumulate unresolved native open requests');
    request!.onsuccess!(); assert.equal(closed, 1, 'close the connection that arrived after our deadline');
    await cache.write();
    assert.ok(await cache.read()); assert.equal(attempts, 2);
  });
}


for (const [kind, create] of Object.entries(kinds)) test(`${kind}: a connection closed by the browser is reopened on the next operation`, async t => {
  const indexedDB = new IDBFactory(); let database, opens = 0;
  const cache = create({ indexedDB: { open(...args) {
    opens++;
    const request = indexedDB.open(...args);
    request.addEventListener('success', () => { database = request.result; });
    return request;
  } } });
  t.after(() => cache.close?.());
  await cache.write(); assert.ok(await cache.read());
  forceCloseDatabase(database!);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(await cache.read(), 'saved values survive reconnect');
  await cache.write(); assert.ok(await cache.read());
  assert.equal(opens, 2);
});
