import {lifetimeFileFixture as fixture} from './helpers/lifetime-file.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FileHandle } from 'node:fs/promises';
import type { CapturedResponse } from './helpers/http-response.ts';
type MomentOptions = NonNullable<Parameters<typeof createLifetimeMoments>[0]>;
import { captureResponse } from './helpers/http-response.ts';
import { deferred } from './helpers/deferred.ts';
import test from 'node:test';
import { pythonExecutable, pythonEnvironment } from '../server/runtime/python.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createLifetimeFile, createLifetimeMoments } from '../server/services/lifetime.ts';
import * as lifetimeService from '../server/services/lifetime.ts';
import { createLifetimeHandler } from '../server/http/lifetime.ts';
import { createRequestHandler } from '../server/http/app.ts';
import { LIFETIME_PLANETS, LIFETIME_POINT_BYTES } from '../shared/lifetime-format.ts';

async function openLifetime(t: test.TestContext, input: Parameters<typeof createLifetimeFile>[0]) {
  const service = (await createLifetimeFile(input))!; t.after(() => service.close()); return service;
}
const unavailable = (error: { code: string; status: number; message: string|string[]; }) => error.code === 'lifetime_unavailable' && error.status === 503 && !error.message.includes('/');

test('lifetime file is disabled without explicit file configuration', async () => {
  assert.equal(await createLifetimeFile(), null);
  await assert.rejects(createLifetimeFile({ file: '/private/missing' }), unavailable);
});

