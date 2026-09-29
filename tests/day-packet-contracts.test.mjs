import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { encodeTransitDay, encodeChartDay } from '../server/packets/encode.mjs';
import { TRANSIT_DAY_VERSION, TRANSIT_PLANETS } from '../shared/day-packets/transit-format.js';
import { CHART_DAY_VERSION, CHART_DAY_PLANETS } from '../shared/day-packets/natal-format.js';
import { decodeTransitDay, decodeChartDay } from '../shared/day-packets/decode.js';
import { createTransitDayClient } from '../src/data/transit-day-client.js';
import { createChartDayClient } from '../src/data/natal-day-client.js';

// Captured from the published pre-refactor implementation before extracting
// the codecs. Covers every predictor, header ordering and float boundary bits.
const contracts = JSON.parse(await readFile(new URL('./fixtures/day-packet-contracts.json', import.meta.url), 'utf8'));
const base = { date: '1990-06-15', startUtc: '1990-06-15T00:00:00Z', samples: 1440, stepSeconds: 60,
  engine: 'Swiss Ephemeris test', ephemeris: 'Test ephemerides', timezoneDatabase: 'IANA test',
  nodeModel: 'true', zodiac: 'tropical-geocentric-apparent' };
const transit = { ...base, columns: Array.from({ length: 11 }, (_, column) => Array.from({ length: 1440 }, (_, minute) => (10 + column * 20 + minute / 10000) % 360)) };
const natal = { ...base, timezone: 'UTC', segments: [{ index: 0, startUtc: base.startUtc, offsetSeconds: 0, utcOffset: 'UTC+00:00', fold: 0 }],
  columns: Array.from({ length: 24 }, (_, column) => Array.from({ length: 1440 }, (_, minute) => column < 22 ? (10 + column * 15 + minute / 10000) % 360
    : column === 22 ? Date.parse(base.startUtc) / 1000 - 88 * 86400 + minute * 61 : (minute % 100) * 1e-12)) };
for (const day of [transit, natal]) day.columns[0].splice(0, 7, -0, 0, Number.MIN_VALUE, 307.62499999999994, 307.625, 359.99999999999994, 0.0000000000001);
const bits = values => Buffer.from(new Float64Array(values).buffer).toString('hex');

for (const [name, day, encode, decode] of [['transit', transit, encodeTransitDay, decodeTransitDay], ['natal', natal, encodeChartDay, decodeChartDay]]) {
  test(`${name} packets remain byte-identical to the pre-refactor release for all five predictors`, () => {
    for (let order = 0; order < 5; order++) {
      const packet = encode(day, { orders: Array(day.columns.length).fill(order) });
      assert.equal(createHash('sha256').update(packet).digest('hex'), contracts[name][order], `predictor ${order}`);
      assert.deepEqual(decode(packet).columns.map(bits), day.columns.map(bits));
    }
  });
}

test('bit-preserving calculation changes keep the published version 1 service/client contract', async () => {
  assert.equal(TRANSIT_DAY_VERSION, '1');
  assert.equal(CHART_DAY_VERSION, '1');
  const transitClient = createTransitDayClient({ fetch: async url => {
    assert.equal(new URL(url, 'https://example.test').searchParams.get('v'), '1');
    return { ok: true, arrayBuffer: async () => encodeTransitDay(transit) };
  } });
  const natalClient = createChartDayClient({ persistentCache: null, fetch: async (url, options) => {
    assert.equal(url, '/api/chart/day');
    assert.equal(JSON.parse(options.body).v, '1');
    return { ok: true, arrayBuffer: async () => encodeChartDay(natal) };
  } });
  assert.deepEqual((await transitClient.getDay(base.date)).columns.map(bits), transit.columns.map(bits));
  assert.deepEqual((await natalClient.getDay({ birthDate: base.date, cityId: 'synthetic', timezone: 'UTC' })).columns.map(bits), natal.columns.map(bits));
});


test('binary planet column order matches both Python producers independently of UI order', async () => {
  const protocol = ['sun', 'moon', 'north_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];
  assert.deepEqual(TRANSIT_PLANETS, protocol);
  assert.deepEqual(CHART_DAY_PLANETS, protocol);
  for (const file of ['transit_day.py', 'chart_day.py']) {
    const python = await readFile(new URL(`../server/python/${file}`, import.meta.url), 'utf8');
    const tuple = python.match(/PLANETS = \(([\s\S]*?)\)/)?.[1];
    assert.ok(tuple, file);
    assert.deepEqual([...tuple.matchAll(/'([^']+)'/g)].map(([, name]) => name), protocol, file);
  }
});
