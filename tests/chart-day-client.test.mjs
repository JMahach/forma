import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartDayClient } from '../src/data/natal-day-client.js';
import { encodeChartDay } from '../server/packets/encode.mjs';
import { CHART_DAY_VERSION } from '../shared/day-packets/natal-format.js';
import { chartDayFixture, personalChartFixture } from './fixtures/chart-day.mjs';

const bytesFor = date => encodeChartDay(chartDayFixture({ date })).buffer;
const response = date => ({ ok: true, arrayBuffer: async () => bytesFor(date) });
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('personal-day request is explicit POST with minimal birth data and coalesces consumers', async () => {
  const requests = [];
  let complete;
  const client = createChartDayClient({ persistentCache: null, fetch: (url, options) => {
    requests.push({ url, options });
    return new Promise(resolve => { complete = resolve; });
  } });
  const chart = personalChartFixture();
  assert.deepEqual(requests, [], 'constructing a client does not calculate a birthday');
  const first = client.getDay(chart), second = client.getDay({ ...chart, id: 'other', name: 'Another name' });
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/chart/day');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.cache, 'no-store');
  assert.deepEqual(JSON.parse(requests[0].options.body), { birthDate: chart.birthDate, cityId: chart.cityId, v: CHART_DAY_VERSION });
  complete(response(chart.birthDate));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(await client.getDay(chart), a);
  assert.equal(requests.length, 1);
});

test('versioned local packet cache works across client instances without retaining chart identity', async () => {
  const packets = new Map(), disk = { get: async key => packets.get(key), put: async (key, bytes) => packets.set(key, bytes) };
  let requests = 0;
  const fetch = async () => { requests++; return response('2026-09-24'); };
  const a = createChartDayClient({ persistentCache: disk, fetch });
  const original = await a.getDay(personalChartFixture());
  await settle();
  assert.deepEqual([...packets.keys()], [`${CHART_DAY_VERSION}:2026-09-24:test-city`]);
  assert.ok([...packets.values()][0] instanceof ArrayBuffer);
  const b = createChartDayClient({ persistentCache: disk, fetch });
  const restored = await b.getDay(personalChartFixture({ id: 'other', name: 'Private name' }));
  assert.deepEqual(restored, original);
  assert.equal(requests, 1);
});

test('corrupt or inaccessible browser cache falls back to the server and write failures do not hide a ready day', async () => {
  for (const disk of [
    { get() { throw new Error('Denied'); }, put() { throw new Error('Quota'); } },
    { get: async () => new ArrayBuffer(12), remove() { throw new Error('Denied'); }, put: async () => { throw new Error('Quota'); } },
  ]) {
    let requests = 0;
    const client = createChartDayClient({ persistentCache: disk, fetch: async () => { requests++; return response('2026-09-24'); } });
    assert.equal((await client.getDay(personalChartFixture())).date, '2026-09-24');
    await settle();
    assert.equal(requests, 1);
  }
});

test('memory cache is bounded and distinguishes cities, dates and stale server responses', async () => {
  let requests = 0;
  const client = createChartDayClient({ persistentCache: null, capacity: 2, fetch: async (_url, options) => {
    requests++; return response(JSON.parse(options.body).birthDate);
  } });
  const chart = personalChartFixture();
  for (const date of ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-23']) await client.getDay({ ...chart, birthDate: date });
  assert.equal(requests, 3);
  await client.getDay({ ...chart, birthDate: '2026-09-22' });
  await client.getDay({ ...chart, birthDate: '2026-09-22', cityId: 'other-city' });
  assert.equal(requests, 5);
  const mismatch = createChartDayClient({ persistentCache: null, fetch: async () => response('2026-09-23') });
  await assert.rejects(mismatch.getDay(chart), /другого дня/);
  const wrongZone = createChartDayClient({ persistentCache: null, fetch: async () => response('2026-09-24') });
  await assert.rejects(wrongZone.getDay({ ...chart, timezone: 'Europe/Moscow' }), /Часовой пояс/);
});

test('cancelled navigation aborts unused transport while shared requests retain live consumers', async () => {
  const signals = [], resolvers = [];
  const client = createChartDayClient({ persistentCache: null, fetch: (_url, options) => {
    signals.push(options.signal);
    return new Promise((resolve, reject) => {
      resolvers.push(resolve);
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  } });
  const a = new AbortController(), b = new AbortController(), chart = personalChartFixture();
  const cancelled = assert.rejects(client.getDay(chart, { signal: a.signal }), { name: 'AbortError' });
  const shared = client.getDay(chart, { signal: b.signal });
  await settle();
  a.abort(); await cancelled;
  assert.equal(signals[0].aborted, false);
  resolvers[0](response(chart.birthDate));
  await shared;
  const c = new AbortController();
  const abandoned = assert.rejects(client.getDay({ ...chart, birthDate: '2026-09-23' }, { signal: c.signal }), { name: 'AbortError' });
  await settle(); c.abort(); await abandoned;
  assert.equal(signals[1].aborted, true);
  const retry = client.getDay({ ...chart, birthDate: '2026-09-23' });
  await settle();
  assert.equal(signals.length, 3, 'returning can start a fresh request');
  resolvers[2](response('2026-09-23')); await retry;
});

test('each caller validates its timezone on memory hits and shared requests, independently of the first caller', async () => {
  const chart = personalChartFixture(), otherZone = { ...chart, timezone: 'Europe/Moscow' };
  let complete, requests = 0;
  const client = createChartDayClient({ persistentCache: null, fetch: () => {
    requests++; return new Promise(resolve => { complete = resolve; });
  } });
  const mismatch = assert.rejects(client.getDay(otherZone), /Часовой пояс/);
  const valid = client.getDay(chart);
  await settle(); complete(response(chart.birthDate));
  await mismatch;
  assert.equal((await valid).timezone, 'UTC', 'a mismatched first caller does not poison another subscriber');
  await assert.rejects(client.getDay(otherZone), /Часовой пояс/);
  assert.equal((await client.getDay(chart)).timezone, 'UTC');
  assert.equal(requests, 1, 'caller-specific validation applies even without another fetch');
});

test('personal-day errors remain retryable and requests expire', async t => {
  let calls = 0;
  const client = createChartDayClient({ persistentCache: null, fetch: async () => ++calls === 1
    ? { ok: false, json: async () => ({ message: 'Расчёт временно недоступен' }) } : response('2026-09-24') });
  await assert.rejects(client.getDay(personalChartFixture()), /временно недоступен/);
  await client.getDay(personalChartFixture());
  assert.equal(calls, 2);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = createChartDayClient({ persistentCache: null, timeoutMs: 100, fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }) });
  const result = assert.rejects(slow.getDay(personalChartFixture()), /не успел загрузиться/);
  await settle(); t.mock.timers.tick(100); await result;
});
