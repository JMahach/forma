import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { captureResponse } from './helpers/http-response.ts';
import { openDatabase } from '../server/storage/database.ts';
import { createAccounts } from '../server/services/accounts.ts';
import type { CodeMail } from '../server/mail/code-mail.ts';
import { createAccountHandler } from '../server/http/accounts.ts';
import { createCityCatalog } from '../server/services/cities.ts';

interface TestBody { attempt?: { id: string }; account?: { id: string; email: string } | null; needsConfirmation?: boolean; session?: {id:string; diagnosticProof?:string} }

function fixture(t: { after: (fn: () => void) => void }) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const messages: CodeMail[] = [];
  const now = () => 1_000_000;
  const accounts = createAccounts({ database: db, key: Buffer.alloc(32, 7), now,
    mail: { async enqueue(message) { messages.push(message); }, async cancel() {} } });
  const handle = createAccountHandler(accounts, { origins: ['https://forma.example.test'], now });
  const jar = new Map<string, string>();
  function apply(headers: string[]) {
    for (const header of headers) {
      const [pair] = header.split(';'), at = pair!.indexOf('=');
      const name = pair!.slice(0, at), value = pair!.slice(at + 1);
      if (/Max-Age=0(?:;|$)/.test(header)) jar.delete(name); else jar.set(name, value);
    }
  }
  async function request(url: string, body?: unknown, options: { origin?: string | null; apply?: boolean } = {}) {
    const input = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    const req = Object.assign(input, { method: body === undefined ? 'GET' : 'POST', url,
      headers: { host: 'forma.example.test', 'content-type': 'application/json',
        cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
        ...(options.origin === null ? {} : { origin: options.origin ?? 'https://forma.example.test' }) },
      socket: { remoteAddress: '192.0.2.1' } }) as unknown as IncomingMessage;
    const res = captureResponse();
    await handle(req, res, new URL(url, 'https://forma.example.test'));
    const cookies = (res.headers['Set-Cookie'] ?? []) as string[];
    if (options.apply !== false) apply(cookies);
    return { status: res.status, body: JSON.parse(res.body) as TestBody, cookies };
  }
  return { request, apply, messages, jar };
}

