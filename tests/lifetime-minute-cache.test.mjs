import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifetimeClient } from '../src/data/lifetime-client.js';
import { createLifetimeExplorer } from '../src/state/lifetime.js';
import { createTransitDayClient } from '../src/data/transit-day-client.js';
import { transitChartAt } from '../src/domain/transit-day.js';
import { LIFETIME_PLANETS } from '../shared/lifetime-format.js';
import { TRANSIT_DAY_VERSION } from '../shared/day-packets/transit-format.js';

const start = Date.parse('2026-09-29T00:00:00Z');
const utc = text => Date.parse(`2026-09-${text}Z`);
const metadata = { startUtc: '2026-09-29T00:00:00Z', endExclusiveUtc: '2026-10-02T00:00:00Z', stepSeconds: 600,
  samples: 432, planets: LIFETIME_PLANETS, engine: 'Swiss Ephemeris 2.10.03' };
const dayAt = date => ({ version: TRANSIT_DAY_VERSION, date, startUtc: `${date}T00:00:00Z`, stepSeconds: 60, samples: 1440,
  engine: metadata.engine, nodeModel: 'true', zodiac: 'tropical-geocentric-apparent',
  columns: Array.from({ length: 24 }, (_, column) => Float64Array.from({ length: 1440 }, (_, minute) => column < 22
    ? (column * 13 + minute / 10000) % 360 : column === 22 ? Date.parse(`${date}T00:00:00Z`) / 1000 - 88 * 86400 + minute * 60 : 1e-11)),
});
const point = index => { const time = new Date(start + index * 600000).toISOString().replace('.000Z', 'Z');
  return { index, utc: time, longitudes: Array(11).fill(12), design: { utc: time, designUtc: new Date(start + index * 600000 - 88 * 86400000).toISOString(), longitudes: Array(11).fill(34), designArcResidualDegrees: 1e-11 } }; };
const response = value => ({ ok: true, json: async () => value });
const tick = () => new Promise(setImmediate);
function harness({ capacity = 1, getMomentState = () => null } = {}) {
  const requests = [], exactRequests = [], dayRequests = [], renders = [];
  const dayClient = createTransitDayClient({ capacity, decode: value => value, fetch: async url => {
    const date = new URL(url, 'http://test').searchParams.get('date'); dayRequests.push(date);
    return { ok: true, arrayBuffer: async () => dayAt(date) };
  } });
  const client = createLifetimeClient({ dayClient, fetch: (url, { signal }) => {
    if (url.endsWith('/meta')) return response(metadata);
    if (url.startsWith('/api/lifetime/moment?')) {
      const utc = new URL(url, 'http://test').searchParams.get('utc'); exactRequests.push(utc);
      return response({ version: '1', utc, longitudes: Array(11).fill(12), design: { ...point(0).design, utc,
        designUtc: new Date(Date.parse(utc) - 88 * 86400000).toISOString() } });
    }
    const index = Number(new URL(url, 'http://test').searchParams.get('index'));
    return new Promise((resolve, reject) => requests.push({ index, signal, resolve: () => resolve(response(point(index))), reject }));
  } });
  const explorer = createLifetimeExplorer({ client, getMomentState, now: () => utc('30T09:37:29'),
    getDayState: () => ({ current: transitChartAt(dayAt('2026-09-30'), 577), timeline: { date: '2026-09-30' } }),
    onRender: () => renders.push(explorer.current) });
  return { client, dayClient, explorer, requests, exactRequests, dayRequests, renders };
}
async function openLifetime(h) {
  await h.explorer.open(); const pending = h.explorer.setDateRange('2026-09-29', '2026-10-01');
  await tick(); h.requests.at(-1)?.resolve(); await pending;
}

test('compatible minute lookup is synchronous, shares day projection, validates UTC and never fetches a day', async () => {
  const h = harness(); const day = await h.dayClient.getDay('2026-09-30'); await h.client.getMeta();
  const chart = h.client.peekMinute(utc('30T09:37:00'));
  assert.equal(chart, transitChartAt(day, 577));
  assert.equal(h.client.peekMinute(utc('30T09:37:00')), chart);
  for (const value of [NaN, Infinity, Number.MAX_SAFE_INTEGER, utc('30T09:37:01'), utc('29T09:37:00')]) assert.equal(h.client.peekMinute(value), null);
  assert.deepEqual(h.dayRequests, ['2026-09-30']); assert.equal(h.requests.length, 0);
});

test('minute lookup rejects incompatible day contracts and days outside lifetime metadata', async () => {
  const raw = dayAt('2026-09-30');
  for (const patch of [{ engine: 'other' }, { version: 'old' }, { stepSeconds: 600 }, { nodeModel: 'mean' }, { zodiac: 'other' }, { startUtc: '2026-10-01T00:00:00Z' }]) {
    const client = createLifetimeClient({ dayClient: { peekDay: () => ({ ...raw, ...patch }) }, fetch: () => response(metadata) });
    await client.getMeta(); assert.equal(client.peekMinute(utc('30T09:37:00')), null);
  }
  const client = createLifetimeClient({ dayClient: { peekDay: () => dayAt('2026-09-28') }, fetch: () => response(metadata) });
  await client.getMeta(); assert.equal(client.peekMinute(utc('28T09:37:00')), null);
});

