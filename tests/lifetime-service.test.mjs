import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLifetimeArchive, createLifetimeMoments } from '../server/services/lifetime.mjs';
import { createLifetimeHandler } from '../server/http/lifetime.mjs';
import { LIFETIME_PLANETS, LIFETIME_STEP_SECONDS, LIFETIME_ARCHIVE_VERSION, LIFETIME_ARCHIVE_FORMAT } from '../shared/lifetime-format.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, samples = 17) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-lifetime-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'sample.f64le'), metadataFile = path.join(directory, 'sample.metadata.json');
  const bytes = Buffer.alloc(samples * LIFETIME_PLANETS.length * 8), start = Date.parse('1900-01-01T00:00:00Z');
  const columns = LIFETIME_PLANETS.map((_, column) => Array.from({ length: samples }, (_, index) => column * 30 + index / 1024 + 0.123456789012345));
  columns[0][0] = 0; columns.at(-1)[samples - 1] = 359.99999999999994;
  columns.forEach((values, column) => values.forEach((value, index) => bytes.writeDoubleLE(value, (column * samples + index) * 8)));
  const metadata = { version: LIFETIME_ARCHIVE_VERSION, format: LIFETIME_ARCHIVE_FORMAT, columns: [...LIFETIME_PLANETS], startUtc: '1900-01-01T00:00:00Z',
    endExclusiveUtc: new Date(start + samples * LIFETIME_STEP_SECONDS * 1000).toISOString().replace('.000Z', 'Z'), stepSeconds: LIFETIME_STEP_SECONDS,
    sampleCount: samples, bytes: bytes.length, flags: 258, engine: 'Swiss Ephemeris 2.10.03', sha256: createHash('sha256').update(bytes).digest('hex') };
  await fs.writeFile(file, bytes); await fs.writeFile(metadataFile, JSON.stringify(metadata));
  return { file, metadataFile, metadata, columns, bytes };
}
async function archive(t, input) {
  const service = await createLifetimeArchive(input); t.after(() => service.close()); return service;
}
const unavailable = error => error.code === 'lifetime_unavailable' && error.status === 503 && !error.message.includes('/');

test('lifetime archive is disabled without explicit corpus configuration', async () => {
  assert.equal(await createLifetimeArchive(), null);
  await assert.rejects(createLifetimeArchive({ file: '/private/missing' }), unavailable);
});

test('first, middle and last points preserve all Float64 values with public metadata only', async t => {
  const input = await fixture(t), service = await archive(t, input);
  assert.deepEqual(service.metadata, { startUtc: input.metadata.startUtc, endExclusiveUtc: input.metadata.endExclusiveUtc,
    stepSeconds: 600, samples: 17, planets: [...LIFETIME_PLANETS], source: 'Swiss Ephemeris 2.10.03' });
  for (const index of [0, 8, 16]) {
    const point = await service.getPoint(index);
    assert.equal(point.index, index);
    assert.equal(point.utc, new Date(Date.parse(input.metadata.startUtc) + index * 600_000).toISOString().replace('.000Z', 'Z'));
    point.longitudes.forEach((value, column) => assert.ok(Object.is(value, input.columns[column][index])));
  }
  assert.ok(Object.isFrozen(service.metadata)); assert.ok(Object.isFrozen(service.metadata.planets));
  assert.equal(JSON.stringify(service.metadata).includes(input.file), false);
});

test('concurrent point requests use independent positional reads', async t => {
  const input = await fixture(t), service = await archive(t, input);
  const indices = Array.from({ length: 80 }, (_, index) => index * 7 % 17);
  const points = await Promise.all(indices.map(index => service.getPoint(index)));
  points.forEach((point, request) => assert.deepEqual(point.longitudes, input.columns.map(column => column[indices[request]])));
});

test('invalid point indices never become file offsets', async t => {
  const input = await fixture(t), service = await archive(t, input);
  for (const index of [-1, 17, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined]) {
    await assert.rejects(service.getPoint(index), error => error.code === 'invalid_index' && error.status === 400);
  }
});

