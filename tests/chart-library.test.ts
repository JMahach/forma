import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/storage/database.ts';
import { createAccountStorage } from '../server/storage/accounts.ts';
import { createChartRecords } from '../server/services/chart-records.ts';
import { createChartLibrary } from '../server/services/chart-library.ts';
import type { AccountChartContent, AccountChartBirth } from '../shared/chart-record-contract.ts';

const op=(n:number)=>n.toString(16).padStart(32,'0');
function fixture(t:{after(fn:()=>void):void}) {
  const database=openDatabase(':memory:');t.after(()=>database.close());
  const accountId=String(createAccountStorage(database).ensureAccount('person@example.test').id);
  let enabled=true,calls=0,onPrepare=()=>{};
  const records=createChartRecords({database,authorize:()=>enabled?{accountId}:null});
  const content:AccountChartContent={name:'Name',note:'private',source:'transit',birthDate:'2000-01-01',birthTime:'12:00',birthPlace:'',
    utc:'2000-01-01T12:00:32.789Z',personality:[],design:[],activations:{personality:[],design:[]},calculationVersion:'old'};
  const created=records.create({operationId:op(1),expectedAccountId:accountId,content});
  const library=createChartLibrary({calculationVersion:'current',prepareBirth:async input=>{
    calls++;onPrepare();const {name:_name,note:_note,...birth}=content;
    return {...birth,utc:(input as {utc:string}).utc,calculationVersion:'current'} as AccountChartBirth;
  }});
  return {records,library,created,accountId,content,options:{signal:new AbortController().signal},
    calls:()=>calls,expire(){enabled=false;},beforePrepare(fn:()=>void){onPrepare=fn;}};
}
test('opening a stored card refreshes old numbers once, keeps exact source UTC and never exposes the note publicly',async t=>{
  const f=fixture(t),id=f.created.chartId;
  const chart=await f.library.public(f.records,id,f.options);
  assert.equal(chart!.calculationVersion,'current');assert.equal(chart!.utc,f.content.utc);
  assert.equal('note' in chart!,false);assert.equal(f.calls(),1);
  assert.equal((await f.library.own(f.records,id,f.accountId,f.options))!.note,'private');
  assert.equal(f.calls(),1);
});
test('expiry during a private read prevents a late personal result, and deletion during refresh cannot resurrect it',async t=>{
  const f=fixture(t);
  f.beforePrepare(()=>f.expire());
  await assert.rejects(f.library.own(f.records,f.created.chartId,f.accountId,f.options),{code:'auth_required'});
  const g=fixture(t);g.beforePrepare(()=>g.records.remove({operationId:op(2),expectedAccountId:g.accountId,chartId:g.created.chartId}));
  assert.equal(await g.library.public(g.records,g.created.chartId,g.options),null);
});
test('listing never recalculates cards; stale data is marked until the selected card is opened',async t=>{
  const f=fixture(t),controller=new AbortController();controller.abort();
  await assert.rejects(f.library.public(f.records,f.created.chartId,{signal:controller.signal}));
  assert.equal(f.calls(),0);
  const page=await f.library.page(f.records,{expectedAccountId:f.accountId,limit:1},f.options);
  assert.equal(page.charts[0]!.calculationVersion,'old');assert.equal(page.charts[0]!.calculationCurrent,false);
  assert.equal(page.calculationVersion,'current');assert.equal(page.nextCursor,null);assert.equal(f.calls(),0);
  const opened=await f.library.own(f.records,f.created.chartId,f.accountId,f.options);
  assert.equal(opened!.calculationVersion,'current');assert.equal(f.calls(),1);
});

