import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createChartCalculation, ChartCalculationError } from '../server/services/chart-calculation.ts';
import { createCalculator } from '../server/services/calculate.ts';
import { createCityCatalog } from '../server/services/cities.ts';
import type { IncomingMessage } from 'node:http';
import { captureResponse } from './helpers/http-response.ts';
import { openDatabase } from '../server/storage/database.ts';
import { createAccounts, type AccountCredentials } from '../server/services/accounts.ts';
import type { CodeMail } from '../server/mail/code-mail.ts';
import { createChartRecords } from '../server/services/chart-records.ts';
import { createChartHandler } from '../server/http/charts.ts';
import type { AccountChartBirth } from '../shared/chart-record-contract.ts';

import { createChartClient } from '../src/data/chart-client.ts';
import { createChartActions } from '../src/state/chart-actions.ts';
import { createViewStore } from '../src/data/view-store.ts';
import { accountChart } from './helpers/account-chart.ts';

const op = (n:number) => n.toString(16).padStart(32,'0');
const birth: AccountChartBirth = {source:'transit', birthDate:'2000-01-01', birthTime:'12:00', birthPlace:'',
  utc:'2000-01-01T12:00:32.789Z', activations:{personality:[],design:[]},
  personality:[], design:[], };
async function fixture(t:{after(fn:()=>void):void}, prepareBirth?: ReturnType<typeof createChartCalculation>, extra: Partial<Parameters<typeof createChartHandler>[0]> = {}) {
  const database=openDatabase(':memory:'); t.after(()=>database.close());
  let time=1_000_000, calls=0, beforePrepare=async()=>{};
  const mail:CodeMail[]=[];
  const accounts=createAccounts({database,key:Buffer.alloc(32,3),now:()=>time,
    mail:{async enqueue(value){mail.push(value);},async cancel(){}}});
  const proof:AccountCredentials={bindings:{},sessions:{}};
  const start=await accounts.start({email:'person@example.test',ip:'192.0.2.1',credentials:proof});
  proof.bindings[start.attempt.id]=start.binding.secret;
  const grant=accounts.verify(start.attempt.id,mail[0]!.code,proof);
  proof.sessions[start.attempt.id]=grant.secret;
  const login=accounts.confirm(start.attempt.id,proof);
  const records=createChartRecords({database,authorize:()=>null,now:()=>time});
  let handler=createChartHandler({records,accounts,origins:['https://forma.example.test'],now:()=>time,...extra,
    prepareBirth:async (input, options)=>{calls++; await beforePrepare(); if(options.signal.aborted) throw new Error('aborted'); return prepareBirth ? prepareBirth(input,options) : {...birth};}});
  async function request(path:string, method='GET', body?:unknown, options:{cookie?:boolean;origin?:string|null;headers?:Record<string,string>;rawBody?:string}={}) {
    const req=Object.assign(Readable.from(options.rawBody!==undefined?[Buffer.from(options.rawBody)]:body===undefined?[]:[Buffer.from(JSON.stringify(body))]),{method,url:path,
      headers:{host:'forma.example.test','content-type':'application/json',
        ...(options.origin===null?{}:{origin:options.origin??'https://forma.example.test'}),
        cookie:options.cookie===false?'':Object.entries(proof.sessions).map(([id,token])=>`__Host-forma_s_${id}=${token}`).join('; '),...options.headers},
      socket:{remoteAddress:'192.0.2.1'}}) as unknown as IncomingMessage;
    const res=captureResponse(); await handler(req,res,new URL(path,'https://forma.example.test'));
    return {status:res.status,body:JSON.parse(res.body),headers:res.headers};
  }
  const intent=(n=1)=>({operationId:op(n),expectedAccountId:login.account.id});
  const create=(n=1)=>request('/api/charts','POST',{...intent(n),name:'Транзит',note:'private',birth:{source:'transit',utc:birth.utc}});
  return {request,intent,create,records,accounts,proof,database,useHandler(next:typeof handler){handler=next;},id:login.session.id,accountId:login.account.id,
    calls:()=>calls,beforePrepare(fn:()=>Promise<void>){beforePrepare=fn;},advance(ms:number){time+=ms;}};
}
test('HTTP separates public card data, private library and read-only operation recovery',async t=>{
  const f=await fixture(t),created=await f.create(); assert.equal(created.status,200);
  const id=created.body.chartId;
  f.database.connection.prepare("UPDATE account_charts SET content=json_remove(content,'$.calculationVersion') WHERE id=?").run(id);
  const storedBefore=f.database.connection.prepare('SELECT * FROM account_charts WHERE id=?').get(id);
  const own=await f.request(`/api/charts/${id}?accountId=${f.accountId}`);
  assert.equal(own.body.chart.note,'private');
  const shared=await f.request(`/api/shared-charts/${id}`,'GET',undefined,{cookie:false});
  assert.equal(shared.status,200); assert.equal(shared.body.chart.note,undefined);
  assert.equal(shared.body.chart.accountId,undefined);
  const page=await f.request(`/api/charts?accountId=${f.accountId}&limit=1`);
  assert.equal(page.body.charts.length,1); assert.equal(page.body.nextCursor,null);
  assert.equal(f.calls(),1,'reading ready data cannot invoke the calculator');
  assert.deepEqual(f.database.connection.prepare('SELECT * FROM account_charts WHERE id=?').get(id),storedBefore);
  for(const value of [own.body.chart,shared.body.chart,page.body,page.body.charts[0]]) {
    assert.equal(Object.hasOwn(value,'calculationVersion'),false);
    assert.equal(Object.hasOwn(value,'calculationCurrent'),false);
  }
  assert.equal((await f.request(`/api/charts?accountId=${f.accountId}`,'GET',undefined,{cookie:false})).status,401);
  const deleted=await f.request(`/api/charts/${id}`,'DELETE',f.intent(2)); assert.equal(deleted.body.kind,'deleted');
  const receipt=await f.request(`/api/charts/operations/${op(1)}?accountId=${f.accountId}`);
  const {chart:projection,catalogMarker:_createdMarker,...fact}=created.body;
  assert.equal(projection.id,id);
  assert.deepEqual(receipt.body,{...fact,catalogMarker:deleted.body.catalogMarker}); assert.equal(f.calls(),1);
  f.advance(48*60*60*1000);
  assert.deepEqual((await f.request(`/api/charts/operations/${op(1)}?accountId=${f.accountId}`)).body,{kind:'unknown',catalogMarker:deleted.body.catalogMarker});
});
test('known operation outcome skips recalculation, and text-only updates preserve the exact birth block',async t=>{
  const f=await fixture(t), first=await f.create();
  assert.deepEqual((await f.create()).body,first.body); assert.equal(f.calls(),1);
  const updated=await f.request('/api/charts/'+first.body.chartId,'PATCH',{...f.intent(2),name:'Новое имя',note:{value:'new',seenRevision:1}});
  assert.equal(updated.status,200); assert.equal(f.calls(),1);
  const own=await f.request(`/api/charts/${first.body.chartId}?accountId=${f.accountId}`);
  assert.equal(own.body.chart.utc,birth.utc); assert.equal(own.body.chart.note,'new');
});
test('private current-state envelopes carry the observed catalog marker without changing durable outcomes',async t=>{
  const f=await fixture(t),created=await f.create(),id=created.body.chartId;
  const marker=()=>String(f.database.connection.prepare('SELECT CAST(marker AS TEXT) AS m FROM library_catalog_markers WHERE accountId=?').get(f.accountId)!.m);
  const receipt=()=>JSON.parse(String(f.database.connection.prepare('SELECT outcome FROM chart_operation_outcomes WHERE accountId=? AND operationId=?').get(f.accountId,op(1))!.outcome));
  const original=receipt();assert.equal(created.body.catalogMarker,marker());
  assert.equal(Object.hasOwn(created.body.chart,'catalogMarker'),false);
  assert.equal(Object.hasOwn(original,'catalogMarker'),false);
  const updated=await f.request('/api/charts/'+id,'PATCH',{...f.intent(2),name:'Changed'});
  assert.equal(updated.body.catalogMarker,marker());
  const recovered=await f.request(`/api/charts/operations/${op(1)}?accountId=${f.accountId}`);
  assert.equal(recovered.body.revision,original.revision);assert.equal(recovered.body.chart.revision,updated.body.revision);
  assert.equal(recovered.body.catalogMarker,marker());assert.deepEqual(receipt(),original);
  f.database.connection.prepare('UPDATE library_catalog_markers SET marker=? WHERE accountId=?').run(9007199254740993n,f.accountId);
  const own=await f.request(`/api/charts/${id}?accountId=${f.accountId}`);
  assert.equal(own.body.catalogMarker,'9007199254740993');
  assert.equal(Object.hasOwn((await f.request('/api/shared-charts/'+id)).body,'catalogMarker'),false);
  for(const [n,kind] of [[3,'deleted'],[4,'absent']] as const){
    const result=await f.request('/api/charts/'+id,'DELETE',f.intent(n));
    assert.equal(result.body.kind,kind);assert.equal(result.body.catalogMarker,marker());
  }
  const missing=await f.request(`/api/charts/${id}?accountId=${f.accountId}`);
  assert.equal(missing.status,404);assert.deepEqual(missing.body,{error:'not_found',catalogMarker:marker()});
  const rejected=await f.request('/api/charts/'+id,'PATCH',{...f.intent(5),name:'Gone'});
  assert.equal(rejected.body.kind,'rejected');assert.equal(rejected.body.code,'not_found');assert.equal(rejected.body.catalogMarker,marker());
  const afterDelete=await f.request(`/api/charts/operations/${op(1)}?accountId=${f.accountId}`);
  assert.deepEqual(afterDelete.body,{...original,catalogMarker:marker()});assert.deepEqual(receipt(),original);
  const unknown=await f.request(`/api/charts/operations/${op(999)}?accountId=${f.accountId}`);
  assert.deepEqual(unknown.body,{kind:'unknown',catalogMarker:marker()});
  for(const path of [`/api/charts/${id}?accountId=999`,`/api/charts/operations/${op(1)}?accountId=999`])
    assert.deepEqual((await f.request(path)).body,{error:'account_changed'});
  assert.equal(f.calls(),1,'observation and recovery never calculate');
});
test('a completed outcome survives revoked access or an unreadable current projection without leaking its marker',async t=>{
  const f=await fixture(t),created=await f.create(),id=created.body.chartId;
  const fact={kind:created.body.kind,chartId:id,revision:created.body.revision},current=f.accounts.current.bind(f.accounts);
  let checks=0;t.mock.method(f.accounts,'current',(...args:Parameters<typeof current>)=>++checks===1?current(...args):null);
  const revoked=await f.request(`/api/charts/operations/${op(1)}?accountId=${f.accountId}`);
  assert.equal(revoked.status,200);assert.deepEqual(revoked.body,fact);
  t.mock.restoreAll();
  const authorize=f.records.withAuthorization;
  t.mock.method(f.records,'withAuthorization',(...args:Parameters<typeof authorize>)=>new Proxy(authorize(...args),{
    get(target,key){if(key==='getOwn' || key==='observeOutcome')return ()=>{throw Error('projection unavailable');};return Reflect.get(target,key);}
  }));
  const unreadable=await f.request(`/api/charts/operations/${op(1)}?accountId=${f.accountId}`);
  assert.equal(unreadable.status,200);assert.deepEqual(unreadable.body,fact);
});
test('read-only current-session observation validates access without extending its expiry',async t=>{
  const f=await fixture(t),expiry=()=>f.database.connection.prepare('SELECT expiresAt FROM account_sessions WHERE id=?').get(f.id)!.expiresAt;
  await f.create();
  const before=expiry();f.advance(1000);
  assert.equal(f.accounts.current(f.proof,{renew:false})?.account.id,f.accountId);assert.equal(expiry(),before);
  assert.equal(f.accounts.current(f.proof)?.account.id,f.accountId);assert.notEqual(expiry(),before);
  const current=f.accounts.current.bind(f.accounts);let checks=0,firstExpiry:unknown;
  t.mock.method(f.accounts,'current',(...args:Parameters<typeof current>)=>{
    if(++checks===2)f.advance(1000);
    const value=current(...args);if(checks===1)firstExpiry=expiry();return value;
  });
  assert.equal((await f.request(`/api/charts/operations/${op(1)}?accountId=${f.accountId}`)).status,200);
  assert.equal(checks,2);assert.equal(expiry(),firstExpiry,'the later observation cannot add a second session write');
  t.mock.restoreAll();
  f.database.connection.prepare('DELETE FROM account_sessions WHERE id=?').run(f.id);
  assert.equal(f.accounts.current(f.proof,{renew:false}),null);
});
test('origin and account identity are checked before calculation, and logout during calculation prevents the write',async t=>{
  const f=await fixture(t),body={...f.intent(),name:'Транзит',note:'',birth:{source:'transit',utc:birth.utc}};
  for(const origin of [null,'http://forma.example.test']) assert.equal((await f.request('/api/charts','POST',body,{origin})).status,403);
  assert.equal((await f.request('/api/charts','POST',body,{cookie:false})).status,401);
  assert.equal((await f.request('/api/charts','POST',{...body,expectedAccountId:'999'})).status,409);
  assert.equal(f.calls(),0);
  f.beforePrepare(()=>f.accounts.logout(f.id,f.proof));
  assert.equal((await f.create()).status,401);
  assert.equal(f.records.getPublic('missing'),null);
});
test('HTTP rejects supplied computed fields and invalid pagination without writing',async t=>{
  const f=await fixture(t);
  for(const extra of [{activations:{}},{revision:2},{id:'chosen'},{accountId:'999'}]) {
    assert.equal((await f.request('/api/charts','POST',{...f.intent(),name:'A',note:'',birth:{source:'transit',utc:birth.utc},...extra})).status,400);
  }
  for(const query of ['limit=0','limit=1000','limit=2.5','after='+('x'.repeat(90))])
    assert.equal((await f.request('/api/charts?accountId='+f.accountId+'&'+query)).status,400);
  assert.equal(f.calls(),0);
});

