import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequestHandler } from '../server/http/app.mjs';
import { createCalculator } from '../server/services/calculate.mjs';
import { LIFETIME_PLANETS, LIFETIME_STEP_SECONDS } from '../shared/lifetime-format.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = 'Swiss Ephemeris 2.10.03';
const metadata = { startUtc: '1801-01-01T00:00:00Z', endExclusiveUtc: '2400-01-01T00:00:00Z',
  stepSeconds: LIFETIME_STEP_SECONDS, samples: (Date.parse('2400-01-01T00:00:00Z') - Date.parse('1801-01-01T00:00:00Z')) / (LIFETIME_STEP_SECONDS * 1000),
  planets: LIFETIME_PLANETS, source };
const utcAt = index => new Date(Date.parse(metadata.startUtc) + index * metadata.stepSeconds * 1000).toISOString().replace('.000Z', 'Z');
const indexAt = utc => (Date.parse(utc) - Date.parse(metadata.startUtc)) / (metadata.stepSeconds * 1000);
const point = utc => ({ utc, designUtc: new Date(Date.parse(utc) - 88 * 86400000).toISOString().replace('.000Z', 'Z'), designArcResidualDegrees: 1e-11,
  longitudes: LIFETIME_PLANETS.map((_, index) => index * 30 + 0.12345678901234) });
const calculatedPoint = utc => ({ ...point(utc), engine: source });
const archivePoint = index => ({ index, utc: utcAt(index), longitudes: point(utcAt(index)).longitudes });
const archive = { metadata, getPoint: async index => archivePoint(index) };
async function request({ index = indexAt('2026-09-30T12:30:00Z'), url, method = 'GET', headers = {}, lifetime = archive,
  calculate = async ({ utc }) => calculatedPoint(utc) } = {}) {
  const res = { status: null, headers: {}, body: '', writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(body) { this.body = body || ''; } };
  const handler = createRequestHandler({ root, lifetime, calculate, cities: {}, publicFiles: async (_req, response) => { response.writeHead(404, {}); response.end(); } });
  await handler({ method, url: url || `/api/lifetime?${new URLSearchParams({ index })}`, headers: { host: 'localhost', ...headers } }, res);
  return res;
}

test('lifetime route returns both sides for the selected archive UTC with bounded response fields', async () => {
  for (const utc of ['1801-01-01T00:00:00Z', '2026-09-30T12:30:00Z', '2399-12-31T23:50:00Z']) {
    const calls = [], index = indexAt(utc);
    const response = await request({ index, calculate: async input => { calls.push(input); return { ...calculatedPoint(input.utc), discardedInternalField: '/private/secret' }; } });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ mode: 'transit_design', utc }]);
    assert.deepEqual(JSON.parse(response.body), { ...archivePoint(index), design: point(utc) });
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal(response.headers['Content-Length'], Buffer.byteLength(response.body));
    assert.equal(response.body.includes('/private'), false);
  }
});

test('index validation rejects normalization, unknown/duplicate fields, bounds and unsupported methods before worker admission', async () => {
  let calls = 0;
  const calculate = async () => { calls++; throw new Error('must not run'); };
  for (const index of ['-1', '+1', '01', '1.0', '1e2', '0x1', 'NaN', 'Infinity', '9007199254740992', metadata.samples]) {
    const response = await request({ index, calculate });
    assert.equal(response.status, 400, String(index));
  }
  for (const url of ['/api/lifetime', '/api/lifetime?index=0&index=1', '/api/lifetime?index=0&utc=2026-09-30T12:30:00Z']) {
    assert.equal((await request({ url, calculate })).status, 400);
  }
  for (const method of ['POST', 'HEAD', 'DELETE']) {
    const response = await request({ method, calculate });
    assert.equal(response.status, 405); assert.equal(response.headers.Allow, 'GET');
  }
  assert.equal((await request({ headers: { origin: 'https://outside.example' }, calculate })).status, 403);
  assert.equal((await request({ lifetime: null, calculate })).status, 503);
  assert.equal((await request({ url: '/api/lifetime/design?utc=2026-09-30T12:30:00Z', calculate })).status, 404);
  assert.equal(calls, 0);
});

