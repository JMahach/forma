import type { SavedReturnView } from '../src/data/view-store.ts';
import type { ChartInput } from '../src/domain/chart-composition.ts';
import type { CycleInput } from '../shared/cycles-format.ts';
import { deferred } from './helpers/deferred.ts';
import type { CycleEvent, CycleEventsResult, CycleChartResult } from '../shared/cycles-format.ts';
import type { TestCyclesOptions, TestReturnsOptions } from './fixtures/returns.ts';
import type {LegacyReturnStorage as ReturnStorage} from './fixtures/returns.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCyclesClient } from './fixtures/returns.ts';
import { createReturnsController } from './fixtures/returns.ts';
import { CYCLE_BODIES, DEFAULT_CYCLE_BODIES } from '../src/domain/cycles.ts';
import { libraryRecordAtMinute } from './fixtures/natal-day.ts';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.ts';
const tick = () => new Promise(setImmediate);
const natal = () => libraryRecordAtMinute(natalDayFixture({ date: '2000-01-01' }), 0, personalChartFixture({ id: 'saved-natal' }));
const event = { body: 'saturn', utc: '2028-07-21T12:36:05.920740Z', cycle: 1, pass: 1, direction: 'direct' as const } as CycleEvent;
event.id = `${event.body}:${event.utc}`; event.cycleId = 'saturn:1'; event.age = (Date.parse(event.utc) - Date.parse(natal().utc)) / (365.2425 * 86400000);
const input = { birthUtc: natal().utc, body: 'saturn', fromAge: 0, toAge: 100 };
const packet = (value: CycleInput = input) => ({ range: { fromAge: value.fromAge!, toAge: value.toAge! }, events: value.body === 'saturn' ? [event] : [] });
const chartResult = { chart: { ...natal(), utc: event.utc } as CycleChartResult['chart'] };
// These doubles preserve raw reads and absent write receipts. The client validates
// stored data and ignores receipts; only the fixture-to-port boundary is narrowed.
type StorageDouble = Partial<{
  [K in 'getEvents' | 'putEvents' | 'removeEvents' | 'getChart' | 'putChart' | 'removeChart']:
    (...args: Parameters<ReturnStorage[K]>) => Promise<unknown>;
}>;
function storageDouble<T extends StorageDouble>(value: T) {
  return value as unknown as Omit<T, keyof ReturnStorage> & Partial<ReturnStorage>;
}

function device() { const records = new Map<string, unknown>(); return storageDouble({ records, getEvents: async (key: string) => records.get(key), putEvents: async (key: string, _input: CycleInput, data: CycleEventsResult) => { records.set(key, data); }, removeEvents: async (key: string) => { records.delete(key); },
  getChart: async (key: string) => records.get(key), putChart: async (key: string, data: unknown) => { records.set(key, data); }, removeChart: async (key: string) => { records.delete(key); } }); }

test('full return charts persist across reloads while standalone dates are requested again', async () => {
  const storage = device(), calls: string[] = [];
  const options: TestCyclesOptions = { returnStorage: storage, request: async (url: string) => { calls.push(url); return url.endsWith('/chart') ? chartResult : packet(); } };
  const first = createCyclesClient(options), chartInput = { birthUtc: input.birthUtc, body: 'saturn', eventUtc: event.utc, timezone: 'UTC' };
  await first.events(input); await tick(); await first.chart(chartInput);
  await first.chart(chartInput);
  const reload = createCyclesClient(options); await reload.events(input); await reload.chart(chartInput);
  assert.equal(calls.filter(url => url.endsWith('/events')).length, 2);
  assert.equal(calls.filter(url => url.endsWith('/chart')).length, 1);
  assert.equal(storage.records.size, 1);
});

test('two consumers share a dates lookup but cancel independently', async () => {
  const waiting = deferred(), cancel = new AbortController(); let calls = 0, transport: AbortSignal | null | undefined;
  const client = createCyclesClient({ request: async (_url, { signal }) => { calls++; transport = signal; return waiting.promise; } });
  const first = client.events(input, cancel.signal), second = client.events(input); await tick();
  cancel.abort(); assert.equal(transport!.aborted, false); waiting.resolve!(packet());
  await assert.rejects(first, { name: 'AbortError' }); await second;
  assert.equal(calls, 1);
});

