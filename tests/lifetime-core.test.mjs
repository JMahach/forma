import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifetimeClient } from '../src/data/lifetime-client.js';
import { createLifetimeExplorer } from '../src/state/lifetime.js';
import { LIFETIME_PLANETS, lifetimeChartAt, validateLifetimeMetadata, validateLifetimeMoment } from '../src/domain/lifetime.js';
import { createTransitPlanetFilter } from '../src/state/transit-planets.js';
import { gatePositionAtLongitude } from '../src/domain/gate-wheel.js';
import { PLANET_IDS } from '../src/domain/planets.js';
import { createTransitDayClient } from '../src/data/transit-day-client.js';
import { transitChartAt } from '../src/domain/transit-day.js';
import { encodeTransitDay } from '../server/packets/encode.mjs';
import { TRANSIT_DAY_VERSION } from '../shared/day-packets/transit-format.js';

const meta = { startUtc: '1900-01-01T00:00:00Z', endExclusiveUtc: '1900-01-04T00:00:00Z', stepSeconds: 600, samples: 432, planets: [...LIFETIME_PLANETS] };
const point = (index, metadata = meta) => ({ index, utc: new Date(Date.parse(metadata.startUtc) + index * 600000).toISOString().replace('.000Z', 'Z'), longitudes: [335.74999999999994, 22, 335.74999999999994, 44, 55, 66, 77, 88, 99, 111, 122] });
const fullMeta = { ...meta, startUtc: '1801-01-01T00:00:00Z', endExclusiveUtc: '2400-01-01T00:00:00Z',
  samples: (Date.parse('2400-01-01T00:00:00Z') - Date.parse('1801-01-01T00:00:00Z')) / 600000 };
const archiveIndex = (date, metadata = fullMeta) => (Date.parse(date.length === 10 ? `${date}T00:00:00Z` : date) - Date.parse(metadata.startUtc)) / 600000;
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
function explorerHarness(metadata = fullMeta, { planetFilter } = {}) {
  const calls = [], metaCalls = [], renders = [], states = [];
  let day = { current: dayChart(), timeline: { date: '2026-09-30', timeZone: 'Europe/Moscow' } };
  let time = Date.parse('2026-09-30T09:34:56.789Z');
  const explorer = createLifetimeExplorer({ client: {
    getMeta: async options => { metaCalls.push(options); return metadata; },
    getPoint(index, { signal }) { const waiting = deferred(); calls.push({ index, signal, ...waiting }); return waiting.promise; },
  }, getDayState: () => day, now: () => time, planetFilter,
  onRender: () => renders.push(explorer.current), onStateChange: state => states.push(state) });
  return { explorer, calls, metaCalls, renders, states, get day() { return day; },
    setNow(value) { time = Date.parse(value); },
    setDay(current, timeline = { date: current.birthDate, timeZone: current.timezone }) { day = { current, timeline }; } };
}

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

test('client coalesces same point, isolates cancellation and retains validated immutable values', async () => {
  const waiting = deferred(), calls = []; let transport;
  const client = createLifetimeClient({ fetch(url, { signal }) { calls.push(url); if (url.endsWith('/meta')) return Promise.resolve(response(meta)); transport = signal; return waiting.promise; } });
  const firstController = new AbortController();
  const first = client.getPoint(3, { signal: firstController.signal }), second = client.getPoint(3);
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await tick(); firstController.abort(); await rejected;
  assert.equal(transport.aborted, false); waiting.resolve(response(moment(3)));
  const actual = await second;
  assert.equal(calls.filter(url => url.includes('?')).length, 1);
  assert.equal(await client.getPoint(3), actual);
  assert.ok(Object.isFrozen(actual)); assert.ok(Object.isFrozen(actual.longitudes));
});