test('real Python calculation passes through HTTP into SQLite and exact transit survives a read',async t=>{
  const calculate=createCalculator({root:fileURLToPath(new URL('../',import.meta.url))});
  t.after(()=>calculate.close());
  const cities=createCityCatalog([{id:'1',name:'Test City',aliases:['Test City'],country:'Test',region:'',
    timezone:'UTC',latitude:0,longitude:0}]);
  const f=await fixture(t,createChartCalculation({calculate,cities}));
  const created=await f.request('/api/charts','POST',{...f.intent(),name:'Person',note:'private',
    birth:{source:'calculated',date:'2000-01-01',time:'12:00',cityId:'1'}});
  assert.equal(created.status,200,JSON.stringify(created.body));
  const own=await f.request('/api/charts/'+created.body.chartId+'?accountId='+f.accountId);
  assert.equal(own.body.chart.activations.personality.length,13);
  assert.equal(own.body.chart.activations.design.length,13);
  assert.equal(own.body.chart.name,'Person');assert.equal(Object.hasOwn(own.body.chart,'calculationVersion'),false);
  const transit=await f.create(2); assert.equal(transit.status,200,JSON.stringify(transit.body));
  const shared=await f.request('/api/shared-charts/'+transit.body.chartId,'GET',undefined,{cookie:false});
  assert.equal(shared.body.chart.utc,birth.utc);assert.equal(shared.body.chart.activations.design.length,13);
});

