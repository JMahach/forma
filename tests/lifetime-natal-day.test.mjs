import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCache } from '../src/data/memory-cache.js';
import { createNatalDayClient } from '../src/data/natal-day-client.js';
import { createLifetimeClient } from '../src/data/lifetime-client.js';
import { createLifetimeExplorer } from '../src/state/lifetime.js';
import { encodeNatalDay } from '../server/packets/encode.mjs';
import { chartAtMinute, natalDayMinute } from '../src/domain/natal-day.js';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.mjs';
import { LIFETIME_PLANETS } from '../shared/lifetime-format.js';
import { IDBFactory } from 'fake-indexeddb';
import { createTransitDayCache } from '../src/data/transit-day-cache.js';

const revision = 'a'.repeat(64), tick = () => new Promise(setImmediate);
const historical = () => natalDayFixture({ date: '1900-01-01', timezone: 'Europe/Paris', segments: [
  { index: 0, startUtc: '1899-12-31T23:50:39Z', offsetSeconds: 561, utcOffset: 'UTC+00:09:21', fold: 0 },
] });
const folded = () => natalDayFixture({ date: '2024-11-03', timezone: 'America/New_York', samples: 1500, segments: [
  { index: 0, startUtc: '2024-11-03T04:00:00Z', offsetSeconds: -14400, utcOffset: 'UTC−04:00', fold: 0 },
  { index: 120, startUtc: '2024-11-03T06:00:00Z', offsetSeconds: -18000, utcOffset: 'UTC−05:00', fold: 1 },
  { index: 180, startUtc: '2024-11-03T07:00:00Z', offsetSeconds: -18000, utcOffset: 'UTC−05:00', fold: 0 },
] });
function harness(raw = natalDayFixture(), { cold = false, memoryLimit, days = null } = {}) {
  const day = { ...raw, calculationVersion: revision }, storage = new Map(), memory = createMemoryCache(memoryLimit === undefined ? {} : { maxBytes: memoryLimit });
  let chart = personalChartFixture({ birthDate: day.date, timezone: day.timezone, utc: day.startUtc });
  const natalCalls = [], requests = []; let reads = 0;
  const persistentCache = { get: async key => { reads++; return storage.get(key); }, put: async (key, bytes) => storage.set(key, bytes), remove: async key => storage.delete(key) };
  const makeNatal = () => createNatalDayClient({ memory, calculationVersion: revision, persistentCache,
    fetch: async (url, options) => { natalCalls.push(url); return { ok: true, arrayBuffer: async () => encodeNatalDay(day).buffer }; } });
  const natal = makeNatal();
  const start = Date.parse(day.startUtc.slice(0, 10)), end = start + 3 * 86400000;
  const meta = { calculationVersion: revision, cacheVersion: revision, startUtc: new Date(start).toISOString().replace('.000Z', 'Z'),
    endExclusiveUtc: new Date(end).toISOString().replace('.000Z', 'Z'), samples: 432, stepSeconds: 600,
    planets: LIFETIME_PLANETS, engine: day.engine, nodeModel: day.nodeModel, zodiac: day.zodiac };
  const client = createLifetimeClient({ natalDayClient: natal, getPersonalChart: () => chart,
    days: days || { prepare: async () => {}, peekDay: () => null, getDay: async () => null, hasMinute: () => false },
    fetch: async url => {
      if (url.endsWith('/meta')) return { ok: true, json: async () => meta };
      requests.push(url);
      const query = new URL(url, 'http://test').searchParams;
      const index = query.has('index') ? Number(query.get('index')) : null;
      const utc = index === null ? query.get('utc') : new Date(start + index * 600000).toISOString().replace('.000Z', 'Z');
      return { ok: true, json: async () => ({ ...(index === null ? { version: '1' } : { index }), utc,
        longitudes: Array(11).fill(12), design: { utc, longitudes: Array(11).fill(34),
          designUtc: new Date(Date.parse(utc) - 88 * 86400000).toISOString().replace('.000Z', 'Z'), designArcResidualDegrees: 1e-12 } }) };
    } });
  return { natal, client, day, memory, storage, natalCalls, requests, meta, get reads() { return reads; }, chart: () => chart,
    setChart: value => { chart = value; },
    async prepare() { await natal.getDay(chart); await tick(); if (cold) { memory.delete(`natal-day:${revision}:1:${chart.birthDate}:${chart.cityId}`); } } };
}

