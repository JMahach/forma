import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCache, estimateBytes } from '../src/data/memory-cache.js';
import { createCyclesClient } from '../src/data/cycles-client.js';
import { chartAtMinute } from '../src/domain/natal-day.js';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.mjs';

const input = { birthUtc: '2000-01-01T00:00:00Z', body: 'saturn', fromAge: 28, toAge: 30 };
const event = { id: 'saturn:2028-07-21T12:36:05.920740Z', body: 'saturn', utc: '2028-07-21T12:36:05.920740Z', age: 28.5550697647, cycle: 1, pass: 1, cycleId: 'saturn:1', direction: 'direct' };
const events = () => ({ events: [{ ...event }], range: { fromAge: 28, toAge: 30 } });
const chartInput = { birthUtc: input.birthUtc, body: input.body, eventUtc: event.utc, timezone: 'UTC' };
function chartResult(selected = event) {
  return { chart: { ...chartAtMinute(natalDayFixture({ date: '2028-07-21' }), 0, personalChartFixture()), utc: selected.utc } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('personal inputs travel in POST JSON only; exact chart RAM is bounded and isolated by natal', async () => {
  const calls = [];
  const client = createCyclesClient({ memory: createMemoryCache({ maxBytes: estimateBytes(chartResult()) }), request: async (url, options) => { calls.push({ url, options }); return chartResult(); } });
  const result = await client.chart(chartInput);
  assert.equal(await client.chart(chartInput), result); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/cycles/chart'); assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.deepEqual(JSON.parse(calls[0].options.body), chartInput); assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  await client.chart({ ...chartInput, birthUtc: '1999-01-01T00:00:00Z' });
  await client.chart(chartInput); assert.equal(calls.length, 3);
  const replacement = createCyclesClient({ request: async () => { calls.push({}); return chartResult(); } });
  await replacement.chart(chartInput); assert.equal(calls.length, 4);
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

test('chart must match the exact requested UTC and timezone and contain complete activations', async () => {
  const wrongDate = { ...event, utc: '2029-04-01T23:24:11.690590Z' };
  for (const data of [null, {}, chartResult(wrongDate),
    { ...chartResult(), chart: { ...chartResult().chart, utc: '2028-07-21T12:36:00Z' } },
    { ...chartResult(), chart: { ...chartResult().chart, activations: { personality: [], design: [] } } },
    chartResult({ ...event, utc: 'not a date' })]) {
    const client = createCyclesClient({ request: async () => data });
    await assert.rejects(client.chart(chartInput));
  }
  const valid = createCyclesClient({ request: async () => chartResult() });
  const result = await valid.chart(chartInput); assert.equal(result.chart.utc, event.utc);
});

test('real exact worker responses cross client validation without rounding away event seconds', async () => {
  const { generateCycles } = await import('../server/services/cycles.mjs');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const client = createCyclesClient({ request: (url, { body }) => generateCycles({ root, input: { ...JSON.parse(body), action: url.endsWith('/chart') ? 'chart' : 'events' } }) });
  const result = await client.events(input); assert.equal(result.events.length, 3);
  const chosen = result.events[0]; const response = await client.chart({ ...chartInput, eventUtc: chosen.utc });
  assert.equal(response.chart.utc, chosen.utc);
});

test('cache identity follows calculation inputs, not property order or an events display timezone', async () => {
  const calls = [];
  const client = createCyclesClient({ cacheVersion: revision, returnStorage: deviceCache(), request: async (url, options) => { calls.push({ url, options }); return events(); } });
  const first = await client.events({ ...input, timezone: 'UTC' });
  assert.equal(await client.events({ toAge: 30, body: 'saturn', timezone: 'Europe/Moscow', fromAge: 28, birthUtc: input.birthUtc }), first);
  assert.equal(calls.length, 1, 'event times depend on birth, body and age range, not display timezone');
  let defaultCalls = 0;
  const defaults = createCyclesClient({ cacheVersion: revision, returnStorage: deviceCache(), request: async () => { defaultCalls++; return { events: [], range: { fromAge: 0, toAge: 100 } }; } });
  await defaults.events({ birthUtc: input.birthUtc, body: input.body });
  await defaults.events({ body: input.body, fromAge: 0, toAge: 100, birthUtc: input.birthUtc });
  assert.equal(defaultCalls, 1);
});

const revision = 'a'.repeat(64);
const tick = () => new Promise(setImmediate);
function deviceCache() {
  const records = new Map();
  return { records, async getEvents(key) { return records.get(key); }, async putEvents(key, _input, value) { records.set(key, value); }, async removeEvents(key) { records.delete(key); },
    async getChart(key) { return records.get(key); }, async putChart(key, value) { records.set(key, value); }, async removeChart(key) { records.delete(key); } };
}

test('reload reads both dates and opened exact charts from the versioned device storage', async () => {
  const returnStorage = deviceCache(), calls = [];
  const request = async (url, options) => { calls.push({ url, options }); return url.endsWith('/chart') ? chartResult() : events(); };
  const first = createCyclesClient({ cacheVersion: revision, returnStorage, request });
  await first.events(input); await first.chart(chartInput); await tick();
  const reload = createCyclesClient({ cacheVersion: revision, returnStorage, request });
  assert.deepEqual(await reload.events({ ...input, timezone: 'Europe/Moscow' }), events());
  assert.deepEqual(await reload.chart(chartInput), chartResult());
  assert.equal(calls.length, 2); assert.equal(returnStorage.records.size, 2);
  assert.ok(calls.every(({ options }) => options.headers['X-Forma-Cycles-Version'] === revision));
  const changed = createCyclesClient({ cacheVersion: 'b'.repeat(64), returnStorage, request });
  await changed.events(input); await changed.chart(chartInput); assert.equal(calls.length, 4, 'a new numerical revision cannot reuse old dates or charts');
});

test('corrupt or mismatched device results are removed and recalculated; storage failure never blocks a result', async () => {
  for (const bytes of [{}, { events: [] }, { ...events(), range: { fromAge: 0, toAge: 100 } }]) {
    let requests = 0, removed = 0;
    const client = createCyclesClient({ cacheVersion: revision, returnStorage: {
      getEvents: async () => bytes, removeEvents: async () => { removed++; }, putEvents: async () => { throw Error('full'); },
    }, request: async () => { requests++; return events(); } });
    assert.deepEqual(await client.events(input), events()); await tick();
    assert.equal(requests, 1); assert.equal(removed, 1);
  }
  const client = createCyclesClient({ cacheVersion: revision, returnStorage: { getEvents() { throw Error('denied'); }, putEvents() { return new Promise(() => {}); } }, request: async () => events() });
  assert.deepEqual(await client.events(input), events(), 'an unfinished write does not delay the chart');
});

test('cancellation while reading device data never publishes it, fetches or remembers it', async () => {
  const held = deferred(), cancel = new AbortController(); let reads = 0, requests = 0;
  const client = createCyclesClient({ cacheVersion: revision, returnStorage: { getEvents: () => { reads++; return held.promise; } },
    request: async () => { requests++; return events(); } });
  const pending = client.events(input, cancel.signal); cancel.abort(); held.resolve(events());
  await assert.rejects(pending, error => error.name === 'AbortError');
  await client.events(input);
  assert.equal(reads, 2, 'an aborted read did not enter the in-memory cache'); assert.equal(requests, 0);
});

test('missing bootstrap versions disable device persistence and version mismatch failures never enter it', async () => {
  for (const cacheVersion of [undefined, '', 'a'.repeat(63), 'A'.repeat(64)]) {
    let storage = 0, header;
    const client = createCyclesClient({ cacheVersion, returnStorage: { getEvents() { storage++; }, putEvents() { storage++; } },
      request: async (_, options) => { header = options.headers['X-Forma-Cycles-Version']; return events(); } });
    await client.events(input); await tick(); assert.equal(storage, 0); assert.equal(header, undefined);
  }
  const returnStorage = deviceCache(), client = createCyclesClient({ cacheVersion: revision, returnStorage,
    request: async () => { throw Object.assign(new Error('Reload'), { code: 'unsupported_version' }); } });
  await assert.rejects(client.events(input), error => error.code === 'unsupported_version');
  assert.equal(returnStorage.records.size, 0);
});

test('a chart already owned by shared application memory bypasses device reads and transport', async () => {
  const ready = chartResult(), keys = [];
  const client = createCyclesClient({ cacheVersion: revision,
    memory: { get(key) { keys.push(key); return ready; }, put() { assert.fail('a ready shared result must not be replaced'); } },
    returnStorage: { getChart() { assert.fail('ready memory precedes device'); } },
    request() { assert.fail('ready memory precedes transport'); },
  });
  assert.equal(await client.chart(chartInput), ready);
  assert.ok(keys.length && keys.every(key => key.startsWith('return-chart:')));
});

test('persistent chart identity separates revision, birth, body, exact UTC and display timezone', async () => {
  const returnStorage = deviceCache(), calls = [];
  const request = async (_url, options) => { const input = JSON.parse(options.body); calls.push(input); return { chart: { ...chartResult().chart, utc: input.eventUtc, timezone: input.timezone } }; };
  const options = { cacheVersion: revision, returnStorage, request };
  for (const input of [chartInput, { ...chartInput, birthUtc: '1999-01-01T00:00:00Z' }, { ...chartInput, body: 'jupiter' },
    { ...chartInput, eventUtc: event.utc.replace('740Z', '741Z') }, { ...chartInput, timezone: 'Europe/Moscow' }]) {
    await createCyclesClient(options).chart(input);
    await createCyclesClient(options).chart(input);
  }
  assert.equal(calls.length, 5);
  await createCyclesClient({ ...options, cacheVersion: 'b'.repeat(64) }).chart(chartInput);
  assert.equal(calls.length, 6); assert.equal(returnStorage.records.size, 6);
});

test('a chart obtained from persistent storage participates in the common memory byte budget', async () => {
  const returnStorage = deviceCache(), value = chartResult(), memory = createMemoryCache({ maxBytes: estimateBytes(value) });
  let requests = 0, reads = 0;
  const read = returnStorage.getChart; returnStorage.getChart = key => { reads++; return read(key); };
  const options = { cacheVersion: revision, returnStorage, memory, request: async () => { requests++; return value; } };
  const client = createCyclesClient(options); await client.chart(chartInput); await tick();
  memory.put('other-feature:data', new ArrayBuffer(estimateBytes(value)));
  assert.equal(memory.size, 1); const restored = await client.chart(chartInput);
  assert.equal(restored, value); assert.equal(requests, 1); assert.equal(reads, 2);
  assert.ok(memory.bytes <= estimateBytes(value));
});

for (const stale of [false, true]) test(`a full chart device ${stale ? 'miss' : 'hit'} during an older request preserves cache-before-network ordering`, async () => {
  const network = deferred(), disk = deferred(); let reads = 0, requests = 0;
  const value = chartResult(), client = createCyclesClient({ cacheVersion: revision, returnStorage: {
    getChart: () => ++reads === 1 ? Promise.resolve(null) : disk.promise, putChart: async () => {},
  }, request: async () => { requests++; return network.promise; } });
  const first = client.chart(chartInput); await tick(); const second = client.chart(chartInput); await tick();
  if (stale) { network.resolve(value); await first; disk.resolve(null); assert.equal(await second, value); }
  else { disk.resolve(value); assert.equal(await second, value); network.resolve(value); await first; }
  assert.equal(requests, 1);
});

test('corrupt persistent full charts cannot enter shared RAM and are replaced by a valid response', async () => {
  let removed = 0, requests = 0;
  const value = chartResult(), client = createCyclesClient({ cacheVersion: revision, returnStorage: {
    getChart: async () => ({ chart: { ...value.chart, utc: '2030-01-01T00:00:00Z' } }),
    removeChart: async () => { removed++; }, putChart: async () => {},
  }, request: async () => { requests++; return value; } });
  assert.equal(await client.chart(chartInput), value); await tick();
  assert.equal(await client.chart(chartInput), value); assert.equal(requests, 1); assert.equal(removed, 1);
});


test('retained return charts share the tab budget and release their exact cache identity', async () => {
  const memory = createMemoryCache({ maxBytes: 1 }), data = chartResult();
  let calls = 0;
  const client = createCyclesClient({ memory, request: async () => { calls++; return data; } });
  const release = client.retainChart({ ...chartInput, timezone: undefined }, data);
  memory.put('another-tool', new ArrayBuffer(16));
  assert.equal(await client.chart(chartInput), data);
  assert.equal(calls, 0);
  assert.ok(memory.bytes > 1, 'active data remains accounted even beyond the reuse budget');
  release(); release();
  assert.equal(memory.size, 0);
  await client.chart(chartInput); assert.equal(calls, 1);
});
