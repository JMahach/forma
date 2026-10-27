import type { IncomingMessage } from 'node:http';
import type { AccountCredentials } from '../services/accounts.ts';
import { HttpInputError } from './json.ts';

const CONTEXT = /^[a-f0-9]{32}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export function parseAccountOrigins(origins: string[]) {
  if (!origins.length) throw new TypeError('Account origins must be configured');
  const allowed = origins.map(value => {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.hostname.endsWith('.localhost');
    if (value !== url.origin || !['http:', 'https:'].includes(url.protocol)
      || (url.protocol !== 'https:' && !loopback)) throw new TypeError('Accounts require HTTPS except on local loopback');
    return url;
  });
  const secure = allowed[0]!.protocol === 'https:';
  if (allowed.some(url => (url.protocol === 'https:') !== secure)) throw new TypeError('Do not mix HTTP and HTTPS account origins');
  return allowed;
}

// One transport boundary for every endpoint that uses an account cookie.
export function createAccountSecurity({ origins, now = Date.now }: { origins: string[]; now?: () => number }) {
  const allowed = parseAccountOrigins(origins), secure = allowed[0]!.protocol === 'https:';
  const prefix = secure ? '__Host-forma_' : 'forma_local_';
  const cookieName = (kind: 'binding' | 'session', id: string) => `${prefix}${kind === 'binding' ? 'b' : 's'}_${id}`;
  function cookie(kind: 'binding' | 'session', id: string, value: string, expiresAt: number) {
    const age = value ? Math.max(0, Math.floor((expiresAt - now()) / 1000)) : 0;
    return `${cookieName(kind, id)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  }
  function credentials(header: string): AccountCredentials {
    if (Buffer.byteLength(header) > 16_384) throw new HttpInputError('too_large', 431);
    const result: AccountCredentials = { bindings: {}, sessions: {} };
    for (const item of header.split(';')) {
      const position = item.indexOf('='), name = item.slice(0, position).trim(), token = item.slice(position + 1).trim();
      if (position < 0 || !name.startsWith(prefix)) continue;
      const suffix = name.slice(prefix.length), id = suffix.slice(2);
      if (!CONTEXT.test(id) || !TOKEN.test(token)) continue;
      const values = suffix.startsWith('b_') ? result.bindings : suffix.startsWith('s_') ? result.sessions : null;
      if (values) {
        if (values[id] !== undefined) throw new HttpInputError('invalid_request', 400);
        values[id] = token;
      }
    }
    return result;
  }
  function assertOrigin(req: IncomingMessage) {
    const origin = req.headers.origin;
    if (!allowed.some(value => value.host === req.headers.host && (!origin || value.origin === origin))
      || (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '') && !origin)) {
      throw new HttpInputError('origin', 403);
    }
  }
  return { assertOrigin, credentials, cookie };
}
