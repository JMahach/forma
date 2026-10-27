import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJSON } from '../src/data/api-client.ts';
import { failureMessage, UI_MESSAGES } from '../src/ui/messages.ts';

test('JSON client forwards request options and returns the server payload', async t => {
  const options = { method: 'POST', body: '{"mode":"transit"}', headers: {'Content-Type':'application/json'}, credentials:'same-origin' as const }, payload = { chart: { id: 'test' } };
  t.mock.method(globalThis, 'fetch', async (url: unknown, actual: RequestInit) => {
    assert.equal(url, '/api/calculate');
    const {signal,...forwarded}=actual;
    assert.deepEqual(forwarded, options);
    assert.ok(signal instanceof AbortSignal);assert.equal(signal.aborted,false);
    return Response.json(payload);
  });
  assert.deepEqual(await requestJSON('/api/calculate', options), payload);
  assert.equal(Object.hasOwn(options,'signal'),false,'transport must not mutate caller options');
});

test('JSON client keeps aborts distinguishable while explaining unavailable transport', async t => {
  const aborted = new DOMException('Aborted', 'AbortError');
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw aborted; });
  await assert.rejects(requestJSON('/api/cities'), error => error === aborted);
  fetch.mock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(requestJSON('/api/cities'), error => error instanceof Error && 'code' in error && error.code === 'connection_failed');
});

test('JSON client preserves cancellation after headers while reading the response body', async t => {
  const cancel = new AbortController();
  let stream: ReadableStreamDefaultController;
  t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, { signal }: RequestInit) => new Response(new ReadableStream({
    start(controller) {
      stream = controller;
      signal!.addEventListener('abort', () => controller.error(signal!.reason), { once: true });
    },
  })));
  const response = requestJSON('/api/cycles/events', { signal: cancel.signal });
  stream!.enqueue(new TextEncoder().encode('{'));
  cancel.abort();
  await assert.rejects(response, error => error === cancel.signal.reason);
});

test('JSON client preserves structured DST error choices for the birth form', async t => {
  const choices = [{ fold: 0, label: 'First' }, { fold: 1, label: 'Second' }];
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'Ambiguous time', error: 'ambiguous_time', choices },{status:422}));
  await assert.rejects(requestJSON('/api/calculate'), error => {
    assert.ok(error instanceof Error);
    assert.ok('code' in error && 'choices' in error);
    assert.equal(error.message, 'Ambiguous time');
    assert.equal(error.code, 'ambiguous_time');
    assert.deepEqual(error.choices, choices);
    return true;
  });
});

test('JSON client reports an unreadable server response without exposing parser details', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>Unexpected HTML</html>'));
  await assert.rejects(requestJSON('/api/calculate'), /Не удалось получить ответ сервера/);
});


test('JSON client distinguishes a broken response stream from invalid JSON', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError('stream failed')); },
  })));
  await assert.rejects(requestJSON('/api/cities'), error => error instanceof Error && 'code' in error && error.code === 'connection_failed');
  fetch.mock.mockImplementation(async () => new Response('{invalid JSON'));
  await assert.rejects(requestJSON('/api/cities'), error => error instanceof Error && 'code' in error && error.code !== 'connection_failed');
});

test('server internal details do not leak into a user-facing technical failure', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({message:'Secret local engine path',error:'engine_failed'},{status:500}));
  await assert.rejects(requestJSON('/api/calculate'), error => {
    assert.ok(error instanceof Error && 'code' in error && 'status' in error);
    assert.equal(error.code, 'engine_failed');
    assert.equal(error.status, 500);
    assert.equal(failureMessage(error, error.message, 'chart-form'), UI_MESSAGES.serverError);
    return true;
  });
});
