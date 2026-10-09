import test from 'node:test';
import assert from 'node:assert/strict';
import { transitSampleAt, transitChartAt } from '../src/domain/transit-day.js';
import { lifetimeChartAt, validateLifetimeMetadata, validateLifetimeMoment } from '../src/domain/lifetime.js';
import { LIFETIME_PLANETS } from '../shared/lifetime-format.js';
import { chartAtMinute } from '../src/domain/natal-day.js';
import { gatePositionAtLongitude } from '../src/domain/gate-wheel.js';
import { PLANET_IDS } from '../src/domain/planets.js';
import * as momentProjection from '../src/domain/moment-projection.js';
import { NATAL_DAY_PLANETS } from '../shared/day-packets/natal-format.js';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.mjs';

const startUtc = '2026-10-05T00:00:00Z';
const metadata = () => validateLifetimeMetadata({ startUtc, endExclusiveUtc: '2026-10-06T00:00:00Z',
  stepSeconds: 600, samples: 144, planets: [...LIFETIME_PLANETS], engine: 'Swiss Ephemeris 2.10.03' });
const packet = () => ({ startUtc, samples: 1440, engine: 'Swiss Ephemeris 2.10.03',
  columns: Array.from({ length: 24 }, (_, column) => Float64Array.from({ length: 1440 }, (_, index) => column < 22
    ? (302 + column * 7 + index / 10000) % 360 : column === 22 ? Date.parse(startUtc) / 1000 - 88 * 86400 + index * 60 : 1e-10)),
});

// Frozen natal projection before sharing projectLongitudes. Compare each full
// chart, including calendar segments, independently of the shared projection.
function previousNatalProjection(day, index, original) {
  const iso = value => new Date(value).toISOString().replace('.000Z', 'Z');
  const segment = day.segments.findLast(value => value.index <= index);
  const moment = Date.parse(segment.startUtc) + (index - segment.index) * 60000;
  const activations = Object.fromEntries(['personality', 'design'].map((side, sideIndex) => {
    const values = Object.fromEntries(NATAL_DAY_PLANETS.map((planet, column) => [planet, day.columns[sideIndex * 11 + column][index]]));
    values.earth = (values.sun + 180) % 360; values.south_node = (values.north_node + 180) % 360;
    return [side, PLANET_IDS.map(planet => ({ planet, ...gatePositionAtLongitude(values[planet]) }))];
  }));
  return { ...original, source: 'calculated', birthDate: day.date, timezone: day.timezone,
    utc: iso(moment), birthTime: iso(moment + segment.offsetSeconds * 1000).slice(11, 16), utcOffset: segment.utcOffset, fold: segment.fold,
    activations, personality: [...new Set(activations.personality.map(entry => entry.gate))].sort((a, b) => a - b),
    design: [...new Set(activations.design.map(entry => entry.gate))].sort((a, b) => a - b),
    designUtc: iso(day.columns[22][index] * 1000), designArcResidualDegrees: day.columns[23][index],
    engine: day.engine, ephemeris: day.ephemeris, timezoneDatabase: day.timezoneDatabase, nodeModel: day.nodeModel, zodiac: day.zodiac };
}

test('every natal minute and both activation sides match the prior projection across ordinary, historical and folded days', () => {
  const original = Object.freeze(personalChartFixture());
  const days = [natalDayFixture(), natalDayFixture({ date: '1900-01-01', timezone: 'Europe/Paris', segments: [
    { index: 0, startUtc: '1899-12-31T23:50:39Z', utcOffset: 'UTC+00:09:21', offsetSeconds: 561, fold: 0 },
  ] }), natalDayFixture({ date: '2026-11-01', timezone: 'America/New_York', samples: 1500, segments: [
    { index: 0, startUtc: '2026-11-01T04:00:00Z', utcOffset: 'UTC−04:00', offsetSeconds: -14400, fold: 0 },
    { index: 120, startUtc: '2026-11-01T06:00:00Z', utcOffset: 'UTC−05:00', offsetSeconds: -18000, fold: 1 },
    { index: 180, startUtc: '2026-11-01T07:00:00Z', utcOffset: 'UTC−05:00', offsetSeconds: -18000, fold: 0 },
  ] })];
  for (const day of days) {
    for (const side of [0, 11]) day.columns[side].set([-0, 307.62499999999994, 307.625, 359.99999999999994]);
    for (let minute = 0; minute < day.samples; minute++) {
      assert.deepEqual(chartAtMinute(day, minute, original), previousNatalProjection(day, minute, original), `${day.date}, minute ${minute}`);
    }
    const first = chartAtMinute(day, 0, original); day.columns[0][0] = 12.345; day.columns[11][0] = 67.89;
    assert.deepEqual(chartAtMinute(day, 0, original), previousNatalProjection(day, 0, original));
    assert.equal(first.activations.personality[0].longitude, 0, 'a later mutable column cannot change an earlier projection');
  }
});

