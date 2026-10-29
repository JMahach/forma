import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {MAIN_RETURN_BODIES,normalizeMainReturn} from '../shared/chart-return-contract.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../server/storage/database.ts';
import {createAccountStorage} from '../server/storage/accounts.ts';
import {createChartRecords} from '../server/services/chart-records.ts';
import {createReturnPackets} from '../server/storage/library-packages.ts';
import {createChartReturns} from '../server/services/chart-returns.ts';
import {createCycles} from '../server/services/cycles.ts';
import {createReturnReceipts} from '../server/services/return-receipt.ts';
import {accountNatalChart,chartId} from './helpers/account-chart.ts';
import {deferred} from './helpers/deferred.ts';
import type {CycleInput,CycleEventsResult,CycleChartResult} from '../shared/cycles-format.ts';
import {CYCLE_BODIES as SERVER_FAMILIES} from '../server/services/cycles.ts';
import {CYCLE_BODIES as CLIENT_FAMILIES} from '../src/domain/cycles.ts';
import {readFile} from 'node:fs/promises';

const version='a'.repeat(64),nextVersion='b'.repeat(64);
// 1 Jan 2000 noon -> 1 Jan 2100 noon is 36525 days, a 100-year calendar span.
const range={fromAge:0,toAge:36525/365.2425};
const eventUtc='2029-01-01T12:00:00Z';
function dates(input:CycleInput):CycleEventsResult {
  return {range:{fromAge:input.fromAge!,toAge:input.toAge!},events:[{
    id:`${input.body}:${eventUtc}`,body:input.body,utc:eventUtc,age:10593/365.2425,
    cycle:1,pass:1,cycleId:`${input.body}:1`,direction:'direct',
  }]};
}
function calculation(input:CycleInput):CycleChartResult {
  return {chart:{...accountNatalChart(),source:'calculated',utc:input.eventUtc!,timezone:input.timezone??'UTC',
    designUtc:'2028-10-10T01:00:00Z',designArcResidualDegrees:1e-9}};
}
function fixture(t:test.TestContext,filename=':memory:') {
  const database=openDatabase(filename);t.after(()=>database.close());
  const accounts=createAccountStorage(database),accountId=String(accounts.ensureAccount('owner@example.test').id),
    otherId=String(accounts.ensureAccount('other@example.test').id);
  let auth:string|null=accountId,sequence=100,calls=0,eventCalls=0;
  const records=createChartRecords({database,authorize:()=>auth?{accountId:auth}:null});
  const created=records.create({operationId:chartId(sequence++),expectedAccountId:accountId,content:accountNatalChart(1,accountId)});
  const chart=records.getOwn(created.chartId)!;
  const cycles={events:async(input:CycleInput)=>{eventCalls++;return dates(input);},
    chart:async(input:CycleInput)=>{calls++;return calculation(input);}};
  const service=createChartReturns({cycles});
  const input={birthUtc:chart.utc,timezone:chart.timezone!,body:'saturn',...range,eventUtc};
  const options={signal:new AbortController().signal};
  const events=()=>service.events(records,chart.id,accountId,input,options);
  const selected=()=>service.chart(records,chart.id,accountId,input,options);
  return {database,records,chart,accountId,otherId,cycles,service,input,options,events,selected,
    calls:()=>({events:eventCalls,charts:calls}),auth(value:string|null){auth=value;},
    update(patch:Partial<Parameters<typeof records.update>[0]>){return records.update({operationId:chartId(sequence++),
      expectedAccountId:accountId,chartId:chart.id,...patch});},
    remove(){return records.remove({operationId:chartId(sequence++),expectedAccountId:accountId,chartId:chart.id});}};
}

