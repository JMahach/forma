import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransitDayClient } from '../src/data/transit-day-client.js';
import { encodeTransitDay } from '../server/packets/encode.mjs';
import { TRANSIT_DAY_VERSION } from '../shared/day-packets/transit-format.js';

const day = date => ({ date, startUtc: `${date}T00:00:00Z`, stepSeconds: 60, samples: 1440,
  engine: 'Swiss Ephemeris', ephemeris: 'test', timezoneDatabase: 'test', nodeModel: 'true', zodiac: 'tropical-geocentric-apparent',
  columns: Array.from({ length: 11 }, (_, col) => Float64Array.from({ length: 1440 }, (_, index) => col * 30 + index / 10000)),
});
const response = date => ({ ok: true, arrayBuffer: async () => encodeTransitDay(day(date)).buffer });

test('day client coalesces concurrent requests and reuses the decoded immutable packet without more network', async () => {
  const requests = [];
  let resolve;
  const client = createTransitDayClient({ fetch: (url, options) => {
    requests.push({ url, options });
    return new Promise(done => { resolve = done; });
  } });
  const first = client.getDay('2026-09-24'), second = client.getDay('2026-09-24');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `/api/transit/day?date=2026-09-24&v=${TRANSIT_DAY_VERSION}`);
  assert.equal(requests[0].options.method, undefined, 'packet loading is a GET');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  resolve(response('2026-09-24'));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(a.columns[0][100], 0.01);
  assert.equal(await client.getDay('2026-09-24'), a);
  assert.equal(requests.length, 1);
});

test('failed requests are retryable and JSON API errors reach the day controls', async () => {
  let requests = 0;
  const client = createTransitDayClient({ fetch: async () => {
    requests++;
    return requests === 1 ? { ok: false, json: async () => ({ message: 'Подготовка дня недоступна' }) } : response('2026-09-24');
  } });
  await assert.rejects(client.getDay('2026-09-24'), /Подготовка дня недоступна/);
  assert.equal((await client.getDay('2026-09-24')).date, '2026-09-24');
  assert.equal(requests, 2);
});

test('day client rejects mismatched packets and bounds its decoded-day memory', async () => {
  let requests = 0;
  const client = createTransitDayClient({ capacity: 2, fetch: async url => {
    requests++;
    return response(new URL(url, 'https://example.test').searchParams.get('date'));
  } });
  await client.getDay('2026-09-22');
  await client.getDay('2026-09-23');
  await client.getDay('2026-09-24');
  await client.getDay('2026-09-23');
  assert.equal(requests, 3);
  await client.getDay('2026-09-22');
  assert.equal(requests, 4, 'oldest unused packet is released');
  const mismatch = createTransitDayClient({ fetch: async () => response('2026-09-23') });
  await assert.rejects(mismatch.getDay('2026-09-24'), /другого дня/);
});

test('day requests have a deadline instead of accumulating indefinitely', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const client = createTransitDayClient({ timeoutMs: 100, fetch: async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  } });
  const pending = assert.rejects(client.getDay('2026-09-24'), /не успел загрузиться/);
  t.mock.timers.tick(100);
  await pending;
  assert.equal(signal.aborted, true);
});