test('client cancels abandoned transport, never caches stale completion, and retries failures', async () => {
  const calls = [], firstWaiting = deferred();
  const client = createLifetimeClient({ fetch(url, { signal }) { if (url.endsWith('/meta')) return response(meta); calls.push({ url, signal }); return calls.length === 1 ? firstWaiting.promise : response(moment(2)); } });
  const controller = new AbortController(), first = client.getPoint(2, { signal: controller.signal });
  const rejection = assert.rejects(first, { name: 'AbortError' }); await tick(); controller.abort(); await rejection;
  assert.equal(calls[0].signal.aborted, true);
  const next = await client.getPoint(2); firstWaiting.resolve(response({ ...moment(2), longitudes: Array(11).fill(99) })); await tick();
  assert.equal(await client.getPoint(2), next); assert.equal(calls.length, 2);
  let attempts = 0;
  const retrying = createLifetimeClient({ fetch(url) { if (url.endsWith('/meta')) return response(meta); if (++attempts === 1) throw new Error('offline'); return response(moment(1)); } });
  await assert.rejects(retrying.getPoint(1), /offline/); assert.equal((await retrying.getPoint(1)).index, 1);
});

test('client validates before caching and its LRU stays bounded to 256 visited points', async () => {
  const calls = [], client = createLifetimeClient({ capacity: 10000, fetch(url) { if (url.endsWith('/meta')) return response(meta); const index = Number(new URL(url, 'http://local').searchParams.get('index')); calls.push(index); return response(moment(index)); } });
  for (let index = 0; index <= 256; index++) await client.getPoint(index);
  const before = calls.length; await client.getPoint(256); assert.equal(calls.length, before);
  await client.getPoint(0); assert.equal(calls.length, before + 1);
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
    assert.equal(await client.getPoint(1), accepted); assert.equal(attempts, 2);
    assert.ok(Object.isFrozen(accepted.design)); assert.ok(Object.isFrozen(accepted.design.longitudes));
  }
});

test('validated moments stay immutable and reusable only for their own archive and requested index', () => {
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
  const otherArchive = validateLifetimeMetadata({ ...meta, startUtc: '1901-01-01T00:00:00Z', endExclusiveUtc: '1901-01-04T00:00:00Z' });
  assert.throws(() => validateLifetimeMoment(accepted, otherArchive, 1));
  assert.throws(() => validateLifetimeMoment(Object.freeze({ ...accepted, utc: point(2).utc }), metadata, 1));
  assert.throws(() => validateLifetimeMoment(Object.freeze({ ...accepted, longitudes: Object.freeze(Array(11)) }), metadata, 1));
  assert.throws(() => validateLifetimeMoment({ ...accepted, design: { ...accepted.design, longitudes: Array(11) } }, metadata, 1));
  assert.throws(() => validateLifetimeMoment({ ...accepted, design: { ...accepted.design, designUtc: new Date(accepted.design.designUtc) } }, metadata, 1));
  assert.throws(() => validateLifetimeMetadata({ ...meta, planets: Array(meta.planets.length) }));
});

const decodedDay = date => ({ version: TRANSIT_DAY_VERSION, date, startUtc: `${date}T00:00:00Z`, stepSeconds: 60, samples: 1440,
  engine: 'Swiss Ephemeris 2.10.03', ephemeris: 'test ephemeris', timezoneDatabase: 'test tzdata', nodeModel: 'true', zodiac: 'tropical-geocentric-apparent',
  columns: Array.from({ length: 24 }, (_, column) => Float64Array.from({ length: 1440 }, (_, minute) => column < 22
    ? (column * 13 + minute / 10000 + 0.123456789012345) % 360
    : column === 22 ? Date.parse(`${date}T00:00:00Z`) / 1000 - 88 * 86400 + minute * 61 : minute % 100 * 1e-12)),
});

