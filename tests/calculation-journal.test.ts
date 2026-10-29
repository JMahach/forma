import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { runJsonWorker, type JsonWorkerOptions } from '../server/runtime/json-worker.ts';
import { createComputeQueue } from '../server/runtime/compute-queue.ts';

function worker() {
  let kills=0;
  const process=Object.assign(new EventEmitter(),{pid:1,stdout:new PassThrough(),stdin:new PassThrough(),kill:()=>{kills++;return true;}});
  return {process:process as unknown as ChildProcessWithoutNullStreams,kills:()=>kills};
}
function fixture(options:Partial<JsonWorkerOptions>={}) {
  const child=worker(), facts:string[]=[];
  const run=()=>runJsonWorker({root:'/unused',script:'calculator.py',input:{secret:'birth-data-must-never-enter-log'},
    timeoutMs:1000,maxOutput:100,unavailable:()=>Error('unavailable'),timeoutError:()=>Error('timeout'),
    spawnWorker:(()=>child.process) as unknown as typeof spawn,onFailure:reason=>{facts.push(reason);},...options});
  return {...child,facts,run};
}

test('one physical failure is reported at its source, without stderr/input/exception text or duplicate close facts',async()=>{
  const f=fixture(), pending=f.run(), failure=assert.rejects(pending,/unavailable/);
  f.process.stdin.emit('error',Error('PRIVATE INPUT'));
  f.process.stdout.emit('error',Error('PRIVATE OUTPUT'));
  f.process.emit('error',Error('PRIVATE EXCEPTION'));
  f.process.emit('close',1);await failure;
  assert.deepEqual(f.facts,['process']);assert.equal(f.kills(),1);
});

test('timeout keeps its first cause, while cancellation and normal domain validation stay silent',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const cancel=new AbortController(), timed=fixture({signal:cancel.signal,timeoutMs:10});
  const result=timed.run(), failure=assert.rejects(result,/timeout/);
  t.mock.timers.tick(10);cancel.abort();timed.process.emit('close',null);await failure;
  assert.deepEqual(timed.facts,['timeout']);
  const controller=new AbortController(), aborted=fixture({signal:controller.signal});
  const cancelled=assert.rejects(aborted.run(),{name:'AbortError'});
  controller.abort();aborted.process.stdin.emit('error',Error('broken pipe after cancellation'));
  aborted.process.emit('close',1);await cancelled;assert.deepEqual(aborted.facts,[]);
  const expected=Object.assign(Error('choose DST fold'),{code:'ambiguous_time'});
  const domain=fixture({validate(){throw expected;}}), rejected=assert.rejects(domain.run(),error=>error===expected);
  domain.process.stdout.emit('data','{}');domain.process.emit('close',0);await rejected;
  assert.deepEqual(domain.facts,[]);
});

test('queue busy and cancellation before admission do not produce a calculation failure',async()=>{
  const queue=createComputeQueue({concurrency:1,maxQueued:0});let release!:()=>void;
  const held=queue.run(()=>new Promise<void>(resolve=>{release=resolve;}));
  const f=fixture({computeQueue:queue});await assert.rejects(f.run(),{code:'busy'});
  const controller=new AbortController();controller.abort();
  await assert.rejects(fixture({signal:controller.signal,onFailure:reason=>{f.facts.push(reason);}}).run(),{name:'AbortError'});
  assert.deepEqual(f.facts,[]);release();await held;queue.close();
});

test('output overflow, invalid JSON and failed spawn each report exactly one controlled cause',async()=>{
  for(const [body,maxOutput] of [['not-json',100],['x'.repeat(101),100]] as const) {
    const f=fixture({maxOutput}), failure=assert.rejects(f.run(),/unavailable/);
    f.process.stdout.emit('data',body);f.process.emit('close',0);await failure;
    assert.deepEqual(f.facts,['invalid_result']);
  }
  const f=fixture({spawnWorker:()=>{throw Error('sensitive launch detail');}});
  await assert.rejects(f.run(),/unavailable/);assert.deepEqual(f.facts,['process']);
});

