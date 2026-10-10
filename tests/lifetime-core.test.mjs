import { lifeTimelineForChart } from '../src/domain/cycles.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifetimeClient } from '../src/data/lifetime-client.js';
import { createLifetimeExplorer } from '../src/state/lifetime.js';
import { lifetimeChartAt, validateLifetimeMetadata, validateLifetimeMoment } from '../src/domain/lifetime.js';
import { LIFETIME_PLANETS } from '../shared/lifetime-format.js';
import { createTransitPlanetFilter } from '../src/state/transit-planets.js';
import { createChartSession } from '../src/state/chart-session.js';
import { gatePositionAtLongitude } from '../src/domain/gate-wheel.js';
import { PLANET_IDS } from '../src/domain/planets.js';
import { createTransitDayClient } from '../src/data/transit-day-client.js';
import { transitChartAt } from '../src/domain/transit-day.js';
import { encodeTransitDay } from '../server/packets/encode.mjs';
import { TRANSIT_DAY_VERSION } from '../shared/day-packets/transit-format.js';

const meta = { calculationVersion: 'a'.repeat(64), startUtc: '1900-01-01T00:00:00Z', endExclusiveUtc: '1900-01-04T00:00:00Z', stepSeconds: 600, samples: 432, planets: [...LIFETIME_PLANETS] };
const point = (index, metadata = meta) => ({ index, utc: new Date(Date.parse(metadata.startUtc) + index * 600000).toISOString().replace('.000Z', 'Z'), longitudes: [335.74999999999994, 22, 335.74999999999994, 44, 55, 66, 77, 88, 99, 111, 122] });
const fullMeta = { ...meta, startUtc: '1801-01-01T00:00:00Z', endExclusiveUtc: '2400-01-01T00:00:00Z',
  samples: (Date.parse('2400-01-01T00:00:00Z') - Date.parse('1801-01-01T00:00:00Z')) / 600000 };
const lifetimeIndex = (date, metadata = fullMeta) => (Date.parse(date.length === 10 ? `${date}T00:00:00Z` : date) - Date.parse(metadata.startUtc)) / 600000;
const response = value => ({ ok: true, json: async () => value });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const designAt = utc => ({ utc, designUtc: new Date(Date.parse(utc) - 88 * 86400000).toISOString().replace('.000Z', 'Z'),
  designArcResidualDegrees: 1e-10, longitudes: point(0).longitudes.map(value => (value + 88) % 360) });

const moment = (index, metadata = meta) => { const value = point(index, metadata); return { ...value, design: designAt(value.utc) }; };

function dayChart(utc = '2026-09-30T09:34:56.789Z') {
  const design = designAt(utc);
  const values = [...point(0).longitudes, ...design.longitudes, Date.parse(design.designUtc) / 1000, design.designArcResidualDegrees];
  const chart = transitChartAt({ startUtc: utc, samples: 1, columns: values.map(value => Float64Array.of(value)) }, 0);
  return { ...chart, id: 'day-preview', birthDate: '2026-09-30', birthTime: '12:34:56',
    timezone: 'Europe/Moscow', utcOffset: 'UTC+03:00', verification: 'Exact current day sample.' };
}
function explorerHarness(metadata = fullMeta, { planetFilter, getMomentState } = {}) {
  const calls = [], metaCalls = [], renders = [], states = [];
  let day = { current: dayChart(), timeline: { date: '2026-09-30', timeZone: 'Europe/Moscow' } };
  let time = Date.parse('2026-09-30T09:34:56.789Z');
  const explorer = createLifetimeExplorer({ client: {
    getMeta: async options => { metaCalls.push(options); return metadata; },
    getPoint(index, { signal }) { const waiting = deferred(); calls.push({ index, signal, ...waiting }); return waiting.promise; },
  }, getDayState: () => day, getMomentState, now: () => time, planetFilter,
  onRender: () => renders.push(explorer.current), onStateChange: state => states.push(state) });
  return { explorer, calls, metaCalls, renders, states, get day() { return day; }, utc: index => Date.parse(metadata.startUtc) + index * 600000,
    setNow(value) { time = Date.parse(value); },
    setDay(current, timeline = { date: current.birthDate, timeZone: current.timezone }) { day = { current, timeline }; } };
}

test('aligning an existing exact moment cancels an invisible lifetime request and same-slot manual scrub still loads the grid', async () => {
  const h = explorerHarness(); await h.explorer.open();
  const loading = h.explorer.setDateRange('1801-01-01', '2399-12-31'); await tick();
  const exact = dayChart('2026-09-30T09:37:29.432Z'), calls = h.calls.length;
  assert.equal(h.explorer.alignMoment(exact), true);
  assert.equal(h.calls.length, calls); assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.explorer.current.utc, exact.utc); assert.equal(h.explorer.state.status, 'ready');
  assert.equal(h.explorer.state.displayedUtc, Date.parse(exact.utc));
  const aligned = h.explorer.state.requestedUtc;
  assert.equal(aligned, Date.parse(exact.utc));
  h.calls[0].resolve(moment(h.calls[0].index, fullMeta)); await loading;
  assert.equal(h.explorer.current.utc, exact.utc, 'a completed abandoned point cannot replace the exact owner');
  const manual = h.explorer.scrub(aligned); await tick();
  assert.equal(h.calls.length, calls + 1);
  h.calls.at(-1).resolve(moment(Math.round(lifetimeIndex(new Date(aligned).toISOString())), fullMeta)); await manual;
  assert.equal(h.explorer.current.utc, point(Math.round(lifetimeIndex(new Date(aligned).toISOString())), fullMeta).utc);
  assert.equal(h.explorer.state.displayedUtc, Date.parse('2026-09-30T09:40:00Z'));
  assert.equal(h.explorer.scrub(aligned), undefined); assert.equal(h.calls.length, calls + 1);
});

test('opening a lifetime around a live or exact owner uses its existing chart without any lifetime point', async () => {
  for (const live of [true, false]) {
    let owner = { current: dayChart('2026-09-30T09:37:29.432Z'), status: 'ready', live };
    const h = explorerHarness(fullMeta, { getMomentState: () => owner });
    await h.explorer.open();
    const restored = h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '1801-01-01', toDate: '2399-12-31', index: Math.round(lifetimeIndex(owner.current.utc)) });
    await tick();
    assert.equal(h.calls.length, 0, 'position alignment must not calculate an unseen rounded moment');
    assert.equal(await restored, true); assert.equal(h.explorer.current.utc, owner.current.utc);
    const aligned = h.explorer.state.requestedUtc; owner = null;
    const manual = h.explorer.scrub(aligned); await tick();
    assert.equal(h.calls.length, 1); h.calls[0].resolve(moment(Math.round(lifetimeIndex(new Date(aligned).toISOString())), fullMeta)); await manual;
    assert.equal(h.explorer.current.utc, point(Math.round(lifetimeIndex(new Date(aligned).toISOString())), fullMeta).utc);
  }
});

test('a live owner still waiting for its minute packet never falls back to an invisible lifetime calculation', async () => {
  let owner = { current: null, status: 'loading', live: true };
  const h = explorerHarness(fullMeta, { getMomentState: () => owner });
  await h.explorer.open();
  const restored = h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '1801-01-01', toDate: '2399-12-31', index: Math.round(lifetimeIndex('2026-09-30T09:37:00Z')) });
  await tick(); assert.equal(h.calls.length, 0); assert.equal(await restored, true);
  owner = { current: dayChart('2026-09-30T09:38:00Z'), status: 'ready', live: true };
  h.explorer.alignMoment(owner.current);
  assert.equal(h.explorer.current.utc, owner.current.utc); assert.equal(h.calls.length, 0);
});

