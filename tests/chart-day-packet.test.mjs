import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeChartDay } from '../server/packets/encode.mjs';
import { decodeChartDay } from '../shared/day-packets/decode.js';
import { chartDayMinute, chartDayIndexAt, chartAtMinute } from '../src/domain/natal-day.js';
import { validateChart } from '../src/data/storage.js';

export function makeDay(date = '1990-06-15', timezone = 'UTC', samples = 1440) {
  return { date, timezone, startUtc: `${date}T00:00:00Z`, stepSeconds: 60, samples,
    segments: [{ index: 0, startUtc: `${date}T00:00:00Z`, offsetSeconds: 0, utcOffset: 'UTC+00:00', fold: 0 }],
    columns: Array.from({ length: 24 }, (_, column) => Array.from({ length: samples }, (_, minute) => column < 22 ? (10 + column * 15 + minute / 10000) % 360 : column === 22 ? Date.parse(`${date}T00:00:00Z`) / 1000 - 88 * 86400 + minute * 61 : (minute % 100) * 1e-12)),
    engine: 'Swiss Ephemeris test', ephemeris: 'Test ephemerides', timezoneDatabase: 'IANA test', nodeModel: 'true', zodiac: 'tropical-geocentric-apparent' };
}
const bits = values => Buffer.from(new Float64Array(values).buffer).toString('hex');
function rewriteHeader(packet, update) {
  const length = new DataView(packet.buffer, packet.byteOffset).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(packet.subarray(8, 8 + length)));
  update(header);
  const next = new TextEncoder().encode(JSON.stringify(header)), result = new Uint8Array(packet.length - length + next.length);
  result.set(packet.subarray(0, 4)); new DataView(result.buffer).setUint32(4, next.length, true);
  result.set(next, 8); result.set(packet.subarray(8 + length), 8 + next.length);
  return result;
}

test('all predictors preserve every bit in both sides, design seconds and exact residuals', () => {
  const day = makeDay();
  day.columns[0].splice(0, 7, -0, 0, Number.MIN_VALUE, 307.62499999999994, 307.625, 359.99999999999994, 0.0000000000001);
  const expected = day.columns.map(bits);
  for (let order = 0; order < 5; order++) {
    const packet = encodeChartDay(day, { orders: Array(24).fill(order) });
    assert.deepEqual(decodeChartDay(packet).columns.map(bits), expected);
  }
  assert.deepEqual(day.columns.map(bits), expected);
});

test('historical seconds and repeated folds preserve unique sample instants without browser tzdata', () => {
  const day = makeDay('2024-11-03', 'America/New_York', 1500);
  day.startUtc = '2024-11-03T04:00:00Z';
  day.segments = [
    { index: 0, startUtc: day.startUtc, offsetSeconds: -14400, utcOffset: 'UTC−04:00', fold: 0 },
    { index: 120, startUtc: '2024-11-03T06:00:00Z', offsetSeconds: -18000, utcOffset: 'UTC−05:00', fold: 1 },
    { index: 180, startUtc: '2024-11-03T07:00:00Z', offsetSeconds: -18000, utcOffset: 'UTC−05:00', fold: 0 },
  ];
  const decoded = decodeChartDay(encodeChartDay(day));
  assert.deepEqual(chartDayMinute(decoded, 90), { index: 90, utc: '2024-11-03T05:30:00Z', birthTime: '01:30', utcOffset: 'UTC−04:00', fold: 0 });
  assert.deepEqual(chartDayMinute(decoded, 150), { index: 150, utc: '2024-11-03T06:30:00Z', birthTime: '01:30', utcOffset: 'UTC−05:00', fold: 1 });
  assert.equal(chartDayIndexAt(decoded, '2024-11-03T06:30:45Z'), 150);
  assert.equal(chartDayIndexAt(decoded, 0), 0);
  assert.equal(chartDayIndexAt(decoded, Date.parse('2025-01-01')), 1499);
  const historical = makeDay('1900-01-01', 'Europe/Paris');
  historical.startUtc = '1899-12-31T23:50:39Z';
  historical.segments = [{ index: 0, startUtc: historical.startUtc, offsetSeconds: 561, utcOffset: 'UTC+00:09:21', fold: 0 }];
  assert.equal(chartDayMinute(decodeChartDay(encodeChartDay(historical)), 1).utc, '1899-12-31T23:51:39Z');
});

test('materialization retains original identity and never mutates the saved chart', () => {
  const day = decodeChartDay(encodeChartDay(makeDay()));
  const original = Object.freeze({ id: 'saved-id', name: 'My chart', note: 'Keep', createdAt: 'original', updatedAt: 'original', cityId: '123' });
  const chart = chartAtMinute(day, 41, original);
  assert.equal(chart.id, original.id); assert.equal(chart.name, original.name); assert.equal(chart.updatedAt, original.updatedAt);
  assert.equal(chart.birthTime, '00:41'); assert.equal(chart.activations.personality.length, 13); assert.equal(chart.activations.design.length, 13);
  assert.equal(chart.designArcResidualDegrees, day.columns[23][41]);
  assert.equal(validateChart(chart).utc, chart.utc);
  assert.equal(original.birthTime, undefined);
  for (const bad of [-1, 1440, 0.5, '1', NaN]) assert.throws(() => chartAtMinute(day, bad, original));
});

test('bounded shapes, timeline validation and value ranges reject corrupt packets', () => {
  const packet = encodeChartDay(makeDay());
  for (const bad of [null, {}, packet.subarray(0, -1), new Uint8Array(1_000_000)]) assert.throws(() => decodeChartDay(bad));
  for (const update of [h => h.version = '2', h => h.samples = 2881, h => h.samples = 0, h => h.orders.pop(), h => h.orders[0] = 9,
    h => h.segments[0].index = 1, h => h.segments[0].offsetSeconds = 1, h => h.segments[0].fold = 2,
    h => h.segments[0].startUtc = '2000-01-01T00:00:00Z', h => h.date = '1990-02-30', h => h.timezone = 'x'.repeat(161)]) {
    assert.throws(() => decodeChartDay(rewriteHeader(packet, update)));
  }
  for (const [column, value] of [[0, NaN], [21, 360], [22, 1.5], [23, 1e-6]]) {
    const day = makeDay(); day.columns[column][0] = value; assert.throws(() => encodeChartDay(day));
  }
});
