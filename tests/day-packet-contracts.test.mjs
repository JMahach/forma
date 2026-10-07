import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { encodeTransitDay, encodeNatalDay } from '../server/packets/encode.mjs';
import { TRANSIT_DAY_VERSION, TRANSIT_PLANETS } from '../shared/day-packets/transit-format.js';
import { NATAL_DAY_VERSION, NATAL_DAY_PLANETS } from '../shared/day-packets/natal-format.js';
import { decodeTransitDay, decodeNatalDay } from '../shared/day-packets/decode.js';
import { shuffle } from '../shared/day-packets/float64-codec.js';
import { createTransitDayClient } from '../src/data/transit-day-client.js';
import { createNatalDayClient } from '../src/data/natal-day-client.js';

// Captured from the published pre-refactor implementation before extracting
// the codecs. Covers every predictor, header ordering and float boundary bits.
const contracts = JSON.parse(await readFile(new URL('./fixtures/day-packet-contracts.json', import.meta.url), 'utf8'));
const base = { date: '1990-06-15', startUtc: '1990-06-15T00:00:00Z', samples: 1440, stepSeconds: 60,
  engine: 'Swiss Ephemeris test', ephemeris: 'Test ephemerides', timezoneDatabase: 'IANA test',
  nodeModel: 'true', zodiac: 'tropical-geocentric-apparent' };
const transit = { ...base, columns: Array.from({ length: 24 }, (_, column) => Array.from({ length: 1440 }, (_, minute) => column < 22
  ? (10 + column * 20 + minute / 10000) % 360 : column === 22 ? Date.parse(base.startUtc) / 1000 - 88 * 86400 + minute * 61 : (minute % 100) * 1e-12)) };
const natal = { ...base, timezone: 'UTC', segments: [{ index: 0, startUtc: base.startUtc, offsetSeconds: 0, utcOffset: 'UTC+00:00', fold: 0 }],
  columns: Array.from({ length: 24 }, (_, column) => Array.from({ length: 1440 }, (_, minute) => column < 22 ? (10 + column * 15 + minute / 10000) % 360
    : column === 22 ? Date.parse(base.startUtc) / 1000 - 88 * 86400 + minute * 61 : (minute % 100) * 1e-12)) };
for (const day of [transit, natal]) day.columns[0].splice(0, 7, -0, 0, Number.MIN_VALUE, 307.62499999999994, 307.625, 359.99999999999994, 0.0000000000001);
const bits = values => Buffer.from(new Float64Array(values).buffer).toString('hex');

for (const [name, day, encode, decode] of [['natal', natal, encodeNatalDay, decodeNatalDay]]) {
  test(`${name} packets remain byte-identical to the pre-refactor release for all five predictors`, () => {
    for (let order = 0; order < 5; order++) {
      const packet = encode(day, { orders: Array(day.columns.length).fill(order) });
      assert.equal(createHash('sha256').update(packet).digest('hex'), contracts[name][order], `predictor ${order}`);
      assert.deepEqual(decode(packet).columns.map(bits), day.columns.map(bits));
    }
  });
}

test('adding transit Design changes only its public service/client version; natal stays version 1', async () => {
  assert.equal(TRANSIT_DAY_VERSION, '2');
  assert.equal(NATAL_DAY_VERSION, '1');
  const transitClient = createTransitDayClient({ fetch: async url => {
    assert.equal(new URL(url, 'https://example.test').searchParams.get('v'), '2');
    return { ok: true, arrayBuffer: async () => encodeTransitDay(transit) };
  } });
  const natalClient = createNatalDayClient({ persistentCache: null, fetch: async (url, options) => {
    assert.equal(url, '/api/chart/day');
    assert.equal(JSON.parse(options.body).v, '1');
    return { ok: true, arrayBuffer: async () => encodeNatalDay(natal) };
  } });
  assert.deepEqual((await transitClient.getDay(base.date)).columns.map(bits), transit.columns.map(bits));
  assert.deepEqual((await natalClient.getDay({ birthDate: base.date, cityId: 'synthetic', timezone: 'UTC' })).columns.map(bits), natal.columns.map(bits));
});

test('version 2 preserves all 24 columns and explicitly rejects genuine cached version 1 packets', () => {
  for (let order = 0; order < 5; order++) {
    const packet = encodeTransitDay(transit, { orders: Array(24).fill(order) });
    assert.deepEqual(decodeTransitDay(packet).columns.map(bits), transit.columns.map(bits));
    const length = new DataView(packet.buffer).getUint32(4, true);
    const header = JSON.parse(new TextDecoder().decode(packet.subarray(8, 8 + length)));
    header.version = '1'; header.orders.length = 11;
    const metadata = new TextEncoder().encode(JSON.stringify(header));
    const oldWords = shuffle(packet.subarray(8 + length), true).subarray(0, 11 * 1440 * 8);
    const legacy = new Uint8Array(8 + metadata.length + oldWords.length);
    legacy.set(packet.subarray(0, 4)); new DataView(legacy.buffer).setUint32(4, metadata.length, true);
    legacy.set(metadata, 8); legacy.set(shuffle(oldWords), 8 + metadata.length);
    assert.equal(createHash('sha256').update(legacy).digest('hex'), contracts.transit[order], 'real published v1 contract');
    assert.throws(() => decodeTransitDay(legacy), 'old black-only cache cannot appear as a complete new day');
  }
});


test('binary planet column order matches the shared Python sampler independently of UI order', async () => {
  const protocol = ['sun', 'moon', 'north_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];
  assert.deepEqual(TRANSIT_PLANETS, protocol);
  assert.deepEqual(NATAL_DAY_PLANETS, protocol);
  const python = await readFile(new URL('../server/python/astronomy.py', import.meta.url), 'utf8');
  const tuple = python.match(/PLANET_BODIES = \(([\s\S]*?)\n\)/)?.[1];
  assert.ok(tuple);
  assert.deepEqual([...tuple.matchAll(/'([^']+)'/g)].map(([, name]) => name), protocol);
});
