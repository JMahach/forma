import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createMomentCache } from '../src/data/moment-cache.js';

const version = 'a'.repeat(64), other = 'b'.repeat(64);
const start = Date.parse('2026-10-09T00:00:00Z');
const iso = ms => new Date(ms).toISOString().replace('.000Z', 'Z');
const meta = { calculationVersion: version, engine: 'test', ephemeris: 'test', timezoneDatabase: 'test', nodeModel: 'true', zodiac: 'tropical-geocentric-apparent' };
const day = () => ({ ...meta, version: '2', date: '2026-10-09', startUtc: iso(start), stepSeconds: 60, samples: 1440,
  columns: Array.from({ length: 24 }, (_, c) => Float64Array.from({ length: 1440 }, (_, i) => c < 22 ? (c + i / 100) % 360 : c === 22 ? (start / 1000 - 88 * 86400 + i * 60) : 1e-10)) });
const moment = (ms, angle = 5) => ({ utc: iso(ms), longitudes: Array(11).fill(angle),
  design: { utc: iso(ms), designUtc: iso(Math.floor(ms / 1000) * 1000 - 88 * 86400000), longitudes: Array(11).fill(angle + 1), designArcResidualDegrees: 1e-10 } });
function cache(t, options = {}) {
  const value = createMomentCache({ indexedDB: new IDBFactory(), ...options });
  t.after(() => value.close());
  return value;
}

test('full day supplies immutable moments and survives browser-cache restart without transport', async t => {
  const indexedDB = new IDBFactory(), a = cache(t, { indexedDB });
  const input = day(); a.putDay(input); input.columns[0][751] = 222;
  assert.equal(a.peekMoment(start + 751 * 60000, version).longitudes[0], 7.51);
  const sample = a.peekMoment(start + 751 * 60000, version);
  assert.throws(() => { sample.longitudes[0] = 100; }, TypeError);
  await a.flush();
  const b = cache(t, { indexedDB }); await b.ready;
  assert.equal(b.hasMinute(start + 751 * 60000, version), true, 'disk catalogue supplies minute precision before payload read');
  assert.equal(b.peekMoment(start + 751 * 60000, version), null);
  assert.deepEqual(await b.readMoment(start + 751 * 60000, version), sample);
  assert.equal(await b.readMoment(start + 751 * 60000, other), null);
});

test('two tabs atomically merge sparse moments, then a full day absorbs duplicate minutes and keeps exact seconds', async t => {
  const indexedDB = new IDBFactory(), a = cache(t, { indexedDB }), b = cache(t, { indexedDB });
  const exact = start + 37123;
  a.putMoment(moment(start + 60000), meta); b.putMoment(moment(exact), meta);
  await Promise.all([a.flush(), b.flush()]);
  a.putDay(day()); b.putMoment(moment(start + 120000), meta);
  await Promise.all([a.flush(), b.flush()]);
  const c = cache(t, { indexedDB }); await c.ready;
  assert.equal((await c.readMoment(start + 120000, version)).longitudes[0], 0.02, 'full day owns duplicate whole minutes');
  assert.deepEqual(await c.readMoment(exact, version), moment(exact));
  assert.equal((await c.getDay('2026-10-09', version)).samples, 1440);
});

test('memory and disk have byte budgets; a stale minute catalogue is a miss, never a calculation', async t => {
  const indexedDB = new IDBFactory(), a = cache(t, { indexedDB, maxMemoryBytes: 600, maxDiskBytes: 600 });
  a.putMoment(moment(start + 60000), meta); await a.flush();
  const b = cache(t, { indexedDB, maxMemoryBytes: 600, maxDiskBytes: 600 }); await b.ready;
  assert.equal(b.hasMinute(start + 60000, version), true);
  a.putMoment(moment(start + 86400000), meta); await a.flush();
  a.putMoment(moment(start + 2 * 86400000), meta); await a.flush();
  assert.ok(a.memoryBytes <= 600);
  assert.equal(await b.readMoment(start + 60000, version), null);
  assert.equal(b.hasMinute(start + 60000, version), false);
});

test('disabled storage still gives immediate memory hits and explicit misses', async t => {
  const a = cache(t, { indexedDB: null }); await a.ready;
  a.putMoment(moment(start), meta);
  assert.deepEqual(a.peekMoment(start, version), moment(start));
  assert.equal(await a.readMoment(start + 60000, version), null);
  await a.flush();
});

test('touching a changed sparse packet cannot overwrite its new minute coverage', async t => {
  const indexedDB = new IDBFactory(), a = cache(t, { indexedDB });
  a.putMoment(moment(start), meta); await a.flush();
  a.putMoment(moment(start + 60000), meta); a.peekMoment(start + 60000, version); await a.flush();
  const b = cache(t, { indexedDB }); await b.ready;
  assert.equal(b.hasMinute(start, version), true); assert.equal(b.hasMinute(start + 60000, version), true);
});

test('a partial RAM packet reads and merges a fuller disk packet without hiding saved minutes', async t => {
  const indexedDB = new IDBFactory(), a = cache(t, { indexedDB });
  a.putDay(day()); await a.flush();
  const b = cache(t, { indexedDB }); await b.ready;
  b.putMoment(moment(start + 37123), meta);
  assert.equal(b.hasMinute(start + 60000, version), true);
  assert.equal((await b.readMoment(start + 60000, version)).longitudes[0], 0.01);
  assert.equal((await b.getDay('2026-10-09', version)).ephemeris, 'test');
});

test('unavailable storage cannot leave an unbounded catalogue after numeric eviction', async t => {
  const a = cache(t, { indexedDB: null, maxMemoryBytes: 600, maxWriteBytes: 600 }); await a.ready;
  for (let i = 0; i < 1000; i++) { a.putMoment(moment(start + i * 86400000), meta); await a.flush(); }
  assert.ok(a.catalogueSize <= 2); assert.ok(a.memoryBytes <= 600);
});