test('main dates persist, and only an opened full return is calculated; ready reads bypass a busy generator',async t=>{
  const f=fixture(t);
  const found=await f.events();assert.equal(found.events.length,1);assert.equal(found.events[0]!.utc,eventUtc);
  assert.deepEqual(f.calls(),{events:1,charts:0});
  assert.equal((await f.selected()).chart.utc,eventUtc);
  assert.deepEqual(f.calls(),{events:1,charts:1});
  f.cycles.events=async()=>{throw Error('busy');};f.cycles.chart=async()=>{throw Error('busy');};
  assert.equal((await f.events()).events[0]!.body,'saturn');
  assert.equal((await f.selected()).chart.utc,eventUtc);
});

test('a whole primary family is ready only after every listed event has a valid calculation',async t=>{
  const f=fixture(t),later='2058-01-01T12:00:00Z';
  const read=()=>f.service.readPackage(f.records,f.chart.id,f.accountId,f.input,f.options);
  assert.equal(read(),null,'no date list is not an empty complete family');
  f.cycles.events=async input=>({range:dates(input).range,events:[dates(input).events[0]!,{
    ...dates(input).events[0]!,id:`saturn:${later}`,utc:later,age:(Date.parse(later)-Date.parse(f.chart.utc))/(365.2425*86400000),
    cycle:2,cycleId:'saturn:2',
  }]});
  await f.selected();assert.equal(read(),null,'one of two events is still a partial server result');
  await f.service.chart(f.records,f.chart.id,f.accountId,{...f.input,eventUtc:later},f.options);
  const complete=read();assert.ok(complete);
  assert.equal(complete.ref.kind,'major-returns');assert.equal(complete.ref.family,'saturn');
  assert.deepEqual(complete.payload.charts.map(item=>item.chart.utc),[eventUtc,later]);
  const before=f.calls();
  assert.deepEqual(read(),complete);assert.deepEqual(f.calls(),before,'reading a package never fills its gaps');
  f.update({name:'Renamed'});assert.deepEqual(read(),complete,'metadata is not a new numerical source');
  f.database.connection.prepare("UPDATE account_chart_returns SET content=x'00' WHERE action='chart' AND eventUtc=?").run(later);
  assert.equal(read(),null,'one corrupt event makes the whole family unavailable');
  assert.equal(f.records.readReturn({chartId:f.chart.id,expectedAccountId:f.accountId,birth:f.chart,action:'chart',input:f.input})!==null,true);
});

test('a new server instance reads the saved return from the same database without computing',async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'forma-chart-returns-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'accounts.sqlite'),f=fixture(t,filename);
  await f.selected();
  const database=openDatabase(filename);t.after(()=>database.close());
  const records=createChartRecords({database,authorize:()=>({accountId:f.accountId})});
  const service=createChartReturns({
    cycles:{events:async()=>{throw Error('must not run');},chart:async()=>{throw Error('must not run');}}});
  assert.equal((await service.chart(records,f.chart.id,f.accountId,f.input,f.options)).chart.utc,eventUtc);
  const changes=database.connection.prepare('SELECT total_changes() AS n').get()!.n;
  assert.deepEqual(service.readPackage(records,f.chart.id,f.accountId,f.input,f.options)?.payload.charts.map(item=>item.chart.utc),[eventUtc]);
  assert.equal(database.connection.prepare('SELECT total_changes() AS n').get()!.n,changes);
});

test('an empty confirmed family is complete, but wrong sources, owners and non-primary families are rejected',async t=>{
  const f=fixture(t),read=(input=f.input)=>f.service.readPackage(f.records,f.chart.id,f.accountId,input,f.options);
  f.cycles.events=async input=>({range:dates(input).range,events:[]});
  await f.events();assert.deepEqual(read()?.payload.charts,[]);
  for(const patch of [{body:'moon'},{fromAge:1},{birthUtc:'2000-01-02T12:00:00Z'}])assert.throws(()=>read({...f.input,...patch}));
  f.auth(f.otherId);assert.throws(()=>read(),{code:'account_changed'});f.auth(f.accountId);
  f.update({birth:{...f.chart,birthDate:'2000-01-02',utc:'2000-01-02T12:00:00Z'}});
  assert.throws(()=>read(),{code:'source_changed'});
  f.remove();assert.throws(()=>read(),{code:'not_found'});
  assert.equal(f.calls().charts,0);
});

