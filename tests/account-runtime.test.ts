import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { captureResponse } from './helpers/http-response.ts';
import { accountEnvironment } from '../server/runtime/account-environment.ts';
import { accountClientIp } from '../server/http/accounts.ts';
import { createAccountRuntime } from '../server/accounts.ts';

const configuration = (stateDir: string) => accountEnvironment({ FORMA_STATE_DIR: stateDir }, 3636);

test('environment keeps persistent state outside the repository and validates paired mail settings', () => {
  assert.ok(path.isAbsolute(accountEnvironment({}, 3636).stateDir));
  assert.deepEqual(accountEnvironment({}, 3636).origins, ['http://localhost:3636', 'http://127.0.0.1:3636', 'http://[::1]:3636']);
  assert.equal(accountEnvironment({}, 3636).postfix, null);
  assert.throws(() => accountEnvironment({ FORMA_POSTFIX_SOCKET: '/run/forma/control.sock' }, 3636));
  assert.throws(() => accountEnvironment({ FORMA_STATE_DIR: 'relative-data' }, 3636));
});

test('proxy headers count as client IP only for explicitly trusted loopback ingress', () => {
  const request = (ip: string, header = '203.0.113.3') => ({ socket: { remoteAddress: ip }, headers: { 'x-real-ip': header } }) as unknown as IncomingMessage;
  assert.equal(accountClientIp(false)(request('127.0.0.1')), '127.0.0.1');
  assert.equal(accountClientIp(true)(request('127.0.0.1')), '203.0.113.3');
  assert.equal(accountClientIp(true)(request('192.0.2.9')), '192.0.2.9');
  assert.equal(accountClientIp(true)(request('::ffff:127.0.0.1', 'forged, 1.2.3.4')), '127.0.0.1');
});

test('runtime opens real storage, preserves its key across restart and refuses unavailable mail honestly', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forma-runtime-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(createAccountRuntime({ configuration: { ...configuration(directory), origins: ['http://192.168.1.2:3636'] } }), /HTTPS/);
  await assert.rejects(stat(path.join(directory, 'keys')), { code: 'ENOENT' });
  const runtime = await createAccountRuntime({ configuration: configuration(directory) });
  const query = async (url: string, body?: unknown) => {
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      method: body ? 'POST' : 'GET', headers: { host: 'localhost:3636', origin: 'http://localhost:3636', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
    }) as unknown as IncomingMessage;
    const res = captureResponse(); await runtime.handler(req, res, new URL(url, 'http://localhost:3636')); return res;
  };
  try {
    const current = await query('/api/account');
    assert.equal(current.status, 200); assert.deepEqual(JSON.parse(current.body), { account: null, session: null });
    const start = await query('/api/auth/email/start', { email: 'person@example.test' });
    assert.equal(start.status, 503); assert.equal(JSON.parse(start.body).error, 'code_send_failed');
    assert.equal(start.headers['Set-Cookie'], undefined);
    assert.equal(runtime.mailConfigured, false);
  } finally { await runtime.close(); }
  const keyPath = path.join(directory, 'keys/account-hmac.bin'), key = await readFile(keyPath);
  assert.equal(key.length, 32); assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(directory, 'forma.sqlite'))).mode & 0o777, 0o600);
  const restarted = await createAccountRuntime({ configuration: configuration(directory) });
  try { assert.deepEqual(await readFile(keyPath), key); }
  finally { await restarted.close(); }
});
