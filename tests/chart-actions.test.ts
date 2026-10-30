import {createChartEditing} from '../src/application/chart-editing.ts';
import test from 'node:test';
import {getEventListeners} from 'node:events';
import assert from 'node:assert/strict';
import { createChartActions } from '../src/state/chart-actions.ts';
import { accountChart, chartId } from './helpers/account-chart.ts';
import type { ChartActionResult } from '../src/state/chart-actions.ts';
import type { AccountChart, ChartWriteIntent, ChartWriteOutcome } from '../shared/chart-record-contract.ts';
import type { SavedChart } from '../shared/chart-types.ts';
import type { ChartClient } from '../src/data/chart-client.ts';

const options=(signal=new AbortController().signal)=>({signal,isCurrent:()=>true});
const access = {accountId: '1', sessionId: 'session'};
const input = {name: 'A', note: 'draft', birth: {source: 'transit' as const, utc: '2000-01-01T12:00:00Z'}};
function fixture(prepareWrite?: Parameters<typeof createChartActions>[0]['prepareWrite']) {
  let current: typeof access | null = {...access}, writes = 0, opens = 0;
  let sendError: unknown = null, seen: unknown, lookup = {kind: 'unknown'} as any;
  let afterWrite = () => {};
  const pending: unknown[] = [];
  const client = {
    async create(value) { writes++; seen = value; afterWrite(); if (sendError) throw sendError; return {...value, outcome: {kind:'created', chartId:chartId(1),revision:1}}; },
    async update(value) { writes++; seen = value; return {...value,outcome:{kind:'updated',chartId:value.chartId,revision:2}}; },
    async remove(value) { writes++; seen = value; afterWrite(); if (sendError) throw sendError; return {...value,catalogMarker:'2',outcome:{kind:'deleted',chartId:value.chartId}}; },
    async addFromSource(value) { writes++; seen = value; return {...value,outcome:{kind:'created',chartId:chartId(2),revision:1}}; },
    async outcome(value) { return {...value,outcome:lookup,catalogMarker:'2'}; },
  } satisfies Pick<ChartClient,'create'|'update'|'remove'|'addFromSource'|'outcome'>;
  const actions = createChartActions({client, getSession:()=>current, newId:()=>chartId(77),
    library:{async open(){opens++;return accountChart();},async forget(){}},
    prepareWrite,onPending:values=>pending.push(values)});
  return {actions, pending, seen:()=>seen, writes:()=>writes, opens:()=>opens,
    switch(value:typeof current){current=value;}, fail(value:unknown){sendError=value;},lookup(value:unknown){lookup=value;},
    afterWrite(fn:()=>void){afterWrite=fn;}};
}

test('signed-in creation uses one server write and then reads the actual chart, without a separate calculation',async()=>{
  const f=fixture(), result=await f.actions.create(input);
  assert.equal(result.kind,'settled'); assert.equal(result.chart?.id,chartId(1));
  assert.equal(f.writes(),1);assert.equal(f.opens(),1);
  assert.deepEqual(f.actions.pending,[]);
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
    getSession:()=>access,newId:()=>chartId(77),
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
  const actions=createChartActions({getSession:()=>access,newId:()=>chartId(70+writes),
    client:{async remove(intent: Parameters<ChartClient['remove']>[0]){writes++;await done;return {...intent,catalogMarker:'2',outcome:{kind:'deleted',chartId:intent.chartId}};}} as any,
    library:{async open(){return accountChart();},async forget(){}}});
  const first=actions.remove(chartId(1)), second=actions.remove(chartId(1)), other=actions.remove(chartId(2));
  assert.equal(writes,2);finish();await Promise.all([first,second,other]);assert.equal(writes,2);
});