test('selecting a saved natal prepares default bodies without opening the panel; filters and close do not cancel preparation', async () => {
  const jobs: (ReturnType<typeof deferred<CycleEventsResult>> & { value: CycleInput; signal?: AbortSignal })[] = [];
  const control = createReturnsController({ client: { events(value, signal) { const job = { value, signal, ...deferred<CycleEventsResult>() }; jobs.push(job); return job.promise; } } });
  control.select(natal()); await tick();
  assert.deepEqual(new Set(jobs.map(job => job.value.body)), new Set(DEFAULT_CYCLE_BODIES));
  assert.equal(control.state.opened, false);
  control.setBodies([]); control.close();
  assert.ok(jobs.every(job => !job.signal!.aborted));
  jobs.forEach(job => job.resolve(packet(job.value))); await tick();
  await control.setBodies(['saturn']); assert.equal(control.state.events.length, 1);
  assert.equal(jobs.length, DEFAULT_CYCLE_BODIES.length);
});

test('restoration uses the current dates descriptor instead of an obsolete saved ordinal', async () => {
  const fresh = { ...event, cycle: 2, cycleId: 'saturn:2', pass: 3 };
  const control = createReturnsController({ client: { events: async value => ({ ...packet(value), events: value.body === 'saturn' ? [fresh] : [] }), chart: async () => chartResult } });
  control.select(natal());
  assert.equal(await control.restore({ opened: false, bodies: ['saturn'], year: null, eventId: event.id, event } as unknown as SavedReturnView), true);
  assert.equal(control.state.selectedEvent, fresh);
});

test('a selected exact chart starts while other body lists are pending', async () => {
  const jobs: (ReturnType<typeof deferred<CycleEventsResult>> & { value: CycleInput; signal?: AbortSignal })[] = []; let chartCalls = 0;
  const control = createReturnsController({ client: { events(value) { if (value.body === 'saturn') return Promise.resolve(packet(value)); const job = { value, ...deferred<CycleEventsResult>() }; jobs.push(job); return job.promise; }, chart: async () => { chartCalls++; return chartResult; } } });
  control.select(natal()); await tick();
  assert.equal(await control.selectEvent(event.id), true);
  assert.equal(chartCalls, 1); assert.equal(control.current!.utc, event.utc);
  jobs.forEach(job => job.resolve(packet(job.value))); await tick();
});

test('a remaining shared consumer receives a readable timeout after the first consumer cancelled', async () => {
  const firstController = new AbortController();
  const client = createCyclesClient({ timeoutMs: 10, request: (_url, { signal }) => new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })) });
  const first = client.events(input, firstController.signal), second = client.events(input);
  firstController.abort(); await assert.rejects(first, { name: 'AbortError' });
  await assert.rejects(second, /не успел завершиться/);
});

test('an obsolete saved exact UTC is acknowledged without calculating an unverified return', async () => {
  let charts = 0;
  const control = createReturnsController({ client: { events: async value => ({ range: { fromAge: value.fromAge!, toAge: value.toAge! }, events: [] }), chart: async () => { charts++; return chartResult; } } });
  control.select(natal());
  assert.equal(await control.restore({ opened: false, bodies: ['saturn'], eventId: event.id, event } as unknown as SavedReturnView), true);
  assert.equal(charts, 0); assert.equal(control.state.selectedEvent, null);
});

test('A to B to A ignores the abandoned response and keeps the last dates request alive', async () => {
  const storage = device(), jobs: (ReturnType<typeof deferred<CycleEventsResult>> & { signal?: AbortSignal | null })[] = [];
  const client = createCyclesClient({ returnStorage: storage, request: async (_url, { signal }) => { const job = { signal, ...deferred<CycleEventsResult>() }; jobs.push(job); return job.promise; } });
  const cancelled = new AbortController();
  const first = client.events(input, cancelled.signal); await tick();
  cancelled.abort(); await assert.rejects(first, { name: 'AbortError' });
  const latest = client.events(input); await tick();
  jobs[0].resolve(packet()); await tick(); assert.equal(storage.records.size, 0);
  assert.equal(jobs[1].signal!.aborted, false); jobs[1].resolve(packet());
  await latest; await tick(); assert.equal(storage.records.size, 0);
  assert.deepEqual(await client.readEvents(input),packet());assert.equal(jobs.length,2);
});

