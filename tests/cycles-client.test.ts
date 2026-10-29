import type { CycleInput } from '../shared/cycles-format.ts';
import { deferred } from './helpers/deferred.ts';
import { realCycleWorker } from './helpers/real-cycle-worker.ts';
import type { CycleEvent, CycleEventsResult, CycleChartResult } from '../shared/cycles-format.ts';
import type { TestCyclesOptions, TestReturnsOptions } from './fixtures/returns.ts';
import type { ReturnStorage } from '../src/data/return-storage.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCache, estimateBytes } from '../src/data/memory-cache.ts';
import { createCyclesClient } from './fixtures/returns.ts';
import { chartAtMinute } from '../src/domain/natal-day.ts';
import { natalDayFixture } from './fixtures/natal-day.ts';
import {mainReturnRange} from '../shared/chart-return-contract.ts';

const input = { birthUtc: '2000-01-01T00:00:00Z', body: 'saturn', fromAge: 28, toAge: 30 };
const event = { id: 'saturn:2028-07-21T12:36:05.920740Z', body: 'saturn', utc: '2028-07-21T12:36:05.920740Z', age: 28.5550697647, cycle: 1, pass: 1, cycleId: 'saturn:1', direction: 'direct' as const };
const events = () => ({ events: [{ ...event }], range: { fromAge: 28, toAge: 30 } });
const chartInput = { birthUtc: input.birthUtc, body: input.body, eventUtc: event.utc, timezone: 'UTC' };
function chartResult(selected = event): CycleChartResult {
  return { chart: { ...chartAtMinute(natalDayFixture({ date: '2028-07-21' }), 0), utc: selected.utc } as CycleChartResult['chart'] };
}

test('basic return RAM reuse touches persistent LRU without rewriting the payload',async()=>{
  const touches:string[]=[],writes:string[]=[];let calls=0;
  const storage={getEvents:async()=>null,getChart:async()=>null,
    putEvents(){writes.push('events');},putChart(){writes.push('chart');},
    touchEvents(){touches.push('events');},touchChart(){touches.push('chart');}};
  const client=createCyclesClient({returnStorage:storage,
    request:async url=>{calls++;return url.endsWith('/events')?events():chartResult();}});
  const dates=await client.events(input),chart=await client.chart(chartInput);
  await new Promise(setImmediate);assert.deepEqual(touches,[]);
  assert.equal(await client.events(input),dates);assert.equal(await client.chart(chartInput),chart);
  await new Promise(setImmediate);
  assert.deepEqual(touches,['events','chart']);assert.deepEqual(writes,['events','chart']);assert.equal(calls,2);
});

test('extra return charts use RAM without consulting or writing persistent storage',async()=>{
  let accesses=0,calls=0;
  const storage={getChart(){accesses++;return null;},putChart(){accesses++;},touchChart(){accesses++;}};
  const client=createCyclesClient({returnStorage:storage,
    request:async()=>{calls++;return chartResult();}});
  const query={...chartInput,body:'moon'},ready=await client.chart(query);
  assert.equal(await client.chart(query),ready);await new Promise(setImmediate);
  assert.equal(accesses,0);assert.equal(calls,1);
});

test('non-primary dates of an owned natal use its durable server list while full events stay in RAM',async()=>{
  const body='moon',owner={chartId:'1234567890',expectedAccountId:'1'};
  const range=mainReturnRange(input.birthUtc)!;
  const selected={...event,body,id:`${body}:${event.utc}`,cycleId:`${body}:1`};
  const requests:string[]=[];let deviceAccess=0;
  const client=createCyclesClient({returnStorage:{async getEvents(){deviceAccess++;return null;},async getChart(){deviceAccess++;return null;},
    async putEvents(){deviceAccess++;return false;},async putChart(){deviceAccess++;return false;}},
    request:async(url,options)=>{
      requests.push(url!);
      const sent=JSON.parse(options!.body as string);
      if(url!.endsWith('/events')){assert.equal(sent.expectedAccountId,owner.expectedAccountId);return {range,events:[selected]};}
      assert.equal(sent.expectedAccountId,undefined);return chartResult(selected);
    }});
  const dates=await client.events({...input,body,...range},undefined,{owner});
  const chart=await client.chart({...chartInput,body},undefined,{owner});
  assert.equal(await client.events({...input,body,...range},undefined,{owner}),dates);
  assert.equal(await client.chart({...chartInput,body},undefined,{owner}),chart);
  await new Promise(setImmediate);
  assert.deepEqual(requests,[`/api/charts/${owner.chartId}/returns/events`,'/api/cycles/chart']);
  assert.equal(deviceAccess,0);
});