import { deferred } from './helpers/deferred.ts';
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function pendingFixture(t:test.TestContext) {
  const f=fixture(t);
  const jobs:{signal:AbortSignal;utc:string;task:ReturnType<typeof deferred<AccountChartBirth>>;finish():void}[]=[];
  const library=createChartLibrary({calculationVersion:'current',prepareBirth:async(input,{signal})=>{
    const task=deferred<AccountChartBirth>(),utc=(input as {utc:string}).utc;
    jobs.push({signal,utc,task,finish(){const {name:_name,note:_note,...birth}=f.content;
      task.resolve({...birth,utc,calculationVersion:'current'});}});
    return task.promise;
  }});
  return {...f,library,jobs};
}
test('one reader cancellation leaves the shared preparation and the other reader intact',async t=>{
  const f=pendingFixture(t),id=f.created.chartId,a=new AbortController(),b=new AbortController();
  const first=f.library.public(f.records,id,{signal:a.signal}),second=f.library.own(f.records,id,f.accountId,{signal:b.signal});
  await turn();assert.equal(f.jobs.length,1);
  const cancelled=assert.rejects(first,{name:'AbortError'});a.abort();await cancelled;
  assert.equal(f.jobs[0]!.signal.aborted,false);
  f.jobs[0]!.finish();assert.equal((await second)!.note,'private');
});
test('the last reader cancels preparation; a late abandoned result cannot write or remove its replacement job',async t=>{
  const f=pendingFixture(t),id=f.created.chartId,a=new AbortController(),b=new AbortController();
  const first=f.library.public(f.records,id,{signal:a.signal}),second=f.library.public(f.records,id,{signal:b.signal});
  await turn();let aborts=0;f.jobs[0]!.signal.addEventListener('abort',()=>aborts++);
  const cancelled=Promise.all([assert.rejects(first,{name:'AbortError'}),assert.rejects(second,{name:'AbortError'})]);
  a.abort();b.abort();await cancelled;assert.equal(aborts,1);assert.equal(f.jobs[0]!.signal.aborted,true);
  const retry=f.library.public(f.records,id,f.options);await turn();assert.equal(f.jobs.length,2);
  f.jobs[0]!.finish();await turn();assert.equal(f.records.getPublic(id)!.calculationVersion,'old');
  const extra=f.library.public(f.records,id,f.options);await turn();assert.equal(f.jobs.length,2);
  f.jobs[1]!.finish();assert.equal((await retry)!.calculationVersion,'current');assert.equal((await extra)!.calculationVersion,'current');
});
test('failure releases the job and completed results are not reused for another stale card',async t=>{
  const f=pendingFixture(t),id=f.created.chartId;
  const first=f.library.public(f.records,id,f.options),second=f.library.public(f.records,id,f.options);
  const failed=Promise.all([assert.rejects(first,/prepare failed/),assert.rejects(second,/prepare failed/)]);
  await turn();assert.equal(f.jobs.length,1);f.jobs[0]!.task.reject(Error('prepare failed'));await failed;
  const retry=f.library.public(f.records,id,f.options);await turn();assert.equal(f.jobs.length,2);f.jobs[1]!.finish();await retry;
  assert.equal((await f.library.public(f.records,id,f.options))!.calculationVersion,'current');assert.equal(f.jobs.length,2);
  const another=f.records.create({operationId:op(2),expectedAccountId:f.accountId,content:{...f.content,name:'Another'}});
  const later=f.library.public(f.records,another.chartId,f.options);await turn();assert.equal(f.jobs.length,3,'there is no completed result cache');
  f.jobs[2]!.finish();await later;
});
test('identical birth input across cards shares only calculation; different exact UTC does not join',async t=>{
  const f=pendingFixture(t);
  const same=f.records.create({operationId:op(2),expectedAccountId:f.accountId,content:{...f.content,name:'Second',note:'second note'}});
  const different=f.records.create({operationId:op(3),expectedAccountId:f.accountId,content:{...f.content,name:'Third',utc:'2000-01-01T12:00:33.789Z'}});
  const requests=[f.created.chartId,same.chartId,different.chartId].map(id=>f.library.own(f.records,id,f.accountId,f.options));
  await turn();assert.equal(f.jobs.length,2);assert.notEqual(f.jobs[0]!.utc,f.jobs[1]!.utc);
  f.jobs.forEach(job=>job.finish());const results=await Promise.all(requests);
  assert.equal(results[0]!.name,'Name');assert.equal(results[1]!.name,'Second');assert.equal(results[1]!.note,'second note');
  assert.equal(results[2]!.utc,'2000-01-01T12:00:33.789Z');
});
test('private access is rechecked separately after a shared preparation; public reader gets no note',async t=>{
  const f=pendingFixture(t),id=f.created.chartId;
  const own=f.library.own(f.records,id,f.accountId,f.options),publicRead=f.library.public(f.records,id,f.options);
  const rejected=assert.rejects(own,{code:'auth_required'});await turn();assert.equal(f.jobs.length,1);
  f.expire();f.jobs[0]!.finish();await rejected;assert.equal('note' in (await publicRead)!,false);
});
test('conditional refresh preserves name/note edits and cannot overwrite newer birth data or resurrect deletion',async t=>{
  const f=pendingFixture(t),id=f.created.chartId;
  const own=f.library.own(f.records,id,f.accountId,f.options);await turn();
  f.records.update({operationId:op(2),expectedAccountId:f.accountId,chartId:id,name:'Renamed',note:{value:'Edited',seenRevision:1}});
  f.jobs[0]!.finish();const renamed=await own;assert.equal(renamed!.name,'Renamed');assert.equal(renamed!.note,'Edited');
  const g=pendingFixture(t),changed=g.library.public(g.records,g.created.chartId,g.options);await turn();
  const {name:_name,note:_note,...nextBirth}=g.content;
  g.records.update({operationId:op(2),expectedAccountId:g.accountId,chartId:g.created.chartId,birth:{...nextBirth,utc:'2000-01-01T12:01:00Z',calculationVersion:'current'}});
  g.jobs[0]!.finish();assert.equal((await changed)!.utc,'2000-01-01T12:01:00Z');
  const h=pendingFixture(t),deleted=h.library.public(h.records,h.created.chartId,h.options);await turn();
  h.records.remove({operationId:op(2),expectedAccountId:h.accountId,chartId:h.created.chartId});
  h.jobs[0]!.finish();assert.equal(await deleted,null);assert.equal(h.records.getPublic(h.created.chartId),null);
});
