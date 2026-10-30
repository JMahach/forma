import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../server/storage/database.ts';
import {createAccountStorage} from '../server/storage/accounts.ts';
import {createChartRecords} from '../server/services/chart-records.ts';
import {accountNatalChart,chartId} from './helpers/account-chart.ts';
import {createLibraryPreparation} from '../server/services/library-preparation.ts';
import {createNatalDays} from '../server/services/natal-days.ts';
import {createChartReturns} from '../server/services/chart-returns.ts';
import {createCycles} from '../server/services/cycles.ts';
import {createReturnReceipts} from '../server/services/return-receipt.ts';
import {natalDayFixture} from './fixtures/natal-day.ts';
import {deferred} from './helpers/deferred.ts';
import {MAIN_RETURN_BODIES,mainReturnRange} from '../shared/chart-return-contract.ts';
import {RETURN_FAMILIES,returnSourceKey} from '../shared/library-package-contract.ts';
import {cycleAge,type CycleInput,type CycleResult} from '../shared/cycles-format.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createComputeQueue,type ComputeQueue} from '../server/runtime/compute-queue.ts';

const tick=()=>new Promise<void>(setImmediate);
const eventUtc='2029-01-01T12:00:00Z';
function result(input:CycleInput,action:'events'|'chart'):CycleResult {
  return action==='events'?{range:{fromAge:input.fromAge!,toAge:input.toAge!},events:[{
    id:`${input.body}:${eventUtc}`,body:input.body,utc:eventUtc,age:cycleAge(eventUtc,input.birthUtc),
    cycle:1,pass:1,cycleId:`${input.body}:1`,direction:'direct',
  }]}:{chart:{...accountNatalChart(),source:'calculated',utc:input.eventUtc!,timezone:input.timezone??'UTC',
    designUtc:'2028-10-10T01:00:00Z',designArcResidualDegrees:1e-9}};
}

function library(t:test.TestContext,filename=':memory:') {
  const database=openDatabase(filename);let closed=false;
  const close=()=>{if(!closed){closed=true;database.close();}};t.after(close);
  const accountId=String(createAccountStorage(database).ensureAccount('owner@example.test').id);
  let authenticated=true;
  const records=createChartRecords({database,authorize:()=>authenticated?{accountId}:null});
  let operation=1;
  const intent=()=>({operationId:chartId(operation++),expectedAccountId:accountId});
  const add=(name='A')=>records.create({...intent(),content:{...accountNatalChart(),name}}).chartId!;
  return {database,accountId,records,intent,add,close,logout(){authenticated=false;}};
}

test('preparation belongs to committed birth changes; metadata, repeats and rollback do not create work',t=>{
  const f=library(t),notices:unknown[]=[];
  f.records.subscribePreparation(notice=>notices.push(notice));
  const input={...f.intent(),content:accountNatalChart()},created=f.records.create(input);
  const task=f.records.preparation.next(0);assert.ok(task);assert.equal(task.chartId,created.chartId);
  assert.equal(notices.length,1);assert.equal(f.records.create(input).chartId,created.chartId);
  f.records.update({...f.intent(),chartId:task.chartId,name:'Renamed',note:{value:'Note',seenRevision:1}});
  assert.deepEqual(f.records.preparation.next(0),task);assert.equal(notices.length,1);
  f.database.connection.exec("CREATE TRIGGER refuse_outcome BEFORE INSERT ON chart_operation_outcomes BEGIN SELECT RAISE(ABORT,'rollback'); END;");
  assert.throws(()=>f.records.update({...f.intent(),chartId:task.chartId,birth:{...accountNatalChart(),birthDate:'2000-01-02',utc:'2000-01-02T12:00:00Z'}}),/rollback/);
  assert.deepEqual(f.records.preparation.next(0),task);assert.equal(notices.length,1,'a rolled-back write cannot start or cancel work');
  f.database.connection.exec('DROP TRIGGER refuse_outcome');
  f.records.update({...f.intent(),chartId:task.chartId,birth:{...accountNatalChart(),birthDate:'2000-01-02',utc:'2000-01-02T12:00:00Z'}});
  const changed=f.records.preparation.next(0);assert.ok(changed);assert.notEqual(changed.recordRevision,task.recordRevision);
  assert.equal(f.records.preparation.complete(task),false,'an old worker cannot remove its replacement');
  f.records.remove({...f.intent(),chartId:task.chartId});assert.equal(f.records.preparation.next(0),null);
});