test('first, middle and last points preserve all Float64 values with public metadata only', async t => {
  const input = await fixture(t), service = await openLifetime(t, input);
  assert.deepEqual(service.metadata, { startUtc: input.metadata.startUtc, endExclusiveUtc: input.metadata.endExclusiveUtc,
    stepSeconds: 600, samples: 17, planets: [...LIFETIME_PLANETS], engine: 'Swiss Ephemeris' });
  for (const index of [0, 8, 16] as const) {
    const point = await service.getPoint(index);
    assert.equal(point.index, index);
    assert.equal(point.utc, new Date(Date.parse(input.metadata.startUtc) + index * 600_000).toISOString().replace('.000Z', 'Z'));
    point.longitudes.forEach((value, column) => assert.ok(Object.is(value, input.columns[column][index])));
    point.design.longitudes.forEach((value, column) => assert.ok(Object.is(value, input.columns[LIFETIME_PLANETS.length + column][index])));
    assert.equal(Date.parse(point.design.designUtc) / 1000, input.columns.at(-2)![index]);
    assert.ok(Object.is(point.design.designArcResidualDegrees, input.columns.at(-1)![index]));
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

test('one hundred prepared points are read again instead of retained after completion', async t => {
  const input = await fixture(t, 144), file = await openLifetime(t, input);
  let reads = 0;
  const service = createLifetimeMoments({ lifetimeFile: { ...file,
    getPoint(index) { reads++; return file.getPoint(index); },
  } })!;
  const first = await Promise.all(Array.from({ length: 100 }, (_, index) => service.getMoment(index)));
  assert.equal(reads, 100);
  const second = await Promise.all(Array.from({ length: 100 }, (_, index) => service.getMoment(index)));
  assert.equal(reads, 200);
  second.forEach((point, index) => { assert.deepEqual(point, first[index]); assert.notEqual(point, first[index]); });
});

test('invalid point indices never become file offsets', async t => {
  const input = await fixture(t), service = await openLifetime(t, input);
  for (const index of [-1, 17, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined] as const) {
    await assert.rejects(service.getPoint(index as number), (error: lifetimeService.LifetimeError) => error.code === 'invalid_index' && error.status === 400);
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
  for (const content of ['not JSON', 'null', '[]', ' '.repeat(16_385)] as const) {
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
  for (const invalid of [NaN, Infinity, -0.1, 360] as const) {
    const broken = Buffer.from(input.bytes); broken.writeDoubleLE(invalid, LIFETIME_POINT_BYTES);
    await fs.writeFile(input.file, broken); await assert.rejects(service.getPoint(1), unavailable);
  }
  for (const [column, invalid] of [[11, NaN], [22, 0.5], [22, 0], [23, -1], [23, 1e-6]] as const) {
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
  const input = await fixture(t), originalOpen = fs.open.bind(fs); let handle!: FileHandle;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => { const result = await originalOpen(...args); if (args[0] === input.file) handle = result; return result; });
  const service = await openLifetime(t, input), entered = deferred(), release = deferred(), originalRead = handle!.read.bind(handle);
  let calls = 0, closed = false;
  t.mock.method(handle!, 'read', async (...args: unknown[]) => { assert.equal(args[2], LIFETIME_POINT_BYTES); assert.equal(args[3], 8 * LIFETIME_POINT_BYTES); if (++calls === 1) entered.resolve!(); await release.promise; return Reflect.apply(originalRead, handle!, args) as ReturnType<typeof originalRead>; });
  const point = service.getPoint(8); await entered.promise;
  const closing = service.close(); assert.equal(service.close(), closing);
  closing.then(() => { closed = true; }); await new Promise(setImmediate); assert.equal(closed, false);
  await assert.rejects(service.getPoint(0), unavailable);
  release.resolve!(); assert.deepEqual((await point).longitudes, input.columns.slice(0, LIFETIME_PLANETS.length).map(column => column[8]));
  await closing; assert.equal(closed, true); assert.equal(calls, 1);
});

async function request(service: Partial<NonNullable<MomentOptions['lifetimeFile']>> | null, url: string, method = 'GET') {
  const res = captureResponse();
  const moments = createLifetimeMoments({ lifetimeFile: service as MomentOptions['lifetimeFile'] })!;
  await createLifetimeHandler(moments && { ...moments, getMetadata: async () => moments.metadata })({ method, url } as IncomingMessage, res, new URL(url, 'http://localhost'));
  return res;
}

test('HTTP exposes metadata and one complete exact moment, uses no-store and rejects other methods', async t => {
  const input = await fixture(t), service = await openLifetime(t, input);
  const meta = await request(service, '/api/lifetime/meta'), point = await request(service, '/api/lifetime?index=16');
  assert.equal(meta.status, 200); assert.deepEqual(JSON.parse(meta.body), service.metadata);
  const expected = await service.getPoint(16);
  assert.equal(point.status, 200); assert.deepEqual(JSON.parse(point.body), expected);
  for (const result of [meta, point] as const) {
    assert.equal(result.headers['Cache-Control'], 'no-store'); assert.equal(result.headers['Content-Length'], Buffer.byteLength(result.body));
    assert.equal(result.headers['X-Content-Type-Options'], 'nosniff'); assert.equal(result.body.includes(input.file), false);
  }
  for (const method of ['HEAD', 'POST', 'OPTIONS', 'DELETE'] as const) {
    const response = await request(service, '/api/lifetime?index=0', method);
    assert.equal(response.status, 405); assert.equal(response.headers.Allow, 'GET'); assert.equal(response.body, undefined);
  }
});

test('HTTP validates one canonical bounded index and sanitizes unavailable errors', async t => {
  const input = await fixture(t), service = await openLifetime(t, input);
  for (const query of ['', 'index=', 'index=-1', 'index=17', 'index=01', 'index=1.0', 'index=1e0', 'index=+1',
    'index=NaN', 'index=Infinity', 'index=9007199254740993', 'index=0&index=1', 'index=0&file=secret'] as const) {
    assert.equal((await request(service, `/api/lifetime?${query}`)).status, 400, query);
  }
  assert.equal((await request(service, '/api/lifetime/meta?file=secret')).status, 400);
  assert.equal((await request(service, '/api/lifetime/unknown')).status, 404);
  assert.equal((await request(null, '/api/lifetime/meta')).status, 503);
  const failure = await request({ getPoint() { throw new Error('/private/secret ENOENT'); } }, '/api/lifetime?index=0');
  assert.equal(failure.status, 503); assert.deepEqual(JSON.parse(failure.body), { error: 'lifetime_unavailable', message: 'Данные летописи недоступны.' });
});

test('real Python file retains format and checksum without calculation markers', async t => {
  const input = await fixture(t), file = path.join(path.dirname(input.file), 'generated.f64le');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)(pythonExecutable(root), ['-m', 'server.python.lifetime_file', '--file', file,
    '--start', '2026-10-02', '--end', '2026-10-03', '--workers', '1'], { cwd: root, env: { ...pythonEnvironment(), PYTHONDONTWRITEBYTECODE: '1' } });
  const metadataFile = file.replace('.f64le', '.metadata.json');
  const service = await openLifetime(t, { file, metadataFile });
  assert.equal(Object.hasOwn(service, 'provenanceVerified'), false);
  const header=JSON.parse(await fs.readFile(metadataFile,'utf8'));
  assert.equal(Object.hasOwn(header,'provenance'),false);assert.equal(header.engine,'Swiss Ephemeris');
  assert.equal((await service.getPoint(75)).utc, '2026-10-02T12:30:00Z');
});


test('a completed lifetime file becomes available on the next request without recreating the service', async t => {
  const input = await fixture(t);
  await fs.unlink(input.metadataFile);
  const service = lifetimeService.createLifetimeService({ file: input.file } as unknown as Parameters<typeof lifetimeService.createLifetimeService>[0]);
  t.after(() => service.close());
  const send = async (url: string|URL) => {
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body: string) { this.body = JSON.parse(body); } } as Omit<CapturedResponse<Record<string, unknown>>, 'end'> & { end(body: string): void };
    await createLifetimeHandler(service)({ method: 'GET' } as IncomingMessage, res as unknown as ServerResponse, new URL(url, 'http://localhost'));
    return res;
  };
  const waiting = await send('/api/lifetime/meta');
  assert.equal(waiting.status, 503);
  assert.equal(waiting.body.error, 'lifetime_preparing');
  assert.equal(waiting.headers['Cache-Control'], 'no-store');
  await fs.unlink(input.file);
  assert.equal((await send('/api/lifetime/meta')).body.error, 'lifetime_preparing');
  await fs.writeFile(input.file, input.bytes);
  assert.equal((await send('/api/lifetime/meta')).body.error, 'lifetime_preparing', 'data without the completion marker must not open');
  await fs.writeFile(input.metadataFile, JSON.stringify(input.metadata));
  const originalOpen = fs.open.bind(fs); let fileOpens = 0;
  t.mock.method(fs, 'open', (...args: Parameters<typeof fs.open>) => { if (args[0] === input.file) fileOpens++; return originalOpen(...args); });
  const replies = await Promise.all([send('/api/lifetime/meta'), send('/api/lifetime/meta')]);
  for (const reply of replies) { assert.equal(reply.status, 200); assert.equal(reply.body.samples, 17); }
  const result = await send('/api/lifetime?index=8');
  assert.equal(result.status, 200);
  assert.equal(result.body.utc, '1900-01-01T01:20:00Z');
  assert.deepEqual(result.body.longitudes, input.columns.slice(0, 11).map(column => column[8]));
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(fileOpens, 1, 'concurrent visitors share validation; ready requests reuse the open file');
});

test('a corrupt lifetime is an error, and a corrected file can be opened by the same service', async t => {
  const input = await fixture(t);
  await fs.writeFile(input.metadataFile, JSON.stringify({ ...input.metadata, sha256: '0'.repeat(64) }));
  const service = lifetimeService.createLifetimeService({ file: input.file });
  t.after(() => service.close());
  await assert.rejects(service.getMetadata(), unavailable);
  await fs.writeFile(input.metadataFile, JSON.stringify(input.metadata));
  assert.equal((await service.getMetadata()).samples, 17);
});


test('closing the service during its first file check closes that handle and rejects further requests', async t => {
  const input = await fixture(t), originalOpen = fs.open.bind(fs);
  let opens = 0, closes = 0;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === input.file) {
      opens++;
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => { closes++; return close(); });
    }
    return handle;
  });
  const service = lifetimeService.createLifetimeService({ file: input.file });
  const opening = assert.rejects(service.getMetadata(), unavailable);
  const closing = service.close();
  assert.equal(service.close(), closing);
  await Promise.all([opening, closing]);
  assert.equal(opens, 1); assert.equal(closes, 1);
  await assert.rejects(service.getMetadata(), unavailable);
  await assert.rejects(service.getMoment(0), unavailable);
  assert.equal(opens, 1, 'closed services cannot reopen files');
});

