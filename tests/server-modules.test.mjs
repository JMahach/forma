import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createCityCatalog } from '../server/services/cities.mjs';
import { createCalculator, CALCULATOR_LIMITS } from '../server/services/calculate.mjs';
import { createRequestHandler } from '../server/http/app.mjs';
import { PUBLIC_FILES } from '../server/http/public-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const city = (id, name, aliases = [name]) => ({ id, name, aliases, country: 'RU', region: 'Region', timezone: 'Europe/Moscow', latitude: 55.75, longitude: 37.62, population: 1000 });
const cities = createCityCatalog([city('prefix', 'Moscow Heights'), city('contains', 'West Moscow'), city('524901', 'Москва', ['Moscow', 'Москва', 'Moskva']), city('accent', 'Évry'), city('yo', 'Орёл')]);

test('city catalogue preserves exact-prefix-substring ranking, normalization and trusted identity', () => {
  assert.deepEqual(cities.search('Moscow').map(value => value.id), ['524901', 'prefix', 'contains']);
  for (const query of ['МОСКВА', 'Moskva', 'Móscow']) assert.equal(cities.search(query)[0].id, '524901');
  assert.equal(cities.search('Evry')[0].id, 'accent');
  assert.equal(cities.search('Орел')[0].id, 'yo');
  assert.deepEqual(cities.search('M'), []);
  assert.equal(cities.find(524901, 'Москва').name, 'Москва');
  assert.equal(cities.find('524901', '<script>forged</script>').name, 'Moscow');
  assert.equal(cities.find('unknown'), null);
  assert.ok(!Object.hasOwn(cities.find('524901'), 'aliases'));
  assert.ok(!Object.hasOwn(cities.find('524901'), 'population'));
  assert.equal(createCityCatalog(Array.from({ length: 20 }, (_, index) => city(String(index), `Moscow ${index}`))).search('Moscow').length, 12);
});

async function request(handler, url, { method = 'GET', value, body = value === undefined ? '' : JSON.stringify(value), headers = {} } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  Object.assign(req, { url, method, headers: { host: 'localhost:4173', 'content-type': 'application/json', ...headers } });
  const res = {
    headersSent: false, status: 0, headers: {}, body: '',
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; this.headersSent = true; return this; },
    end(body) { this.body = body?.toString() || ''; return this; },
  };
  await handler(req, res);
  return { ...res, json: () => JSON.parse(res.body) };
}

test('HTTP handler resolves authoritative cities and retains response statuses and input limits', async () => {
  const inputs = [];
  const handler = createRequestHandler({ root, cities, calculate: async input => { inputs.push(input); return input.result || { chart: { source: input.mode } }; } });
  const response = await request(handler, '/api/calculate', { method: 'POST', value: { mode: 'natal', cityId: '524901', cityName: 'Москва', city: { timezone: 'UTC' } } });
  assert.equal(response.status, 200);
  assert.equal(inputs[0].city.timezone, 'Europe/Moscow');
  assert.equal(inputs[0].city.name, 'Москва');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal((await request(handler, '/api/cities?q=Moscow')).json().cities[0].id, '524901');
  for (const [options, status, error] of [
    [{ value: { cityId: 'unknown', city: { timezone: 'UTC' } } }, 422, 'city_required'],
    [{ body: '{' }, 400, 'invalid_json'],
    [{ value: null }, 400, 'invalid_request'],
    [{ value: [] }, 400, 'invalid_request'],
    [{ value: {}, headers: { 'content-type': 'text/plain' } }, 415, 'content_type'],
    [{ body: ' '.repeat(20001) }, 413, 'too_large'],
    [{ body: '{}' + ' '.repeat(19998) }, 422, 'city_required'],
    [{ value: {}, headers: { origin: 'https://unrelated.example' } }, 403, 'origin'],
  ]) {
    const result = await request(handler, '/api/calculate', { method: 'POST', ...options });
    assert.equal(result.status, status); assert.equal(result.json().error, error);
  }
  assert.equal(inputs.length, 1, 'invalid requests never start a calculation');
  for (const [error, expected] of [['busy', 503], ['engine_unavailable', 503], ['timeout', 422], ['ambiguous_time', 422]]) {
    const result = await request(handler, '/api/calculate', { method: 'POST', value: { mode: 'transit', result: { error } } });
    assert.equal(result.status, expected); assert.equal(result.json().error, error);
  }
  assert.equal((await request(handler, '/api/calculate', { method: 'POST', value: { mode: 'transit' }, headers: { origin: 'http://localhost:4173' } })).status, 200);
});

test('static serving exposes the explicit public files and preserves private paths, HEAD and method rules', async () => {
  const handler = createRequestHandler({ root, cities, calculate: () => { throw new Error('Static requests must not calculate'); } });
  for (const path of ['/', ...[...PUBLIC_FILES.keys()].map(key => `/${key}`)]) {
    const response = await request(handler, path);
    assert.equal(response.status, 200, path);
    assert.ok(response.body.length > 0, path);
    assert.equal(response.headers['Cache-Control'], 'no-cache');
  }
  const head = await request(handler, '/', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.body, '');
  const post = await request(handler, '/', { method: 'POST' });
  assert.equal(post.status, 405); assert.equal(post.headers.Allow, 'GET, HEAD');
  for (const path of ['/server/http/app.mjs', '/server/http/public-files.mjs', '/server/services/cities.mjs', '/server/services/calculate.mjs', '/data/cities.json', '/.git/config', '/.venv/pyvenv.cfg', '/tests/previews/preview-harness.js', '/src/../server/python/calculator.py', '/src/%2e%2e/server/python/calculator.py']) {
    assert.equal((await request(handler, path)).status, 404, path);
  }
});