function preparation(t:test.TestContext,f:ReturnType<typeof library>,before:(input:CycleInput,action:'events'|'chart')=>Promise<void>=async()=>{},computeQueue?:ComputeQueue) {
  const calls:string[]=[];
  const natalDays=createNatalDays({packages:f.records.packages,generateDay:async(date,timezone,options)=>{
    const generate=async()=>{calls.push('day');const day=natalDayFixture({date,timezone,samples:10});
      return {...day,columns:day.columns.map(column=>Array.from(column))};};
    return computeQueue?computeQueue.run(generate,options):generate();
  }});
  const cycles=createCycles({computeQueue,generate:async input=>{const {action}=input;calls.push(`${action}:${input.body}`);await before(input,action);return result(input,action);}});
  const receipts=createReturnReceipts({key:Buffer.alloc(32,1)}),returns=createChartReturns({cycles,receipts});
  let time=0;const failures:unknown[]=[];
  const worker=createLibraryPreparation({records:f.records,natalDays,returns,now:()=>time,onFailure:()=>failures.push('failure')});
  t.after(async()=>{await worker.close();await cycles.close();});
  return {worker,calls,natalDays,cycles,returns,receipts,failures,advance(){time+=60_000;}};
}

test('saving returns before preparation; a day is readable while dates are blocked; repeat wake writes nothing',async t=>{
  const f=library(t),entered=deferred(),release=deferred();
  const p=preparation(t,f,async()=>{entered.resolve();await release.promise;});
  const id=f.add();assert.deepEqual(p.calls,[]);
  await p.worker.wake();await tick();assert.deepEqual(p.calls,[],'a wake before listener startup cannot calculate');
  const work=p.worker.start();await entered.promise;
  assert.ok(f.records.packages.readDay({date:'2000-01-01',timezone:'UTC'}));
  assert.ok(f.records.getOwn(id),'the card is available before any return dates');
  release.resolve();await work;
  assert.deepEqual(p.calls,['day',...RETURN_FAMILIES.map(body=>`events:${body}`),...MAIN_RETURN_BODIES.map(body=>`chart:${body}`)]);
  assert.equal(f.records.preparation.nextDue(),null);
  const changes=f.database.connection.prepare('SELECT total_changes() AS n').get()!.n;
  await p.worker.wake();await p.worker.wake();
  assert.equal(f.database.connection.prepare('SELECT total_changes() AS n').get()!.n,changes);
  assert.equal(p.calls.length,19);assert.deepEqual(p.failures,[]);
});

test('a live request takes the shared compute slot before a pending library day',async t=>{
  const f=library(t),queue=createComputeQueue({concurrency:1}),release=deferred(),held=queue.run(()=>release.promise);
  const p=preparation(t,f,undefined,queue);f.add();const work=p.worker.start();await tick();await tick();
  const live=p.cycles.events({birthUtc:accountNatalChart().utc,body:'moon',...mainReturnRange(accountNatalChart().utc)});
  release.resolve();await held;await live;await work;
  assert.deepEqual(p.calls.slice(0,2),['events:moon','day']);assert.equal(f.records.preparation.nextDue(),null);
  queue.close();
});