test('a late preparation refusal returns an outcome already committed by the same operation',async t=>{
  const f=await fixture(t);let count=0,release!:()=>void;
  const delayed=new Promise<void>(resolve=>{release=resolve;});
  f.beforePrepare(async()=>{if(++count===2){await delayed;throw new ChartCalculationError('invalid_time');}});
  const first=f.create(),second=f.create();
  const success=await first;assert.equal(success.status,200);
  release();
  const late=await second;assert.equal(late.status,200);assert.deepEqual(late.body,success.body);
});

test('the main router forwards chart paths and never falls back to HTML when storage is absent',async()=>{
  const {createRequestHandler}=await import('../server/http/app.ts');
  const base={root:'/unused',cities:createCityCatalog([]),calculate:async()=>{throw new Error('unused');},
    publicFiles:()=>{throw new Error('Chart route must not serve HTML');}};
  const handle=createRequestHandler({...base,chartHandler:async(_req,res,url)=>{
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({path:url.pathname}));
  }});
  for(const path of ['/api/charts','/api/charts/'+op(1),'/api/charts/operations/'+op(1),'/api/shared-charts/'+op(1)]) {
    const req={method:'GET',url:path,headers:{}} as IncomingMessage,res=captureResponse();
    await handle(req,res);assert.equal(res.status,200);assert.equal(JSON.parse(res.body).path,path);
    const absent=captureResponse();await createRequestHandler(base)(req,absent);
    assert.equal(absent.status,503);assert.equal(JSON.parse(absent.body).error,'chart_unavailable');
  }
});