test('malformed archive metadata and mismatched file sizes are rejected', async t => {
  const input = await fixture(t);
  const changes = [
    { version: '1' }, { version: '3' }, { version: undefined }, { format: 'Float32' }, { columns: [...LIFETIME_PLANETS].reverse() },
    { columns: ['north_node', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'] },
    { columns: ['sun', 'north_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'] },
    { columns: [...LIFETIME_PLANETS, 'moon'] }, { sampleCount: 1.5 }, { sampleCount: 0 },
    { stepSeconds: 60 }, { flags: 2 }, { engine: '/private/secret' }, { sha256: 'bad' },
    { bytes: input.bytes.length - 8 }, { startUtc: '1900-02-30T00:00:00Z' },
    { startUtc: '1800-12-31T23:50:00Z' }, { endExclusiveUtc: '1901-01-01T00:00:00Z' },
  ];
  for (const change of changes) {
    await fs.writeFile(input.metadataFile, JSON.stringify({ ...input.metadata, ...change }));
    await assert.rejects(createLifetimeArchive(input), unavailable, JSON.stringify(change));
  }
  for (const content of ['not JSON', 'null', '[]', ' '.repeat(16_385)]) {
    await fs.writeFile(input.metadataFile, content); await assert.rejects(createLifetimeArchive(input), unavailable);
  }
  await fs.writeFile(input.metadataFile, JSON.stringify(input.metadata));
  const valid = await createLifetimeArchive(input); await valid.close();
  await fs.truncate(input.file, input.bytes.length - 1);
  await assert.rejects(createLifetimeArchive(input), unavailable);
});

test('short reads and invalid stored angles fail without exposing filesystem details', async t => {
  const input = await fixture(t), service = await archive(t, input);
  await fs.truncate(input.file, input.bytes.length - 1);
  await assert.rejects(service.getPoint(16), unavailable);
  for (const invalid of [NaN, Infinity, -0.1, 360]) {
    const broken = Buffer.from(input.bytes); broken.writeDoubleLE(invalid, 8);
    await fs.writeFile(input.file, broken); await assert.rejects(service.getPoint(1), unavailable);
  }
  await fs.writeFile(input.file, input.bytes);
  assert.deepEqual((await service.getPoint(1)).longitudes, input.columns.map(column => column[1]));
});

test('startup verifies the complete digest and rejects same-size finite corruption', async t => {
  const input = await fixture(t, 25_000); // Cross the bounded 1 MiB hashing buffer.
  const valid = await createLifetimeArchive(input); await valid.close();
  const corrupted = Buffer.from(input.bytes); corrupted.writeDoubleLE(123.456, corrupted.length - 16);
  await fs.writeFile(input.file, corrupted);
  await assert.rejects(createLifetimeArchive(input), unavailable);
  await fs.writeFile(input.file, input.bytes);
  const restored = await archive(t, input);
  assert.deepEqual((await restored.getPoint(24_998)).longitudes, input.columns.map(column => column[24_998]));
});

test('close waits for all pending positional reads and prevents new requests', async t => {
  const input = await fixture(t), originalOpen = fs.open.bind(fs); let handle;
  t.mock.method(fs, 'open', async (...args) => { const result = await originalOpen(...args); if (args[0] === input.file) handle = result; return result; });
  const service = await archive(t, input), entered = deferred(), release = deferred(), originalRead = handle.read.bind(handle);
  let calls = 0, closed = false;
  t.mock.method(handle, 'read', async (...args) => { if (++calls === LIFETIME_PLANETS.length) entered.resolve(); await release.promise; return originalRead(...args); });
  const point = service.getPoint(8); await entered.promise;
  const closing = service.close(); assert.equal(service.close(), closing);
  closing.then(() => { closed = true; }); await new Promise(setImmediate); assert.equal(closed, false);
  await assert.rejects(service.getPoint(0), unavailable);
  release.resolve(); assert.deepEqual((await point).longitudes, input.columns.map(column => column[8]));
  await closing; assert.equal(closed, true);
});

async function request(service, url, method = 'GET') {
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  const moments = createLifetimeMoments({ archive: service, calculate: async ({ utc }) => ({ ...design(utc), engine: service?.metadata?.source }) });
  await createLifetimeHandler(moments)({ method, url }, res, new URL(url, 'http://localhost'));
  return res;
}
const design = utc => ({ utc, designUtc: new Date(Date.parse(utc) - 88 * 86400000).toISOString().replace('.000Z', 'Z'),
  designArcResidualDegrees: 1e-11, longitudes: LIFETIME_PLANETS.map((_, index) => index * 30 + 0.12345678901234) });

test('HTTP exposes metadata and one complete exact moment, uses no-store and rejects other methods', async t => {
  const input = await fixture(t), service = await archive(t, input);
  const meta = await request(service, '/api/lifetime/meta'), point = await request(service, '/api/lifetime?index=16');
  assert.equal(meta.status, 200); assert.deepEqual(JSON.parse(meta.body), service.metadata);
  const expected = await service.getPoint(16);
  assert.equal(point.status, 200); assert.deepEqual(JSON.parse(point.body), { ...expected, design: design(expected.utc) });
  for (const result of [meta, point]) {
    assert.equal(result.headers['Cache-Control'], 'no-store'); assert.equal(result.headers['Content-Length'], Buffer.byteLength(result.body));
    assert.equal(result.headers['X-Content-Type-Options'], 'nosniff'); assert.equal(result.body.includes(input.file), false);
  }
  for (const method of ['HEAD', 'POST', 'OPTIONS', 'DELETE']) {
    const response = await request(service, '/api/lifetime?index=0', method);
    assert.equal(response.status, 405); assert.equal(response.headers.Allow, 'GET'); assert.equal(response.body, undefined);
  }
});

test('HTTP validates one canonical bounded index and sanitizes unavailable errors', async t => {
  const input = await fixture(t), service = await archive(t, input);
  for (const query of ['', 'index=', 'index=-1', 'index=17', 'index=01', 'index=1.0', 'index=1e0', 'index=+1',
    'index=NaN', 'index=Infinity', 'index=9007199254740993', 'index=0&index=1', 'index=0&file=secret']) {
    assert.equal((await request(service, `/api/lifetime?${query}`)).status, 400, query);
  }
  assert.equal((await request(service, '/api/lifetime/meta?file=secret')).status, 400);
  assert.equal((await request(service, '/api/lifetime/unknown')).status, 404);
  assert.equal((await request(null, '/api/lifetime/meta')).status, 503);
  const failure = await request({ getPoint() { throw new Error('/private/secret ENOENT'); } }, '/api/lifetime?index=0');
  assert.equal(failure.status, 503); assert.deepEqual(JSON.parse(failure.body), { error: 'lifetime_unavailable', message: 'Данные шкалы лет недоступны.' });
});
