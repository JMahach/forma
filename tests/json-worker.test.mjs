import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runJsonWorker } from '../server/runtime/json-worker.mjs';
import { negotiateEncoding } from '../server/http/content-encoding.mjs';

function harness(options = {}) {
  const worker = new EventEmitter(), kills = [];
  worker.stdout = new EventEmitter(); worker.stdout.setEncoding = () => {};
  worker.stdin = new EventEmitter(); worker.stdin.end = value => { worker.input = JSON.parse(value); };
  worker.kill = signal => kills.push(signal);
  const failure = new Error('unavailable'), timeout = new Error('timeout');
  const promise = runJsonWorker({ root: '/example', script: 'day.py', input: { date: '2026-09-25' },
    timeoutMs: 1000, maxOutput: 100, unavailable: () => failure, timeoutError: () => timeout,
    validate: value => value, spawnWorker: () => worker, ...options });
  return { worker, kills, promise, failure, timeout };
}

test('JSON worker passes structured input, parses output and settles exactly once', async () => {
  const h = harness();
  assert.deepEqual(h.worker.input, { date: '2026-09-25' });
  h.worker.stdout.emit('data', '{"minutes":'); h.worker.stdout.emit('data', '1440}');
  h.worker.emit('close', 0);
  assert.deepEqual(await h.promise, { minutes: 1440 });
  h.worker.emit('error', new Error('late'));
  assert.deepEqual(await h.promise, { minutes: 1440 });
});

test('JSON worker limits bytes (not characters) and waits for termination', async () => {
  const h = harness({ maxOutput: 3 });
  let settled = false;
  const outcome = h.promise.catch(error => { settled = true; return error; });
  h.worker.stdout.emit('data', 'яя');
  assert.deepEqual(h.kills, ['SIGKILL']);
  await Promise.resolve(); assert.equal(settled, false);
  h.worker.emit('close', null);
  assert.equal(await outcome, h.failure);
});

test('JSON worker preserves domain validation errors without exposing invalid output', async () => {
  for (const [body, exitCode] of [['not json', 0], ['{}', 1]]) {
    const h = harness();
    h.worker.stdout.emit('data', body); h.worker.emit('close', exitCode);
    await assert.rejects(h.promise, error => error === h.failure);
  }
  const expected = new Error('unsupported date');
  const h = harness({ validate() { throw expected; } });
  h.worker.stdout.emit('data', '{}'); h.worker.emit('close', 0);
  await assert.rejects(h.promise, error => error === expected);
});

test('JSON worker pipe errors kill the process and spawn errors fail without waiting', async () => {
  const pipe = harness();
  pipe.worker.stdin.emit('error', new Error('pipe'));
  assert.deepEqual(pipe.kills, ['SIGKILL']);
  pipe.worker.emit('close', null);
  await assert.rejects(pipe.promise, error => error === pipe.failure);
  const spawn = harness();
  spawn.worker.emit('error', new Error('missing runtime'));
  await assert.rejects(spawn.promise, error => error === spawn.failure);
});

test('live process errors wait for close, even before the asynchronous spawn event', async () => {
  for (const marker of ['spawn', 'pid']) {
    const h = harness();
    if (marker === 'spawn') h.worker.emit('spawn'); else h.worker.pid = 123;
    let settled = false;
    const outcome = h.promise.catch(error => { settled = true; return error; });
    h.worker.emit('error', new Error('live process error'));
    assert.deepEqual(h.kills, ['SIGKILL']);
    await Promise.resolve(); assert.equal(settled, false);
    h.worker.stdout.emit('data', '{}'); h.worker.emit('close', 0);
    assert.equal(await outcome, h.failure);
  }
});

test('synchronous launch failure has no process to wait for', async () => {
  const h = harness({ spawnWorker() { throw new Error('spawn unavailable'); } });
  await assert.rejects(h.promise, error => error === h.failure);
});

test('scalar character limits and batch byte limits keep their different units', async () => {
  const body = '{"я":1}';
  const scalar = harness({ maxOutput: body.length, outputUnit: 'characters' });
  scalar.worker.stdout.emit('data', body); scalar.worker.emit('close', 0);
  assert.deepEqual(await scalar.promise, { я: 1 });
  assert.deepEqual(scalar.kills, []);
  const batch = harness({ maxOutput: body.length });
  batch.worker.stdout.emit('data', body);
  assert.deepEqual(batch.kills, ['SIGKILL']);
  batch.worker.emit('close', 0);
  await assert.rejects(batch.promise, error => error === batch.failure);
});

test('stdout failure and thrown stdin writes terminate before rejecting', async () => {
  const output = harness();
  output.worker.stdout.emit('error', new Error('broken output'));
  assert.deepEqual(output.kills, ['SIGKILL']);
  output.worker.emit('close', null);
  await assert.rejects(output.promise, error => error === output.failure);
  let worker;
  const h = harness({ spawnWorker() {
    worker = new EventEmitter();
    worker.stdout = new EventEmitter(); worker.stdout.setEncoding = () => {};
    worker.stdin = new EventEmitter(); worker.stdin.end = () => { throw new Error('broken input'); };
    worker.kill = signal => { worker.killed = signal; }; return worker;
  } });
  assert.equal(worker.killed, 'SIGKILL');
  let settled = false;
  const outcome = h.promise.catch(error => { settled = true; return error; });
  await Promise.resolve(); assert.equal(settled, false);
  worker.emit('close', null);
  assert.equal(await outcome, h.failure);
});

test('encoding negotiation is independent of the packet and respects explicit exclusions', () => {
  for (const [header, expected] of [[undefined, 'identity'], ['br,gzip', 'br'], ['gzip;q=1,br;q=.4', 'gzip'],
    ['br;q=0,gzip;q=0', 'identity'], ['*;q=0', null], ['identity;q=0,deflate', null],
    ['identity;q=0,gzip;q=wrong', null], ['*;q=0,br;q=.1', 'br']]) {
    assert.equal(negotiateEncoding(header), expected);
  }
});