test('a lost outcome lookup remains unknown and keeps the original deletion pointer',async()=>{
  let writes=0,reads=0;
  const actions=createChartActions({getSession:()=>access,newId:()=>chartId(70),
    client:{async remove(){writes++;throw new TypeError('network');},async outcome(){reads++;throw new TypeError('network');}} as any,
    library:{async open(){return accountChart();},async forget(){}}});
  await actions.remove(chartId(1));const check=await actions.remove(chartId(1));
  assert.equal(check.kind,'unknown');assert.equal(writes,1);assert.equal(reads,1);assert.equal(actions.pending.length,1);
});


test('logout clears deletion recovery and a late response cannot attach it to the next account',async()=>{
  let session:typeof access|null={...access},finish!:(value:any)=>void;
  const actions=createChartActions({getSession:()=>session,newId:()=>chartId(71),
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
    return Response.json({kind:'deleted',chartId:operations.get(operation),catalogMarker:'2'});
  }});
  const actions=createChartActions({client,getSession:()=>access,
    library:{async open(){return accountChart();},async forget(id){forgotten.push(id);}}});
  for(const id of ids)assert.equal((await actions.remove(id)).kind,'unknown');
  for(const id of ids)assert.equal((await actions.remove(id)).kind,'settled');
  assert.deepEqual(writes,ids);assert.deepEqual(forgotten,ids);assert.deepEqual(actions.pending,[]);
});


function readySaveFixture(prepareWrite?: Parameters<typeof createChartActions>[0]['prepareWrite']) {
  let current:typeof access|null=null,writes=0,reads=0,opens=0;
  let result:ChartWriteOutcome={kind:'created',chartId:chartId(2),revision:1};
  let error:unknown,lookupError:unknown,after=async()=>{};
  const copy={...accountChart(2),note:'Own existing note'};
  const temporary:SavedChart={...accountChart(1),createdAt:'',updatedAt:''};
  const submitted:unknown[]=[];
  async function write(value:ChartWriteIntent) {writes++;submitted.push(value);await after();if(error)throw error;return {...value,outcome:result};}
  const actions=createChartActions({getSession:()=>current,newId:()=>chartId(77),
    client:{create:write,update:write,remove:write,addFromSource:write,
      async outcome(value){reads++;if(lookupError)throw lookupError;return {...value,outcome:result};}},
    library:{async open(){opens++;return copy;},async forget(){}},
    saveReady:write,prepareWrite});
  return {actions,temporary,copy,submitted,counts:()=>({writes,reads,opens}),
    login(value:typeof current={...access}){current=value;},outcome(value:ChartWriteOutcome){result=value;},
    fail(value:unknown){error=value;},lookupFail(value:unknown){lookupError=value;},wait(value:()=>Promise<void>){after=value;}};
}

test('adding a shared source opens the matched own chart without copying its note or calculating',async()=>{
  const h=readySaveFixture();h.login();h.outcome({kind:'existing',chartId:chartId(2),revision:1});
  const source={...accountChart(1,'7'),note:'Private source note'};
  const result=await h.actions.saveSource({kind:'shared',chart:source},options());
  assert.equal(result.kind,'settled');if(result.kind!=='settled')return;
  assert.equal(result.chart,h.copy);assert.equal(result.chart?.note,'Own existing note');
  assert.deepEqual(h.submitted,[{operationId:chartId(77),expectedAccountId:'1',sourceId:chartId(1),seenRevision:1}]);
});

test('a lost ready save is checked by outcome reading without a second create',async()=>{
  const h=readySaveFixture();h.login();h.fail(new TypeError('lost response'));
  const source={kind:'temporary' as const,chart:h.temporary};
  assert.equal((await h.actions.saveSource(source,options())).kind,'unknown');h.fail(undefined);
  assert.equal((await h.actions.saveSource(source,options())).kind,'settled');
  assert.deepEqual(h.counts(),{writes:1,reads:1,opens:1});
});

