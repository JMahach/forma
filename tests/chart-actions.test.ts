import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartActions } from '../src/state/chart-actions.ts';
import { accountChart, chartId } from './helpers/account-chart.ts';
import type { ChartActionResult } from '../src/state/chart-actions.ts';
import type { AccountChart, ChartWriteIntent, ChartWriteOutcome } from '../shared/chart-record-contract.ts';
import type { SavedChart } from '../shared/chart-types.ts';
import type { ChartClient } from '../src/data/chart-client.ts';

const access = {accountId: '1', sessionId: 'session'};
const input = {name: 'A', note: 'draft', birth: {source: 'transit' as const, utc: '2000-01-01T12:00:00Z'}};
function fixture() {
  let current: typeof access | null = {...access}, writes = 0, calculations = 0, opens = 0;
  let sendError: unknown = null, seen: unknown, lookup = {kind: 'unknown'} as any;
  let afterWrite = () => {};
  const pending: unknown[] = [];
  const client = {
    async create(value) { writes++; seen = value; afterWrite(); if (sendError) throw sendError; return {...value, outcome: {kind:'created', chartId:chartId(1),revision:1}}; },
    async update(value) { writes++; seen = value; return {...value,outcome:{kind:'updated',chartId:value.chartId,revision:2}}; },
    async remove(value) { writes++; seen = value; afterWrite(); if (sendError) throw sendError; return {...value,outcome:{kind:'deleted',chartId:value.chartId}}; },
    async addFromSource(value) { writes++; seen = value; return {...value,outcome:{kind:'created',chartId:chartId(2),revision:1}}; },
    async outcome(value) { return {...value,outcome:lookup}; },
  } satisfies Pick<ChartClient,'create'|'update'|'remove'|'addFromSource'|'outcome'>;
  const actions = createChartActions({client, getSession:()=>current, newId:()=>chartId(77),
    library:{async open(){opens++;return accountChart();},async forget(){}},
    async calculate(){calculations++;return accountChart();},onPending:values=>pending.push(values)});
  return {actions, pending, seen:()=>seen, writes:()=>writes, calculations:()=>calculations, opens:()=>opens,
    switch(value:typeof current){current=value;}, fail(value:unknown){sendError=value;},lookup(value:unknown){lookup=value;},
    afterWrite(fn:()=>void){afterWrite=fn;}};
}

test('signed-in creation uses one server write and then reads the actual chart, without a separate calculation',async()=>{
  const f=fixture(), result=await f.actions.create(input);
  assert.equal(result.kind,'settled'); assert.equal(result.chart?.id,chartId(1));
  assert.equal(f.writes(),1);assert.equal(f.calculations(),0);assert.equal(f.opens(),1);
  assert.deepEqual(f.actions.pending,[]);
});

test('a guest gets a temporary calculated card without a server write or save marker',async()=>{
  const f=fixture();f.switch(null);
  const result=await f.actions.create(input);
  assert.equal(result.kind,'temporary');assert.equal(result.chart.name,'A');assert.equal(result.chart.note,'draft');
  assert.equal(f.writes(),0);assert.equal(f.calculations(),1);assert.deepEqual(f.actions.pending,[]);
});

test('a lost write remains a small pending pointer and is recovered only by reading its outcome',async()=>{
  const f=fixture();f.fail(Object.assign(new Error(),{code:'connection_failed'}));
  const first=await f.actions.create(input);assert.equal(first.kind,'unknown');
  assert.deepEqual(f.actions.pending,[{operationId:chartId(77),expectedAccountId:'1'}]);
  f.lookup({kind:'created',chartId:chartId(1),revision:1});
  const result=await f.actions.recover(f.actions.pending[0]!);
  assert.equal(result.kind,'settled');assert.equal(f.writes(),1);assert.deepEqual(f.actions.pending,[]);
});

test('an expired outcome stays unknown and never causes a repeated write',async()=>{
  const f=fixture();f.fail(new TypeError('network'));
  await f.actions.create(input);
  const result=await f.actions.recover(f.actions.pending[0]!);
  assert.equal(result.kind,'unknown');assert.equal(f.writes(),1);assert.equal(f.actions.pending.length,1);
});

