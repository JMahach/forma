import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJSON } from '../src/data/api-client.ts';
import { createLifetimeClient } from '../src/data/lifetime-client.ts';
import { failureMessage, UI_MESSAGES } from '../src/ui/messages.ts';

for (const client of ['json', 'lifetime'] as const) {
  test(`${client}: HTTP 503 preserves the explicit reason and diagnostic data`, async t => {
    for (const code of ['busy', 'engine_unavailable']) {
      const body = { error: code, message: 'Technical details for diagnostics', retryAfter: 5 };
      const send = async () => new Response(JSON.stringify(body), { status: 503 });
      if (client === 'json') t.mock.method(globalThis, 'fetch', send);
      const request = client === 'json' ? requestJSON('/api/calculate') : createLifetimeClient({ fetch: send }).getMeta();
      await assert.rejects(request, (error: Error & { code?: string; status?: number; details?: unknown }) => {
        assert.equal(error.code, code); assert.equal(error.status, 503); assert.deepEqual(error.details, body);
        assert.equal(failureMessage(error, error.message), UI_MESSAGES.serverError);
        if (client === 'json') assert.equal(failureMessage(error, error.message, 'chart-form'), code === 'busy' ? UI_MESSAGES.calculationBusy : UI_MESSAGES.serverError);
        return true;
      });
    }
  });
  test(`${client}: an unknown or unusable HTTP 503 body retains status and a safe fallback`, async t => {
    for (const body of [null, [], { message: 'Internal engine details' }, '<html>not JSON</html>']) {
      const send = async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 503 });
      if (client === 'json') t.mock.method(globalThis, 'fetch', send);
      const request = client === 'json' ? requestJSON('/api/calculate') : createLifetimeClient({ fetch: send }).getMeta();
      await assert.rejects(request, (error: Error & { code?: string; status?: number }) => {
        assert.equal(error.code, 'server_error'); assert.equal(error.status, 503);
        assert.equal(failureMessage(error, error.message), UI_MESSAGES.serverError);
        return true;
      });
    }
  });
}
