import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCycles, generateCycles, validateCycleRequest } from '../server/services/cycles.mjs';
import * as cyclesService from '../server/services/cycles.mjs';
import { createCyclesHandler } from '../server/http/cycles.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const requestInput = { birthUtc: '2000-01-01T00:00:00Z', body: 'sun', fromAge: 0, toAge: 100 };
const emptyEvents = input => ({ events: [], range: { fromAge: input.fromAge, toAge: input.toAge } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { resolve, promise }; };
const tick = () => new Promise(setImmediate);
async function expectCancellation(pending, controller) {
  const outcome = pending.then(() => 'resolved', error => error.name);
  controller.abort(); await tick();
  assert.equal(await Promise.race([outcome, Promise.resolve('still pending')]), 'AbortError');
}

test('cycle revisions bind exact calculation inputs including Chiron while interface releases preserve device data', async t => {
  assert.equal(typeof cyclesService.cyclesCalculationFingerprint, 'function');
  const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-cycles-revision-'));
  t.after(() => fs.rm(copy, { recursive: true, force: true }));
  const names = ['server/python/cycles.py', 'server/python/return_index.py', 'server/python/astronomy.py', 'server/python/civil_time.py',
    'server/python/date_limits.py', 'server/python/errors.py', 'requirements.txt', 'server/services/cycles.mjs',
    'shared/cycles-format.js', 'shared/date-limits.js', 'data/ephe/sepl_18.se1', 'data/ephe/semo_18.se1', 'data/ephe/seas_18.se1'];
  for (const name of names) { await fs.mkdir(path.dirname(path.join(copy, name)), { recursive: true }); await fs.copyFile(path.join(root, name), path.join(copy, name)); }
  const original = await cyclesService.cyclesCalculationFingerprint(root);
  assert.match(original, /^[a-f0-9]{64}$/); assert.equal(await cyclesService.cyclesCalculationFingerprint(copy), original);
  for (const name of names.filter(name => name !== 'server/services/cycles.mjs')) {
    const file = path.join(copy, name), before = await fs.readFile(file), stat = await fs.stat(file), changed = Buffer.from(before);
    changed[0] ^= 1; await fs.writeFile(file, changed); await fs.utimes(file, stat.atime, stat.mtime);
    assert.notEqual(await cyclesService.cyclesCalculationFingerprint(copy), original, name);
    await fs.writeFile(file, before);
  }
  const serviceFile = path.join(copy, 'server/services/cycles.mjs');
  await fs.writeFile(serviceFile, (await fs.readFile(serviceFile, 'utf8')).replace('maxQueued: 12', 'maxQueued: 13'));
  assert.equal(await cyclesService.cyclesCalculationFingerprint(copy), original, 'queue capacity does not change astronomical results');
  await fs.mkdir(path.join(copy, 'src')); await fs.writeFile(path.join(copy, 'src/app.js'), 'new interface');
  assert.equal(await cyclesService.cyclesCalculationFingerprint(copy), original);
  await fs.unlink(path.join(copy, 'data/ephe/seas_18.se1'));
  const missingChiron = await cyclesService.cyclesCalculationFingerprint(copy);
  assert.match(missingChiron, /^[a-f0-9]{64}$/); assert.notEqual(missingChiron, original,
    'missing Chiron data keeps the other bodies available and invalidates previously complete device results');
});


test('optional ephemeris files and nested inputs invalidate cycle results', async t => {
  const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-cycles-optional-'));
  t.after(() => fs.rm(copy, { recursive: true, force: true }));
  for (const name of ['server/python', 'server/services/cycles.mjs', 'shared/cycles-format.js', 'shared/date-limits.js', 'requirements.txt', 'data/ephe']) {
    await fs.mkdir(path.dirname(path.join(copy, name)), { recursive: true });
    await fs.cp(path.join(root, name), path.join(copy, name), { recursive: true });
  }
  const original = await cyclesService.cyclesCalculationFingerprint(copy);
  const optional = path.join(copy, 'data/ephe/seleapsec.txt');
  let previous = original;
  for (const content of ['20261231\n', '20271231\n']) {
    await fs.writeFile(optional, content);
    const changed = await cyclesService.cyclesCalculationFingerprint(copy);
    assert.notEqual(changed, previous, 'optional time-conversion inputs belong to the cycle revision');
    previous = changed;
  }
  await fs.unlink(optional);
  assert.equal(await cyclesService.cyclesCalculationFingerprint(copy), original);
  await fs.mkdir(path.join(copy, 'data/ephe/extra'));
  await fs.writeFile(path.join(copy, 'data/ephe/extra/data.se1'), 'nested ephemeris');
  assert.notEqual(await cyclesService.cyclesCalculationFingerprint(copy), original);
});

async function request(service, { path = '/api/cycles/events', method = 'POST', value = requestInput, body = JSON.stringify(value), headers = {} } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  Object.assign(req, { method, headers: { 'content-type': 'application/json', ...headers } });
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  await createCyclesHandler(service)(req, res, new URL(path, 'http://localhost'));
  return res;
}

test('cycle requests preserve exact seconds, strip unrelated input and reject invalid limits before a worker', () => {
  const exact = '2000-01-01T00:00:00.123456Z';
  assert.deepEqual(validateCycleRequest({ ...requestInput, birthUtc: exact, name: 'Not forwarded', city: {}, action: 'chart' }, 'events'), { action: 'events', ...requestInput, birthUtc: exact });
  assert.deepEqual(validateCycleRequest({ birthUtc: exact, body: 'saturn', eventUtc: '2028-07-21T12:36:05.920740Z', timezone: 'Europe/London' }, 'chart'), { action: 'chart', birthUtc: exact, body: 'saturn', eventUtc: '2028-07-21T12:36:05.920740Z', timezone: 'Europe/London' });
  for (const change of [{ birthUtc: '2000-02-30T00:00:00Z' }, { birthUtc: '2000-01-01T00:00Z' }, { birthUtc: '2400-01-01T00:00:00Z' },
    { body: 'earth' }, { body: '__proto__' }, { fromAge: -1 }, { fromAge: '0' }, { toAge: 301 }, { toAge: 121 }, { fromAge: 2, toAge: 1 },
    { birthUtc: '2399-01-01T00:00:00Z', toAge: 2 }]) assert.throws(() => validateCycleRequest({ ...requestInput, ...change }, 'events'));
  for (const eventUtc of ['1999-01-01T00:00:00Z', requestInput.birthUtc, '2301-01-01T00:00:00Z']) assert.throws(() => validateCycleRequest({ ...requestInput, eventUtc }, 'chart'));
  assert.throws(() => validateCycleRequest({ ...requestInput, eventUtc: '2028-07-21T12:36:05Z', timezone: '../UTC' }, 'chart'));
});

test('transport is POST JSON only, private, bounded and never launches invalid requests', async () => {
  const calls = [], service = { events: async input => { calls.push(input); return emptyEvents(input); } };
  const good = await request(service);
  assert.equal(good.status, 200); assert.equal(good.headers['Cache-Control'], 'private, no-store'); assert.equal(good.headers.ETag, undefined);
  assert.equal(calls.length, 1);
  for (const [options, status] of [[{ method: 'GET' }, 405], [{ method: 'HEAD' }, 405], [{ body: '[]' }, 400], [{ body: '{' }, 400],
    [{ body: ' '.repeat(2049) }, 413], [{ headers: { 'content-type': 'text/plain' } }, 415], [{ value: { ...requestInput, toAge: 200 } }, 422]]) {
    const response = await request(service, options); assert.equal(response.status, status); assert.equal(response.headers['Cache-Control'], 'private, no-store');
  }
  assert.equal(calls.length, 1);
});

test('a stale device calculation version is rejected before work and all cycle responses stay private', async () => {
  const cacheVersion = 'a'.repeat(64); let calls = 0;
  const service = createCycles({ cacheVersion, generate: async input => { calls++; return emptyEvents(input); } });
  assert.equal(service.cacheVersion, cacheVersion);
  for (const version of ['', 'old', 'b'.repeat(64), cacheVersion.toUpperCase()]) {
    const result = await request(service, { headers: { 'x-forma-cycles-version': version } });
    assert.equal(result.status, 400); assert.equal(JSON.parse(result.body).error, 'unsupported_version');
    assert.equal(result.headers['Cache-Control'], 'private, no-store');
  }
  assert.equal(calls, 0);
  const valid = await request(service, { headers: { 'x-forma-cycles-version': cacheVersion } });
  assert.equal(valid.status, 200); assert.equal(valid.headers['Cache-Control'], 'private, no-store');
  assert.equal((await request(service)).status, 200, 'unversioned callers remain supported without device persistence');
  assert.equal(calls, 1); await service.close();
});

test('bounded singleflight queue and cache expire without persisting birth data', async () => {
  let instant = 0, calls = 0, active = 0, maximum = 0;
  const release = deferred();
  const service = createCycles({ root, now: () => instant, limits: { concurrency: 1, maxQueued: 1, capacity: 1, ttlMs: 10 }, generate: async input => {
    calls++; active++; maximum = Math.max(active, maximum); if (calls === 1) await release.promise; active--; return emptyEvents(input);
  } });
  const first = service.events(requestInput); assert.equal(service.events(requestInput), first);
  const second = service.events({ ...requestInput, body: 'saturn' });
  await assert.rejects(service.events({ ...requestInput, body: 'jupiter' }), error => error.code === 'cycles_busy');
  assert.equal(service.queued, 1); release.resolve(); await Promise.all([first, second]);
  assert.equal(maximum, 1); assert.equal(service.size, 1); assert.equal(calls, 2);
  await service.events({ ...requestInput, body: 'saturn' }); assert.equal(calls, 2);
  instant = 11; assert.equal(service.size, 0);
  await service.events({ ...requestInput, body: 'saturn' }); assert.equal(calls, 3);
  const replacement = createCycles({ root, generate: async input => { calls++; return emptyEvents(input); } });
  await replacement.events({ ...requestInput, body: 'saturn' }); assert.equal(calls, 4);
});

test('one cancelled consumer leaves shared queued work for the other consumer', async () => {
  const jobs = [], service = createCycles({ limits: { concurrency: 1 }, generate: input => {
    const hold = deferred(); jobs.push({ input, finish: () => hold.resolve(emptyEvents(input)) }); return hold.promise;
  } });
  const running = service.events(requestInput), one = new AbortController(), two = new AbortController();
  const sharedInput = { ...requestInput, body: 'saturn' };
  const cancelled = service.events(sharedInput, { signal: one.signal }), kept = service.events(sharedInput, { signal: two.signal });
  await expectCancellation(cancelled, one);
  assert.equal(service.queued, 1); assert.equal(jobs.length, 1);
  jobs[0].finish(); await running; await tick();
  assert.equal(jobs.length, 2); jobs[1].finish(); assert.deepEqual(await kept, emptyEvents(sharedInput)); await service.close();
});

test('abandoning every queued consumer frees admission for the latest request without starting obsolete workers', async () => {
  const jobs = [], service = createCycles({ limits: { concurrency: 1, maxQueued: 1 }, generate: input => {
    const hold = deferred(); jobs.push({ input, finish: () => hold.resolve(emptyEvents(input)) }); return hold.promise;
  } });
  const running = service.events(requestInput), cancel = new AbortController(), other = new AbortController();
  const obsolete = service.events({ ...requestInput, body: 'saturn' }, { signal: cancel.signal });
  const shared = service.events({ ...requestInput, body: 'saturn' }, { signal: other.signal });
  await expectCancellation(obsolete, cancel);
  assert.equal(service.queued, 1);
  await expectCancellation(shared, other);
  assert.equal(service.queued, 0); assert.equal(service.active, 1);
  const latest = service.events({ ...requestInput, body: 'jupiter' });
  assert.equal(service.queued, 1); jobs[0].finish(); await running; await tick();
  assert.deepEqual(jobs.map(job => job.input.body), ['sun', 'jupiter']);
  jobs[1].finish(); await latest; await service.close();
});

test('abandoned running work retains its slot until close and a new consumer starts fresh work', async () => {
  const hold = deferred(); let calls = 0;
  const service = createCycles({ limits: { concurrency: 1 }, generate: async input => { calls++; await hold.promise; return emptyEvents(input); } });
  const cancel = new AbortController(), first = service.events(requestInput, { signal: cancel.signal });
  await expectCancellation(first, cancel);
  assert.equal(service.active, 1);
  const resumed = service.events(requestInput); hold.resolve(); await resumed;
  assert.equal(calls, 2); assert.equal(service.active, 0); assert.equal(service.size, 1);
  await service.close();
});

test('an already aborted consumer cannot start, join or read completed work', async () => {
  let calls = 0;
  const hold = deferred(), service = createCycles({ generate: async input => { calls++; await hold.promise; return emptyEvents(input); } });
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(service.events(requestInput, { signal: cancelled.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
  const active = service.events(requestInput);
  await assert.rejects(service.events(requestInput, { signal: cancelled.signal }), { name: 'AbortError' });
  hold.resolve(); await active;
  await assert.rejects(service.events(requestInput, { signal: cancelled.signal }), { name: 'AbortError' });
  assert.equal(calls, 1); await service.close();
});

test('disconnecting before the POST body is complete never submits calculation work', async t => {
  let calls = 0; const req = new PassThrough(); req.method = 'POST'; req.headers = { 'content-type': 'application/json' };
  const res = new EventEmitter(); res.writeHead = () => { throw Error('disconnected response'); }; res.end = () => {};
  const handled = createCyclesHandler({ events() { calls++; } })(req, res, new URL('http://localhost/api/cycles/events'));
  handled.catch(() => {}); t.after(() => req.destroy());
  req.write('{"birthUtc":'); res.emit('close');
  await tick(); assert.equal(req.destroyed, true); await handled; assert.equal(calls, 0);
});

test('HTTP disconnection removes an abandoned queued request and shutdown still waits for running work', async () => {
  const hold = deferred(), inputs = [], service = createCycles({ limits: { concurrency: 1 }, generate: async input => {
    inputs.push(input); await hold.promise; return emptyEvents(input);
  } });
  const running = service.events(requestInput);
  const req = Readable.from([Buffer.from(JSON.stringify({ ...requestInput, body: 'saturn' }))]);
  req.method = 'POST'; req.headers = { 'content-type': 'application/json' };
  const res = new EventEmitter(); res.writeHead = () => { throw Error('disconnected response'); }; res.end = () => {};
  const handled = createCyclesHandler(service)(req, res, new URL('http://localhost/api/cycles/events'));
  handled.catch(() => {});
  await tick(); assert.equal(service.queued, 1); res.emit('close'); await tick();
  assert.equal(service.queued, 0); await handled; assert.deepEqual(inputs.map(input => input.body), ['sun']);
  let closed = false; const closing = service.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); hold.resolve(); await running; await closing;
  assert.equal(service.active, 0); assert.equal(service.size, 0);
});

test('worker failure releases admission; invalid results and approximate fallbacks cannot reach clients', async () => {
  let calls = 0;
  const service = createCycles({ root, generate: async input => {
    if (++calls === 1) return { error: 'ephemeris_unavailable', message: 'Точные данные отсутствуют.', body: input.body };
    if (calls === 2) return { ...emptyEvents(input), events: [{ body: 'wrong' }] };
    return emptyEvents(input);
  } });
  const result = await request(service, { value: { ...requestInput, body: 'chiron' } });
  assert.equal(result.status, 422); assert.equal(JSON.parse(result.body).error, 'ephemeris_unavailable'); assert.equal(JSON.parse(result.body).body, 'chiron');
  assert.equal(service.size, 0);
  await assert.rejects(service.events(requestInput), error => error.code === 'cycles_unavailable');
  await service.events(requestInput); assert.equal(service.size, 1);
});

test('worker timeout waits for actual close; stdin is limited to calculation fields and stderr is ignored', async () => {
  let worker, options;
  const output = generateCycles({ root, input: { ...requestInput, action: 'events', name: 'Private display name' }, timeoutMs: 1,
    spawnWorker(...args) {
      options = args[2]; worker = new EventEmitter(); worker.stdout = new EventEmitter(); worker.stdout.setEncoding = () => {};
      worker.stdin = new EventEmitter(); worker.stdin.end = value => { worker.input = JSON.parse(value); };
      worker.kill = signal => { worker.killed = signal; }; return worker;
    } });
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']); assert.equal(worker.input.name, undefined);
  let settled = false; output.catch(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(worker.killed, 'SIGKILL'); assert.equal(settled, false);
  worker.emit('close', null); await assert.rejects(output, error => error.code === 'cycles_timeout');
});

test('real worker returns exact reference events and chart without minute truncation', async () => {
  const input = { ...requestInput, action: 'events', body: 'saturn', fromAge: 28, toAge: 30 };
  const result = await generateCycles({ root, input });
  assert.equal(result.events.length, 3); assert.deepEqual(result.events.map(item => item.pass), [1, 2, 3]);
  assert.equal(result.events[0].utc.slice(0, 19), '2028-07-21T12:36:05');
  const chart = await generateCycles({ root, input: { action: 'chart', birthUtc: requestInput.birthUtc, body: 'saturn', eventUtc: result.events[0].utc, timezone: 'Europe/London' } });
  assert.equal(chart.chart.birthTime, '13:36'); assert.equal(chart.chart.utc, result.events[0].utc);
  assert.equal(chart.chart.activations.personality.length, 13); assert.equal(chart.chart.activations.design.length, 13);
  const service = createCycles({ root });
  await assert.rejects(service.chart({ birthUtc: requestInput.birthUtc, body: 'saturn', eventUtc: '2028-07-21T12:36:00Z', timezone: 'UTC' }), error => error.code === 'invalid_event');
  await service.close();
});

test('closing cycles rejects queued and new work, waits for the active worker and drops cached personal results', async () => {
  const waiting = deferred();
  const service = createCycles({ root, limits: { concurrency: 1 }, generate: async input => { await waiting.promise; return emptyEvents(input); } });
  const active = service.events(requestInput);
  const queued = service.events({ ...requestInput, body: 'saturn' }, { signal: new AbortController().signal });
  const rejected = assert.rejects(queued, error => error.code === 'cycles_unavailable');
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  await rejected;
  await assert.rejects(service.events(requestInput), error => error.code === 'cycles_unavailable');
  assert.equal(closed, false); assert.equal(service.queued, 0);
  waiting.resolve(); await active; await closing;
  assert.equal(closed, true); assert.equal(service.active, 0); assert.equal(service.size, 0);
});

test('native HTTP routes forward cycle events and charts while cross-origin calls never reach their service', async () => {
  const { createRequestHandler } = await import('../server/http/app.mjs');
  const calls = [];
  const handler = createRequestHandler({ root, cities: {}, calculate: () => {},
    cycles: { events: async input => { calls.push(input); return emptyEvents(input); },
      chart: async input => { calls.push(input); return { chart: { utc: input.eventUtc } }; } },
    publicFiles: async (_, res) => { res.writeHead(404, {}); res.end(); } });
  async function call(path, value, origin = 'http://localhost:4176') {
    const req = Readable.from([Buffer.from(JSON.stringify(value))]);
    Object.assign(req, { url: path, method: 'POST', headers: { host: 'localhost:4176', origin, 'content-type': 'application/json' } });
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
    await handler(req, res); return res;
  }
  assert.equal((await call('/api/cycles/events', requestInput)).status, 200);
  assert.equal((await call('/api/cycles/chart', { birthUtc: requestInput.birthUtc, body: 'sun', eventUtc: '2000-12-31T05:46:22Z', timezone: 'UTC' })).status, 200);
  assert.deepEqual(calls.map(input => input.action), ['events', 'chart']);
  assert.equal((await call('/api/cycles/events', requestInput, 'https://unrelated.example')).status, 403);
  assert.equal(calls.length, 2);
});

test('opening a known UTC needs no cached event descriptor and ignores client-provided metadata', async () => {
  const observed = [];
  const service = createCycles({ root, generate: async (input, trusted) => {
    observed.push({ input, trusted });
    return generateCycles({ root, input, ...trusted });
  } });
  const input = { ...requestInput, body: 'saturn', fromAge: 28, toAge: 30 };
  const list = await service.events(input), event = list.events[2];
  const exact = { birthUtc: input.birthUtc, body: input.body, eventUtc: event.utc, timezone: 'Europe/London' };
  const chart = await service.chart({ ...exact, verifiedEvent: { ...event, cycle: 99 } });
  assert.equal(observed[1].trusted?.verifiedEvent, undefined);
  assert.equal(observed[1].input.verifiedEvent, undefined);
  assert.equal(chart.event, undefined); assert.equal(chart.chart.utc, event.utc);
  const direct = await generateCycles({ root, input: { ...exact, action: 'chart' } });
  const numbers = value => { const { createdAt, updatedAt, ...rest } = value.chart; return { ...value, chart: rest }; };
  assert.deepEqual(numbers(chart), numbers(direct));
  await assert.rejects(service.chart({ ...exact, eventUtc: '2028-07-21T12:36:00Z', verifiedEvent: event }), error => error.code === 'invalid_event');
  assert.equal(observed[2].trusted?.verifiedEvent, undefined, 'a different UTC cannot borrow the cached event');
  await service.close();
});

function cycleWorker(encoded, code = 0) {
  return () => {
    const worker = new EventEmitter(); worker.pid = 123;
    worker.stdout = new EventEmitter(); worker.stdout.setEncoding = () => {};
    worker.stdin = new EventEmitter();
    worker.stdin.end = () => queueMicrotask(() => { worker.stdout.emit('data', encoded); worker.emit('close', code); });
    worker.kill = () => queueMicrotask(() => worker.emit('close', 1));
    return worker;
  };
}

test('the worker and service composition semantically validates every event once before caching', async t => {
  const input = { ...requestInput, body: 'moon' }, parse = Date.parse, birth = parse(input.birthUtc);
  const output = { ...emptyEvents(input), events: Array.from({ length: 1000 }, (_, index) => {
    const time = birth + (index + 1) * 27 * 86400000, utc = new Date(time).toISOString().replace('.000Z', 'Z');
    return { body: 'moon', utc, age: (time - birth) / (365.2425 * 86400000), id: `moon:${utc}`,
      cycle: index + 1, pass: 1, cycleId: `moon:${index + 1}`, direction: 'direct' };
  }) };
  const reads = { birth: 0, event: 0 }; let workers = 0;
  Date.parse = value => {
    if (new Error().stack.includes('validCycleEvent')) reads[value === input.birthUtc ? 'birth' : 'event']++;
    return parse(value);
  };
  t.after(() => { Date.parse = parse; });
  const service = createCycles({ root, generate: input => {
    workers++;
    return generateCycles({ root, input, spawnWorker: cycleWorker(JSON.stringify(output)) });
  } });
  t.after(() => service.close());
  const result = await service.events(input);
  assert.deepEqual(result, output); assert.equal(service.size, 1);
  assert.equal(reads.birth, output.events.length, 'one age check per event at the publication boundary');
  const acceptedReads = { ...reads };
  assert.equal(await service.events(input), result);
  assert.deepEqual(reads, acceptedReads, 'the accepted RAM entry requires no further semantic walk');
  assert.equal(workers, 1);
});

test('the publication boundary validates worker and injected results, maps errors and never caches failures', async () => {
  const invalidResults = [null, [], {}, { ...emptyEvents(requestInput), events: [{ body: 'wrong' }] },
    { ...emptyEvents(requestInput), events: Array(2001).fill({}) },
    { error: 'unknown_error', message: 'untrusted detail' }];
  for (const transport of ['injected', 'worker']) {
    for (const result of invalidResults) {
      const service = createCycles({ root, generate: input => transport === 'injected' ? Promise.resolve(result)
        : generateCycles({ root, input, spawnWorker: cycleWorker(JSON.stringify(result)) }) });
      await assert.rejects(service.events(requestInput), error => error.code === 'cycles_unavailable' && error.status === 503);
      assert.equal(service.size, 0); assert.equal(service.active, 0); await service.close();
    }
    for (const body of ['sun', 'wrong']) {
      const result = { error: 'ephemeris_unavailable', message: 'Точные данные отсутствуют.', body };
      const service = createCycles({ root, generate: input => transport === 'injected' ? Promise.resolve(result)
        : generateCycles({ root, input, spawnWorker: cycleWorker(JSON.stringify(result)) }) });
      await assert.rejects(service.events(requestInput), error => error.code === result.error && error.status === 422
        && error.message === result.message && error.details.body === (body === 'sun' ? body : undefined));
      assert.equal(service.size, 0); await service.close();
    }
  }
  for (const [encoded, options] of [['{', {}], [JSON.stringify(emptyEvents(requestInput)), { maxOutputBytes: 5 }]]) {
    const service = createCycles({ root, generate: input => generateCycles({ root, input, spawnWorker: cycleWorker(encoded), ...options }) });
    await assert.rejects(service.events(requestInput), error => error.code === 'cycles_unavailable');
    assert.equal(service.active, 0); assert.equal(service.size, 0); await service.close();
  }
});


test('a missing return index remains a retryable 503 with its own error code', async t => {
  let calls = 0;
  const service = createCycles({ generate: async input => ++calls === 1
    ? { error: 'return_index_unavailable', message: 'Индекс возвратов ещё не создан.', body: input.body }
    : emptyEvents(input) });
  t.after(() => service.close());
  const failed = await request(service);
  assert.equal(failed.status, 503);
  assert.equal(JSON.parse(failed.body).error, 'return_index_unavailable');
  assert.equal(JSON.parse(failed.body).message, 'Индекс возвратов ещё не создан.');
  assert.equal(failed.headers['Retry-After'], '3');
  assert.equal(failed.headers['Cache-Control'], 'private, no-store');
  assert.equal((await request(service)).status, 200);
  assert.equal(calls, 2, 'failed preparation is not cached as an empty completed list');
});
