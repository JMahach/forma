import { validateTransitDayQuery } from '../server/http/transit-days.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createTransitDays, generateTransitDay, encodeDayPacket, transitCacheFingerprint } from '../server/services/transit-days.mjs';
import { negotiateEncoding } from '../server/http/content-encoding.mjs';
import { decodeTransitDay } from '../shared/day-packets/decode.js';
import { transitChartAt } from '../src/domain/transit-day.js';
import { createRequestHandler } from '../server/http/app.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const now = () => new Date('2026-09-24T12:00:00Z');
const fingerprint = '0123456789abcdef';
const makeDay = date => ({ date, startUtc: `${date}T00:00:00Z`, samples: 1440, stepSeconds: 60,
  columns: Array.from({ length: 11 }, (_, column) => Array.from({ length: 1440 }, (_, minute) => 10 + column * 20 + minute / 10000)),
  engine: 'Swiss Ephemeris test', ephemeris: 'Test ephemerides', timezoneDatabase: 'IANA test', nodeModel: 'true', zodiac: 'tropical-geocentric-apparent' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-transit-tests-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function cache(t, options = {}) {
  const service = await createTransitDays({ root, cacheDir: await directory(t), now, fingerprint, generateDay: async date => makeDay(date), ...options });
  t.after(() => service.close());
  return service;
}

test('singleflight shares a day across requests and bounds the global queue to one active plus five waiting', async t => {
  const entered = deferred(), release = deferred(), calls = [];
  let active = 0, maximum = 0;
  const service = await cache(t, { generateDay: async date => {
    calls.push(date); active++; maximum = Math.max(maximum, active);
    if (calls.length === 1) { entered.resolve(); await release.promise; }
    active--; return makeDay(date);
  } });
  const first = service.get('2026-09-20');
  assert.equal(service.get('2026-09-20'), first);
  await entered.promise;
  const waiting = ['21', '22', '23', '24', '25'].map(day => service.get(`2026-09-${day}`));
  assert.equal(service.queued, 5);
  await assert.rejects(service.get('2026-09-26'), error => error.code === 'transit_busy' && error.retryAfter === 1);
  release.resolve();
  const packets = await Promise.all([first, ...waiting]);
  assert.equal(calls.length, 6); assert.equal(maximum, 1);
  assert.equal(await service.get('2026-09-20'), packets[0]);
  assert.equal(calls.length, 6);
});

test('a generation error releases the queue and is retriable without an error cache', async t => {
  let calls = 0;
  const service = await cache(t, { generateDay: async date => { if (++calls === 1) throw new Error('temporary'); return makeDay(date); } });
  await assert.rejects(service.get('2026-09-24'), /temporary/);
  assert.equal(service.size, 0);
  assert.equal(decodeTransitDay((await service.get('2026-09-24')).bytes.identity).date, '2026-09-24');
  assert.equal(calls, 2);
});

test('restart reuses gzip without astronomy; corrupt packets and changed fingerprints regenerate', async t => {
  const cacheDir = await directory(t);
  let calls = 0;
  const options = { root, cacheDir, now, fingerprint, generateDay: async date => { calls++; return makeDay(date); } };
  const first = await createTransitDays(options);
  const original = await first.get('2026-09-24'); first.close();
  const restarted = await createTransitDays(options);
  assert.deepEqual((await restarted.get('2026-09-24')).bytes, original.bytes);
  assert.equal(calls, 1); restarted.close();
  const file = path.join(cacheDir, `2026-09-24.${fingerprint}.gz`);
  await fs.writeFile(file, 'not gzip');
  const repaired = await createTransitDays(options);
  await repaired.get('2026-09-24'); assert.equal(calls, 2); repaired.close();
  const invalidated = await createTransitDays({ ...options, fingerprint: 'abcdef0123456789' });
  await invalidated.get('2026-09-24'); assert.equal(calls, 3); invalidated.close();
  assert.deepEqual(await fs.readdir(cacheDir), ['2026-09-24.abcdef0123456789.gz']);
});

test('RAM and disk retain at most seven days and pruning leaves unrelated files and directories intact', async t => {
  const cacheDir = await directory(t);
  const service = await cache(t, { cacheDir });
  await fs.writeFile(path.join(cacheDir, 'notes.txt'), 'keep');
  await fs.mkdir(path.join(cacheDir, `2026-08-01.${fingerprint}.gz`));
  for (let day = 10; day <= 18; day++) await service.get(`2026-09-${day}`);
  assert.equal(service.size, 7);
  const entries = await fs.readdir(cacheDir, { withFileTypes: true });
  assert.equal(entries.filter(entry => entry.isFile() && entry.name.endsWith('.gz')).length, 7);
  assert.equal(await fs.readFile(path.join(cacheDir, 'notes.txt'), 'utf8'), 'keep');
  assert.ok((await fs.stat(path.join(cacheDir, `2026-08-01.${fingerprint}.gz`))).isDirectory());
  assert.ok(!entries.some(entry => entry.name.endsWith('.tmp')));
});

test('query validation is exact, version aware and uses UTC dates through month/year boundaries', () => {
  const query = value => new URLSearchParams(value);
  for (const date of ['2026-09-22', '2026-09-24', '2026-09-26']) assert.deepEqual(validateTransitDayQuery(query({ date, v: '1' }), now()), { date, versioned: true });
  assert.equal(validateTransitDayQuery(query({ date: '2026-09-24' }), now()).versioned, false);
  for (const value of [{}, { date: '2026-9-24' }, { date: '2026-02-30' }, { date: '../2026-09-24' }, { date: '2026-09-24', v: '2' }, { date: '2026-09-24', v: '' }]) {
    assert.throws(() => validateTransitDayQuery(query(value), now()), error => error.status === 400);
  }
  assert.throws(() => validateTransitDayQuery(query({ date: '2026-09-27' }), now()), error => error.status === 422);
  assert.equal(validateTransitDayQuery(query({ date: '2027-01-01', v: '1' }), new Date('2026-12-31T23:59:59Z')).date, '2027-01-01');
  assert.equal(validateTransitDayQuery(query({ date: '2026-09-30', v: '1' }), new Date('2026-10-01T00:00:00Z')).date, '2026-09-30');
});

test('warmup shares tomorrow at a month rollover and cleans its unref midnight timer', async t => {
  let instant = new Date('2026-09-30T23:59:59Z');
  const calls = [], timers = [], cleared = [], scheduled = [deferred(), deferred()];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { const timer = { callback, delay, unref() { this.unreferenced = true; } }; timers.push(timer); scheduled[timers.length - 1]?.resolve(timer); return timer; });
  t.mock.method(globalThis, 'clearTimeout', timer => cleared.push(timer));
  const service = await cache(t, { now: () => instant, generateDay: async date => { calls.push(date); return makeDay(date); } });
  await service.warm();
  assert.deepEqual(calls, ['2026-09-30', '2026-10-01']);
  service.startWarmup();
  await scheduled[0].promise;
  assert.equal(timers[0].delay, 1050); assert.equal(timers[0].unreferenced, true);
  instant = new Date('2026-10-01T00:00:00.050Z');
  timers[0].callback();
  await scheduled[1].promise;
  await service.warm();
  assert.deepEqual(calls, ['2026-09-30', '2026-10-01', '2026-10-02']);
  assert.equal(timers[1].delay, 86400000);
  service.close(); assert.equal(cleared.at(-1), timers[1]);
});

test('startup crossing midnight still prewarms the new tomorrow while its first batch is unfinished', async t => {
  let instant = new Date('2026-09-30T23:59:59Z');
  const firstEntered = deferred(), release = deferred(), calls = [], timers = [], cleared = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay, unref() { this.unreferenced = true; } };
    timers.push(timer); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => cleared.push(timer));
  const service = await cache(t, { now: () => instant, generateDay: async date => {
    calls.push(date);
    if (calls.length === 1) { firstEntered.resolve(); await release.promise; }
    return makeDay(date);
  } });
  service.startWarmup();
  try {
    await firstEntered.promise;
    assert.equal(timers.length, 1, 'the rollover is scheduled before the initial batch finishes');
    assert.equal(timers[0].delay, 1050);
    assert.equal(timers[0].unreferenced, true);
    instant = new Date('2026-10-01T00:00:00.050Z');
    timers[0].callback();
    assert.equal(timers.length, 2);
    assert.equal(service.queued, 2, 'October 1 is shared and October 2 is queued behind the active September 30');
  } finally { release.resolve(); }
  await service.warm();
  assert.deepEqual(calls, ['2026-09-30', '2026-10-01', '2026-10-02']);
  service.close();
  assert.equal(cleared.at(-1), timers[1]);
  await new Promise(setImmediate);
  assert.equal(timers.length, 2, 'completion does not recreate a closed timer');
});

