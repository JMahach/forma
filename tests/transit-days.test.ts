interface Timer { callback: () => void; delay: number | undefined; unreferenced?: boolean; unref(): void }
import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from 'node:http';
import type { CapturedResponse } from './helpers/http-response.ts';
import type { TestWorker, TestSpawner } from './helpers/test-worker.ts';
import type { ChartActivations } from '../shared/chart-types.ts';
import { TransitDayError } from '../server/services/transit-days.ts';
const generateTransitDay = (options: Omit<Parameters<typeof generate>[0], 'spawnWorker'> & { spawnWorker?: TestSpawner<string> }) =>
  generate(options as Parameters<typeof generate>[0]);
import { deferred } from './helpers/deferred.ts';
import { validateTransitDayQuery } from '../server/http/transit-days.ts';
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
import { createTransitDays, generateTransitDay as generate, encodeDayPacket } from '../server/services/transit-days.ts';
import { negotiateEncoding } from '../server/http/content-encoding.ts';
import { pythonExecutable, pythonEnvironment } from '../server/runtime/python.ts';
import { decodeTransitDay } from '../shared/day-packets/decode.ts';
import { transitChartAt } from '../src/domain/transit-day.ts';
import { createRequestHandler } from '../server/http/app.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const now = () => new Date('2026-09-24T12:00:00Z');
const makeDay = (date: string) => ({ date, startUtc: `${date}T00:00:00Z`, samples: 1440, stepSeconds: 60,
  columns: Array.from({ length: 24 }, (_, column) => Array.from({ length: 1440 }, (_, minute) => column < 22 ? (10 + column * 20 + minute / 10000) % 360 : column === 22 ? Date.parse(`${date}T00:00:00Z`) / 1000 - 88 * 86400 + minute * 61 : minute % 100 * 1e-12)),
  engine: 'Swiss Ephemeris test', ephemeris: 'Test ephemerides', timezoneDatabase: 'IANA test', nodeModel: 'true', zodiac: 'tropical-geocentric-apparent' });
async function directory(t: test.TestContext) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'forma-transit-tests-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function cache(t: test.TestContext, options: Partial<Parameters<typeof createTransitDays>[0]> = {}) {
  let service: Awaited<ReturnType<typeof createTransitDays>>;
  t.after(() => service?.close());
  service = await createTransitDays({ root, cacheDir: await directory(t), now, generateDay: async date => makeDay(date), ...options });
  return service;
}

test('singleflight shares a day across requests and bounds the global queue to one active plus five waiting', async t => {
  const entered = deferred(), release = deferred(), calls = [];
  let active = 0, maximum = 0;
  const service = await cache(t, { generateDay: async (date: string) => {
    calls.push(date); active++; maximum = Math.max(maximum, active);
    if (calls.length === 1) { entered.resolve!(); await release.promise; }
    active--; return makeDay(date);
  } });
  const first = service.get('2026-09-20');
  assert.equal(service.get('2026-09-20'), first);
  await entered.promise;
  const waiting = ['21', '22', '23', '24', '25'].map(day => service.get(`2026-09-${day}`));
  assert.equal(service.queued, 5);
  await assert.rejects(service.get('2026-09-26'), (error: TransitDayError) => error.code === 'transit_busy' && error.retryAfter === 1);
  release.resolve!();
  const packets = await Promise.all([first, ...waiting]);
  assert.equal(calls.length, 6); assert.equal(maximum, 1);
  assert.equal(await service.get('2026-09-24'), packets[4]);
  assert.equal(calls.length, 6);
});

test('a generation error releases the queue and is retriable without an error cache', async t => {
  let calls = 0;
  const service = await cache(t, { generateDay: async (date: string) => { if (++calls === 1) throw new Error('temporary'); return makeDay(date); } });
  await assert.rejects(service.get('2026-09-24'), /temporary/);
  assert.equal(service.size, 0);
  assert.equal(decodeTransitDay((await service.get('2026-09-24')).bytes.identity).date, '2026-09-24');
  assert.equal(calls, 2);
});