for(const change of ['cancel','account','session','clear'] as const)test(`a committed ready save after ${change} cannot restore the old screen`,async()=>{
  const h=readySaveFixture();h.login();let finish!:()=>void;
  h.wait(()=>new Promise(resolve=>{finish=resolve;}));
  const controller=new AbortController();
  const pending=h.actions.saveSource({kind:'temporary',chart:h.temporary},options(controller.signal));
  if(change==='cancel')controller.abort();
  if(change==='account')h.login({accountId:'2',sessionId:'next'});
  if(change==='session')h.login({accountId:'1',sessionId:'next'});
  if(change==='clear')h.actions.clear();
  finish();const result=await pending;
  assert.equal(result.kind,'settled');if(result.kind!=='settled')return;
  assert.equal(result.active,false);assert.equal(result.chart,null);
  assert.equal(h.counts().opens,change==='cancel'?1:0,'screen cancellation allows library acceptance, account retirement does not');
});

test('cancelling a save while its library read finishes suppresses the returned chart',async()=>{
  let finish!:(chart:AccountChart)=>void;
  const h=readySaveFixture();h.login();
  const actions=createChartActions({getSession:()=>access,
    client:{async create(){assert.fail();},async update(){assert.fail();},async remove(){assert.fail();},
      async addFromSource(value){return {...value,outcome:{kind:'created',chartId:chartId(2),revision:1}};},async outcome(){assert.fail();}},
    library:{open:()=>new Promise(resolve=>{finish=resolve;}),async forget(){}}});
  const controller=new AbortController();
  const pending=actions.saveSource({kind:'shared',chart:accountChart(1,'7')},options(controller.signal));
  await new Promise(setImmediate);controller.abort();finish(accountChart(2));
  const result=await pending;assert.equal(result.kind,'settled');if(result.kind==='settled'){assert.equal(result.active,false);assert.equal(result.chart,null);}
});


test('returning to an unknown source after cancellation reads the original outcome',async()=>{
  const h=readySaveFixture();h.login();h.fail(new TypeError('lost reply'));
  const source={kind:'temporary' as const,chart:h.temporary};
  const controller=new AbortController();
  assert.equal((await h.actions.saveSource(source,options(controller.signal))).kind,'unknown');controller.abort();
  h.fail(undefined);assert.equal((await h.actions.saveSource(source,options())).kind,'settled');
  assert.deepEqual(h.counts(),{writes:1,reads:1,opens:1});
});


test('a definitive ready-save refusal allows a fresh explicit write instead of checking a nonexistent outcome',async()=>{
  const h=readySaveFixture();h.login();h.fail(Object.assign(new Error('invalid input'),{status:422,code:'city_required'}));
  const source={kind:'temporary' as const,chart:h.temporary};
  await assert.rejects(h.actions.saveSource(source,options()),{code:'city_required'});
  assert.equal(h.actions.pending.length,0);h.fail(undefined);
  assert.equal((await h.actions.saveSource(source,options())).kind,'settled');
  assert.deepEqual(h.counts(),{writes:2,reads:0,opens:1});
});

test('concurrent recovery shares acquisition but keeps each consumer cancellation independent',async()=>{
 const intent={operationId:chartId(77),expectedAccountId:'1'};
 let reads=0,opens=0,release!:()=>void,transport:AbortSignal|undefined;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const actions=createChartActions({initialPending:[intent],getSession:()=>access,
  client:{async outcome(value,signal){reads++;transport=signal;await gate;return {...value,outcome:{kind:'created',chartId:chartId(1),revision:1}};}} as Pick<ChartClient,'create'|'update'|'remove'|'addFromSource'|'outcome'>,
  library:{async open(){opens++;return accountChart();},async forget(){}}});
 const controller=new AbortController();
 const first=actions.recover(intent,controller.signal);
 const firstRejected=assert.rejects(first,{name:'AbortError'});
 let current=true;
 const second=actions.recover(intent,undefined,()=>current);
 const third=actions.recover(intent);
 assert.equal(reads,1);
 controller.abort();await firstRejected;assert.equal(transport?.aborted,false);
 current=false;release();
 const [obsolete,active]=await Promise.all([second,third]);
 assert.equal(opens,1);assert.equal(obsolete.kind,'settled');assert.equal(active.kind,'settled');
 if(obsolete.kind==='settled'&&active.kind==='settled'){
  assert.equal(obsolete.active,false);assert.equal(obsolete.chart,null);
  assert.equal(active.active,true);assert.equal(active.chart?.id,chartId(1));
 }
 assert.deepEqual(actions.pending,[]);
 await actions.recover(intent);assert.equal(reads,2,'completed outcomes are not cached');
});

