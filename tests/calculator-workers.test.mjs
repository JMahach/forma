import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCalculator, CALCULATOR_LIMITS } from '../server/services/calculate.mjs';

const tick = () => new Promise(setImmediate);
const utc = '2026-09-30T12:34:56Z';
const input = { mode: 'transit_design', utc };
const point = value => ({ utc: value, designUtc: '2026-07-04T12:34:56Z',
  designArcResidualDegrees: 1e-11, longitudes: Array.from({ length: 11 }, (_, i) => i * 30 + 0.12345678901234) });

function harness(t, { capacity = 4, timeoutMs = 1000, maxOutput = 100000, spawnFailure = false, missingPid = false } = {}) {
  const workers = [];
  const calculate = createCalculator({ root: '/unused', limits: { ...CALCULATOR_LIMITS, concurrency: capacity, timeoutMs, outputCharacters: maxOutput },
    spawnWorker(_python, [script]) {
      if (spawnFailure) throw new Error('spawn unavailable');
      const worker = new EventEmitter(); if (!missingPid) worker.pid = workers.length + 1; worker.script = script;
      worker.stdout = new EventEmitter(); worker.stdout.setEncoding = () => {};
      worker.stdin = new EventEmitter(); worker.inputs = [];
      worker.stdin.write = worker.stdin.end = line => worker.inputs.push(JSON.parse(line));
      worker.kill = () => { worker.killed = true; };
      worker.respond = (value = point(worker.inputs.at(-1).utc)) => { worker.stdout.emit('data', JSON.stringify(value)); };
      worker.complete = (value = point(worker.inputs.at(-1).utc)) => { worker.respond(value); worker.emit('close', 0); };
      workers.push(worker); return worker;
    } });
  t.after(async () => {
    const closed = calculate.close();
    workers.forEach(worker => worker.emit('close', null));
    await closed;
  });
  return { calculate, workers };
}

test('Design uses the ordinary scalar worker, preserves exact input and waits for process close', async t => {
  const { calculate, workers } = harness(t);
  assert.equal(workers.length, 0);
  const first = calculate(input);
  assert.ok(workers[0].script.endsWith('/calculator.py'));
  assert.deepEqual(workers[0].inputs, [input]);
  let completed = false; first.then(() => { completed = true; });
  const body = JSON.stringify(point(utc));
  workers[0].stdout.emit('data', body.slice(0, 20)); await tick();
  assert.equal(completed, false);
  workers[0].stdout.emit('data', body.slice(20)); await tick();
  assert.equal(completed, false, 'even complete JSON retains the process slot until close');
  workers[0].emit('close', 0); assert.deepEqual(await first, point(utc));
  const secondUtc = '1801-01-01T00:00:00Z';
  const second = calculate({ ...input, utc: secondUtc });
  assert.equal(workers.length, 2, 'each scalar process owns exactly one input');
  workers[1].complete(); assert.deepEqual(await second, point(secondUtc));
});

test('four physical slots are shared across natal, transit, exact moment and Design', async t => {
  const { calculate, workers } = harness(t);
  const requests = [calculate(input), calculate({ mode: 'transit_moment', utc }), calculate({ mode: 'transit' }), calculate({ mode: 'natal' })];
  assert.equal(workers.length, 4);
  assert.ok(workers.every(worker => worker.inputs.length === 1 && worker.script.endsWith('/calculator.py')));
  assert.equal((await calculate(input)).error, 'busy');
  workers[0].respond(); await tick();
  assert.equal((await calculate(input)).error, 'busy');
  workers[0].emit('close', 0); await requests[0];
  const replacement = calculate(input); assert.equal(workers.length, 5);
  for (const worker of workers.slice(1)) worker.complete({ chart: {} });
  await Promise.all([...requests, replacement]);
});

test('overflow and live process errors retain admission until close, then permit an isolated retry', async t => {
  for (const corrupt of [worker => worker.stdout.emit('data', 'x'.repeat(1001)),
    worker => worker.stdin.emit('error', new Error('pipe')), worker => worker.stdout.emit('error', new Error('pipe')),
    worker => worker.emit('error', new Error('live process failure'))]) {
    const { calculate, workers } = harness(t, { capacity: 1, maxOutput: 1000 });
    const pending = calculate(input); let settled = false; pending.then(() => { settled = true; });
    corrupt(workers[0]); await tick();
    assert.equal(workers[0].killed, true); assert.equal(settled, false);
    assert.equal((await calculate(input)).error, 'busy'); assert.equal(workers.length, 1);
    workers[0].respond(); workers[0].emit('close', null);
    assert.equal((await pending).error, 'engine_unavailable');
    const retry = calculate(input); assert.equal(workers.length, 2);
    workers[0].respond(); workers[0].emit('error', new Error('late event')); await tick();
    workers[1].complete(); assert.deepEqual(await retry, point(utc));
  }
});

test('timeout holds its slot until close; failed spawn, bad JSON and nonzero exit release admission', async t => {
  const { calculate, workers } = harness(t, { capacity: 1, timeoutMs: 5 });
  const pending = calculate(input);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(workers[0].killed, true); assert.equal((await calculate(input)).error, 'busy');
  workers[0].emit('close', null); assert.equal((await pending).error, 'timeout');
  const crashed = calculate(input); workers[1].respond(); workers[1].emit('close', 1);
  assert.equal((await crashed).error, 'engine_unavailable');
  const malformed = calculate(input); workers[2].stdout.emit('data', '{invalid}'); workers[2].emit('close', 0);
  assert.equal((await malformed).error, 'engine_unavailable');
  const missing = harness(t, { capacity: 1, missingPid: true });
  const failedSpawn = missing.calculate(input); missing.workers[0].emit('error', new Error('ENOENT'));
  assert.equal((await failedSpawn).error, 'engine_unavailable');
  const retry = missing.calculate(input); missing.workers[1].complete(); assert.deepEqual(await retry, point(utc));
  const thrown = harness(t, { capacity: 1, spawnFailure: true });
  assert.equal((await thrown.calculate(input)).error, 'engine_unavailable');
  assert.equal((await thrown.calculate(input)).error, 'engine_unavailable');
});

test('invalid Design request shape stays bounded; domain errors allow a fresh scalar request', async t => {
  const { calculate, workers } = harness(t, { capacity: 1 });
  for (const value of [undefined, {}, 'x'.repeat(65)]) {
    assert.equal((await calculate({ ...input, utc: value })).error, 'engine_unavailable');
  }
  assert.equal(workers.length, 0);
  const invalidDate = calculate({ ...input, utc: 'bad-date' });
  workers[0].complete({ error: 'invalid_utc', message: 'Invalid date' });
  assert.equal((await invalidDate).error, 'invalid_utc');
  const next = calculate(input); workers[1].complete(); assert.deepEqual(await next, point(utc));
});

test('shutdown kills active scalar processes, rejects new work and waits for every close', async t => {
  const { calculate, workers } = harness(t);
  const active = calculate(input), scalar = calculate({ mode: 'transit' });
  let closed = false; const closing = calculate.close();
  assert.equal(calculate.close(), closing); closing.then(() => { closed = true; });
  assert.ok(workers.every(worker => worker.killed));
  assert.equal((await calculate(input)).error, 'engine_unavailable');
  await tick(); assert.equal(closed, false);
  workers[0].emit('close', null); await tick(); assert.equal(closed, false);
  workers[1].emit('close', null);
  assert.equal((await active).error, 'engine_unavailable'); assert.equal((await scalar).error, 'engine_unavailable');
  await closing; assert.equal(closed, true);
});