test('HTTP issues secure host cookies, keeps secrets out of JSON and requires confirmation', async t => {
  const f = fixture(t);
  const start = await f.request('/api/auth/email/start', { email: 'person@example.test' });
  assert.equal(start.status, 200);
  assert.equal(start.cookies.length, 1);
  assert.match(start.cookies[0]!, /^__Host-forma_b_[a-f0-9]{32}=/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(start.cookies[0]!.includes(flag));
  assert.equal(JSON.stringify(start.body).includes('secret'), false);
  const attemptId = start.body.attempt!.id;
  const verified = await f.request('/api/auth/email/verify', { attemptId, code: f.messages[0]!.code });
  assert.equal(verified.body.needsConfirmation, true);
  assert.equal(verified.body.session, undefined);
  assert.equal((await f.request('/api/account')).body.account, null);
  const confirmed = await f.request('/api/auth/confirm', { attemptId });
  assert.equal(confirmed.body.account!.email, 'person@example.test');
  assert.match(confirmed.body.session!.diagnosticProof!, /^v1\.[1-9][0-9]*\.[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/);
  assert.equal((await f.request('/api/account')).body.session!.diagnosticProof, confirmed.body.session!.diagnosticProof);
  assert.equal((await f.request('/api/account')).body.account!.email, 'person@example.test');
  assert.ok([...f.jar.keys()].every(name => name.startsWith('__Host-forma_s_')));
});

test('a delayed verify Set-Cookie cannot restore login after logout', async t => {
  const f = fixture(t);
  const start = await f.request('/api/auth/email/start', { email: 'person@example.test' });
  const attemptId = start.body.attempt!.id;
  const verify = await f.request('/api/auth/email/verify', { attemptId, code: f.messages[0]!.code }, { apply: false });
  assert.equal((await f.request('/api/auth/logout', { sessionId: attemptId })).status, 200);
  f.apply(verify.cookies);
  const account = await f.request('/api/account');
  assert.equal(account.body.account, null);
  assert.equal(f.jar.size, 0);
  assert.equal((await f.request('/api/auth/confirm', { attemptId })).status, 410);
});

test('POST rejects missing, wrong-scheme and wrong-port origins before sending a code', async t => {
  const f = fixture(t);
  for (const origin of [null, 'http://forma.example.test', 'https://forma.example.test:3636', 'https://other.example.test']) {
    assert.equal((await f.request('/api/auth/email/start', { email: 'person@example.test' }, { origin })).status, 403);
  }
  assert.equal(f.messages.length, 0);
});

test('an insecure LAN origin cannot enable account cookies', t => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const accounts = createAccounts({ database: db, key: Buffer.alloc(32, 7), mail: { async enqueue() {}, async cancel() {} } });
  assert.throws(() => createAccountHandler(accounts, { origins: ['http://192.168.1.5:3636'] }), /HTTPS/);
  assert.doesNotThrow(() => createAccountHandler(accounts, { origins: ['http://127.0.0.1:3636'] }));
});

test('the main router passes account paths to their owner and never serves HTML for them', async () => {
  const { createRequestHandler } = await import('../server/http/app.ts');
  let called = false;
  const accountHandler: ReturnType<typeof createAccountHandler> = async (_req, res) => {
    called = true; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"account":null}');
  };
  const base = { root: '/unused', cities: createCityCatalog([]), calculate: async () => { throw new Error('must not calculate'); } };
  const handler = createRequestHandler({ ...base, accountHandler,
    publicFiles: () => { throw new Error('Account route must not serve public files'); },
  });
  const req = { method: 'GET', url: '/api/account', headers: {} } as IncomingMessage;
  const res = captureResponse();
  await handler(req, res);
  assert.equal(called, true); assert.equal(res.status, 200);
  const unavailable = createRequestHandler({ ...base, publicFiles: () => { throw new Error('must not serve HTML'); }
  });
  const absent = captureResponse(); await unavailable(req, absent);
  assert.equal(absent.status, 503);
  assert.equal(JSON.parse(absent.body).error, 'account_unavailable');
});

test('database failure returns an internal error without clearing unverified cookies', async () => {
  const db = openDatabase(':memory:');
  const accounts = createAccounts({ database: db, key: Buffer.alloc(32, 7), mail: { async enqueue() {}, async cancel() {} } });
  const handler = createAccountHandler(accounts, { origins: ['http://localhost:3636'] });
  db.close();
  const req = { method: 'GET', headers: { host: 'localhost:3636',
    cookie: `forma_local_s_${'a'.repeat(32)}=${'b'.repeat(43)}` } } as IncomingMessage;
  const res = captureResponse();
  await assert.doesNotReject(handler(req, res, new URL('http://localhost:3636/api/account')));
  assert.equal(res.status, 500);
  assert.equal(JSON.parse(res.body).error, 'internal_error');
  assert.equal(res.headers['Set-Cookie'], undefined);
});

test('common attempt, cancel and confirm share the existing email lifecycle', async t => {
  const f = fixture(t);
  const first = await f.request('/api/auth/email/start', {email: 'cancel@example.test'});
  const firstId = first.body.attempt!.id;
  const common = await f.request('/api/auth/attempt?id=' + firstId);
  assert.equal(common.status, 200);
  assert.equal((common.body as {stage: string}).stage, 'code');
  assert.equal((await f.request('/api/auth/cancel', {attemptId: firstId})).status, 200);
  assert.equal((await f.request('/api/auth/attempt?id=' + firstId)).status, 410);
  const second = await f.request('/api/auth/email/start', {email: 'confirm@example.test'});
  const secondId = second.body.attempt!.id;
  await f.request('/api/auth/email/verify', {attemptId: secondId, code: f.messages.at(-1)!.code});
  const confirmed = await f.request('/api/auth/confirm', {attemptId: secondId});
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.account!.email, 'confirm@example.test');
  assert.deepEqual((await f.request('/api/auth/confirm', {attemptId: secondId})).body, confirmed.body);
});