test('a RAM chart and a selected ready list never wait for other bodies being prepared', async () => {
  const storage = device(), waiting = deferred(); let requests = 0;
  const client = createCyclesClient({ returnStorage: storage, request: async url => { requests++; return url.endsWith('/chart') ? chartResult : waiting.promise; } });
  const chartInput = { birthUtc: input.birthUtc, body: 'saturn', eventUtc: event.utc, timezone: 'UTC' };
  const ready = await client.chart(chartInput), pending = client.events(input); await tick();
  assert.equal(await client.chart(chartInput), ready); assert.equal(requests, 2);
  waiting.resolve!(packet()); await pending;
});

test('one failed body never erases successful empty lists or retries them', async () => {
  const calls = new Map();
  const control = createReturnsController({ client: { events: async value => {
    calls.set(value.body, (calls.get(value.body) || 0) + 1);
    if (value.body === 'saturn' && calls.get(value.body) === 1) throw new Error('Retry Saturn');
    return { range: { fromAge: value.fromAge!, toAge: value.toAge! }, events: [] };
  } } });
  control.select(natal()); await control.open(); await control.retry();
  await control.setBodies(CYCLE_BODIES.map(body => body.id));
  assert.equal(calls.get('saturn'), 2);
  assert.ok([...calls].filter(([body]) => body !== 'saturn').every(([, count]) => count === 1));
  assert.deepEqual(control.state.events, []);
});

test('dates completed by another tab are readable before this tab’s older same-key request finishes', async () => {
  const waiting = deferred(); let stored: unknown = null, calls = 0;
  const client = createCyclesClient({ returnStorage: storageDouble({ getEvents: async () => stored, putEvents: async () => {} }),
    request: async () => { calls++; return waiting.promise; } });
  const first = client.events(input); await tick(); stored = packet();
  const second = client.events(input);
  const ready = await Promise.race([second.then(() => true), tick().then(() => false)]);
  waiting.resolve!(packet()); await Promise.all([first, second]);
  assert.equal(ready, true, 'a completed device result must bypass an unfinished request');
  assert.equal(calls, 1);
});

test('a stale device miss reuses the same-key network result that completed during its read', async () => {
  const network = deferred(), disk = deferred(); let reads = 0, requests = 0;
  const client = createCyclesClient({ returnStorage: storageDouble({ getEvents: () => ++reads === 1 ? Promise.resolve(null) : disk.promise, putEvents: async () => {} }),
    request: async () => { requests++; return network.promise; } });
  const first = client.events(input); await tick(); const second = client.events(input); await tick();
  network.resolve!(packet()); await first; disk.resolve!(null); await second;
  assert.equal(requests, 1, 'a stale read is not permission to repeat a completed search');
});

test('an aborted captured request does not replace a later consumer’s own live result', async () => {
  const disk = deferred(), jobs: (ReturnType<typeof deferred<CycleEventsResult>> & { signal?: AbortSignal | null })[] = []; let reads = 0;
  const client = createCyclesClient({ returnStorage: storageDouble({ getEvents: () => ++reads === 1 ? Promise.resolve(null) : disk.promise, putEvents: async () => {} }),
    request: async (_url, { signal }) => { const job = { signal, ...deferred<CycleEventsResult>() }; jobs.push(job); return job.promise; } });
  const controller = new AbortController(), first = client.events(input, controller.signal); await tick();
  const next = client.events(input); await tick(); controller.abort(); await assert.rejects(first, { name: 'AbortError' });
  disk.resolve!(null); await tick(); assert.equal(jobs.length, 2); assert.equal(jobs[1].signal!.aborted, false);
  jobs[0].resolve(packet()); const fresh = { ...packet(), events: [] }; jobs[1].resolve(fresh);
  assert.equal(await next, fresh);
});

