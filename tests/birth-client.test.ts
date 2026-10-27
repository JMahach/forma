import test from 'node:test';
import assert from 'node:assert/strict';
import { createBirthClient } from '../src/data/birth-client.ts';
import type { requestJSON } from '../src/data/api-client.ts';
import type { CalculationRequest } from '../shared/chart-types.ts';

test('birth client forwards the same query, calculation payload and cancellation signal', async () => {
  const signal = new AbortController().signal, calls: { url: string; options: RequestInit }[] = [];
  const city = { id: '524901', name: 'Москва' }, chart = { personality: [1], design: [2] };
  const request: typeof requestJSON = async <T>(url: string, options: RequestInit = {}) => {
    calls.push({ url, options }); return (url.startsWith('/api/cities') ? { cities: [city] } : { chart }) as T;
  };
  const client = createBirthClient(request);
  assert.deepEqual(await client.findCities('Москва', signal), [city]);
  const payload: CalculationRequest = { name: 'Анна', date: '2000-01-01', time: '12:00', cityId: '524901', mode: 'natal' };
  assert.equal(await client.calculate(payload, signal), chart);
  assert.equal(calls[0].url, '/api/cities?q=%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0');
  assert.equal(calls[1].url, '/api/calculate');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body as string), payload);
  assert.ok(calls.every(call => call.options.signal === signal));
});
test('birth client retains the incomplete-calculation rejection before saving', async () => {
  for (const chart of [undefined, {}, { personality: [] }, { personality: [], design: null }]) {
    const client = createBirthClient(async <T>() => ({ chart }) as T);
    await assert.rejects(client.calculate({} as CalculationRequest, new AbortController().signal),
      { message: 'Сервер вернул неполный расчёт. Карта не сохранена.' });
  }
});
test('birth client treats absent city results as an empty list without changing failures', async () => {
  const empty = createBirthClient(async <T>() => ({ cities: null }) as T);
  assert.deepEqual(await empty.findCities('Москва', new AbortController().signal), []);
  const error = Object.assign(new Error('busy'), { code: 'busy' });
  const failed = createBirthClient(async () => { throw error; });
  await assert.rejects(failed.calculate({} as CalculationRequest, new AbortController().signal), caught => caught === error);
});

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
test('a full calculation queue waits and retries the same read-only calculation without another click', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: RequestInit[] = [], chart = {personality: [1], design: [2]};
  const client = createBirthClient(async <T>(_url: string, options: RequestInit = {}) => {
    calls.push(options);
    if (calls.length < 3) throw Object.assign(new Error('busy'), {code: 'busy', status: 503});
    return {chart} as T;
  });
  const payload: CalculationRequest = {mode: 'natal', name: 'Original'};
  const controller = new AbortController();
  const pending = client.calculate(payload, controller.signal);
  // Observe rejection immediately as well, so a broken implementation cannot hide as an unhandled error.
  const outcome = pending.then(value => ({value}), error => ({error}));
  await flush();
  assert.equal(calls.length, 1);
  payload.name = 'Changed while waiting';
  t.mock.timers.tick(499); await flush(); assert.equal(calls.length, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(calls.length, 2);
  t.mock.timers.tick(999); await flush(); assert.equal(calls.length, 2);
  t.mock.timers.tick(1); await flush(); assert.equal(calls.length, 3);
  assert.deepEqual(await outcome, {value: chart});
  assert.ok(calls.every(call => call.body === calls[0].body && call.signal === controller.signal));
  assert.equal(JSON.parse(String(calls[2].body)).name, 'Original');
});
test('cancelling admission removes the timer and prevents a late calculation request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const client = createBirthClient(async () => {
    calls++; throw Object.assign(new Error('busy'), {code: 'busy', status: 503});
  });
  const controller = new AbortController(), pending = client.calculate({mode:'natal'}, controller.signal);
  const outcome = pending.then(() => null, error => error);
  await flush(); controller.abort();
  assert.equal((await outcome).name, 'AbortError');
  t.mock.timers.tick(60_000); await flush(); assert.equal(calls, 1);
});
test('an aborted form never starts a calculation or accepts an already arriving response', async () => {
  const controller = new AbortController(); let calls = 0;
  const client = createBirthClient(async <T>() => { calls++; return {chart:{personality:[1],design:[2]}} as T; });
  controller.abort();
  await assert.rejects(client.calculate({mode:'natal'}, controller.signal), {name:'AbortError'});
  assert.equal(calls, 0);
  const next = new AbortController();
  const late = createBirthClient(async <T>() => { next.abort(); return {chart:{personality:[1],design:[2]}} as T; });
  await assert.rejects(late.calculate({mode:'natal'}, next.signal), {name:'AbortError'});
});
test('only a confirmed queue-full response is retried, never a lost response or another server failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const details of [{code:'connection_failed'}, {code:'timeout',status:503},
    {code:'engine_unavailable',status:503}, {code:'server_error',status:503},
    {code:'busy',status:422}, {code:'busy'}, {code:'ambiguous_time',status:422}]) {
    let calls = 0;
    const error = Object.assign(new Error(details.code), details);
    const client = createBirthClient(async () => { calls++; throw error; });
    await assert.rejects(client.calculate({mode:'natal'}, new AbortController().signal), caught => caught === error);
    t.mock.timers.tick(60_000); await flush(); assert.equal(calls, 1);
  }
});
