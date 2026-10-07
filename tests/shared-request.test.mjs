import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { shareRequest } from '../src/data/shared-request.js';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('cancelling one consumer preserves shared transport and the remaining consumer data', async () => {
  const pending = new Map(), waiting = Promise.withResolvers(), controller = new AbortController();
  let transport, starts = 0;
  const start = async request => {
    starts++; transport = request.controller.signal;
    await waiting.promise;
    return [...request.consumers].map(consumer => consumer.timezone);
  };
  const cancelled = assert.rejects(shareRequest(pending, 'day', start, {
    signal: controller.signal, consumer: { timezone: 'Europe/Moscow' },
  }), { name: 'AbortError' });
  const ready = shareRequest(pending, 'day', start, { consumer: { timezone: 'UTC' } });
  await settle();
  controller.abort(); await cancelled;
  assert.equal(transport.aborted, false);
  assert.equal(starts, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  waiting.resolve();
  assert.deepEqual(await ready, ['UTC']);
  assert.equal(pending.size, 0);
});

test('the last cancellation aborts transport and releases the pending key immediately', async () => {
  const pending = new Map(), waiting = Promise.withResolvers(), a = new AbortController(), b = new AbortController();
  let transport;
  const start = request => { transport = request.controller.signal; return waiting.promise; };
  const first = assert.rejects(shareRequest(pending, 'day', start, { signal: a.signal }), { name: 'AbortError' });
  const second = assert.rejects(shareRequest(pending, 'day', start, { signal: b.signal }), { name: 'AbortError' });
  await settle();
  a.abort(); await first;
  assert.equal(transport.aborted, false);
  assert.equal(pending.size, 1);
  b.abort(); await second;
  assert.equal(transport.aborted, true);
  assert.equal(pending.size, 0);
  waiting.resolve('late');
  await settle();
});

test('an already-aborted consumer neither starts a request nor joins or cancels an existing one', async () => {
  const pending = new Map(), controller = new AbortController(), waiting = Promise.withResolvers();
  let starts = 0, transport;
  const start = request => { starts++; transport = request.controller.signal; return waiting.promise; };
  controller.abort();
  await assert.rejects(shareRequest(pending, 'day', start, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(starts, 0);
  assert.equal(pending.size, 0);
  const ready = shareRequest(pending, 'day', start);
  await assert.rejects(shareRequest(pending, 'day', start, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(starts, 1);
  assert.equal(transport.aborted, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  waiting.resolve('ready');
  assert.equal(await ready, 'ready');
});

for (const outcome of ['resolve', 'reject']) {
  test(`late ${outcome} of an abandoned request cannot remove a newer pending request`, async () => {
    const pending = new Map(), controller = new AbortController(), old = Promise.withResolvers(), current = Promise.withResolvers();
    let starts = 0;
    const start = () => ++starts === 1 ? old.promise : current.promise;
    const cancelled = assert.rejects(shareRequest(pending, 'day', start, { signal: controller.signal }), { name: 'AbortError' });
    controller.abort(); await cancelled;
    const ready = shareRequest(pending, 'day', start);
    const newerRequest = pending.get('day');
    old[outcome](outcome === 'reject' ? new Error('late failure') : 'stale');
    await settle();
    assert.equal(pending.get('day'), newerRequest);
    const joined = shareRequest(pending, 'day', start);
    assert.equal(starts, 2, 'the newcomer joins the current request');
    current.resolve('current');
    assert.deepEqual(await Promise.all([ready, joined]), ['current', 'current']);
    assert.equal(pending.size, 0);
  });

  test(`request ${outcome} releases consumer abort listeners and consumer data`, async () => {
    const pending = new Map(), waiting = Promise.withResolvers(), controller = new AbortController();
    let request;
    const result = shareRequest(pending, 'day', value => { request = value; return waiting.promise; }, { signal: controller.signal });
    const done = outcome === 'reject' ? assert.rejects(result, /unavailable/) : result;
    await settle();
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    waiting[outcome](outcome === 'reject' ? new Error('unavailable') : 'ready');
    await done;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(request.consumers.size, 0);
    controller.abort();
    assert.equal(request.controller.signal.aborted, false, 'completed work is no longer subscribed to navigation');
  });
}