test('real calculate response can be saved with its signature without a second Python computation',async t=>{
  const {createCalculationReceipts}=await import('../server/services/calculation-receipt.ts');
  const {createRequestHandler}=await import('../server/http/app.ts');
  const root=fileURLToPath(new URL('../',import.meta.url)),calculator=createCalculator({root});t.after(()=>calculator.close());
  const cities=createCityCatalog([]),receipts=createCalculationReceipts({key:Buffer.alloc(32,5)});
  let calculations=0;
  const calculate:typeof calculator=Object.assign((...args:Parameters<typeof calculator>)=>{calculations++;return calculator(...args);},{close:calculator.close});
  const prepare=createChartCalculation({cities,calculate,receipts});
  const f=await fixture(t,prepare);
  const router=createRequestHandler({root,cities,calculate,issueCalculationReceipt:receipts.issue});
  const req=Object.assign(Readable.from([Buffer.from(JSON.stringify({mode:'transit',utc:birth.utc}))]),{
    method:'POST',url:'/api/calculate',headers:{host:'forma.example.test',origin:'https://forma.example.test','content-type':'application/json'},
    socket:{remoteAddress:'192.0.2.1'},
  }) as unknown as IncomingMessage;
  const res=captureResponse();await router(req,res);assert.equal(res.status,200);
  const ready=JSON.parse(res.body).chart;assert.ok(ready.calculationReceipt);assert.equal(calculations,1);
  const saved=await f.request('/api/charts','POST',{...f.intent(90),name:'Ready result',note:'Private',
    birth:{source:'transit',utc:birth.utc},calculationReceipt:ready.calculationReceipt});
  assert.equal(saved.status,200);assert.equal(saved.body.kind,'created');assert.equal(calculations,1);
  const own=await f.request('/api/charts/'+saved.body.chartId+'?accountId='+f.accountId);
  assert.equal(own.body.chart.utc,ready.utc);assert.deepEqual(own.body.chart.personality,ready.personality);
  assert.equal(Object.hasOwn(own.body.chart,'calculationReceipt'),false);
});