test('lifetime chart contains all13 planets including Moon with exact derived boundary values', () => {
  const chart = lifetimeChartAt(meta, point(0));
  assert.equal(chart.id, 'lifetime-preview'); assert.equal(chart.source, 'transit');
  assert.equal(chart.activations.personality.length, 13); assert.deepEqual(chart.activations.design, []);
  assert.deepEqual(chart.activations.personality.map(entry => entry.planet), PLANET_IDS);
  for (let index = 0; index < LIFETIME_PLANETS.length; index++) {
    const entry = chart.activations.personality.find(value => value.planet === LIFETIME_PLANETS[index]);
    assert.deepEqual(entry, { planet: LIFETIME_PLANETS[index], ...gatePositionAtLongitude(point(0).longitudes[index]) });
  }
  const north = chart.activations.personality.find(entry => entry.planet === 'north_node');
  const south = chart.activations.personality.find(entry => entry.planet === 'south_node');
  assert.deepEqual([north.gate, north.line], [55, 6]); assert.deepEqual([south.gate, south.line], [40, 1]);
  const earth = chart.activations.personality.find(entry => entry.planet === 'earth');
  assert.deepEqual([earth.gate, earth.line, earth.longitude], [40, 1, 155.75]);
  assert.equal(chart.utc, meta.startUtc);
  assert.equal(lifetimeChartAt(meta, point(meta.samples - 1)).utc, '1900-01-03T23:50:00Z');
});