test('a late committed write cannot open a chart for another account',async()=>{
  const f=fixture();f.afterWrite(()=>f.switch({accountId:'2',sessionId:'next'}));
  const result=await f.actions.create(input);
  assert.equal(result.kind,'settled');assert.equal(result.active,false);assert.equal(result.chart,null);assert.equal(f.opens(),0);
});

test('an explicit HTTP refusal retains its cause and clears the unknown pointer',async()=>{
  const f=fixture();f.fail(Object.assign(new Error('Choose time'),{status:422,code:'ambiguous_time'}));
  await assert.rejects(f.actions.create(input),{status:422,code:'ambiguous_time'});
  assert.deepEqual(f.actions.pending,[]);
});

test('note edits send the shown note revision without resending birth or an unchanged name',async()=>{
  const f=fixture(),previous=accountChart();
  await f.actions.update({chartId:previous.id,note:{value:'new note',seenRevision:previous.noteRevision}});
  assert.deepEqual(f.seen(),{operationId:chartId(77),expectedAccountId:'1',chartId:previous.id,note:{value:'new note',seenRevision:1}});
});

test('a failed current-chart read cannot turn a committed receipt into a failed command',async()=>{
  const f=fixture();
  const actions=createChartActions({client:{async create(value: Parameters<ChartClient['create']>[0]){return {...value,outcome:{kind:'created',chartId:chartId(1),revision:1}};}} as any,
    getSession:()=>access,newId:()=>chartId(77),calculate:async()=>accountChart(),
    library:{async open(){throw Object.assign(new Error(),{code:'not_found',status:404});},async forget(){}}});
  const result=await actions.create(input);
  assert.equal(result.kind,'settled');assert.equal(result.receipt.outcome.kind,'created');
  assert.equal(result.chart,null);assert.equal((result.readError as any).code,'not_found');
});

for (const status of [503, 504]) test(`HTTP ${status} after a committed write retains its recovery pointer`, async () => {
  const f = fixture();
  f.fail(Object.assign(new Error('gateway response'), {status, code: 'server_error'}));
  f.lookup({kind: 'created', chartId: chartId(1), revision: 1});
  const result = await f.actions.create(input);
  assert.equal(result.kind, 'unknown'); assert.equal(f.actions.pending.length, 1);
  const recovered = await f.actions.recover(f.actions.pending[0]!);
  assert.equal(recovered.kind, 'settled'); assert.equal(f.writes(), 1);
});


for (const cause of [{status: 422, code: 'ambiguous_time'}, {status: 503, code: 'server_error'}]) {
  test(`late ${cause.code} cannot expose the former account error after a switch`, async () => {
    const f = fixture();
    f.fail(Object.assign(new Error('private birth time'), {...cause, choices: [{utc: 'private'}]}));
    f.afterWrite(() => {f.switch({accountId: '2', sessionId: 'next'}); f.actions.clear();});
    if (cause.status === 422) await assert.rejects(f.actions.create(input), (error: unknown) => {
      assert.equal((error as any).code, 'account_changed'); assert.equal((error as any).choices, undefined);
      assert.equal((error as Error).message.includes('private'), false); return true;
    });
    else {const result = await f.actions.create(input); assert.equal(result.kind, 'unknown'); assert.equal(result.error, undefined);}
    assert.deepEqual(f.actions.pending, []);
  });
}

test('a late failed current-record read returns only an inactive historical receipt', async () => {
  let current: typeof access | null = access;
  const actions = createChartActions({getSession: () => current, newId: () => chartId(77),
    client: {async create(value) {return {...value, outcome: {kind: 'created', chartId: chartId(1), revision: 1}};},
      async update() {assert.fail('no update');}, async remove() {assert.fail('no deletion');},
      async addFromSource() {assert.fail('no copying');}, async outcome() {assert.fail('no lookup');}},
    calculate: async () => accountChart(),
    library: {async open() {current = {accountId: '2', sessionId: 'next'}; throw new Error('private error');}, async forget() {}}});
  const result = await actions.create(input); assert.equal(result.kind, 'settled');
  assert.equal(result.active, false); assert.equal(result.chart, null); assert.equal(result.readError, undefined);
});