test('the last recovery consumer aborts transport and a cleared generation cannot settle for the new one',async()=>{
 const intent={operationId:chartId(78),expectedAccountId:'1'};
 const requests:{signal?:AbortSignal;finish:(value:unknown)=>void}[]=[];
 let opens=0;
 const actions=createChartActions({initialPending:[intent],getSession:()=>access,
  client:{outcome(_value: ChartWriteIntent,signal?: AbortSignal){return new Promise(resolve=>requests.push({signal,finish:resolve}));}} as unknown as Pick<ChartClient,'create'|'update'|'remove'|'addFromSource'|'outcome'>,
  library:{async open(){opens++;return accountChart();},async forget(){}}});
 const controller=new AbortController(),first=actions.recover(intent,controller.signal);
 const rejected=assert.rejects(first,{name:'AbortError'});
 controller.abort();await rejected;assert.equal(requests[0]!.signal?.aborted,true);
 const old=actions.recover(intent);actions.clear();
 const next=actions.recover(intent);assert.equal(requests.length,3);
 for(const request of requests)request.finish({...intent,outcome:{kind:'created',chartId:chartId(1),revision:1}});
 const [oldResult,nextResult]=await Promise.all([old,next]);
 assert.equal(opens,1);
 assert.equal(oldResult.kind==='settled'&&oldResult.active,false);
 assert.equal(nextResult.kind==='settled'&&nextResult.active,true);
});


test('ready save waits for the prepared pointer and binding; RAM-only still permits one write',async()=>{
 let release!:(value:{kind:'memory-only'})=>void;const prepared=new Promise<{kind:'memory-only'}>(resolve=>{release=resolve;});
 const steps:string[]=[];let binding:ChartWriteIntent|null=null;
 const h=readySaveFixture(async(intent,seen,signal)=>{
  steps.push('checkpoint');assert.deepEqual(h.actions.pending,[intent]);assert.deepEqual(binding,intent);
  assert.equal(seen.sessionId,access.sessionId);assert.equal(signal.aborted,false);return prepared;
 });h.login();
 const first=h.actions.saveSource({kind:'temporary',chart:h.temporary},{...options(),onIntent:value=>{binding=value;steps.push('binding');}});
 assert.equal(h.counts().writes,0,'HTTP cannot begin while the checkpoint waits');assert.deepEqual(steps,['binding','checkpoint']);
 release({kind:'memory-only'});assert.equal((await first).kind,'settled');assert.equal(h.counts().writes,1);
});