test('revisiting a day minute creates an independent sample and chart with the same exact facts', () => {
  const day = packet(), first = transitChartAt(day, 0), sample = transitSampleAt(day, 0);
  transitChartAt(day, 1);
  const revisited = transitChartAt(day, 0);
  assert.notEqual(revisited, first);
  assert.deepEqual(revisited, first);
  const revisitedSample = transitSampleAt(day, 0);
  assert.notEqual(revisitedSample, sample);
  assert.deepEqual(revisitedSample, sample);
  for (const side of ['personality', 'design']) {
    assert.equal(revisited.activations[side].length, 13);
    for (let i = 0; i < 13; i++) assert.deepEqual(revisited.activations[side][i], first.activations[side][i]);
  }
});

test('revisiting an immutable Lifetime moment reuses its chart without changing the chart contract', () => {
  const day = packet(), meta = metadata();
  const firstPoint = validateLifetimeMoment({ index: 0, ...transitSampleAt(day, 0) }, meta);
  const secondPoint = validateLifetimeMoment({ index: 1, ...transitSampleAt(day, 10) }, meta);
  const first = lifetimeChartAt(meta, firstPoint);
  lifetimeChartAt(meta, secondPoint);
  assert.equal(lifetimeChartAt(meta, firstPoint), first);
  assert.equal(first.id, 'lifetime-preview');
  assert.equal(first.utc, startUtc);
  assert.equal(first.engine, 'Swiss Ephemeris 2.10.03');
  assert.deepEqual(first.activations.personality[0], { planet: 'sun', longitude: 302, gate: 41, line: 1 });
});

test('Lifetime retains its supplied exact sample while Day independently projects the same values', () => {
  const day = packet(), sample = transitSampleAt(day, 20), dayChart = transitChartAt(day, 20), meta = metadata();
  const point = validateLifetimeMoment({ index: 2, ...sample }, meta), yearChart = lifetimeChartAt(meta, point);
  assert.equal(point.longitudes, sample.longitudes);
  assert.equal(point.design.longitudes, sample.design.longitudes);
  assert.deepEqual(yearChart.activations.personality, dayChart.activations.personality);
  assert.deepEqual(yearChart.activations.design, dayChart.activations.design);
  assert.equal(dayChart.id, 'current-transit');
  assert.equal(yearChart.id, 'lifetime-preview');
});

