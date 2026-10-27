import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, forceCloseDatabase } from 'fake-indexeddb';
import { createIndexedDatabase } from '../src/data/indexed-db.ts';

// Connection lifetime belongs to this helper. Calculation adapters now open a
// common database plus fenced migration sources, so their open count is not its
// connection contract.
type DatabaseOptions = Parameters<typeof createIndexedDatabase>[0];
type TestOptions = Omit<Partial<DatabaseOptions>, 'indexedDB'> & { indexedDB: Pick<IDBFactory, 'open'> };
type PendingOpen = { result: { close(): void }; onblocked?: () => void; onsuccess?: () => void };

function create(options: TestOptions) {
  const database=createIndexedDatabase({databaseName:'connection-test',version:1,stores:['packets'],
    // The connection helper only calls open on the supplied factory.
    upgrade(db){db.createObjectStore('packets');},...options as Partial<DatabaseOptions>});
  return {
    read:()=>database.transaction('readonly',(tx,result)=>{const request=tx.objectStore('packets').get('key');request.onsuccess=()=>result(request.result??null);}),
    write:()=>database.transaction('readwrite',(tx,result)=>{tx.objectStore('packets').put(new ArrayBuffer(12),'key');result(true);}),
    close:()=>database.close(),
  };
}

  test('a denied open can recover on the next attempt', async t => {
    const healthy = new IDBFactory(); let attempts = 0;
    const cache = create({ indexedDB: { open(...args: Parameters<IDBFactory['open']>) {
      if (++attempts === 1) throw new Error('Temporarily denied');
      return healthy.open(...args);
    } } });
    t.after(() => cache.close?.());
    assert.equal(await cache.read(), null);
    await cache.write();
    assert.ok(await cache.read()); assert.equal(attempts, 2);
  });

  for (const blocked of [true, false] as const) test(`${blocked ? 'blocked' : 'timed-out'} open retries only after the native request settles`, async t => {
    const healthy = new IDBFactory(); let attempts = 0, request: PendingOpen, closed = 0;
    const cache = create({ timeoutMs: 50, indexedDB: { open(...args: Parameters<IDBFactory['open']>) {
      if (++attempts > 1) return healthy.open(...args);
      request = { result: { close() { closed++; } } };
      if (blocked) queueMicrotask(() => request.onblocked!());
      // Model only the late completion and close operations exercised here.
      return request as unknown as IDBOpenDBRequest;
    } } });
    t.after(() => cache.close?.());
    assert.equal(await cache.read(), null);
    for (let i = 0; i < 3; i++) assert.equal(await cache.read(), null);
    assert.equal(attempts, 1, 'never accumulate unresolved native open requests');
    request!.onsuccess!(); assert.equal(closed, 1, 'close the connection that arrived after our deadline');
    await cache.write();
    assert.ok(await cache.read()); assert.equal(attempts, 2);
  });
test('a connection closed by the browser is reopened on the next operation', async t => {
  const indexedDB = new IDBFactory(); let database: IDBDatabase | undefined, opens = 0;
  const cache = create({ indexedDB: { open(...args: Parameters<IDBFactory['open']>) {
    opens++;
    const request = indexedDB.open(...args);
    request.addEventListener('success', () => { database = request.result; });
    return request;
  } } });
  t.after(() => cache.close?.());
  await cache.write(); assert.ok(await cache.read());
  // fake-indexeddb declares a constructor here, but closes an existing connection.
  forceCloseDatabase(database! as unknown as Parameters<typeof forceCloseDatabase>[0]);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(await cache.read(), 'saved values survive reconnect');
  await cache.write(); assert.ok(await cache.read());
  assert.equal(opens, 2);
});

for (const stage of ['open', 'request', 'upgrade'] as const) test(`quota during ${stage} stays distinguishable and a later opening can recover`, async t => {
  const native = new IDBFactory(); let full = true, aborted = 0;
  const factory = {open(...args: Parameters<IDBFactory['open']>) {
    if (full && stage === 'open') throw new DOMException('Full', 'QuotaExceededError');
    if (full && stage === 'request') {
      const failed = {error: new DOMException('Full', 'QuotaExceededError'), onerror: null as (() => void) | null};
      queueMicrotask(() => failed.onerror?.());
      return failed as unknown as IDBOpenDBRequest;
    }
    return native.open(...args);
  }} as IDBFactory;
  const database = createIndexedDatabase({indexedDB: factory, databaseName: `quota-${stage}`, version: 1, stores: ['packets'],
    upgrade(db, tx) {
      db.createObjectStore('packets');
      if (full && stage === 'upgrade') {
        tx.addEventListener('abort', () => { aborted++; });
        throw new DOMException('Full', 'QuotaExceededError');
      }
    }});
  t.after(() => database.close());
  const write = () => database.transactionResult('readwrite', (tx, result) => {
    tx.objectStore('packets').put('saved', 'key'); result(true);
  });
  assert.deepEqual(await write(), {status: 'quota'});
  if (stage === 'upgrade') assert.equal(aborted, 1, 'only report quota after the schema transaction rolls back');
  full = false;
  assert.deepEqual(await write(), {status: 'complete', value: true});
  assert.equal(await database.transaction('readonly', (tx, result) => {
    const request = tx.objectStore('packets').get('key'); request.onsuccess = () => result(request.result);
  }), 'saved');
});
