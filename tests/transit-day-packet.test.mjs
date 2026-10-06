import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeTransitDay, encodeNumericColumn } from '../server/packets/encode.mjs';
import { decodeTransitDay } from '../shared/day-packets/decode.js';
import { transitChartAt } from '../src/domain/transit-day.js';
import { TRANSIT_PLANETS, TRANSIT_DAY_COLUMNS } from '../shared/day-packets/transit-format.js';
import { validateChart } from '../src/data/storage.js';
import { gatePositionAtLongitude } from '../src/domain/gate-wheel.js';

function fixture() {
  return { date: '2026-09-24', startUtc: '2026-09-24T00:00:00Z', stepSeconds: 60, samples: 1440,
    engine: 'Swiss Ephemeris test', ephemeris: 'local test files', timezoneDatabase: 'IANA test',
    nodeModel: 'true', zodiac: 'tropical-geocentric-apparent',
    columns: Array.from({ length: TRANSIT_DAY_COLUMNS }, (_, column) => Float64Array.from({ length: 1440 }, (_, row) => column < 22
      ? (column * 31.7 + row * 0.019731) % 360 : column === 22 ? Date.parse('2026-06-24T12:34:56Z') / 1000 + row * 61 : row % 100 * 1e-12)) };
}
function bits(values) { return Buffer.from(new Float64Array(values).buffer).toString('hex'); }
function rewriteHeader(packet, update) {
  const length = new DataView(packet.buffer, packet.byteOffset).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(packet.subarray(8, 8 + length)));
  update(header);
  const next = new TextEncoder().encode(JSON.stringify(header));
  const result = new Uint8Array(packet.length - length + next.length);
  result.set(packet.subarray(0, 4)); new DataView(result.buffer).setUint32(4, next.length, true);
  result.set(next, 8); result.set(packet.subarray(8 + length), 8 + next.length);
  return result;
}

test('all five predictor orders restore every longitude bit, with wraps and narrow boundary values', () => {
  const day = fixture();
  day.columns[0].set([-0, 0, Number.MIN_VALUE, 307.62499999999994, 307.625, 359.99999999999994, 0.0000000000001]);
  const before = day.columns.map(bits);
  for (let order = 0; order <= 4; order++) {
    const packet = encodeTransitDay(day, { orders: Array(TRANSIT_DAY_COLUMNS).fill(order) });
    const result = decodeTransitDay(packet);
    assert.deepEqual(result.columns.map(bits), before);
    assert.equal(result.startUtc, day.startUtc);
    assert.equal(result.samples, 1440);
    assert.deepEqual(result.orders, Array(TRANSIT_DAY_COLUMNS).fill(order));
  }
  assert.deepEqual(day.columns.map(bits), before, 'encoding does not mutate input');
});

test('mixed planet predictors, offset byte views and ArrayBuffers decode identically', () => {
  const day = fixture(), orders = Array.from({ length: TRANSIT_DAY_COLUMNS }, (_, i) => i % 5);
  const packet = encodeTransitDay(day, { orders });
  const padded = new Uint8Array(packet.length + 30); padded.set(packet, 17);
  assert.deepEqual(decodeTransitDay(padded.subarray(17, 17 + packet.length)).columns.map(bits), day.columns.map(bits));
  assert.deepEqual(decodeTransitDay(packet.buffer).columns.map(bits), day.columns.map(bits));
  assert.equal(encodeNumericColumn(day.columns[0], 3).length, 1440 * 8);
});

