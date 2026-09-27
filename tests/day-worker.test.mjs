import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runDayWorker } from '../server/runtime/day-worker.mjs';
import { negotiateEncoding } from '../server/http/content-encoding.mjs';

function harness(options = {}) {
  const worker = new EventEmitter(), kills = [];
  worker.stdout = new EventEmitter(); worker.stdout.setEncoding = () => {};
  worker.stdin = new EventEmitter(); worker.stdin.end = value => { worker.input = JSON.parse(value); };
  worker.kill = signal => kills.push(signal);
  const failure = new Error('unavailable'), timeout = new Error('timeout');
  const promise = runDayWorker({ root: '/example', script: 'day.py', input: { date: '2026-09-25' },
    timeoutMs: 1000, maxOutputBytes: 100, unavailable: () => failure, timeoutError: () => timeout,
    validate: value => value, spawnWorker: () => worker, ...options });
  return { worker, kills, promise, failure, timeout };
}

test('batch adapter passes structured input, parses output and settles exactly once', async () => {
  const h = harness();
  assert.deepEqual(h.worker.input, { date: '2026-09-25' });
  h.worker.stdout.emit('data', '{"minutes":'); h.worker.stdout.emit('data', '1440}');
  h.worker.emit('close', 0);
  assert.deepEqual(await h.promise, { minutes: 1440 });
  h.worker.emit('error', new Error('late'));
  assert.deepEqual(await h.promise, { minutes: 1440 });
});

test('batch adapter limits bytes (not characters) and waits for termination', async () => {
  const h = harness({ maxOutputBytes: 3 });
  let settled = false;
  const outcome = h.promise.catch(error => { settled = true; return error; });
  h.worker.stdout.emit('data', 'яя');
  assert.deepEqual(h.kills, ['SIGKILL']);
  await Promise.resolve(); assert.equal(settled, false);
  h.worker.emit('close', null);
  assert.equal(await outcome, h.failure);
});

test('batch adapter preserves domain validation errors without exposing invalid output', async () => {
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

test('batch pipe errors kill the process and spawn errors fail without waiting', async () => {
  const pipe = harness();
  pipe.worker.stdin.emit('error', new Error('pipe'));
  assert.deepEqual(pipe.kills, ['SIGKILL']);
  pipe.worker.emit('close', null);
  await assert.rejects(pipe.promise, error => error === pipe.failure);
  const spawn = harness();
  spawn.worker.emit('error', new Error('missing runtime'));
  await assert.rejects(spawn.promise, error => error === spawn.failure);
});

test('encoding negotiation is independent of the packet and respects explicit exclusions', () => {
  for (const [header, expected] of [[undefined, 'identity'], ['br,gzip', 'br'], ['gzip;q=1,br;q=.4', 'gzip'],
    ['br;q=0,gzip;q=0', 'identity'], ['*;q=0', null], ['identity;q=0,deflate', null],
    ['identity;q=0,gzip;q=wrong', null], ['*;q=0,br;q=.1', 'br']]) {
    assert.equal(negotiateEncoding(header), expected);
  }
});