test('personal inputs travel in POST JSON only; exact chart RAM is bounded and isolated by natal', async () => {
  const calls: { url?: string; options?: RequestInit }[] = [];
  const client = createCyclesClient({ memory: createMemoryCache({ maxBytes: estimateBytes(chartResult()) }), request: async (url, options) => { calls.push({ url, options }); return chartResult(); } });
  const result = await client.chart(chartInput);
  assert.equal(await client.chart(chartInput), result); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/cycles/chart'); assert.equal(calls[0].options!.method, 'POST');
  assert.equal(calls[0].options!.cache, 'no-store');
  assert.deepEqual(JSON.parse(calls[0].options!.body as string), chartInput); assert.equal((calls[0].options!.headers as Record<string, string>)['Content-Type'], 'application/json');
  await client.chart({ ...chartInput, birthUtc: '1999-01-01T00:00:00Z' });
  await client.chart(chartInput); assert.equal(calls.length, 3);
  const replacement = createCyclesClient({ request: async () => { calls.push({}); return chartResult(); } });
  await replacement.chart(chartInput); assert.equal(calls.length, 4);
});

test('cancelled request never enters cache even when transport ignores its signal', async () => {
  const hold = deferred(), cancel = new AbortController(); let calls = 0;
  const client = createCyclesClient({ returnStorage:null,request: async () => ++calls === 1 ? hold.promise : events() });
  const old = client.events(input, cancel.signal); cancel.abort(); hold.resolve!(events());
  await assert.rejects(old, error => (error as Error).name === 'AbortError');
  await client.events(input); assert.equal(calls, 2);
});

test('an already cancelled signal stops both cached and uncached requests without calling transport', async () => {
  let calls = 0; const cancel = new AbortController();
  const client = createCyclesClient({ request: async () => { calls++; return events(); } });
  await client.events(input); cancel.abort();
  await assert.rejects(client.events(input, cancel.signal), error => (error as Error).name === 'AbortError');
  await assert.rejects(client.events({ ...input, toAge: 31 }, cancel.signal), error => (error as Error).name === 'AbortError');
  assert.equal(calls, 1);
});

test('timeout is readable and retryable while caller cancellation stays AbortError', async () => {
  let calls = 0;
  const client = createCyclesClient({ timeoutMs: 2, request: async (url, { signal }) => {
    if (++calls > 1) return events();
    return new Promise((resolve, reject) => signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } });
  await assert.rejects(client.events(input), /не успел завершиться/);
  await client.events(input); assert.equal(calls, 2);
});

test('a timeout while reading JSON keeps the cycle timeout message and can retry', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, { signal }: RequestInit) => {
    if (++calls > 1) return Response.json(events());
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        signal!.addEventListener('abort', () => controller.error(signal!.reason), { once: true });
      },
    }));
  });
  const client = createCyclesClient({ timeoutMs: 2 });
  await assert.rejects(client.events(input), /не успел завершиться/);
  assert.deepEqual(await client.events(input), events());
  assert.equal(calls, 2);
});

test('server errors keep their code and are never cached', async () => {
  let calls = 0;
  const client = createCyclesClient({ request: async () => { if (++calls === 1) throw Object.assign(new Error('Busy'), { code: 'cycles_busy' }); return events(); } });
  await assert.rejects(client.events(input), error => (error as Error & { code?: string }).code === 'cycles_busy');
  await client.events(input); assert.equal(calls, 2);
});