test('close waits for the active calculation and queued work without a disk-write phase', async t => {
  const entered=deferred(),release=deferred(),calls:string[]=[];let closed=false;
  const service=await cache(t,{generateDay:async date=>{
    calls.push(date);if(calls.length===1){entered.resolve!();await release.promise;}return makeDay(date);
  }});
  const first=service.get('2026-09-24');await entered.promise;
  const next=service.get('2026-09-25'),closing=service.close().then(()=>{closed=true;});
  await new Promise(setImmediate);assert.equal(closed,false);assert.equal(service.queued,1);
  release.resolve!();await Promise.all([first,next,closing]);
  assert.deepEqual(calls,['2026-09-24','2026-09-25']);assert.equal(closed,true);
});

test('interactive days run ahead of queued warmup without interrupting the live day', async t => {
  const entered = deferred(), release = deferred(), calls: unknown[] = [];
  let active = 0, maximum = 0;
  const service = await cache(t, { generateDay: async (date: string) => {
    calls.push(date); active++; maximum = Math.max(maximum, active);
    if (calls.length === 1) { entered.resolve!(); await release.promise; }
    active--; return makeDay(date);
  } });
  const warmup = service.warm();
  await entered.promise;
  const firstUser = service.get('2026-09-23'), secondUser = service.get('2026-09-22');
  assert.deepEqual(calls, ['2026-09-24'], 'the active warmup is never preempted');
  release.resolve!();
  await Promise.all([warmup, firstUser, secondUser]);
  assert.deepEqual(calls, ['2026-09-24', '2026-09-23', '2026-09-22', '2026-09-25', '2026-09-26']);
  assert.equal(maximum, 1);
});

test('requesting a queued background day promotes its existing job and preserves singleflight at capacity', async t => {
  const entered = deferred(), release = deferred(), calls: unknown[] = [];
  const service = await cache(t, { generateDay: async (date: string) => {
    calls.push(date);
    if (calls.length === 1) { entered.resolve!(); await release.promise; }
    return makeDay(date);
  } });
  const first = service.get('2026-09-20');
  await entered.promise;
  const warmup = service.warm();
  const waiting = [service.get('2026-09-21')];
  assert.equal(service.queued, 5);
  const promoted = service.get('2026-09-26');
  assert.equal(service.get('2026-09-26'), promoted);
  assert.equal(service.queued, 5, 'promotion consumes no additional queue slot');
  await assert.rejects(service.get('2026-09-22'), (error: TransitDayError) => error.code === 'transit_busy');
  release.resolve!();
  await Promise.all([first, warmup, promoted, ...waiting]);
  assert.deepEqual(calls, ['2026-09-20', '2026-09-21', '2026-09-26', '2026-09-24', '2026-09-23', '2026-09-25']);
  assert.equal(calls.filter(date => date === '2026-09-26').length, 1);
});

for (const saturated of [false,true]) test(`a ready RAM day bypasses ${saturated?'a full calculation queue':'an active calculation'}`,async t=>{
  const entered=deferred(),release=deferred(),calls:string[]=[];
  const service=await cache(t,{generateDay:async date=>{
    calls.push(date);if(date==='2026-09-20'){entered.resolve!();await release.promise;}return makeDay(date);
  }});
  const expected=await service.get('2026-09-24'),active=service.get('2026-09-20');await entered.promise;
  const waiting:Promise<unknown>[]=[];
  try {
    if(saturated)waiting.push(...['21','22','27','28','29'].map(day=>service.get(`2026-09-${day}`)));
    const readers=await Promise.all(Array.from({length:100},()=>service.get('2026-09-24')));
    assert.ok(readers.every(packet=>packet===expected));
    assert.deepEqual(calls,['2026-09-24','2026-09-20']);
  } finally {release.resolve!();await Promise.allSettled([active,...waiting]);}
});