test('all five primary families expose their complete saved events without a new calculation',async t=>{
  const f=fixture(t);
  for(const body of MAIN_RETURN_BODIES) {
    const input={...f.input,body};
    await f.service.chart(f.records,f.chart.id,f.accountId,input,f.options);
    const packet=f.service.readPackage(f.records,f.chart.id,f.accountId,input,f.options);
    assert.ok(packet);assert.equal(packet.ref.family,body);
    assert.equal(packet.payload.dates.events[0]!.body,body);
    assert.deepEqual(packet.payload.charts.map(item=>item.chart.utc),[eventUtc]);
  }
  assert.deepEqual(f.calls(),{events:5,charts:5});
});

test('names and notes do not invalidate attached dates or calculations',async t=>{
  const f=fixture(t);await f.selected();
  f.update({name:'Renamed',note:{value:'Edited',seenRevision:1}});
  await f.selected();assert.deepEqual(f.calls(),{events:1,charts:1});
  assert.equal(f.records.getOwn(f.chart.id)!.note,'Edited');
});

test('guests and another account cannot compute or populate an owner card',async t=>{
  const f=fixture(t);f.auth(null);await assert.rejects(f.events(),{code:'auth_required'});
  f.auth(f.otherId);await assert.rejects(f.events(),{code:'account_changed'});
  await assert.rejects(f.service.events(f.records,f.chart.id,f.otherId,f.input,f.options),{code:'not_found'});
  assert.deepEqual(f.calls(),{events:0,charts:0});
});

test('unknown families, arbitrary ranges and non-primary full events never enter saved calculations',async t=>{
  const f=fixture(t);
  for(const patch of [{body:'unknown'},{fromAge:5},{toAge:150}]) {
    await assert.rejects(f.service.events(f.records,f.chart.id,f.accountId,{...f.input,...patch},f.options),{code:'invalid_chart'});
  }
  await assert.rejects(f.service.chart(f.records,f.chart.id,f.accountId,{...f.input,body:'sun'},f.options),{code:'invalid_chart'});
  await assert.rejects(f.service.chart(f.records,f.chart.id,f.accountId,{...f.input,eventUtc:'2029-01-02T12:00:00Z'},f.options),{code:'invalid_chart'});
  assert.equal(f.calls().charts,0);
});

test('all thirteen date families persist independently without calculating any full events',async t=>{
  const f=fixture(t);
  for(const body of SERVER_FAMILIES) {
    const request={...f.input,body};
    assert.equal((await f.service.events(f.records,f.chart.id,f.accountId,request,f.options)).events[0]!.body,body);
  }
  assert.deepEqual(f.calls(),{events:13,charts:0});
  const service=createChartReturns({cycles:{events:async()=>assert.fail('ready dates must not be searched again'),
    chart:async()=>assert.fail('reading dates must not prepare full events')}});
  for(const body of SERVER_FAMILIES)assert.equal((await service.events(f.records,f.chart.id,f.accountId,{...f.input,body},f.options)).events[0]!.body,body);
  assert.deepEqual(f.calls(),{events:13,charts:0});
});

test('client, server and Python agree on thirteen return families without imposing UI order',async()=>{
  const text=await readFile(new URL('../server/python/return_index.py',import.meta.url),'utf8');
  const dictionary=text.match(/^BODIES = \{([\s\S]*?)^\}/m)?.[1];assert.ok(dictionary);
  const python=[...dictionary.matchAll(/^\s+'([^']+)':/gm)].map(([,name])=>name);
  assert.equal(SERVER_FAMILIES.length,13);
  assert.deepEqual(new Set(CLIENT_FAMILIES.map(row=>row.id)),new Set(SERVER_FAMILIES));
  assert.deepEqual(new Set(python),new Set(SERVER_FAMILIES));
});

