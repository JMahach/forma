import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createLifetimeFile, createLifetimeMoments } from '../server/services/lifetime.mjs';
import * as lifetimeService from '../server/services/lifetime.mjs';
import { createLifetimeHandler } from '../server/http/lifetime.mjs';
import { createRequestHandler } from '../server/http/app.mjs';
import { LIFETIME_PLANETS, LIFETIME_STEP_SECONDS, LIFETIME_FILE_VERSION, LIFETIME_FILE_FORMAT, LIFETIME_FIELDS, LIFETIME_POINT_BYTES } from '../shared/lifetime-format.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, samples = 17) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-lifetime-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'sample.f64le'), metadataFile = path.join(directory, 'sample.metadata.json');
  const bytes = Buffer.alloc(samples * LIFETIME_POINT_BYTES), start = Date.parse('1900-01-01T00:00:00Z');
  const columns = LIFETIME_PLANETS.map((_, column) => Array.from({ length: samples }, (_, index) => (column * 30 + index / 1024) % 360 + 0.000012345));
  columns[0][0] = 0; columns.at(-1)[samples - 1] = 359.99999999999994;
  columns.push(...LIFETIME_PLANETS.map((_, column) => Array.from({ length: samples }, (_, index) => (column * 30 + index / 2048 + 1) % 360)),
    Array.from({ length: samples }, (_, index) => (start + index * 600000 - 88 * 86400000) / 1000), Array(samples).fill(1e-11));
  columns.forEach((values, column) => values.forEach((value, index) => bytes.writeDoubleLE(value, index * LIFETIME_POINT_BYTES + column * 8)));
  const metadata = { version: LIFETIME_FILE_VERSION, format: LIFETIME_FILE_FORMAT, columns: [...LIFETIME_FIELDS], startUtc: '1900-01-01T00:00:00Z',
    endExclusiveUtc: new Date(start + samples * LIFETIME_STEP_SECONDS * 1000).toISOString().replace('.000Z', 'Z'), stepSeconds: LIFETIME_STEP_SECONDS,
    sampleCount: samples, bytes: bytes.length, flags: 258, engine: 'Swiss Ephemeris 2.10.03', sha256: createHash('sha256').update(bytes).digest('hex'),
    provenance: { version: '1', calculationFingerprint: await lifetimeService.lifetimeFileFingerprint(fileURLToPath(new URL('../', import.meta.url))) } };
  await fs.writeFile(file, bytes); await fs.writeFile(metadataFile, JSON.stringify(metadata));
  return { file, metadataFile, metadata, columns, bytes };
}
async function openLifetime(t, input) {
  const service = await createLifetimeFile(input); t.after(() => service.close()); return service;
}
const unavailable = error => error.code === 'lifetime_unavailable' && error.status === 503 && !error.message.includes('/');

test('lifetime file is disabled without explicit file configuration', async () => {
  assert.equal(await createLifetimeFile(), null);
  await assert.rejects(createLifetimeFile({ file: '/private/missing' }), unavailable);
});

test('first, middle and last points preserve all Float64 values with public metadata only', async t => {
  const input = await fixture(t), service = await openLifetime(t, input);
  assert.deepEqual(service.metadata, { startUtc: input.metadata.startUtc, endExclusiveUtc: input.metadata.endExclusiveUtc,
    stepSeconds: 600, samples: 17, planets: [...LIFETIME_PLANETS], engine: 'Swiss Ephemeris 2.10.03' });
  for (const index of [0, 8, 16]) {
    const point = await service.getPoint(index);
    assert.equal(point.index, index);
    assert.equal(point.utc, new Date(Date.parse(input.metadata.startUtc) + index * 600_000).toISOString().replace('.000Z', 'Z'));
    point.longitudes.forEach((value, column) => assert.ok(Object.is(value, input.columns[column][index])));
    point.design.longitudes.forEach((value, column) => assert.ok(Object.is(value, input.columns[LIFETIME_PLANETS.length + column][index])));
    assert.equal(Date.parse(point.design.designUtc) / 1000, input.columns.at(-2)[index]);
    assert.ok(Object.is(point.design.designArcResidualDegrees, input.columns.at(-1)[index]));
  }
  assert.ok(Object.isFrozen(service.metadata)); assert.ok(Object.isFrozen(service.metadata.planets));
  assert.equal(JSON.stringify(service.metadata).includes(input.file), false);
});