test('events reject the wrong body, invalid date, wrong range and impossible birth ownership', async () => {
  for (const data of [null, {}, { events: null }, { ...events(), events: [null] },
    { ...events(), events: [{ ...event, body: 'moon' }] }, { ...events(), events: [{ ...event, utc: 'not a date' }] },
    { ...events(), range: { fromAge: 0, toAge: 100 } },
    { ...events(), events: [{ ...event, utc: '2028-02-30T12:00:00Z' }] },
    { ...events(), events: [{ ...event, utc: '1999-07-21T12:36:05Z' }] }] as const) {
    const client = createCyclesClient({ request: async () => data });
    await assert.rejects(client.events(input));
  }
});

test('chart must match the exact requested UTC and timezone and contain complete activations', async () => {
  const wrongDate = { ...event, utc: '2029-04-01T23:24:11.690590Z' };
  for (const data of [null, {}, chartResult(wrongDate),
    { ...chartResult(), chart: { ...chartResult().chart, utc: '2028-07-21T12:36:00Z' } },
    { ...chartResult(), chart: { ...chartResult().chart, activations: { personality: [], design: [] } } },
    chartResult({ ...event, utc: 'not a date' })] as const) {
    const client = createCyclesClient({ request: async () => data });
    await assert.rejects(client.chart(chartInput));
  }
  const valid = createCyclesClient({ request: async () => chartResult() });
  const result = await valid.chart(chartInput); assert.equal(result.chart.utc, event.utc);
});

test('real exact worker responses cross client validation without rounding away event seconds', async t => {
  const real = await realCycleWorker(t);
  const client = createCyclesClient({ request: (url, { body }) => real.generate({ ...JSON.parse(body as string), action: url.endsWith('/chart') ? 'chart' : 'events' }) });
  const result = await client.events(input); assert.equal(result.events.length, 3);
  const chosen = result.events[0]; const response = await client.chart({ ...chartInput, eventUtc: chosen.utc });
  assert.equal(response.chart.utc, chosen.utc);
});

test('cache identity follows calculation inputs, not property order or an events display timezone', async () => {
  const calls = [];
  const client = createCyclesClient({ returnStorage: deviceCache(), request: async (url, options) => { calls.push({ url, options }); return events(); } });
  const first = await client.events({ ...input, timezone: 'UTC' });
  assert.equal(await client.events({ toAge: 30, body: 'saturn', timezone: 'Europe/Moscow', fromAge: 28, birthUtc: input.birthUtc }), first);
  assert.equal(calls.length, 1, 'event times depend on birth, body and age range, not display timezone');
  let defaultCalls = 0;
  const defaults = createCyclesClient({ returnStorage: deviceCache(), request: async () => { defaultCalls++; return { events: [], range: { fromAge: 0, toAge: 100 } }; } });
  await defaults.events({ birthUtc: input.birthUtc, body: input.body });
  await defaults.events({ body: input.body, fromAge: 0, toAge: 100, birthUtc: input.birthUtc });
  assert.equal(defaultCalls, 1);
});

const revision = 'a'.repeat(64);
const tick = () => new Promise(setImmediate);
function deviceCache() {
  const records = new Map<string, unknown>();
  return { records, async getEvents(key: string) { return records.get(key); }, async putEvents(key: string, _input: CycleInput, value: CycleEventsResult) { records.set(key, value); }, async removeEvents(key: string) { records.delete(key); },
    async getChart(key: string) { return records.get(key); }, async putChart(key: string, value: unknown) { records.set(key, value); }, async removeChart(key: string) { records.delete(key); } };
}