test('a late unknown response retains an uncleared recovery pointer without its private cause', async () => {
  const f = fixture(); f.fail(Object.assign(new Error('private'), {status: 503, code: 'server_error'}));
  f.afterWrite(() => f.switch({accountId: '2', sessionId: 'next'}));
  const result = await f.actions.create(input); assert.equal(result.kind, 'unknown'); assert.equal(result.error, undefined);
  assert.equal(f.actions.pending.length, 1); assert.equal(f.actions.pending[0]!.expectedAccountId, '1');
});


test('rechecking an unconfirmed deletion reads its first outcome instead of issuing another deletion',async()=>{
  const f=fixture();f.fail(Object.assign(new Error('lost reply'),{status:504}));
  const first=await f.actions.remove(chartId(1));assert.equal(first.kind,'unknown');
  const waiting=await f.actions.remove(chartId(1));assert.equal(waiting.kind,'unknown');
  assert.equal(f.writes(),1);assert.equal(f.actions.pending.length,1);
  f.lookup({kind:'deleted',chartId:chartId(1)});
  const confirmed=await f.actions.remove(chartId(1));
  assert.equal(confirmed.kind,'settled');assert.equal(confirmed.receipt.outcome.kind,'deleted');
  assert.equal(f.writes(),1);assert.equal(f.actions.pending.length,0);
});

test('concurrent confirmations share one deletion while a different card remains independent',async()=>{
  let writes=0,finish!:()=>void;
  const done=new Promise<void>(resolve=>{finish=resolve;});
  const actions=createChartActions({getSession:()=>access,newId:()=>chartId(70+writes),calculate:async()=>accountChart(),
    client:{async remove(intent: Parameters<ChartClient['remove']>[0]){writes++;await done;return {...intent,outcome:{kind:'deleted',chartId:intent.chartId}};}} as any,
    library:{async open(){return accountChart();},async forget(){}}});
  const first=actions.remove(chartId(1)), second=actions.remove(chartId(1)), other=actions.remove(chartId(2));
  assert.equal(writes,2);finish();await Promise.all([first,second,other]);assert.equal(writes,2);
});

test('a lost outcome lookup remains unknown and keeps the original deletion pointer',async()=>{
  let writes=0,reads=0;
  const actions=createChartActions({getSession:()=>access,newId:()=>chartId(70),calculate:async()=>accountChart(),
    client:{async remove(){writes++;throw new TypeError('network');},async outcome(){reads++;throw new TypeError('network');}} as any,
    library:{async open(){return accountChart();},async forget(){}}});
  await actions.remove(chartId(1));const check=await actions.remove(chartId(1));
  assert.equal(check.kind,'unknown');assert.equal(writes,1);assert.equal(reads,1);assert.equal(actions.pending.length,1);
});


test('logout clears deletion recovery and a late response cannot attach it to the next account',async()=>{
  let session:typeof access|null={...access},finish!:(value:any)=>void;
  const actions=createChartActions({getSession:()=>session,newId:()=>chartId(71),calculate:async()=>accountChart(),
    client:{remove:()=>new Promise(resolve=>{finish=resolve;})} as any,
    library:{async open(){return accountChart();},async forget(){assert.fail('former account must not clear the new library');}}});
  const work=actions.remove(chartId(1));
  session={accountId:'2',sessionId:'new'};actions.clear();
  finish({operationId:chartId(71),expectedAccountId:'1',outcome:{kind:'deleted',chartId:chartId(1)}});
  const result=await work;assert.equal(result.kind,'settled');assert.equal(result.active,false);
  session={...access};assert.equal(actions.isCheckingRemoval(chartId(1)),false);assert.deepEqual(actions.pending,[]);
});