test('cache-only natal day reads share prepared numbers without starting a day request', async () => {
  const h = harness();
  assert.equal(await h.natal.readDay(h.chart()), null); assert.deepEqual(h.natalCalls, []);
  await h.prepare();
  assert.equal(h.natal.peekDay(h.chart()), await h.natal.readDay(h.chart()));
  assert.equal(h.natal.peekDay({ ...h.chart(), birthDate: '2026-09-25' }), null);
  assert.equal(await h.natal.readDay({ ...h.chart(), timezone: 'Europe/Moscow' }), null);
  assert.equal(h.natalCalls.length, 1);
});

for (const [name, make, indices] of [['ordinary', () => natalDayFixture(), [700]], ['historical seconds', historical, [1, 100]], ['repeated local hour', folded, [90, 150]]]) {
  test(`lifetime reuses a prepared natal day after RAM eviction: ${name}`, async () => {
    const h = harness(make(), { cold: true }); await h.prepare(); await h.client.getMeta();
    for (const index of indices) {
      const utc = Date.parse(natalDayMinute(h.day, index).utc), expected = chartAtMinute(h.day, index, h.chart());
      assert.equal(h.client.hasMinute(utc), true);
      const actual = await h.client.getMinute(utc);
      assert.equal(actual.utc, expected.utc);
      assert.deepEqual(actual.activations, expected.activations);
      assert.equal(actual.designUtc, expected.designUtc);
    }
    assert.deepEqual(h.requests, []); assert.equal(h.natalCalls.length, 1);
  });
}

test('personal lifetime scrubs and steps on exact historical samples within the current bounds', async t => {
  const h = harness(historical()); await h.prepare();
  const first = Date.parse(natalDayMinute(h.day, 1).utc), next = first + 60000;
  const explorer = createLifetimeExplorer({ client: h.client }); t.after(() => explorer.close());
  assert.equal(await explorer.restore({ opened: true, mode: 'lifetime', fromDate: '1899-12-31', toDate: '1900-01-01', requestedUtc: first }), true);
  await explorer.scrub(next + 17000);
  assert.equal(explorer.state.requestedUtc, next); assert.equal(explorer.current.utc, new Date(next).toISOString().replace('.000Z', 'Z'));
  assert.equal(explorer.adjacentUtc(1), next + 60000); assert.equal(explorer.adjacentUtc(-1), first);
  await explorer.scrub(next, { minUtc: first + 1000, maxUtc: next - 1000 });
  assert.equal(explorer.state.requestedUtc, next, 'a narrow interval without any prepared/grid sample cannot invent one');
  await explorer.scrub(Date.parse('1900-01-01T00:10:39Z'));
  assert.equal(explorer.adjacentUtc(-1), Date.parse('1900-01-01T00:09:39Z'), 'an available natal minute stays local across a ten-minute grid boundary');
  assert.deepEqual(h.requests, []);
});

for (const direction of [1, -1]) test(`a historical step ${direction} offers the exact prepared sample before selecting it`, async t => {
  const h = harness(historical(), { memoryLimit: 0 }); await h.prepare();
  const explorer = createLifetimeExplorer({ client: h.client }); t.after(() => explorer.close());
  const current = Date.parse('1900-01-01T00:10:39Z');
  await explorer.restore({ opened: true, mode: 'lifetime', fromDate: '1899-12-31', toDate: '1900-01-01', requestedUtc: current });
  const expected = Date.parse(direction > 0 ? '1900-01-01T00:11:39Z' : '1900-01-01T00:09:39Z'), offered = [];
  await explorer.step(direction, null, utc => offered.push(utc));
  assert.deepEqual(offered, [expected], 'ownership sees the same exact natal sample that is selected');
  assert.equal(explorer.state.requestedUtc, expected);
  assert.equal(Date.parse(explorer.current.utc), expected);
  assert.deepEqual(h.requests, []);
});

test('a backward historical step offers the exact birth boundary to its owner', async t => {
  const h = harness(historical()); await h.prepare();
  const birth = Date.parse('1900-01-01T00:10:39Z'), current = Date.parse('1900-01-01T00:11:39Z');
  const explorer = createLifetimeExplorer({ client: h.client }); t.after(() => explorer.close());
  await explorer.restore({ opened: true, mode: 'lifetime', fromDate: '1900-01-01', toDate: '1900-01-01',
    minimumUtc: '1900-01-01T00:10:39Z', requestedUtc: current });
  const offered = []; let resetBirth = false;
  await explorer.step(-1, null, utc => {
    offered.push(utc);
    if (utc > birth) return;
    resetBirth = true;
    return false;
  });
  assert.deepEqual(offered, [birth]);
  assert.equal(resetBirth, true, 'the exact endpoint owner receives the birth command');
  assert.equal(explorer.state.requestedUtc, current, 'the endpoint owner prevents a manual lifetime selection');
  assert.deepEqual(h.requests, []);
});