test('query validation is exact, version aware and uses UTC dates through month/year boundaries', () => {
  const query = (value: string|string[][]|URLSearchParams|Record<string,string>|{ date?: undefined; v?: undefined; }|{ date: string; v?: undefined; }|{ date: string; v: string; }|undefined) => new URLSearchParams(value as Record<string, string>);
  for (const date of ['2026-09-22', '2026-09-24', '2026-09-26'] as const) assert.deepEqual(validateTransitDayQuery(query({ date, v: '2' }), now()), { date, allowCalculate: true });
  assert.deepEqual(validateTransitDayQuery(query({ date: '2026-09-24' }), now()), { date: '2026-09-24', allowCalculate: true });
  for (const value of [{}, { date: '2026-9-24' }, { date: '2026-02-30' }, { date: '../2026-09-24' }, { date: '2026-09-24', v: '0' }, { date: '2026-09-24', v: '' }] as const) {
    assert.throws(() => validateTransitDayQuery(query(value), now()), (error: TransitDayError) => error.status === 400);
  }
  assert.equal(validateTransitDayQuery(query({ date: '2026-09-27' }), now()).allowCalculate, false);
  assert.equal(validateTransitDayQuery(query({ date: '2027-01-01', v: '2' }), new Date('2026-12-31T23:59:59Z')).date, '2027-01-01');
  assert.equal(validateTransitDayQuery(query({ date: '2026-09-30', v: '2' }), new Date('2026-10-01T00:00:00Z')).date, '2026-09-30');
});

test('warmup shares tomorrow at a month rollover and cleans its unref midnight timer', async t => {
  let instant = new Date('2026-09-30T23:59:59Z');
  const calls: unknown[] = [], timers: Timer[] = [], cleared: unknown[] = [], scheduled = [deferred(), deferred()];
  const service = await cache(t, { now: () => instant, generateDay: async (date: string) => { calls.push(date); return makeDay(date); } });
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, delay: number | undefined) => { const timer: Timer = { callback, delay, unref() { this.unreferenced = true; } }; timers.push(timer); scheduled[timers.length - 1]?.resolve!(timer); return timer; });
  t.mock.method(globalThis, 'clearTimeout', (timer: unknown) => cleared.push(timer));
  await service.warm();
  assert.deepEqual(calls, ['2026-09-30', '2026-09-29', '2026-10-01', '2026-10-02']);
  service.startWarmup();
  await scheduled[0].promise;
  assert.equal(timers[0].delay, 1050); assert.equal(timers[0].unreferenced, true);
  instant = new Date('2026-10-01T00:00:00.050Z');
  timers[0].callback();
  await scheduled[1].promise;
  await service.warm();
  assert.deepEqual(calls, ['2026-09-30', '2026-09-29', '2026-10-01', '2026-10-02', '2026-10-03']);
  assert.equal(timers[1].delay, 86400000);
  service.close(); assert.equal(cleared.at(-1), timers[1]);
});

test('startup crossing midnight still prewarms the new tomorrow while its first batch is unfinished', async t => {
  let instant = new Date('2026-09-30T23:59:59Z');
  const firstEntered = deferred(), release = deferred(), calls: unknown[] = [], timers: Timer[] = [], cleared: unknown[] = [];
  const service = await cache(t, { now: () => instant, generateDay: async (date: string) => {
    calls.push(date);
    if (calls.length === 1) { firstEntered.resolve!(); await release.promise; }
    return makeDay(date);
  } });
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, delay: number | undefined) => {
    const timer: Timer = { callback, delay, unref() { this.unreferenced = true; } };
    timers.push(timer); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer: unknown) => cleared.push(timer));
  service.startWarmup();
  try {
    await firstEntered.promise;
    assert.equal(timers.length, 1, 'the rollover is scheduled before the initial batch finishes');
    assert.equal(timers[0].delay, 1050);
    assert.equal(timers[0].unreferenced, true);
    instant = new Date('2026-10-01T00:00:00.050Z');
    timers[0].callback();
    assert.equal(timers.length, 2);
    assert.equal(service.queued, 3, 'obsolete September 29 leaves the queue; October 1 and 2 are shared and October 3 is added');
  } finally { release.resolve!(); }
  await service.warm();
  assert.deepEqual(calls, ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03']);
  service.close();
  assert.equal(cleared.at(-1), timers[1]);
  await new Promise(setImmediate);
  assert.equal(timers.length, 2, 'completion does not recreate a closed timer');
});

async function request(service: Parameters<typeof createRequestHandler>[0]['transitDays'], url: string, { method = 'GET', headers = {} } = {}) {
  const result = { headersSent: false, status: 0, headers: {} as OutgoingHttpHeaders, body: null as Buffer | string | null | undefined,
    writeHead(status: number, values: OutgoingHttpHeaders) { this.status = status; this.headers = values; this.headersSent = true; },
    end(body?: Buffer | string) { this.body = body; } };
  const handler = createRequestHandler({ root, transitDays: service, now, cities: {}, calculate: () => { throw new Error('Day route must not run natal workers'); } } as unknown as Parameters<typeof createRequestHandler>[0]);
  await handler({ method, url, headers: { host: 'localhost', ...headers } } as IncomingMessage, result as unknown as ServerResponse);
  return result;
}