test('the expected birth and timezone cannot silently change under an existing request',async t=>{
  const f=fixture(t);
  for(const patch of [{birthUtc:'2001-01-01T12:00:00Z'},{timezone:'Europe/Moscow'},{timezone:''}]) {
    await assert.rejects(f.service.events(f.records,f.chart.id,f.accountId,{...f.input,...patch},f.options),{code:'source_changed'});
  }
  assert.equal(f.calls().events,0);
  f.update({birth:{...f.chart,timezone:'Europe/Moscow'}});
  const input={...f.input,timezone:'Europe/Moscow'};
  const result=await f.service.chart(f.records,f.chart.id,f.accountId,input,f.options);
  assert.equal(result.chart.timezone,'Europe/Moscow');
  assert.deepEqual(await f.service.chart(f.records,f.chart.id,f.accountId,input,f.options),result);
  assert.deepEqual(f.calls(),{events:1,charts:1});
});

for(const change of ['logout','account','birth','delete','abort'] as const) {
  test(`a delayed calculation after ${change} cannot write or return its old result`,async t=>{
    const f=fixture(t);await f.events();
    const pending=deferred<CycleChartResult>(),entered=deferred<void>();
    f.cycles.chart=async()=>{entered.resolve();return pending.promise;};
    const controller=new AbortController();
    const result=f.service.chart(f.records,f.chart.id,f.accountId,f.input,{signal:controller.signal});
    const expected=change==='logout'?{code:'auth_required'}:change==='account'?{code:'account_changed'}:
      change==='delete'?{code:'not_found'}:change==='abort'?{name:'AbortError'}:{code:'source_changed'};
    const rejected=assert.rejects(result,expected);await entered.promise;
    if(change==='logout')f.auth(null);
    if(change==='account')f.auth(f.otherId);
    if(change==='birth')f.update({birth:{...f.chart,utc:'2000-01-01T12:01:00Z',birthTime:'12:01'}});
    if(change==='delete')f.remove();
    if(change==='abort')controller.abort();
    pending.resolve(calculation(f.input));await rejected;
    const rows=f.database.connection.prepare("SELECT count(*) AS n FROM account_chart_returns WHERE action='chart'").get();
    assert.equal(rows!.n,0);
  });
}

test('changing birth and deleting a card remove its linked data; name alone does not',async t=>{
  const f=fixture(t);await f.selected();
  const count=()=>Number(f.database.connection.prepare('SELECT count(*) AS n FROM account_chart_returns').get()!.n);
  assert.equal(count(),2);
  f.update({birth:{...f.chart,utc:'2000-01-01T12:01:00Z',birthTime:'12:01'}});assert.equal(count(),0);
  f.update({birth:f.chart});await f.selected();
  f.remove();assert.equal(count(),0);
});

test('reconstructing the return owner keeps ready numbers and user edits without recalculating',async t=>{
  const f=fixture(t);await f.selected();
  const next=createChartReturns({cycles:f.cycles});
  assert.equal(f.database.connection.prepare('SELECT count(*) AS n FROM account_chart_returns').get()!.n,2);
  assert.equal(f.records.getOwn(f.chart.id)!.note,f.chart.note);
  await next.chart(f.records,f.chart.id,f.accountId,f.input,f.options);
  assert.deepEqual(f.calls(),{events:1,charts:1});
});

test('bad generator results are rejected without poisoning persistent data; a later attempt succeeds',async t=>{
  const f=fixture(t),generate=f.cycles.events;
  f.cycles.events=async()=>({range,events:[{...dates(f.input).events[0]!,body:'sun'}]});
  await assert.rejects(f.events(),{code:'chart_unavailable'});
  assert.equal(f.database.connection.prepare('SELECT count(*) AS n FROM account_chart_returns').get()!.n,0);
  f.cycles.events=generate;assert.equal((await f.events()).events[0]!.body,'saturn');
});

test('even a cached dates read rechecks access after its async boundary',async t=>{
  const f=fixture(t);await f.events();
  const reply=f.events();f.auth(null);
  await assert.rejects(reply,{code:'auth_required'});
});