test('worker failure, capacity and malformed data stay retriable without exposing internal details', async () => {
  const utc = '2026-09-30T12:30:00Z';
  for (const value of [undefined, { error: 'timeout', message: '/private/secret' }, { ...calculatedPoint(utc), utc: '2026-09-30T12:40:00Z' },
    { ...calculatedPoint(utc), longitudes: [1] }, { ...calculatedPoint(utc), longitudes: Array(11).fill(NaN) },
    { ...calculatedPoint(utc), engine: undefined }, { ...calculatedPoint(utc), engine: 'Swiss Ephemeris 2.9.0' },
    { ...calculatedPoint(utc), designUtc: 'invalid' }, { ...calculatedPoint(utc), designArcResidualDegrees: 1e-6 }]) {
    const response = await request({ calculate: async () => value });
    assert.equal(response.status, 503); assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal(response.body.includes('/private/secret'), false);
  }
  const busy = await request({ calculate: async () => ({ error: 'busy' }) });
  assert.equal(busy.status, 503); assert.equal(JSON.parse(busy.body).error, 'busy');
  assert.equal((await request({ calculate: async () => { throw new Error('/private/secret'); } })).body.includes('/private'), false);
});

test('Design-only requests reuse a session within the shared calculator process admission limits', async t => {
  const workers = [];
  const calculate = createCalculator({ root, limits: { concurrency: 1, timeoutMs: 1000, outputCharacters: 100000 }, spawnWorker() {
    const worker = new EventEmitter(); worker.stdout = new EventEmitter(); worker.stdout.setEncoding = () => {};
    worker.stdin = new EventEmitter(); worker.stdin.write = input => { worker.input = JSON.parse(input); };
    worker.kill = () => worker.emit('close', null);
    workers.push(worker); return worker;
  } });
  t.after(() => calculate.close());
  const first = calculate({ mode: 'transit_design', utc: '2026-09-30T12:34:56Z' });
  assert.deepEqual(workers[0].input, { id: 1, utc: '2026-09-30T12:34:56Z' });
  assert.equal((await calculate({ mode: 'transit' })).error, 'busy', 'transit and Design share the same admission counter');
  assert.equal(workers.length, 1);
  workers[0].stdout.emit('data', JSON.stringify({ id: workers[0].input.id, result: calculatedPoint(workers[0].input.utc) }) + '\n');
  assert.deepEqual(await first, calculatedPoint('2026-09-30T12:34:56Z'));
  const next = calculate({ mode: 'transit_design', utc: '2026-09-30T12:35:56Z' });
  assert.equal(workers.length, 1);
  assert.equal(workers[0].input.id, 2);
  workers[0].stdout.emit('data', JSON.stringify({ id: workers[0].input.id, result: calculatedPoint(workers[0].input.utc) }) + '\n');
  assert.equal((await next).utc, '2026-09-30T12:35:56Z');
});

test('real lifetime Design float bits, UTC and residual equal the production natal calculator across supported years', async t => {
  try { await access(new URL('../.venv/bin/python', import.meta.url)); } catch { t.skip('Local Python environment unavailable'); return; }
  const calculate = createCalculator({ root });
  t.after(() => calculate.close());
  for (const date of ['1801-01-01', '2024-02-29', '2399-12-31']) {
    const { chart } = await calculate({ mode: 'natal', name: 'Parity', date, time: '12:30', city: { id: 'utc', name: 'UTC', timezone: 'UTC' } });
    const index = indexAt(chart.utc), expected = new Map(chart.activations.design.map(entry => [entry.planet, entry.longitude]));
    const longitudes = LIFETIME_PLANETS.map(planet => chart.activations.personality.find(entry => entry.planet === planet).longitude);
    const lifetime = { metadata: { ...metadata, source: chart.engine }, getPoint: async requested => {
      assert.equal(requested, index); return { index, utc: chart.utc, longitudes };
    } };
    const response = await request({ index, calculate, lifetime });
    assert.equal(response.status, 200);
    const actual = JSON.parse(response.body);
    assert.deepEqual(actual.longitudes, longitudes);
    actual.design.longitudes.forEach((value, column) => assert.ok(Object.is(value, expected.get(LIFETIME_PLANETS[column])), `${date} ${LIFETIME_PLANETS[column]}`));
    assert.equal(actual.design.designUtc, chart.designUtc);
    assert.ok(Object.is(actual.design.designArcResidualDegrees, chart.designArcResidualDegrees));
  }
});