for(const change of ['session','source','abort','failed'] as const)test(`an unsent save drops its recovery pointer after ${change} during preparation`,async()=>{
 let release!:(value:{kind:'stored'}|{kind:'failed';cause:unknown})=>void;let attempts=0;
 const prepared=new Promise<{kind:'stored'}|{kind:'failed';cause:unknown}>(resolve=>{release=resolve;});
 const h=readySaveFixture(async()=>++attempts===1?prepared:{kind:'stored'});h.login();
 let current=true,binding:ChartWriteIntent|null=null;
 const controller=new AbortController(),source={kind:'temporary' as const,chart:h.temporary};
 const request={signal:controller.signal,isCurrent:()=>current,onIntent:(value:ChartWriteIntent|null)=>{binding=value;}};
 const running=h.actions.saveSource(source,request);
 assert.equal(h.counts().writes,0);
 const rejected=assert.rejects(running);
 if(change==='session')h.login({accountId:'2',sessionId:'next'});
 if(change==='source')current=false;
 if(change==='abort')controller.abort();
 release(change==='failed'?{kind:'failed',cause:new Error('snapshot producer')}:{kind:'stored'});
 await rejected;assert.equal(h.counts().writes,0);assert.deepEqual(h.actions.pending,[]);assert.equal(binding,null);
 if(change==='failed'){
  assert.equal((await h.actions.saveSource(source,request)).kind,'settled','another explicit save is not trapped in lookup for an unsent operation');
  assert.equal(h.counts().writes,1);assert.equal(h.counts().reads,0);
  const direct=fixture(async()=>({kind:'failed',cause:new Error('snapshot')}));
  await assert.rejects(direct.actions.create(input),{code:'checkpoint_failed'});
  assert.equal(direct.writes(),0);assert.deepEqual(direct.actions.pending,[]);
 }
});

// Exercise the application result before a view disposes its completed request.
test('editing reports the command outcome once without repeating deletion',async()=>{
 for(const kind of ['deleted','absent','unknown','refused'] as const){
  const f=fixture(),deleted:string[]=[],reports:string[]=[];
  if(kind==='absent' || kind==='unknown'){f.fail(new TypeError('lost response'));f.lookup({kind,chartId:chartId(1)});}
  if(kind==='refused')f.fail(Object.assign(new Error('invalid'),{status:422,code:'invalid_request'}));
  const editing=createChartEditing({actions:f.actions,ready:async()=>{},session:()=>access,accountId:()=>access.accountId,
   temporaryId:()=>null,durable:()=>true,online:()=>kind!=='unknown',deleted:id=>{deleted.push(id);},
   observe:action=>{reports.push(action);return {finishSuccess(){reports.push('success');},reportFailure(step){reports.push(step.reason);},reportError(_error,step){reports.push(step.stage);}};},
   messages:{signIn:'sign-in',failed:'failed',unconfirmed:'unconfirmed',unavailable:'unavailable'}});
  const result=editing.remove(chartId(1),new AbortController().signal);
  if(kind==='refused')await assert.rejects(result,{code:'invalid_request'});
  else assert.equal((await result).kind,kind==='unknown'?'unknown':'deleted');
  assert.deepEqual(reports,['chart_delete',kind==='refused'?'request':kind==='unknown'?'outcome_unknown':'success']);
  assert.deepEqual(deleted,kind==='deleted' || kind==='absent'?[chartId(1)]:[]);
  assert.equal(f.writes(),1);assert.equal(f.opens(),0);
 }
});

test('editing chooses the existing local form path for a guest or temporary edit, but never for an expired personal library',async()=>{
 for(const kind of ['guest','temporary','expired'] as const){
  const f=fixture();if(kind!=='temporary')f.switch(null);
  const previous=kind==='temporary'?{...accountChart(),id:'temporary',createdAt:'',updatedAt:''}:undefined;
  const editing=createChartEditing({actions:f.actions,ready:async()=>{},session:()=>kind==='temporary'?access:null,
   accountId:()=>kind==='expired'?'1':null,temporaryId:()=>previous?.id??null,
   durable:()=>true,online:()=>true,deleted(){},messages:{signIn:'sign-in',failed:'failed',unconfirmed:'unconfirmed',unavailable:'unavailable'}});
  const result=editing.submit({name:'A',note:'draft',...(previous?{previous}:{})},new AbortController().signal);
  result?.catch(()=>{});
  if(kind==='expired')await assert.rejects(result!,{code:'account_changed'});else assert.equal(result,null,kind);
  assert.equal(f.writes(),0);
 }
});


