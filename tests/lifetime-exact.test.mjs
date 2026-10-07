import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createLifetimeClient } from '../src/data/lifetime-client.js';
import { createLifetimeExplorer } from '../src/state/lifetime.js';
import { createLifetimeMoments } from '../server/services/lifetime.mjs';
import { createCalculator } from '../server/services/calculate.mjs';
import { createRequestHandler } from '../server/http/app.mjs';
import { LIFETIME_PLANETS } from '../shared/lifetime-format.js';

const engine = 'Swiss Ephemeris 2.10.03', start = Date.parse('2026-10-01T00:00:00Z');
const metadata = { startUtc: '2026-10-01T00:00:00Z', endExclusiveUtc: '2026-10-04T00:00:00Z',
  stepSeconds: 600, samples: 432, planets: LIFETIME_PLANETS, engine };
const utc = '2026-10-02T12:31:00Z', milliseconds = Date.parse(utc);
const design = utc => ({ utc, engine, designUtc: new Date(Date.parse(utc) - 88 * 86400000).toISOString().replace('.000Z', 'Z'),
  longitudes: Array(11).fill(34.123456789), designArcResidualDegrees: 1e-11 });
const full = utc => ({ utc, engine, longitudes: Array(11).fill(12.345678901), design: design(utc) });
const point = index => ({ index, utc: new Date(start + index * 600000).toISOString().replace('.000Z', 'Z'), longitudes: Array(11).fill(21), design: design(new Date(start + index * 600000).toISOString().replace('.000Z', 'Z')) });
const lifetimeFile = { metadata, cacheIdentity: 'a'.repeat(64), getPoint: async index => point(index) };
const root = fileURLToPath(new URL('../', import.meta.url));
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function service(options = {}) { return createLifetimeMoments({ lifetimeFile, calculate: ({ utc }) => full(utc),
  calculationFingerprint: 'b'.repeat(64), ...options }); }
function http(handler, url, method = 'GET') {
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(body) { this.body = body; } };
  return handler({ method, url, headers: { host: 'localhost' } }, res).then(() => ({ ...res, value: res.body ? JSON.parse(res.body) : null }));
}
function harness(calculate = ({ utc }) => full(utc)) {
  const requests = [], dayRequests = [];
  const handler = createRequestHandler({ root, lifetime: lifetimeFile, lifetimeFingerprint: 'b'.repeat(64), calculate,
    now: () => new Date('2026-10-06T00:00:00Z'), transitDays: { get: async date => { dayRequests.push(date); throw new Error('No day'); } },
    publicFiles: async (_req, res) => { res.writeHead(404, {}); res.end(); } });
  const client = createLifetimeClient({ dayClient: { peekDay: () => null, getDay: async date => {
    dayRequests.push(date); throw new Error('date_out_of_range'); } }, fetch: async (url, options) => {
    requests.push({ url, options }); const result = await http(handler, url);
    return { ok: result.status === 200, json: async () => result.value };
  } });
  return { handler, client, requests, dayRequests };
}

test('cold historical 12:31 restores both sides outside Day window; 12:30 reads the full file', async () => {
  const calls = [], h = harness(input => { calls.push(input); return full(input.utc); });
  const explorer = createLifetimeExplorer({ client: h.client });
  assert.equal(await explorer.restore({ opened: true, mode: 'lifetime', fromDate: '2026-10-01', toDate: '2026-10-03', requestedUtc: milliseconds }), true);
  assert.equal(explorer.current.utc, utc);
  assert.equal(explorer.current.activations.personality.length, 13);
  assert.equal(explorer.current.planetFilter.designActivations.length, 13);
  assert.deepEqual(h.dayRequests, []);
  assert.deepEqual(calls, [{ mode: 'transit_moment', utc }]);
  assert.equal(new URL(h.requests[1].url, 'http://test').pathname, '/api/lifetime/moment');
  const chart = await h.client.getMinute(milliseconds - 60000);
  assert.equal(chart.utc, '2026-10-02T12:30:00Z');
  assert.equal(new URL(h.requests[2].url, 'http://test').pathname, '/api/lifetime');
  assert.equal(chart.activations.personality[0].longitude, 21);
  assert.deepEqual(h.dayRequests, []);
});