test('reload reads both dates and opened exact charts from device storage', async () => {
  const returnStorage = deviceCache(), calls: { url: string; options: RequestInit }[] = [];
  const request = async (url: string, options: RequestInit) => { calls.push({ url, options }); return url.endsWith('/chart') ? chartResult() : events(); };
  const first = createCyclesClient({ returnStorage, request });
  await first.events(input); await first.chart(chartInput); await tick();
  const reload = createCyclesClient({ returnStorage, request });
  assert.deepEqual(await reload.events({ ...input, timezone: 'Europe/Moscow' }), events());
  assert.deepEqual(await reload.chart(chartInput), chartResult());
  assert.equal(calls.length, 2); assert.equal(returnStorage.records.size, 2);
  assert.ok(calls.every(({ options }) => (options.headers as Record<string, string>)['X-Forma-Cycles-Version'] === undefined));
  const changed = createCyclesClient({ returnStorage, request });
  await changed.events(input); await changed.chart(chartInput); assert.equal(calls.length, 2, 'replacing a client reuses the same prepared numbers');
});

test('corrupt or mismatched device results are removed and recalculated; storage failure never blocks a result', async () => {
  for (const bytes of [{}, { events: [] }, { ...events(), range: { fromAge: 0, toAge: 100 } }] as const) {
    let requests = 0, removed = 0;
    const client = createCyclesClient({ returnStorage: {
      getEvents: async () => bytes, removeEvents: async () => { removed++; }, putEvents: async () => { throw Error('full'); },
    }, request: async () => { requests++; return events(); } });
    assert.deepEqual(await client.events(input), events()); await tick();
    assert.equal(requests, 1); assert.equal(removed, 1);
  }
  const client = createCyclesClient({ returnStorage: { getEvents() { throw Error('denied'); }, putEvents() { return new Promise(() => {}); } }, request: async () => events() });
  assert.deepEqual(await client.events(input), events(), 'an unfinished write does not delay the chart');
});

test('cancellation while reading device data never publishes it, fetches or remembers it', async () => {
  const held = deferred(), cancel = new AbortController(); let reads = 0, requests = 0;
  const client = createCyclesClient({ returnStorage: { getEvents: () => { reads++; return held.promise; } },
    request: async () => { requests++; return events(); } });
  const pending = client.events(input, cancel.signal); cancel.abort(); held.resolve!(events());
  await assert.rejects(pending, error => (error as Error).name === 'AbortError');
  await client.events(input);
  assert.equal(reads, 2, 'an aborted read did not enter the in-memory cache'); assert.equal(requests, 0);
});

test('failed transport never enters device persistence', async () => {
  const returnStorage=deviceCache(),client=createCyclesClient({returnStorage,
    request:async()=>{throw Object.assign(new Error('Unavailable'),{code:'server_unavailable'});}});
  await assert.rejects(client.events(input),{code:'server_unavailable'});
  assert.equal(returnStorage.records.size,0);
});

test('a chart already owned by shared application memory bypasses device reads and transport', async () => {
  const ready = chartResult(), keys: PropertyKey[] = [];
  const client = createCyclesClient({ memory: { get<T = unknown>(key: PropertyKey) { keys.push(key); return ready as T; }, put() { assert.fail('a ready shared result must not be replaced'); } } as unknown as import('../src/data/memory-cache.ts').MemoryCache,
    returnStorage: { getChart() { assert.fail('ready memory precedes device'); } },
    request() { assert.fail('ready memory precedes transport'); },
  });
  assert.equal(await client.chart(chartInput), ready);
  assert.ok(keys.length && keys.every(key => (key as string).startsWith('return-chart:')));
});

test('persistent chart identity separates birth, body, exact UTC and display timezone', async () => {
  const returnStorage = deviceCache(), calls: CycleInput[] = [];
  const request = async (_url: string, options: RequestInit) => { const input = JSON.parse(options.body as string); calls.push(input); return { chart: { ...chartResult().chart, utc: input.eventUtc, timezone: input.timezone } }; };
  const options: TestCyclesOptions = { returnStorage, request };
  for (const input of [chartInput, { ...chartInput, birthUtc: '1999-01-01T00:00:00Z' }, { ...chartInput, body: 'chiron' },
    { ...chartInput, eventUtc: event.utc.replace('740Z', '741Z') }, { ...chartInput, timezone: 'Europe/Moscow' }] as const) {
    await createCyclesClient(options).chart(input);
    await createCyclesClient(options).chart(input);
  }
  assert.equal(calls.length, 5);
  await createCyclesClient({ ...options }).chart(chartInput);
  assert.equal(calls.length, 5); assert.equal(returnStorage.records.size, 5);
});