test('lifetime validates ordered metadata, matching timestamps, indexes and finite angles', () => {
  for (const change of [{ planets: [...meta.planets].reverse() }, { planets: ['north_node', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'] }, { samples: 431 }, { stepSeconds: 60 }, { startUtc: '1900-02-30T00:00:00Z' }]) assert.throws(() => validateLifetimeMetadata({ ...meta, ...change }));
  for (const value of [{ ...point(0), index: -1 }, { ...point(0), index: meta.samples }, { ...point(0), utc: point(1).utc }, { ...point(0), longitudes: [0] },
    ...[NaN, Infinity, -1, 360].map(value => ({ ...point(0), longitudes: [value, ...point(0).longitudes.slice(1)] }))]) assert.throws(() => lifetimeChartAt(meta, value));
});

test('client coalesces concurrent points and isolates cancellation without retaining completed points', async () => {
  const waiting = deferred(), calls = []; let transport;
  const client = createLifetimeClient({ fetch(url, { signal }) { calls.push(url); if (url.endsWith('/meta')) return Promise.resolve(response(meta)); transport = signal; return waiting.promise; } });
  const firstController = new AbortController();
  const first = client.getPoint(3, { signal: firstController.signal }), second = client.getPoint(3);
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await tick(); firstController.abort(); await rejected;
  assert.equal(transport.aborted, false); waiting.resolve(response(moment(3)));
  const actual = await second;
  assert.equal(calls.filter(url => url.includes('?')).length, 1);
  assert.deepEqual(await client.getPoint(3), actual);
  assert.equal(calls.filter(url => url.includes('?')).length, 2, 'a later independent visit returns to the server');
  assert.ok(Object.isFrozen(actual)); assert.ok(Object.isFrozen(actual.longitudes));
});

test('client cancels abandoned transport, never caches stale completion, and retries failures', async () => {
  const calls = [], firstWaiting = deferred();
  const client = createLifetimeClient({ fetch(url, { signal }) { if (url.endsWith('/meta')) return response(meta); calls.push({ url, signal }); return calls.length === 1 ? firstWaiting.promise : response(moment(2)); } });
  const controller = new AbortController(), first = client.getPoint(2, { signal: controller.signal });
  const rejection = assert.rejects(first, { name: 'AbortError' }); await tick(); controller.abort(); await rejection;
  assert.equal(calls[0].signal.aborted, true);
  const next = await client.getPoint(2); firstWaiting.resolve(response({ ...moment(2), longitudes: Array(11).fill(99) })); await tick();
  assert.deepEqual(await client.getPoint(2), next); assert.equal(calls.length, 3);
  let attempts = 0;
  const retrying = createLifetimeClient({ fetch(url) { if (url.endsWith('/meta')) return response(meta); if (++attempts === 1) throw new Error('offline'); return response(moment(1)); } });
  await assert.rejects(retrying.getPoint(1), /offline/); assert.equal((await retrying.getPoint(1)).index, 1);
});

test('independent visits never accumulate intermediate points in RAM or IndexedDB', async () => {
  const calls = [], client = createLifetimeClient({ fetch(url, options) {
    assert.equal(options.cache, 'no-store');
    if (url.endsWith('/meta')) return response(meta);
    const index = Number(new URL(url, 'http://local').searchParams.get('index'));
    calls.push(index); return response(moment(index));
  } });
  for (const index of [0, 1, 2, 1, 0]) await client.getPoint(index);
  assert.deepEqual(calls, [0, 1, 2, 1, 0]);
  assert.equal(client.peekMinute(Date.parse(meta.startUtc)), null);
  assert.equal(client.hasMinute(Date.parse(meta.startUtc)), false);
  assert.equal(await client.readMinute(Date.parse(meta.startUtc)), null);
  let attempts = 0;
  const invalid = createLifetimeClient({ fetch(url) { return response(url.endsWith('/meta') ? meta : ++attempts === 1 ? moment(2) : moment(1)); } });
  await assert.rejects(invalid.getPoint(1), /Некорректные/); assert.equal((await invalid.getPoint(1)).index, 1);
});

test('a complete moment requires matching Design and never caches a partial or invalid pair', async () => {
  const complete = moment(1);
  assert.equal(lifetimeChartAt(meta, complete).activations.design.length, 13);
  assert.equal(lifetimeChartAt(meta, point(1)).activations.design.length, 0, 'standalone black conversion remains supported');
  const invalid = [point(1), { ...complete, design: null }, { ...complete, design: designAt(point(2).utc) },
    ...[{ designUtc: complete.utc }, { designUtc: 'invalid' }, { designArcResidualDegrees: Infinity },
      { designArcResidualDegrees: 1e-6 }, { longitudes: [0] }, { longitudes: Array(11).fill(360) }]
      .map(change => ({ ...complete, design: { ...complete.design, ...change } }))];
  for (const value of invalid) {
    assert.throws(() => validateLifetimeMoment(value, meta, 1));
    let attempts = 0;
    const client = createLifetimeClient({ fetch: url => response(url.endsWith('/meta') ? meta : ++attempts === 1 ? value : complete) });
    await assert.rejects(client.getPoint(1), /Некорректные/);
    const accepted = await client.getPoint(1);
    assert.equal(accepted.utc, accepted.design.utc); assert.equal(attempts, 2);
    assert.deepEqual(await client.getPoint(1), accepted); assert.equal(attempts, 3);
    assert.ok(Object.isFrozen(accepted.design)); assert.ok(Object.isFrozen(accepted.design.longitudes));
  }
});

test('validated moments stay immutable and reusable only for their own lifetime and requested index', () => {
  const rawMeta = { ...meta, planets: [...meta.planets] };
  const metadata = validateLifetimeMetadata(rawMeta);
  const raw = moment(1), expected = lifetimeChartAt(rawMeta, raw);
  const accepted = validateLifetimeMoment(raw, metadata, 1);
  rawMeta.samples = 1; rawMeta.planets.reverse();
  raw.longitudes[0] = 0; raw.design.longitudes[0] = 0;
  assert.equal(validateLifetimeMetadata(metadata), metadata);
  assert.equal(validateLifetimeMoment(accepted, metadata, 1), accepted);
  assert.deepEqual(lifetimeChartAt(metadata, accepted), expected);
  assert.throws(() => { accepted.design.longitudes[0] = 123; }, TypeError);
  assert.throws(() => validateLifetimeMoment(accepted, metadata, 2));
  const otherLifetime = validateLifetimeMetadata({ ...meta, startUtc: '1901-01-01T00:00:00Z', endExclusiveUtc: '1901-01-04T00:00:00Z' });
  assert.throws(() => validateLifetimeMoment(accepted, otherLifetime, 1));
  assert.throws(() => validateLifetimeMoment(Object.freeze({ ...accepted, utc: point(2).utc }), metadata, 1));
  assert.throws(() => validateLifetimeMoment(Object.freeze({ ...accepted, longitudes: Object.freeze(Array(11)) }), metadata, 1));
  assert.throws(() => validateLifetimeMoment({ ...accepted, design: { ...accepted.design, longitudes: Array(11) } }, metadata, 1));
  assert.throws(() => validateLifetimeMoment({ ...accepted, design: { ...accepted.design, designUtc: new Date(accepted.design.designUtc) } }, metadata, 1));
  assert.throws(() => validateLifetimeMetadata({ ...meta, planets: Array(meta.planets.length) }));
});

const decodedDay = date => ({ calculationVersion: 'a'.repeat(64), version: TRANSIT_DAY_VERSION, date, startUtc: `${date}T00:00:00Z`, stepSeconds: 60, samples: 1440,
  engine: 'Swiss Ephemeris 2.10.03', ephemeris: 'test ephemeris', timezoneDatabase: 'test tzdata', nodeModel: 'true', zodiac: 'tropical-geocentric-apparent',
  columns: Array.from({ length: 24 }, (_, column) => Float64Array.from({ length: 1440 }, (_, minute) => column < 22
    ? (column * 13 + minute / 10000 + 0.123456789012345) % 360
    : column === 22 ? Date.parse(`${date}T00:00:00Z`) / 1000 - 88 * 86400 + minute * 61 : minute % 100 * 1e-12)),
});

test('Lifetime reuses a real decoded day at exact UTC with all black/red Float64 values and no point request', async () => {
  const raw = decodedDay('1900-01-02'), dayRequests = [], requests = [];
  const dayClient = createTransitDayClient({ fetch: async url => { dayRequests.push(url); return { ok: true, arrayBuffer: async () => encodeTransitDay(raw).buffer }; } });
  const day = await dayClient.getDay(raw.date);
  const client = createLifetimeClient({ dayClient, fetch(url) {
    requests.push(url); assert.equal(url, '/api/lifetime/meta'); return response({ ...meta, engine: raw.engine });
  } });
  const index = 144 + 75, sample = await client.getPoint(index), minute = 750;
  assert.equal(sample.utc, '1900-01-02T12:30:00Z'); assert.equal(sample.design.utc, sample.utc);
  for (let column = 0; column < 11; column++) {
    assert.ok(Object.is(sample.longitudes[column], day.columns[column][minute]));
    assert.ok(Object.is(sample.design.longitudes[column], day.columns[column + 11][minute]));
  }
  assert.equal(sample.design.designUtc, new Date(day.columns[22][minute] * 1000).toISOString().replace('.000Z', 'Z'));
  assert.ok(Object.is(sample.design.designArcResidualDegrees, day.columns[23][minute]));
  assert.deepEqual(await client.getPoint(index), sample);
  assert.deepEqual(requests, ['/api/lifetime/meta']); assert.equal(dayRequests.length, 1);
  assert.ok(Object.isFrozen(sample.design.longitudes));
});

test('uncached UTC days and incompatible day contracts fall back to one complete point without fetching days', async () => {
  const raw = decodedDay('1900-01-02');
  const variants = [null, { ...raw, engine: 'Swiss Ephemeris different' }, { ...raw, version: '1' },
    { ...raw, nodeModel: 'mean' }, { ...raw, zodiac: 'other' }, { ...raw, startUtc: '1900-01-03T00:00:00Z' }];
  for (const cached of variants) {
    const requests = [], peeks = [];
    const client = createLifetimeClient({ dayClient: { peekDay(date) { peeks.push(date); return cached; }, getDay() { throw Error('must not fetch a day'); } },
      fetch(url) { requests.push(url); return response(url.endsWith('/meta') ? { ...meta, engine: raw.engine } : moment(144)); } });
    assert.deepEqual(await client.getPoint(144), moment(144));
    assert.deepEqual(requests, ['/api/lifetime/meta', '/api/lifetime?index=144']); assert.deepEqual(peeks, ['1900-01-02']);
  }
  const dayRequests = [], requests = [];
  const dayClient = createTransitDayClient({ fetch: async url => { dayRequests.push(url); return { ok: true, arrayBuffer: async () => encodeTransitDay(raw).buffer }; } });
  await dayClient.getDay(raw.date);
  const client = createLifetimeClient({ dayClient, fetch(url) { requests.push(url); return response(url.endsWith('/meta') ? { ...meta, engine: raw.engine } : moment(288)); } });
  assert.equal((await client.getPoint(288)).utc, '1900-01-03T00:00:00Z');
  assert.equal(dayRequests.length, 1); assert.deepEqual(requests, ['/api/lifetime/meta', '/api/lifetime?index=288']);
});

test('default Lifetime client receives the shared day cache through controller options', async t => {
  const day = decodedDay('2026-09-30'), requests = [], peeks = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(url);
    assert.equal(url, '/api/lifetime/meta', 'a cached lifetime minute needs no point request');
    return response({ ...fullMeta, engine: day.engine });
  });
  const owner = createTransitPlanetFilter(); owner.setAllPlanets(true, 'design');
  const explorer = createLifetimeExplorer({ planetFilter: owner,
    dayClient: { peekDay(date) { peeks.push(date); return date === day.date ? day : null; } },
    getDayState: () => ({ current: dayChart(), timeline: { date: day.date, timeZone: 'Europe/Moscow' } }),
  });
  await explorer.open();
  await explorer.setDateRange('2025-01-01', '2027-01-01');
  assert.equal(explorer.state.status, 'ready');
  assert.equal(explorer.current.utc, '2026-09-30T09:35:00Z');
  assert.equal(explorer.current.activations.personality[0].longitude, day.columns[0][575]);
  assert.equal(explorer.current.activations.design[0].longitude, day.columns[11][575]);
  assert.deepEqual(requests, ['/api/lifetime/meta']); assert.deepEqual(peeks, [day.date]);
});

async function settle(h, pending, metadata = fullMeta) {
  await tick(); const call = h.calls.at(-1); call.resolve(moment(call.index, metadata)); return pending;
}

async function openLifetime(h, from = '1801-01-01', through = '2399-12-31') {
  await h.explorer.open();
  return settle(h, h.explorer.setDateRange(from, through));
}

test('Lifetime opens seamlessly on the exact current day chart and loads metadata without a lifetime point', async () => {
  const h = explorerHarness(), original = structuredClone(h.day.current);
  const pending = h.explorer.open();
  assert.equal(h.explorer.current.utc, original.utc, 'opening never rounds the visible day sample');
  assert.equal(h.explorer.current.planetFilter.activations, h.day.current.activations.personality);
  await pending;
  assert.equal(h.metaCalls.length, 1); assert.equal(h.calls.length, 0);
  assert.deepEqual([h.explorer.state.fromDate, h.explorer.state.toDate], ['2026-09-30', '2026-09-30']);
  assert.deepEqual([h.explorer.state.minDate, h.explorer.state.maxDate], ['1801-01-01', '2399-12-31']);
  assert.equal(h.explorer.state.mode, 'day'); assert.equal(h.explorer.state.status, 'ready');
  for (const key of ['utc', 'id', 'birthDate', 'birthTime', 'timezone', 'utcOffset', 'verification']) assert.equal(h.explorer.current[key], original[key]);
  assert.deepEqual(h.explorer.current.activations.personality, original.activations.personality);
  assert.deepEqual(h.day.current, original);
  assert.equal(h.explorer.setDateRange('2026-09-30', '2026-09-30'), true);
  assert.equal(h.calls.length, 0);
});

test('day sync follows the borrowed exact chart and local date without rendering or requesting astronomy', async () => {
  const h = explorerHarness(); await h.explorer.open(); h.explorer.setPlanet('moon', false);
  const renders = h.renders.length, notices = h.states.length;
  const next = { ...dayChart('2026-09-30T21:01:23.456Z'), birthDate: '2026-10-01', birthTime: '00:01:23' };
  h.setDay(next); h.explorer.syncDay();
  assert.equal(h.explorer.current.utc, next.utc);
  assert.equal(h.explorer.current.planetFilter.activations, next.activations.personality);
  assert.deepEqual([h.explorer.state.fromDate, h.explorer.state.toDate], ['2026-10-01', '2026-10-01']);
  assert.equal(h.explorer.current.activations.personality.some(entry => entry.planet === 'moon'), false);
  assert.equal(h.renders.length, renders, 'the existing day renderer owns the redraw');
  assert.ok(h.states.length > notices); assert.equal(h.calls.length, 0);
});

test('a custom full lifetime range uses the current shown moment at the ten-minute grid', async () => {
  const h = explorerHarness(); await openLifetime(h);
  assert.equal(h.calls.length, 1); assert.equal(h.explorer.state.mode, 'lifetime');
  assert.deepEqual([h.explorer.state.fromDate, h.explorer.state.toDate], ['1801-01-01', '2399-12-31']);
  assert.deepEqual([h.explorer.state.minUtc, h.explorer.state.maxUtc], [Date.parse('1801-01-01T00:00:00Z'), Date.parse('2399-12-31T23:59:59.999Z')]);
  assert.equal(h.explorer.current.utc, '2026-09-30T09:30:00Z');
  const chart = h.explorer.current, renders = h.renders.length;
  h.setDay(dayChart('2026-09-30T13:45:00Z')); h.explorer.syncDay();
  assert.equal(h.explorer.current, chart, 'day updates cannot overwrite a lifetime point');
  assert.equal(h.renders.length, renders); assert.equal(h.calls.length, 1);
  assert.equal(h.explorer.setDateRange('1801-01-01', '2399-12-31'), true);
  assert.equal(h.calls.length, 1, 'an unchanged ready range does not reload');
});

test('one request at a time publishes progress and follows the latest scrub', async () => {
  const h = explorerHarness(); await openLifetime(h); h.explorer.setInteracting(true);
  const pending = h.explorer.scrub(h.utc(1)); await tick();
  for (let i = 2; i <= 100; i++) h.explorer.scrub(h.utc(i));
  assert.equal(h.calls.length, 2); h.calls[1].resolve(moment(1, fullMeta)); await tick();
  assert.equal(h.explorer.state.displayedUtc, h.utc(1)); assert.equal(h.calls[2].index, 100);
  h.explorer.scrub(h.utc(200)); h.calls[2].resolve(moment(100, fullMeta)); await tick();
  assert.equal(h.explorer.state.displayedUtc, h.utc(100)); assert.equal(h.calls[3].index, 200);
  h.calls[3].resolve(moment(200, fullMeta)); await pending;
  assert.equal(h.explorer.state.displayedUtc, h.utc(200)); assert.equal(h.explorer.state.status, 'ready');
});

test('stale errors cannot starve the latest target; failed targets keep the visible chart', async () => {
  const h = explorerHarness(); await openLifetime(h); const shown = h.explorer.current;
  const pending = h.explorer.scrub(h.utc(2)); await tick(); h.explorer.scrub(h.utc(3));
  h.calls[1].reject(new Error('old failure')); await tick(); assert.equal(h.calls[2].index, 3);
  h.calls[2].reject(new Error('latest failure')); await pending;
  assert.equal(h.explorer.current, shown); assert.equal(h.explorer.state.error, ''); assert.equal(h.explorer.state.retryCount, 1);
  await settle(h, h.explorer.retry()); assert.equal(h.explorer.state.displayedUtc, h.utc(3));
});

test('narrowed ranges reject in-flight outside points, clamp the requested moment and include the whole leap day', async () => {
  const h = explorerHarness(); await openLifetime(h);
  const pending = h.explorer.scrub(h.utc(0)); await tick();
  h.explorer.setDateRange('2000-02-29', '2000-02-29');
  h.calls[1].resolve(moment(0, fullMeta)); await tick();
  const target = lifetimeIndex('2000-02-29'); assert.equal(h.calls[2].index, target);
  assert.equal(h.explorer.state.maxUtc - h.explorer.state.minUtc + 1, 86400000);
  h.calls[2].resolve(moment(target, fullMeta)); await pending;
  assert.equal(h.explorer.current.utc, '2000-02-29T00:00:00Z');
  await settle(h, h.explorer.scrub(Number.MAX_SAFE_INTEGER));
  assert.equal(h.explorer.current.utc, '2000-02-29T23:50:00Z');
  await settle(h, h.explorer.scrub(-Number.MAX_SAFE_INTEGER)); assert.equal(h.explorer.current.utc, '2000-02-29T00:00:00Z');
});

test('invalid, incomplete, out of bounds, reversed and non-leap dates leave the day range unchanged', async () => {
  const h = explorerHarness(); await h.explorer.open(); const before = h.explorer.state;
  for (const pair of [['1800-12-31', '1900-01-01'], ['2399-01-01', '2400-01-01'], ['2000-01-02', '2000-01-01'],
    ['1900-02-29', '1900-03-01'], ['2000-02-30', '2000-03-01'], ['2000-1-1', '2000-01-02'], ['abc', '2000-01-01']]) {
    assert.equal(h.explorer.setDateRange(...pair), false);
  }
  assert.equal(h.explorer.state.current, before.current); assert.equal(h.calls.length, 0);
  assert.deepEqual([h.explorer.state.fromDate, h.explorer.state.toDate], [before.fromDate, before.toDate]);
  assert.equal(h.explorer.state.mode, 'day');
});

test('close cancels pending work; reopen borrows the latest day and retains planet choices', async () => {
  const h = explorerHarness(); await openLifetime(h, '2000-01-01', '2000-01-02');
  h.explorer.setPlanet('moon', false);
  const pending = h.explorer.scrub(h.explorer.state.minUtc); await tick(); const stale = h.calls.at(-1), requests = h.calls.length;
  h.explorer.close(); assert.equal(stale.signal.aborted, true); assert.equal(h.explorer.current, null);
  h.setDay(dayChart('2026-09-30T15:42:11.000Z')); await h.explorer.open();
  stale.resolve(moment(stale.index, fullMeta)); await pending;
  assert.deepEqual([h.explorer.state.fromDate, h.explorer.state.toDate], ['2026-09-30', '2026-09-30']);
  assert.equal(h.explorer.state.selectedPlanets.includes('moon'), false);
  assert.equal(h.explorer.state.mode, 'day'); assert.equal(h.explorer.current.utc, h.day.current.utc);
  assert.equal(h.calls.length, requests, 'reopening needs no lifetime point'); assert.equal(h.metaCalls.length, 1);
});

test('selecting the current local day returns to day mode and ignores the cancelled lifetime completion', async () => {
  const h = explorerHarness(); await openLifetime(h);
  const pending = h.explorer.scrub(h.utc(0)); await tick(); const stale = h.calls.at(-1);
  assert.equal(h.explorer.setDateRange('2026-09-30', '2026-09-30'), true);
  assert.equal(stale.signal.aborted, true); assert.equal(h.explorer.state.mode, 'day');
  assert.equal(h.explorer.current.utc, h.day.current.utc);
  const current = h.explorer.current, requests = h.calls.length;
  stale.resolve(moment(stale.index, fullMeta)); await pending;
  assert.equal(h.explorer.current, current); assert.equal(h.calls.length, requests);
});

test('the lifetime marker tracks actual now without moving the chosen chart and goNow stays inside the range', async () => {
  const h = explorerHarness(); await openLifetime(h);
  const nowIndex = lifetimeIndex('2026-09-30T09:30:00Z'); assert.equal(h.explorer.state.referenceUtc, Date.parse('2026-09-30T09:34:00Z'));
  await settle(h, h.explorer.scrub(h.utc(nowIndex - 10)));
  const chart = h.explorer.current, renders = h.renders.length, points = h.calls.length, notices = h.states.length;
  h.setNow('2026-09-30T09:44:56.789Z'); h.explorer.syncClock();
  assert.equal(h.explorer.state.referenceUtc, Date.parse('2026-09-30T09:44:00Z')); assert.equal(h.explorer.current, chart);
  assert.equal(h.renders.length, renders); assert.equal(h.calls.length, points); assert.equal(h.states.length, notices + 1);
  h.explorer.syncClock(); assert.equal(h.states.length, notices + 1);
  await settle(h, h.explorer.goNow()); assert.equal(h.explorer.state.displayedUtc, h.utc(nowIndex + 1));
  await settle(h, h.explorer.setDateRange('1900-01-01', '1900-01-02'));
  assert.equal(h.explorer.state.referenceUtc, null); assert.equal(h.explorer.goNow(), undefined);
});

test('metadata failure retries while retaining the day chart, and closed metadata cannot publish', async () => {
  let attempts = 0, points = 0; const chart = dayChart();
  const explorer = createLifetimeExplorer({ getDayState: () => ({ current: chart, timeline: { date: '2026-09-30', timeZone: 'Europe/Moscow' } }), client: {
    getMeta: async () => { if (++attempts === 1) throw new Error('offline'); return fullMeta; }, getPoint: async i => { points++; return moment(i, fullMeta); },
  } });
  assert.equal(await explorer.open(), false); assert.equal(explorer.state.status, 'loading'); assert.equal(explorer.state.retryCount, 1); assert.equal(explorer.current.utc, chart.utc);
  assert.equal(await explorer.retry(), true); assert.equal(explorer.state.mode, 'day'); assert.equal(explorer.state.status, 'ready'); assert.equal(points, 0);
  const waiting = deferred();
  const closed = createLifetimeExplorer({ getDayState: () => ({ current: chart, timeline: { date: '2026-09-30', timeZone: 'Europe/Moscow' } }), client: { getMeta: () => waiting.promise, getPoint: () => { points++; } } });
  const pending = closed.open(); await tick(); closed.close(); waiting.resolve(fullMeta); await pending;
  assert.equal(closed.state.metadata, null); assert.equal(points, 0);
});

test('all/none and individual derived planets reuse full day and lifetime records without API work', async () => {
  const h = explorerHarness(); await h.explorer.open();
  for (const mode of ['day', 'lifetime']) {
    if (mode === 'lifetime') await settle(h, h.explorer.setDateRange('1801-01-01', '2399-12-31'));
    const calls = h.calls.length, full = h.explorer.current.activations.personality;
    h.explorer.toggleAllPlanets(); assert.equal(h.explorer.current.activations.personality.length, 0);
    assert.deepEqual(h.explorer.current.planetFilter.activations, full);
    h.explorer.togglePlanet('earth'); assert.deepEqual(h.explorer.current.activations.personality, [full.find(e => e.planet === 'earth')]);
    h.explorer.togglePlanet('south_node'); assert.deepEqual(h.explorer.current.activations.personality, full.filter(e => ['earth', 'south_node'].includes(e.planet)));
    h.explorer.toggleAllPlanets(); assert.deepEqual(h.explorer.state.selectedPlanets, PLANET_IDS);
    assert.equal(h.calls.length, calls); assert.equal(h.explorer.togglePlanet('unknown'), false);
  }
});

test('a shared transit owner changes both lifetime getters immediately and preserves red choices across day/lifetime', async () => {
  const owner = createTransitPlanetFilter(), h = explorerHarness(fullMeta, { planetFilter: owner });
  await h.explorer.open();
  assert.deepEqual(h.explorer.state.selectedDesignPlanets, []);
  assert.deepEqual(h.explorer.current.activations.design, []);
  const initial = h.explorer.current;
  owner.setPlanet('moon', true, 'design');
  assert.notEqual(h.explorer.current, initial);
  assert.equal(h.explorer.state.current, h.explorer.current);
  assert.deepEqual(h.explorer.state.selectedDesignPlanets, ['moon']);
  assert.deepEqual(h.explorer.current.activations.design, h.day.current.activations.design.filter(e => e.planet === 'moon'));
  assert.equal(h.explorer.current.planetFilter.designActivations, h.day.current.activations.design);
  assert.equal(h.calls.length, 0, 'day filtering never requests a second calculation');
  h.explorer.togglePlanet('earth', 'design'); h.explorer.setAllPlanets(false);
  await settle(h, h.explorer.setDateRange('1801-01-01', '2399-12-31'));
  assert.deepEqual(h.explorer.current.activations.personality, []);
  assert.deepEqual(h.explorer.current.activations.design.map(e => e.planet), ['earth', 'moon']);
  const before = h.calls.length;
  h.explorer.toggleAllPlanets('design'); assert.equal(h.explorer.current.activations.design.length, 13);
  h.explorer.toggleAllPlanets('design'); assert.deepEqual(h.explorer.current.activations.design, []);
  assert.equal(h.calls.length, before);
  h.explorer.setPlanet('south_node', true, 'design'); h.explorer.close(); await h.explorer.open();
  assert.deepEqual(h.explorer.state.selectedDesignPlanets, ['south_node']);
  assert.deepEqual(h.explorer.current.activations.design, h.day.current.activations.design.filter(e => e.planet === 'south_node'));
});

test('Lifetime and day remember the shared Design selection while restoring all day black planets', async () => {
  const owner = createTransitPlanetFilter(), h = explorerHarness(fullMeta, { planetFilter: owner });
  assert.equal(owner.filter(h.day.current).planetFilter.perPlanetControls, false);
  assert.deepEqual(owner.state.selectedDesignPlanets, []);
  owner.setAllPlanets(true, 'design');
  await h.explorer.open();
  assert.equal(h.states[0].current.planetFilter.perPlanetControls, true);
  assert.equal(h.renders[0].planetFilter.perPlanetControls, true);
  assert.equal(h.renders[0].activations.design.length, 13, 'opening Lifetime remembers enabled Design');
  h.explorer.setAllPlanets(false, 'design');
  h.explorer.setPlanet('moon', false); h.explorer.setPlanet('sun', true, 'design');
  const selected = owner.state;
  await settle(h, h.explorer.setDateRange('1801-01-01', '2399-12-31'));
  assert.equal(h.explorer.current.planetFilter.perPlanetControls, true);
  const renders = h.renders.length;
  h.explorer.close();
  assert.equal(h.states.at(-1).current, null, 'closed Lifetime no longer owns a filtered chart');
  assert.equal(owner.filter(h.day.current).planetFilter.perPlanetControls, false);
  assert.equal(h.renders.length, renders + 1, 'the session is rendered after compact metadata is restored');
  assert.deepEqual(owner.state, { selectedPlanets: PLANET_IDS, selectedDesignPlanets: PLANET_IDS });
  assert.equal(owner.filter(h.day.current).activations.personality.length, 13);
  await h.explorer.open();
  assert.equal(h.explorer.current.planetFilter.perPlanetControls, true);
  assert.deepEqual(owner.state, selected); assert.equal(h.calls.length, 1, 'reopening only borrows the current day');
});

test('closed Lifetime state reads retain one filtered live chart per minute without evicting its owner', async () => {
  const owner = createTransitPlanetFilter(), h = explorerHarness(fullMeta, { planetFilter: owner });
  const session = createChartSession({ store: { get: () => null, has: () => false },
    getLifetime: () => h.explorer, getTransit: () => ({ current: h.day.current }), filterTransit: owner.filter });
  await openLifetime(h);
  h.explorer.setPlanet('moon', false); h.explorer.setPlanet('sun', true, 'design');
  const selection = owner.snapshot, requests = h.calls.length;
  h.explorer.close();
  for (const utc of [h.day.current.utc, '2026-09-30T09:35:00Z']) {
    if (utc !== h.day.current.utc) h.setDay(dayChart(utc));
    session.publish('transit', h.day.current);
    const charts = new Set(), states = [];
    for (let index = 0; index < 50; index++) {
      states.push(h.explorer.state);
      charts.add(session.current);
    }
    assert.equal(charts.size, 1, 'closed-state notifications cannot recreate the unchanged live projection');
    assert.ok(states.every(state => state.current === null));
    assert.equal(session.current.utc, utc);
    assert.equal(session.current.primary.activations.personality.length, 13);
    assert.equal(session.current.primary.activations.design.length, 13);
  }
  assert.equal(h.calls.length, requests);
  await h.explorer.open();
  assert.equal(h.explorer.current.utc, h.day.current.utc);
  assert.deepEqual(owner.snapshot, selection, 'closing keeps raw selections for the next opening');
  assert.equal(h.explorer.current.activations.personality.length, 12);
  assert.deepEqual(h.explorer.current.activations.design.map(entry => entry.planet), ['sun']);
  assert.equal(h.calls.length, requests);
});

test('a complete lifetime response publishes both sides once and uses selections made while pending', async () => {
  const h = explorerHarness(); await h.explorer.open();
  const shown = h.explorer.current, renders = h.renders.length;
  const pending = h.explorer.setDateRange('1801-01-01', '2399-12-31'); await tick();
  const index = h.calls[0].index;
  assert.equal(h.explorer.current, shown); assert.equal(h.renders.length, renders);
  assert.equal(h.explorer.state.displayedUtc, Date.parse(shown.utc)); assert.equal(h.explorer.state.status, 'loading');
  h.explorer.setAllPlanets(false); h.explorer.setPlanet('venus', true, 'design');
  const beforeCompletion = h.renders.length;
  h.calls[0].resolve(moment(index, fullMeta)); await pending;
  assert.equal(h.renders.length, beforeCompletion + 1);
  assert.equal(h.explorer.state.displayedUtc, h.utc(index)); assert.equal(h.explorer.state.status, 'ready');
  assert.deepEqual(h.explorer.current.activations.personality, []);
  assert.deepEqual(h.explorer.current.activations.design.map(e => e.planet), ['venus']);
  assert.equal(h.explorer.current.designUtc, designAt(point(index, fullMeta).utc).designUtc);
  assert.equal(h.calls.length, 1);
});

test('superseded invalid pairs advance the latest target; a mismatched latest Design retains the whole visible chart', async () => {
  const h = explorerHarness(); await h.explorer.open();
  const shown = h.explorer.current;
  const pending = h.explorer.setDateRange('1801-01-01', '2399-12-31'); await tick();
  h.explorer.scrub(h.utc(1)); h.calls[0].resolve(point(h.calls[0].index, fullMeta)); await tick();
  assert.equal(h.calls[1].index, 1); assert.equal(h.explorer.current, shown);
  h.calls[1].resolve({ ...moment(1, fullMeta), design: designAt(point(2, fullMeta).utc) }); await pending;
  assert.equal(h.explorer.state.status, 'loading'); assert.equal(h.explorer.state.retryCount, 1); assert.equal(h.explorer.current, shown);
  assert.equal(h.explorer.state.displayedUtc, Date.parse(shown.utc));
  const retry = h.explorer.retry(); await tick(); h.calls[2].resolve(moment(1, fullMeta)); await retry;
  assert.equal(h.explorer.state.displayedUtc, h.utc(1)); assert.equal(h.explorer.current.utc, point(1, fullMeta).utc);
});

test('closing or switching to the day cancels the complete request and its late pair cannot replace the day', async () => {
  for (const exit of ['close', 'day']) {
    const h = explorerHarness(); await h.explorer.open();
    const pending = h.explorer.setDateRange('1801-01-01', '2399-12-31'); await tick();
    const stale = h.calls[0];
    if (exit === 'close') { h.explorer.close(); h.setDay(dayChart('2026-09-30T18:27:00Z')); await h.explorer.open(); }
    else h.explorer.setDateRange('2026-09-30', '2026-09-30');
    assert.equal(stale.signal.aborted, true);
    const current = h.explorer.current; stale.resolve(moment(stale.index, fullMeta)); await pending;
    assert.equal(h.explorer.current, current); assert.equal(h.explorer.current.utc, h.day.current.utc);
    assert.equal(h.explorer.state.mode, 'day');
  }
});

test('lifetime restoration fetches the saved index first after loading metadata and clamping the range', async () => {
  for (const [saved, wanted] of [[200, 200], [-99, 144], [999, 287]]) {
    const h = explorerHarness(meta);
    const pending = h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '1900-01-02', toDate: '1900-01-02', index: saved });
    await tick();
    assert.deepEqual(h.calls.map(c => c.index), [wanted], 'restore must not load the current day or range start before the saved point');
    assert.deepEqual([h.explorer.state.minUtc, h.explorer.state.maxUtc], [Date.parse('1900-01-02T00:00:00Z'), Date.parse('1900-01-02T23:59:59.999Z')]);
    h.calls[0].resolve(moment(wanted));
    assert.equal(await pending, true);
    assert.equal(h.explorer.current.utc, point(wanted).utc);
    assert.equal(h.explorer.state.displayedUtc, h.utc(wanted));
  }
});

