import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLifetimeMoments } from '../server/services/lifetime.mjs';
import { createCalculator } from '../server/services/calculate.mjs';
import { createRequestHandler } from '../server/http/app.mjs';
import { LIFETIME_PLANETS } from '../shared/lifetime-format.js';

const metadata = { startUtc: '2026-09-30T00:00:00Z', endExclusiveUtc: '2026-10-01T00:00:00Z',
  stepSeconds: 600, samples: 144, planets: LIFETIME_PLANETS, source: 'Swiss Ephemeris 2.10.03' };
const utcAt = index => new Date(Date.parse(metadata.startUtc) + index * 600000).toISOString().replace('.000Z', 'Z');
const point = index => ({ index, utc: utcAt(index), longitudes: LIFETIME_PLANETS.map((_, column) => column * 30 + index / 1024) });
const design = utc => ({ utc, designUtc: new Date(Date.parse(utc) - 88 * 86400000).toISOString().replace('.000Z', 'Z'),
  designArcResidualDegrees: 1e-11, longitudes: LIFETIME_PLANETS.map((_, column) => column * 30 + 0.123456789012345) });
const calculatedDesign = utc => ({ ...design(utc), engine: metadata.source });
const archive = { metadata, getPoint: async index => point(index) };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(setImmediate);
const busy = error => error.code === 'busy' && error.status === 503;
const unavailable = error => error.code === 'lifetime_unavailable' && error.status === 503;

async function httpRequest(handler, url) {
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(body) { this.body = body; } };
  await handler({ method: 'GET', url, headers: { host: 'localhost' } }, res);
  return { status: res.status, value: JSON.parse(res.body) };
}

test('five duplicate HTTP moments share one calculator process and reuse its completed Design', async t => {
  const workers = [], reads = [];
  const calculate = createCalculator({ root: '/unused', spawnWorker() {
    const worker = new EventEmitter(); worker.stdout = new EventEmitter(); worker.stdout.setEncoding = () => {};
    worker.stdin = new EventEmitter(); worker.stdin.write = text => { worker.input = JSON.parse(text); };
    worker.kill = () => worker.emit('close', null);
    workers.push(worker); return worker;
  } });
  t.after(() => calculate.close());
  const handler = createRequestHandler({ root: '/unused', calculate, lifetime: { metadata, getPoint: async index => { reads.push(index); return point(index); } },
    publicFiles: async () => { throw new Error('unexpected static request'); } });
  const requests = Array.from({ length: 5 }, () => httpRequest(handler, '/api/lifetime?index=3'));
  await tick();
  assert.equal(workers.length, 1); assert.deepEqual(reads, [3]);
  assert.deepEqual(workers[0].input, { id: 1, utc: utcAt(3) });
  workers[0].stdout.emit('data', JSON.stringify({ id: workers[0].input.id, result: calculatedDesign(utcAt(3)) }) + '\n');
  const results = await Promise.all(requests);
  assert.deepEqual(results.map(result => result.status), [200, 200, 200, 200, 200]);
  results.forEach(result => assert.deepEqual(result.value, { ...point(3), design: design(utcAt(3)) }));
  await httpRequest(handler, '/api/lifetime?index=3');
  assert.equal(workers.length, 1, 'later moments reuse the completed Design without starting another process');
  assert.deepEqual(reads, [3], 'the complete moment also reuses its eleven stored longitudes');
});

test('complete moments share the Design object and the same bounded LRU budget', async () => {
  const reads = [], calls = [];
  const service = createLifetimeMoments({ capacity: 2,
    archive: { metadata, getPoint(index) { reads.push(index); return point(index); } },
    calculate({ utc }) { calls.push(utc); return calculatedDesign(utc); } });
  const first = await service.getMoment(0);
  assert.equal(first.design, await service.getDesign(utcAt(0)));
  assert.equal(first, await service.getMoment(0));
  assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.longitudes));
  await service.getMoment(1); await service.getMoment(0); await service.getDesign(utcAt(2));
  assert.equal(await service.getMoment(0), first, 'a Design-only entry shares the complete-moment capacity');
  await service.getMoment(1);
  assert.deepEqual(reads, [0, 1, 1]);
  assert.deepEqual(calls, [utcAt(0), utcAt(1), utcAt(2), utcAt(1)]);
});

test('Design LRU is bounded, aliases share entries, immutable results and new services do not share caches', async () => {
  const calls = [], originals = [];
  const calculate = async ({ utc }) => { calls.push(utc); const value = calculatedDesign(utc); originals.push(value); return value; };
  const service = createLifetimeMoments({ archive, calculate, capacity: 2 });
  const first = await service.getDesign(utcAt(0));
  originals[0].longitudes[0] = 200;
  assert.equal(first.longitudes[0], 0.123456789012345);
  assert.throws(() => { first.longitudes[0] = 100; }, TypeError);
  await service.getDesign(utcAt(1));
  assert.equal(await service.getDesign(utcAt(0).replace('Z', '.000Z')), first);
  await service.getDesign(utcAt(2)); await service.getDesign(utcAt(1));
  assert.deepEqual(calls, [utcAt(0), utcAt(1), utcAt(2), utcAt(1)], 'touching zero evicts one, not zero');
  await createLifetimeMoments({ archive, calculate }).getDesign(utcAt(0));
  assert.equal(calls.length, 5, 'new calculator owner starts with an empty cache');
});

