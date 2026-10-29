import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createCalculationCache } from '../src/data/calculation-cache.ts';

const start = Date.parse('2026-10-26T12:00:00Z');
const window = { dates: ['2026-10-26'], expiresAt: start + 86400000 };

async function fixture(t: test.TestContext) {
  let now = start;
  const indexedDB = new IDBFactory(), options = { indexedDB, legacySources: [], now: () => now };
  const a = createCalculationCache(options), b = createCalculationCache(options);
  t.after(() => { a.close(); b.close(); });
  await a.setTransitWindow(window);
  await a.put('natal', 'current', Uint8Array.of(1, 2));
  await b.status();
  return { a, b, advance(ms: number) { now += ms; } };
}

test('an identical transit window keeps its revision without notifying peers', async t => {
  const { a, b } = await fixture(t), before = await a.status();
  assert.ok('window' in before && before.window);
  let changes = 0, scans = 0, writes = 0;
  const cursor=IDBObjectStore.prototype.openCursor,put=IDBObjectStore.prototype.put;
  t.mock.method(IDBObjectStore.prototype,'openCursor',function(this:IDBObjectStore,...args:Parameters<typeof cursor>){if(this.name==='catalogue')scans++;return cursor.apply(this,args);});
  t.mock.method(IDBObjectStore.prototype,'put',function(this:IDBObjectStore,...args:Parameters<typeof put>){writes++;return put.apply(this,args);});
  b.subscribe(() => changes++);
  for (let i = 0; i < 5; i++) assert.deepEqual(await a.setTransitWindow({ ...window, dates: [...window.dates] }, {
    expectedRevision: before.window.revision,
  }), { status: 'applied', revision: before.window.revision });
  assert.equal(changes, 0);assert.equal(scans,0);assert.equal(writes,0);
  assert.deepEqual(await a.status(), before);
});

test('a new local window prunes old transit data, keeps personal data and rejects a stale tab', async t => {
  const { a, b } = await fixture(t);
  await a.put('transit', 'old-day', new Uint8Array(100), {date: window.dates[0]});
  const before = await a.status();assert.ok('window' in before && before.window);
  let changes=0;b.subscribe(()=>changes++);
  const changed={dates:['2026-10-27'],expiresAt:window.expiresAt+86400000};
  assert.deepEqual(await a.setTransitWindow(changed,{expectedRevision:before.window.revision}),{status:'applied',revision:before.window.revision+1});
  assert.equal(changes,1);
  assert.equal(await b.get('transit','old-day'),null);
  assert.deepEqual(await b.get('natal','current'),Uint8Array.of(1,2));
  assert.deepEqual(await b.setTransitWindow(window,{expectedRevision:before.window.revision}),{status:'stale'});
  assert.equal(changes,1);
});

test('steady status and catalogue reads use readonly transactions, while cache hits still touch LRU atomically', async t => {
  const { a } = await fixture(t);
  const { IDBDatabase } = await import('fake-indexeddb');
  const transaction = IDBDatabase.prototype.transaction;
  const modes: IDBTransactionMode[] = [];
  t.mock.method(IDBDatabase.prototype, 'transaction', function(this: IDBDatabase, stores: string[], mode: IDBTransactionMode, ...rest: []) {
    modes.push(mode); return transaction.call(this, stores, mode, ...rest);
  });
  for (let i = 0; i < 10; i++) await a.status();
  assert.equal(modes.filter(mode => mode === 'readwrite').length, 0);
  modes.length = 0;
  for (let i = 0; i < 10; i++) await a.catalogue('natal');
  assert.equal(modes.filter(mode => mode === 'readwrite').length, 0);
  modes.length = 0;
  await a.get('natal', 'current');
  assert.ok(modes.includes('readwrite'));
});

test('removing absent data succeeds without rewriting control or notifying peers', async t => {
  const { a, b } = await fixture(t), before = await a.status();
  let writes = 0, changes = 0;
  const put = IDBObjectStore.prototype.put;
  t.mock.method(IDBObjectStore.prototype, 'put', function(this: IDBObjectStore, ...args: Parameters<typeof put>) {
    if (this.name === 'control') writes++;
    return put.apply(this, args);
  });
  b.subscribe(() => changes++);
  for (let i = 0; i < 10; i++) assert.equal(await a.remove('natal', 'absent'), true);
  assert.equal(writes, 0); assert.equal(changes, 0);
  assert.deepEqual(await a.status(), before);
  assert.equal(await a.remove('natal', 'current'), true);
  assert.equal(writes, 1); assert.equal(changes, 1);
  assert.equal(await b.get('natal', 'current'), null);
});