test('day restoration borrows the live day while malformed or closed snapshots stay unopened', async () => {
  const valid = { opened: true, mode: 'lifetime', fromDate: '1900-01-02', toDate: '1900-01-02', index: 200 };
  for (const invalid of [null, {}, { ...valid, opened: false }, { ...valid, mode: 'unknown' },
    { ...valid, index: 1.5 }, { ...valid, index: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, fromDate: '1900-02-30' }, { ...valid, fromDate: '1900-01-03' }]) {
    const h = explorerHarness(meta);
    assert.equal(await h.explorer.restore(invalid), false);
    assert.equal(h.explorer.state.opened, false); assert.equal(h.calls.length, 0);
  }
  const h = explorerHarness(meta);
  assert.equal(await h.explorer.restore({ opened: true, mode: 'day' }), true);
  assert.equal(h.explorer.current.utc, h.day.current.utc);
  assert.equal(h.explorer.state.mode, 'day'); assert.equal(h.calls.length, 0);
  assert.equal(h.renders.length, 1, 'a restored day publishes its borrowed chart');
});

test('invalid lifetime bounds load no moment and preserve the borrowed day', async () => {
  const h = explorerHarness(meta);
  assert.equal(await h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '1800-01-01', toDate: '1900-01-02', index: 200 }), false);
  assert.equal(h.calls.length, 0); assert.equal(h.explorer.state.mode, 'day');
  assert.equal(h.explorer.current.utc, h.day.current.utc);
});