test('a failed outcome read keeps the unknown source bound to its original command',async()=>{
 const h=readySaveFixture();h.login();h.fail(new TypeError('lost reply'));
 const source={kind:'temporary' as const,chart:h.temporary};
 assert.equal((await h.actions.saveSource(source,options())).kind,'unknown');h.fail(undefined);
 const unavailable=new TypeError('outcome unavailable');h.lookupFail(unavailable);
 await assert.rejects(h.actions.saveSource(source,options()),error=>error===unavailable);
 h.lookupFail(undefined);assert.equal((await h.actions.saveSource(source,options())).kind,'settled');
 assert.deepEqual(h.counts(),{writes:1,reads:2,opens:1});
});

test('an outcome refusal for a restored pointer preserves its cause without clearing another binding',async()=>{
 const h=readySaveFixture();h.login();const refusal=Object.assign(new Error('invalid pointer'),{code:'invalid_request',status:400});
 h.lookupFail(refusal);let cleared=0;
 await assert.rejects(h.actions.saveSource({kind:'temporary',chart:h.temporary},{...options(),
  intent:{operationId:chartId(90),expectedAccountId:'1'},onIntent(){cleared++;}}),error=>error===refusal);
 assert.deepEqual(h.counts(),{writes:0,reads:1,opens:0});assert.equal(cleared,0);
});


const unusedChartClient:Parameters<typeof createChartActions>[0]['client']={
 async create(){assert.fail('unexpected creation');},async update(){assert.fail('unexpected edit');},
 async remove(){assert.fail('unexpected removal');},async addFromSource(){assert.fail('unexpected copy');},
 async outcome(){assert.fail('unexpected recovery');},
};

test('whenIdle waits for a cancelled ready save through late library acceptance',async()=>{
 let response!:()=>void,accept!:()=>void,opens=0,idle=false;
 const replying=new Promise<void>(resolve=>{response=resolve;}),accepting=new Promise<void>(resolve=>{accept=resolve;});
 const chart=accountChart(),controller=new AbortController();
 const actions=createChartActions({getSession:()=>access,
  saveReady:async intent=>{await replying;return {...intent,outcome:{kind:'created',chartId:chart.id,revision:1}};},
  client:unusedChartClient,
  library:{async open(){opens++;await accepting;return chart;},async forget(){}}});
 const work=actions.saveSource({kind:'temporary',chart:{...chart,source:'transit',createdAt:'',updatedAt:''}},options(controller.signal));
 controller.abort();const barrier=actions.whenIdle().then(()=>{idle=true;});
 await new Promise(setImmediate);assert.equal(idle,false);assert.equal(opens,0);
 response();await new Promise(setImmediate);assert.equal(opens,1);assert.equal(idle,false);
 accept();await barrier;const result=await work;
 assert.equal(result.kind==='settled' && result.active,false);assert.equal(idle,true);
});

test('whenIdle retains shared recovery after its final consumer cancels and after clear',async()=>{
 const intent={expectedAccountId:access.accountId,operationId:chartId(99)},chart=accountChart();
 let respond!:()=>void,accept!:()=>void,opens=0,idle=false;
 const response=new Promise<void>(resolve=>{respond=resolve;}),acceptance=new Promise<void>(resolve=>{accept=resolve;});
 const actions=createChartActions({getSession:()=>access,initialPending:[intent],
  client:{...unusedChartClient,async outcome(value){await response;return {...value,outcome:{kind:'created',chartId:chart.id,revision:1}};}},
  library:{async open(){opens++;await acceptance;return chart;},async forget(){}}});
 const first=new AbortController(),second=new AbortController();
 const one=actions.recover(intent,first.signal),two=actions.recover(intent,second.signal);
 const rejected=Promise.all([assert.rejects(one,{name:'AbortError'}),assert.rejects(two,{name:'AbortError'})]);
 first.abort();second.abort();await rejected;
 const barrier=actions.whenIdle().then(()=>{idle=true;});await new Promise(setImmediate);assert.equal(idle,false);
 respond();await new Promise(setImmediate);assert.equal(opens,1);assert.equal(idle,false);
 actions.clear();await new Promise(setImmediate);assert.equal(idle,false,'retiring consumers cannot erase an acceptance already in progress');
 accept();await barrier;assert.equal(idle,true);
});