function workerHarness(limits = CALCULATOR_LIMITS) {
  const workers = [], calls = [];
  const calculate = createCalculator({ root, limits, spawnWorker(...args) {
    calls.push(args);
    const worker = new EventEmitter();
    worker.stdout = new EventEmitter(); worker.stdout.setEncoding = encoding => { worker.encoding = encoding; };
    worker.stdin = new EventEmitter(); worker.stdin.end = input => { worker.input = input; };
    worker.kill = () => { worker.killed = true; };
    workers.push(worker);
    return worker;
  } });
  return { calculate, workers, calls };
}

test('calculator keeps four-process admission, JSON protocol and releases slots on each completion path', async () => {
  assert.deepEqual(CALCULATOR_LIMITS, { concurrency: 4, timeoutMs: 15000, outputCharacters: 100000 });
  const { calculate, workers, calls } = workerHarness();
  const pending = Array.from({ length: 4 }, () => calculate({ mode: 'transit' }));
  assert.equal((await calculate({ mode: 'transit' })).error, 'busy');
  assert.equal(workers.length, 4);
  assert.ok(calls[0][0].endsWith('/.venv/bin/python'));
  assert.ok(calls[0][1][0].endsWith('/server/python/calculator.py'));
  assert.deepEqual(calls[0][2], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
  assert.equal(workers[0].input, '{"mode":"transit"}');
  assert.equal(workers[0].encoding, 'utf8');
  workers[0].stdout.emit('data', '{"chart":'); workers[0].stdout.emit('data', '{}}'); workers[0].emit('close', 0);
  workers[1].stdout.emit('data', 'invalid JSON'); workers[1].emit('close', 0);
  workers[2].stdin.emit('error', new Error('closed pipe'));
  assert.equal(workers[2].killed, true);
  workers[2].emit('close', null);
  workers[3].emit('close', 1);
  const results = await Promise.all(pending);
  assert.deepEqual(results[0], { chart: {} });
  assert.ok(results.slice(1).every(result => result.error === 'engine_unavailable'));
  const again = calculate({ mode: 'transit' });
  assert.equal(workers.length, 5);
  workers[4].emit('error', new Error('spawn unavailable'));
  assert.equal((await again).error, 'engine_unavailable');
});

test('calculator terminates excessive output and timed-out workers without accepting late results', async () => {
  const oversized = workerHarness();
  const result = oversized.calculate({ mode: 'transit' });
  oversized.workers[0].stdout.emit('data', 'x'.repeat(100001));
  assert.equal(oversized.workers[0].killed, true);
  oversized.workers[0].stdout.emit('data', '{}'); oversized.workers[0].emit('close', 0);
  assert.equal((await result).error, 'engine_unavailable');
  const timeout = workerHarness({ ...CALCULATOR_LIMITS, timeoutMs: 1 });
  const timedOut = timeout.calculate({ mode: 'transit' });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(timeout.workers[0].killed, true);
  timeout.workers[0].emit('close', null);
  assert.equal((await timedOut).error, 'timeout');
});

test('calculator holds all four admission slots until failed live processes close', async () => {
  for (const reason of ['stdin', 'output', 'timeout', 'process']) {
    const limits = { ...CALCULATOR_LIMITS, timeoutMs: reason === 'timeout' ? 1 : 1000 };
    const { calculate, workers } = workerHarness(limits);
    const pending = Array.from({ length: 4 }, () => calculate({ mode: 'transit' }));
    let completed = 0;
    pending.forEach(result => result.then(() => { completed++; }));
    if (reason === 'stdin') workers[0].stdin.emit('error', new Error('pipe'));
    if (reason === 'output') workers[0].stdout.emit('data', 'x'.repeat(limits.outputCharacters + 1));
    if (reason === 'timeout') await new Promise(resolve => setTimeout(resolve, 5));
    if (reason === 'process') {
      workers[0].emit('spawn');
      workers[0].emit('error', new Error('live process failure'));
    }
    await Promise.resolve();
    assert.equal(completed, 0, reason);
    assert.equal(workers[0].killed, true, reason);
    assert.equal((await calculate({ mode: 'transit' })).error, 'busy', reason);
    assert.equal(workers.length, 4, reason);
    for (const worker of workers) worker.emit('close', null);
    const results = await Promise.all(pending);
    assert.equal(results[0].error, reason === 'timeout' ? 'timeout' : 'engine_unavailable');
    const next = calculate({ mode: 'transit' });
    assert.equal(workers.length, 5);
    workers[4].stdout.emit('data', '{}'); workers[4].emit('close', 0);
    assert.deepEqual(await next, {});
  }
});