test('HTTP endpoint sends negotiated lossless packets and HEAD without browser storage or conditional reads', async t => {
  let calls = 0;
  const service = await cache(t, { generateDay: async (date: string) => { calls++; return makeDay(date); } });
  const url = `/api/transit/day?date=2026-09-24&v=2`;
  for (const [accept, encoding, unpack] of [['gzip, br', 'br', brotliDecompressSync], ['gzip', 'gzip', gunzipSync], ['identity', undefined, (value: Buffer) => value]] as const) {
    const result = await request(service, url, { headers: { 'accept-encoding': accept } });
    assert.equal(result.status, 200); assert.equal(result.headers['Content-Encoding'], encoding);
    assert.equal(result.headers['Content-Type'], 'application/octet-stream');
    assert.equal(result.headers['Content-Length'], result.body!.length);
    assert.equal(result.headers.Vary, 'Accept-Encoding'); assert.equal(result.headers['Cache-Control'], 'no-store'); assert.equal(result.headers.ETag, undefined);
    assert.equal(decodeTransitDay(unpack(result.body as Buffer)).date, '2026-09-24');
    const cached = await request(service, url, { headers: { 'accept-encoding': accept, 'if-none-match': '*' } });
    assert.equal(cached.status, 200); assert.deepEqual(cached.body, result.body);
    const head = await request(service, url, { method: 'HEAD', headers: { 'accept-encoding': accept } });
    assert.equal(head.status, 200); assert.equal(head.body, undefined); assert.deepEqual(head.headers, result.headers);
  }
  assert.equal(calls, 1);
  assert.equal((await request(service, '/api/transit/day?date=2026-09-24&v=2')).headers['Cache-Control'], 'no-store');
  assert.equal((await request(service, '/api/transit/day?date=2026-09-24')).headers['Cache-Control'], 'no-store');
  assert.equal((await request(service, url, { method: 'POST' })).status, 405);
  assert.equal((await request(service, url, { headers: { origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await request(service, '/.cache/transit/v1/2026-09-24.gz')).status, 404);
  const version = await request(service, '/api/transit/day?date=2026-09-24&v=0');
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
  const service = await cache(t, { generateDay: async (date: string) => { if (++calls === 1) throw new Error('temporary'); return makeDay(date); } });
  const url = `/api/transit/day?date=2026-09-24&v=2`;
  const failed = await request(service, url);
  assert.equal(failed.status, 503); assert.equal(failed.headers['Cache-Control'], 'no-store'); assert.equal(failed.headers['Retry-After'], '5');
  assert.equal((await request(service, url)).status, 200); assert.equal(calls, 2);
});

test('batch workers are bounded and a terminated process must close before releasing its generation slot', async () => {
  const worker = new EventEmitter() as TestWorker<string>;
  worker.stdout = new EventEmitter() as TestWorker['stdout']; worker.stdout.setEncoding = () => {};
  worker.stdin = new EventEmitter() as TestWorker['stdin']; worker.stdin.end = input => { worker.input = input; };
  worker.kill = signal => { worker.signal = signal; };
  let settled = false;
  const result = generateTransitDay({ root, date: '2026-09-24', spawnWorker(command, args, options) {
    assert.equal(command, pythonExecutable(root));
    assert.equal(args![0], path.join(root, 'server/python/transit_day.py'));
    assert.deepEqual(options!.stdio, ['pipe', 'pipe', 'ignore']);
    return worker;
  } });
  result.then(() => { settled = true; }, () => { settled = true; });
  assert.equal(worker.input, '{"date":"2026-09-24"}');
  worker.stdout.emit('data', 'x'.repeat(1000001));
  assert.equal(worker.signal, 'SIGKILL');
  await Promise.resolve();
  assert.equal(settled, false);
  worker.emit('close', null);
  await assert.rejects(result, (error: TransitDayError) => error.code === 'transit_unavailable');
});

test('real Python batch and binary packet reproduce all 1440 scalar charts exactly', async t => {
  try { await fs.access(pythonExecutable(root)); } catch { t.skip('Install the local Python environment to run real ephemeris parity'); return; }
  const date = '2026-09-24';
  const day = await generateTransitDay({ root, date });
  const packet = await encodeDayPacket(day), decoded = decodeTransitDay(packet);
  const script = "import datetime as dt,json; from server.python import calculator as c; print(json.dumps([c.calculate(dict(mode='natal',name='Parity',date='2026-09-24',time=f'{i//60:02d}:{i%60:02d}',city=dict(id='utc',name='UTC',timezone='UTC')))['chart']['activations'] for i in range(1440)],separators=(',',':')))";
  const { stdout } = await promisify(execFile)(pythonExecutable(root), ['-c', script], { cwd: root, maxBuffer: 6000000, env: pythonEnvironment() });
  const reference = JSON.parse(stdout) as ChartActivations[];
  let crossings = 0;
  for (let minute = 0; minute < 1440; minute++) {
    const chart = transitChartAt(decoded, minute);
    assert.deepEqual(chart.activations, reference[minute], `minute ${minute}`);
    if (minute) crossings += reference[minute].personality.filter((entry, index) => entry.gate !== reference[minute - 1].personality[index].gate).length;
  }
  assert.ok(crossings > 0, 'the actual day includes gate boundaries');
  assert.equal(transitChartAt(decoded, 1439).utc, `${date}T23:59:00Z`);
});


test('HTTP preserves its range error after a transient historical result has been delivered',async t=>{
  let calculations=0;
  const service=await cache(t,{generateDay:async date=>{calculations++;return makeDay(date);}});
  await service.get('2020-01-01');assert.equal(service.size,0);
  assert.equal((await request(service,'/api/transit/day?date=2020-01-01')).status,422);
  assert.equal(calculations,1,'HTTP outside its calculation range does not start new work');
});

test('one HTTP consumer can cancel a shared day without interrupting its neighbour', async t => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const service = await cache(t, { generateDay: async (date: string) => { calls++; entered.resolve!(); await release.promise; return makeDay(date); } });
  const a = new AbortController(), b = new AbortController();
  const first = service.get('2026-09-24', { signal: a.signal }), rejected = assert.rejects(first, { name: 'AbortError' });
  const second = service.get('2026-09-24', { signal: b.signal }); await entered.promise;
  a.abort(); await rejected; release.resolve!(); assert.ok((await second).bytes.gzip); assert.equal(calls, 1);
});

test('a transit retry after cancellation during packing reuses the completed day without regenerating', { timeout: 10000 }, async t => {
  const entered = deferred(), calls: unknown[] = [];
  const service = await cache(t, { generateDay: async (date: string) => {
    calls.push(date); entered.resolve!(); return makeDay(date);
  } });
  const controller = new AbortController();
  const first = service.get('2026-09-24', { signal: controller.signal });
  const cancelled = assert.rejects(first, { name: 'AbortError' });
  await entered.promise;
  await new Promise(setImmediate); // Keep encoding and compression real after the generator returns.
  assert.equal(service.size, 0);
  controller.abort();
  const resumed = service.get('2026-09-24');
  assert.equal(service.queued, 1);
  await cancelled;
  const packet = await resumed;
  assert.equal(decodeTransitDay(packet.bytes.identity).date, '2026-09-24');
  assert.deepEqual(calls, ['2026-09-24'], 'a completed abandoned day must satisfy its queued retry');
  assert.equal(await service.get('2026-09-24'), packet);
  await service.get('2026-09-25');
  assert.deepEqual(calls, ['2026-09-24', '2026-09-25'], 'reuse releases the slot for the next date');
  await service.close();
});

test('a new HTTP consumer never joins an abandoned day while its worker is closing', async t => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const service = await cache(t, { generateDay: async (date: string) => {
    if (++calls === 1) { entered.resolve!(); await release.promise; throw new DOMException('cancelled', 'AbortError'); }
    return makeDay(date);
  } });
  const controller = new AbortController(), first = service.get('2026-09-24', { signal: controller.signal });
  const cancelled = assert.rejects(first, { name: 'AbortError' });
  await entered.promise; controller.abort(); await cancelled;
  const next = request(service, '/api/transit/day?date=2026-09-24');
  release.resolve!();
  const response = await next; assert.equal(response.status, 200); assert.equal(calls, 2);
});


test('RAM-only transit warmup prepares exactly yesterday through the day after tomorrow without disk packets', async t => {
  const cacheDir=await directory(t), calls:string[]=[];
  const service=await cache(t,{cacheDir,generateDay:async date=>{calls.push(date);return makeDay(date);}});
  await service.warm();
  assert.deepEqual([...calls].sort(),['2026-09-23','2026-09-24','2026-09-25','2026-09-26']);
  assert.equal(service.size,4);
  for(const date of calls)await service.get(date);
  assert.equal(calls.length,4);
  assert.deepEqual(await fs.readdir(cacheDir),[]);
});

test('RAM-only transit keeps outside-window calculations transient while preserving the existing HTTP range', async t => {
  const calls:string[]=[];
  const service=await cache(t,{generateDay:async date=>{calls.push(date);return makeDay(date);}});
  await service.warm();
  for(let i=0;i<2;i++)assert.equal((await request(service,'/api/transit/day?date=2026-09-22')).status,200);
  assert.equal(calls.filter(date=>date==='2026-09-22').length,2,'the fifth allowed HTTP date is never retained');
  assert.equal(service.size,4);
  assert.equal((await request(service,'/api/transit/day?date=2026-09-21')).status,422);
  for(const date of ['2026-09-23','2026-09-24','2026-09-25','2026-09-26'])await service.get(date);
  assert.equal(calls.length,6,'transient calculations do not evict the four retained dates');
});

test('RAM-only transit restart recomputes all four dates and carries no old calculation version', async t => {
  const cacheDir=await directory(t), calls:string[]=[];
  const options={root,cacheDir,now,generateDay:async(date:string)=>{calls.push(date);return makeDay(date);}};
  const first=await createTransitDays(options);
  await first.warm();await first.close();
  const second=await createTransitDays(options);
  t.after(()=>second.close());await second.warm();
  assert.equal(calls.length,8);
  assert.equal(Object.hasOwn(second,'calculationVersion'),false);
  assert.equal(Object.hasOwn(decodeTransitDay((await second.get('2026-09-24')).bytes.identity),'calculationVersion'),false);
  assert.deepEqual(await fs.readdir(cacheDir),[]);
});

test('RAM-only transit rollover cannot retain an obsolete day that finishes late', async t => {
  let instant=new Date('2026-09-24T12:00:00Z');
  const entered=deferred(),release=deferred(),calls:string[]=[];
  const service=await cache(t,{now:()=>instant,generateDay:async date=>{
    calls.push(date);if(date==='2026-09-23'){entered.resolve!();await release.promise;}return makeDay(date);
  }});
  const old=service.get('2026-09-23');await entered.promise;
  instant=new Date('2026-09-25T00:00:00Z');const warm=service.warm();release.resolve!();
  await Promise.all([old,warm]);
  assert.equal(service.size,4);
  await assert.rejects(service.get('2026-09-23',{allowCalculate:false}),(error:TransitDayError)=>error.code==='date_out_of_range');
  for(const date of ['2026-09-24','2026-09-25','2026-09-26','2026-09-27'])await service.get(date);
  assert.equal(calls.length,5);
});

test('RAM-only transit migration deletes only owned regular packets and temporary files in legacy version directories', async t => {
  const cacheDir=await directory(t),outside=await directory(t);
  const packet='2026-09-24.0123456789abcdef.gz',temporary='.'+packet+'.12345678-1234-1234-1234-123456789abc.tmp';
  for(const dir of ['v1','v2','other'])await fs.mkdir(path.join(cacheDir,dir));
  for(const file of [packet,temporary,'v1/'+packet,'v2/'+packet,'notes.txt','other/'+packet])await fs.writeFile(path.join(cacheDir,file),'keep or retire');
  await fs.writeFile(path.join(outside,packet),'outside');
  await fs.symlink(path.join(outside,packet),path.join(cacheDir,'2026-09-25.0123456789abcdef.gz'));
  await fs.symlink(outside,path.join(cacheDir,'v3'));
  await fs.mkdir(path.join(cacheDir,'2026-09-26.0123456789abcdef.gz'));
  const service=await cache(t,{cacheDir});
  for(const file of [packet,temporary,'v1/'+packet,'v2/'+packet])await assert.rejects(fs.lstat(path.join(cacheDir,file)),{code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(cacheDir,'notes.txt'),'utf8'),'keep or retire');
  assert.equal(await fs.readFile(path.join(cacheDir,'other',packet),'utf8'),'keep or retire');
  assert.equal(await fs.readFile(path.join(outside,packet),'utf8'),'outside');
  assert.equal((await fs.lstat(path.join(cacheDir,'v3'))).isSymbolicLink(),true);
  assert.equal((await fs.lstat(path.join(cacheDir,'2026-09-25.0123456789abcdef.gz'))).isSymbolicLink(),true);
  assert.equal((await fs.lstat(path.join(cacheDir,'2026-09-26.0123456789abcdef.gz'))).isDirectory(),true);
  await service.warm();assert.equal(await fs.readFile(path.join(outside,packet),'utf8'),'outside');
});

test('RAM-only transit migration does not follow a symlink used as its legacy root', async t => {
  const parent=await directory(t),outside=await directory(t),cacheDir=path.join(parent,'transit');
  const packet='2026-09-24.0123456789abcdef.gz';
  await fs.writeFile(path.join(outside,packet),'outside');await fs.symlink(outside,cacheDir);
  const service=await cache(t,{cacheDir});await service.warm();
  assert.deepEqual(await fs.readdir(outside),[packet]);
  assert.equal(await fs.readFile(path.join(outside,packet),'utf8'),'outside');
});


test('a background date retired before its worker starts never reaches the generator',async t=>{
  let instant=new Date('2026-09-24T23:59:59Z');const calls:string[]=[];
  const service=await cache(t,{now:()=>instant,generateDay:async date=>{calls.push(date);return makeDay(date);}});
  const old=service.warm();instant=new Date('2026-09-28T00:00:00Z');await old;
  assert.deepEqual(calls,[]);
  await service.warm();assert.deepEqual([...calls].sort(),['2026-09-27','2026-09-28','2026-09-29','2026-09-30']);
});

test('warmup eventually fills all four dates after admission to a full interactive queue',async t=>{
  const entered=deferred(),release=deferred(),calls:string[]=[];
  const service=await cache(t,{generateDay:async date=>{
    calls.push(date);if(calls.length===1){entered.resolve!();await release.promise;}return makeDay(date);
  }});
  const first=service.get('2026-09-20');await entered.promise;
  const waiting=['21','22','27','28','29'].map(day=>service.get(`2026-09-${day}`));
  const warm=service.warm();assert.equal(service.queued,5);release.resolve!();
  await Promise.all([first,...waiting,warm]);assert.equal(service.size,4);
  for(const date of ['2026-09-23','2026-09-24','2026-09-25','2026-09-26'])assert.equal(calls.filter(value=>value===date).length,1);
});

test('an outside-window result completing after its only consumer cancels is never retained',async t=>{
  const entered=deferred(),release=deferred();let calls=0;
  const service=await cache(t,{generateDay:async date=>{if(++calls===1){entered.resolve!();await release.promise;}return makeDay(date);}});
  const controller=new AbortController(),first=service.get('2026-09-20',{signal:controller.signal});
  const cancelled=assert.rejects(first,{name:'AbortError'});await entered.promise;
  controller.abort();await cancelled;release.resolve!();await service.close();
  assert.equal(service.size,0);await service.get('2026-09-20');assert.equal(calls,2);assert.equal(service.size,0);
});


test('transit migration refuses a symlink in an ancestor of the cache root',async t=>{
  const project=await directory(t),outside=await directory(t),packet='2026-09-24.0123456789abcdef.gz';
  await fs.mkdir(path.join(outside,'transit'));await fs.writeFile(path.join(outside,'transit',packet),'outside');
  await fs.symlink(outside,path.join(project,'.cache'));
  const errors:unknown[]=[];
  const service=await cache(t,{cacheDir:path.join(project,'.cache','transit'),onCacheError:error=>errors.push(error)});
  assert.deepEqual(service.migration,{removed:0,blocked:1,reason:'unsafe_path'});
  assert.equal(errors.length,1);
  assert.equal(JSON.stringify(service.migration).includes(project),false);
  assert.deepEqual(await fs.readdir(path.join(outside,'transit')),[packet]);
  assert.equal(await fs.readFile(path.join(outside,'transit',packet),'utf8'),'outside');
});

test('transit migration cannot escape through a version directory swapped after inspection',async t=>{
  const cacheDir=await directory(t),outside=await directory(t),version=path.join(cacheDir,'v1');
  const packet='2026-09-24.0123456789abcdef.gz';await fs.mkdir(version);
  await fs.writeFile(path.join(version,packet),'owned');await fs.writeFile(path.join(outside,packet),'outside');
  const script=`import json,os,sys
from server.python import transit_cache_cleanup as migration
cache,outside=sys.argv[1:]
version=os.path.join(cache,'v1')
original=os.stat(version)
listdir=os.listdir
swapped=False
def racing_listdir(descriptor):
    global swapped
    current=os.fstat(descriptor)
    if not swapped and (current.st_dev,current.st_ino)==(original.st_dev,original.st_ino):
        os.rename(version,os.path.join(cache,'parked'))
        os.symlink(outside,version)
        swapped=True
    return listdir(descriptor)
os.listdir=racing_listdir
result=migration.cleanup(cache)
print(json.dumps(dict(swapped=swapped,result=result)))`;
  const {stdout}=await promisify(execFile)(pythonExecutable(root),['-B','-c',script,cacheDir,outside],{cwd:root,env:pythonEnvironment()});
  assert.deepEqual(JSON.parse(stdout),{swapped:true,result:{removed:1,blocked:0,reason:'complete'}});
  assert.deepEqual(await fs.readdir(outside),[packet]);
  assert.equal(await fs.readFile(path.join(outside,packet),'utf8'),'outside');
  assert.deepEqual(await fs.readdir(path.join(cacheDir,'parked')),[],'only the original opened directory was cleaned');
});

test('transit migration fails closed when descriptor-relative operations are unavailable',async t=>{
  const cacheDir=await directory(t),packet='2026-09-24.0123456789abcdef.gz';
  await fs.writeFile(path.join(cacheDir,packet),'keep');
  const script=`import json,sys
from server.python import transit_cache_cleanup as migration
migration.SUPPORTED=False
print(json.dumps(migration.cleanup(sys.argv[1])))`;
  const {stdout}=await promisify(execFile)(pythonExecutable(root),['-B','-c',script,cacheDir],{cwd:root,env:pythonEnvironment()});
  assert.deepEqual(JSON.parse(stdout),{removed:0,blocked:1,reason:'unsupported'});
  assert.deepEqual(await fs.readdir(cacheDir),[packet]);
});


test('transit migration does not normalize away a parent traversal before checking path components',async t=>{
  const parent=await directory(t),cacheDir=path.join(parent,'transit'),packet='2026-09-24.0123456789abcdef.gz';
  await fs.mkdir(cacheDir);await fs.writeFile(path.join(cacheDir,packet),'keep');
  const service=await cache(t,{cacheDir:parent+'/unchecked/../transit'});
  assert.deepEqual(service.migration,{removed:0,blocked:1,reason:'invalid_input'});
  assert.deepEqual(await fs.readdir(cacheDir),[packet]);
});


test('transit migration accepts only ASCII digits in owned packet and temporary filenames',async t=>{
  const cacheDir=await directory(t),suffix='.0123456789abcdef.gz',uuid='.12345678-1234-1234-1234-123456789abc.tmp';
  const owned=['2026-09-24'+suffix,'.2026-09-24'+suffix+uuid];
  const foreign=['٢٠٢٦-٠٩-٢٤'+suffix,'.٢٠٢٦-٠٩-٢٤'+suffix+uuid];
  for(const name of [...owned,...foreign])await fs.writeFile(path.join(cacheDir,name),name);
  const service=await cache(t,{cacheDir});
  assert.deepEqual((await fs.readdir(cacheDir)).sort(),foreign.sort(),'Unicode dates were never produced by the old cache');
  assert.deepEqual(service.migration,{removed:2,blocked:0,reason:'complete'});
  for(const name of foreign)assert.equal(await fs.readFile(path.join(cacheDir,name),'utf8'),name);
});