test('failed work resumes only missing parts after owner replacement; a ready signed return is accepted first',async t=>{
  const f=library(t),id=f.add(),p=preparation(t,f,async input=>{if(input.body==='moon')throw Error('temporary');});
  await p.worker.start();assert.deepEqual(p.calls,['day','events:sun','events:moon']);
  const pending=f.records.preparation.next(60_000);assert.ok(pending);assert.equal(pending.attempts,1);
  assert.equal(f.records.preparation.next(0),null);await p.worker.wake();assert.equal(p.calls.length,3);await p.worker.close();
  const restarted=preparation(t,f);restarted.advance();
  const input={birthUtc:accountNatalChart().utc,timezone:'UTC',body:'saturn',eventUtc},value=result(input,'chart');
  await restarted.returns.accept(f.records,id,f.accountId,{action:'chart',input,result:value,proof:restarted.receipts.issue('chart',input,value)},
    {signal:new AbortController().signal});
  await restarted.worker.start();
  assert.equal(restarted.calls.includes('day'),false);assert.equal(restarted.calls.includes('events:sun'),false);
  assert.equal(restarted.calls.includes('chart:saturn'),false);assert.equal(restarted.calls.length,16);
  assert.equal(f.records.preparation.next(60_000),null);
});

test('a real database reopen continues pending parts once and never requeues a completed library',async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'forma-preparation-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'forma.sqlite'),f=library(t,filename),p=preparation(t,f,async input=>{if(input.body==='moon')throw Error('failure');});
  f.add();await p.worker.start();await p.worker.close();await p.natalDays.close();f.close();
  const reopened=library(t,filename),next=preparation(t,reopened);next.advance();await next.worker.start();
  assert.equal(next.calls.length,17);assert.equal(next.calls.includes('day'),false);assert.equal(next.calls.includes('events:sun'),false);
  await next.worker.close();await next.natalDays.close();reopened.close();
  const complete=library(t,filename),idle=preparation(t,complete);
  await idle.worker.start();assert.deepEqual(idle.calls,[]);assert.equal(complete.records.preparation.nextDue(),null);
});

test('browser logout and a disconnected live consumer leave accepted server preparation running',async t=>{
  const f=library(t),entered=deferred(),release=deferred(),p=preparation(t,f,async input=>{
    if(input.body==='sun'){entered.resolve();await release.promise;}
  });
  f.add();const work=p.worker.start();await entered.promise;
  const controller=new AbortController(),live=p.cycles.events({birthUtc:accountNatalChart().utc,body:'sun',...mainReturnRange(accountNatalChart().utc)},
    {signal:controller.signal});
  controller.abort();await assert.rejects(live,{name:'AbortError'});f.logout();
  release.resolve();await work;assert.equal(p.calls.length,19);assert.equal(f.records.preparation.nextDue(),null);
  assert.equal(p.calls.filter(call=>call==='events:sun').length,1);
});

test('birth replacement aborts the old destination, deletion aborts new work, and a stopped owner schedules nothing',async t=>{
  const f=library(t),entered=deferred(),release=deferred(),p=preparation(t,f,async()=>{entered.resolve();await release.promise;});
  const id=f.add(),work=p.worker.start();await entered.promise;
  f.records.update({...f.intent(),chartId:id,birth:{...accountNatalChart(),birthDate:'2000-01-02',utc:'2000-01-02T12:00:00Z'}});
  f.records.remove({...f.intent(),chartId:id});release.resolve();await work;
  assert.equal(f.database.connection.prepare('SELECT count(*) AS n FROM account_chart_returns').get()!.n,0);
  assert.equal(f.records.preparation.next(0),null);assert.deepEqual(p.failures,[]);
  await p.worker.close();f.add('Later');await tick();await p.worker.wake();
  assert.equal(p.calls.length,2);assert.ok(f.records.preparation.next(0));
});

test('later saved cards with the same numerical source reuse ready parts without another calculation',async t=>{
  const f=library(t),p=preparation(t,f);f.add();await p.worker.start();
  const first=[...p.calls];const second=f.add('Second');await p.worker.wake();
  assert.deepEqual(p.calls,first);
  const chart=f.records.getOwn(second)!;
  for(const body of MAIN_RETURN_BODIES)assert.ok(p.returns.readPackage(f.records,second,f.accountId,
    {kind:'major-returns',family:body,sourceKey:returnSourceKey({birthUtc:chart.utc,timezone:chart.timezone!})},{signal:new AbortController().signal}));
});