test('concurrent readers share unfinished calculation but keep independent access after it',async t=>{
  const f=fixture(t),pending=deferred<CycleEventsResult>(),entered=deferred<void>();let calls=0,firstAllowed=true;
  const cycles=createCycles({generate:async()=>{calls++;entered.resolve();return pending.promise;}});
  t.after(()=>cycles.close());
  const service=createChartReturns({cycles});
  const first=f.records.withAuthorization(()=>firstAllowed?{accountId:f.accountId}:null);
  const a=service.events(first,f.chart.id,f.accountId,f.input,f.options),b=service.events(f.records,f.chart.id,f.accountId,f.input,f.options);
  const denied=assert.rejects(a,{code:'auth_required'});await entered.promise;firstAllowed=false;
  pending.resolve(dates(f.input));await denied;
  assert.equal((await b).events[0]!.utc,eventUtc);assert.equal(calls,1);
  assert.equal((await service.events(f.records,f.chart.id,f.accountId,f.input,f.options)).events[0]!.utc,eventUtc);
  assert.equal(calls,1);
});

test('corrupt saved dates and full results are never returned as valid and are replaced on demand',async t=>{
  const f=fixture(t);await f.selected();
  f.database.connection.prepare("UPDATE account_chart_returns SET content=x'00' WHERE action='events'").run();
  assert.equal((await f.events()).events[0]!.utc,eventUtc);
  createReturnPackets(f.database).save({chartId:f.chart.id,action:'chart',body:'saturn',eventUtc},{});
  assert.equal((await f.selected()).chart.utc,eventUtc);
  assert.deepEqual(f.calls(),{events:2,charts:2});
});

test('a late return preserves concurrent name/note edits',async t=>{
  const f=fixture(t),pending=deferred<CycleEventsResult>(),entered=deferred<void>();
  f.cycles.events=async()=>{entered.resolve();return pending.promise;};
  const reply=f.events();await entered.promise;
  f.update({name:'New name',note:{value:'New note',seenRevision:1}});
  pending.resolve(dates(f.input));assert.equal((await reply).events[0]!.utc,eventUtc);
  assert.equal(f.records.getOwn(f.chart.id)!.name,'New name');assert.equal(f.records.getOwn(f.chart.id)!.note,'New note');
});

function signedFixture(t:test.TestContext) {
  const f=fixture(t),receipts=createReturnReceipts({key:new Uint8Array(32).fill(17)});
  const service=createChartReturns({cycles:f.cycles,receipts});
  const result=calculation(f.input),proof=receipts.issue('chart',f.input,result)!;
  const packet={action:'chart' as const,input:f.input,result,proof};
  return {...f,service,receipts,packet,accept:()=>service.accept(f.records,f.chart.id,f.accountId,packet,f.options)};
}

test('a historically signed ready return is attached without a dates search and remains readable without any generator',async t=>{
  const f=signedFixture(t);
  const prepared=normalizeMainReturn('chart',f.input,f.packet.result)!;
  const signature=createHmac('sha256',new Uint8Array(32).fill(17)).update('forma:return-receipt:v1\0')
    .update(JSON.stringify([nextVersion,'chart',prepared.input,prepared.result])).digest('base64url');
  f.packet.proof=`v1.${nextVersion}.${signature}`;
  f.cycles.events=async()=>{throw Error('no dates calculation allowed');};
  f.cycles.chart=async()=>{throw Error('no chart calculation allowed');};
  assert.deepEqual(await f.accept(),{accepted:true});
  assert.equal(f.database.connection.prepare('SELECT count(*) AS n FROM account_chart_returns').get()!.n,1);
  assert.deepEqual(await f.service.chart(f.records,f.chart.id,f.accountId,f.input,f.options),prepared.result);
  assert.deepEqual(f.calls(),{events:0,charts:0});
});

