import http, { type IncomingMessage, type ServerResponse, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';

export interface MailboxProxyOptions {
  enabled: boolean;
  environment: 'stand' | 'production';
  release: boolean;
  port: number;
}
const prefix = '/__mail/';
const eventsPath = '/__mail/api/events';
const handshakeTimeout = 10_000;
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const requestFields = ['accept', 'accept-language', 'accept-encoding', 'content-type', 'content-encoding', 'content-length',
  'origin', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions'];
const securityHeaders = {
  'cache-control': 'no-store', pragma: 'no-cache', expires: '0', 'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin', 'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN',
};
const tokens = (value: string | undefined) => (value ?? '').toLowerCase().split(',').map(value => value.trim());
function owns(req: IncomingMessage) {
  const path = (req.url ?? '').split('?')[0];
  return path === '/__mail' || path.startsWith(prefix);
}
function safePath(req: IncomingMessage) {
  const target = req.url ?? '';
  if (target.includes('#')) return false;
  try {
    const path = decodeURIComponent(target.split('?')[0]);
    return !/[\\%\x00-\x20\x7f]/.test(path) && !path.split('/').some(part => part === '.' || part === '..');
  } catch { return false; }
}
function loopback(address: string | undefined) {
  if (address === '::1') return true;
  const ipv4 = address?.startsWith('::ffff:') ? address.slice(7) : address;
  return !!ipv4 && isIP(ipv4) === 4 && ipv4.startsWith('127.');
}
function countHeader(req: IncomingMessage, name: string) {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) count++;
  return count;
}
function permitted(req: IncomingMessage, port: number, websocket: boolean) {
  if (!loopback(req.socket.remoteAddress) || countHeader(req, 'host') !== 1
    || countHeader(req, 'origin') > 1 || countHeader(req, 'referer') > 1) return false;
  const host = req.headers.host?.toLowerCase();
  if (!host || !['localhost', '127.0.0.1', '[::1]'].some(name => host === `${name}:${port}`)) return false;
  const origin = `http://${host}`, supplied = req.headers.origin;
  if (supplied !== undefined && supplied !== origin) return false;
  if ((websocket || !['GET', 'HEAD'].includes(req.method ?? '')) && supplied !== origin) return false;
  // Direct navigation may have no Origin. Fetch metadata and Referer still reject
  // foreign embeds, including same-site requests from another localhost port.
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  if (req.headers.referer !== undefined) {
    try { if (new URL(req.headers.referer).origin !== origin) return false; } catch { return false; }
  }
  return true;
}
function upstreamHeaders(req: IncomingMessage, websocket = false): OutgoingHttpHeaders {
  const excluded = new Set(tokens(req.headers.connection));
  const headers: OutgoingHttpHeaders = {host: req.headers.host};
  for (const name of requestFields) {
    if (!excluded.has(name) && req.headers[name] !== undefined && (websocket || !name.startsWith('sec-websocket-')))
      headers[name] = req.headers[name];
  }
  if (websocket) {headers.connection = 'Upgrade'; headers.upgrade = 'websocket';}
  return headers;
}
function downstreamHeaders(input: IncomingHttpHeaders): OutgoingHttpHeaders {
  const excluded = new Set([...hopHeaders, ...tokens(input.connection), 'set-cookie', 'set-cookie2', 'www-authenticate', 'authentication-info']);
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(input)) {
    if (!excluded.has(name) && !name.startsWith('access-control-') && value !== undefined) headers[name] = value;
  }
  Object.assign(headers, securityHeaders);
  // Multiple policies intersect; preserve any stronger Mailpit restrictions.
  headers['content-security-policy'] = [...(input['content-security-policy'] ? [input['content-security-policy']].flat() : []), "frame-ancestors 'self'"].join(', ');
  return headers;
}
function httpFailure(res: ServerResponse, status: number) {
  if (res.destroyed) return;
  if (res.headersSent) {res.destroy(); return;}
  res.writeHead(status, {...securityHeaders, connection: 'close', 'content-type': 'text/plain; charset=utf-8'});
  res.end(status === 502 ? 'Local mailbox unavailable' : 'Local mailbox request denied');
}
function socketFailure(socket: Duplex, status: number) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} Mailbox unavailable\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}

/** Dev-only capability. Does not read environment variables, create a listener,
 * record traffic or expose an upstream-address option. Owner must call close()
 * before waiting for server shutdown, so upgraded sockets cannot hold it open.
 * Mailpit: --listen 127.0.0.1:8025 --webroot /__mail/.
 * https://mailpit.axllent.org/docs/configuration/proxy/
 * https://mailpit.axllent.org/docs/api-v1/websocket/
 */