test('background cancellation waits for its physical worker before another destination starts',async t=>{
  const f=library(t),entered=deferred(),release=deferred(),p=preparation(t,f,async()=>{entered.resolve();await release.promise;});
  const id=f.add();const work=p.worker.start();await entered.promise;
  f.records.remove({...f.intent(),chartId:id});
  f.records.create({...f.intent(),content:{...accountNatalChart(),birthDate:'2000-01-02',utc:'2000-01-02T12:00:00Z'}});
  try {await tick();await tick();assert.deepEqual(p.calls,['day','events:sun']);}
  finally {release.resolve();await work;}
  assert.equal(f.records.preparation.nextDue(),null);
});

test('a failure backs off without blocking another card; the single retry resumes only its missing parts',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=library(t);let failing=true;
  const p=preparation(t,f,async input=>{if(failing && input.birthUtc===accountNatalChart().utc && input.body==='moon')throw Error('temporary');});
  const first=f.add();f.records.create({...f.intent(),content:{...accountNatalChart(),birthDate:'2000-01-02',utc:'2000-01-02T12:00:00Z'}});
  await p.worker.start();assert.equal(f.records.preparation.next(60_000)?.chartId,first);
  assert.equal(p.failures.length,1);const calls=p.calls.length;
  t.mock.timers.tick(59_999);await tick();assert.equal(p.calls.length,calls);
  p.advance();failing=false;t.mock.timers.tick(1);await tick();await tick();
  assert.ok(p.calls.length>calls,'the retry timer wakes the worker without another foreground request');
  await p.worker.wake();
  assert.equal(f.records.preparation.nextDue(),null);assert.equal(p.calls.length,calls+17);
});

test('a committed save wakes an already idle owner without an explicit caller wake',{timeout:1000},async t=>{
  const f=library(t),entered=deferred(),release=deferred(),p=preparation(t,f,async()=>{entered.resolve();await release.promise;});
  await p.worker.start();f.add();
  try {await entered.promise;assert.deepEqual(p.calls,['day','events:sun']);}
  finally {release.resolve();}
  await p.worker.wake();assert.equal(f.records.preparation.nextDue(),null);
});

test('the one-time upgrade schedules old calculated records and does not rescan completed records',t=>{
  const f=library(t),id=f.add();
  f.database.connection.exec("DELETE FROM library_preparations; DELETE FROM chart_storage_migrations WHERE name='library_preparation';");
  const migrated=createChartRecords({database:f.database,authorize:()=>({accountId:f.accountId})});
  const task=migrated.preparation.next(0);assert.ok(task);assert.equal(task.chartId,id);
  assert.equal(migrated.preparation.complete(task),true);
  const again=createChartRecords({database:f.database,authorize:()=>({accountId:f.accountId})});
  assert.equal(again.preparation.nextDue(),null);
});

test('background day and complete families retain the saved IANA zone',async t=>{
  const f=library(t),p=preparation(t,f),timezone='Europe/Moscow';
  const created=f.records.create({...f.intent(),content:{...accountNatalChart(),timezone,utc:'2000-01-01T09:00:00Z',utcOffset:'UTC+03:00'}});
  await p.worker.start();assert.equal(f.records.preparation.nextDue(),null);
  assert.ok(f.records.packages.readDay({date:'2000-01-01',timezone}));
  const packet=p.returns.readPackage(f.records,created.chartId,f.accountId,{kind:'major-returns',family:'saturn',sourceKey:returnSourceKey({birthUtc:'2000-01-01T09:00:00Z',timezone})},
    {signal:new AbortController().signal});
  assert.equal(packet?.payload.source.timezone,timezone);assert.equal(packet?.payload.charts[0]?.chart.timezone,timezone);
});