test('a chart obtained from persistent storage participates in the common memory byte budget', async () => {
  const returnStorage = deviceCache(), value = chartResult(), memory = createMemoryCache({ maxBytes: estimateBytes(value) });
  let requests = 0, reads = 0;
  const read = returnStorage.getChart; returnStorage.getChart = key => { reads++; return read(key); };
  const options: TestCyclesOptions = { returnStorage, memory, request: async () => { requests++; return value; } };
  const client = createCyclesClient(options); await client.chart(chartInput); await tick();
  memory.put('other-feature:data', new ArrayBuffer(estimateBytes(value)));
  assert.equal(memory.size, 1); const restored = await client.chart(chartInput);
  assert.equal(restored, value); assert.equal(requests, 1); assert.equal(reads, 2);
  assert.ok(memory.bytes <= estimateBytes(value));
});

for (const stale of [false, true] as const) test(`a full chart device ${stale ? 'miss' : 'hit'} during an older request preserves cache-before-network ordering`, async () => {
  const network = deferred(), disk = deferred(); let reads = 0, requests = 0;
  const value = chartResult(), client = createCyclesClient({ returnStorage: {
    getChart: () => ++reads === 1 ? Promise.resolve(null) : disk.promise, putChart: async () => {},
  }, request: async () => { requests++; return network.promise; } });
  const first = client.chart(chartInput); await tick(); const second = client.chart(chartInput); await tick();
  if (stale) { network.resolve!(value); await first; disk.resolve!(null); assert.equal(await second, value); }
  else { disk.resolve!(value); assert.equal(await second, value); network.resolve!(value); await first; }
  assert.equal(requests, 1);
});

test('corrupt persistent full charts cannot enter shared RAM and are replaced by a valid response', async () => {
  let removed = 0, requests = 0;
  const value = chartResult(), client = createCyclesClient({ returnStorage: {
    getChart: async () => ({ chart: { ...value.chart, utc: '2030-01-01T00:00:00Z' } }),
    removeChart: async () => { removed++; }, putChart: async () => {},
  }, request: async () => { requests++; return value; } });
  assert.equal(await client.chart(chartInput), value); await tick();
  assert.equal(await client.chart(chartInput), value); assert.equal(requests, 1); assert.equal(removed, 1);
});


test('retained return charts share the tab budget and release their exact cache identity', async () => {
  const memory = createMemoryCache({ maxBytes: 1 }), data = chartResult();
  let calls = 0;
  const client = createCyclesClient({ memory, request: async () => { calls++; return data; } });
  const release = client.retainChart({ ...chartInput, timezone: undefined }, data);
  memory.put('another-tool', new ArrayBuffer(16));
  assert.equal(await client.chart(chartInput), data);
  assert.equal(calls, 0);
  assert.ok(memory.bytes > 1, 'active data remains accounted even beyond the reuse budget');
  release(); release();
  assert.equal(memory.size, 0);
  await client.chart(chartInput); assert.equal(calls, 1);
});


test('owned major returns use the authenticated chart route without changing the numerical request', async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const client = createCyclesClient({ returnStorage: null,
    request: async (url, options) => { calls.push({url, options}); return url.endsWith('/events') ? events() : chartResult(); } });
  const owner = {chartId: '123', expectedAccountId: '7'};
  await client.events(input, undefined, {owner});
  await client.chart(chartInput, undefined, {owner, event});
  assert.deepEqual(calls.map(call => call.url), ['/api/charts/123/returns/events', '/api/charts/123/returns/chart']);
  assert.deepEqual(JSON.parse(calls[0].options.body as string), {...input, timezone:'UTC', expectedAccountId: '7'});
  assert.deepEqual(JSON.parse(calls[1].options.body as string), {...chartInput, expectedAccountId: '7'});
  assert.equal((calls[0].options.headers as Record<string, string>)['X-Forma-Cycles-Version'], undefined);
});

