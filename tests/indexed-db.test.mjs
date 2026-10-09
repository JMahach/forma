import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, forceCloseDatabase } from 'fake-indexeddb';
import { createBinaryCache } from '../src/data/binary-cache.js';
import { createMomentStorage } from '../src/data/moment-storage.js';
import { momentPacket } from '../src/data/moment-packet.js';

const packet = momentPacket({ utc: '2026-10-09T00:00:00Z', longitudes: Array(11).fill(1),
  design: { longitudes: Array(11).fill(2), designUtc: '2026-07-13T00:00:00Z', designArcResidualDegrees: 1e-10 } },
  { calculationVersion: 'a'.repeat(64) });
const kinds = {
  binary(options) {
    const cache = createBinaryCache({ databaseName: 'binary', ...options });
    return { read: () => cache.get('key'), write: () => cache.put('key', new ArrayBuffer(12)) };
  },
  moments(options) {
    const cache = createMomentStorage({ databaseName: 'moments', ...options });
    return { read: () => cache.read(packet.key), write: () => cache.write([packet]), close: () => cache.close() };
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

  for (const blocked of [true, false]) test(`${kind}: ${blocked ? 'blocked' : 'timed-out'} open retries only after the native request settles`, async t => {
    const healthy = new IDBFactory(); let attempts = 0, request, closed = 0;
    const cache = create({ timeoutMs: 50, indexedDB: { open(...args) {
      if (++attempts > 1) return healthy.open(...args);
      request = { result: { close() { closed++; } } };
      if (blocked) queueMicrotask(() => request.onblocked());
      return request;
    } } });
    t.after(() => cache.close?.());
    assert.equal(await cache.read(), null);
    for (let i = 0; i < 3; i++) assert.equal(await cache.read(), null);
    assert.equal(attempts, 1, 'never accumulate unresolved native open requests');
    request.onsuccess(); assert.equal(closed, 1, 'close the connection that arrived after our deadline');
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
  forceCloseDatabase(database);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(await cache.read(), 'saved values survive reconnect');
  await cache.write(); assert.ok(await cache.read());
  assert.equal(opens, 2);
});