test('closing during restore metadata prevents stale metadata and lifetime publication', async () => {
  const waiting = deferred(), points = [];
  const explorer = createLifetimeExplorer({ client: { getMeta: () => waiting.promise, getPoint: async i => { points.push(i); return moment(i); } } });
  const pending = explorer.restore({ opened: true, mode: 'lifetime', fromDate: '1900-01-02', toDate: '1900-01-02', index: 200 });
  await tick(); explorer.close(); waiting.resolve(meta);
  assert.equal(await pending, false); assert.equal(explorer.state.metadata, null);
  assert.equal(explorer.current, null); assert.deepEqual(points, []);
});

test('later user range cancels a restore point before it can replace the chosen range', async () => {
  const h = explorerHarness(meta);
  const pending = h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '1900-01-02', toDate: '1900-01-03', index: 200 });
  await tick(); const stale = h.calls[0];
  const changed = h.explorer.setDateRange('1900-01-03', '1900-01-03'); await tick();
  assert.equal(stale.signal.aborted, true);
  stale.resolve(moment(200)); await pending;
  assert.notEqual(h.explorer.state.displayedUtc, h.utc(200));
  h.calls.at(-1).resolve(moment(288)); await changed;
  assert.equal(h.explorer.current.utc, '1900-01-03T00:00:00Z');
});