test('extra bodies keep the general calculation route even for an owned natal', async () => {
  const calls: string[] = [];
  const client = createCyclesClient({request: async url => { calls.push(url); return chartResult(); }});
  await client.chart({...chartInput, body: 'moon'}, undefined, {owner: {chartId: '123', expectedAccountId: '7'}});
  assert.deepEqual(calls, ['/api/cycles/chart']);
});

test('pending equal returns of distinct owned cards cannot share a persistence request', async () => {
  const hold = deferred(), urls: string[] = [];
  const client = createCyclesClient({returnStorage: null, request: async url => { urls.push(url); return hold.promise; }});
  const a = client.events(input, undefined, {owner: {chartId: '123', expectedAccountId: '7'}});
  const b = client.events(input, undefined, {owner: {chartId: '456', expectedAccountId: '7'}});
  await new Promise(setImmediate);
  hold.resolve!(events());
  await Promise.all([a,b]);
  assert.deepEqual(urls.sort(), ['/api/charts/123/returns/events', '/api/charts/456/returns/events']);
});


test('ready signed return is visible while its separate owned attachment waits', async () => {
  const hold=deferred(), calls:{url:string;body:Record<string,unknown>}[]=[];
  const ready={...events(),proof:'v1.'+'a'.repeat(64)+'.'+'b'.repeat(43)};
  const client=createCyclesClient({returnStorage:null,request:async(url,options)=>{
    calls.push({url,body:JSON.parse(String(options.body))});return url.endsWith('/accept')?hold.promise:ready;
  }});
  await client.events(input);
  const first=await client.events(input,undefined,{owner:{chartId:'123',expectedAccountId:'7'}});
  const second=await client.events(input,undefined,{owner:{chartId:'456',expectedAccountId:'7'}});
  await client.events(input,undefined,{owner:{chartId:'123',expectedAccountId:'7'}});
  await new Promise(setImmediate);
  assert.equal(first,ready);assert.equal(second,ready);
  assert.deepEqual(calls.map(call=>call.url),['/api/cycles/events','/api/charts/123/returns/accept','/api/charts/456/returns/accept']);
  assert.equal(calls[1].body.proof,ready.proof);assert.equal(calls[1].body.expectedAccountId,'7');
  hold.resolve!({accepted:true});
});

test('failed attachment neither hides ready numbers nor starts an automatic retry', async () => {
  let accepts=0;
  const ready={...events(),proof:'v1.'+'a'.repeat(64)+'.'+'b'.repeat(43)};
  const client=createCyclesClient({returnStorage:null,request:async(url)=>{
    if(url.endsWith('/accept')){accepts++;throw Object.assign(new Error('offline'),{code:'offline'});}return ready;
  }});
  await client.events(input);
  assert.equal(await client.events(input,undefined,{owner:{chartId:'123',expectedAccountId:'7'}}),ready);
  await new Promise(setImmediate);await new Promise(setImmediate);
  assert.equal(accepts,1);
});

test('adopting a prepared natal attaches only cached signed dates and opened exact returns', async () => {
  const calls:string[]=[],proof='v1.'+'a'.repeat(64)+'.'+'b'.repeat(43);
  const client=createCyclesClient({returnStorage:null,request:async url=>{
    calls.push(url);return url.endsWith('/accept')?{accepted:true}:url.endsWith('/events')?{...events(),proof}:{...chartResult(),proof};
  }});
  await client.events(input);await client.chart(chartInput,undefined,{event});
  await client.syncPrepared(input,{chartId:'123',expectedAccountId:'7'});
  await new Promise(setImmediate);await new Promise(setImmediate);
  assert.deepEqual(calls,['/api/cycles/events','/api/cycles/chart','/api/charts/123/returns/accept','/api/charts/123/returns/accept']);
});