test('natal reuse does not lend a rounded instant, another original chart, or a different numerical revision', async () => {
  const h = harness(historical()); await h.prepare(); await h.client.getMeta();
  const exact = Date.parse(natalDayMinute(h.day, 1).utc);
  assert.equal(h.client.peekMinute(Math.floor(exact / 60000) * 60000), null);
  h.setChart({ ...h.chart(), birthDate: '1900-01-02' });
  assert.equal(h.client.peekMinute(exact), null);
  await h.client.getMinute(exact); assert.equal(h.requests.length, 1); assert.match(h.requests[0], /23%3A51%3A39Z/);
});

test('a missing prepared natal day falls back to lifetime without calculating the whole natal day', async () => {
  const h = harness(); await h.client.getMeta();
  await h.client.getPoint(12);
  assert.equal(h.requests.length, 1); assert.deepEqual(h.natalCalls, []);
});

test('a different numerical revision cannot lend a natal day to lifetime', async () => {
  const h = harness(); await h.prepare(); h.meta.calculationVersion = 'b'.repeat(64);
  await h.client.getMeta();
  const utc = Date.parse(natalDayMinute(h.day, 700).utc);
  assert.equal(h.client.hasMinute(utc), false); assert.equal(h.client.peekMinute(utc), null);
  await h.client.getMinute(utc); assert.equal(h.requests.length, 1);
});

test('two cache-only natal readers cancel independently and do not wait for pending calculation', async () => {
  let resolveDisk, resolveNetwork, calls = 0;
  let bytes = null;
  const persistentCache = { get: async () => bytes, put() {} };
  const chart = personalChartFixture(), raw = { ...natalDayFixture(), calculationVersion: revision };
  const client = createNatalDayClient({ calculationVersion: revision, persistentCache,
    fetch: () => { calls++; return new Promise(resolve => { resolveNetwork = resolve; }); } });
  const calculation = client.getDay(chart); await tick(); assert.equal(calls, 1);
  persistentCache.get = () => new Promise(resolve => { resolveDisk = resolve; });
  const cancelled = new AbortController();
  const abandoned = client.readDay(chart, { signal: cancelled.signal }), surviving = client.readDay(chart);
  const rejected = assert.rejects(abandoned, { name: 'AbortError' });
  cancelled.abort(); resolveDisk(encodeNatalDay(raw).buffer);
  await rejected;
  const day = await surviving; assert.equal(day.date, chart.birthDate); assert.equal(calls, 1);
  assert.equal(client.peekDay(chart), day);
  resolveNetwork({ ok: true, arrayBuffer: async () => encodeNatalDay(raw).buffer }); await calculation;
});


test('a ready natal packet from disk is used even when the shared reuse budget cannot retain it', async () => {
  const h = harness(historical(), { memoryLimit: 0 }); await h.prepare();
  const expected = natalDayMinute(h.day, 1).utc;
  const chart = await h.client.getMinute(Date.parse(expected));
  assert.equal(chart.utc, expected);
  assert.deepEqual(h.requests, []);
  assert.equal(h.memory.size, 0);
});

for (const firstMode of ['readDay', 'getDay']) test(`a stale ${firstMode} disk miss rechecks numbers published to shared RAM`, async () => {
  let resolveFirst, reads = 0, calls = 0;
  const raw = { ...natalDayFixture(), calculationVersion: revision }, bytes = encodeNatalDay(raw).buffer;
  const chart = personalChartFixture();
  const client = createNatalDayClient({ calculationVersion: revision,
    persistentCache: { get() { return ++reads === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : firstMode === 'getDay' ? bytes : null; }, put() {} },
    fetch: async () => { calls++; return { ok: true, arrayBuffer: async () => bytes }; } });
  const first = client[firstMode](chart); await tick();
  const ready = await client[firstMode === 'readDay' ? 'getDay' : 'readDay'](chart);
  resolveFirst(null);
  assert.ok(await first === ready, 'the exact ready packet must win over a stale disk miss');
  assert.equal(calls, firstMode === 'readDay' ? 1 : 0);
});