test('cached scrub synchronously replaces and aborts cold work; late completion cannot replace the minute', async () => {
  const h = harness(); await openLifetime(h); await h.dayClient.getDay('2026-09-30');
  const pending = h.explorer.scrub(utc('29T01:00:00')); await tick(); const cold = h.requests.at(-1);
  const next = utc('30T09:37:00'); const result = h.explorer.scrub(next);
  assert.equal(h.explorer.state.requestedUtc, next); assert.equal(h.explorer.state.displayedUtc, next);
  assert.equal(h.explorer.state.status, 'ready'); assert.equal(cold.signal.aborted, true);
  assert.equal(h.renders.at(-1).utc, '2026-09-30T09:37:00Z');
  cold.resolve(); await pending; await result;
  assert.equal(h.explorer.state.displayedUtc, next); assert.equal(h.requests.length, 2);
});

test('cache growth never moves target and manual minute survives day eviction without a reload', async () => {
  const h = harness(); await openLifetime(h); const before = h.explorer.state.requestedUtc;
  await h.dayClient.getDay('2026-09-30'); assert.equal(h.explorer.state.requestedUtc, before);
  const minute = utc('30T09:37:00'); await h.explorer.scrub(minute); const chart = h.explorer.current;
  await h.dayClient.getDay('2026-10-01'); assert.equal(h.client.peekMinute(minute), null);
  await h.explorer.scrub(minute);
  assert.equal(h.explorer.current, chart); assert.equal(h.explorer.state.requestedUtc, minute);
  assert.equal(h.requests.length, 1); assert.equal(h.dayRequests.length, 2);
});

test('borrowed exact return at the same UTC still requires manual lifetime acquisition', async () => {
  const h = harness(); await openLifetime(h);
  const exact = { ...transitChartAt(dayAt('2026-09-29'), 60), id: 'exact-return' };
  h.explorer.alignMoment(exact);
  const pending = h.explorer.scrub(utc('29T01:00:00')); await tick();
  assert.equal(h.requests.length, 2); h.requests.at(-1).resolve(); await pending;
  assert.equal(h.explorer.current.id, 'lifetime-preview');
});

test('cold scrubs preserve intermediate progress and admit one point at a time', async () => {
  const h = harness(); await openLifetime(h);
  const pending = h.explorer.scrub(utc('29T01:00:00')); await tick();
  h.explorer.scrub(utc('29T02:00:00')); h.explorer.scrub(utc('29T03:00:00'));
  assert.equal(h.requests.length, 2); h.requests[1].resolve(); await tick();
  assert.equal(h.explorer.state.displayedUtc, utc('29T01:00:00'));
  assert.equal(h.explorer.state.requestedUtc, utc('29T03:00:00'));
  assert.equal(h.explorer.state.status, 'loading'); assert.equal(h.requests.length, 3);
  h.requests[2].resolve(); await pending;
  assert.equal(h.explorer.state.displayedUtc, utc('29T03:00:00'));
});

test('explicit UTC restore loads one missing minute exactly and legacy index remains readable', async () => {
  const h = harness();
  assert.equal(await h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '2026-09-29', toDate: '2026-10-01', requestedUtc: utc('30T09:37:00') }), true);
  assert.equal(h.explorer.state.displayedUtc, utc('30T09:37:00')); assert.equal(h.requests.length, 0);
  assert.deepEqual(h.dayRequests, []); assert.deepEqual(h.exactRequests, ['2026-09-30T09:37:00Z']);
  const old = harness(); const pending = old.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '2026-09-29', toDate: '2026-10-01', index: 6 });
  await tick(); assert.equal(old.requests[0].index, 6); old.requests[0].resolve(); assert.equal(await pending, true);
  assert.equal(old.explorer.state.displayedUtc, utc('29T01:00:00'));
});

test('UTC bounds retain exact birth, keyboard neighbors are pure and reach minute/grid boundaries', async () => {
  const h = harness(); await h.dayClient.getDay('2026-09-30');
  await h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '2026-09-30', toDate: '2026-10-01', minimumUtc: '2026-09-30T09:34:56Z', requestedUtc: utc('30T09:37:00') });
  assert.equal(h.explorer.state.minUtc, utc('30T09:34:56')); assert.equal(h.explorer.state.maxUtc, Date.parse('2026-10-01T23:59:59.999Z'));
  const before = h.explorer.state.requestedUtc;
  assert.equal(h.explorer.adjacentUtc(-1), utc('30T09:36:00')); assert.equal(h.explorer.adjacentUtc(1), utc('30T09:38:00'));
  assert.equal(h.explorer.state.requestedUtc, before);
  await h.explorer.scrub(utc('30T09:35:00')); assert.equal(h.explorer.adjacentUtc(-1), utc('30T09:34:56'));
  await h.explorer.scrub(utc('30T23:59:00')); assert.equal(h.explorer.adjacentUtc(1), Date.parse('2026-10-01T00:00:00Z'));
  assert.equal(h.explorer.state.referenceUtc, utc('30T09:37:00'));
});