test('closing the calculation client aborts pending attachments and forbids new work', async () => {
  const ready={...events(),proof:'v1.'+'a'.repeat(64)+'.'+'b'.repeat(43)};
  let attachmentSignal:AbortSignal|undefined,accepts=0;
  const client=createCyclesClient({returnStorage:null,request:async(url,{signal})=>{
    if(!url.endsWith('/accept'))return ready;
    accepts++;attachmentSignal=signal!;
    return new Promise((_,reject)=>signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
  }});
  await client.events(input);
  await client.events(input,undefined,{owner:{chartId:'123',expectedAccountId:'7'}});
  await new Promise(setImmediate);
  assert.ok(attachmentSignal);assert.equal(attachmentSignal.aborted,false);
  client.close();assert.equal(attachmentSignal.aborted,true);
  await assert.rejects(client.syncPrepared(input,{chartId:'456',expectedAccountId:'8'}),{name:'AbortError'});
  await assert.rejects(client.events(input),{name:'AbortError'});
  await new Promise(setImmediate);assert.equal(accepts,1);
});

test('adopting a long return list enumerates opened charts and coalesces only the pending adoption',async()=>{
 const proof='v1.'+'a'.repeat(64)+'.'+'b'.repeat(43),birthUtc=input.birthUtc,query={birthUtc,body:'saturn',fromAge:0,toAge:100};
 const dates=Array.from({length:1336},(_,i)=>{const utc=new Date(Date.parse(birthUtc)+(i+1)*27*86400000).toISOString();return {...event,id:`saturn:${utc}`,utc,age:((i+1)*27)/365.2425};});
 const opened=dates[50],hold=deferred();let chartReads=0,enumerations=0,accepts=0;
 const client=createCyclesClient({returnStorage:{getEvents:async()=>null,getChart:async()=>{chartReads++;return null;},putEvents:async()=>true,putChart:async()=>true,chartKeys:async()=>{enumerations++;return [];}},
  request:async url=>{if(url.endsWith('/accept')){accepts++;return hold.promise;}return url.endsWith('/events')?{events:dates,range:{fromAge:0,toAge:100},proof}:{...chartResult(opened),proof};}});
 await client.events(query);await client.chart({...chartInput,eventUtc:opened.utc},undefined,{event:opened});chartReads=0;
 const owner={chartId:'123',expectedAccountId:'7'};
 const a=client.syncPrepared(query,owner),b=client.syncPrepared(query,owner);await new Promise(setImmediate);
 assert.equal(chartReads,0,'1336 dates must not trigger 1336 device probes');assert.equal(enumerations,1);assert.equal(accepts,2,'dates and one opened chart attach once each');
 hold.resolve!({accepted:true});await Promise.all([a,b]);
 await client.syncPrepared(query,owner);assert.equal(enumerations,2,'a settled adoption leaves no forever memo');
});

test('prepared chart enumeration includes only matching key shape, natal, body and timezone from current RAM and device keys',async()=>{
 const revision='a'.repeat(64),key=(values:unknown[])=>JSON.stringify(['chart',...values]);
 const keyValues=[input.birthUtc,input.body,event.utc,'UTC'];
 const saved=[key(keyValues),key([input.birthUtc,'venus',event.utc,'UTC']),key([input.birthUtc,input.body,event.utc,'Europe/Moscow']),key(['1999-01-01T00:00:00Z',input.body,event.utc,'UTC']),JSON.stringify(['chart','b'.repeat(64),...keyValues]),'broken'];
 const client=createCyclesClient({returnStorage:{chartKeys:async()=>saved},request:async()=>assert.fail('enumeration never calculates')});
 assert.deepEqual(await client.preparedChartInputs({birthUtc:input.birthUtc,body:input.body,timezone:'UTC'}),[chartInput]);
});