test('concurrent private and public reads return ready numbers without preparation or private-field sharing',async t=>{
  const f=await fixture(t),created=await f.create(),id=created.body.chartId as string,before=f.calls();
  f.beforePrepare(async()=>{throw Error('no preparation during a read');});
  const results=await Promise.all(Array.from({length:8},(_,index)=>f.request(index%2
    ? `/api/charts/${id}?accountId=${f.accountId}` : `/api/shared-charts/${id}`,'GET',undefined,{cookie:index%2===1})));
  for(let index=0;index<results.length;index++) {
    assert.equal(results[index]!.status,200);
    assert.equal(results[index]!.body.chart.utc,birth.utc);
    assert.equal(results[index]!.body.chart.note,index%2?'private':undefined);
  }
  assert.equal(f.calls()-before,0,'eight reads perform no numerical preparation');
});

test('owned returns HTTP uses chart authorization and the common origin boundary', async t => {
  let calls=0;
  const returns: NonNullable<Parameters<typeof createChartHandler>[0]['returns']>={readPackage(){throw new Error('unused');},events:async (access, id, expectedAccountId, input, {signal})=>{
    const chart=access.getOwn(id,expectedAccountId);
    assert.ok(chart);assert.equal(signal.aborted,false);calls++;
    return {events:[],range:{fromAge:input.fromAge ?? 0,toAge:input.toAge ?? 100}};
  },chart:async()=>{throw new Error('unused');},accept:async()=>{throw new Error('unused');}};
  const f=await fixture(t,undefined,{returns});
  const saved=await f.create(),path='/api/charts/'+saved.body.chartId+'/returns/events';
  const input={expectedAccountId:f.accountId,birthUtc:birth.utc,timezone:'UTC',body:'saturn',fromAge:0,toAge:100};
  const response=await f.request(path,'POST',input);
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.deepEqual(response.body,{events:[],range:{fromAge:0,toAge:100}});
  assert.equal((await f.request(path,'GET')).status,405);
  assert.equal((await f.request(path,'POST',input,{cookie:false})).status,401);
  assert.equal((await f.request(path,'POST',{...input,expectedAccountId:'999'})).status,409);
  assert.equal((await f.request(path,'POST',input,{origin:null})).status,403);
  assert.equal((await f.request(path,'POST',{...input,activations:{}})).status,400);
  assert.equal(calls,1);
});