test('materialized minutes use exact two-sided positions and retain a valid legacy saved-transit fallback', () => {
  const day = decodeTransitDay(encodeTransitDay(fixture()));
  day.columns[0][0] = 307.62499999999994;
  for (const minute of [0, 1, 719, 1439]) {
    const chart = transitChartAt(day, minute);
    assert.equal(chart.activations.personality.length, 13);
    assert.equal(chart.activations.design.length, 13);
    assert.equal(Date.parse(chart.designUtc) / 1000, day.columns[22][minute]);
    assert.equal(chart.designArcResidualDegrees, day.columns[23][minute]);
    const legacyFallback = { ...chart, design: [], designUtc: null, designArcResidualDegrees: null,
      activations: { personality: chart.activations.personality, design: [] } };
    assert.equal(validateChart(legacyFallback).utc, chart.utc);
    assert.equal(chart.utc, new Date(Date.parse(day.startUtc) + minute * 60000).toISOString().replace('.000Z', 'Z'));
    for (const [column, planet] of TRANSIT_PLANETS.entries()) {
      assert.deepEqual(chart.activations.personality.find(a => a.planet === planet), { planet, ...gatePositionAtLongitude(day.columns[column][minute]) });
      assert.deepEqual(chart.activations.design.find(a => a.planet === planet), { planet, ...gatePositionAtLongitude(day.columns[11 + column][minute]) });
    }
    assert.equal(chart.activations.personality.find(a => a.planet === 'earth').longitude, (day.columns[0][minute] + 180) % 360);
    assert.equal(chart.activations.personality.find(a => a.planet === 'south_node').longitude, (day.columns[2][minute] + 180) % 360);
  }
  assert.deepEqual(transitChartAt(day, 0).activations.personality[0], { planet: 'sun', longitude: 307.62499999999994, gate: 41, line: 6 });
  for (const invalid of [-1, 1440, 1.5, NaN, '1']) assert.throws(() => transitChartAt(day, invalid));
});

test('fixed shape and bounded metadata reject malformed and incompatible packets before allocation', () => {
  const packet = encodeTransitDay(fixture());
  for (const invalid of [null, {}, new Uint8Array(), packet.subarray(0, -1), new Uint8Array(packet.length + 1), new Uint8Array(200000)]) {
    assert.throws(() => decodeTransitDay(invalid));
  }
  for (const update of [h => h.version = '1', h => h.samples = 1e12, h => h.stepSeconds = 1,
    h => h.orders[0] = 5, h => h.orders.pop(), h => h.startUtc = '2026-09-24T00:00:01Z',
    h => { h.date = '2026-02-30'; h.startUtc = `${h.date}T00:00:00Z`; },
    h => h.engine = 'x'.repeat(300), h => h.nodeModel = 'mean']) {
    assert.throws(() => decodeTransitDay(rewriteHeader(packet, update)));
  }
  const badLength = packet.slice(); new DataView(badLength.buffer).setUint32(4, 0xffffffff, true);
  assert.throws(() => decodeTransitDay(badLength));
});

test('encoder refuses incomplete days, nonfinite coordinates and invalid predictor configurations', () => {
  for (const coordinate of [NaN, Infinity, -1, 360]) {
    const day = fixture(); day.columns[0][0] = coordinate;
    assert.throws(() => encodeTransitDay(day));
  }
  const short = fixture(); short.columns[0] = [1]; assert.throws(() => encodeTransitDay(short));
  assert.throws(() => encodeTransitDay(fixture(), { orders: [3] }));
  assert.throws(() => encodeNumericColumn(new Float64Array(1440), -1));
  for (const [column, value] of [[11, -1], [21, 360], [22, 1.5], [22, 20_000_000_000], [23, -1e-12], [23, 1.00001e-7]]) {
    const day = fixture(); day.columns[column][0] = value;
    assert.throws(() => encodeTransitDay(day), `${column}: ${value}`);
  }
  const oldShape = fixture(); oldShape.columns.length = 11; assert.throws(() => encodeTransitDay(oldShape));
});

test('full packets validate each indexed value once before encoding, including sparse input', () => {
  const day = fixture(); let reads = 0;
  day.columns[0] = new Proxy(Array.from(day.columns[0]), { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
    return Reflect.get(target, key, receiver);
  } });
  encodeTransitDay(day);
  assert.equal(reads, 1440 * 2, 'one range validation and one numerical encoding read');
  const sparse = fixture(); sparse.columns[0] = Array.from(sparse.columns[0]); delete sparse.columns[0][12];
  assert.throws(() => encodeTransitDay(sparse));
  const missing = fixture(); delete missing.columns[0];
  assert.throws(() => encodeTransitDay(missing));
});
