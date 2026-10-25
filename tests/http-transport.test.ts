import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpTransport, configureTransportSimulation, getConnectionMode, subscribeConnection } from '../src/data/http-transport.ts';
import { createStandConnection } from '../src/dev/control-colors.ts';

test('offline prevents a request; returning online permits it without replaying the rejected call', async () => {
  const mode = createStandConnection(); let calls = 0;
  const request = createHttpTransport({ connection: mode, fetch: async () => { calls++; return new Response('ok'); } });
  mode.set('offline');
  await assert.rejects(request('/api/test'), { code: 'offline' });
  assert.equal(calls, 0);
  mode.set('online'); assert.equal(calls, 0);
  assert.equal(await (await request('/api/test')).text(), 'ok'); assert.equal(calls, 1);
});

test('server silence stays distinct from a confirmed refusal', async () => {
  const connection = createStandConnection(); connection.set('server');
  const request = createHttpTransport({ connection, fetch: async () => { throw new Error('must not send'); } });
  await assert.rejects(request('/api/save', { method: 'POST' }), { code: 'server_unavailable' });
});

test('connection loss rejects the active request even if its late fetch ignores abort', async () => {
  const connection = createStandConnection(); let resolve!: (r: Response) => void;
  const request = createHttpTransport({ connection, fetch: async () => new Promise<Response>(r => resolve = r) });
  const result = request('/api/test');
  connection.set('offline'); resolve(new Response('late'));
  await assert.rejects(result, { code: 'offline' });
});

test('cancellation is not a network error and a later response cannot complete it', async () => {
  const connection = createStandConnection(), controller = new AbortController();
  const request = createHttpTransport({ connection, fetch: async () => new Promise<Response>(() => {}) });
  const result = request('/api/test', { signal: controller.signal }); controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
});

test('connection loss while reading the body rejects unread data and releases listeners', async () => {
  const mode = createStandConnection(); let listeners = 0;
  const connection = { get current() { return mode.current; }, subscribe(fn: (v: 'online'|'offline'|'server') => void) {
    listeners++; const stop = mode.subscribe(fn); return () => { listeners--; stop(); };
  } };
  const request = createHttpTransport({ connection, fetch: async () => new Response(new ReadableStream({start() {}})) });
  const response = await request('/api/test'), body = response.json();
  mode.set('server'); await assert.rejects(body, { code: 'server_unavailable' });
  assert.equal(listeners, 0);
});

test('completed read releases the observer and later mode changes do not invalidate its result', async () => {
  const mode = createStandConnection(); let listeners = 0;
  const connection = { get current() { return mode.current; }, subscribe(fn: (v: 'online'|'offline'|'server') => void) {
    listeners++; const stop = mode.subscribe(fn); return () => { listeners--; stop(); };
  } };
  const request = createHttpTransport({ connection, fetch: async () => new Response('{"ready":true}') });
  const payload = await (await request('/api/test')).json();
  assert.deepEqual(payload, {ready:true}); assert.equal(listeners,0); mode.set('offline');
  assert.deepEqual(payload, {ready:true});
});

test('the shared mode observer exposes the stand source to forms without replaying actions', () => {
 const connection=createStandConnection(); configureTransportSimulation(connection);
 const modes:string[]=[]; const stop=subscribeConnection(mode=>modes.push(mode));
 connection.set('offline'); assert.equal(getConnectionMode(),'offline'); stop(); connection.set('online');
 assert.deepEqual(modes,['online','offline']); configureTransportSimulation(null);
});