test('runtime joins private HTTP and durable main return records across reconstruction', async t => {
  const [{createChartRuntime},{accountNatalChart},{mainReturnRange},{cycleAge},{chartAtMinute},{natalDayFixture}] = await Promise.all([
    import('../server/charts.ts'), import('./helpers/account-chart.ts'), import('../shared/chart-return-contract.ts'),
    import('../shared/cycles-format.ts'), import('../src/domain/natal-day.ts'), import('./fixtures/natal-day.ts')]);
  const f=await fixture(t),content=accountNatalChart();
  const saved=f.records.withAuthorization(()=>({accountId:f.accountId})).create({...f.intent(),content});
  assert.equal(saved.kind,'created');
  const range=mainReturnRange(content.utc!)!,utc='2028-07-21T12:36:00.000Z';
  const event={id:'saturn:'+utc,body:'saturn',utc,age:cycleAge(utc,content.utc),cycle:1,pass:1,cycleId:'saturn:1',direction:'direct' as const};
  const result={chart:{...chartAtMinute(natalDayFixture({date:'2028-07-21'}),756),utc}};
  let dateCalls=0,chartCalls=0;
  const cycles={events:async()=>{dateCalls++;return {events:[event],range};},
    chart:async()=>{chartCalls++;return result;}};
  const calculate=createCalculator({root:fileURLToPath(new URL('../',import.meta.url))});t.after(()=>calculate.close());
  const connect=()=>f.useHandler(createChartRuntime({database:f.database,accounts:f.accounts,cities:createCityCatalog([]),
    calculate,cycles,origins:['https://forma.example.test']}).handler);
  const path='/api/charts/'+saved.chartId+'/returns/',base={expectedAccountId:f.accountId,birthUtc:content.utc,timezone:content.timezone,body:'saturn'};
  connect();
  const dates=await f.request(path+'events','POST',{...base,...range});assert.equal(dates.status,200,JSON.stringify(dates.body));
  const exact=await f.request(path+'chart','POST',{...base,eventUtc:utc});assert.equal(exact.status,200,JSON.stringify(exact.body));
  connect();
  assert.deepEqual((await f.request(path+'events','POST',{...base,...range})).body,dates.body);
  assert.deepEqual((await f.request(path+'chart','POST',{...base,eventUtc:utc})).body,exact.body);
  assert.equal(dateCalls,1);assert.equal(chartCalls,1);
  assert.equal((await f.request(path+'chart','POST',{...base,eventUtc:utc},{cookie:false})).status,401);
});


test('owned return transport needs no calculation marker and preserves queue refusal', async t => {
  const {CycleError}=await import('../server/services/cycles.ts');
  let calls=0;
  const returns: NonNullable<Parameters<typeof createChartHandler>[0]['returns']>={readPackage(){throw new Error('unused');},
    async events(){calls++;throw new CycleError('busy','Busy',503,2);},
    async chart(){throw new Error('unused');},async accept(){throw new Error('unused');},
  };
  const f=await fixture(t,undefined,{returns}),saved=await f.create();
  const path='/api/charts/'+saved.body.chartId+'/returns/events';
  const input={expectedAccountId:f.accountId,birthUtc:birth.utc,body:'saturn',fromAge:0,toAge:100};
  const busy=await f.request(path,'POST',input);
  assert.equal(busy.status,503);assert.equal(busy.body.error,'busy');assert.equal(busy.headers['Retry-After'],'2');assert.equal(calls,1);
});


test('HTTP accepts a proven prepared return without calculating it again', async t => {
  let accepted=0;
  const returns: NonNullable<Parameters<typeof createChartHandler>[0]['returns']>={readPackage(){throw new Error('unused');},
    async events(){throw new Error('must not calculate');},async chart(){throw new Error('must not calculate');},
    async accept(access,id,expectedAccountId,packet,{signal}){
      assert.ok(access.getOwn(id,expectedAccountId));assert.equal(signal.aborted,false);
      assert.equal(packet.action,'events');assert.equal(packet.proof,'proof');accepted++;return {accepted:true};
    },
  };
  const f=await fixture(t,undefined,{returns}),saved=await f.create();
  const path='/api/charts/'+saved.body.chartId+'/returns/accept';
  const body={expectedAccountId:f.accountId,action:'events',input:{birthUtc:birth.utc,body:'saturn',fromAge:0,toAge:100},result:{events:[],range:{fromAge:0,toAge:100}},proof:'proof'};
  const result=await f.request(path,'POST',body);assert.equal(result.status,200,JSON.stringify(result.body));assert.deepEqual(result.body,{accepted:true});
  assert.equal((await f.request(path,'POST',body,{cookie:false})).status,401);
  assert.equal((await f.request(path,'POST',{...body,extra:'unaccepted'})).status,400);
  assert.equal(accepted,1);
  const encoded=JSON.stringify(body),atLimit=encoded+' '.repeat(65536-Buffer.byteLength(encoded));
  assert.equal((await f.request(path,'POST',undefined,{rawBody:atLimit})).status,200,'a valid JSON packet at 64 KiB is accepted');
  const oversized=await f.request(path,'POST',undefined,{rawBody:atLimit+' '});
  assert.equal(oversized.status,413);assert.equal(oversized.body.error,'too_large');
  assert.equal(accepted,2,'oversized input never reaches the prepared-data owner');
});


