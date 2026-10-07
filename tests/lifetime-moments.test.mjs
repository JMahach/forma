import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifetimeMoments } from '../server/services/lifetime.mjs';
import { createRequestHandler } from '../server/http/app.mjs';
import { LIFETIME_PLANETS } from '../shared/lifetime-format.js';

const metadata = { startUtc: '2026-09-30T00:00:00Z', endExclusiveUtc: '2026-10-01T00:00:00Z',
  stepSeconds: 600, samples: 144, planets: LIFETIME_PLANETS, engine: 'Swiss Ephemeris 2.10.03' };
const utcAt = index => new Date(Date.parse(metadata.startUtc) + index * 600000).toISOString().replace('.000Z', 'Z');
const design = utc => ({ utc, designUtc: new Date(Date.parse(utc) - 88 * 86400000).toISOString().replace('.000Z', 'Z'),
  designArcResidualDegrees: 1e-11, longitudes: LIFETIME_PLANETS.map((_, column) => column * 30 + 0.123456789012345) });
const point = index => ({ index, utc: utcAt(index), longitudes: LIFETIME_PLANETS.map((_, column) => column * 30 + index / 1024), design: design(utcAt(index)) });
const lifetimeFile = { metadata, getPoint: async index => point(index) };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(setImmediate);
const busy = error => error.code === 'busy' && error.status === 503;
const unavailable = error => error.code === 'lifetime_unavailable' && error.status === 503;
const neverCalculate = () => { throw Error('Grid must never calculate'); };

async function httpRequest(handler, url) {
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(body) { this.body = body; } };
  await handler({ method: 'GET', url, headers: { host: 'localhost' } }, res);
  return { status: res.status, value: JSON.parse(res.body) };
}

test('cold full grid point is served without invoking the calculator', async () => {
  const service = createLifetimeMoments({ lifetimeFile, calculate: neverCalculate });
  assert.deepEqual(await service.getMoment(0), point(0));
});

test('five duplicate HTTP moments share one complete file read with no calculator', async () => {
  const reads = [], pending = deferred();
  const handler = createRequestHandler({ root: '/unused', calculate: neverCalculate,
    lifetime: { metadata, getPoint(index) { reads.push(index); return pending.promise; } },
    publicFiles: async () => { throw new Error('unexpected static request'); } });
  const requests = Array.from({ length: 5 }, () => httpRequest(handler, '/api/lifetime?index=3'));
  await tick(); assert.deepEqual(reads, [3]); pending.resolve(point(3));
  const results = await Promise.all(requests);
  results.forEach(result => { assert.equal(result.status, 200); assert.deepEqual(result.value, point(3)); });
  await httpRequest(handler, '/api/lifetime?index=3'); assert.deepEqual(reads, [3]);
});

test('full moments use a bounded LRU and immutable snapshots, aliases share entries', async () => {
  const reads = [], originals = [];
  const service = createLifetimeMoments({ capacity: 2, calculate: neverCalculate,
    lifetimeFile: { metadata, getPoint(index) { reads.push(index); const value = point(index); originals.push(value); return value; } } });
  const first = await service.getMoment(0);
  originals[0].longitudes[0] = 200; originals[0].design.longitudes[0] = 200;
  assert.deepEqual(first, point(0));
  assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.longitudes));
  assert.ok(Object.isFrozen(first.design)); assert.ok(Object.isFrozen(first.design.longitudes));
  await service.getMoment(1);
  assert.equal(await service.getUtcMoment(utcAt(0).replace('Z', '.000Z')), first);
  await service.getMoment(2); await service.getMoment(1);
  assert.deepEqual(reads, [0, 1, 2, 1]);
  const fresh = createLifetimeMoments({ lifetimeFile, calculate: neverCalculate });
  assert.notEqual(await fresh.getMoment(0), first);
});

test('pending grid reads are bounded and duplicates share admission', async () => {
  const jobs = [];
  const service = createLifetimeMoments({ maxPending: 2, calculate: neverCalculate,
    lifetimeFile: { metadata, getPoint(index) { const pending = deferred(); jobs.push({ index, ...pending }); return pending.promise; } } });
  const first = service.getMoment(0), second = service.getMoment(1), same = service.getMoment(0);
  await assert.rejects(service.getMoment(2), busy);
  assert.equal(jobs.length, 2);
  jobs[0].resolve(point(0)); assert.equal(await first, await same);
  const third = service.getMoment(2); await tick(); assert.equal(jobs.length, 3);
  jobs[1].resolve(point(1)); jobs[2].resolve(point(2)); await Promise.all([second, third]);
});

test('failed or malformed full points are never cached and release admission', async () => {
  const base = point(0);
  for (const broken of [undefined, new Error('/private/path'), { ...base, index: 1 }, { ...base, utc: utcAt(1) },
    { ...base, longitudes: Array(11).fill(NaN) }, { ...base, design: undefined },
    { ...base, design: { ...base.design, designUtc: base.utc } },
    { ...base, design: { ...base.design, designArcResidualDegrees: 1e-6 } },
    { ...base, design: { ...base.design, longitudes: Array(11).fill(Infinity) } }]) {
    let reads = 0;
    const service = createLifetimeMoments({ maxPending: 1, calculate: neverCalculate,
      lifetimeFile: { metadata, getPoint() { if (++reads > 1) return base; if (broken instanceof Error) throw broken; return broken; } } });
    await assert.rejects(service.getMoment(0), error => unavailable(error) && !error.message.includes('/private'));
    assert.deepEqual(await service.getMoment(0), base); await service.getMoment(0); assert.equal(reads, 2);
  }
});

test('invalid indices and UTC never read or calculate', async () => {
  let calls = 0;
  const service = createLifetimeMoments({ lifetimeFile: { metadata, getPoint() { calls++; } }, calculate() { calls++; } });
  for (const index of [-1, 144, 1.5, NaN, Infinity, '1', null]) {
    await assert.rejects(service.getMoment(index), error => error.code === 'invalid_index');
  }
  for (const utc of ['2026-02-30T00:00:00Z', '2026-09-30', '1800-12-31T23:59:59Z', '2400-01-01T00:00:00Z']) {
    await assert.rejects(service.getUtcMoment(utc));
  }
  assert.equal(calls, 0);
});