test('Years reuses a real decoded day at exact UTC with all black/red Float64 values and no point request', async () => {
  const raw = decodedDay('1900-01-02'), dayRequests = [], requests = [];
  const dayClient = createTransitDayClient({ fetch: async url => { dayRequests.push(url); return { ok: true, arrayBuffer: async () => encodeTransitDay(raw).buffer }; } });
  const day = await dayClient.getDay(raw.date);
  const client = createLifetimeClient({ dayClient, fetch(url) {
    requests.push(url); assert.equal(url, '/api/lifetime/meta'); return response({ ...meta, source: raw.engine });
  } });
  const index = 144 + 75, sample = await client.getPoint(index), minute = 750;
  assert.equal(sample.utc, '1900-01-02T12:30:00Z'); assert.equal(sample.design.utc, sample.utc);
  for (let column = 0; column < 11; column++) {
    assert.ok(Object.is(sample.longitudes[column], day.columns[column][minute]));
    assert.ok(Object.is(sample.design.longitudes[column], day.columns[column + 11][minute]));
  }
  assert.equal(sample.design.designUtc, new Date(day.columns[22][minute] * 1000).toISOString().replace('.000Z', 'Z'));
  assert.ok(Object.is(sample.design.designArcResidualDegrees, day.columns[23][minute]));
  assert.equal(await client.getPoint(index), sample);
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
      fetch(url) { requests.push(url); return response(url.endsWith('/meta') ? { ...meta, source: raw.engine } : moment(144)); } });
    assert.deepEqual(await client.getPoint(144), moment(144));
    assert.deepEqual(requests, ['/api/lifetime/meta', '/api/lifetime?index=144']); assert.deepEqual(peeks, ['1900-01-02']);
  }
  const dayRequests = [], requests = [];
  const dayClient = createTransitDayClient({ fetch: async url => { dayRequests.push(url); return { ok: true, arrayBuffer: async () => encodeTransitDay(raw).buffer }; } });
  await dayClient.getDay(raw.date);
  const client = createLifetimeClient({ dayClient, fetch(url) { requests.push(url); return response(url.endsWith('/meta') ? { ...meta, source: raw.engine } : moment(288)); } });
  assert.equal((await client.getPoint(288)).utc, '1900-01-03T00:00:00Z');
  assert.equal(dayRequests.length, 1); assert.deepEqual(requests, ['/api/lifetime/meta', '/api/lifetime?index=288']);
});

test('default Years client receives the shared day cache through controller options', async t => {
  const day = decodedDay('2026-09-30'), requests = [], peeks = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(url);
    assert.equal(url, '/api/lifetime/meta', 'a cached archive minute needs no point request');
    return response({ ...fullMeta, source: day.engine });
  });
  const owner = createTransitPlanetFilter(); owner.setAllPlanets(true, 'design');
  const explorer = createLifetimeExplorer({ planetFilter: owner,
    dayClient: { peekDay(date) { peeks.push(date); return date === day.date ? day : null; } },
    getDayState: () => ({ current: dayChart(), timeline: { date: day.date, timeZone: 'Europe/Moscow' } }),
  });
  await explorer.open();
  await explorer.setDateRange('2025-01-01', '2027-01-01');
  assert.equal(explorer.state.status, 'ready');
  assert.equal(explorer.current.utc, '2026-09-30T09:30:00Z');
  assert.equal(explorer.current.activations.personality[0].longitude, day.columns[0][570]);
  assert.equal(explorer.current.activations.design[0].longitude, day.columns[11][570]);
  assert.deepEqual(requests, ['/api/lifetime/meta']); assert.deepEqual(peeks, [day.date]);
});

async function settle(h, pending, metadata = fullMeta) {
  await tick(); const call = h.calls.at(-1); call.resolve(moment(call.index, metadata)); return pending;
}

async function openArchive(h, from = '1801-01-01', through = '2399-12-31') {
  await h.explorer.open();
  return settle(h, h.explorer.setDateRange(from, through));
}

