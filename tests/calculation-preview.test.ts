import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalculationPreview } from '../src/dev/calculation-preview.ts';
import { createHttpTransport } from '../src/data/http-transport.ts';
import { createStandConnection } from '../src/dev/stand-connection.ts';

for (const exit of ['abort', 'ordinary', 'offline'] as const) test(`calculation preview holds without sending, then ${exit} cancels without replay`, async () => {
  let calls = 0;
  const preview = createCalculationPreview(async () => { calls++; return new Response('{}'); });
  const connection = createStandConnection();
  const request = createHttpTransport({connection, fetch: preview.fetch});
  preview.setWaiting(true);
  const controller = new AbortController();
  const pending = request('/api/calculate', {method:'POST',signal:controller.signal});
  const rejected = assert.rejects(pending, exit === 'offline' ? {code:'offline'} : {name:'AbortError'});
  await Promise.resolve(); assert.equal(calls,0);
  if (exit === 'abort') controller.abort();
  else if (exit === 'ordinary') preview.setWaiting(false);
  else connection.set('offline');
  await rejected; assert.equal(calls,0);
});
test('ordinary requests pass through once; the hold only concerns POST calculations', async () => {
  const calls: unknown[] = [];
  const preview = createCalculationPreview(async input => { calls.push(input); return new Response('{}'); });
  preview.setWaiting(true);
  await preview.fetch('/api/cities?q=test');
  await preview.fetch('/api/calculate', {method:'GET'});
  preview.setWaiting(false);
  await preview.fetch('/api/calculate', {method:'POST'});
  assert.deepEqual(calls,['/api/cities?q=test','/api/calculate','/api/calculate']);
});

test('a remembered preview never holds requests outside the open form', async () => {
  let calls = 0;
  const preview = createCalculationPreview(async () => {calls++; return new Response('{}');}, () => false);
  preview.setWaiting(true);
  await preview.fetch('/api/calculate',{method:'POST'});
  assert.equal(calls,1);
});