test('switching the original natal prepares its stored day even when lifetime metadata was already loaded', async t => {
  const h = harness(); await h.prepare();
  const explorer = createLifetimeExplorer({ client: h.client, getPersonalChart: h.chart,
    getMomentState: () => ({ current: h.chart(), status: 'ready' }) });
  t.after(() => explorer.close());
  const snapshot = { opened: true, mode: 'lifetime', fromDate: h.day.date, toDate: h.day.date, requestedUtc: Date.parse(h.day.startUtc) };
  assert.equal(await explorer.restore(snapshot), true);
  const previous = [...h.storage.keys()][0], next = previous.replace('test-city', 'another-city');
  h.storage.set(next, h.storage.get(previous));
  h.setChart({ ...h.chart(), id: 'second-person', cityId: 'another-city' });
  assert.equal(h.natal.peekDay(h.chart()), null);
  assert.equal(await explorer.restore(snapshot), true);
  assert.equal(h.client.hasMinute(Date.parse(h.day.startUtc) + 60000), true);
  assert.equal(h.natalCalls.length, 1); assert.deepEqual(h.requests, []);
});


test('an absent natal day is checked once per active original, not twice for each distant point', async () => {
  const h = harness(); await h.client.getMeta();
  for (const index of [150, 151, 152]) await h.client.getPoint(index);
  assert.equal(h.reads, 1);
  assert.equal(h.requests.length, 3); assert.deepEqual(h.natalCalls, []);
  h.setChart({ ...h.chart(), cityId: 'next-city' }); await h.client.getMeta();
  assert.equal(h.reads, 2, 'the new original gets its own preparation');
});

test('evicting natal numbers retains only the active timeline and preserves the exact ready-minute step', async () => {
  const h = harness(historical()); await h.prepare(); await h.client.getMeta();
  h.memory.delete([...h.storage.keys()][0]);
  const utc = Date.parse(natalDayMinute(h.day, 1).utc);
  assert.equal(h.client.nearestMinute(utc + 17000), utc);
  assert.equal(h.client.hasMinute(utc), true);
  assert.equal(h.client.peekMinute(utc), null);
  const chart = await h.client.readMinute(utc);
  assert.equal(chart.utc, natalDayMinute(h.day, 1).utc);
  assert.deepEqual(h.requests, []);
});

test('a missing historical natal minute still reads the ready transit day for its grid fallback', async t => {
  const days = createTransitDayCache({ indexedDB: new IDBFactory(), memory: createMemoryCache({ maxBytes: 0 }) });
  t.after(() => days.close());
  const h = harness(historical(), { days }); await h.prepare();
  days.putDay({ ...h.day, version: '2', date: '1899-12-31', startUtc: '1899-12-31T00:00:00Z' }); await days.flush();
  const explorer = createLifetimeExplorer({ client: h.client }); t.after(() => explorer.close());
  await explorer.restore({ opened: true, mode: 'lifetime', fromDate: '1899-12-31', toDate: '1900-01-01',
    requestedUtc: Date.parse('1899-12-31T00:00:00Z') });
  h.memory.delete([...h.storage.keys()][0]); h.storage.clear();
  const before = h.requests.length;
  await explorer.scrub(Date.parse('1899-12-31T23:51:39Z'));
  assert.equal(explorer.current.utc, '1899-12-31T23:50:00Z');
  assert.equal(h.requests.length, before, 'a natal read with UTC seconds did not check the transit day');
});

for (const command of ['open', 'restore']) test(`explicit ${command} discovers the same natal day saved after an earlier miss`, async t => {
  const h = harness();
  const explorer = createLifetimeExplorer({ client: h.client, getPersonalChart: h.chart,
    getMomentState: () => ({ current: h.chart(), status: 'ready' }) });
  t.after(() => explorer.close());
  const snapshot = { opened: true, mode: 'lifetime', fromDate: h.day.date, toDate: h.day.date, requestedUtc: Date.parse(h.day.startUtc) };
  const show = () => command === 'open' ? explorer.open() : explorer.restore(snapshot);
  await show(); explorer.close();
  const minute = Date.parse(natalDayMinute(h.day, 1).utc);
  assert.equal(h.client.hasMinute(minute), false);
  await h.prepare(); h.memory.delete([...h.storage.keys()][0]);
  assert.equal(h.natal.peekDay(h.chart()), null);
  const before = h.reads;
  await show();
  assert.equal(h.reads, before + 1, 'one cache-only lookup belongs to the explicit opening');
  assert.equal(h.client.hasMinute(minute), true);
  assert.equal((await h.client.getMinute(minute)).utc, natalDayMinute(h.day, 1).utc);
  assert.deepEqual(h.requests, []);
  for (const index of [150, 151, 152]) await h.client.getPoint(index);
  assert.equal(h.reads, before + 1, 'scrubbing does not repeat the opening lookup');
  assert.equal(h.natalCalls.length, 1, 'reopening never recalculates the natal day');
});
