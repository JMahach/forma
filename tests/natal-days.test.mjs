import { createNatalDayHandler, validateNatalDayRequest } from '../server/http/natal-days.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createNatalDays, generateNatalDay, encodeNatalDayPacket } from '../server/services/natal-days.mjs';
import { decodeNatalDay } from '../shared/day-packets/decode.js';
import { chartAtMinute, natalDayMinute } from '../src/domain/natal-day.js';
import { createRequestHandler } from '../server/http/app.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cities = { find: id => id === 'trusted' ? { timezone: 'Europe/Moscow' } : null };
const makeDay = (date, timezone) => ({ date, timezone, startUtc: `${date}T00:00:00Z`, samples: 10, stepSeconds: 60,
  segments: [{ index: 0, startUtc: `${date}T00:00:00Z`, offsetSeconds: 0, utcOffset: 'UTC+00:00', fold: 0 }],
  columns: Array.from({ length: 24 }, (_, column) => Array.from({ length: 10 }, (_, minute) => column < 22 ? 10 + column * 10 + minute / 10000 : column === 22 ? Date.parse(date) / 1000 - 88 * 86400 + minute * 60 : 1e-10)),
  engine: 'Swiss Ephemeris test', ephemeris: 'Test ephemerides', timezoneDatabase: 'IANA test', nodeModel: 'true', zodiac: 'tropical-geocentric-apparent' });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { resolve, promise }; };
const tick = () => new Promise(setImmediate);

test('request uses only trusted city timezone and strictly validates date, city and version', () => {
  assert.deepEqual(validateNatalDayRequest({ birthDate: '1990-06-15', cityId: 'trusted', v: '1', timezone: 'UTC', city: { timezone: 'UTC' }, name: 'Never forwarded' }, cities), { date: '1990-06-15', timezone: 'Europe/Moscow' });
  for (const change of [{ birthDate: '1990-02-30' }, { birthDate: '1800-01-01' }, { birthDate: '2400-01-01' }, { cityId: 'forged' }, { cityId: {} }, { v: '2' }]) {
    assert.throws(() => validateNatalDayRequest({ birthDate: '1990-06-15', cityId: 'trusted', v: '1', ...change }, cities));
  }
});

test('singleflight queue runs one day at a time and short-lived memory never survives service replacement', async () => {
  let instant = 0, active = 0, maximum = 0;
  const release = deferred(), calls = [];
  const service = createNatalDays({ root, now: () => instant, capacity: 2, ttlMs: 100, generateDay: async (date, timezone) => {
    calls.push([date, timezone]); active++; maximum = Math.max(maximum, active);
    if (calls.length === 1) await release.promise;
    active--; return makeDay(date, timezone);
  } });
  const first = service.get('1990-06-15', 'UTC');
  assert.equal(service.get('1990-06-15', 'UTC'), first);
  const queued = ['16', '17', '18'].map(date => service.get(`1990-06-${date}`, 'UTC'));
  assert.equal(service.queued, 3);
  await assert.rejects(service.get('1990-06-19', 'UTC'), error => error.code === 'natal_day_busy');
  release.resolve(); await Promise.all([first, ...queued]);
  assert.equal(maximum, 1); assert.equal(calls.length, 4); assert.equal(service.size, 2);
  await service.get('1990-06-18', 'UTC'); assert.equal(calls.length, 4);
  instant = 101; assert.equal(service.size, 0);
  await service.get('1990-06-18', 'UTC'); assert.equal(calls.length, 5);
  const replacement = createNatalDays({ root, generateDay: async (date, timezone) => { calls.push([date, timezone]); return makeDay(date, timezone); } });
  await replacement.get('1990-06-18', 'UTC'); assert.equal(calls.length, 6);
});

test('failed generation releases admission and same day can be retried', async () => {
  let calls = 0;
  const service = createNatalDays({ root, generateDay: async (date, timezone) => { if (++calls === 1) throw new Error('Unavailable'); return makeDay(date, timezone); } });
  await assert.rejects(service.get('1990-06-15', 'UTC'));
  assert.equal(service.size, 0);
  assert.equal(decodeNatalDay((await service.get('1990-06-15', 'UTC')).bytes.identity).date, '1990-06-15');
});

