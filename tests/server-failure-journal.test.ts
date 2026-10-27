import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { createRequestHandler } from '../server/http/app.ts';
import { createCityCatalog } from '../server/services/cities.ts';
import { NATAL_DAY_VERSION } from '../shared/day-packets/natal-format.ts';
import { createChartHandler } from '../server/http/charts.ts';
import type { createChartRecords } from '../server/services/chart-records.ts';
import { LifetimeError } from '../server/services/lifetime.ts';
import { createAccountHandler } from '../server/http/accounts.ts';
import type { Accounts } from '../server/services/accounts.ts';
import { createServerReporter } from '../server/journal/report.ts';
import { completeJournalEvent } from '../server/journal/events.ts';
import type { JournalEvent } from '../server/journal/events.ts';
import { captureResponse } from './helpers/http-response.ts';

function fixture() {
  const rows: JournalEvent[] = [];
  const report = createServerReporter({environment:'stand', write: async event => {rows.push(event);return {status:'accepted'};}});
  const cities = createCityCatalog([{id:'utc',name:'UTC',aliases:[],timezone:'UTC',country:'',region:'',latitude:0,longitude:0}]);
  const failure = () => {throw Error('PRIVATE chart/email/token/address details');};
  const handler = createRequestHandler({root:'/unused',cities,calculate:failure,report,
    publicFiles:failure,lifetime:{getMetadata:failure,getMoment:failure},
    natalDays:{get:failure,calculationVersion:null},transitDays:{get:failure},cycles:{cacheVersion:null,events:failure,chart:failure}});
  async function request(url: string, body?: unknown, headers: Record<string,string> = {}) {
    const req=Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),{
      method:body === undefined?'GET':'POST',url,headers:{host:'localhost','content-type':'application/json',...headers},
    }) as IncomingMessage;
    const res=captureResponse();await handler(req,res);await Promise.resolve();return res;
  }
  return {rows,report,cities,failure,handler,request};
}

test('unexpected HTTP failures reach the unified journal with only a fixed component and reason',async()=>{
  const f=fixture();
  for(const [url,body,component] of [
    ['/known-asset',undefined,'public_files'],
    ['/api/calculate',{mode:'transit',name:'PRIVATE'},'calculator'],
    ['/api/lifetime/meta',undefined,'lifetime'],
    ['/api/chart/day',{v:NATAL_DAY_VERSION,birthDate:'2000-01-01',cityId:'utc'},'natal_day'],
    ['/api/transit/day?date='+new Date().toISOString().slice(0,10),undefined,'transit_day'],
    ['/api/cycles/events',{birthUtc:'2000-01-01T00:00:00Z',body:'sun',fromAge:0,toAge:10},'cycles'],
  ] as const) {
    const before=f.rows.length;
    await f.request(url,body);
    assert.equal(f.rows.length,before+1,component);
    assert.deepEqual({...f.rows.at(-1),eventId:undefined,occurredAt:undefined},{schemaVersion:1,environment:'stand',
      eventId:undefined,occurredAt:undefined,source:'runtime',event:'http_request_failed',level:'error',outcome:'failed',component,reason:'unexpected'});
  }
  assert.equal(JSON.stringify(f.rows).includes('PRIVATE'),false);
});

test('bad input, bad URL, forbidden origin and ordinary missing/preparing data do not become server faults',async()=>{
  const f=fixture();
  await f.request('http://[');await f.request('/%ZZ');
  await f.request('/api/calculate',{}, {origin:'https://elsewhere.test'});
  await f.request('/api/calculate',{mode:'natal'});
  await f.request('/api/transit/day?date=bad');
  await f.request('/api/cycles/events',{});
  const handler=createRequestHandler({root:'/unused',cities:f.cities,calculate:f.failure,report:f.report,
    lifetime:{getMetadata:async()=>{throw new LifetimeError('lifetime_preparing','Preparing');},getMoment:f.failure}});
  await handler({method:'GET',url:'/api/lifetime/meta',headers:{host:'localhost'}} as IncomingMessage,captureResponse());
  assert.deepEqual(f.rows,[]);
});

test('account response credential cleanup failure is recorded without discarding credentials or raw error',async()=>{
  const f=fixture();
  const accounts={current:()=>null,discardedCredentials:f.failure} as unknown as Accounts;
  const handle=createAccountHandler(accounts,{origins:['http://localhost'],report:f.report});
  const res=captureResponse();
  await handle({method:'GET',headers:{host:'localhost'}} as IncomingMessage,res,new URL('http://localhost/api/account'));
  assert.equal(res.status,503);assert.equal(res.headers['Set-Cookie'],undefined);
  assert.equal(f.rows.length,1);assert.equal(f.rows[0]!.event,'http_request_failed');
  assert.equal(f.rows[0]!.component,'account');assert.equal(JSON.stringify(f.rows).includes('PRIVATE'),false);
});