test('failed async diagnostics cannot replace a calculation failure or create an unhandled rejection',async()=>{
  const f=fixture({onFailure:async()=>{throw Error('journal down');}}), failure=assert.rejects(f.run(),/unavailable/);
  f.process.emit('close',1);await failure;await new Promise<void>(resolve=>setImmediate(resolve));
});

import { createCalculator } from '../server/services/calculate.ts';
import { createCycles } from '../server/services/cycles.ts';
import { generateNatalDay } from '../server/services/natal-days.ts';
import { generateTransitDay } from '../server/services/transit-days.ts';
import type { CalculationFailureFact } from '../server/services/calculation-failure.ts';

test('calculator reports a Python failure once, keeps normal clarification silent and never repeats transport failure',async()=>{
  const child=worker(), facts:CalculationFailureFact[]=[];
  const calculate=createCalculator({root:'/unused',spawnWorker:(()=>child.process) as unknown as typeof spawn,report:event=>facts.push(event)});
  try {
    let result=calculate({mode:'transit'});
    child.process.stdout.emit('data',JSON.stringify({error:'ambiguous_time',message:'PRIVATE DATE'}));child.process.emit('close',0);
    assert.equal((await result).error,'ambiguous_time');assert.equal(facts.length,0);
    result=calculate({mode:'transit'});
    child.process.stdout.emit('data',JSON.stringify({error:'calculation_failed',message:'PRIVATE DATE'}));child.process.emit('close',0);
    assert.equal((await result).error,'calculation_failed');
    assert.deepEqual(facts.map(({event,component,reason})=>({event,component,reason})),[
      {event:'calculation_failed',component:'calculator',reason:'invalid_result'}]);
    result=calculate({mode:'transit'});
    child.process.stdout.emit('data',JSON.stringify({error:'design_search_failed',message:'PRIVATE SEARCH DETAILS'}));child.process.emit('close',0);
    assert.equal((await result).error,'design_search_failed');
    result=calculate({mode:'transit'});child.process.emit('close',1);await result;
    assert.deepEqual(facts.map(f=>f.reason),['invalid_result','invalid_result','process']);
    assert.ok(facts.every(f=>Object.keys(f).sort().join(',')==='component,event,occurredAt,reason'));
  } finally {await calculate.close();}
});

test('one invalid cycle result shared by several consumers produces one fact',async()=>{
  const facts:CalculationFailureFact[]=[];
  const cycles=createCycles({generate:async()=>({private:'birth details'}),report:fact=>facts.push(fact)});
  const input={birthUtc:'2000-01-01T00:00:00Z',body:'sun',fromAge:0,toAge:10};
  await Promise.all([assert.rejects(cycles.events(input)),assert.rejects(cycles.events(input))]);
  assert.equal(facts.length,1);assert.equal(facts[0]!.component,'cycles');assert.equal(facts[0]!.reason,'invalid_result');
  await cycles.close();
});

test('day generators distinguish unusable results from normal calendar rejection',async()=>{
  const facts:CalculationFailureFact[]=[];
  for(const [kind,value,expected] of [
    ['natal',{error:'nonexistent_date',message:'PRIVATE DATE'},0],
    ['natal',{date:'wrong',timezone:'UTC'},1],
    ['transit',{date:'wrong'},2],
  ] as const) {
    const child=worker(), common={root:'/unused',date:'2000-01-01',spawnWorker:(()=>child.process) as unknown as typeof spawn,report:(f:CalculationFailureFact)=>facts.push(f)};
    const pending=kind==='natal'?generateNatalDay({...common,timezone:'UTC'}):generateTransitDay(common);
    const rejected=assert.rejects(pending);child.process.stdout.emit('data',JSON.stringify(value));child.process.emit('close',0);await rejected;
    assert.equal(facts.length,expected);
  }
  assert.deepEqual(facts.map(f=>f.component),['natal_day','transit_day']);
});

