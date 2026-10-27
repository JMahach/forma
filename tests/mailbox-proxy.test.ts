import test from 'node:test';
import assert from 'node:assert/strict';
import http, { type IncomingMessage, type Server, type RequestOptions } from 'node:http';
import net, { type Socket } from 'node:net';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';
import { createMailboxProxy, type MailboxProxyOptions } from '../server/dev/mailbox-proxy.ts';

const origin = 'http://localhost:3636';
const key = Buffer.alloc(16, 7).toString('base64');
const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
const configuration: MailboxProxyOptions = {enabled: true, environment: 'stand', release: false, port: 3636};
const wsHeaders = {origin, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': key, 'sec-websocket-version': '13'};
async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); return address.port;
}
async function fixture(t: test.TestContext, options: Partial<MailboxProxyOptions> = {}) {
  const sockets = new Set<Socket>();
  const received: {url: string | undefined; headers: IncomingMessage['headers']; body: string}[] = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push({url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString()});
    res.writeHead(200, {'content-type': 'application/json', 'set-cookie': 'forma_local_s_fake=stolen; Path=/',
      'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600', 'x-mailpit': 'ok'});
    res.end(JSON.stringify({message: 'synthetic message', code: '654321'}));
  });
  const targetPort = await listen(upstream);
  const original = http.request.bind(http);
  const routed: RequestOptions[] = [];
  // Keep production's upstream fixed. Only this test transport redirects to a synthetic receiver.
  t.mock.method(http, 'request', (options: RequestOptions, callback?: (res: IncomingMessage) => void) => {
    routed.push(options); assert.equal(options.hostname, '127.0.0.1'); assert.equal(options.port, 8025);
    return original({...options, port: targetPort}, callback);
  });
  const proxy = createMailboxProxy({...configuration, ...options});
  let peer: string | undefined;
  const server = http.createServer((req, res) => {
    if (peer !== undefined) Object.defineProperty(req.socket, 'remoteAddress', {value: peer, configurable: true});
    if (!proxy.handleHttp(req, res)) {res.writeHead(418); res.end('ordinary site');}
  });
  server.on('upgrade', (req, socket, head) => {
    if (peer !== undefined) Object.defineProperty(req.socket, 'remoteAddress', {value: peer, configurable: true});
    if (!proxy.handleUpgrade(req, socket, head)) socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  for (const owner of [server, upstream]) owner.on('connection', socket => {sockets.add(socket); socket.on('close', () => sockets.delete(socket));});
  const port = await listen(server);
  t.after(async () => {proxy.close(); for (const socket of sockets) socket.destroy();
    await Promise.all([server, upstream].map(owner => new Promise<void>(resolve => owner.close(() => resolve()))));});
  function request(path = '/__mail/', headers: Record<string, string | string[] | undefined> = {}, method = 'GET', body?: string) {
    return new Promise<{status: number; headers: IncomingMessage['headers']; body: string}>((resolve, reject) => {
      const req = original({hostname: '127.0.0.1', port, path, method, headers: Object.entries({host: 'localhost:3636', ...headers}).flatMap(([name, value]) => value === undefined ? [] : (Array.isArray(value) ? value : [value]).flatMap(value => [name, value]))}, res => {
        const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(Buffer.from(chunk))); res.on('error', reject);
        res.on('end', () => resolve({status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString()}));
      }); req.on('error', reject); req.end(body);
    });
  }
  return {proxy, server, upstream, port, request, received, routed, original, setPeer(value: string) {peer = value;}};
}