test('expanded decimal chart IDs remain distinct through deletion, lost replies and outcome recovery',async()=>{
  const {createChartClient}=await import('../src/data/chart-client.ts');
  const ids=['1000000000000000001','1000000000000000002'];
  assert.equal(Number(ids[0]),Number(ids[1]),'this pair deliberately detects precision loss');
  const operations=new Map<string,string>(), writes:string[]=[], forgotten:string[]=[];
  const client=createChartClient({getSession:()=>access,fetch:async(input,options={})=>{
    const path=String(input);
    if(options.method==='DELETE'){
      const chart=path.slice('/api/charts/'.length),body=JSON.parse(String(options.body));
      writes.push(chart);operations.set(body.operationId,chart);
      assert.match(body.operationId,/^[a-f0-9-]+$/);assert.notEqual(body.operationId,chart);
      return Response.json({error:'server_error'},{status:504});
    }
    const operation=path.slice('/api/charts/operations/'.length).split('?')[0];
    return Response.json({kind:'deleted',chartId:operations.get(operation)});
  }});
  const actions=createChartActions({client,getSession:()=>access,calculate:async()=>accountChart(),
    library:{async open(){return accountChart();},async forget(id){forgotten.push(id);}}});
  for(const id of ids)assert.equal((await actions.remove(id)).kind,'unknown');
  for(const id of ids)assert.equal((await actions.remove(id)).kind,'settled');
  assert.deepEqual(writes,ids);assert.deepEqual(forgotten,ids);assert.deepEqual(actions.pending,[]);
});


function readySaveFixture() {
  let current:typeof access|null=null,writes=0,calculations=0,reads=0,opens=0;
  let result:ChartWriteOutcome={kind:'created',chartId:chartId(2),revision:1};
  let error:unknown,after=async()=>{};
  const copy={...accountChart(2),note:'Own existing note'};
  const temporary:SavedChart={...accountChart(1),createdAt:'',updatedAt:''};
  const submitted:unknown[]=[];
  async function write(value:ChartWriteIntent) {writes++;submitted.push(value);await after();if(error)throw error;return {...value,outcome:result};}
  const actions=createChartActions({getSession:()=>current,newId:()=>chartId(77),
    client:{create:write,update:write,remove:write,addFromSource:write,
      async outcome(value){reads++;return {...value,outcome:result};}},
    library:{async open(){opens++;return copy;},async forget(){}},
    async calculate(){calculations++;return temporary;},saveReady:write});
  return {actions,temporary,copy,submitted,counts:()=>({writes,calculations,reads,opens}),
    login(value:typeof current={...access}){current=value;},outcome(value:ChartWriteOutcome){result=value;},
    fail(value:unknown){error=value;},wait(value:()=>Promise<void>){after=value;}};
}

test('ready temporary save continues once after login and repeated clicks share the same command',async()=>{
  const h=readySaveFixture(),source={kind:'temporary' as const,chart:h.temporary};
  const action=h.actions.prepareSave(source);
  assert.deepEqual(await action.run(),{kind:'sign-in'});
  assert.equal(h.actions.prepareSave(source),action);
  assert.deepEqual(await action.run(),{kind:'sign-in'});
  assert.equal(h.counts().writes,0);h.login();
  const [first,second]=await Promise.all([action.run(),action.run()]);
  assert.equal(first,second);assert.equal(first.kind,'settled');
  assert.deepEqual(h.counts(),{writes:1,calculations:0,reads:0,opens:1});
  assert.equal((h.submitted[0] as {chart:SavedChart}).chart,h.temporary);
});

test('adding a shared source opens the matched own chart without copying its note or calculating',async()=>{
  const h=readySaveFixture();h.login();h.outcome({kind:'existing',chartId:chartId(2),revision:1});
  const source={...accountChart(1,'7'),note:'Private source note'};
  const result=await h.actions.prepareSave({kind:'shared',chart:source}).run();
  assert.equal(result.kind,'settled');if(result.kind!=='settled')return;
  assert.equal(result.chart,h.copy);assert.equal(result.chart?.note,'Own existing note');
  assert.deepEqual(h.submitted,[{operationId:chartId(77),expectedAccountId:'1',sourceId:chartId(1),seenRevision:1}]);
  assert.equal(h.counts().calculations,0);
});