test('prepared returns survive HTTP and device reload, attach to the saved card, and reopen without calculation', async t => {
  const [{createChartRuntime},{createCyclesHandler},{createCyclesClient},{createReturnStorage},{IDBFactory},
    {accountNatalChart},{mainReturnRange},{cycleAge},{chartAtMinute},{natalDayFixture}] = await Promise.all([
    import('../server/charts.ts'),import('../server/http/cycles.ts'),import('../src/data/cycles-client.ts'),
    import('../src/data/return-storage.ts'),import('fake-indexeddb'),import('./helpers/account-chart.ts'),
    import('../shared/chart-return-contract.ts'),import('../shared/cycles-format.ts'),
    import('../src/domain/natal-day.ts'),import('./fixtures/natal-day.ts')]);
  const f=await fixture(t),content=accountNatalChart(),key=new Uint8Array(32).fill(19);
  const range=mainReturnRange(content.utc!)!,utc='2028-07-21T12:36:00.000Z';
  const event={id:'saturn:'+utc,body:'saturn',utc,age:cycleAge(utc,content.utc),cycle:1,pass:1,cycleId:'saturn:1',direction:'direct' as const};
  const exact={chart:{...chartAtMinute(natalDayFixture({date:'2028-07-21'}),756),utc}};
  let dateCalls=0,chartCalls=0;
  const cycles={events:async()=>{dateCalls++;return {events:[event],range};},
    chart:async()=>{chartCalls++;return exact;}};
  const calculate=createCalculator({root:fileURLToPath(new URL('../',import.meta.url))});t.after(()=>calculate.close());
  const connect=()=>{
    const runtime=createChartRuntime({database:f.database,accounts:f.accounts,cities:createCityCatalog([]),
      calculate,cycles,origins:['https://forma.example.test'],key});
    const general=createCyclesHandler(cycles,{issueReceipt:runtime.issueReturnReceipt});
    f.useHandler((req,res,url)=>url.pathname.startsWith('/api/cycles/')?general(req,res,url):runtime.handler(req,res,url));
  };
  connect();
  const requests:string[]=[],request=async(url:string,options:RequestInit)=>{
    requests.push(url);
    const reply=await f.request(url,'POST',JSON.parse(String(options.body)));
    assert.equal(reply.status,200,JSON.stringify(reply.body));return reply.body;
  };
  const indexedDB=new IDBFactory(),device=createReturnStorage({indexedDB});t.after(()=>device.close());
  const pendingWrites:Promise<unknown>[]=[];
  const storage={...device,putEvents:(...args:Parameters<typeof device.putEvents>)=>{
    const promise=device.putEvents(...args);pendingWrites.push(promise);return promise;
  },putChart:(...args:Parameters<typeof device.putChart>)=>{
    const promise=device.putChart(...args);pendingWrites.push(promise);return promise;
  }};
  const input={birthUtc:content.utc,body:'saturn',timezone:content.timezone,...range};
  const chartInput={birthUtc:content.utc,body:'saturn',timezone:content.timezone,eventUtc:utc};
  const first=createCyclesClient({returnStorage:storage,request});t.after(()=>first.close());
  await first.events(input);await first.chart(chartInput,undefined,{event});
  await new Promise(setImmediate);await Promise.all(pendingWrites);first.close();device.close();
  const restoredDevice=createReturnStorage({indexedDB});t.after(()=>restoredDevice.close());
  const restored=createCyclesClient({returnStorage:restoredDevice,request});t.after(()=>restored.close());
  const saved=f.records.withAuthorization(()=>({accountId:f.accountId})).create({...f.intent(),content});
  assert.equal(saved.kind,'created');assert.ok('chartId' in saved);
  const owner={chartId:saved.chartId,expectedAccountId:f.accountId};
  await restored.syncPrepared(input,owner);
  assert.deepEqual(requests,['/api/cycles/events','/api/cycles/chart',
    `/api/charts/${saved.chartId}/returns/accept`,`/api/charts/${saved.chartId}/returns/accept`]);
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS count FROM account_chart_returns').get()!.count,2);
  connect();
  const fresh=createCyclesClient({returnStorage:null,request});t.after(()=>fresh.close());
  assert.equal((await fresh.events(input,undefined,{owner})).events[0]!.utc,utc);
  assert.equal((await fresh.chart(chartInput,undefined,{owner,event})).chart.utc,utc);
  assert.equal(dateCalls,1);assert.equal(chartCalls,1);
});