test('fault schema rejects unbounded fields and incorrect component/reason combinations',()=>{
  const defaults={environment:'stand' as const,occurredAt:1000,eventId:'event'};
  for(const fact of [
    {event:'http_request_failed',component:'account',reason:'unexpected'},
    {event:'prepared_data_failed',component:'lifetime',reason:'open'},
    {event:'prepared_data_failed',component:'lifetime',reason:'read'},
  ]) {
    assert.ok(completeJournalEvent(fact,defaults));
    for(const extra of [{url:'/private'},{request:{}},{ip:'127.0.0.1'},{error:Error('PRIVATE')},{accountId:'1'}]) {
      assert.equal(completeJournalEvent({...fact,...extra},defaults),null);
    }
    assert.equal(completeJournalEvent({...fact,component:'PRIVATE'},defaults),null);
    assert.equal(completeJournalEvent({...fact,reason:'PRIVATE'},defaults),null);
  }
  assert.equal(completeJournalEvent({event:'calculation_failed',component:'public_files',reason:'process'},defaults),null);
  assert.equal(completeJournalEvent({event:'prepared_data_failed',component:'account',reason:'read'},defaults),null);
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJournalRuntime } from '../server/journal/runtime.ts';
import { createTransitDays } from '../server/services/transit-days.ts';
import { natalDayFixture } from './fixtures/natal-day.ts';

test('HTTP source facts survive journal shutdown in the existing archive',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'forma-http-journal-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const journal=createJournalRuntime({directory,environment:'stand'}), f=fixture();
  const handler=createRequestHandler({root:'/unused',cities:f.cities,calculate:f.failure,report:journal.report,publicFiles:f.failure});
  try {await handler({method:'GET',url:'/asset?private=PRIVATE',headers:{host:'localhost'}} as IncomingMessage,captureResponse());}
  finally {await journal.close();}
  const files=(await fs.readdir(path.join(directory,'archive'))).filter(file=>file.endsWith('.jsonl'));
  const text=(await Promise.all(files.map(file=>fs.readFile(path.join(directory,'archive',file),'utf8')))).join('');
  const rows=text.trim().split('\n').map(line=>JSON.parse(line) as JournalEvent);
  assert.equal(rows.length,1);assert.equal(rows[0]!.event,'http_request_failed');
  assert.equal(text.includes('PRIVATE'),false);
});

test('one failed day packing is recorded at its calculation source, not again for every HTTP consumer',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'forma-http-day-journal-'));
  const f=fixture(), date='2000-01-01';
  const transit=await createTransitDays({cacheDir:directory,calculationVersion:'a'.repeat(64),report:f.report,
    now:()=>new Date(date+'T12:00:00Z'),generateDay:async()=>({...natalDayFixture({date,timezone:'UTC'}),columns:[]})});
  t.after(async()=>{await transit.close();await fs.rm(directory,{recursive:true,force:true});});
  const handler=createRequestHandler({root:'/unused',cities:f.cities,calculate:f.failure,report:f.report,
    transitDays:transit,now:()=>new Date(date+'T12:00:00Z')});
  const request=()=>handler({method:'GET',url:'/api/transit/day?date='+date,headers:{host:'localhost'}} as IncomingMessage,captureResponse());
  await Promise.all([request(),request()]);
  assert.equal(f.rows.length,1);assert.equal(f.rows[0]!.event,'calculation_failed');
});

test('disconnection is silent and a broken reporter cannot replace the HTTP response',async()=>{
  const f=fixture();
  await f.handler({method:'GET',url:'/asset',aborted:true,headers:{host:'localhost'}} as IncomingMessage,captureResponse());
  assert.deepEqual(f.rows,[]);
  for(const report of [()=>{throw Error('journal down');},async()=>{throw Error('journal down');}]) {
    const handler=createRequestHandler({root:'/unused',cities:f.cities,calculate:f.failure,report,publicFiles:f.failure});
    const res=captureResponse();
    await handler({method:'GET',url:'/asset',headers:{host:'localhost'}} as IncomingMessage,res);
    assert.equal(JSON.parse(res.body).error,'invalid_request');
  }
  await new Promise<void>(resolve=>setImmediate(resolve));
});


test('unexpected chart access failure reaches the journal before the public error',async()=>{
  const f=fixture();
  const records={withAuthorization:f.failure} as unknown as ReturnType<typeof createChartRecords>;
  const handle=createChartHandler({records,accounts:{current:()=>null},prepareBirth:f.failure,
    calculationVersion:'current',origins:['http://localhost'],report:f.report});
  const res=captureResponse();
  await handle({method:'GET',headers:{host:'localhost'}} as IncomingMessage,res,new URL('http://localhost/api/charts?accountId=1'));
  assert.equal(res.status,503);assert.equal(JSON.parse(res.body).error,'chart_unavailable');
  assert.equal(f.rows.length,1);assert.equal(f.rows[0]!.component,'charts');
  assert.equal(JSON.stringify(f.rows).includes('PRIVATE'),false);
});
