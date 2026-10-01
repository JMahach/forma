import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCalculator, CALCULATOR_LIMITS } from '../server/services/calculate.mjs';

const tick = () => new Promise(setImmediate);
const utc = '2026-09-30T12:34:56Z';
const input = { mode: 'transit_design', utc };
const point = value => ({ utc: value, designUtc: '2026-07-04T12:34:56Z',
  designArcResidualDegrees: 1e-11, longitudes: Array.from({ length: 11 }, (_, i) => i * 30 + 0.12345678901234) });

function harness(t, { capacity = 4, timeoutMs = 1000, idleMs = 30_000, spawnFailure = false, missingPid = false } = {}) {
  const workers = [];
  const calculate = createCalculator({ root: '/unused', limits: { ...CALCULATOR_LIMITS, concurrency: capacity, timeoutMs }, idleMs,
    spawnWorker(_python, [script]) {
      if (spawnFailure) throw new Error('spawn unavailable');
      const worker = new EventEmitter(); if (!missingPid) worker.pid = workers.length + 1; worker.script = script;
      worker.stdout = new EventEmitter(); worker.stdout.setEncoding = () => {};
      worker.stdin = new EventEmitter(); worker.inputs = [];
      worker.stdin.write = worker.stdin.end = line => worker.inputs.push(JSON.parse(line));
      worker.kill = () => { worker.killed = true; };
      worker.respond = (value = point(worker.inputs.at(-1).utc), id = worker.inputs.at(-1).id) => {
        worker.stdout.emit('data', JSON.stringify({ id, result: value }) + '\n');
      };
      workers.push(worker); return worker;
    } });
  t.after(async () => {
    const closed = calculate.close();
    workers.forEach(worker => worker.emit('close', null));
    await closed;
  });
  return { calculate, workers };
}

test('Design sessions start lazily, reuse one worker, frame fragments and keep identity per request', async t => {
  const { calculate, workers } = harness(t);
  assert.equal(workers.length, 0);
  const first = calculate(input);
  assert.ok(workers[0].script.endsWith('/design_worker.py'));
  assert.deepEqual(workers[0].inputs, [{ id: 1, utc }]);
  let completed = false; first.then(() => { completed = true; });
  const frame = JSON.stringify({ id: 1, result: point(utc) }) + '\n';
  workers[0].stdout.emit('data', frame.slice(0, 20)); await tick();
  assert.equal(completed, false);
  workers[0].stdout.emit('data', frame.slice(20));
  assert.deepEqual(await first, point(utc));
  const secondUtc = '1801-01-01T00:00:00Z';
  const second = calculate({ ...input, utc: secondUtc });
  assert.equal(workers.length, 1);
  assert.deepEqual(workers[0].inputs[1], { id: 2, utc: secondUtc });
  workers[0].respond(); assert.deepEqual(await second, point(secondUtc));
});

test('four physical slots are shared; scalar replacement waits for the idle Design process to close', async t => {
  const { calculate, workers } = harness(t);
  const requests = [calculate(input), calculate(input), calculate({ mode: 'transit' }), calculate({ mode: 'natal' })];
  assert.equal(workers.length, 4);
  assert.ok(workers.every(worker => worker.inputs.length === 1), 'one in-flight request per worker');
  assert.equal((await calculate(input)).error, 'busy');
  workers[0].respond(); await requests[0];
  const scalar = calculate({ mode: 'transit' });
  assert.equal(workers[0].killed, true);
  assert.equal(workers.length, 4, 'kill alone does not release a physical process slot');
  assert.equal((await calculate(input)).error, 'busy');
  workers[0].emit('close', null); await tick();
  assert.equal(workers.length, 5);
  assert.ok(workers[4].script.endsWith('/calculator.py'));
  workers[1].respond();
  for (const worker of [workers[2], workers[3], workers[4]]) {
    worker.stdout.emit('data', '{"chart":{}}'); worker.emit('close', 0);
  }
  assert.deepEqual(await scalar, { chart: {} }); await Promise.all(requests);
});

test('corrupt, oversized and misidentified output is killed and cannot release or poison the next session', async t => {
  const badFrames = [
    worker => worker.stdout.emit('data', '{invalid}\n'),
    worker => worker.respond(point(utc), 999),
    worker => worker.respond(point('2026-09-30T12:35:56Z')),
    worker => worker.respond({ ...point(utc), longitudes: [1] }),
    worker => worker.stdout.emit('data', JSON.stringify({ id: 1, result: point(utc) }) + '\n\n'),
    worker => worker.stdout.emit('data', 'x'.repeat(8193)),
    worker => worker.stdin.emit('error', new Error('pipe')),
    worker => worker.stdout.emit('error', new Error('pipe')),
    worker => worker.emit('error', new Error('live process failure')),
  ];
  for (const corrupt of badFrames) {
    const { calculate, workers } = harness(t, { capacity: 1 });
    const pending = calculate(input); let settled = false; pending.then(() => { settled = true; });
    corrupt(workers[0]); await tick();
    assert.equal(workers[0].killed, true); assert.equal(settled, false);
    assert.equal((await calculate(input)).error, 'busy'); assert.equal(workers.length, 1);
    workers[0].respond(); workers[0].emit('close', null);
    assert.equal((await pending).error, 'engine_unavailable');
    const retry = calculate(input); assert.equal(workers.length, 2);
    workers[0].respond(); await tick(); assert.equal(workers[1].inputs.length, 1);
    workers[1].respond(); assert.deepEqual(await retry, point(utc));
  }
});