test('Years opens seamlessly on the exact current day chart and loads metadata without an archive point', async () => {
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

test('a custom full archive range uses the current shown moment at the ten-minute grid', async () => {
  const h = explorerHarness(); await openArchive(h);
  assert.equal(h.calls.length, 1); assert.equal(h.explorer.state.mode, 'archive');
  assert.deepEqual([h.explorer.state.fromDate, h.explorer.state.toDate], ['1801-01-01', '2399-12-31']);
  assert.deepEqual([h.explorer.state.minIndex, h.explorer.state.maxIndex], [0, fullMeta.samples - 1]);
  assert.equal(h.explorer.current.utc, '2026-09-30T09:30:00Z');
  const chart = h.explorer.current, renders = h.renders.length;
  h.setDay(dayChart('2026-09-30T13:45:00Z')); h.explorer.syncDay();
  assert.equal(h.explorer.current, chart, 'day updates cannot overwrite an archive point');
  assert.equal(h.renders.length, renders); assert.equal(h.calls.length, 1);
  assert.equal(h.explorer.setDateRange('1801-01-01', '2399-12-31'), true);
  assert.equal(h.calls.length, 1, 'an unchanged ready range does not reload');
});

test('one request at a time publishes progress and follows the latest scrub', async () => {
  const h = explorerHarness(); await openArchive(h);
  const pending = h.explorer.scrub(1); await tick();
  for (let i = 2; i <= 100; i++) h.explorer.scrub(i);
  assert.equal(h.calls.length, 2); h.calls[1].resolve(moment(1, fullMeta)); await tick();
  assert.equal(h.explorer.state.displayedIndex, 1); assert.equal(h.calls[2].index, 100);
  h.explorer.scrub(200); h.calls[2].resolve(moment(100, fullMeta)); await tick();
  assert.equal(h.explorer.state.displayedIndex, 100); assert.equal(h.calls[3].index, 200);
  h.calls[3].resolve(moment(200, fullMeta)); await pending;
  assert.equal(h.explorer.state.displayedIndex, 200); assert.equal(h.explorer.state.status, 'ready');
});

test('stale errors cannot starve the latest target; failed targets keep the visible chart', async () => {
  const h = explorerHarness(); await openArchive(h); const shown = h.explorer.current;
  const pending = h.explorer.scrub(2); await tick(); h.explorer.scrub(3);
  h.calls[1].reject(new Error('old failure')); await tick(); assert.equal(h.calls[2].index, 3);
  h.calls[2].reject(new Error('latest failure')); await pending;
  assert.equal(h.explorer.current, shown); assert.equal(h.explorer.state.error, 'latest failure');
  await settle(h, h.explorer.retry()); assert.equal(h.explorer.state.displayedIndex, 3);
});

test('narrowed ranges reject in-flight outside points, clamp the requested moment and include the whole leap day', async () => {
  const h = explorerHarness(); await openArchive(h);
  const pending = h.explorer.scrub(0); await tick();
  h.explorer.setDateRange('2000-02-29', '2000-02-29');
  h.calls[1].resolve(moment(0, fullMeta)); await tick();
  const target = archiveIndex('2000-02-29'); assert.equal(h.calls[2].index, target);
  assert.equal(h.explorer.state.maxIndex - h.explorer.state.minIndex + 1, 144);
  h.calls[2].resolve(moment(target, fullMeta)); await pending;
  assert.equal(h.explorer.current.utc, '2000-02-29T00:00:00Z');
  await settle(h, h.explorer.scrub(Number.MAX_SAFE_INTEGER));
  assert.equal(h.explorer.current.utc, '2000-02-29T23:50:00Z');
  await settle(h, h.explorer.scrub(-1)); assert.equal(h.explorer.current.utc, '2000-02-29T00:00:00Z');
});

test('invalid, incomplete, out of bounds, reversed and non-leap dates leave the day range unchanged', async () => {
  const h = explorerHarness(); await h.explorer.open(); const before = h.explorer.state;
  for (const pair of [['1800-12-31', '1900-01-01'], ['2399-01-01', '2400-01-01'], ['2000-01-02', '2000-01-01'],
    ['1900-02-29', '1900-03-01'], ['2000-02-30', '2000-03-01'], ['2000-1-1', '2000-01-02'], ['', '2000-01-01'], ['abc', '2000-01-01']]) {
    assert.equal(h.explorer.setDateRange(...pair), false);
  }
  assert.equal(h.explorer.state.current, before.current); assert.equal(h.calls.length, 0);
  assert.deepEqual([h.explorer.state.fromDate, h.explorer.state.toDate], [before.fromDate, before.toDate]);
  assert.equal(h.explorer.state.mode, 'day');
});

test('close cancels pending work; reopen borrows the latest day and retains planet choices', async () => {
  const h = explorerHarness(); await openArchive(h, '2000-01-01', '2000-01-02');
  h.explorer.setPlanet('moon', false);
  const pending = h.explorer.scrub(h.explorer.state.minIndex); await tick(); const stale = h.calls.at(-1), requests = h.calls.length;
  h.explorer.close(); assert.equal(stale.signal.aborted, true); assert.equal(h.explorer.current, null);
  h.setDay(dayChart('2026-09-30T15:42:11.000Z')); await h.explorer.open();
  stale.resolve(moment(stale.index, fullMeta)); await pending;
  assert.deepEqual([h.explorer.state.fromDate, h.explorer.state.toDate], ['2026-09-30', '2026-09-30']);
  assert.equal(h.explorer.state.selectedPlanets.includes('moon'), false);
  assert.equal(h.explorer.state.mode, 'day'); assert.equal(h.explorer.current.utc, h.day.current.utc);
  assert.equal(h.calls.length, requests, 'reopening needs no archive point'); assert.equal(h.metaCalls.length, 1);
});

test('selecting the current local day returns to day mode and ignores the cancelled archive completion', async () => {
  const h = explorerHarness(); await openArchive(h);
  const pending = h.explorer.scrub(0); await tick(); const stale = h.calls.at(-1);
  assert.equal(h.explorer.setDateRange('2026-09-30', '2026-09-30'), true);
  assert.equal(stale.signal.aborted, true); assert.equal(h.explorer.state.mode, 'day');
  assert.equal(h.explorer.current.utc, h.day.current.utc);
  const current = h.explorer.current, requests = h.calls.length;
  stale.resolve(moment(stale.index, fullMeta)); await pending;
  assert.equal(h.explorer.current, current); assert.equal(h.calls.length, requests);
});

test('the archive marker tracks actual now without moving the chosen chart and goNow stays inside the range', async () => {
  const h = explorerHarness(); await openArchive(h);
  const nowIndex = archiveIndex('2026-09-30T09:30:00Z'); assert.equal(h.explorer.state.referenceIndex, nowIndex);
  await settle(h, h.explorer.scrub(nowIndex - 10));
  const chart = h.explorer.current, renders = h.renders.length, points = h.calls.length, notices = h.states.length;
  h.setNow('2026-09-30T09:44:56.789Z'); h.explorer.syncClock();
  assert.equal(h.explorer.state.referenceIndex, nowIndex + 1); assert.equal(h.explorer.current, chart);
  assert.equal(h.renders.length, renders); assert.equal(h.calls.length, points); assert.equal(h.states.length, notices + 1);
  h.explorer.syncClock(); assert.equal(h.states.length, notices + 1);
  await settle(h, h.explorer.goNow()); assert.equal(h.explorer.state.displayedIndex, nowIndex + 1);
  await settle(h, h.explorer.setDateRange('1900-01-01', '1900-01-02'));
  assert.equal(h.explorer.state.referenceIndex, null); assert.equal(h.explorer.goNow(), undefined);
});

test('metadata failure retries while retaining the day chart, and closed metadata cannot publish', async () => {
  let attempts = 0, points = 0; const chart = dayChart();
  const explorer = createLifetimeExplorer({ getDayState: () => ({ current: chart, timeline: { date: '2026-09-30', timeZone: 'Europe/Moscow' } }), client: {
    getMeta: async () => { if (++attempts === 1) throw new Error('offline'); return fullMeta; }, getPoint: async i => { points++; return moment(i, fullMeta); },
  } });
  assert.equal(await explorer.open(), false); assert.equal(explorer.state.status, 'error'); assert.equal(explorer.current.utc, chart.utc);
  assert.equal(await explorer.retry(), true); assert.equal(explorer.state.mode, 'day'); assert.equal(explorer.state.status, 'ready'); assert.equal(points, 0);
  const waiting = deferred();
  const closed = createLifetimeExplorer({ getDayState: () => ({ current: chart, timeline: { date: '2026-09-30', timeZone: 'Europe/Moscow' } }), client: { getMeta: () => waiting.promise, getPoint: () => { points++; } } });
  const pending = closed.open(); await tick(); closed.close(); waiting.resolve(fullMeta); await pending;
  assert.equal(closed.state.metadata, null); assert.equal(points, 0);
});

test('all/none and individual derived planets reuse full day and archive records without API work', async () => {
  const h = explorerHarness(); await h.explorer.open();
  for (const mode of ['day', 'archive']) {
    if (mode === 'archive') await settle(h, h.explorer.setDateRange('1801-01-01', '2399-12-31'));
    const calls = h.calls.length, full = h.explorer.current.activations.personality;
    h.explorer.toggleAllPlanets(); assert.equal(h.explorer.current.activations.personality.length, 0);
    assert.deepEqual(h.explorer.current.planetFilter.activations, full);
    h.explorer.togglePlanet('earth'); assert.deepEqual(h.explorer.current.activations.personality, [full.find(e => e.planet === 'earth')]);
    h.explorer.togglePlanet('south_node'); assert.deepEqual(h.explorer.current.activations.personality, full.filter(e => ['earth', 'south_node'].includes(e.planet)));
    h.explorer.toggleAllPlanets(); assert.deepEqual(h.explorer.state.selectedPlanets, PLANET_IDS);
    assert.equal(h.calls.length, calls); assert.equal(h.explorer.togglePlanet('unknown'), false);
  }
});

test('a shared transit owner changes both lifetime getters immediately and preserves red choices across day/archive', async () => {
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

test('Years and day remember the shared Design selection while restoring all day black planets', async () => {
  const owner = createTransitPlanetFilter(), h = explorerHarness(fullMeta, { planetFilter: owner });
  assert.equal(owner.filter(h.day.current).planetFilter.perPlanetControls, false);
  assert.deepEqual(owner.state.selectedDesignPlanets, []);
  owner.setAllPlanets(true, 'design');
  await h.explorer.open();
  assert.equal(h.states[0].current.planetFilter.perPlanetControls, true);
  assert.equal(h.renders[0].planetFilter.perPlanetControls, true);
  assert.equal(h.renders[0].activations.design.length, 13, 'opening Years remembers enabled Design');
  h.explorer.setAllPlanets(false, 'design');
  h.explorer.setPlanet('moon', false); h.explorer.setPlanet('sun', true, 'design');
  const selected = owner.state;
  await settle(h, h.explorer.setDateRange('1801-01-01', '2399-12-31'));
  assert.equal(h.explorer.current.planetFilter.perPlanetControls, true);
  const renders = h.renders.length;
  h.explorer.close();
  assert.equal(h.states.at(-1).current.planetFilter.perPlanetControls, false);
  assert.equal(owner.filter(h.day.current).planetFilter.perPlanetControls, false);
  assert.equal(h.renders.length, renders + 1, 'the session is rendered after compact metadata is restored');
  assert.deepEqual(owner.state, { selectedPlanets: PLANET_IDS, selectedDesignPlanets: PLANET_IDS });
  assert.equal(owner.filter(h.day.current).activations.personality.length, 13);
  await h.explorer.open();
  assert.equal(h.explorer.current.planetFilter.perPlanetControls, true);
  assert.deepEqual(owner.state, selected); assert.equal(h.calls.length, 1, 'reopening only borrows the current day');
});

test('a complete archive response publishes both sides once and uses selections made while pending', async () => {
  const h = explorerHarness(); await h.explorer.open();
  const shown = h.explorer.current, renders = h.renders.length;
  const pending = h.explorer.setDateRange('1801-01-01', '2399-12-31'); await tick();
  const index = h.calls[0].index;
  assert.equal(h.explorer.current, shown); assert.equal(h.renders.length, renders);
  assert.equal(h.explorer.state.displayedIndex, null); assert.equal(h.explorer.state.status, 'loading');
  h.explorer.setAllPlanets(false); h.explorer.setPlanet('venus', true, 'design');
  const beforeCompletion = h.renders.length;
  h.calls[0].resolve(moment(index, fullMeta)); await pending;
  assert.equal(h.renders.length, beforeCompletion + 1);
  assert.equal(h.explorer.state.displayedIndex, index); assert.equal(h.explorer.state.status, 'ready');
  assert.deepEqual(h.explorer.current.activations.personality, []);
  assert.deepEqual(h.explorer.current.activations.design.map(e => e.planet), ['venus']);
  assert.equal(h.explorer.current.designUtc, designAt(point(index, fullMeta).utc).designUtc);
  assert.equal(h.calls.length, 1);
});

test('superseded invalid pairs advance the latest target; a mismatched latest Design retains the whole visible chart', async () => {
  const h = explorerHarness(); await h.explorer.open();
  const shown = h.explorer.current;
  const pending = h.explorer.setDateRange('1801-01-01', '2399-12-31'); await tick();
  h.explorer.scrub(1); h.calls[0].resolve(point(h.calls[0].index, fullMeta)); await tick();
  assert.equal(h.calls[1].index, 1); assert.equal(h.explorer.current, shown);
  h.calls[1].resolve({ ...moment(1, fullMeta), design: designAt(point(2, fullMeta).utc) }); await pending;
  assert.equal(h.explorer.state.status, 'error'); assert.equal(h.explorer.current, shown);
  assert.equal(h.explorer.state.displayedIndex, null);
  const retry = h.explorer.retry(); await tick(); h.calls[2].resolve(moment(1, fullMeta)); await retry;
  assert.equal(h.explorer.state.displayedIndex, 1); assert.equal(h.explorer.current.utc, point(1, fullMeta).utc);
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
