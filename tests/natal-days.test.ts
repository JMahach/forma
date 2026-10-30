import type { CityCatalog } from '../server/services/cities.ts';
import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from 'node:http';
import type { CapturedResponse } from './helpers/http-response.ts';
import type { TestWorker, TestSpawner } from './helpers/test-worker.ts';
import type { ChartActivations } from '../shared/chart-types.ts';
import { NatalDayError } from '../server/services/natal-days.ts';
const generateNatalDay = (options: Omit<Parameters<typeof generate>[0], 'spawnWorker'> & { spawnWorker?: TestSpawner<string> }) =>
  generate(options as Parameters<typeof generate>[0]);
import { deferred } from './helpers/deferred.ts';
import { createNatalDayHandler, validateNatalDayRequest } from '../server/http/natal-days.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createNatalDays, generateNatalDay as generate, encodeNatalDayPacket } from '../server/services/natal-days.ts';
import { decodeNatalDay } from '../shared/day-packets/decode.ts';
import { chartAtMinute, natalDayMinute } from '../src/domain/natal-day.ts';
import { createRequestHandler } from '../server/http/app.ts';
import { natalDayFixture } from './fixtures/natal-day.ts';
import { pythonExecutable, pythonEnvironment } from '../server/runtime/python.ts';
import type { DayPacket } from '../server/packets/compression.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const cities = { find: (id: string) => id === 'trusted' ? { timezone: 'Europe/Moscow' } : null } as unknown as CityCatalog;
const makeDay = (date: string, timezone: string) => ({ date, timezone, startUtc: `${date}T00:00:00Z`, samples: 10, stepSeconds: 60,
  segments: [{ index: 0, startUtc: `${date}T00:00:00Z`, offsetSeconds: 0, utcOffset: 'UTC+00:00', fold: 0 }],
  columns: Array.from({ length: 24 }, (_, column) => Array.from({ length: 10 }, (_, minute) => column < 22 ? 10 + column * 10 + minute / 10000 : column === 22 ? Date.parse(date) / 1000 - 88 * 86400 + minute * 60 : 1e-10)),
  engine: 'Swiss Ephemeris test', ephemeris: 'Test ephemerides', timezoneDatabase: 'IANA test', nodeModel: 'true', zodiac: 'tropical-geocentric-apparent' });
const tick = () => new Promise(setImmediate);

test('close waits for abandoned packing before the database owner can close and rejects later reads',async()=>{
  const packing=deferred(),release=deferred(),request=new AbortController();let writes=0,closed=false;
  const service=createNatalDays({generateDay:async(date,timezone)=>makeDay(date,timezone),
    packDay:async()=>{packing.resolve();await release.promise;return {bytes:{identity:Buffer.alloc(1),br:Buffer.alloc(1),gzip:Buffer.alloc(1)}};},
    packages:{readDay:()=>null,putDay:()=>{writes++;return 'stored';}}});
  const work=service.get('2000-01-01','UTC',{signal:request.signal});
  await packing.promise;request.abort();await assert.rejects(work,{name:'AbortError'});
  const stopped=service.close().then(()=>{closed=true;});await tick();assert.equal(closed,false);
  release.resolve();await stopped;assert.equal(writes,0);
  await assert.rejects(service.get('2000-01-01','UTC'),{name:'AbortError'});
});

test('a generated day for another source is rejected and a corrected retry still works',async()=>{
  let wrong=true;const reports:unknown[]=[];
  const service=createNatalDays({report:fact=>{reports.push(fact);},
    generateDay:async(date,timezone)=>makeDay(wrong?'2000-01-02':date,timezone)});
  await assert.rejects(service.get('2000-01-01','UTC'),{code:'natal_day_unavailable'});
  assert.equal(service.size,0);assert.equal(reports.length,1);
  wrong=false;assert.ok(await service.get('2000-01-01','UTC'));await service.close();
});