test('an empty lifetime end keeps the slider active through the final available moment', async () => {
  for (const end of [null, '', undefined]) {
    const h = explorerHarness(meta); await h.explorer.open();
    const pending = h.explorer.setDateRange('1900-01-02', end);
    assert.notEqual(pending, false);
    await tick();
    assert.equal(h.explorer.state.mode, 'lifetime'); assert.equal(h.explorer.state.openEnded, true);
    assert.deepEqual([h.explorer.state.fromDate, h.explorer.state.toDate, h.explorer.state.minUtc, h.explorer.state.maxUtc],
      ['1900-01-02', '1900-01-03', Date.parse('1900-01-02T00:00:00Z'), Date.parse('1900-01-03T23:59:59.999Z')]);
    h.calls[0].resolve(moment(h.calls[0].index)); await pending;
    const final = h.explorer.scrub(h.utc(431)); await tick();
    h.calls.at(-1).resolve(moment(431)); await final;
    assert.equal(h.explorer.current.utc, '1900-01-03T23:50:00Z');
    assert.equal(h.explorer.state.status, 'ready'); assert.equal(h.explorer.state.requestedUtc, h.utc(431));
  }
});

test('the same effective lifetime end switches between open and explicit bounds without another point', async () => {
  const h = explorerHarness(meta); await h.explorer.open();
  const pending = h.explorer.setDateRange('1900-01-02', null); await tick();
  assert.notEqual(pending, false); h.calls[0].resolve(moment(h.calls[0].index)); await pending;
  assert.equal(h.explorer.setDateRange('1900-01-02', '1900-01-03'), true);
  assert.equal(h.explorer.state.openEnded, false); assert.equal(h.calls.length, 1);
  assert.equal(h.explorer.setDateRange('1900-01-02', null), true);
  assert.equal(h.explorer.state.openEnded, true); assert.equal(h.calls.length, 1);
  h.explorer.close(); await h.explorer.open();
  assert.equal(h.explorer.state.mode, 'day'); assert.equal(h.explorer.state.openEnded, false);
});