test('exact moments share bounded calculation admission and complete-moment LRU; grid reads remain available', async () => {
  const calls = [], pending = deferred();
  const s = service({ maxPending: 1, capacity: 2, calculate: input => { calls.push(input); return pending.promise; } });
  const first = s.getUtcMoment(utc), same = s.getUtcMoment(utc.replace('Z', '.000Z'));
  await assert.rejects(s.getUtcMoment('2026-10-02T12:32:00Z'), { code: 'busy' });
  assert.equal((await s.getMoment(1)).index, 1, 'file reads remain available while scalar work is busy');
  assert.equal(calls.length, 1);
  pending.resolve(full(utc));
  const result = await first;
  assert.equal(await same, result); assert.equal(await s.getUtcMoment(utc), result);
  assert.ok(Object.isFrozen(result.longitudes));
  assert.equal(calls.length, 1);
  const values = [], reuse = service({ calculate: input => { values.push(input.mode); return full(input.utc); } });
  const exact = await reuse.getUtcMoment(utc);
  assert.equal(await reuse.getUtcMoment(utc), exact);
  assert.deepEqual(values, ['transit_moment']);
  const grid = await reuse.getUtcMoment('2026-10-02T12:30:00Z');
  assert.equal(await reuse.getMoment(219), grid);
  assert.deepEqual(values, ['transit_moment']);
});

test('exact handler validates version, shape and range before calculator admission', async () => {
  const h = harness(() => { throw new Error('Invalid request must not calculate'); });
  const meta = (await http(h.handler, '/api/lifetime/meta')).value;
  for (const [query, expected] of [
    ['', 400], ['utc=2026-02-30T12:31:00Z', 400], ['utc=2026-10-04T00:00:00Z', 422],
    ['utc=2026-09-30T23:59:00Z', 422], [`utc=${utc}&utc=${utc}`, 400], [`utc=${utc}&index=0`, 400],
    [`utc=${utc}&v=${'c'.repeat(64)}`, 400], [`utc=${utc}&v=${meta.cacheVersion}&v=${meta.cacheVersion}`, 400],
  ]) {
    const result = await http(h.handler, `/api/lifetime/moment?${query}`);
    assert.equal(result.status, expected, query); assert.equal(result.headers['Cache-Control'], 'no-store');
  }
  assert.equal((await http(h.handler, `/api/lifetime/moment?utc=${utc}`, 'POST')).status, 405);
  const valid = harness(); const result = await http(valid.handler, `/api/lifetime/moment?utc=${utc}&v=${meta.cacheVersion}`);
  assert.equal(result.status, 200); assert.equal(result.value.version, '1');
  assert.equal(result.headers['Cache-Control'], 'public, max-age=31536000, immutable');
});

test('malformed exact response is rejected and retry never reuses the failed result', async () => {
  for (const mutate of [value => ({ ...value, utc: '2026-10-02T12:30:00Z' }), value => ({ ...value, longitudes: [1] }),
    value => ({ ...value, engine: 'other' }), value => ({ ...value, design: { ...value.design, engine: 'other' } }), value => ({ ...value, design: { ...value.design, designArcResidualDegrees: -1 } })]) {
    let calls = 0;
    const s = service({ calculate: () => ++calls === 1 ? mutate(full(utc)) : full(utc) });
    await assert.rejects(s.getUtcMoment(utc), { code: 'lifetime_unavailable' });
    assert.equal((await s.getUtcMoment(utc)).utc, utc); assert.equal(calls, 2);
  }
});

test('two consumers share exact transport; only last cancellation aborts it and late result is not cached', async () => {
  let calls = 0; const responses = [];
  const meta = service().metadata;
  const client = createLifetimeClient({ fetch: async (url, options) => {
    if (url.endsWith('/meta')) return { ok: true, json: async () => meta };
    calls++; const pending = deferred(); responses.push({ ...pending, signal: options.signal }); return pending.promise;
  } });
  await client.getMeta();
  const a = new AbortController(), b = new AbortController();
  const first = client.getMinute(milliseconds, { signal: a.signal }), second = client.getMinute(milliseconds, { signal: b.signal });
  await tick(); assert.equal(calls, 1); a.abort(); await assert.rejects(first, { name: 'AbortError' });
  assert.equal(responses[0].signal.aborted, false);
  b.abort(); await assert.rejects(second, { name: 'AbortError' }); assert.equal(responses[0].signal.aborted, true);
  const retry = client.getMinute(milliseconds); await tick(); assert.equal(calls, 2);
  responses[0].resolve({ ok: true, json: async () => ({ ...full(utc), version: '1' }) });
  responses[1].resolve({ ok: true, json: async () => ({ ...full(utc), version: '1' }) });
  assert.equal((await retry).utc, utc);
});