test('disconnected natal requests release queued admission for the latest day', async t => {
  const held = deferred(), calls = [];
  const service = createNatalDays({ generateDay: async (date, timezone) => {
    calls.push(date); await held.promise; return makeDay(date, timezone);
  } });
  const handle = createNatalDayHandler(service), requests = [];
  t.after(async () => { held.resolve(); await Promise.all(requests.map(item => item.done)); });
  function start(date) {
    const req = Readable.from([Buffer.from(JSON.stringify({ birthDate: date, cityId: 'trusted', v: '1' }))]);
    req.method = 'POST'; req.complete = true; req.headers = { 'content-type': 'application/json' };
    const res = new EventEmitter();
    res.writeHead = status => { assert.ok(!res.destroyed, 'no response after disconnect'); res.status = status; };
    res.end = body => { res.body = body; res.writableEnded = true; };
    const item = { res, done: handle(req, res, cities) }; requests.push(item); return item;
  }
  const obsolete = ['15', '16', '17', '18'].map(day => start(`1990-06-${day}`));
  await tick(); assert.equal(service.queued, 3);
  obsolete.forEach(({ res }) => { res.destroyed = true; res.emit('close'); });
  await tick(); assert.equal(service.queued, 0);
  const latest = start('1990-06-19'); await tick(); assert.equal(service.queued, 1);
  held.resolve(); await latest.done;
  assert.equal(latest.res.status, 200);
  assert.deepEqual(calls, ['1990-06-15', '1990-06-19']);
});

test('natal cancellation keeps shared queued consumers and the active process slot', async t => {
  const held = deferred(), calls = [], outcomes = [];
  const service = createNatalDays({ generateDay: async (date, timezone) => {
    calls.push(date); await held.promise; return makeDay(date, timezone);
  } });
  const outcome = promise => { const result = promise.then(() => 'ready', error => error.name); outcomes.push(result); return result; };
  t.after(async () => { held.resolve(); await Promise.all(outcomes); });
  const active = new AbortController(), first = new AbortController(), second = new AbortController();
  const running = outcome(service.get('1990-06-15', 'UTC', { signal: active.signal }));
  const queued = outcome(service.get('1990-06-16', 'UTC', { signal: first.signal }));
  const shared = outcome(service.get('1990-06-16', 'UTC', { signal: second.signal }));
  first.abort(); await tick();
  assert.equal(await Promise.race([queued, Promise.resolve('pending')]), 'AbortError');
  assert.equal(service.queued, 1);
  second.abort(); await tick();
  assert.equal(await Promise.race([shared, Promise.resolve('pending')]), 'AbortError');
  assert.equal(service.queued, 0);
  active.abort(); await tick();
  assert.equal(await Promise.race([running, Promise.resolve('pending')]), 'AbortError');
  const resumed = outcome(service.get('1990-06-15', 'UTC'));
  const latest = outcome(service.get('1990-06-17', 'UTC'));
  assert.deepEqual(calls, ['1990-06-15']); assert.equal(service.queued, 1);
  held.resolve(); assert.equal(await resumed, 'ready'); assert.equal(await latest, 'ready');
  assert.deepEqual(calls, ['1990-06-15', '1990-06-17']);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(service.get('1990-06-15', 'UTC', { signal: cancelled.signal }), { name: 'AbortError' });
});

test('a natal disconnect during upload never submits calculation work', async t => {
  let calls = 0;
  const req = new PassThrough(); req.method = 'POST'; req.headers = { 'content-type': 'application/json' };
  const res = new EventEmitter(); res.writeHead = () => { throw Error('disconnected response'); }; res.end = () => {};
  const handled = createNatalDayHandler({ get() { calls++; } })(req, res, cities);
  handled.catch(() => {}); t.after(() => req.destroy());
  req.write('{"birthDate":'); res.emit('close'); await tick();
  assert.equal(req.destroyed, true); await handled; assert.equal(calls, 0);
});