for(const change of ['cancel','source','revision','navigation'] as const)test(`login completion cannot resume a ready save after ${change}`,async()=>{
  const h=readySaveFixture();let visible=true;
  const source={kind:'shared' as const,chart:{...accountChart(1,'7')}};
  const action=h.actions.prepareSave(source,()=>visible);
  assert.equal((await action.run()).kind,'sign-in');
  if(change==='cancel')action.cancel();
  if(change==='source')source.chart.name='Changed';
  if(change==='revision')source.chart.revision++;
  if(change==='navigation')visible=false;
  h.login();assert.deepEqual(await action.run(),{kind:'inactive'});
  assert.deepEqual(h.counts(),{writes:0,calculations:0,reads:0,opens:0});
});

test('a lost ready save is checked by outcome reading without a second create',async()=>{
  const h=readySaveFixture();h.login();h.fail(new TypeError('lost response'));
  const action=h.actions.prepareSave({kind:'temporary',chart:h.temporary});
  assert.equal((await action.run()).kind,'unknown');h.fail(undefined);
  assert.equal((await action.run()).kind,'settled');
  assert.deepEqual(h.counts(),{writes:1,calculations:0,reads:1,opens:1});
});

for(const change of ['cancel','account','session','clear'] as const)test(`a committed ready save after ${change} cannot restore the old screen`,async()=>{
  const h=readySaveFixture();h.login();let finish!:()=>void;
  h.wait(()=>new Promise(resolve=>{finish=resolve;}));
  const action=h.actions.prepareSave({kind:'temporary',chart:h.temporary});
  const pending=action.run();
  if(change==='cancel')action.cancel();
  if(change==='account')h.login({accountId:'2',sessionId:'next'});
  if(change==='session')h.login({accountId:'1',sessionId:'next'});
  if(change==='clear')h.actions.clear();
  finish();const result=await pending;
  assert.equal(result.kind,'settled');if(result.kind!=='settled')return;
  assert.equal(result.active,false);assert.equal(result.chart,null);assert.equal(h.counts().opens,0);
  assert.deepEqual(await action.run(),{kind:'inactive'});
});

test('cancelling a save while its library read finishes suppresses the returned chart',async()=>{
  let finish!:(chart:AccountChart)=>void;
  const h=readySaveFixture();h.login();
  const actions=createChartActions({getSession:()=>access,calculate:async()=>{assert.fail('no recalculation');},
    client:{async create(){assert.fail();},async update(){assert.fail();},async remove(){assert.fail();},
      async addFromSource(value){return {...value,outcome:{kind:'created',chartId:chartId(2),revision:1}};},async outcome(){assert.fail();}},
    library:{open:()=>new Promise(resolve=>{finish=resolve;}),async forget(){}}});
  const action=actions.prepareSave({kind:'shared',chart:accountChart(1,'7')});
  const pending=action.run();await new Promise(setImmediate);action.cancel();finish(accountChart(2));
  const result=await pending;assert.equal(result.kind,'settled');if(result.kind==='settled'){assert.equal(result.active,false);assert.equal(result.chart,null);}
});


test('returning to an unknown save after closing its action reads the original outcome',async()=>{
  const h=readySaveFixture();h.login();h.fail(new TypeError('lost reply'));
  const source={kind:'temporary' as const,chart:h.temporary};
  const first=h.actions.prepareSave(source);assert.equal((await first.run()).kind,'unknown');first.cancel();
  h.fail(undefined);const second=h.actions.prepareSave(source);assert.notEqual(second,first);
  assert.equal((await second.run()).kind,'settled');
  assert.deepEqual(h.counts(),{writes:1,calculations:0,reads:1,opens:1});
});


test('a definitive ready-save refusal allows a fresh explicit write instead of checking a nonexistent outcome',async()=>{
  const h=readySaveFixture();h.login();h.fail(Object.assign(new Error('invalid input'),{status:422,code:'city_required'}));
  const source={kind:'temporary' as const,chart:h.temporary},first=h.actions.prepareSave(source);
  await assert.rejects(first.run(),{code:'city_required'});
  assert.equal(h.actions.pending.length,0);first.cancel();h.fail(undefined);
  assert.equal((await h.actions.prepareSave(source).run()).kind,'settled');
  assert.deepEqual(h.counts(),{writes:2,calculations:0,reads:0,opens:1});
});