test('whenIdle ignores unresolved pointers and finishes after a failed active operation',async()=>{
 const f=fixture();f.fail(new Error('lost reply'));await f.actions.create(input);
 await f.actions.whenIdle();assert.equal(f.actions.pending.length,1);
 await f.actions.recover(f.actions.pending[0]!);await f.actions.whenIdle();assert.equal(f.actions.pending.length,1);
 f.fail(Object.assign(new Error('refused'),{status:422,code:'ambiguous_time'}));
 await assert.rejects(f.actions.create(input));await f.actions.whenIdle();
});

test('whenIdle observes a write before its pending-pointer notification can start update preparation',async()=>{
 let finish!:()=>void,idle:Promise<void>|undefined,completed=false;
 const response=new Promise<void>(resolve=>{finish=resolve;});
 const actions=createChartActions({getSession:()=>access,
  client:{...unusedChartClient,async create(value){await response;return {...value,outcome:{kind:'created',chartId:chartId(1),revision:1}};}},
  library:{async open(){return accountChart();},async forget(){}},
  onPending(pending){if(pending.length)idle=actions.whenIdle().then(()=>{completed=true;});}});
 const work=actions.create(input);await new Promise(setImmediate);assert.equal(completed,false);
 finish();await work;await idle;assert.equal(completed,true);
});


test('cancelling whenIdle releases only its waiter and leaves the active write intact',async()=>{
 let finish!:()=>void,opens=0;
 const response=new Promise<void>(resolve=>{finish=resolve;});
 const actions=createChartActions({getSession:()=>access,
  client:{...unusedChartClient,async create(value){await response;return {...value,outcome:{kind:'created',chartId:chartId(1),revision:1}};}},
  library:{async open(){opens++;return accountChart();},async forget(){}}});
 const work=actions.create(input),control=new AbortController();
 const cancelled=assert.rejects(actions.whenIdle(control.signal),{name:'AbortError'});
 assert.equal(getEventListeners(control.signal,'abort').length,1);control.abort();await cancelled;
 assert.equal(getEventListeners(control.signal,'abort').length,0);
 await assert.rejects(actions.whenIdle(control.signal),{name:'AbortError'});
 const next=new AbortController();let idle=false;const barrier=actions.whenIdle(next.signal).then(()=>{idle=true;});
 await new Promise(setImmediate);assert.equal(idle,false);
 finish();await work;await barrier;assert.equal(opens,1);assert.equal(idle,true);
 assert.equal(getEventListeners(next.signal,'abort').length,0);
});


test('whenIdle waits for every active write and recovery, not just the first completion',async()=>{
 let finishWrite!:()=>void,finishRecovery!:()=>void,idle=false;
 const writeGate=new Promise<void>(resolve=>{finishWrite=resolve;}),recoveryGate=new Promise<void>(resolve=>{finishRecovery=resolve;});
 const intent={expectedAccountId:access.accountId,operationId:chartId(90)};
 const actions=createChartActions({getSession:()=>access,client:{...unusedChartClient,
  async create(value){await writeGate;return {...value,outcome:{kind:'created',chartId:chartId(1),revision:1}};},
  async outcome(value){await recoveryGate;return {...value,outcome:{kind:'unknown'}};},
 },library:{async open(){return accountChart();},async forget(){}}});
 const write=actions.create(input),recovery=actions.recover(intent),barrier=actions.whenIdle().then(()=>{idle=true;});
 finishWrite();await write;await new Promise(setImmediate);assert.equal(idle,false);
 finishRecovery();await recovery;await barrier;assert.equal(idle,true);
});