async function request(service, { method = 'POST', value = { birthDate: '1990-06-15', cityId: 'trusted', v: '1' }, body = JSON.stringify(value), headers = {} } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  Object.assign(req, { url: '/api/chart/day', method, headers: { host: 'localhost', 'content-type': 'application/json', ...headers } });
  const res = { headersSent: false, writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(body) { this.body = body; } };
  await createRequestHandler({ root, cities, natalDays: service })(req, res);
  return res;
}
test('POST returns private negotiated lossless bytes; invalid requests never reach a worker', async () => {
  const calls = [];
  const service = createNatalDays({ root, generateDay: async (date, timezone) => { calls.push([date, timezone]); return makeDay(date, timezone); } });
  for (const [accept, encoding, unpack] of [['br,gzip', 'br', brotliDecompressSync], ['gzip', 'gzip', gunzipSync], ['identity', undefined, value => value]]) {
    const result = await request(service, { headers: { 'accept-encoding': accept } });
    assert.equal(result.status, 200); assert.equal(result.headers['Content-Encoding'], encoding);
    assert.equal(result.headers['Cache-Control'], 'private, no-store'); assert.equal(result.headers.ETag, undefined);
    assert.equal(result.headers['Content-Length'], result.body.length);
    assert.equal(decodeNatalDay(unpack(result.body)).timezone, 'Europe/Moscow');
  }
  assert.deepEqual(calls, [['1990-06-15', 'Europe/Moscow']]);
  for (const [options, status] of [[{ method: 'GET' }, 405], [{ method: 'HEAD' }, 405], [{ body: '[]' }, 400], [{ body: '{' }, 400],
    [{ body: ' '.repeat(1025) }, 413], [{ headers: { 'content-type': 'text/plain' } }, 415],
    [{ headers: { origin: 'https://other.example' } }, 403], [{ headers: { 'accept-encoding': '*;q=0' } }, 406]]) {
    assert.equal((await request(service, options)).status, status);
  }
  assert.equal(calls.length, 1);
});

test('batch worker sends only date/zone, ignores stderr and waits for termination before releasing slot', async () => {
  let worker, args;
  const result = generateNatalDay({ root, date: '1990-06-15', timezone: 'Europe/Moscow', timeoutMs: 1, spawnWorker(...values) {
    args = values; worker = new EventEmitter(); worker.stdout = new EventEmitter(); worker.stdout.setEncoding = () => {};
    worker.stdin = new EventEmitter(); worker.stdin.end = input => { worker.input = input; };
    worker.kill = signal => { worker.killed = signal; }; return worker;
  } });
  assert.deepEqual(JSON.parse(worker.input), { date: '1990-06-15', timezone: 'Europe/Moscow' });
  assert.deepEqual(args[2].stdio, ['pipe', 'pipe', 'ignore']);
  let finished = false; result.catch(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(worker.killed, 'SIGKILL'); assert.equal(finished, false);
  worker.emit('close', null);
  await assert.rejects(result, error => error.code === 'natal_day_timeout');
});

test('real historical and fold days survive production compression and reconstruct reference P+D exactly', async () => {
  const run = promisify(execFile);
  for (const [date, timezone, indices] of [['1900-01-01', 'Europe/Paris', [0, 719, 1439]], ['2024-11-03', 'America/New_York', [0, 90, 150, 1499]]]) {
    const source = await generateNatalDay({ root, date, timezone });
    const raw = await encodeNatalDayPacket(source), decoded = decodeNatalDay(raw);
    const bits = values => Buffer.from(new Float64Array(values).buffer).toString('hex');
    assert.deepEqual(decoded.columns.map(bits), source.columns.map(bits));
    const script = `import json\nfrom server.python import calculator as c\nfrom server.python import civil_time as d\nminutes=d.local_minutes(${JSON.stringify(date)},${JSON.stringify(timezone)})\ncharts=[]\nfor i in ${JSON.stringify(indices)}:\n m,offset,fold,seconds=minutes[i]\n local=m+c.dt.timedelta(seconds=seconds)\n charts.append(c.calculate(dict(mode='natal',name='Reference',date=${JSON.stringify(date)},time=local.strftime('%H:%M'),fold=fold,city=dict(id='test',name='Test',timezone=${JSON.stringify(timezone)})))['chart'])\nprint(json.dumps(charts))`;
    const references = JSON.parse((await run(`${root}.venv/bin/python`, ['-c', script], { cwd: root, maxBuffer: 100000 })).stdout);
    indices.forEach((index, i) => {
      const chart = chartAtMinute(decoded, index, { id: 'same-id', name: 'Original' }), reference = references[i];
      for (const key of ['activations', 'personality', 'design', 'utc', 'birthTime', 'utcOffset', 'fold', 'designUtc', 'designArcResidualDegrees']) assert.deepEqual(chart[key], reference[key], `${timezone} sample ${index}: ${key}`);
      assert.equal(natalDayMinute(decoded, index).utc, reference.utc);
    });
  }
});