test('real calculator through HTTP and client restores exact historical Swiss values', async t => {
  const calculate = createCalculator({ root }); t.after(() => calculate.close());
  const expected = (await calculate({ mode: 'natal', name: 'Parity', date: utc.slice(0, 10), time: '12:31', city: { id: 'utc', name: 'UTC', timezone: 'UTC' } })).chart;
  const h = harness(calculate), chart = await h.client.getMinute(milliseconds);
  assert.equal(chart.utc, expected.utc); assert.equal(chart.designUtc, expected.designUtc);
  for (const side of ['personality', 'design']) assert.deepEqual(chart.activations[side].map(entry => entry.longitude), expected.activations[side].map(entry => entry.longitude));
  assert.deepEqual(h.dayRequests, []);
});

test('HTTP exact requests share four calculation slots and repeated UTC without a personality-only path', async () => {
  const jobs = [], h = harness(input => {
    const waiting = deferred(); jobs.push({ input, ...waiting }); return waiting.promise;
  });
  const moments = ['12:31', '12:32', '12:33', '12:34'].map(time => `2026-10-02T${time}:00Z`);
  const active = moments.map(value => http(h.handler, `/api/lifetime/moment?utc=${value}`));
  const repeated = http(h.handler, `/api/lifetime/moment?utc=${moments[0].replace('Z', '.000Z')}`);
  await tick();
  assert.deepEqual(jobs.map(job => job.input), moments.map(value => ({ mode: 'transit_moment', utc: value })));
  const overflow = await http(h.handler, '/api/lifetime/moment?utc=2026-10-02T12:35:00Z');
  assert.equal(overflow.status, 503); assert.equal(overflow.value.error, 'busy');
  const gridWhileBusy = await http(h.handler, '/api/lifetime?index=0');
  assert.equal(gridWhileBusy.status, 200); assert.equal(jobs.length, 4);
  jobs.forEach(job => job.resolve(full(job.input.utc)));
  const responses = await Promise.all(active), duplicate = await repeated;
  responses.forEach((response, index) => {
    assert.equal(response.status, 200); assert.equal(response.value.utc, moments[index]);
    assert.deepEqual(response.value.longitudes, full(moments[index]).longitudes);
    assert.deepEqual(response.value.design.longitudes, design(moments[index]).longitudes);
  });
  assert.equal(duplicate.body, responses[0].body);
  assert.equal((await http(h.handler, `/api/lifetime/moment?utc=${moments[0]}`)).body, responses[0].body);
  assert.equal(jobs.length, 4);
  assert.equal((await http(h.handler, '/api/lifetime?index=0')).status, 200);
  assert.equal(jobs.length, 4, 'grid reads do not enter the scalar calculator');
});

test('exact and grid entries share server and client eviction limits', async () => {
  const calls = [], s = service({ capacity: 1, calculate: input => {
    calls.push(input.mode); return full(input.utc);
  } });
  await s.getUtcMoment(utc); await s.getMoment(0); await s.getUtcMoment(utc);
  assert.deepEqual(calls, ['transit_moment', 'transit_moment']);
  const h = harness(), requests = [];
  const client = createLifetimeClient({ capacity: 1, fetch: async (url, options) => {
    requests.push({ url, cache: options.cache }); const result = await http(h.handler, url);
    return { ok: result.status === 200, json: async () => result.value };
  } });
  const first = await client.getMinute(milliseconds);
  assert.equal(first, await client.getMinute(milliseconds));
  await client.getPoint(0); await client.getMinute(milliseconds);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.slice(1).map(request => request.cache), ['default', 'default', 'default']);
});

test('client rejects mismatched exact UTC, contract versions and malformed sides before caching', async () => {
  for (const mutate of [value => ({ ...value, utc: '2026-10-02T12:30:00Z' }), value => ({ ...value, version: '2' }),
    value => ({ ...value, longitudes: Array(11).fill(NaN) }), value => ({ ...value, design: null }),
    value => ({ ...value, design: { ...value.design, utc: '2026-10-02T12:32:00Z' } })]) {
    let calls = 0;
    const client = createLifetimeClient({ fetch: async url => ({ ok: true, json: async () => {
      if (url.endsWith('/meta')) return metadata;
      const value = { ...full(utc), version: '1' }; return ++calls === 1 ? mutate(value) : value;
    } }) });
    await assert.rejects(client.getMinute(milliseconds), /Некорректные данные/);
    assert.equal((await client.getMinute(milliseconds)).utc, utc); assert.equal(calls, 2);
  }
});