test('a waiting live day precedes background preparation and promotes a shared queued day',async()=>{
  let release!:()=>void;
  const order:string[]=[];
  const service=createNatalDays({generateDay:async(date,timezone)=>{
    order.push(date);if(order.length===1)await new Promise<void>(resolve=>{release=resolve;});
    return makeDay(date,timezone);
  }});
  const first=service.get('2000-01-01','UTC');
  const background=service.get('2000-01-02','UTC',{priority:-1});
  const live=service.get('2000-01-03','UTC');
  release();await Promise.all([first,background,live]);
  assert.deepEqual(order,['2000-01-01','2000-01-03','2000-01-02']);
  order.length=0;
  const next=service.get('2000-01-04','UTC');
  const shared=service.get('2000-01-05','UTC',{priority:-1});
  const other=service.get('2000-01-06','UTC');
  const joined=service.get('2000-01-05','UTC');
  release();await Promise.all([next,shared,other,joined]);
  assert.deepEqual(order,['2000-01-04','2000-01-05','2000-01-06']);
});

test('request uses only trusted city timezone and strictly validates date, city and version', () => {
  assert.deepEqual(validateNatalDayRequest({ birthDate: '1990-06-15', cityId: 'trusted', v: '1', timezone: 'UTC', city: { timezone: 'UTC' }, name: 'Never forwarded' }, cities), { date: '1990-06-15', timezone: 'Europe/Moscow' });
  for (const change of [{ birthDate: '1990-02-30' }, { birthDate: '1800-01-01' }, { birthDate: '2400-01-01' }, { cityId: 'forged' }, { cityId: {} }, { v: '2' }] as const) {
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
  await assert.rejects(service.get('1990-06-19', 'UTC'), (error: NatalDayError) => error.code === 'natal_day_busy');
  release.resolve!(); await Promise.all([first, ...queued]);
  assert.equal(maximum, 1); assert.equal(calls.length, 4); assert.equal(service.size, 2);
  await service.get('1990-06-18', 'UTC'); assert.equal(calls.length, 4);
  instant = 101; assert.equal(service.size, 0);
  await service.get('1990-06-18', 'UTC'); assert.equal(calls.length, 5);
  const replacement = createNatalDays({ root, generateDay: async (date, timezone) => { calls.push([date, timezone]); return makeDay(date, timezone); } });
  await replacement.get('1990-06-18', 'UTC'); assert.equal(calls.length, 6);
});

test('default natal memory retains ten results and the eleventh evicts the least recently read day', async () => {
  const calls: string[] = [];
  const service = createNatalDays({ now: () => 1_000, generateDay: async (date, timezone) => {
    calls.push(date); return makeDay(date, timezone);
  } });
  const dates = Array.from({ length: 11 }, (_, index) => `1990-06-${String(index + 1).padStart(2, '0')}`);
  const packets = new Map<string, DayPacket>();
  for (const date of dates.slice(0, 10)) packets.set(date, await service.get(date, 'UTC'));
  assert.equal(service.size, 10);
  for (const date of dates.slice(0, 10)) assert.equal(await service.get(date, 'UTC'), packets.get(date));
  assert.equal(calls.length, 10, 'all ten results remain available without another calculation');
  await service.get(dates[0]!, 'UTC'); // Reading moves this day ahead of the second day in LRU order.
  packets.set(dates[10]!, await service.get(dates[10]!, 'UTC'));
  assert.equal(service.size, 10);
  for (const date of [dates[0]!, ...dates.slice(2)]) assert.equal(await service.get(date, 'UTC'), packets.get(date));
  assert.equal(calls.length, 11, 'the ten retained days still reuse their original packets');
  await service.get(dates[1]!, 'UTC');
  assert.deepEqual(calls, [...dates, dates[1]!], 'only the evicted second day needs regeneration');
  assert.equal(service.size, 10);
});

test('default natal lifetime is ten minutes from preparation and cache reads never extend it', async () => {
  let instant = 1_000, calls = 0;
  const started = deferred(), release = deferred();
  const service = createNatalDays({ now: () => instant, generateDay: async (date, timezone) => {
    calls++;
    if (calls === 1) { started.resolve!(); await release.promise; }
    return makeDay(date, timezone);
  } });
  const pending = service.get('1990-06-15', 'UTC');
  await started.promise;
  instant = 121_000; release.resolve!();
  const packet = await pending; // Preparation completed after two minutes of waiting.
  instant = 601_000; // Ten minutes after the request, but only eight after preparation.
  assert.equal(await service.get('1990-06-15', 'UTC'), packet);
  instant = 720_999;
  assert.equal(await service.get('1990-06-15', 'UTC'), packet);
  assert.equal(calls, 1);
  instant = 721_000;
  assert.equal(service.size, 0, 'the read one millisecond earlier must not renew the deadline');
  const replacement = await service.get('1990-06-15', 'UTC');
  assert.notEqual(replacement, packet);
  assert.equal(calls, 2);
});

test('failed generation releases admission and same day can be retried', async () => {
  let calls = 0;
  const service = createNatalDays({ root, generateDay: async (date, timezone) => { if (++calls === 1) throw new Error('Unavailable'); return makeDay(date, timezone); } });
  await assert.rejects(service.get('1990-06-15', 'UTC'));
  assert.equal(service.size, 0);
  assert.equal(decodeNatalDay((await service.get('1990-06-15', 'UTC')).bytes.identity).date, '1990-06-15');
});

test('disconnected natal requests release queued admission for the latest day', async t => {
  const held = deferred(), calls: unknown[] = [];
  const service = createNatalDays({ generateDay: async (date, timezone) => {
    calls.push(date); await held.promise; return makeDay(date, timezone);
  } });
  const handle = createNatalDayHandler(service), requests: ReturnType<typeof start>[] = [];
  t.after(async () => { held.resolve!(); await Promise.all(requests.map(item => item.done)); });
  function start(date: string): { res: EventEmitter & CapturedResponse<Buffer | string> & { destroyed: boolean; writableEnded: boolean }; done: Promise<void> } {
    const req = Readable.from([Buffer.from(JSON.stringify({ birthDate: date, cityId: 'trusted', v: '1' }))]) as IncomingMessage;
    req.method = 'POST'; req.complete = true; req.headers = { 'content-type': 'application/json' };
    const res = new EventEmitter() as EventEmitter & CapturedResponse<Buffer | string> & { destroyed: boolean; writableEnded: boolean };
    res.writeHead = status => { assert.ok(!res.destroyed, 'no response after disconnect'); res.status = status; };
    res.end = body => { res.body = body; res.writableEnded = true; };
    const item = { res, done: handle(req, res as unknown as ServerResponse, cities) }; requests.push(item); return item;
  }
  const obsolete = ['15', '16', '17', '18'].map(day => start(`1990-06-${day}`));
  await tick(); assert.equal(service.queued, 3);
  obsolete.forEach(({ res }) => { res.destroyed = true; res.emit('close'); });
  await tick(); assert.equal(service.queued, 0);
  const latest = start('1990-06-19'); await tick(); assert.equal(service.queued, 1);
  held.resolve!(); await latest.done;
  assert.equal(latest.res.status, 200);
  assert.deepEqual(calls, ['1990-06-15', '1990-06-19']);
});

test('natal cancellation keeps shared queued consumers and the active process slot', async t => {
  const held = deferred(), calls: unknown[] = [], outcomes: Promise<string>[] = [];
  const service = createNatalDays({ generateDay: async (date, timezone) => {
    calls.push(date); await held.promise; return makeDay(date, timezone);
  } });
  const outcome = (promise: Promise<unknown>) => { const result = promise.then(() => 'ready', error => error.name); outcomes.push(result); return result; };
  t.after(async () => { held.resolve!(); await Promise.all(outcomes); });
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
  assert.deepEqual(calls, ['1990-06-15']); assert.equal(service.queued, 2, 'a new consumer must not join an abandoned active job');
  held.resolve!(); assert.equal(await resumed, 'ready'); assert.equal(await latest, 'ready');
  assert.deepEqual(calls, ['1990-06-15', '1990-06-15', '1990-06-17']);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(service.get('1990-06-15', 'UTC', { signal: cancelled.signal }), { name: 'AbortError' });
});

test('a natal retry after cancellation during packing reuses the completed day without regenerating', { timeout: 10000 }, async () => {
  const calls: unknown[] = [];
  const service = createNatalDays({ generateDay: async (date, timezone) => {
    calls.push([date, timezone]); return natalDayFixture({ date, timezone });
  } });
  const controller = new AbortController();
  const first = service.get('1990-06-15', 'UTC', { signal: controller.signal });
  const cancelled = assert.rejects(first, { name: 'AbortError' });
  await tick(); // The generator has returned; real asynchronous packet packing is still underway.
  assert.equal(service.size, 0);
  controller.abort();
  const resumed = service.get('1990-06-15', 'UTC');
  assert.equal(service.queued, 1);
  await cancelled;
  const packet = await resumed;
  assert.equal(decodeNatalDay(packet.bytes.identity).date, '1990-06-15');
  assert.deepEqual(calls, [['1990-06-15', 'UTC']], 'a completed abandoned day must satisfy its queued retry');
  assert.equal(await service.get('1990-06-15', 'UTC'), packet);
  await service.get('1990-06-16', 'UTC');
  assert.deepEqual(calls, [['1990-06-15', 'UTC'], ['1990-06-16', 'UTC']], 'reuse releases the slot for the next date');
});

test('a natal disconnect during upload never submits calculation work', async t => {
  let calls = 0;
  const req = new PassThrough() as PassThrough & IncomingMessage; req.method = 'POST'; req.headers = { 'content-type': 'application/json' };
  const res = new EventEmitter() as EventEmitter & CapturedResponse<Buffer | string> & { destroyed: boolean; writableEnded: boolean }; res.writeHead = () => { throw Error('disconnected response'); }; res.end = () => {};
  const handled = createNatalDayHandler({ get() { calls++; } } as unknown as Parameters<typeof createNatalDayHandler>[0])(req, res as unknown as ServerResponse, cities);
  handled.catch(() => {}); t.after(() => req.destroy());
  req.write('{"birthDate":'); res.emit('close'); await tick();
  assert.equal(req.destroyed, true); await handled; assert.equal(calls, 0);
});

async function request(service: { get: (date: string,timezone: string,{ signal }?: { signal?: AbortSignal; }) => Promise<DayPacket>; size: number; queued: number; }, { method = 'POST', value = { birthDate: '1990-06-15', cityId: 'trusted', v: '1' }, body = JSON.stringify(value), headers = {} }: { method?: string; value?: Record<string, unknown>; body?: string; headers?: Record<string, string> } = {}) {
  const req = Readable.from([Buffer.from(body)]) as IncomingMessage;
  Object.assign(req, { url: '/api/chart/day', method, headers: { host: 'localhost', 'content-type': 'application/json', ...headers } });
  const res = { headersSent: false, writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(body) { this.body = body; } } as CapturedResponse<Buffer | string> & { headersSent: boolean };
  await createRequestHandler({ root, cities, natalDays: service } as unknown as Parameters<typeof createRequestHandler>[0])(req, res as unknown as ServerResponse);
  return res;
}
test('POST returns private negotiated lossless bytes; invalid requests never reach a worker', async () => {
  const calls: unknown[] = [];
  const service = createNatalDays({ root, generateDay: async (date, timezone) => { calls.push([date, timezone]); return makeDay(date, timezone); } });
  for (const [accept, encoding, unpack] of [['br,gzip', 'br', brotliDecompressSync], ['gzip', 'gzip', gunzipSync], ['identity', undefined, (value: Buffer) => value]] as const) {
    const result = await request(service, { headers: { 'accept-encoding': accept } });
    assert.equal(result.status, 200); assert.equal(result.headers['Content-Encoding'], encoding);
    assert.equal(result.headers['Cache-Control'], 'private, no-store'); assert.equal(result.headers.ETag, undefined);
    assert.equal(result.headers['Content-Length'], result.body.length);
    assert.equal(decodeNatalDay(unpack(result.body as Buffer)).timezone, 'Europe/Moscow');
  }
  assert.deepEqual(calls, [['1990-06-15', 'Europe/Moscow']]);
  for (const [options, status] of [[{ method: 'GET' }, 405], [{ method: 'HEAD' }, 405], [{ body: '[]' }, 400], [{ body: '{' }, 400],
    [{ body: ' '.repeat(1025) }, 413], [{ headers: { 'content-type': 'text/plain' } }, 415],
    [{ headers: { origin: 'https://other.example' } }, 403], [{ headers: { 'accept-encoding': '*;q=0' } }, 406]] as const) {
    assert.equal((await request(service, options)).status, status);
  }
  assert.equal(calls.length, 1);
});

test('batch worker sends only date/zone, ignores stderr and waits for termination before releasing slot', async () => {
  let worker!: TestWorker<string>, args;
  const result = generateNatalDay({ root, date: '1990-06-15', timezone: 'Europe/Moscow', timeoutMs: 1, spawnWorker(...values) {
    args = values; worker = new EventEmitter() as TestWorker<string>; worker.stdout = new EventEmitter() as TestWorker['stdout']; worker.stdout.setEncoding = () => {};
    worker.stdin = new EventEmitter() as TestWorker['stdin']; worker.stdin.end = input => { worker.input = input; };
    worker.kill = signal => { worker.killed = signal; }; return worker;
  } });
  assert.deepEqual(JSON.parse(worker!.input), { date: '1990-06-15', timezone: 'Europe/Moscow' });
  assert.deepEqual(args![2].stdio, ['pipe', 'pipe', 'ignore']);
  let finished = false; result.catch(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(worker!.killed, 'SIGKILL'); assert.equal(finished, false);
  worker!.emit('close', null);
  await assert.rejects(result, (error: NatalDayError) => error.code === 'natal_day_timeout');
});

test('real historical and fold days survive production compression and reconstruct reference P+D exactly', async () => {
  const run = promisify(execFile);
  for (const [date, timezone, indices] of [['1900-01-01', 'Europe/Paris', [0, 719, 1439]], ['2024-11-03', 'America/New_York', [0, 90, 150, 1499]]] as const) {
    const source = await generateNatalDay({ root, date, timezone });
    const raw = await encodeNatalDayPacket(source), decoded = decodeNatalDay(raw);
    const bits = (values: ArrayLike<number>) => Buffer.from(new Float64Array(values).buffer).toString('hex');
    assert.deepEqual(decoded.columns.map(bits), source.columns.map(bits));
    const script = `import json\nfrom server.python import calculator as c\nfrom server.python import civil_time as d\nminutes=d.local_minutes(${JSON.stringify(date)},${JSON.stringify(timezone)})\ncharts=[]\nfor i in ${JSON.stringify(indices)}:\n m,offset,fold,seconds=minutes[i]\n local=m+c.dt.timedelta(seconds=seconds)\n charts.append(c.calculate(dict(mode='natal',name='Reference',date=${JSON.stringify(date)},time=local.strftime('%H:%M'),fold=fold,city=dict(id='test',name='Test',timezone=${JSON.stringify(timezone)})))['chart'])\nprint(json.dumps(charts))`;
    const references = JSON.parse((await run(pythonExecutable(root), ['-c', script], { cwd: root, env: pythonEnvironment(), maxBuffer: 100000 })).stdout);
    indices.forEach((index: number, i: string|number) => {
      const chart = chartAtMinute(decoded, index), reference = references[i];
      for (const key of ['activations', 'personality', 'design', 'utc', 'utcOffset', 'fold', 'designUtc', 'designArcResidualDegrees'] as const) assert.deepEqual(chart[key], reference[key], `${timezone} sample ${index}: ${key}`);
      assert.equal(chart.localDate, reference.birthDate, `${timezone} sample ${index}: local date`);
      assert.equal(chart.localTime, reference.birthTime, `${timezone} sample ${index}: local time`);
      assert.equal(natalDayMinute(decoded, index).utc, reference.utc);
    });
  }
});


test('ready natal packets have no calculation marker and repeat reads reuse the prepared bytes', async () => {
  let calls = 0;
  const service = createNatalDays({generateDay:async (date,timezone)=>{calls++;return makeDay(date,timezone);}});
  const value={birthDate:'1990-06-15',cityId:'trusted',v:'1'};
  const first=await request(service,{value}),second=await request(service,{value});
  assert.equal(first.status,200);assert.equal(second.status,200);
  assert.equal(Object.hasOwn(decodeNatalDay(first.body),'calculationVersion'),false);
  assert.deepEqual(second.body,first.body);assert.equal(calls,1);
});