test('only an explicit source stand owns the mailbox namespace; release and production never proxy', async t => {
  for (const options of [{enabled: false}, {environment: 'production' as const}, {release: true}, {enabled: true, release: true, environment: 'production' as const}]) {
    await t.test(JSON.stringify(options), async t => {
      const h = await fixture(t, options);
      assert.equal((await h.request()).status, 418);
      assert.equal((await h.request('/__mail/api/events', wsHeaders)).status, 404);
      assert.equal(h.routed.length, 0);
    });
  }
});
test('HTTP streams the preserved path and body to fixed loopback, stripping credentials and cookie/CORS responses', async t => {
  const h = await fixture(t);
  const reply = await h.request('/__mail/api/messages?limit=5', {origin, cookie: 'forma_local_s_x=private', authorization: 'Bearer private',
    'proxy-authorization': 'private', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'evil.test',
    'content-type': 'application/json', connection: 'close, x-hidden', 'x-hidden': 'private'}, 'POST', '{"read":true}');
  assert.equal(reply.status, 200); assert.match(reply.body, /654321/);
  assert.equal(h.received[0].url, '/__mail/api/messages?limit=5'); assert.equal(h.received[0].body, '{"read":true}');
  assert.equal(h.received[0].headers.host, 'localhost:3636'); assert.equal(h.received[0].headers.origin, origin);
  for (const name of ['cookie', 'authorization', 'proxy-authorization', 'x-forwarded-for', 'x-forwarded-host', 'x-hidden'])
    assert.equal(h.received[0].headers[name], undefined, name);
  assert.equal(reply.headers['set-cookie'], undefined); assert.equal(reply.headers['access-control-allow-origin'], undefined);
  assert.equal(reply.headers['cache-control'], 'no-store'); assert.equal(reply.headers['referrer-policy'], 'no-referrer');
  assert.equal(reply.headers['cross-origin-resource-policy'], 'same-origin'); assert.equal(reply.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(reply.headers['x-mailpit'], 'ok');
  assert.equal((await h.request('/ordinary')).status, 418);
});
test('navigation and same-origin resources work for each explicit local host, with a scoped slash redirect', async t => {
  const h = await fixture(t);
  for (const host of ['localhost:3636', '127.0.0.1:3636', '[::1]:3636']) {
    assert.equal((await h.request('/__mail/', {host, 'sec-fetch-site': 'none'})).status, 200);
    assert.equal((await h.request('/__mail/assets/index.js', {host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin'})).status, 200);
  }
  const redirect = await h.request('/__mail?search=hello');
  assert.equal(redirect.status, 308); assert.equal(redirect.headers.location, '/__mail/?search=hello');
  assert.equal((await h.request('/__mail-other/')).status, 418);
});
test('LAN peers cannot use forged forwarding headers or even the correct local Origin and Host', async t => {
  const h = await fixture(t);
  for (const peer of ['192.168.1.24', '10.0.0.1', '::ffff:192.168.1.24', 'fe80::1', '']) {
    h.setPeer(peer);
    assert.equal((await h.request('/__mail/', {origin, 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1'})).status, 403);
    assert.equal((await h.request('/__mail/api/events', wsHeaders)).status, 403);
  }
  assert.equal(h.routed.length, 0);
});
test('IPv4-mapped and IPv6 loopback peers are accepted', async t => {
  const h = await fixture(t);
  for (const peer of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) {h.setPeer(peer); assert.equal((await h.request()).status, 200);}
});
test('foreign, malformed, missing and duplicate hosts fail closed before any upstream work', async t => {
  const h = await fixture(t);
  for (const host of ['evil.test:3636', 'localhost.evil.test:3636', 'localhost:8025', 'localhost', '127.1:3636',
    '2130706433:3636', 'localhost.:3636', 'user@localhost:3636', '[::ffff:127.0.0.1]:3636', '', ['localhost:3636', 'evil.test']]) {
    assert.ok([400, 403].includes((await h.request('/__mail/', {host})).status), String(host));
  }
  assert.equal(h.routed.length, 0);
});
test('foreign pages, opaque origins, sibling ports/hosts and unsafe requests without Origin are denied', async t => {
  const h = await fixture(t);
  const headers: Record<string, string | string[] | undefined>[] = [
    {origin: 'http://evil.test'}, {origin: 'null'}, {origin: 'http://localhost:8025'}, {origin: 'http://127.0.0.1:3636'},
    {origin: origin + '/'}, {origin: [origin, origin]}, {referer: 'http://evil.test/page'},
    {'sec-fetch-site': 'cross-site'}, {'sec-fetch-site': 'same-site'}, {origin, 'sec-fetch-site': 'cross-site'},
  ];
  for (const input of headers) assert.equal((await h.request('/__mail/', input)).status, 403, JSON.stringify(input));
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await h.request('/__mail/api/messages', {}, method)).status, 403);
  assert.equal((await h.request('/__mail/', {origin}, 'TRACE')).status, 405);
  assert.equal(h.routed.length, 0);
});
test('path traversal, absolute request targets and encoded path escapes never reach the upstream', async t => {
  const h = await fixture(t);
  for (const path of ['/__mail/../api/account', '/__mail/%2e%2e/api/account', '/__mail/%2f..%2fapi/account',
    '/__mail/%252e%252e/api/account', '/__mail/\\..\\api/account', '/__mail/%zz', '/__mail/hello#fragment']) {
    assert.equal((await h.request(path, {origin})).status, 400, path);
  }
  assert.equal((await h.request('http://evil.test/__mail/')).status, 418);
  assert.equal(h.routed.length, 0);
});
test('a missing or broken Mailpit produces a bounded mailbox failure while ordinary routes stay alive', async t => {
  const h = await fixture(t); h.upstream.closeAllConnections(); await new Promise<void>(resolve => h.upstream.close(() => resolve()));
  const reply = await h.request(); assert.equal(reply.status, 502); assert.doesNotMatch(reply.body, /ECONNREFUSED|8025|stack|private/);
  assert.equal(reply.headers['cache-control'], 'no-store'); assert.equal((await h.request('/ordinary')).status, 418);
});
test('upstream truncation and downstream cancellation close their counterpart without uncaught errors', async t => {
  const h = await fixture(t); h.upstream.removeAllListeners('request');
  h.upstream.on('request', (_req, res) => {res.writeHead(200, {'content-length': 100}); res.write('short'); res.destroy();});
  const broken = await h.request().then(value => value.status, () => 'closed'); assert.ok(broken === 502 || broken === 'closed');
  h.upstream.removeAllListeners('request');
  let upstreamClosed!: () => void; const closed = new Promise<void>(resolve => {upstreamClosed = resolve;});
  const entered = new Promise<void>(resolve => h.upstream.once('request', (_req, res) => {res.on('close', upstreamClosed); resolve();}));
  const req = h.original({hostname: '127.0.0.1', port: h.port, path: '/__mail/', headers: {host: 'localhost:3636'}});
  req.on('error', () => {}); req.end(); await entered; req.destroy(); await closed;
  assert.equal((await h.request('/ordinary')).status, 418);
});
test('WebSocket validates Origin and handshake, and reserves only the documented events path', async t => {
  const h = await fixture(t);
  for (const headers of [{...wsHeaders, origin: undefined}, {...wsHeaders, origin: 'http://evil.test'}, {...wsHeaders, 'sec-websocket-version': '12'},
    {...wsHeaders, 'sec-websocket-key': 'bad'}, {...wsHeaders, upgrade: 'arbitrary'}]) {
    const clean = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
    assert.ok([400, 403].includes((await h.request('/__mail/api/events', clean)).status));
  }
  assert.equal((await h.request('/__mail/arbitrary', wsHeaders)).status, 404); assert.equal(h.routed.length, 0);
});
test('WebSocket preserves both upgrade heads and live bytes, strips credentials and closes on disposal', async t => {
  const h = await fixture(t); let upstreamClosed!: () => void;
  const closed = new Promise<void>(resolve => {upstreamClosed = resolve;});
  h.upstream.on('upgrade', (req, socket, head) => {
    assert.equal(req.url, '/__mail/api/events?test=1'); assert.equal(req.headers.host, 'localhost:3636'); assert.equal(req.headers.origin, origin);
    assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.authorization, undefined);
    socket.on('error', () => {}); socket.on('end', () => socket.end()); socket.on('close', upstreamClosed);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: forma_local_s_x=bad\r\n\r\nupstream-head`);
    if (head.length) socket.write(head); socket.on('data', chunk => socket.write(chunk));
  });
  const socket = net.createConnection({host: '127.0.0.1', port: h.port}); socket.on('error', () => {});
  t.after(() => socket.destroy()); await once(socket, 'connect');
  let data = ''; const ready = new Promise<void>(resolve => socket.on('data', chunk => {data += chunk.toString(); if (data.includes('client-head')) resolve();}));
  socket.write(`GET /__mail/api/events?test=1 HTTP/1.1\r\nHost: localhost:3636\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nCookie: private\r\nAuthorization: private\r\n\r\nclient-head`);
  await ready; assert.match(data, /^HTTP\/1.1 101 /); assert.match(data, /upstream-head/); assert.doesNotMatch(data, /Set-Cookie/i);
  const next = once(socket, 'data'); socket.write('live-frame'); assert.equal((await next)[0].toString(), 'live-frame');
  const clientClosed = once(socket, 'close'); h.proxy.close(); await Promise.all([closed, clientClosed]);
  assert.equal((await h.request()).status, 503); assert.equal((await h.request('/ordinary')).status, 418);
});
test('failed WebSocket handshakes never tunnel and a refused upstream does not crash the server', async t => {
  const h = await fixture(t); assert.equal((await h.request('/__mail/api/events', wsHeaders)).status, 502); h.upstream.on('upgrade', (_req, socket) => {
    socket.on('error', () => {}); socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n');
  });
  assert.equal((await h.request('/__mail/api/events', wsHeaders)).status, 502);
  assert.equal((await h.request('/ordinary')).status, 418);
});

test('idle upstream HTTP headers and WebSocket handshakes have a bounded deadline', async t => {
  for (const websocket of [false, true]) await t.test(websocket ? 'upgrade' : 'HTTP', async t => {
    const h = await fixture(t); h.upstream.removeAllListeners('request');
    const entered = new Promise<void>(resolve => {
      if (websocket) h.upstream.once('upgrade', (_req, socket) => {socket.on('end', () => socket.end()); resolve();});
      else h.upstream.once('request', () => resolve());
    });
    t.mock.timers.enable({apis: ['setTimeout']});
    const pending = h.request(websocket ? '/__mail/api/events' : '/__mail/', websocket ? wsHeaders : {});
    await entered; t.mock.timers.tick(10_000);
    const reply = await pending; assert.equal(reply.status, 502); assert.doesNotMatch(reply.body, /654321/);
    t.mock.timers.reset(); assert.equal((await h.request('/ordinary')).status, 418);
  });
});
test('aborting an upload cancels the upstream request before its declared body is complete', async t => {
  const h = await fixture(t); h.upstream.removeAllListeners('request');
  let aborted!: () => void; const stopped = new Promise<void>(resolve => {aborted = resolve;});
  const entered = new Promise<void>(resolve => h.upstream.once('request', req => {req.on('aborted', aborted); req.on('error', () => {}); req.resume(); resolve();}));
  const req = h.original({hostname: '127.0.0.1', port: h.port, method: 'POST', path: '/__mail/api/messages',
    headers: {host: 'localhost:3636', origin, 'content-length': 100000}});
  req.on('error', () => {}); req.write('partial'); await entered; req.destroy(); await stopped;
  assert.equal((await h.request('/ordinary')).status, 418);
});
test('closing a client during a pending upgrade cancels the unfinished upstream handshake', async t => {
  const h = await fixture(t); let stopped!: () => void;
  const closed = new Promise<void>(resolve => {stopped = resolve;});
  const entered = new Promise<void>(resolve => h.upstream.once('upgrade', (_req, socket) => {
    socket.on('error', () => {}); socket.on('end', () => {stopped(); socket.end();}); resolve();
  }));
  const req = h.original({hostname: '127.0.0.1', port: h.port, path: '/__mail/api/events', headers: {host: 'localhost:3636', ...wsHeaders}});
  req.on('error', () => {}); req.end(); await entered; req.destroy(); await closed;
  assert.equal((await h.request('/ordinary')).status, 418);
});
test('HEAD and upstream HTTP statuses remain intact, and shutdown cancels active HTTP work', async t => {
  const h = await fixture(t);
  assert.equal((await h.request('/__mail/', {}, 'HEAD')).body, '');
  h.upstream.removeAllListeners('request'); h.upstream.once('request', (_req, res) => {res.writeHead(404); res.end('missing');});
  const missing = await h.request('/__mail/missing'); assert.equal(missing.status, 404); assert.equal(missing.body, 'missing');
  let stopped!: () => void; const closed = new Promise<void>(resolve => {stopped = resolve;});
  const entered = new Promise<void>(resolve => h.upstream.once('request', (_req, res) => {res.on('close', stopped); resolve();}));
  const pending = h.request().then(() => 'unexpected', () => 'closed'); await entered; h.proxy.close(); h.proxy.close();
  assert.equal(await pending, 'closed'); await closed; assert.equal((await h.request('/ordinary')).status, 418);
});

test('leaving an HTTP response mid-body closes its upstream stream', async t => {
  const h = await fixture(t); h.upstream.removeAllListeners('request');
  let stopped!: () => void; const closed = new Promise<void>(resolve => {stopped = resolve;});
  h.upstream.once('request', (_req, res) => {res.on('close', stopped); res.writeHead(200); res.write('first chunk');});
  await new Promise<void>((resolve, reject) => {
    const req = h.original({hostname: '127.0.0.1', port: h.port, path: '/__mail/', headers: {host: 'localhost:3636'}}, res => {
      res.once('data', () => {res.destroy(); resolve();}); res.on('error', () => {});
    }); req.on('error', reject); req.end();
  });
  await closed; assert.equal((await h.request('/ordinary')).status, 418);
});
test('upstream WebSocket EOF closes the browser side without affecting the ordinary site', async t => {
  const h = await fixture(t); let upstream: Duplex | undefined;
  h.upstream.once('upgrade', (_req, socket) => {
    upstream = socket; socket.on('error', () => {}); socket.on('end', () => socket.end());
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  const client = await new Promise<Socket>((resolve, reject) => {
    const req = h.original({hostname: '127.0.0.1', port: h.port, path: '/__mail/api/events', headers: {host: 'localhost:3636', ...wsHeaders}});
    req.on('error', reject); req.on('upgrade', (_res, socket) => resolve(socket)); req.end();
  });
  client.on('error', () => {}); client.resume(); t.after(() => client.destroy());
  const ended = once(client, 'close'); assert.ok(upstream); upstream.end(); await ended;
  assert.equal((await h.request('/ordinary')).status, 418);
});