export function createMailboxProxy(options: MailboxProxyOptions) {
  const enabled = options.enabled === true && options.environment === 'stand' && options.release === false
    && Number.isInteger(options.port) && options.port > 0 && options.port <= 65535;
  const active = new Set<() => void>();
  let closed = false;
  return {
    handleHttp(req: IncomingMessage, res: ServerResponse): boolean {
      if (!enabled || !owns(req)) return false;
      if (closed) {httpFailure(res, 503); return true;}
      if (!permitted(req, options.port, false)) {httpFailure(res, 403); return true;}
      if (!safePath(req)) {httpFailure(res, 400); return true;}
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method ?? '')) {httpFailure(res, 405); return true;}
      if ((req.url ?? '').split('?')[0] === '/__mail') {
        res.writeHead(308, {...securityHeaders, location: prefix + ((req.url ?? '').includes('?') ? '?' + req.url!.split('?').slice(1).join('?') : '')});
        res.end(); return true;
      }
      let incoming: IncomingMessage | undefined, stopped = false;
      const outgoing = http.request({hostname: '127.0.0.1', port: 8025, path: req.url, method: req.method,
        headers: upstreamHeaders(req), agent: false});
      const stop = () => {
        if (stopped) return; stopped = true; active.delete(cancel);
        clearTimeout(deadline); req.unpipe(outgoing); outgoing.destroy(); incoming?.destroy();
        req.off('aborted', cancel); req.off('error', cancel); res.off('close', stop); res.off('finish', stop);
      };
      const cancel = () => {stop(); res.destroy();};
      const fail = () => {if (!stopped) {httpFailure(res, 502); stop();}};
      const deadline = setTimeout(fail, handshakeTimeout); deadline.unref();
      active.add(cancel); req.on('aborted', cancel); req.on('error', cancel); res.on('close', stop); res.on('finish', stop); res.on('error', cancel);
      outgoing.on('error', fail);
      outgoing.on('upgrade', (_res, socket) => {socket.destroy(); fail();});
      outgoing.on('response', response => {
        if (stopped) {response.destroy(); return;}
        incoming = response; clearTimeout(deadline);
        response.on('error', fail); response.on('aborted', fail);
        // Bound an idle HTTP body too; WebSocket uses its separate long-lived port.
        response.setTimeout(handshakeTimeout, fail);
        res.writeHead(response.statusCode ?? 502, downstreamHeaders(response.headers)); response.pipe(res);
      });
      if (req.aborted || res.destroyed) cancel(); else req.pipe(outgoing);
      return true;
    },
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
      if (!enabled || !owns(req)) return false;
      // Always consume socket errors, including denials before an upstream exists.
      socket.on('error', () => {});
      if (closed) {socketFailure(socket, 503); return true;}
      if (!permitted(req, options.port, true)) {socketFailure(socket, 403); return true;}
      if (!safePath(req)) {socketFailure(socket, 400); return true;}
      if ((req.url ?? '').split('?')[0] !== eventsPath) {socketFailure(socket, 404); return true;}
      const key = req.headers['sec-websocket-key'];
      if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' || !tokens(req.headers.connection).includes('upgrade')
        || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)
        || Buffer.from(key, 'base64').toString('base64') !== key) {socketFailure(socket, 400); return true;}
      let tunnel: Duplex | undefined, stopped = false;
      const outgoing = http.request({hostname: '127.0.0.1', port: 8025, path: req.url, method: 'GET',
        headers: upstreamHeaders(req, true), agent: false});
      const stop = () => {
        if (stopped) return; stopped = true; active.delete(cancel); clearTimeout(deadline);
        outgoing.destroy(); tunnel?.destroy(); socket.off('close', cancel); socket.off('end', cancel);
      };
      const cancel = () => {stop(); socket.destroy();};
      const fail = () => {if (!stopped) {stop(); socketFailure(socket, 502);}};
      const deadline = setTimeout(fail, handshakeTimeout); deadline.unref();
      active.add(cancel); socket.on('close', cancel); socket.on('end', cancel); socket.on('error', cancel);
      outgoing.on('error', fail);
      outgoing.on('response', response => {response.destroy(); fail();});
      outgoing.on('upgrade', (response, upstream, upstreamHead) => {
        if (stopped) {upstream.destroy(); return;}
        tunnel = upstream; upstream.on('error', cancel); upstream.on('close', cancel);
        const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (response.statusCode !== 101 || response.headers.upgrade?.toLowerCase() !== 'websocket'
          || !tokens(response.headers.connection).includes('upgrade') || response.headers['sec-websocket-accept'] !== expected) {fail(); return;}
        clearTimeout(deadline); upstream.setTimeout(0);
        const headers = downstreamHeaders(response.headers); delete headers['content-length'];
        headers.connection = 'Upgrade'; headers.upgrade = 'websocket';
        const lines = Object.entries(headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(value => `${name}: ${value}`));
        socket.write('HTTP/1.1 101 Switching Protocols\r\n' + lines.join('\r\n') + '\r\n\r\n');
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) upstream.write(head);
        upstream.pipe(socket); socket.pipe(upstream);
      });
      if (socket.destroyed) cancel(); else outgoing.end();
      return true;
    },
    close() {if (closed) return; closed = true; for (const cancel of [...active]) cancel();},
  };
}