test('Day and Lifetime keep identical chart facts while adapters retain their own identity and provenance', () => {
  const provenance = { engine: 'Swiss Ephemeris test', ephemeris: 'test ephemeris', timezoneDatabase: 'test tzdata',
    nodeModel: 'true', zodiac: 'tropical-geocentric-apparent' };
  const day = Object.assign(packet(), provenance), minute = 20;
  day.columns[22][minute] += 37.125;
  day.columns[23][minute] = 7.654321e-11;
  const meta = validateLifetimeMetadata({ ...metadata(), ...provenance,
    startUtc: '2026-10-01T00:00:00Z', samples: 5 * 144 });
  const sample = transitSampleAt(day, minute);
  const point = validateLifetimeMoment({ index: 4 * 144 + 2, ...sample }, meta);
  const current = transitChartAt(day, minute), lifetime = lifetimeChartAt(meta, point);
  assert.equal(current.utc, '2026-10-05T00:20:00Z');
  assert.equal(current.designUtc, '2026-07-09T00:20:37.125Z');
  assert.equal(current.designArcResidualDegrees, 7.654321e-11);
  assert.equal(current.createdAt, day.startUtc); assert.equal(lifetime.createdAt, meta.startUtc);
  assert.equal(current.verification, 'Lossless minute-grid Swiss Ephemeris transit; official Human Design reference-chart validation pending.');
  assert.equal(lifetime.verification, 'Exact Swiss Ephemeris longitudes on a ten-minute grid.');
  assert.deepEqual({ ...lifetime, id: current.id, createdAt: current.createdAt, verification: current.verification }, current);
  for (const side of ['personality', 'design']) {
    assert.deepEqual(current[side], lifetime[side]); assert.deepEqual(current.activations[side], lifetime.activations[side]);
  }
  assert.deepEqual(transitChartAt(day, minute), current); assert.equal(lifetimeChartAt(meta, point), lifetime);
  const explicit = lifetimeChartAt({ ...meta, engine: 'Explicit engine' }, point);
  assert.equal(explicit.engine, 'Explicit engine');
  day.source = 'not a transit fallback'; delete day.engine;
  assert.equal(transitChartAt(day, minute).engine, undefined, 'Day does not inherit the lifetime engine fallback');
});

test('a standalone lifetime point retains an empty immutable Design and its explicit metadata contract', () => {
  const meta = metadata(), sample = transitSampleAt(packet(), 0);
  const chart = lifetimeChartAt(meta, { index: 0, utc: sample.utc, longitudes: sample.longitudes });
  assert.deepEqual(chart.design, []); assert.deepEqual(chart.activations.design, []);
  assert.equal(chart.design, chart.activations.design); assert.ok(Object.isFrozen(chart.design));
  const { personality, design, activations, ...details } = chart;
  assert.deepEqual(details, { id: 'lifetime-preview', name: 'Транзит', source: 'transit', utc: startUtc,
    birthDate: '2026-10-05', birthTime: '00:00', birthPlace: '', timezone: 'UTC', utcOffset: 'UTC+00:00', fold: 0,
    designUtc: null, cityId: null, city: null, engine: 'Swiss Ephemeris 2.10.03', ephemeris: undefined,
    timezoneDatabase: undefined, nodeModel: undefined, zodiac: undefined, designArcResidualDegrees: null,
    updatedAt: startUtc, createdAt: startUtc, note: '', verification: 'Exact Swiss Ephemeris longitudes on a ten-minute grid.' });
});

test('the common moment constructor retains exact UTC, frozen projected references and only declared chart metadata', () => {
  const sample = transitSampleAt(packet(), 0), utc = '2026-10-05T12:34:56.789Z';
  const moment = { ...sample, utc, design: { ...sample.design, utc, designUtc: '2026-07-09T12:01:23.456Z', designArcResidualDegrees: 0 } };
  const metadata = { id: 'exact-test-moment', createdAt: '2026-10-01T00:00:00Z', verification: 'Exact fixture.',
    engine: 'test engine', ephemeris: 'test files', timezoneDatabase: 'test tzdata', nodeModel: 'true', zodiac: 'tropical',
    source: 'must not replace transit', columns: 'must not leak into chart', samples: 1440 };
  assert.equal(typeof momentProjection.projectMomentChart, 'function');
  const chart = momentProjection.projectMomentChart(moment, LIFETIME_PLANETS, metadata);
  const { personality, design, activations, ...details } = chart;
  assert.deepEqual(details, { id: metadata.id, name: 'Транзит', source: 'transit', utc,
    birthDate: '2026-10-05', birthTime: '12:34', birthPlace: '', timezone: 'UTC', utcOffset: 'UTC+00:00', fold: 0,
    designUtc: moment.design.designUtc, cityId: null, city: null, engine: metadata.engine, ephemeris: metadata.ephemeris,
    timezoneDatabase: metadata.timezoneDatabase, nodeModel: metadata.nodeModel, zodiac: metadata.zodiac,
    designArcResidualDegrees: 0, updatedAt: utc, createdAt: metadata.createdAt, note: '', verification: metadata.verification });
  for (const [side, longitudes] of [['personality', moment.longitudes], ['design', moment.design.longitudes]]) {
    const projected = momentProjection.projectLongitudes(longitudes, LIFETIME_PLANETS);
    assert.equal(chart[side], projected.gates); assert.equal(activations[side], projected.activations);
  }
  assert.ok(Object.isFrozen(chart)); assert.ok(Object.isFrozen(activations));
  assert.throws(() => { chart.utc = ''; }, TypeError);
  assert.throws(() => { chart.activations.design[0].gate = 1; }, TypeError);
});