test('concurrent point requests use independent positional reads', async t => {
  const input = await fixture(t), service = await openLifetime(t, input);
  const indices = Array.from({ length: 80 }, (_, index) => index * 7 % 17);
  const points = await Promise.all(indices.map(index => service.getPoint(index)));
  points.forEach((point, request) => assert.deepEqual(point.longitudes, input.columns.slice(0, LIFETIME_PLANETS.length).map(column => column[indices[request]])));
});

test('invalid point indices never become file offsets', async t => {
  const input = await fixture(t), service = await openLifetime(t, input);
  for (const index of [-1, 17, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined]) {
    await assert.rejects(service.getPoint(index), error => error.code === 'invalid_index' && error.status === 400);
  }
});

test('malformed file metadata and mismatched file sizes are rejected', async t => {
  const input = await fixture(t);
  const changes = [
    { version: '1' }, { version: '2' }, { version: undefined }, { format: 'Float32' }, { columns: [...LIFETIME_PLANETS].reverse() },
    { columns: ['north_node', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'] },
    { columns: ['sun', 'north_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'] },
    { columns: [...LIFETIME_PLANETS, 'moon'] }, { sampleCount: 1.5 }, { sampleCount: 0 },
    { stepSeconds: 60 }, { flags: 2 }, { engine: '/private/secret' }, { sha256: 'bad' },
    { bytes: input.bytes.length - 8 }, { startUtc: '1900-02-30T00:00:00Z' },
    { startUtc: '1800-12-31T23:50:00Z' }, { endExclusiveUtc: '1901-01-01T00:00:00Z' },
  ];
  for (const change of changes) {
    await fs.writeFile(input.metadataFile, JSON.stringify({ ...input.metadata, ...change }));
    await assert.rejects(createLifetimeFile(input), unavailable, JSON.stringify(change));
  }
  for (const content of ['not JSON', 'null', '[]', ' '.repeat(16_385)]) {
    await fs.writeFile(input.metadataFile, content); await assert.rejects(createLifetimeFile(input), unavailable);
  }
  await fs.writeFile(input.metadataFile, JSON.stringify(input.metadata));
  const valid = await createLifetimeFile(input); await valid.close();
  await fs.truncate(input.file, input.bytes.length - 1);
  await assert.rejects(createLifetimeFile(input), unavailable);
});

test('short reads and invalid stored moment values fail without exposing filesystem details', async t => {
  const input = await fixture(t), service = await openLifetime(t, input);
  await fs.truncate(input.file, input.bytes.length - 1);
  await assert.rejects(service.getPoint(16), unavailable);
  for (const invalid of [NaN, Infinity, -0.1, 360]) {
    const broken = Buffer.from(input.bytes); broken.writeDoubleLE(invalid, LIFETIME_POINT_BYTES);
    await fs.writeFile(input.file, broken); await assert.rejects(service.getPoint(1), unavailable);
  }
  for (const [column, invalid] of [[11, NaN], [22, 0.5], [22, 0], [23, -1], [23, 1e-6]]) {
    const broken = Buffer.from(input.bytes); broken.writeDoubleLE(invalid, LIFETIME_POINT_BYTES + column * 8);
    await fs.writeFile(input.file, broken); await assert.rejects(service.getPoint(1), unavailable);
  }
  await fs.writeFile(input.file, input.bytes);
  assert.deepEqual((await service.getPoint(1)).longitudes, input.columns.slice(0, LIFETIME_PLANETS.length).map(column => column[1]));
});

test('startup verifies the complete digest and rejects same-size finite corruption', async t => {
  const input = await fixture(t, 25_000); // Cross the bounded 1 MiB hashing buffer.
  const valid = await createLifetimeFile(input); await valid.close();
  const corrupted = Buffer.from(input.bytes); corrupted.writeDoubleLE(123.456, corrupted.length - 16);
  await fs.writeFile(input.file, corrupted);
  await assert.rejects(createLifetimeFile(input), unavailable);
  await fs.writeFile(input.file, input.bytes);
  const restored = await openLifetime(t, input);
  assert.deepEqual((await restored.getPoint(24_998)).longitudes, input.columns.slice(0, LIFETIME_PLANETS.length).map(column => column[24_998]));
});

test('close waits for all pending positional reads and prevents new requests', async t => {
  const input = await fixture(t), originalOpen = fs.open.bind(fs); let handle;
  t.mock.method(fs, 'open', async (...args) => { const result = await originalOpen(...args); if (args[0] === input.file) handle = result; return result; });
  const service = await openLifetime(t, input), entered = deferred(), release = deferred(), originalRead = handle.read.bind(handle);
  let calls = 0, closed = false;
  t.mock.method(handle, 'read', async (...args) => { assert.equal(args[2], LIFETIME_POINT_BYTES); assert.equal(args[3], 8 * LIFETIME_POINT_BYTES); if (++calls === 1) entered.resolve(); await release.promise; return originalRead(...args); });
  const point = service.getPoint(8); await entered.promise;
  const closing = service.close(); assert.equal(service.close(), closing);
  closing.then(() => { closed = true; }); await new Promise(setImmediate); assert.equal(closed, false);
  await assert.rejects(service.getPoint(0), unavailable);
  release.resolve(); assert.deepEqual((await point).longitudes, input.columns.slice(0, LIFETIME_PLANETS.length).map(column => column[8]));
  await closing; assert.equal(closed, true); assert.equal(calls, 1);
});

async function request(service, url, method = 'GET') {
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  const moments = createLifetimeMoments({ lifetimeFile: service, calculate() { throw Error('Grid must never calculate'); } });
  await createLifetimeHandler(moments)({ method, url }, res, new URL(url, 'http://localhost'));
  return res;
}

test('HTTP exposes metadata and one complete exact moment, uses no-store and rejects other methods', async t => {
  const input = await fixture(t), service = await openLifetime(t, input);
  const meta = await request(service, '/api/lifetime/meta'), point = await request(service, '/api/lifetime?index=16');
  assert.equal(meta.status, 200); assert.deepEqual(JSON.parse(meta.body), service.metadata);
  const expected = await service.getPoint(16);
  assert.equal(point.status, 200); assert.deepEqual(JSON.parse(point.body), expected);
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
  const input = await fixture(t), service = await openLifetime(t, input);
  for (const query of ['', 'index=', 'index=-1', 'index=17', 'index=01', 'index=1.0', 'index=1e0', 'index=+1',
    'index=NaN', 'index=Infinity', 'index=9007199254740993', 'index=0&index=1', 'index=0&file=secret']) {
    assert.equal((await request(service, `/api/lifetime?${query}`)).status, 400, query);
  }
  assert.equal((await request(service, '/api/lifetime/meta?file=secret')).status, 400);
  assert.equal((await request(service, '/api/lifetime/unknown')).status, 404);
  assert.equal((await request(null, '/api/lifetime/meta')).status, 503);
  const failure = await request({ getPoint() { throw new Error('/private/secret ENOENT'); } }, '/api/lifetime?index=0');
  assert.equal(failure.status, 503); assert.deepEqual(JSON.parse(failure.body), { error: 'lifetime_unavailable', message: 'Данные летописи недоступны.' });
});

async function versionedHandler(t, input, fingerprint = 'a'.repeat(64)) {
  const source = await openLifetime(t, input), reads = [];
  const handler = createRequestHandler({ root: '/unused', lifetime: { ...source,
    getPoint(index) { reads.push(index); return source.getPoint(index); } }, lifetimeFingerprint: fingerprint,
    calculate() { throw Error('Grid must never calculate'); }, publicFiles() { throw Error('unexpected static'); } });
  const send = async url => {
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
    await handler({ method: 'GET', url, headers: { host: 'localhost' } }, res);
    return res;
  };
  const meta = await send('/api/lifetime/meta');
  return { send, meta, version: JSON.parse(meta.body).cacheVersion, reads };
}

test('only a matching complete-moment version gets immutable HTTP caching', async t => {
  const input = await fixture(t), { send, meta, version, reads } = await versionedHandler(t, input);
  assert.match(version, /^[a-f0-9]{64}$/);
  assert.equal(meta.headers['Cache-Control'], 'no-store');
  const first = await send(`/api/lifetime?index=2&v=${version}`), repeat = await send(`/api/lifetime?index=2&v=${version}`);
  assert.equal(first.status, 200); assert.equal(repeat.body, first.body);
  assert.equal(first.headers['Cache-Control'], 'public, max-age=31536000, immutable');
  assert.deepEqual(reads, [2]);
  assert.equal((await send('/api/lifetime?index=2')).headers['Cache-Control'], 'no-store');
  for (const query of [`index=3&v=${'b'.repeat(64)}`, 'index=3&v=', 'index=3&v=bad',
    `index=3&v=${version.toUpperCase()}`, `index=3&v=${version}&v=${version}`, `index=3&v=${version}&extra=1`]) {
    const result = await send(`/api/lifetime?${query}`);
    assert.equal(result.status, 400, query); assert.equal(result.headers['Cache-Control'], 'no-store');
  }
  assert.deepEqual(reads, [2], 'stale and malformed versions do not read or publish a point');
  const invalid = await send(`/api/lifetime?index=17&v=${version}`);
  assert.equal(invalid.status, 400); assert.equal(invalid.headers['Cache-Control'], 'no-store');
  await fs.truncate(input.file, 0);
  const failure = await send(`/api/lifetime?index=3&v=${version}`);
  assert.equal(failure.status, 503); assert.equal(failure.headers['Cache-Control'], 'no-store');
});

test('moment versions bind verified file bytes, index-to-UTC metadata and calculation inputs', async t => {
  const input = await fixture(t), first = await versionedHandler(t, input);
  assert.match(first.version, /^[a-f0-9]{64}$/);
  assert.equal((await versionedHandler(t, input)).version, first.version);
  assert.notEqual((await versionedHandler(t, input, 'b'.repeat(64))).version, first.version);
  const shifted = { ...input.metadata, startUtc: '1900-01-02T00:00:00Z',
    endExclusiveUtc: new Date(Date.parse(input.metadata.endExclusiveUtc) + 86400000).toISOString().replace('.000Z', 'Z') };
  await fs.writeFile(input.metadataFile, JSON.stringify(shifted));
  const changedMetadata = await versionedHandler(t, input);
  assert.notEqual(changedMetadata.version, first.version, 'same bytes at another UTC origin must never share immutable URLs');
  const stale = await changedMetadata.send(`/api/lifetime?index=0&v=${first.version}`);
  assert.equal(stale.status, 400); assert.equal(stale.headers['Cache-Control'], 'no-store');
  assert.deepEqual(changedMetadata.reads, []);
  const changed = Buffer.from(input.bytes); changed.writeDoubleLE(42, 0);
  await fs.writeFile(input.file, changed);
  await fs.writeFile(input.metadataFile, JSON.stringify({ ...input.metadata, sha256: createHash('sha256').update(changed).digest('hex') }));
  assert.notEqual((await versionedHandler(t, input)).version, first.version);
});

test('calculation fingerprints follow exact inputs but ignore paths, timestamps and interface files', async t => {
  assert.equal(typeof lifetimeService.lifetimeCalculationFingerprint, 'function');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-moment-fingerprint-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const names = ['server/python/astronomy.py', 'server/python/civil_time.py', 'server/python/errors.py',
    'server/python/calculator.py', 'requirements.txt',
    'shared/lifetime-format.js', 'shared/day-packets/moment-columns.js', 'server/services/lifetime.mjs', 'data/ephe/sepl_18.se1', 'data/ephe/semo_18.se1', 'data/ephe/seas_18.se1'];
  for (const name of names) {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.copyFile(new URL(`../${name}`, import.meta.url), path.join(directory, name));
  }
  const fingerprint = () => lifetimeService.lifetimeCalculationFingerprint(directory);
  const original = await fingerprint(); assert.match(original, /^[a-f0-9]{64}$/);
  assert.equal(await lifetimeService.lifetimeCalculationFingerprint(fileURLToPath(new URL('../', import.meta.url))), original);
  for (const name of names) {
    const file = path.join(directory, name), before = await fs.readFile(file), stat = await fs.stat(file);
    const changed = Buffer.from(before); changed[0] ^= 1;
    await fs.writeFile(file, changed); await fs.utimes(file, stat.atime, stat.mtime);
    assert.notEqual(await fingerprint(), original, `${name}: same-sized changed inputs invalidate the revision`);
    await fs.writeFile(file, before);
  }
  await fs.mkdir(path.join(directory, 'src')); await fs.writeFile(path.join(directory, 'src/app.js'), 'interface update');
  assert.equal(await fingerprint(), original, 'an interface deployment leaves astronomical URLs reusable');
});

test('full file provenance is required and must match current calculation inputs', async t => {
  const input = await fixture(t), verified = await openLifetime(t, input);
  assert.equal(verified.provenanceVerified, true);
  const calculationFingerprint = input.metadata.provenance.calculationFingerprint;
  for (const invalid of [undefined, null, {}, { version: '2', calculationFingerprint }, { version: '1', calculationFingerprint: '0'.repeat(64) }]) {
    await fs.writeFile(input.metadataFile, JSON.stringify({ ...input.metadata, provenance: invalid }));
    await assert.rejects(createLifetimeFile(input), unavailable);
  }
});

test('real Python file provenance is accepted by the Node startup verifier', async t => {
  const input = await fixture(t), file = path.join(path.dirname(input.file), 'generated.f64le');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)(path.join(root, '.venv/bin/python'), ['-m', 'server.python.lifetime_file', '--file', file,
    '--start', '2026-10-02', '--end', '2026-10-03', '--workers', '1'], { cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  const metadataFile = file.replace('.f64le', '.metadata.json');
  const service = await openLifetime(t, { file, metadataFile });
  assert.equal(service.provenanceVerified, true);
  assert.equal((await service.getPoint(75)).utc, '2026-10-02T12:30:00Z');
});


test('optional ephemeris input presence and bytes invalidate file provenance and exact URLs in both languages', async t => {
  const input = await fixture(t), directory = path.dirname(input.file), root = fileURLToPath(new URL('../', import.meta.url));
  for (const name of ['server/python', 'server/services/lifetime.mjs', 'requirements.txt', 'shared', 'data/ephe']) {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.cp(path.join(root, name), path.join(directory, name), { recursive: true });
  }
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util');
  async function fingerprints() {
    const fileFingerprint = await lifetimeService.lifetimeFileFingerprint(directory);
    const { stdout } = await promisify(execFile)(path.join(root, '.venv/bin/python'), ['-B', '-c',
      'from server.python.lifetime_file import calculation_fingerprint; print(calculation_fingerprint())'], { cwd: directory });
    assert.equal(stdout.trim(), fileFingerprint, 'Python preparation and Node verification use identical names, ordering and bytes');
    return [fileFingerprint, await lifetimeService.lifetimeCalculationFingerprint(directory)];
  }
  const original = await fingerprints();
  await fs.writeFile(input.metadataFile, JSON.stringify({ ...input.metadata, provenance: { version: '1', calculationFingerprint: original[0] } }));
  const verified = await createLifetimeFile({ ...input, root: directory });
  assert.equal(verified.provenanceVerified, true); await verified.close();
  const optional = path.join(directory, 'data/ephe/seleapsec.txt');
  let before = original;
  for (const contents of ['', '20261231\n', '20271231\n']) {
    await fs.writeFile(optional, contents);
    const changed = await fingerprints();
    changed.forEach((value, index) => assert.notEqual(value, before[index], 'new or changed optional bytes cannot reuse a numerical revision'));
    await assert.rejects(createLifetimeFile({ ...input, root: directory }), unavailable);
    before = changed;
  }
  await fs.unlink(optional);
  assert.deepEqual(await fingerprints(), original, 'removal restores the original complete input set');
  const restored = await createLifetimeFile({ ...input, root: directory }); await restored.close();
  const nested = path.join(directory, 'data/ephe/extra');
  await fs.mkdir(nested);
  // Deliberately create these in reverse byte order. Empty contents still bind the file name.
  await fs.writeFile(path.join(nested, '💫.txt'), ''); await fs.writeFile(path.join(nested, 'я.txt'), '');
  const withNested = await fingerprints();
  withNested.forEach((value, index) => assert.notEqual(value, original[index], 'all ephemeris directory files participate, including nested names'));
  await assert.rejects(createLifetimeFile({ ...input, root: directory }), unavailable);
  await fs.rm(nested, { recursive: true });
  assert.deepEqual(await fingerprints(), original);
});
