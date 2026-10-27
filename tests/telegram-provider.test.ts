import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createTelegramProvider } from '../server/services/telegram-provider.ts';

const now = 1_800_000_000_000, nonce = 'n'.repeat(43);
const attempt = {nonce, createdAt: now - 60_000, expiresAt: now + 29 * 60_000};
const pair = await generateKeyPair('RS256', {extractable: true});
const keys = {keys: [{...await exportJWK(pair.publicKey), kid: 'test', alg: 'RS256', use: 'sig'}]};
const signed = () => new SignJWT({iss: 'https://oauth.telegram.org', aud: '123', sub: 'subject',
  iat: now / 1000 - 1, exp: now / 1000 + 600, nonce, id: 456})
  .setProtectedHeader({alg: 'RS256', kid: 'test'}).sign(pair.privateKey);
const json = (value: unknown) => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});

test('provider fetches only fixed Telegram keys and verifies the actual signature without retaining a key cache', async () => {
  const calls: string[] = [];
  const provider = createTelegramProvider({clientId: '123', now: () => now, fetch: async (input, options) => {
    calls.push(String(input)); assert.equal(options?.redirect, 'error'); return json(keys);
  }});
  const token = await signed();
  for (let n = 0; n < 2; n++) assert.deepEqual(await provider.verify(token, attempt),
    {subject: 'subject', userId: '456', username: null, expiresAt: now + 600_000});
  assert.deepEqual(calls, ['https://oauth.telegram.org/.well-known/jwks.json', 'https://oauth.telegram.org/.well-known/jwks.json']);
});

test('oversized decoded JWKS, excess keys, malformed JSON and HTTP failures are unavailable', async () => {
  const token = await signed();
  for (const response of [new Response('x'.repeat(65_537)), json({keys: Array(17).fill(keys.keys[0])}),
    new Response('{'), new Response('blocked', {status: 503}), json({keys: []})]) {
    const provider = createTelegramProvider({clientId: '123', now: () => now, fetch: async () => response});
    await assert.rejects(provider.verify(token, attempt), {code: 'telegram_unavailable'});
  }
});

test('deadline covers response-body reading and caller cancellation ends pending IO', async () => {
  const token = await signed(); let cancelled = false;
  const provider = createTelegramProvider({clientId: '123', now: () => now, timeoutMs: 5, fetch: async () =>
    new Response(new ReadableStream({start(controller) {controller.enqueue(new TextEncoder().encode('{'));},
      cancel() {cancelled = true;}}))});
  await assert.rejects(provider.verify(token, attempt), {code: 'telegram_unavailable'});
  assert.equal(cancelled, true);
  const abort = new AbortController(); abort.abort();
  const unused = createTelegramProvider({clientId: '123', fetch: async () => {assert.fail('cancelled verification must not fetch');}});
  await assert.rejects(unused.verify(token, attempt, {signal: abort.signal}), {name: 'AbortError'});
});

test('invalid token size is rejected before fetching and current time is read after IO', async () => {
  let time = now, calls = 0;
  const provider = createTelegramProvider({clientId: '123', now: () => time, fetch: async () => {
    calls++; time = now + 600_000; return json(keys);
  }});
  await assert.rejects(provider.verify('x'.repeat(16 * 1024 + 1), attempt), {code: 'telegram_invalid'});
  assert.equal(calls, 0);
  await assert.rejects(provider.verify(await signed(), attempt), {code: 'telegram_invalid'});
  assert.equal(calls, 1);
});

test('caller abort during response streaming cancels the body and rejects with AbortError', async () => {
  const token = await signed(), abort = new AbortController(); let entered!: () => void, cancelled = false;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const provider = createTelegramProvider({clientId: '123', now: () => now, fetch: async () =>
    new Response(new ReadableStream({start(controller) { controller.enqueue(new TextEncoder().encode('{')); entered(); },
      cancel() { cancelled = true; }}))});
  const pending = provider.verify(token, attempt, {signal: abort.signal});
  await ready; await Promise.resolve(); abort.abort();
  await assert.rejects(pending, {name: 'AbortError'}); assert.equal(cancelled, true);
});

test('response headers cannot hold the verification beyond its deadline', async () => {
  const provider = createTelegramProvider({clientId: '123', now: () => now, timeoutMs: 5,
    fetch: async () => new Promise<Response>(() => {})});
  await assert.rejects(provider.verify(await signed(), attempt), {code: 'telegram_unavailable'});
});
