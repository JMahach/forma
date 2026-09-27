import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJSON } from '../src/data/api-client.js';

test('JSON client forwards request options and returns the server payload', async t => {
  const options = { method: 'POST', body: '{"mode":"transit"}' }, payload = { chart: { id: 'test' } };
  t.mock.method(globalThis, 'fetch', async (url, actual) => {
    assert.equal(url, '/api/calculate');
    assert.equal(actual, options);
    return { ok: true, json: async () => payload };
  });
  assert.equal(await requestJSON('/api/calculate', options), payload);
});

test('JSON client keeps aborts distinguishable while explaining unavailable transport', async t => {
  const aborted = new DOMException('Aborted', 'AbortError');
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw aborted; });
  await assert.rejects(requestJSON('/api/cities'), error => error === aborted);
  fetch.mock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(requestJSON('/api/cities'), /Локальный сервер недоступен/);
});

test('JSON client preserves structured DST error choices for the birth form', async t => {
  const choices = [{ fold: 0, label: 'First' }, { fold: 1, label: 'Second' }];
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, json: async () => ({ message: 'Ambiguous time', error: 'ambiguous_time', choices }) }));
  await assert.rejects(requestJSON('/api/calculate'), error => {
    assert.equal(error.message, 'Ambiguous time');
    assert.equal(error.code, 'ambiguous_time');
    assert.equal(error.choices, choices);
    return true;
  });
});

test('JSON client reports an unreadable server response without exposing parser details', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected HTML'); } }));
  await assert.rejects(requestJSON('/api/calculate'), /Сервер расчёта не ответил/);
});
