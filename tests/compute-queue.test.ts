import test from 'node:test';
import assert from 'node:assert/strict';
import { createComputeQueue } from '../server/runtime/compute-queue.ts';
import { runJsonWorker, type JsonWorkerOptions } from '../server/runtime/json-worker.ts';
import { createNatalDays, generateNatalDay } from '../server/services/natal-days.ts';
import { createCycles, generateCycles } from '../server/services/cycles.ts';
import { createCalculator } from '../server/services/calculate.ts';
import { EventEmitter } from 'node:events';
const tick = () => new Promise(setImmediate);
const worker = () => {
  const value: EventEmitter & { killed?: boolean } = new EventEmitter();
  return Object.assign(value, {
    pid: 10,
    stdout: Object.assign(new EventEmitter(), { setEncoding() {} }),
    stdin: Object.assign(new EventEmitter(), { end() {} }),
    kill() { value.killed = true; },
  });
};
test('different scripts share a physical process budget and cancellation keeps its slot until close', async () => {
  const queue = createComputeQueue({ concurrency: 1, maxQueued: 2 }), workers: ReturnType<typeof worker>[] = [];
  const run = (script: string, signal?: AbortSignal) => runJsonWorker({ root: '/unused', script, input: {}, signal, computeQueue: queue,
    timeoutMs: 1000, maxOutput: 100, unavailable: () => Error('unavailable'), timeoutError: () => Error('timeout'),
    // Only the process events and streams used by runJsonWorker are supplied.
    spawnWorker: (() => { const value = worker(); workers.push(value); return value; }) as unknown as JsonWorkerOptions['spawnWorker'] });
  const a = new AbortController(), first = run('calculator.py', a.signal), failed = assert.rejects(first, { name: 'AbortError' });
  const second = run('transit_day.py');
  assert.equal(workers.length, 1); a.abort(); await tick();
  assert.equal(workers[0].killed, true); assert.equal(workers.length, 1);
  workers[0].emit('close', 1); await failed; await tick();
  assert.equal(workers.length, 2);
  workers[1].stdout.emit('data', '{}'); workers[1].emit('close', 0); await second;
  assert.equal(queue.active, 0);
});
test('abandoned waiting work never starts and queue admission is bounded', async () => {
  const queue = createComputeQueue({ concurrency: 1, maxQueued: 1 });
  let release, starts = 0;
  const first = queue.run(() => new Promise(resolve => { release = resolve; }));
  const cancel = new AbortController();
  const second = queue.run(() => { starts++; }, { signal: cancel.signal });
  const failed = assert.rejects(second, { name: 'AbortError' });
  await assert.rejects(queue.run(() => {}), { code: 'busy' });
  cancel.abort(); await failed; release!(); await first;
  assert.equal(starts, 0); assert.equal(queue.queued, 0);
});

test('abandoned natal, return and scalar jobs leave the common queue before any Python starts', async () => {
  const computeQueue = createComputeQueue({ concurrency: 1 }); let release, starts = 0;
  const held = computeQueue.run(() => new Promise(resolve => { release = resolve; }));
  const spawnWorker = () => { starts++; throw Error('cancelled work must not start'); };
  const natal = createNatalDays({ generateDay: (date, timezone, options) => generateNatalDay({ root: '/unused', date, timezone, computeQueue, spawnWorker, ...options }) });
  const cycles = createCycles({ generate: (input, options) => generateCycles({ root: '/unused', input, computeQueue, spawnWorker, ...options }) });
  const calculate = createCalculator({ root: '/unused', computeQueue, spawnWorker });
  const controllers = Array.from({ length: 3 }, () => new AbortController());
  const a = natal.get('2000-01-01', 'UTC', { signal: controllers[0].signal });
  const b = cycles.events({ birthUtc: '2000-01-01T00:00:00Z', body: 'sun', fromAge: 0, toAge: 100 }, { signal: controllers[1].signal });
  const c = calculate({ mode: 'transit', utc: '2000-01-01T00:00:00Z' }, { signal: controllers[2].signal });
  const failures = [assert.rejects(a, { name: 'AbortError' }), assert.rejects(b, { name: 'AbortError' })];
  await tick(); assert.equal(computeQueue.queued, 3);
  controllers.forEach(controller => controller.abort()); await Promise.all(failures);
  // The calculator resolves cancellation errors; its declared result omits that variant.
  assert.equal(((await c) as unknown as Error).name, 'AbortError'); assert.equal(computeQueue.queued, 0);
  release!(); await held; await tick(); assert.equal(starts, 0); await cycles.close(); await calculate.close();
});

test('a waiting warmup adopts interactive priority when a user joins it', async () => {
  const queue = createComputeQueue({ concurrency: 1 }); let release, background = true;
  const held = queue.run(() => new Promise(resolve => { release = resolve; })), order: unknown[] = [];
  const day = queue.run(() => { order.push('day'); }, { priority: () => background ? -1 : 0 });
  const scalar = queue.run(() => { order.push('scalar'); }); background = false;
  release!(); await Promise.all([held, day, scalar]); assert.deepEqual(order, ['day', 'scalar']);
});