test('a failed spawn arriving after cancellation cannot turn cancellation into a logged process failure',async()=>{
  const controller=new AbortController(), f=fixture({signal:controller.signal});
  Object.defineProperty(f.process,'pid',{value:undefined});
  const cancelled=assert.rejects(f.run(),{name:'AbortError'});
  controller.abort();f.process.emit('error',Error('spawn failed after cancellation'));f.process.emit('close',1);
  await cancelled;assert.deepEqual(f.facts,[]);
});


import { createNatalDays } from '../server/services/natal-days.ts';
import { createTransitDays } from '../server/services/transit-days.ts';
import { natalDayFixture } from './fixtures/natal-day.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJournalRuntime } from '../server/journal/runtime.ts';

test('day packing owns one invalid-result fact; valid results, cache hits and input rejection remain silent', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-calculation-days-'));
  const facts: CalculationFailureFact[] = [];
  let invalid = true, generated = 0;
  const generateDay = async (date: string, timezone = 'UTC') => {
    generated++;
    const day = natalDayFixture({date, timezone});
    return {...day, columns: invalid ? [] : day.columns.map(column => Array.from(column))};
  };
  const natal = createNatalDays({generateDay, report: fact => facts.push(fact)});
  const transit = await createTransitDays({cacheDir: directory, calculationVersion: 'a'.repeat(64),
    now: () => new Date('2000-01-01T12:00:00Z'), generateDay: date => generateDay(date), report: fact => facts.push(fact)});
  t.after(async () => { await transit.close(); await fs.rm(directory, {recursive: true, force: true}); });
  for (const get of [() => natal.get('2000-01-01', 'UTC'), () => transit.get('2000-01-01')]) {
    await Promise.all([assert.rejects(get()), assert.rejects(get())]);
  }
  assert.deepEqual(facts.map(fact => fact.component), ['natal_day', 'transit_day']);
  assert.equal(generated, 2);
  invalid = false;
  const n = await natal.get('2000-01-01', 'UTC'), d = await transit.get('2000-01-01');
  assert.equal(await natal.get('2000-01-01', 'UTC'), n);
  assert.equal(await transit.get('2000-01-01'), d);
  await assert.rejects(natal.get('bad-date', 'UTC'));
  await assert.rejects(transit.get('bad-date'));
  await assert.rejects(transit.get('2000-01-02', {allowCalculate: false}));
  assert.equal(facts.length, 2); assert.equal(generated, 4);
});

for (const warm of [false, true]) test('shutdown preserves the last calculation fact, warm journal=' + warm, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-calculation-journal-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const journal = createJournalRuntime({directory, environment: 'stand'}), accepted: Promise<boolean>[] = [];
  const child = worker();
  const calculate = createCalculator({root: '/unused', spawnWorker: (() => child.process) as unknown as typeof spawn,
    report: fact => { const result = journal.report(fact); accepted.push(result); return result; }});
  try {
    if (warm) assert.equal(await journal.report({event: 'chart_cleanup_failed', occurredAt: Date.now()}), true);
    const result = calculate({mode: 'transit', name: 'PRIVATE'});
    child.process.stdout.emit('data', 'not-json'); child.process.emit('close', 0); await result;
  } finally { await calculate.close(); await journal.close(); }
  assert.deepEqual(await Promise.all(accepted), [true]);
  const files = (await fs.readdir(path.join(directory, 'archive'))).filter(file => file.endsWith('.jsonl'));
  const contents = (await Promise.all(files.map(file => fs.readFile(path.join(directory, 'archive', file), 'utf8')))).join('');
  const records = contents.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  const calculations = records.filter(record => record.event === 'calculation_failed');
  assert.equal(calculations.length, 1);
  const row = calculations[0]!;
  assert.equal(row.event, 'calculation_failed'); assert.equal(row.source, 'calculation');
  assert.equal(row.reason, 'invalid_result'); assert.equal(row.component, 'calculator');
  assert.equal(row.environment, 'stand'); assert.equal(row.level, 'error'); assert.equal(row.outcome, 'failed');
  assert.equal(contents.includes('PRIVATE'), false); assert.equal(contents.includes('not-json'), false);
});


