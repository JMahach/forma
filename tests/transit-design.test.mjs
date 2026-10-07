import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLifetimeFile } from '../server/services/lifetime.mjs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createRequestHandler } from '../server/http/app.mjs';
import { createCalculator } from '../server/services/calculate.mjs';
import { LIFETIME_PLANETS, LIFETIME_STEP_SECONDS } from '../shared/lifetime-format.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const engine = 'Swiss Ephemeris 2.10.03';
const metadata = { startUtc: '1801-01-01T00:00:00Z', endExclusiveUtc: '2400-01-01T00:00:00Z',
  stepSeconds: LIFETIME_STEP_SECONDS, samples: (Date.parse('2400-01-01T00:00:00Z') - Date.parse('1801-01-01T00:00:00Z')) / (LIFETIME_STEP_SECONDS * 1000),
  planets: LIFETIME_PLANETS, engine };
const utcAt = index => new Date(Date.parse(metadata.startUtc) + index * metadata.stepSeconds * 1000).toISOString().replace('.000Z', 'Z');
const indexAt = utc => (Date.parse(utc) - Date.parse(metadata.startUtc)) / (metadata.stepSeconds * 1000);
const point = utc => ({ utc, designUtc: new Date(Date.parse(utc) - 88 * 86400000).toISOString().replace('.000Z', 'Z'), designArcResidualDegrees: 1e-11,
  longitudes: LIFETIME_PLANETS.map((_, index) => index * 30 + 0.12345678901234) });
const calculatedPoint = utc => ({ ...point(utc), engine });
const storedPoint = index => ({ index, utc: utcAt(index), longitudes: point(utcAt(index)).longitudes, design: point(utcAt(index)) });
const lifetimeFile = { metadata, getPoint: async index => storedPoint(index) };
async function request({ index = indexAt('2026-09-30T12:30:00Z'), url, method = 'GET', headers = {}, lifetime = lifetimeFile,
  calculate = async ({ utc }) => calculatedPoint(utc) } = {}) {
  const res = { status: null, headers: {}, body: '', writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(body) { this.body = body || ''; } };
  const handler = createRequestHandler({ root, lifetime, calculate, cities: {}, publicFiles: async (_req, response) => { response.writeHead(404, {}); response.end(); } });
  await handler({ method, url: url || `/api/lifetime?${new URLSearchParams({ index })}`, headers: { host: 'localhost', ...headers } }, res);
  return res;
}

test('lifetime route returns both sides for the selected stored UTC with bounded response fields', async () => {
  for (const utc of ['1801-01-01T00:00:00Z', '2026-09-30T12:30:00Z', '2399-12-31T23:50:00Z']) {
    const calls = [], index = indexAt(utc);
    const response = await request({ index, calculate: async input => { calls.push(input); return { ...calculatedPoint(input.utc), discardedInternalField: '/private/secret' }; } });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, []);
    assert.deepEqual(JSON.parse(response.body), { ...storedPoint(index), design: point(utc) });
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
  const utc = '2026-09-30T12:31:00Z', url = `/api/lifetime/moment?utc=${utc}`;
  for (const value of [undefined, { error: 'timeout', message: '/private/secret' }, { ...calculatedPoint(utc), utc: '2026-09-30T12:40:00Z' },
    { ...calculatedPoint(utc), longitudes: [1] }, { ...calculatedPoint(utc), longitudes: Array(11).fill(NaN) },
    { ...calculatedPoint(utc), engine: undefined }, { ...calculatedPoint(utc), engine: 'Swiss Ephemeris 2.9.0' },
    { ...calculatedPoint(utc), designUtc: 'invalid' }, { ...calculatedPoint(utc), designArcResidualDegrees: 1e-6 }]) {
    const response = await request({ url, calculate: async () => ({ utc, engine, longitudes: point(utc).longitudes, design: value }) });
    assert.equal(response.status, 503); assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal(response.body.includes('/private/secret'), false);
  }
  const busy = await request({ url, calculate: async () => ({ error: 'busy' }) });
  assert.equal(busy.status, 503); assert.equal(JSON.parse(busy.body).error, 'busy');
  assert.equal((await request({ url, calculate: async () => { throw new Error('/private/secret'); } })).body.includes('/private'), false);
});

test('public Design-only calculation uses the scalar pool and preserves exact output', async t => {
  const calculate = createCalculator({ root }); t.after(() => calculate.close());
  const utc = '1801-01-01T12:30:00Z';
  const whole = await calculate({ mode: 'transit_moment', utc });
  const standalone = await calculate({ mode: 'transit_design', utc });
  assert.deepEqual(standalone, whole.design);
  assert.equal(standalone.designUtc.slice(0, 4), '1800');
  const city = { id: 'utc', name: 'UTC', timezone: 'UTC' };
  const handler = createRequestHandler({ root, calculate, cities: { find: () => city }, publicFiles() { throw Error('unexpected static'); } });
  const req = Readable.from([Buffer.from(JSON.stringify({ mode: 'transit_design', utc, cityId: city.id }))]);
  Object.assign(req, { method: 'POST', url: '/api/calculate', headers: { host: 'localhost', 'content-type': 'application/json' } });
  const res = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
  await handler(req, res);
  assert.equal(res.status, 200); assert.deepEqual(JSON.parse(res.body), standalone);
});

test('real lifetime Design float bits, UTC and residual equal the production natal calculator across supported years', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forma-lifetime-parity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calculate = createCalculator({ root });
  t.after(() => calculate.close());
  for (const date of ['1801-01-01', '2024-02-29', '2399-12-31']) {
    const { chart } = await calculate({ mode: 'natal', name: 'Parity', date, time: '12:30', city: { id: 'utc', name: 'UTC', timezone: 'UTC' } });
    const expected = new Map(chart.activations.design.map(entry => [entry.planet, entry.longitude]));
    const longitudes = LIFETIME_PLANETS.map(planet => chart.activations.personality.find(entry => entry.planet === planet).longitude);
    const file = path.join(directory, `${date}.f64le`), metadataFile = file.replace('.f64le', '.metadata.json');
    const end = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    await promisify(execFile)(path.join(root, '.venv/bin/python'), ['-m', 'server.python.lifetime_file', '--file', file,
      '--start', date, '--end', end, '--workers', '1'], { cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    const lifetime = await createLifetimeFile({ file, metadataFile }); t.after(() => lifetime.close());
    const response = await request({ index: 75, lifetime, calculate() { throw Error('Prepared points must never calculate'); } });
    assert.equal(response.status, 200);
    const actual = JSON.parse(response.body);
    assert.deepEqual(actual.longitudes, longitudes);
    actual.design.longitudes.forEach((value, column) => assert.ok(Object.is(value, expected.get(LIFETIME_PLANETS[column])), `${date} ${LIFETIME_PLANETS[column]}`));
    assert.equal(actual.design.designUtc, chart.designUtc);
    assert.ok(Object.is(actual.design.designArcResidualDegrees, chart.designArcResidualDegrees));
  }
});