// The disk reader owns these facts before HTTP turns them into a public error.
test('lifetime journal distinguishes actual damaged data from preparation, bad input and close', async t => {
  const input = await fixture(t), facts: unknown[] = [], report = (fact: unknown) => {facts.push(fact);};
  const reader = (await createLifetimeFile({...input, report}))!;
  await reader.getPoint(0);await assert.rejects(reader.getPoint(-1));
  assert.deepEqual(facts,[]);
  await fs.truncate(input.file,0);
  await assert.rejects(reader.getPoint(0));
  assert.equal(facts.length,1);
  assert.deepEqual({...facts[0] as object,occurredAt:undefined},
    {event:'prepared_data_failed',component:'lifetime',reason:'read',occurredAt:undefined});
  await reader.close();await assert.rejects(reader.getPoint(0));assert.equal(facts.length,1);
  await fs.writeFile(input.metadataFile,'PRIVATE invalid metadata');
  await assert.rejects(createLifetimeFile({...input,report}));assert.equal(facts.length,2);
  assert.equal((facts[1] as {reason:string}).reason,'open');
  await fs.unlink(input.metadataFile);
  await assert.rejects(createLifetimeFile({...input,report}),{code:'lifetime_preparing'});assert.equal(facts.length,2);
  assert.equal(JSON.stringify(facts).includes('PRIVATE'),false);
});


test('a ready lifetime needs only its verified file, never calculation-source fingerprints or version URLs', async t => {
  const input=await fixture(t),originalRead=fs.readFile;let reads:string[]=[];
  t.mock.method(fs,'readFile',(...args:Parameters<typeof fs.readFile>)=>{reads.push(String(args[0]));return Reflect.apply(originalRead,fs,args);});
  const reader=await openLifetime(t,input);
  assert.deepEqual(reads,[input.metadataFile],'opening reads only prepared metadata, not source code or ephemerides');
  assert.equal(Object.hasOwn(reader,'cacheIdentity'),false);
  assert.equal(Object.hasOwn(reader,'provenanceVerified'),false);
  const meta=await request(reader,'/api/lifetime/meta');
  assert.equal(Object.hasOwn(JSON.parse(meta.body),'calculationVersion'),false);
  assert.equal(Object.hasOwn(JSON.parse(meta.body),'cacheVersion'),false);
  const result=await request(reader,'/api/lifetime?index=8');
  assert.equal(result.status,200);assert.deepEqual(JSON.parse(result.body).longitudes,input.columns.slice(0,11).map(column=>column[8]));
  assert.deepEqual(await fs.readFile(input.file),input.bytes);
});