async function request(service, url, { method = 'GET', headers = {} } = {}) {
  const result = { headersSent: false, status: 0, headers: {}, body: null,
    writeHead(status, values) { this.status = status; this.headers = values; this.headersSent = true; },
    end(body) { this.body = body; } };
  const handler = createRequestHandler({ root, transitDays: service, now, cities: {}, calculate: () => { throw new Error('Day route must not run natal workers'); } });
  await handler({ method, url, headers: { host: 'localhost', ...headers } }, result);
  return result;
}

test('HTTP endpoint sends negotiated lossless packets, ETags, HEAD/304 and version-scoped immutable caching', async t => {
  let calls = 0;
  const service = await cache(t, { generateDay: async date => { calls++; return makeDay(date); } });
  const url = '/api/transit/day?date=2026-09-24&v=1';
  for (const [accept, encoding, unpack] of [['gzip, br', 'br', brotliDecompressSync], ['gzip', 'gzip', gunzipSync], ['identity', undefined, value => value]]) {
    const result = await request(service, url, { headers: { 'accept-encoding': accept } });
    assert.equal(result.status, 200); assert.equal(result.headers['Content-Encoding'], encoding);
    assert.equal(result.headers['Content-Type'], 'application/octet-stream');
    assert.equal(result.headers['Content-Length'], result.body.length);
    assert.equal(result.headers.Vary, 'Accept-Encoding'); assert.match(result.headers['Cache-Control'], /immutable/);
    assert.equal(decodeTransitDay(unpack(result.body)).date, '2026-09-24');
    const cached = await request(service, url, { headers: { 'accept-encoding': accept, 'if-none-match': `W/${result.headers.ETag}` } });
    assert.equal(cached.status, 304); assert.equal(cached.body, undefined);
    const head = await request(service, url, { method: 'HEAD', headers: { 'accept-encoding': accept } });
    assert.equal(head.status, 200); assert.equal(head.body, undefined); assert.deepEqual(head.headers, result.headers);
  }
  assert.equal(calls, 1);
  assert.equal((await request(service, '/api/transit/day?date=2026-09-24')).headers['Cache-Control'], 'no-cache');
  assert.equal((await request(service, url, { method: 'POST' })).status, 405);
  assert.equal((await request(service, url, { headers: { origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await request(service, '/.cache/transit/v1/2026-09-24.gz')).status, 404);
  const version = await request(service, '/api/transit/day?date=2026-09-24&v=2');
  assert.equal(version.status, 400); assert.equal(version.headers['Cache-Control'], 'no-store');
  const unacceptable = await request(service, url, { headers: { 'accept-encoding': 'br;q=0,gzip;q=0,identity;q=0' } });
  assert.equal(unacceptable.status, 406); assert.equal(calls, 1);
});

test('encoding preference honors exclusions and transient HTTP failures remain retriable', async t => {
  assert.equal(negotiateEncoding('br;q=0,gzip'), 'gzip');
  assert.equal(negotiateEncoding('gzip;q=.5,br;q=1'), 'br');
  assert.equal(negotiateEncoding('br;q=0,gzip;q=0'), 'identity');
  assert.equal(negotiateEncoding('*'), 'br');
  let calls = 0;
  const service = await cache(t, { generateDay: async date => { if (++calls === 1) throw new Error('temporary'); return makeDay(date); } });
  const url = '/api/transit/day?date=2026-09-24&v=1';
  const failed = await request(service, url);
  assert.equal(failed.status, 503); assert.equal(failed.headers['Cache-Control'], 'no-store'); assert.equal(failed.headers['Retry-After'], '5');
  assert.equal((await request(service, url)).status, 200); assert.equal(calls, 2);
});

test('batch workers are bounded and a terminated process must close before releasing its generation slot', async () => {
  const worker = new EventEmitter();
  worker.stdout = new EventEmitter(); worker.stdout.setEncoding = () => {};
  worker.stdin = new EventEmitter(); worker.stdin.end = input => { worker.input = input; };
  worker.kill = signal => { worker.signal = signal; };
  let settled = false;
  const result = generateTransitDay({ root, date: '2026-09-24', spawnWorker(command, args, options) {
    assert.ok(command.endsWith('/.venv/bin/python'));
    assert.ok(args[0].endsWith('/server/python/transit_day.py'));
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']);
    return worker;
  } });
  result.then(() => { settled = true; }, () => { settled = true; });
  assert.equal(worker.input, '{"date":"2026-09-24"}');
  worker.stdout.emit('data', 'x'.repeat(500001));
  assert.equal(worker.signal, 'SIGKILL');
  await Promise.resolve();
  assert.equal(settled, false);
  worker.emit('close', null);
  await assert.rejects(result, error => error.code === 'transit_unavailable');
});

test('real Python batch and binary packet reproduce all 1440 scalar charts exactly', async t => {
  try { await fs.access(path.join(root, '.venv/bin/python')); } catch { t.skip('Install the local Python environment to run real ephemeris parity'); return; }
  const date = '2026-09-24';
  const day = await generateTransitDay({ root, date });
  const packet = await encodeDayPacket(day), decoded = decodeTransitDay(packet);
  const script = "import datetime as dt,json; from server.python import astronomy as c; from server.python import civil_time as civil; start=dt.datetime(2026,9,24,tzinfo=c.UTC); print(json.dumps([c.activations(c.julian_tt(start+dt.timedelta(minutes=i))) for i in range(1440)],separators=(',',':')))";
  const { stdout } = await promisify(execFile)(path.join(root, '.venv/bin/python'), ['-c', script], { cwd: root, maxBuffer: 4000000 });
  const reference = JSON.parse(stdout);
  let crossings = 0;
  for (let minute = 0; minute < 1440; minute++) {
    const chart = transitChartAt(decoded, minute);
    assert.deepEqual(chart.activations.personality, reference[minute], `minute ${minute}`);
    if (minute) crossings += reference[minute].filter((entry, index) => entry.gate !== reference[minute - 1][index].gate).length;
  }
  assert.ok(crossings > 0, 'the actual day includes gate boundaries');
  assert.equal(transitChartAt(decoded, 1439).utc, `${date}T23:59:00Z`);
});


test('disk fingerprint is stable and tracks the relocated calculation and format owners', async t => {
  const sourceRoot = await directory(t);
  const inputs = ['server/python/astronomy.py', 'server/python/civil_time.py', 'server/python/errors.py', 'server/python/transit_day.py',
    'requirements.txt', 'shared/day-packets/transit-format.js', 'shared/day-packets/float64-codec.js',
    'shared/day-packets/decode.js', 'server/packets/encode.mjs'];
  for (const file of [...inputs, 'data/ephe/sepl_18.se1', 'data/ephe/semo_18.se1']) {
    await fs.mkdir(path.dirname(path.join(sourceRoot, file)), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, file), `baseline ${file}`);
  }
  const baseline = await transitCacheFingerprint(sourceRoot);
  assert.match(baseline, /^[a-f0-9]{16}$/);
  assert.equal(await transitCacheFingerprint(sourceRoot), baseline);
  for (const file of inputs) {
    const name = path.join(sourceRoot, file), content = await fs.readFile(name);
    await fs.appendFile(name, '\nchanged');
    assert.notEqual(await transitCacheFingerprint(sourceRoot), baseline, file);
    await fs.writeFile(name, content);
    assert.equal(await transitCacheFingerprint(sourceRoot), baseline, file);
  }
});