test('open-ended lifetime restoration uses current metadata edge rather than the stored old end', async () => {
  const h = explorerHarness(meta);
  const pending = h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '1900-01-02', toDate: '1900-01-02', openEnded: true, index: 431 });
  await tick();
  assert.deepEqual(h.calls.map(c => c.index), [431]);
  assert.deepEqual([h.explorer.state.toDate, h.explorer.state.maxUtc, h.explorer.state.openEnded], ['1900-01-03', Date.parse('1900-01-03T23:59:59.999Z'), true]);
  h.calls[0].resolve(moment(431)); assert.equal(await pending, true);
  assert.equal(await h.explorer.restore({ opened: true, mode: 'day' }), true);
  assert.equal(h.explorer.state.openEnded, false);
});

test('a personal birth boundary clips the lifetime range and clamps restored pre-birth indices to the same endpoint', async () => {
  const h = explorerHarness(meta);
  const pending = h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '1900-01-02', toDate: '1900-01-03',
    minimumUtc: '1900-01-02T12:34:56Z', index: 144 });
  await tick();
  assert.equal(h.explorer.state.minUtc, Date.parse('1900-01-02T12:34:56Z'));
  assert.deepEqual(h.calls.map(call => call.index), [220]);
  h.calls[0].resolve(moment(220)); await pending;
  h.explorer.scrub(h.utc(0));
  assert.equal(h.explorer.state.requestedUtc, h.utc(220));
  assert.equal(h.calls.length, 1);
});

test('cold Now supersedes a queued lifetime scrub before a late response or failure can load another point', async () => {
  for (const fail of [false, true]) {
    let owner = null;
    const h = explorerHarness(meta, { getMomentState: () => owner });
    await h.explorer.open();
    const initial = h.explorer.setDateRange('1900-01-01', '1900-01-03');
    await tick(); h.calls[0].resolve(moment(h.calls[0].index)); await initial; h.calls.length = 0; h.renders.length = 0;
    const previous = h.explorer.current;
    const loading = h.explorer.scrub(h.utc(10)); await tick(); h.explorer.scrub(h.utc(11));
    owner = { current: null, status: 'loading', live: true };
    if (fail) h.calls[0].reject(new Error('Old point failed'));
    else h.calls[0].resolve(moment(10));
    await tick();
    assert.deepEqual(h.calls.map(call => call.index), [10], 'the superseded coalesced point is never requested');
    assert.equal(await loading, true);
    assert.equal(h.explorer.state.status, 'loading');
    assert.equal(h.explorer.state.error, '');
    assert.equal(h.explorer.current, previous, 'the obsolete result never becomes a visible frame');
    assert.deepEqual(h.renders, []);
    owner = { current: dayChart('1900-01-02T00:01:00Z'), status: 'ready', live: true };
    h.explorer.alignMoment(owner.current);
    assert.equal(h.explorer.current.utc, owner.current.utc);
    assert.equal(h.calls.length, 1);
  }
});


for (const source of ['metadata', 'point', 'minute']) test(`${source} failures retry automatically with a bounded delay and preserve the chosen moment`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const saved = Date.parse('2026-09-30T09:37:00Z'), chart = dayChart();
  const failFirst = () => { if (++attempts <= 7) throw new Error('temporary failure'); };
  const explorer = createLifetimeExplorer({ getDayState: () => ({ current: chart, timeline: { date: '2026-09-30' } }), client: {
    getMeta: async () => { if (source === 'metadata') failFirst(); return fullMeta; },
    getPoint: async index => { failFirst(); return moment(index, fullMeta); },
    getMinute: async utc => { failFirst(); return dayChart(new Date(utc).toISOString()); },
  } });
  t.after(() => explorer.close());
  if (source === 'metadata') await explorer.open();
  else if (source === 'point') { await explorer.open(); await explorer.setDateRange('2026-09-29', '2026-10-01'); }
  else await explorer.restore({ opened: true, mode: 'lifetime', fromDate: '2026-09-29', toDate: '2026-10-01', requestedUtc: saved });
  const target = explorer.state.requestedUtc, shown = explorer.current;
  assert.equal(attempts, 1); assert.equal(explorer.state.retryCount, 1);
  assert.equal(explorer.state.status, 'loading'); assert.equal(explorer.state.error, '');
  for (const [index, delay] of [1000, 2000, 4000, 8000, 16000, 30000, 30000].entries()) {
    t.mock.timers.tick(delay - 1); await tick();
    assert.equal(attempts, index + 1, 'the controller never retries before the deadline');
    assert.equal(explorer.current, shown, 'a failed attempt never replaces the visible chart');
    t.mock.timers.tick(1); await tick();
    assert.equal(attempts, index + 2);
  }
  assert.equal(explorer.state.retryCount, 0); assert.equal(explorer.state.status, 'ready');
  assert.equal(explorer.state.requestedUtc, target);
  if (source === 'minute') assert.equal(Date.parse(explorer.current.utc), saved);
});

test('closing or selecting a new moment cancels a pending retry instead of reviving its old target', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = explorerHarness(); t.after(() => h.explorer.close());
  await h.explorer.open();
  let loading = h.explorer.setDateRange('1801-01-01', '2399-12-31'); await tick();
  h.calls[0].reject(new Error('offline')); await loading;
  assert.equal(h.explorer.state.retryCount, 1);
  loading = h.explorer.scrub(h.utc(1)); await tick();
  assert.equal(h.explorer.state.retryCount, 0); assert.equal(h.calls.length, 2);
  h.calls[1].resolve(moment(1, fullMeta)); await loading;
  t.mock.timers.tick(5000); await tick();
  assert.equal(h.calls.length, 2); assert.equal(h.explorer.state.displayedUtc, h.utc(1));
  loading = h.explorer.scrub(h.utc(2)); await tick();
  h.calls[2].reject(new Error('offline')); await loading;
  h.explorer.close(); t.mock.timers.tick(60000); await tick();
  assert.equal(h.calls.length, 3); assert.equal(h.explorer.state.retryCount, 0);
});