test('failed or malformed Design results release admission and are never cached', async () => {
  const utc = utcAt(0);
  for (const failure of [undefined, { error: 'busy' }, { error: 'timeout', message: '/private/error' },
    new Error('/private/error'), { ...calculatedDesign(utc), utc: utcAt(1) }, { ...calculatedDesign(utc), designUtc: utc },
    { ...calculatedDesign(utc), designUtc: '1801-01-01T00:00:00Z' }, { ...calculatedDesign(utc), designArcResidualDegrees: -1 },
    { ...calculatedDesign(utc), designArcResidualDegrees: 1e-6 }, { ...calculatedDesign(utc), longitudes: [1] },
    { ...calculatedDesign(utc), longitudes: Array(11).fill(Infinity) }]) {
    let calls = 0;
    const service = createLifetimeMoments({ archive, maxPending: 1, calculate: async () => {
      calls++; if (calls > 1) return calculatedDesign(utc); if (failure instanceof Error) throw failure; return failure;
    } });
    await assert.rejects(service.getDesign(utc), error => (busy(error) || unavailable(error)) && !error.message.includes('/private'));
    assert.deepEqual(await service.getDesign(utc), design(utc));
    await service.getDesign(utc);
    assert.equal(calls, 2);
  }
});

test('distinct pending Design work is bounded while duplicate requests remain admissible', async () => {
  const calls = [];
  const service = createLifetimeMoments({ archive, maxPending: 2, calculate: ({ utc }) => {
    const pending = deferred(); calls.push({ utc, ...pending }); return pending.promise;
  } });
  const first = service.getDesign(utcAt(0)), second = service.getDesign(utcAt(1));
  const duplicate = service.getDesign(utcAt(0));
  await assert.rejects(service.getDesign(utcAt(2)), busy);
  assert.equal(calls.length, 2);
  calls[0].resolve(calculatedDesign(utcAt(0))); await first; await duplicate;
  const third = service.getDesign(utcAt(2)); await tick();
  assert.equal(calls.length, 3);
  calls[1].resolve(calculatedDesign(utcAt(1))); calls[2].resolve(calculatedDesign(utcAt(2))); await Promise.all([second, third]);
});

test('missing or different Design engines never publish or cache a mixed archive moment', async () => {
  for (const engine of [undefined, 'Swiss Ephemeris 2.9.0']) {
    let calls = 0;
    const service = createLifetimeMoments({ archive, maxPending: 1, calculate: async ({ utc }) => {
      calls++;
      return calls === 1 ? { ...calculatedDesign(utc), engine } : calculatedDesign(utc);
    } });
    await assert.rejects(service.getMoment(0), unavailable);
    assert.deepEqual(await service.getMoment(0), { ...point(0), design: design(utcAt(0)) });
    await service.getMoment(0);
    assert.equal(calls, 2, 'a mismatched result is retried; the compatible result is cached');
  }
});

test('one exact moment starts archive and Design together and publishes neither side alone', async () => {
  const black = deferred(), red = deferred(), started = [];
  const service = createLifetimeMoments({ archive: { metadata, getPoint(index) { started.push(['black', index]); return black.promise; } },
    calculate({ utc }) { started.push(['red', utc]); return red.promise; } });
  let resolved = false;
  const pending = service.getMoment(5).then(value => { resolved = true; return value; });
  await tick();
  assert.deepEqual(started, [['black', 5], ['red', utcAt(5)]]);
  red.resolve(calculatedDesign(utcAt(5))); await tick(); assert.equal(resolved, false);
  black.resolve(point(5));
  const result = await pending;
  assert.deepEqual(result, { ...point(5), design: design(utcAt(5)) });
  assert.equal(result.utc, result.design.utc);
  result.longitudes.forEach((value, column) => assert.ok(Object.is(value, point(5).longitudes[column])));
});

test('a failing half keeps moment admission until both operations settle, then permits retry', async () => {
  const black = deferred(), red = deferred(); let reads = 0;
  const service = createLifetimeMoments({ maxPending: 1, archive: { metadata, getPoint(index) { reads++; return reads === 1 ? black.promise : point(index); } },
    calculate: () => red.promise });
  const pending = service.getMoment(0);
  black.reject(new Error('read failed')); await tick();
  await assert.rejects(service.getMoment(1), busy);
  assert.equal(reads, 1);
  red.resolve(calculatedDesign(utcAt(0)));
  await assert.rejects(pending, /read failed/);
  assert.deepEqual(await service.getMoment(0), { ...point(0), design: design(utcAt(0)) });
});

test('mismatched or corrupt archive halves never produce a combined moment', async () => {
  for (const broken of [{ ...point(0), index: 1 }, { ...point(0), utc: utcAt(1) }, { ...point(0), longitudes: Array(11).fill(NaN) }]) {
    const service = createLifetimeMoments({ archive: { metadata, getPoint: async () => broken }, calculate: async ({ utc }) => calculatedDesign(utc) });
    await assert.rejects(service.getMoment(0), unavailable);
  }
});

test('invalid archive indices and UTC requests never read the archive or start calculation', async () => {
  let calls = 0;
  const service = createLifetimeMoments({ archive: { metadata, getPoint() { calls++; } }, calculate() { calls++; } });
  for (const index of [-1, 144, 1.5, NaN, Infinity, '1', null]) {
    await assert.rejects(service.getMoment(index), error => error.code === 'invalid_index');
  }
  for (const utc of ['2026-02-30T00:00:00Z', '2026-09-30', '1800-12-31T23:59:59Z', '2400-01-01T00:00:00Z']) {
    await assert.rejects(service.getDesign(utc));
  }
  assert.equal(calls, 0);
});
