import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createNatalDayClient } from '../src/data/natal-day-client.js';
import { encodeNatalDay } from '../server/packets/encode.mjs';
import { NATAL_DAY_VERSION } from '../shared/day-packets/natal-format.js';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.mjs';

const bytesFor = date => encodeNatalDay(natalDayFixture({ date })).buffer;
const response = date => ({ ok: true, arrayBuffer: async () => bytesFor(date) });
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('personal-day request is explicit POST with minimal birth data and coalesces consumers', async () => {
  const requests = [];
  let complete;
  const client = createNatalDayClient({ persistentCache: null, fetch: (url, options) => {
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
  assert.deepEqual(JSON.parse(requests[0].options.body), { birthDate: chart.birthDate, cityId: chart.cityId, v: NATAL_DAY_VERSION });
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
  const a = createNatalDayClient({ persistentCache: disk, fetch });
  const original = await a.getDay(personalChartFixture());
  await settle();
  assert.deepEqual([...packets.keys()], [`${NATAL_DAY_VERSION}:2026-09-24:test-city`]);
  assert.ok([...packets.values()][0] instanceof ArrayBuffer);
  const b = createNatalDayClient({ persistentCache: disk, fetch });
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
    const client = createNatalDayClient({ persistentCache: disk, fetch: async () => { requests++; return response('2026-09-24'); } });
    assert.equal((await client.getDay(personalChartFixture())).date, '2026-09-24');
    await settle();
    assert.equal(requests, 1);
  }
});

test('memory cache is bounded and distinguishes cities, dates and stale server responses', async () => {
  let requests = 0;
  const client = createNatalDayClient({ persistentCache: null, capacity: 2, fetch: async (_url, options) => {
    requests++; return response(JSON.parse(options.body).birthDate);
  } });
  const chart = personalChartFixture();
  for (const date of ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-23']) await client.getDay({ ...chart, birthDate: date });
  assert.equal(requests, 3);
  await client.getDay({ ...chart, birthDate: '2026-09-22' });
  await client.getDay({ ...chart, birthDate: '2026-09-22', cityId: 'other-city' });
  assert.equal(requests, 5);
  const mismatch = createNatalDayClient({ persistentCache: null, fetch: async () => response('2026-09-23') });
  await assert.rejects(mismatch.getDay(chart), /другого дня/);
  const wrongZone = createNatalDayClient({ persistentCache: null, fetch: async () => response('2026-09-24') });
  await assert.rejects(wrongZone.getDay({ ...chart, timezone: 'Europe/Moscow' }), /Часовой пояс/);
});

test('cancelled navigation aborts unused transport while shared requests retain live consumers', async () => {
  const signals = [], resolvers = [];
  const client = createNatalDayClient({ persistentCache: null, fetch: (_url, options) => {
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

test('already-aborted navigation does not read storage or start transport', async () => {
  const controller = new AbortController();
  let reads = 0, requests = 0;
  const client = createNatalDayClient({ persistentCache: { get: async () => { reads++; } },
    fetch: async () => { requests++; return response('2026-09-24'); },
  });
  controller.abort();
  await assert.rejects(client.getDay(personalChartFixture(), { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(reads, 0); assert.equal(requests, 0);
});

test('late abandoned transport cannot remove its replacement or cache a stale result', async () => {
  const requests = [], controller = new AbortController(), chart = personalChartFixture();
  let writes = 0;
  const client = createNatalDayClient({ persistentCache: { get: async () => null, put: () => { writes++; } },
    fetch: (_url, { signal }) => new Promise(resolve => { requests.push({ resolve, signal }); }),
  });
  const cancelled = assert.rejects(client.getDay(chart, { signal: controller.signal }), { name: 'AbortError' });
  await settle(); controller.abort(); await cancelled;
  const ready = client.getDay(chart);
  await settle();
  assert.equal(requests.length, 2);
  requests[0].resolve(response(chart.birthDate));
  await settle();
  assert.equal(writes, 0);
  const joined = client.getDay(chart);
  await settle();
  assert.equal(requests.length, 2, 'late cleanup must leave the replacement available to new consumers');
  requests[1].resolve(response(chart.birthDate));
  assert.equal(await ready, await joined);
  assert.equal(writes, 1);
});

test('success and failure both release navigation abort listeners', async () => {
  for (const ok of [true, false]) {
    const controller = new AbortController();
    let complete;
    const client = createNatalDayClient({ persistentCache: null, fetch: () => new Promise(resolve => { complete = resolve; }) });
    const result = client.getDay(personalChartFixture(), { signal: controller.signal });
    const done = ok ? result : assert.rejects(result, /unavailable/);
    await settle();
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    complete(ok ? response('2026-09-24') : { ok: false, json: async () => ({ message: 'unavailable' }) });
    await done;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('each caller validates its timezone on memory hits and shared requests, independently of the first caller', async () => {
  const chart = personalChartFixture(), otherZone = { ...chart, timezone: 'Europe/Moscow' };
  let complete, requests = 0;
  const client = createNatalDayClient({ persistentCache: null, fetch: () => {
    requests++; return requests === 1 ? new Promise(resolve => { complete = resolve; }) : Promise.resolve(response(chart.birthDate));
  } });
  const mismatch = assert.rejects(client.getDay(otherZone), /Часовой пояс/);
  const valid = client.getDay(chart);
  await settle(); complete(response(chart.birthDate));
  await mismatch;
  assert.equal((await valid).timezone, 'UTC', 'a mismatched first caller does not poison another subscriber');
  await assert.rejects(client.getDay(otherZone), /Часовой пояс/);
  assert.equal((await client.getDay(chart)).timezone, 'UTC');
  assert.equal(requests, 3, 'a conflicting cache hit rechecks the server; an incompatible fresh response is not retained');
});

test('personal-day errors remain retryable and requests expire', async t => {
  let calls = 0;
  const client = createNatalDayClient({ persistentCache: null, fetch: async () => ++calls === 1
    ? { ok: false, json: async () => ({ message: 'Расчёт временно недоступен' }) } : response('2026-09-24') });
  await assert.rejects(client.getDay(personalChartFixture()), /временно недоступен/);
  await client.getDay(personalChartFixture());
  assert.equal(calls, 2);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = createNatalDayClient({ persistentCache: null, timeoutMs: 100, fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }) });
  const result = assert.rejects(slow.getDay(personalChartFixture()), /не успел загрузиться/);
  await settle(); t.mock.timers.tick(100); await result;
});

test('a disk packet from another timezone is removed and recovered from the server before entering memory', async () => {
  const chart = personalChartFixture(), key = `${NATAL_DAY_VERSION}:${chart.birthDate}:${chart.cityId}`;
  let packet = encodeNatalDay(natalDayFixture({ timezone: 'Europe/Moscow' })).buffer;
  let requests = 0, removed = 0, writes = 0;
  const disk = { get: async () => packet,
    remove(value) { assert.equal(value, key); removed++; packet = null; },
    put(value, bytes) { assert.equal(value, key); writes++; packet = bytes; },
  };
  const fetch = async () => { requests++; return response(chart.birthDate); };
  const client = createNatalDayClient({ persistentCache: disk, fetch });
  const recovered = await client.getDay(chart);
  assert.equal(recovered.timezone, chart.timezone);
  assert.equal(await client.getDay(chart), recovered);
  await settle();
  assert.equal(requests, 1); assert.equal(removed, 1); assert.equal(writes, 1);
  const reloaded = createNatalDayClient({ persistentCache: disk, fetch });
  assert.equal((await reloaded.getDay(chart)).timezone, chart.timezone);
  assert.equal(requests, 1, 'the recovered persisted packet is reusable');
});

test('an incompatible RAM packet is evicted and skips the same stale disk packet on recovery', async () => {
  const chart = personalChartFixture(), previous = { ...chart, timezone: 'Europe/Moscow' };
  const stale = encodeNatalDay(natalDayFixture({ timezone: previous.timezone })).buffer;
  let requests = 0, reads = 0, removed = 0;
  const client = createNatalDayClient({ persistentCache: {
    get: async () => { reads++; return stale; }, remove() { removed++; },
  }, fetch: async () => { requests++; return response(chart.birthDate); } });
  assert.equal((await client.getDay(previous)).timezone, previous.timezone);
  const recovered = await client.getDay(chart);
  assert.equal(recovered.timezone, chart.timezone);
  assert.equal(await client.getDay(chart), recovered);
  await settle();
  assert.equal(requests, 1); assert.equal(reads, 1); assert.equal(removed, 1);
});

test('a fresh incompatible server packet remains an error and is never retained in either cache', async () => {
  const chart = personalChartFixture(); let requests = 0, writes = 0;
  const wrong = encodeNatalDay(natalDayFixture({ timezone: 'Europe/Moscow' })).buffer;
  const client = createNatalDayClient({ persistentCache: { get: async () => null, put() { writes++; } },
    fetch: async () => { requests++; return { ok: true, arrayBuffer: async () => wrong }; },
  });
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(client.getDay(chart), /Часовой пояс/);
  await settle(); assert.equal(requests, 2); assert.equal(writes, 0);
});

test('a cached timezone matching only the first caller is revalidated without poisoning the correct shared consumer', async () => {
  const chart = personalChartFixture(), staleChart = { ...chart, timezone: 'Europe/Moscow' };
  const stale = encodeNatalDay(natalDayFixture({ timezone: staleChart.timezone })).buffer;
  let requests = 0, removed = 0, writes = 0;
  const client = createNatalDayClient({ persistentCache: { get: async () => stale, remove() { removed++; }, put() { writes++; } },
    fetch: async () => { requests++; return response(chart.birthDate); },
  });
  const outdated = assert.rejects(client.getDay(staleChart), /Часовой пояс/), current = client.getDay(chart);
  await outdated;
  const day = await current;
  assert.equal(day.timezone, chart.timezone);
  assert.equal(await client.getDay(chart), day);
  await settle(); assert.equal(requests, 1); assert.equal(removed, 1); assert.equal(writes, 1);
});

test('a cancelled incompatible subscriber does not invalidate a cached packet still needed by a compatible subscriber', async () => {
  const chart = personalChartFixture(), controller = new AbortController();
  let release, requests = 0, removed = 0;
  const client = createNatalDayClient({ persistentCache: {
    get: () => new Promise(resolve => { release = resolve; }), remove() { removed++; },
  }, fetch: async () => { requests++; return response(chart.birthDate); } });
  const cancelled = assert.rejects(client.getDay({ ...chart, timezone: 'Europe/Moscow' }, { signal: controller.signal }), { name: 'AbortError' });
  const ready = client.getDay(chart);
  controller.abort(); await cancelled;
  release(bytesFor(chart.birthDate));
  assert.equal((await ready).timezone, chart.timezone);
  assert.equal(requests, 0); assert.equal(removed, 0);
});