import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { createRequestHandler } from '../server/http/app.ts';
import { createChartCalculation } from '../server/services/chart-calculation.ts';
import { createCityCatalog } from '../server/services/cities.ts';
import { createCalculationFailureReporter } from '../server/services/calculation-failure.ts';
import { accountChart } from './helpers/account-chart.ts';
import { captureResponse } from './helpers/http-response.ts';

test('legacy HTTP and account preparation share source validation without repeating the fact', async () => {
  const facts: CalculationFailureFact[] = [], cities = createCityCatalog([]);
  let child: ReturnType<typeof worker>;
  const calculate = createCalculator({root: '/unused', spawnWorker: (() => { child = worker(); return child!.process; }) as unknown as typeof spawn,
    report: fact => facts.push(fact)});
  const handler = createRequestHandler({root: '/unused', calculate, cities, publicFiles: async () => {throw Error('unused');}});
  async function respond(value: unknown) {
    const request = Object.assign(Readable.from([JSON.stringify({mode: 'transit'})]), {
      method: 'POST', url: '/api/calculate', headers: {host: 'localhost', 'content-type': 'application/json'},
    }) as IncomingMessage;
    const response = captureResponse();
    const pending = handler(request, response);
    await new Promise<void>(resolve => setImmediate(resolve));
    child!.process.stdout.emit('data', JSON.stringify(value)); child!.process.emit('close', 0);
    await pending;
    return response;
  }
  try {
    for (const value of [{}, null, {chart: {...accountChart(), activations: {personality: [], design: []}}}]) {
      const response = await respond(value);
      assert.equal(JSON.parse(response.body).error, 'calculation_failed');
    }
    assert.equal(facts.length, 3);
    const good = {chart: accountChart(), timeResolution: {ambiguous: false}};
    const response = await respond(good);
    assert.equal(response.status, 200); assert.deepEqual(JSON.parse(response.body), good); assert.equal(facts.length, 3);
    const report = createCalculationFailureReporter('calculator', fact => facts.push(fact));
    const prepare = createChartCalculation({cities, calculate, onInvalidResult: () => report('invalid_result')});
    const rejected = assert.rejects(prepare({source: 'transit', utc: '2000-01-01T12:00:00Z'}, {signal: new AbortController().signal}), {code: 'calculation_failed'});
    child!.process.stdout.emit('data', '{}'); child!.process.emit('close', 0); await rejected;
    assert.equal(facts.length, 4);
  } finally { await calculate.close(); }
});


import { fileURLToPath } from 'node:url';
import type { CalculationRequest } from '../shared/chart-types.ts';

test('real Python keeps current transit, natal, exact moment and Design unchanged and unreported', async () => {
  const facts: CalculationFailureFact[] = [];
  const calculate = createCalculator({root: fileURLToPath(new URL('../', import.meta.url)), report: fact => facts.push(fact)});
  const utc = '2000-01-01T12:00:00Z';
  const inputs: CalculationRequest[] = [
    {mode: 'transit'}, {mode: 'transit', utc},
    {mode: 'natal', name: 'Test', date: '2000-01-01', time: '12:00',
      city: {id: 'utc', name: 'UTC', timezone: 'UTC', country: '', region: '', latitude: 0, longitude: 0}},
    {mode: 'transit_moment', utc}, {mode: 'transit_design', utc},
  ];
  try {
    for (const input of inputs) assert.equal((await calculate(input)).error, undefined, input.mode);
    assert.equal(facts.length, 0);
  } finally {await calculate.close();}
});
