import test from 'node:test';
import assert from 'node:assert/strict';
import { createCyclesClient } from '../src/data/cycles-client.js';
import { chartAtMinute } from '../src/domain/natal-day.js';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.mjs';

const input = { birthUtc: '2000-01-01T00:00:00Z', body: 'saturn', fromAge: 28, toAge: 30 };
const event = { id: 'saturn:2028-07-21T12:36:05.920740Z', body: 'saturn', utc: '2028-07-21T12:36:05.920740Z', age: 28.5550697647, cycle: 1, pass: 1, cycleId: 'saturn:1', direction: 'direct' };
const events = () => ({ events: [{ ...event }], range: { fromAge: 28, toAge: 30 } });
const chartInput = { birthUtc: input.birthUtc, body: input.body, eventUtc: event.utc, timezone: 'UTC' };
function chartResult(selected = event) {
  return { event: { ...selected }, chart: { ...chartAtMinute(natalDayFixture({ date: '2028-07-21' }), 0, personalChartFixture()), utc: selected.utc } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('personal inputs travel in POST JSON only, and successful cache is bounded and isolated by natal', async () => {
  const calls = [];
  const client = createCyclesClient({ capacity: 1, request: async (url, options) => { calls.push({ url, options }); const result = events(); result.events[0].age = (Date.parse(event.utc) - Date.parse(JSON.parse(options.body).birthUtc)) / (365.2425 * 86400000); return result; } });
  const result = await client.events(input);
  assert.equal((await client.events(input)), result); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/cycles/events'); assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), input); assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  await client.events({ ...input, birthUtc: '1999-01-01T00:00:00Z' });
  await client.events(input); assert.equal(calls.length, 3, 'one-entry cache evicts the older natal request');
  const replacement = createCyclesClient({ request: async () => { calls.push({}); return events(); } });
  await replacement.events(input); assert.equal(calls.length, 4);
});

test('cancelled request never enters cache even when transport ignores its signal', async () => {
  const hold = deferred(), cancel = new AbortController(); let calls = 0;
  const client = createCyclesClient({ request: async () => ++calls === 1 ? hold.promise : events() });
  const old = client.events(input, cancel.signal); cancel.abort(); hold.resolve(events());
  await assert.rejects(old, error => error.name === 'AbortError');
  await client.events(input); assert.equal(calls, 2);
});

test('an already cancelled signal stops both cached and uncached requests without calling transport', async () => {
  let calls = 0; const cancel = new AbortController();
  const client = createCyclesClient({ request: async () => { calls++; return events(); } });
  await client.events(input); cancel.abort();
  await assert.rejects(client.events(input, cancel.signal), error => error.name === 'AbortError');
  await assert.rejects(client.events({ ...input, toAge: 31 }, cancel.signal), error => error.name === 'AbortError');
  assert.equal(calls, 1);
});

test('timeout is readable and retryable while caller cancellation stays AbortError', async () => {
  let calls = 0;
  const client = createCyclesClient({ timeoutMs: 2, request: async (url, { signal }) => {
    if (++calls > 1) return events();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } });
  await assert.rejects(client.events(input), /не успел завершиться/);
  await client.events(input); assert.equal(calls, 2);
});

test('a timeout while reading JSON keeps the cycle timeout message and can retry', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    if (++calls > 1) return Response.json(events());
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    }));
  });
  const client = createCyclesClient({ timeoutMs: 2 });
  await assert.rejects(client.events(input), /не успел завершиться/);
  assert.deepEqual(await client.events(input), events());
  assert.equal(calls, 2);
});

test('server errors keep their code and are never cached', async () => {
  let calls = 0;
  const client = createCyclesClient({ request: async () => { if (++calls === 1) throw Object.assign(new Error('Busy'), { code: 'cycles_busy' }); return events(); } });
  await assert.rejects(client.events(input), error => error.code === 'cycles_busy');
  await client.events(input); assert.equal(calls, 2);
});

test('events reject the wrong body, invalid date, wrong range and impossible birth ownership', async () => {
  for (const data of [null, {}, { events: null }, { ...events(), events: [null] },
    { ...events(), events: [{ ...event, body: 'moon' }] }, { ...events(), events: [{ ...event, utc: 'not a date' }] },
    { ...events(), range: { fromAge: 0, toAge: 100 } },
    { ...events(), events: [{ ...event, utc: '2028-02-30T12:00:00Z' }] },
    { ...events(), events: [{ ...event, utc: '1999-07-21T12:36:05Z' }] }]) {
    const client = createCyclesClient({ request: async () => data });
    await assert.rejects(client.events(input));
  }
});

test('chart must match the requested event moment and body, not just a mutually consistent pair', async () => {
  const wrongDate = { ...event, utc: '2029-04-01T23:24:11.690590Z' };
  for (const data of [null, {}, chartResult({ ...event, body: 'moon' }), chartResult(wrongDate),
    { ...chartResult(), chart: { ...chartResult().chart, utc: '2028-07-21T12:36:00Z' } },
    { ...chartResult(), chart: { ...chartResult().chart, activations: { personality: [], design: [] } } },
    chartResult({ ...event, utc: 'not a date' })]) {
    const client = createCyclesClient({ request: async () => data });
    await assert.rejects(client.chart(chartInput));
  }
  const valid = createCyclesClient({ request: async () => chartResult() });
  const result = await valid.chart(chartInput); assert.equal(result.event.utc, event.utc); assert.equal(result.chart.utc, event.utc);
});