test('a birth in the final seconds keeps its exact endpoint beyond the final whole minute', async () => {
  const birth = '2026-09-30T23:59:56.789Z';
  const original = { ...transitChartAt(dayAt('2026-09-30'), 1439), utc: birth };
  const h = harness({ getMomentState: () => ({ current: original, status: 'ready' }) });
  assert.equal(await h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '2026-09-30', toDate: '2026-09-30', minimumUtc: birth, requestedUtc: Date.parse(birth) }), true);
  assert.equal(h.explorer.state.minUtc, Date.parse(birth));
  assert.equal(h.explorer.state.maxUtc, utc('30T23:59:59.999'));
  assert.equal(h.explorer.state.requestedUtc, Date.parse(birth));
  assert.equal(h.explorer.adjacentUtc(-1), Date.parse(birth));
  assert.equal(h.requests.length, 0);
});

test('restoring a minute beyond the chosen range loads its final valid minute', async () => {
  const h = harness();
  assert.equal(await h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '2026-09-29', toDate: '2026-09-30', requestedUtc: Date.parse('2026-10-01T09:37:00Z') }), true);
  assert.equal(h.explorer.state.requestedUtc, utc('30T23:59:00'));
  assert.equal(h.explorer.current.utc, '2026-09-30T23:59:00Z');
  assert.deepEqual(h.dayRequests, []); assert.deepEqual(h.exactRequests, ['2026-09-30T23:59:00Z']); assert.equal(h.requests.length, 0);
});

test('End resolves the last cached minute and otherwise the final cold lifetime slot', async () => {
  const h = harness(); await openLifetime(h); await h.dayClient.getDay('2026-10-01');
  await h.explorer.scrub(h.explorer.state.maxUtc);
  assert.equal(h.explorer.state.requestedUtc, Date.parse('2026-10-01T23:59:00Z'));
  const cold = harness(); await openLifetime(cold); const end = cold.explorer.scrub(cold.explorer.state.maxUtc);
  await tick(); assert.equal(cold.requests.at(-1).index, 431); cold.requests.at(-1).resolve(); await end;
  assert.equal(cold.explorer.state.requestedUtc, Date.parse('2026-10-01T23:50:00Z'));
});

test('failed minute restoration retries the same UTC and a newer scrub invalidates its late completion', async () => {
  let attempts = 0, resolveMinute;
  const client = createLifetimeClient({ fetch: url => {
    if (url.endsWith('/meta')) return response(metadata);
    if (url.startsWith('/api/lifetime/moment?')) {
      attempts++; if (attempts === 1) return Promise.reject(new Error('offline minute'));
      return new Promise(resolve => { resolveMinute = resolve; });
    }
    return response(point(Number(new URL(url, 'http://test').searchParams.get('index'))));
  } });
  const explorer = createLifetimeExplorer({ client });
  const saved = utc('30T09:37:00');
  assert.equal(await explorer.restore({ opened: true, mode: 'lifetime', fromDate: '2026-09-29', toDate: '2026-10-01', requestedUtc: saved }), false);
  assert.equal(explorer.state.status, 'error'); assert.equal(explorer.state.requestedUtc, saved);
  const retry = explorer.retry(); await tick(); assert.equal(attempts, 2);
  await explorer.scrub(utc('29T01:00:00'));
  resolveMinute(response({ version: '1', utc: '2026-09-30T09:37:00Z', longitudes: Array(11).fill(12),
    design: { ...point(0).design, utc: '2026-09-30T09:37:00Z' } }));
  assert.equal(await retry, false);
  assert.equal(explorer.state.requestedUtc, utc('29T01:00:00')); assert.equal(explorer.state.displayedUtc, utc('29T01:00:00'));
});

test('changing only open-ended range after a borrowed exact chart requests a valid manual grid point', async () => {
  const h = harness(); await openLifetime(h);
  const exact = { ...transitChartAt(dayAt('2026-09-30'), 577), utc: '2026-09-30T09:37:29.432Z', id: 'exact-return' };
  h.explorer.alignMoment(exact);
  const pending = h.explorer.setDateRange('2026-09-29', null); await tick();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests.at(-1).index, 202);
  h.requests.at(-1).resolve(); assert.equal(await pending, true);
  assert.equal(h.explorer.state.requestedUtc, utc('30T09:40:00'));
});