test('the same signed numbers attach independently to two owner cards without exposing notes or growing duplicate rows',async t=>{
  const f=signedFixture(t),added=f.records.create({operationId:chartId(500),expectedAccountId:f.accountId,content:accountNatalChart(2,f.accountId)});
  await f.accept();await f.service.accept(f.records,added.chartId,f.accountId,f.packet,f.options);await f.accept();
  const rows=f.database.connection.prepare('SELECT chartId,action,body,eventUtc FROM account_chart_returns').all();assert.equal(rows.length,2);
  const packets=createReturnPackets(f.database);
  for(const row of rows)assert.equal('note' in (packets.read(row as unknown as Parameters<typeof packets.read>[0]) as CycleChartResult).chart,false);
  assert.deepEqual(f.calls(),{events:0,charts:0});
});

test('altered and foreign proofs, missing verifier, foreign owners and changed birth cannot populate a card',async t=>{
  const f=signedFixture(t),accept=(patch:Partial<typeof f.packet>)=>f.service.accept(f.records,f.chart.id,f.accountId,{...f.packet,...patch},f.options);
  const bad=structuredClone(f.packet.result);bad.chart.activations.personality[0]!.longitude+=1;
  await assert.rejects(accept({result:bad}),{code:'invalid_chart'});
  const foreign=createReturnReceipts({key:new Uint8Array(32).fill(18)});
  await assert.rejects(accept({proof:foreign.issue('chart',f.input,f.packet.result)!}),{code:'invalid_chart'});
  const noVerifier=createChartReturns({cycles:f.cycles});
  await assert.rejects(noVerifier.accept(f.records,f.chart.id,f.accountId,f.packet,f.options),{code:'invalid_chart'});
  f.auth(f.otherId);await assert.rejects(f.accept(),{code:'account_changed'});f.auth(f.accountId);
  f.update({birth:{...f.chart,utc:'2000-01-01T12:01:00Z'}});await assert.rejects(f.accept(),{code:'source_changed'});
  assert.equal(f.database.connection.prepare('SELECT count(*) AS n FROM account_chart_returns').get()!.n,0);
  assert.deepEqual(f.calls(),{events:0,charts:0});
});

test('the owner is checked again at the write boundary of proof verification',async t=>{
  const f=signedFixture(t),receipts={read:(...args:Parameters<typeof f.receipts.read>)=>{const result=f.receipts.read(...args);f.auth(null);return result;}};
  const service=createChartReturns({cycles:f.cycles,receipts});
  await assert.rejects(service.accept(f.records,f.chart.id,f.accountId,f.packet,f.options),{code:'auth_required'});
  assert.equal(f.database.connection.prepare('SELECT count(*) AS n FROM account_chart_returns').get()!.n,0);
});

test('signed dates retain only their canonical lifetime and never trigger preparation of full returns',async t=>{
  const f=signedFixture(t),result=dates(f.input),proof=f.receipts.issue('events',f.input,result)!;
  await f.service.accept(f.records,f.chart.id,f.accountId,{action:'events',input:f.input,result,proof},f.options);
  assert.equal((await f.service.events(f.records,f.chart.id,f.accountId,f.input,f.options)).events[0]!.utc,eventUtc);
  assert.deepEqual(f.calls(),{events:0,charts:0});
});

test('different rounded requests for one confirmed exact root share one persisted record',async t=>{
  const f=signedFixture(t);await f.accept();
  const input={...f.input,eventUtc:'2029-01-01T12:00:00.250Z'};
  const proof=f.receipts.issue('chart',input,f.packet.result)!;assert.equal(typeof proof,'string');
  await f.service.accept(f.records,f.chart.id,f.accountId,{action:'chart',input,result:f.packet.result,proof},f.options);
  assert.equal(f.database.connection.prepare('SELECT count(*) AS n FROM account_chart_returns').get()!.n,1);
  assert.equal((await f.service.chart(f.records,f.chart.id,f.accountId,f.input,f.options)).chart.utc,eventUtc);
  assert.deepEqual(f.calls(),{events:0,charts:0});
});