test('day clock updates cannot erase metadata retry feedback or its failure count', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let chart = dayChart(), fail = true;
  const explorer = createLifetimeExplorer({ getDayState: () => ({ current: chart }), client: {
    getMeta: async () => { if (fail) throw new Error('offline metadata'); return fullMeta; },
  } });
  t.after(() => explorer.close());
  await explorer.open();
  chart = dayChart('2026-09-30T09:35:00Z'); explorer.syncDay();
  assert.equal(explorer.current.utc, chart.utc);
  assert.equal(explorer.state.status, 'loading'); assert.equal(explorer.state.retryCount, 1);
  fail = false; t.mock.timers.tick(1000); await tick();
  assert.equal(explorer.state.status, 'ready'); assert.equal(explorer.state.retryCount, 0);
});


for (const minute of [false, true]) test(`a rejected lifetime revision refreshes metadata and preserves ${minute ? 'the exact minute' : 'UTC across shifted indexes'}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const oldMeta = { ...meta, cacheVersion: 'a'.repeat(64) };
  const newMeta = { ...meta, startUtc: '1899-12-31T00:00:00Z', samples: 576, cacheVersion: 'b'.repeat(64) };
  const requestedUtc = Date.parse(minute ? '1900-01-02T00:01:00Z' : '1900-01-02T00:00:00Z');
  const maximumUtc = '1900-01-03T12:34:56Z';
  const calls = []; let updated = false;
  const client = createLifetimeClient({ fetch(url) {
    calls.push(url);
    if (url.endsWith('/meta')) return response(updated ? newMeta : oldMeta);
    const parsed = new URL(url, 'http://local');
    if (updated && parsed.searchParams.get('v') === oldMeta.cacheVersion) {
      return { ok: false, json: async () => ({ error: 'unsupported_version' }) };
    }
    const currentMeta = updated ? newMeta : oldMeta;
    if (parsed.pathname.endsWith('/moment')) {
      const utc = parsed.searchParams.get('utc');
      return response({ version: '1', utc, longitudes: point(0).longitudes, design: designAt(utc) });
    }
    return response(moment(Number(parsed.searchParams.get('index')), currentMeta));
  } });
  const explorer = createLifetimeExplorer({ client }); t.after(() => explorer.close());
  await explorer.open(); await client.getPoint(0); updated = true;
  await explorer.restore({ opened: true, mode: 'lifetime', fromDate: '1900-01-01', toDate: '1900-01-03', maximumUtc, requestedUtc });
  t.mock.timers.tick(1000); await tick();
  assert.equal(explorer.state.status, 'ready');
  assert.equal(explorer.state.metadata.cacheVersion, newMeta.cacheVersion);
  assert.equal(explorer.state.maxUtc, Date.parse(maximumUtc), 'refreshing numerical data preserves the personal centenary');
  assert.equal(explorer.state.requestedUtc, requestedUtc);
  assert.equal(Date.parse(explorer.current.utc), requestedUtc);
  assert.equal(explorer.state.fromDate, '1900-01-01'); assert.equal(explorer.state.toDate, '1900-01-03');
  assert.equal(calls.filter(url => url.endsWith('/meta')).length, 2);
  if (!minute) assert.match(calls.at(-1), /index=288&v=b{64}$/);
  assert.equal((await client.getPoint(0)).utc, newMeta.startUtc, 'old memory entries cannot survive a revision change');
  const complete = calls.length; t.mock.timers.tick(60000); await tick();
  assert.equal(calls.length, complete, 'success stops automatic retries');
});


test('a personal rail stops at the exact calendar centenary instead of the end of its day', async () => {
  const birth = '2000-02-29T12:34:56Z', anniversary = Date.parse('2100-03-01T12:34:56Z');
  const span = lifeTimelineForChart({ utc: birth });
  assert.equal(Date.parse(span.maximumUtc), anniversary);
  const h = explorerHarness(fullMeta, { getMomentState: () => ({ current: dayChart(birth), status: 'ready' }) });
  assert.equal(await h.explorer.restore({ opened: true, mode: 'lifetime', ...span, minimumUtc: birth, requestedUtc: Date.parse(birth) }), true);
  assert.equal(h.explorer.state.maxUtc, anniversary);
  assert.equal(h.explorer.state.minUtc, Date.parse(birth));
  assert.equal(h.calls.length, 0);
});


test('an empty lifetime start uses the first available instant', async () => {
  for (const from of [null, '', undefined]) {
    const h = explorerHarness(meta); await h.explorer.open();
    const pending = h.explorer.setDateRange(from, '1900-01-02'); await settle(h, pending, meta);
    assert.deepEqual([h.explorer.state.fromDate, h.explorer.state.minUtc, h.explorer.state.openStart],
      ['1900-01-01', Date.parse(meta.startUtc), true]);
    const calls = h.calls.length;
    assert.equal(h.explorer.setDateRange('1900-01-01', '1900-01-02'), true);
    assert.equal(h.explorer.state.openStart, false); assert.equal(h.calls.length, calls);
    assert.equal(h.explorer.setDateRange(null, '1900-01-02'), true);
    assert.equal(h.explorer.state.openStart, true); assert.equal(h.calls.length, calls);
    h.explorer.close(); await h.explorer.open(); assert.equal(h.explorer.state.openStart, false);
  }
});

test('open-start restoration uses the available lower bound instead of a stored former start', async () => {
  const h = explorerHarness(meta);
  const pending = h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '1900-01-02', toDate: '1900-01-03', openStart: true, index: 0 });
  await settle(h, pending, meta);
  assert.deepEqual([h.explorer.state.fromDate, h.explorer.state.minUtc, h.explorer.state.openStart],
    ['1900-01-01', Date.parse(meta.startUtc), true]);
  assert.equal(await h.explorer.restore({ opened: true, mode: 'day' }), true);
  assert.equal(h.explorer.state.openStart, false);
});

for (const openStart of [true, false]) test(`metadata expansion ${openStart ? 'expands an open start' : 'preserves an exact personal lower bound'}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const nextMeta = { ...meta, startUtc: '1899-12-31T00:00:00Z', samples: 576 };
  let metadataCalls = 0, pointCalls = 0;
  const explorer = createLifetimeExplorer({ client: {
    async getMeta() { return ++metadataCalls === 1 ? meta : nextMeta; },
    async getPoint(index) {
      if (++pointCalls === 1) throw Object.assign(new Error('Версия изменилась'), { code: 'unsupported_version' });
      return moment(index, nextMeta);
    },
  } });
  t.after(() => explorer.close());
  const minimumUtc = '1900-01-01T12:34:56Z', requestedUtc = Date.parse('1900-01-02T00:00:00Z');
  await explorer.restore({ opened: true, mode: 'lifetime', fromDate: '1900-01-01', toDate: '1900-01-03',
    requestedUtc, openStart, ...(openStart ? {} : { minimumUtc }) });
  t.mock.timers.tick(1000); await tick();
  assert.equal(explorer.state.status, 'ready'); assert.equal(metadataCalls, 2);
  assert.equal(explorer.state.openStart, openStart);
  assert.equal(explorer.state.minUtc, Date.parse(openStart ? nextMeta.startUtc : minimumUtc));
  assert.equal(explorer.state.fromDate, openStart ? '1899-12-31' : '1900-01-01');
  assert.equal(explorer.state.requestedUtc, requestedUtc);
});