test('real exact worker responses cross client validation without rounding away event seconds', async () => {
  const { generateCycles } = await import('../server/services/cycles.mjs');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const client = createCyclesClient({ request: (url, { body }) => generateCycles({ root, input: { ...JSON.parse(body), action: url.endsWith('/chart') ? 'chart' : 'events' } }) });
  const result = await client.events(input); assert.equal(result.events.length, 3);
  const chosen = result.events[0]; const response = await client.chart({ ...chartInput, eventUtc: chosen.utc });
  assert.equal(response.event.utc, chosen.utc); assert.equal(response.chart.utc, chosen.utc);
});

test('cache identity follows calculation inputs, not property order or an events display timezone', async () => {
  const calls = [];
  const client = createCyclesClient({ request: async (url, options) => { calls.push({ url, options }); return events(); } });
  const first = await client.events({ ...input, timezone: 'UTC' });
  assert.equal(await client.events({ toAge: 30, body: 'saturn', timezone: 'Europe/Moscow', fromAge: 28, birthUtc: input.birthUtc }), first);
  assert.equal(calls.length, 1, 'event times depend on birth, body and age range, not display timezone');
  let defaultCalls = 0;
  const defaults = createCyclesClient({ request: async () => { defaultCalls++; return { events: [], range: { fromAge: 0, toAge: 100 } }; } });
  await defaults.events({ birthUtc: input.birthUtc, body: input.body });
  await defaults.events({ body: input.body, fromAge: 0, toAge: 100, birthUtc: input.birthUtc });
  assert.equal(defaultCalls, 1);
});

const revision = 'a'.repeat(64), encode = value => new TextEncoder().encode(JSON.stringify(value)).buffer;
const tick = () => new Promise(setImmediate);
function deviceCache() {
  const records = new Map();
  return { records, async get(key) { return records.get(key); }, async put(key, value) { records.set(key, value); }, async remove(key) { records.delete(key); } };
}

test('new clients restore validated event lists and exact charts from the versioned device cache without network', async () => {
  const persistentCache = deviceCache(), calls = [];
  const request = async (url, options) => { calls.push({ url, options }); return url.endsWith('/chart') ? chartResult() : events(); };
  const first = createCyclesClient({ cacheVersion: revision, persistentCache, request });
  await first.events(input); await first.chart(chartInput); await tick();
  const reload = createCyclesClient({ cacheVersion: revision, persistentCache, request });
  assert.deepEqual(await reload.events({ ...input, timezone: 'Europe/Moscow' }), events());
  assert.deepEqual(await reload.chart(chartInput), chartResult());
  assert.equal(calls.length, 2, 'reload uses both finished results on the device');
  assert.equal(persistentCache.records.size, 2);
  assert.ok(calls.every(({ options }) => options.headers['X-Forma-Cycles-Version'] === revision));
  const changed = createCyclesClient({ cacheVersion: 'b'.repeat(64), persistentCache, request });
  await changed.events(input); assert.equal(calls.length, 3, 'a new calculation revision cannot reuse old bytes');
});

test('corrupt or mismatched device results are removed and recalculated; storage failure never blocks a result', async () => {
  for (const bytes of [new Uint8Array([255]).buffer, encode({}), encode({ ...events(), range: { fromAge: 0, toAge: 100 } })]) {
    let requests = 0, removed = 0;
    const client = createCyclesClient({ cacheVersion: revision, persistentCache: {
      get: async () => bytes, remove: async () => { removed++; }, put: async () => { throw Error('full'); },
    }, request: async () => { requests++; return events(); } });
    assert.deepEqual(await client.events(input), events()); await tick();
    assert.equal(requests, 1); assert.equal(removed, 1);
  }
  const client = createCyclesClient({ cacheVersion: revision, persistentCache: { get() { throw Error('denied'); }, put() { return new Promise(() => {}); } }, request: async () => events() });
  assert.deepEqual(await client.events(input), events(), 'an unfinished write does not delay the chart');
});

test('cancellation while reading device data never publishes it, fetches or remembers it', async () => {
  const held = deferred(), cancel = new AbortController(); let reads = 0, requests = 0;
  const client = createCyclesClient({ cacheVersion: revision, persistentCache: { get: () => { reads++; return held.promise; } },
    request: async () => { requests++; return events(); } });
  const pending = client.events(input, cancel.signal); cancel.abort(); held.resolve(encode(events()));
  await assert.rejects(pending, error => error.name === 'AbortError');
  await client.events(input);
  assert.equal(reads, 2, 'an aborted read did not enter the in-memory cache'); assert.equal(requests, 0);
});

test('missing bootstrap versions disable device persistence and version mismatch failures never enter it', async () => {
  for (const cacheVersion of [undefined, '', 'a'.repeat(63), 'A'.repeat(64)]) {
    let storage = 0, header;
    const client = createCyclesClient({ cacheVersion, persistentCache: { get() { storage++; }, put() { storage++; } },
      request: async (_, options) => { header = options.headers['X-Forma-Cycles-Version']; return events(); } });
    await client.events(input); await tick(); assert.equal(storage, 0); assert.equal(header, undefined);
  }
  const persistentCache = deviceCache(), client = createCyclesClient({ cacheVersion: revision, persistentCache,
    request: async () => { throw Object.assign(new Error('Reload'), { code: 'unsupported_version' }); } });
  await assert.rejects(client.events(input), error => error.code === 'unsupported_version');
  assert.equal(persistentCache.records.size, 0);
});
