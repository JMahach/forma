import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpTransport, configureTransportSimulation, fetchResource, getConnectionMode, subscribeConnection } from '../src/data/http-transport.ts';
import { createStandConnection } from './helpers/preview/stand-connection.ts';

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

function browserConnection(t: test.TestContext) {
 const previous = Object.getOwnPropertyDescriptors(globalThis);
 const events = new EventTarget(), network = {onLine: true};
 Object.defineProperty(globalThis, 'window', {configurable:true, value:events});
 Object.defineProperty(globalThis, 'navigator', {configurable:true, value:network});
 t.after(() => {
  configureTransportSimulation(null);
  for (const name of ['window','navigator','fetch']) {
   if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
   else Reflect.deleteProperty(globalThis, name);
  }
 });
 return {set(online:boolean) {network.onLine=online;events.dispatchEvent(new Event(online?'online':'offline'));}};
}

test('real offline and the stand use one mode, without duplicate transitions or automatic writes', async t => {
 const browser=browserConnection(t), stand=createStandConnection();let writes=0;
 configureTransportSimulation(stand, async()=>{writes++;return new Response('saved');});
 const modes:string[]=[];const stop=subscribeConnection(mode=>modes.push(mode));t.after(stop);
 browser.set(false);assert.equal(getConnectionMode(),'offline');
 await assert.rejects(fetchResource('/api/save',{method:'POST'}),{code:'offline'});
 stand.set('server');assert.equal(getConnectionMode(),'offline');
 browser.set(true);assert.equal(getConnectionMode(),'server');
 assert.equal(writes,0);
 await assert.rejects(fetchResource('/api/save',{method:'POST'}),{code:'server_unavailable'});
 stand.set('online');browser.set(true);assert.equal(writes,0);
 assert.equal(await (await fetchResource('/api/save',{method:'POST'})).text(),'saved');
 assert.equal(writes,1);assert.deepEqual(modes,['online','offline','server','online']);
 stop();browser.set(false);stand.set('offline');assert.deepEqual(modes,['online','offline','server','online']);
});

for (const simulated of [false,true]) {
 test(`real connection loss rejects a late response with stand=${simulated}`, async t => {
  const browser=browserConnection(t);let reply!:(value:Response)=>void,calls=0;
  const send:typeof fetch=async()=>{calls++;return new Promise<Response>(resolve=>{reply=resolve;});};
  if (simulated) configureTransportSimulation(createStandConnection(),send);
  else Object.defineProperty(globalThis,'fetch',{configurable:true,writable:true,value:send});
  const work=fetchResource('/api/save',{method:'POST'});
  browser.set(false);reply(new Response('late'));
  await assert.rejects(work,{code:'offline'});
  browser.set(true);assert.equal(calls,1,'connectivity never repeats an unknown write');
 });
}

test('a real offline event interrupts body reading and reconnect leaves the failed read stopped', async t => {
 const browser=browserConnection(t);let calls=0;
 Object.defineProperty(globalThis,'fetch',{configurable:true,writable:true,value:async()=>{
  calls++;return new Response(new ReadableStream({start(){}}));
 }});
 const response=await fetchResource('/api/chart'), body=response.json();
 browser.set(false);await assert.rejects(body,{code:'offline'});
 browser.set(true);assert.equal(calls,1);assert.equal(getConnectionMode(),'online');
});

test('a failed server request does not invent an offline mode for local actions', async t => {
 browserConnection(t);const stand=createStandConnection();
 configureTransportSimulation(stand,async()=>{throw new TypeError('unreachable server');});
 await assert.rejects(fetchResource('/api/chart'),TypeError);
 assert.equal(getConnectionMode(),'online');
 stand.set('server');assert.equal(getConnectionMode(),'server');
});