test('timeout retains admission until close; crash and failed spawn permit a fresh request', async t => {
  const { calculate, workers } = harness(t, { capacity: 1, timeoutMs: 5 });
  const pending = calculate(input);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(workers[0].killed, true);
  assert.equal((await calculate(input)).error, 'busy');
  workers[0].emit('close', null); assert.equal((await pending).error, 'timeout');
  const crashed = calculate(input); workers[1].emit('close', 1);
  assert.equal((await crashed).error, 'engine_unavailable');
  const missing = harness(t, { capacity: 1, missingPid: true });
  const failedSpawn = missing.calculate(input); missing.workers[0].emit('error', new Error('ENOENT'));
  assert.equal((await failedSpawn).error, 'engine_unavailable');
  const next = calculate(input); workers[2].respond(); assert.deepEqual(await next, point(utc));
  const thrown = harness(t, { capacity: 1, spawnFailure: true });
  assert.equal((await thrown.calculate(input)).error, 'engine_unavailable');
  assert.equal((await thrown.calculate(input)).error, 'engine_unavailable');
});

test('bounded requests never spawn, ordinary domain errors keep a usable worker, idle workers close', async t => {
  const { calculate, workers } = harness(t, { capacity: 1, idleMs: 5 });
  for (const value of [undefined, {}, 'x'.repeat(65)]) {
    assert.equal((await calculate({ ...input, utc: value })).error, 'engine_unavailable');
  }
  assert.equal(workers.length, 0);
  const invalidDate = calculate({ ...input, utc: 'bad-date' });
  workers[0].respond({ error: 'invalid_utc', message: 'Invalid date' });
  assert.equal((await invalidDate).error, 'invalid_utc');
  const next = calculate(input); workers[0].respond(); assert.deepEqual(await next, point(utc));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(workers[0].killed, true);
  assert.equal((await calculate(input)).error, 'busy');
  workers[0].emit('close', null);
  const afterIdle = calculate(input); workers[1].respond(); await afterIdle;
  workers[1].stdout.emit('data', 'unsolicited data');
  assert.equal(workers[1].killed, true, 'idle protocol garbage retires a session');
});

test('shutdown rejects new work and waits for both persistent and scalar processes', async t => {
  const { calculate, workers } = harness(t);
  const active = calculate(input), idle = calculate(input), scalar = calculate({ mode: 'transit' });
  workers[1].respond(); await idle;
  let closed = false; const closing = calculate.close().then(() => { closed = true; });
  assert.equal(workers[0].killed, true); assert.equal(workers[1].killed, true);
  assert.equal((await calculate(input)).error, 'engine_unavailable');
  await tick(); assert.equal(closed, false);
  workers[0].emit('close', null); workers[1].emit('close', null); await tick();
  assert.equal(closed, false, 'an admitted scalar request still owns its process');
  workers[2].stdout.emit('data', '{}'); workers[2].emit('close', 0);
  assert.equal((await active).error, 'engine_unavailable'); assert.deepEqual(await scalar, {});
  await closing; assert.equal(closed, true); await calculate.close();
});

test('shutdown during idle eviction prevents a replacement scalar from spawning', async t => {
  const { calculate, workers } = harness(t, { capacity: 1 });
  const design = calculate(input); workers[0].respond(); await design;
  const scalar = calculate({ mode: 'transit' });
  assert.equal(workers[0].killed, true);
  const closing = calculate.close();
  workers[0].emit('close', null);
  assert.equal((await scalar).error, 'engine_unavailable');
  await closing; assert.equal(workers.length, 1);
});

test('a delayed previous frame on a reused worker cannot complete its newer request', async t => {
  const { calculate, workers } = harness(t, { capacity: 1 });
  const first = calculate(input); workers[0].respond(); await first;
  const next = calculate({ ...input, utc: '2026-09-30T12:35:56Z' });
  workers[0].respond(point(utc), 1);
  assert.equal(workers[0].killed, true);
  assert.equal((await calculate(input)).error, 'busy');
  workers[0].emit('close', null);
  assert.equal((await next).error, 'engine_unavailable');
});
