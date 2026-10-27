import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { createAccountSecurity } from '../server/http/account-security.ts';

const origins = ['https://forma.example.test'];
function request(method: string, origin?: string, host = 'forma.example.test') {
  return { method, headers: { host, ...(origin === undefined ? {} : { origin }) } } as IncomingMessage;
}
test('all account-backed mutations use the same exact origin protection', () => {
  const security = createAccountSecurity({ origins });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const origin of [undefined, 'http://forma.example.test', 'https://forma.example.test:3636', 'null']) {
      assert.throws(() => security.assertOrigin(request(method, origin)), { code: 'origin', status: 403 });
    }
    assert.doesNotThrow(() => security.assertOrigin(request(method, origins[0])));
  }
  assert.doesNotThrow(() => security.assertOrigin(request('GET')));
  assert.throws(() => security.assertOrigin(request('GET', undefined, 'attacker.test')), { code: 'origin' });
  assert.throws(() => security.assertOrigin(request('GET', 'https://attacker.test')), { code: 'origin' });
});
test('the shared credential reader rejects duplicates and oversized headers, ignores foreign and malformed cookies', () => {
  const security = createAccountSecurity({ origins });
  const id = 'a'.repeat(32), token = 'b'.repeat(43), pair = `__Host-forma_s_${id}=${token}`;
  assert.deepEqual(security.credentials(`other=value; ${pair}; forma_local_s_${id}=${token}; __Host-forma_b_bad=bad`),
    { bindings: {}, sessions: { [id]: token } });
  assert.throws(() => security.credentials(`${pair}; ${pair}`), { code: 'invalid_request' });
  assert.throws(() => security.credentials('x'.repeat(16_385)), { status: 431 });
});
test('cookie lifetime and flags are shared across handlers, with loopback-only insecure mode', () => {
  const secure = createAccountSecurity({ origins, now: () => 1000 });
  assert.equal(secure.cookie('session', 'a'.repeat(32), 'b'.repeat(43), 6000),
    `__Host-forma_s_${'a'.repeat(32)}=${'b'.repeat(43)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=5; Secure`);
  const local = createAccountSecurity({ origins: ['http://localhost:3636'], now: () => 1000 });
  assert.match(local.cookie('session', 'a'.repeat(32), '', 0), /^forma_local_s_.*Max-Age=0$/);
  assert.throws(() => createAccountSecurity({ origins: ['http://192.168.1.20:3636'] }), /HTTPS/);
});
