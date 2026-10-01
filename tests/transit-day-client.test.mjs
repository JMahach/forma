import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransitDayClient } from '../src/data/transit-day-client.js';
import { encodeTransitDay } from '../server/packets/encode.mjs';
import { TRANSIT_DAY_VERSION } from '../shared/day-packets/transit-format.js';
import { createLiveTransit } from '../src/state/live-transit.js';

const day = date => ({ date, startUtc: `${date}T00:00:00Z`, stepSeconds: 60, samples: 1440,
  engine: 'Swiss Ephemeris', ephemeris: 'test', timezoneDatabase: 'test', nodeModel: 'true', zodiac: 'tropical-geocentric-apparent',
  columns: Array.from({ length: 24 }, (_, col) => Float64Array.from({ length: 1440 }, (_, index) => col < 22
    ? (col * 30 + index / 10000) % 360 : col === 22 ? Date.parse(`${date}T00:00:00Z`) / 1000 - 88 * 86400 + index * 61 : index % 100 * 1e-12)),
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
  assert.equal(a.columns.length, 24);
  assert.deepEqual(a.columns.map(column => [...column]), day('2026-09-24').columns.map(column => [...column]), 'all red angles, exact Design seconds and residuals survive the network decoder');
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

test('the startup request shares the pending request and decoded cache with the live view', async () => {
  for (const completeBeforeAttach of [false, true]) {
    let finish, requests = 0;
    const client = createTransitDayClient({ initialDate: '2026-09-24', fetch: () => {
      requests++;
      return new Promise(resolve => { finish = () => resolve(response('2026-09-24')); });
    } });
    assert.equal(requests, 1, 'construction starts the UTC packet before UI attachment');
    if (completeBeforeAttach) { finish(); await new Promise(resolve => setImmediate(resolve)); }
    const first = client.getDay('2026-09-24'), concurrent = client.getDay('2026-09-24');
    if (!completeBeforeAttach) finish();
    const [a, b] = await Promise.all([first, concurrent]);
    assert.equal(a, b);
    assert.equal(await client.getDay('2026-09-24'), a);
    assert.equal(requests, 1, 'handoff uses one network request in both timing orders');
  }
});

test('an early failure reaches the existing live retry policy without an automatic duplicate request', async () => {
  const requests = [];
  const client = createTransitDayClient({ initialDate: '2026-09-24', fetch: async url => {
    const date = new URL(url, 'https://example.test').searchParams.get('date');
    requests.push(date);
    return requests.length === 1 ? { ok: false, json: async () => ({ message: 'День ещё не готов' }) } : response(date);
  } });
  // The rejection must remain handled even if loading the UI takes another task.
  await new Promise(resolve => setImmediate(resolve));
  const live = createLiveTransit({ dayClient: client,
    now: () => Date.parse('2026-09-24T12:00:20Z'), timeZone: () => 'Europe/Moscow' });
  await live.refresh(true);
  assert.equal(live.state.status, 'error');
  assert.equal(live.state.error, 'День ещё не готов');
  assert.deepEqual(requests, ['2026-09-24', '2026-09-23'], 'current UTC request precedes the local-day edge');
  await live.refresh();
  assert.equal(requests.length, 2, 'automatic retry observes the original backoff');
  await live.refresh(true);
  assert.equal(live.state.status, 'ready');
  assert.deepEqual(requests, ['2026-09-24', '2026-09-23', '2026-09-24'], 'explicit retry reuses the successful edge');
});

test('a changed UTC date discards the one-shot startup result instead of retaining an obsolete failure', async () => {
  const requests = [];
  const client = createTransitDayClient({ initialDate: '2026-09-24', fetch: async url => {
    const date = new URL(url, 'https://example.test').searchParams.get('date');
    requests.push(date);
    if (requests.length === 1) throw new Error('Offline during startup');
    return response(date);
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await client.getDay('2026-09-25')).date, '2026-09-25');
  assert.equal((await client.getDay('2026-09-24')).date, '2026-09-24');
  assert.deepEqual(requests, ['2026-09-24', '2026-09-25', '2026-09-24']);
});