test('immutable projections and longitude snapshots cannot be corrupted by their consumers', () => {
  const day = packet(), sample = transitSampleAt(day, 0), chart = transitChartAt(day, 0);
  for (const mutate of [() => { sample.longitudes[0] = 0; }, () => { sample.design.longitudes[0] = 0; },
    () => { sample.design.utc = ''; }, () => { chart.name = ''; }, () => { chart.activations.design = []; },
    () => { chart.activations.personality[0].gate = 1; }, () => { chart.personality.push(1); }]) assert.throws(mutate, TypeError);
  const year = lifetimeChartAt(metadata(), { index: 0, ...sample });
  assert.throws(() => { year.activations.design[0].longitude = 0; }, TypeError);
  assert.throws(() => { year.design = []; }, TypeError);
  assert.deepEqual(transitChartAt(day, 0), chart);
});

test('each projection reads current day numbers and metadata without changing prior snapshots', () => {
  const day = packet(), first = transitChartAt(day, 0), other = transitChartAt(day, 1);
  day.columns[0][0] = 307.625;
  const changed = transitChartAt(day, 0);
  assert.notEqual(changed, first);
  assert.deepEqual(changed.activations.personality[0], { planet: 'sun', longitude: 307.625, gate: 19, line: 1 });
  assert.equal(first.activations.personality[0].longitude, 302);
  assert.deepEqual(transitChartAt(day, 1), other);
  day.engine = 'Another engine';
  const metadataChanged = transitChartAt(day, 0);
  assert.notEqual(metadataChanged, changed);
  assert.equal(metadataChanged.engine, 'Another engine');
  assert.deepEqual(metadataChanged.activations.personality, changed.activations.personality);
  day.startUtc = '2026-10-06T00:00:00Z';
  assert.equal(transitChartAt(day, 0).utc, '2026-10-06T00:00:00Z');
});

test('mutable Lifetime input is copied and revalidated, including externally frozen shells', () => {
  const meta = metadata(), sample = transitSampleAt(packet(), 0);
  const raw = { index: 0, ...sample, longitudes: [...sample.longitudes], design: { ...sample.design, longitudes: [...sample.design.longitudes] } };
  Object.freeze(raw);
  const first = lifetimeChartAt(meta, raw);
  raw.longitudes[0] = 307.625;
  const next = lifetimeChartAt(meta, raw);
  assert.equal(first.activations.personality[0].longitude, 302);
  assert.equal(next.activations.personality[0].gate, 19);
  raw.design.longitudes[0] = NaN;
  assert.throws(() => lifetimeChartAt(meta, raw), /Некорректные/);
});

test('a numeric day retains no history of previously materialized charts', () => {
  const day = packet(), keys = Object.keys(day), minutes = [0, 1, 1439];
  const charts = minutes.map(minute => transitChartAt(day, minute));
  for (let index = 0; index < minutes.length; index++) {
    const current = transitChartAt(day, minutes[index]);
    assert.notEqual(current, charts[index]);
    assert.deepEqual(current, charts[index]);
  }
  assert.deepEqual(Object.keys(day), keys, 'projection does not attach UI history to the numeric packet');
});

test('lifetime cache versions accept only the complete lowercase content digest', () => {
  const meta = metadata();
  assert.equal(validateLifetimeMetadata({ ...meta, cacheVersion: 'a'.repeat(64) }).cacheVersion, 'a'.repeat(64));
  for (const cacheVersion of ['', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), 123, null]) {
    assert.throws(() => validateLifetimeMetadata({ ...meta, cacheVersion }), /Некорректные/);
  }
});
