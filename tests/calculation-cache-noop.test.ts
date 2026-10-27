import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createCalculationCache } from '../src/data/calculation-cache.ts';

const version = 'a'.repeat(64), versions = { natal: version, returns: version };
const start = Date.parse('2026-10-26T12:00:00Z');
const window = { version, dates: ['2026-10-26'], expiresAt: start + 86400000 };

async function fixture(t: test.TestContext) {
  let now = start;
  const indexedDB = new IDBFactory(), options = { indexedDB, legacySources: [], now: () => now };
  const a = createCalculationCache(options), b = createCalculationCache(options);
  t.after(() => { a.close(); b.close(); });
  await a.confirmVersions(versions);
  await a.setTransitWindow(window);
  await a.put('natal', 'current', Uint8Array.of(1, 2), { version });
  await b.status();
  return { a, b, advance(ms: number) { now += ms; } };
}

test('confirming unchanged versions in ready storage does not scan, rewrite or notify peers', async t => {
  const { a, b } = await fixture(t), before = await a.status();
  let scans = 0, writes = 0, changes = 0;
  const openCursor = IDBObjectStore.prototype.openCursor, put = IDBObjectStore.prototype.put;
  t.mock.method(IDBObjectStore.prototype, 'openCursor', function(this: IDBObjectStore, ...args: Parameters<typeof openCursor>) {
    if (this.name === 'catalogue') scans++;
    return openCursor.apply(this, args);
  });
  t.mock.method(IDBObjectStore.prototype, 'put', function(this: IDBObjectStore, ...args: Parameters<typeof put>) {
    if (this.name === 'control') writes++;
    return put.apply(this, args);
  });
  b.subscribe(() => changes++);
  for (let i = 0; i < 5; i++) assert.deepEqual(await a.confirmVersions(versions, { previous: versions }), { status: 'applied' });
  assert.equal(scans, 0); assert.equal(writes, 0); assert.equal(changes, 0);
  assert.deepEqual(await a.status(), before);
  assert.deepEqual(await b.get('natal', 'current'), Uint8Array.of(1, 2));
});

test('an identical transit window keeps its revision without notifying peers', async t => {
  const { a, b } = await fixture(t), before = await a.status();
  assert.ok('window' in before && before.window);
  let changes = 0;
  b.subscribe(() => changes++);
  for (let i = 0; i < 5; i++) assert.deepEqual(await a.setTransitWindow({ ...window, dates: [...window.dates] }, {
    expectedRevision: before.window.revision, expectedVersions: versions,
  }), { status: 'applied', revision: before.window.revision });
  assert.equal(changes, 0);
  assert.deepEqual(await a.status(), before);
});

test('unchanged versions still remove transit data when the confirmed window has expired', async t => {
  const { a, b, advance } = await fixture(t);
  await a.put('transit', 'day', new Uint8Array(100), { version, date: window.dates[0] });
  const before = await a.status();
  let changes = 0; b.subscribe(() => changes++);
  advance(86400000);
  assert.deepEqual(await a.confirmVersions(versions), { status: 'applied' });
  const after = await a.status();
  assert.ok(after.accountedBytes! < before.accountedBytes!);
  assert.equal(changes, 1);
  assert.equal(await b.get('transit', 'day'), null);
  assert.deepEqual(await b.get('natal', 'current'), Uint8Array.of(1, 2));
});

test('unchanged versions do not skip reconciliation before storage reaches ready', async t => {
  const cache = createCalculationCache({ indexedDB: new IDBFactory(), legacySources: [] });
  t.after(() => cache.close());
  await cache.confirmVersions(versions);
  const before = await cache.status();
  assert.equal(before.phase, 'scanning');
  await cache.confirmVersions(versions);
  const after = await cache.status();
  assert.ok('revision' in before && 'revision' in after);
  assert.equal(after.revision, before.revision + 1);
});

test('real version and window transitions still notify peers, prune old data and reject stale tabs', async t => {
  const { a, b } = await fixture(t);
  await a.put('transit', 'old-day', new Uint8Array(100), { version, date: window.dates[0] });
  const before = await a.status();
  assert.ok('window' in before && before.window);
  const next = 'b'.repeat(64), nextVersions = { natal: next, returns: next };
  let changes = 0; b.subscribe(() => changes++);
  assert.deepEqual(await a.confirmVersions(nextVersions, { previous: versions }), { status: 'applied' });
  assert.equal(changes, 1);
  assert.equal(await b.get('natal', 'current'), null);
  assert.deepEqual(await a.setTransitWindow({ ...window, version: next }, {
    previousVersion: version, expectedRevision: before.window.revision, expectedVersions: nextVersions,
  }), { status: 'applied', revision: before.window.revision + 1 });
  assert.equal(changes, 2);
  assert.equal(await b.get('transit', 'old-day'), null);
  assert.deepEqual(await b.confirmVersions(versions, { previous: versions }), { status: 'stale' });
  assert.deepEqual(await b.setTransitWindow(window, { expectedVersions: versions }), { status: 'stale' });
  assert.equal(changes, 2);
});