for (const committed of [false, true]) test(`lost save response survives reload and recovers through HTTP without another write (committed=${committed})`, async t => {
  const f = await fixture(t, async () => accountChart());
  const access = {accountId: f.accountId, sessionId: f.id};
  const storage = new Map<string, string>();
  const getStorage = () => ({getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {storage.set(key, value);}});
  let connected = true, loseResponse = true, writes = 0;
  const requests: {method: string; path: string}[] = [];
  const client = createChartClient({getSession: () => access, fetch: async (path, options = {}) => {
    if (!connected) throw new TypeError('offline');
    const method = options.method ?? 'GET';
    requests.push({method, path: String(path)});
    if (method !== 'GET') writes++;
    if (loseResponse && method !== 'GET' && !committed) {
      connected = false;
      throw new TypeError('connection lost before server received the write');
    }
    const result = await f.request(String(path), method, options.body ? JSON.parse(String(options.body)) : undefined);
    if (loseResponse && method !== 'GET') {
      assert.equal(result.status, 200, 'the database accepted the write before its reply was lost');
      connected = false;
      throw new TypeError('reply lost after commit');
    }
    return Response.json(result.body, {status: result.status});
  }});
  const openPage = () => {
    const view = createViewStore({getStorage});
    const saved = view.read();
    return {view, actions: createChartActions({client, getSession: () => access,
      library: {open: async id => (await client.own({chartId:id,expectedAccountId:access.accountId})).chart, async forget() {}},
      async calculate() {throw new Error('recovery must never calculate');}, newId: () => op(701),
      initialPending: saved?.pendingChartWrites,
      onPending: pendingChartWrites => {assert.equal(view.write({...saved, version: 1, pendingChartWrites}), true);},
    })};
  };
  const original = openPage();
  const result = await original.actions.create({name: 'Проверка потерянного ответа', note: 'Не повторять запись',
    birth: {source: 'transit', utc: birth.utc!}});
  assert.equal(result.kind, 'unknown'); assert.equal(writes, 1);
  const pointer = {operationId: op(701), expectedAccountId: access.accountId};
  assert.deepEqual(original.view.read()?.pendingChartWrites, [pointer]);
  const reloaded = openPage();
  assert.deepEqual(reloaded.actions.pending, [pointer]);
  await assert.rejects(reloaded.actions.recover(pointer));
  assert.equal(writes, 1, 'offline restoration cannot re-send the save');
  const beforeRecovery = requests.length;
  connected = true; loseResponse = false;
  const recovered = await reloaded.actions.recover(pointer);
  assert.equal(recovered.kind, committed ? 'settled' : 'unknown');
  if (recovered.kind === 'settled') {
    assert.equal(recovered.active, true); assert.equal(recovered.readError, undefined);
    assert.equal(recovered.chart?.name, 'Проверка потерянного ответа');
    assert.equal(recovered.chart?.note, 'Не повторять запись');
  }
  assert.deepEqual(reloaded.view.read()?.pendingChartWrites, committed ? [] : [pointer]);
  assert.ok(requests.slice(beforeRecovery).every(request => request.method === 'GET'));
  assert.ok(requests[beforeRecovery].path.includes('/operations/'));
  const secondReload = openPage();
  for (const pending of secondReload.actions.pending) await secondReload.actions.recover(pending);
  assert.equal(writes, 1, 'subsequent reload and online outcome checks must never write');
  const library = await f.request(`/api/charts?accountId=${access.accountId}`);
  assert.equal(library.body.charts.length, committed ? 1 : 0);
  assert.equal(f.calls(), committed ? 1 : 0, 'recovery never repeats a calculation');
});