for (const ambiguous of [false, true] as const) test(`restoration ${ambiguous ? 'rejects ambiguous' : 'accepts one'} fresh microsecond refinement`, async () => {
  const refined = { ...event, utc: '2028-07-21T12:36:05.920780Z', cycle: 2, cycleId: 'saturn:2' };
  refined.id = `${refined.body}:${refined.utc}`;
  const rival = { ...refined, utc: '2028-07-21T12:36:06.100000Z', id: 'saturn:2028-07-21T12:36:06.100000Z' };
  const events = ambiguous ? [refined, rival] : [refined], requested: CycleInput[] = [];
  const control = createReturnsController({ client: {
    events: async value => ({ ...packet(value), events: value.body === 'saturn' ? events : [] }),
    chart: async value => { requested.push(value); return { chart: { ...natal(), utc: value.eventUtc } as CycleChartResult['chart'] }; },
  } });
  control.select(natal()); await control.restore({ opened: false, bodies: ['saturn'], eventId: event.id, event } as unknown as SavedReturnView);
  assert.equal(control.state.selectedEvent, ambiguous ? null : refined);
  assert.deepEqual(requested.map(value => value.eventUtc), ambiguous ? [] : [refined.utc]);
});

test('an exact current event wins restoration even with another event inside the refinement window', async () => {
  const nearby = { ...event, utc: '2028-07-21T12:36:06.100000Z', id: 'saturn:2028-07-21T12:36:06.100000Z' };
  const control = createReturnsController({ client: { events: async value => ({ ...packet(value), events: value.body === 'saturn' ? [event, nearby] : [] }), chart: async () => chartResult } });
  control.select(natal());
  assert.equal(await control.restore({ opened: false, bodies: ['saturn'], eventId: event.id, event } as unknown as SavedReturnView), true);
  assert.equal(control.state.selectedEvent, event);
});


for (const drop of ['reset', 'exit', 'select'] as const) test(`selected return retains memory until ${drop}`, async () => {
  const holds: { value: CycleInput; data: unknown; released: boolean }[] = [], waiting = deferred<CycleChartResult>(); let next = false;
  const client: NonNullable<TestReturnsOptions['client']> = { events: async (value: CycleInput) => packet(value), chart: async () => next ? waiting.promise : chartResult,
    retainChart(value, data) { const hold = { value, data, released: false }; holds.push(hold); return () => { hold.released = true; }; } };
  const control = createReturnsController({ client });
  await control.select(natal()); await control.selectEvent(event.id);
  assert.equal(holds.length, 1);
  assert.deepEqual(holds[0].value, { birthUtc: input.birthUtc, body: event.body, eventUtc: event.utc, timezone: natal().timezone || 'UTC' });
  assert.equal(holds[0].data, chartResult);
  control.select({ ...natal(), name: 'Renamed' }); control.close(); await control.setBodies([]);
  assert.equal(holds[0].released, false, 'metadata, filters and tools do not drop the shown chart');
  next = true; const pending = control.selectEvent(event.id); await tick();
  assert.equal(holds[0].released, false, 'previous chart stays visible during replacement');
  if (drop === 'select') await control.select({ ...natal(), id: 'another' }); else control[drop]();
  assert.equal(holds[0].released, true);
  waiting.resolve!(chartResult); await pending;
  assert.equal(holds.length, 1, 'abandoned result never becomes retained');
});

test('accepted replacement retains the new return before releasing the previous one', async () => {
  const order: unknown[] = [];
  const control = createReturnsController({ client: { events: async value => packet(value), chart: async () => chartResult,
    retainChart() { order.push('retain'); return () => order.push('release'); } } });
  await control.select(natal()); await control.selectEvent(event.id); await control.selectEvent(event.id);
  assert.deepEqual(order, ['retain', 'retain', 'release']);
  control.reset(); assert.deepEqual(order, ['retain', 'retain', 'release', 'release']);
});

test('cache-only lookup restores a full chart after reload but leaves absent standalone dates absent', async () => {
  const storage=device();let requests=0;
  const options:TestCyclesOptions={returnStorage:storage,request:async url=>{requests++;return url.endsWith('/chart')?chartResult:packet();}};
  const first=createCyclesClient(options),exact={birthUtc:input.birthUtc,body:'saturn',eventUtc:event.utc,timezone:'UTC'};
  await first.events(input);await first.chart(exact,undefined,{event});await tick();
  const before=requests,second=createCyclesClient(options);
  assert.deepEqual((await first.readEvents(input))?.events,[event]);
  assert.equal(await second.readEvents(input),null);
  assert.equal((await second.readChart(exact))?.chart.utc,event.utc);
  assert.equal(await second.readEvents({...input,body:'chiron'}),null);
  assert.equal(await second.readChart({...exact,eventUtc:'2029-01-01T00:00:00Z'}),null);
  assert.equal(requests,before);first.close();second.close();
});
