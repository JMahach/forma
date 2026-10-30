import {IDBFactory} from 'fake-indexeddb';
import {createAccountLibraryStore} from '../src/data/account-library-store.ts';
import {createCyclesClient} from '../src/data/cycles-client.ts';
import {createChartClient} from '../src/data/chart-client.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {IncomingMessage} from 'node:http';
import {openDatabase} from '../server/storage/database.ts';
import {createAccounts,type AccountCredentials} from '../server/services/accounts.ts';
import {createChartRecords} from '../server/services/chart-records.ts';
import {createChartHandler} from '../server/http/charts.ts';
import {captureResponse} from './helpers/http-response.ts';
import {accountNatalChart,accountChart,chartId} from './helpers/account-chart.ts';
import type {CodeMail} from '../server/mail/code-mail.ts';
import {ACCOUNT_POLICY} from '../server/services/account-policy.ts';
import {createChartReturns} from '../server/services/chart-returns.ts';
import {mainReturnRange} from '../shared/chart-return-contract.ts';
import {cycleAge} from '../shared/cycles-format.ts';
import {returnSourceKey,natalDaySourceKey} from '../shared/library-package-contract.ts';
import {createAccountStorage} from '../server/storage/accounts.ts';
import {natalDayFixture} from './fixtures/natal-day.ts';
import {encodeNatalDayPacket} from '../server/services/natal-days.ts';
import {compressDayPacket} from '../server/packets/compression.ts';

async function fixture(t:test.TestContext) {
  const database=openDatabase(':memory:');t.after(()=>database.close());
  const queries:string[]=[],prepare=database.connection.prepare.bind(database.connection);
  database.connection.prepare=sql=>{
    const statement=prepare(sql);
    return new Proxy(statement,{get(target,key){
      const value=Reflect.get(target,key);
      if(['get','all','iterate','run'].includes(String(key)))return (...args:unknown[])=>{queries.push(sql);return value.apply(target,args);};
      return typeof value==='function'?value.bind(target):value;
    }});
  };
  let time=1_000_000,operation=1,nextId=3_000_000_000;
  const mail:CodeMail[]=[];
  const accounts=createAccounts({database,key:Buffer.alloc(32,8),now:()=>time,
    mail:{async enqueue(message){mail.push(message);},async cancel(){}}});
  const proof:AccountCredentials={bindings:{},sessions:{}};
  const start=await accounts.start({email:'owner@example.test',ip:'192.0.2.1',credentials:proof});
  proof.bindings[start.attempt.id]=start.binding.secret;
  proof.sessions[start.attempt.id]=accounts.verify(start.attempt.id,mail[0]!.code,proof).secret;
  const login=accounts.confirm(start.attempt.id,proof),accountId=login.account.id;
  const records=createChartRecords({database,authorize:()=>({accountId}),now:()=>time,newId:()=>String(nextId++)});
  const returns=createChartReturns({cycles:{events:async()=>assert.fail('ready reads must not search dates'),
    chart:async()=>assert.fail('ready reads must not calculate')}});
  const handler=createChartHandler({records,accounts,origins:['https://forma.example.test'],now:()=>time,
    returns,prepareBirth:async()=>assert.fail('catalogue reads must not calculate')});
  async function request(path:string,method='GET',authenticated=true,encoding='identity') {
    const req=Object.assign(Readable.from([]),{method,url:path,headers:{host:'forma.example.test',origin:'https://forma.example.test',
      'accept-encoding':encoding,cookie:authenticated?Object.entries(proof.sessions).map(([id,token])=>`__Host-forma_s_${id}=${token}`).join('; '):''},
      socket:{remoteAddress:'192.0.2.1'}}) as unknown as IncomingMessage;
    const res=captureResponse();await handler(req,res,new URL(path,'https://forma.example.test'));
    return {status:res.status,body:res.headers['Content-Type']==='application/octet-stream'?res.body:JSON.parse(res.body),headers:res.headers};
  }
  const intent=()=>({expectedAccountId:accountId,operationId:chartId(operation++)});
  return {database,accounts,records,accountId,proof,request,intent,session:login.session,queries,setNextId(id:number){nextId=id;},
    url:`/api/charts/catalog?accountId=${accountId}`,advance(ms:number){time+=ms;},now:()=>time,
    add(name='Name'){return records.create({...intent(),content:{...accountNatalChart(),name}}).chartId;}};
}

test('empty, unchanged and forced catalogue reads use one existing session and renew it without card payloads',async t=>{
  const f=await fixture(t),first=await f.request(f.url);
  assert.equal(first.status,200);assert.equal(first.body.kind,'page');assert.deepEqual(first.body.entries,[]);
  const {marker}=first.body;assert.equal(typeof marker,'string');
  f.advance(3_600_000);
  f.queries.length=0;
  const unchanged=await f.request(`${f.url}&knownMarker=${marker}`);
  assert.deepEqual(unchanged.body,{kind:'unchanged',accountId:f.accountId,marker});
  assert.ok(unchanged.headers['Set-Cookie']);
  assert.equal(f.queries.filter(sql=>sql.startsWith('UPDATE account_sessions')).length,1);
  assert.equal(f.queries.filter(sql=>sql.includes('FROM library_catalog_markers')).length,1);
  assert.ok(f.queries.every(sql=>!sql.includes('account_charts') && !sql.includes('account_chart_returns') && !sql.includes('library_natal_days')));
  const session=f.database.connection.prepare('SELECT expiresAt FROM account_sessions WHERE id=?').get(f.session.id);
  assert.equal(session?.expiresAt,f.now()+ACCOUNT_POLICY.sessionMs);
  assert.equal((await f.request(f.url)).body.kind,'page','lost local catalogue can force a complete fetch');
  assert.equal((await f.request(`/api/charts/catalog/confirm?accountId=${f.accountId}&marker=${marker}`)).body.kind,'confirmed');
  assert.equal((await f.request(f.url,'GET',false)).status,401);
  assert.equal((await f.request('/api/charts/catalog?accountId=999')).status,409);
});

test('the real catalogue client reads ordered pages and confirms one marker without fetching calculations',async t=>{
 const f=await fixture(t),ids=[f.add('First'),f.add('Second'),f.add('Third')],paths:string[]=[];
 const client=createChartClient({getSession:()=>({accountId:f.accountId,sessionId:f.session.id}),fetch:async(path)=>{
  paths.push(String(path));const reply=await f.request(String(path));return Response.json(reply.body,{status:reply.status});
 }});
 const first=await client.catalog({expectedAccountId:f.accountId,limit:2});assert.equal(first.kind,'page');if(first.kind!=='page')throw Error('page');
 assert.deepEqual(first.entries.map(row=>row.id),ids.slice(0,2));
 const last=await client.catalog({expectedAccountId:f.accountId,limit:2,marker:first.marker,after:first.nextCursor!});
 assert.equal(last.kind,'page');if(last.kind!=='page')throw Error('page');assert.deepEqual(last.entries.map(row=>row.id),ids.slice(2));
 assert.equal((await client.confirmCatalog({expectedAccountId:f.accountId,marker:first.marker})).kind,'confirmed');
 assert.equal((await client.catalog({expectedAccountId:f.accountId,knownMarker:first.marker})).kind,'unchanged');
 assert.equal(paths.length,4);assert.ok(paths.every(path=>path.startsWith('/api/charts/catalog')));
 f.records.remove({...f.intent(),chartId:ids[0]!});
 assert.equal((await client.confirmCatalog({expectedAccountId:f.accountId,marker:first.marker})).kind,'restart');
});

test('a confirmed HTTP walk joins the local catalogue; repeated server changes never remove local cards',async t=>{
 const {readCompleteLibraryCatalog}=await import('../src/state/library-reconciliation.ts');
 const f=await fixture(t),ids=[f.add('First'),f.add('Second'),f.add('Third')];let requests=0,change:'page'|'confirm'|null=null;
 const client=createChartClient({getSession:()=>({accountId:f.accountId,sessionId:f.session.id}),fetch:async(path)=>{
  requests++;
  if(change==='confirm' && String(path).includes('/confirm?'))f.records.update({...f.intent(),chartId:ids[0]!,name:'Change '+requests});
  const reply=await f.request(String(path));
  if(change==='page' && reply.body.kind==='page')f.records.update({...f.intent(),chartId:ids[0]!,name:'Change '+requests});
  return Response.json(reply.body,{status:reply.status});
 }});
 const local=createAccountLibraryStore({indexedDB:new IDBFactory()});t.after(()=>local.close());
 const active=await local.activate(f.accountId);if(active.status!=='stored')throw Error('owner');
 await local.put(active.lease,ids.map(id=>f.records.getOwn(id)!));
 const base=await local.readCatalog();assert.ok(base);
 const complete=await readCompleteLibraryCatalog(client,f.accountId,null,new AbortController().signal,2);
 assert.equal(complete.status,'complete');if(complete.status!=='complete')throw Error('complete');
 assert.equal((await local.putCatalog(base,complete.catalog)).status,'stored');assert.equal(requests,3);
 const unchanged=await readCompleteLibraryCatalog(client,f.accountId,complete.catalog,new AbortController().signal,2);
 assert.equal(unchanged.status,'unchanged');assert.equal(requests,4);
 f.records.remove({...f.intent(),chartId:ids[2]!});change='page';
 const unstable=await readCompleteLibraryCatalog(client,f.accountId,complete.catalog,new AbortController().signal,1);
 assert.equal(unstable.status,'unstable');assert.equal(requests,8,'two finite attempts: first page then restart, no loop');
 change='confirm';
 assert.equal((await readCompleteLibraryCatalog(client,f.accountId,complete.catalog,new AbortController().signal)).status,'unstable');
 assert.equal(requests,12,'a changed final confirmation also has only two attempts');
 assert.equal((await local.read())!.charts.length,3);assert.deepEqual((await local.readCatalog())?.catalog,complete.catalog);
});

test('catalogue transport rejects foreign or inconsistent metadata and preserves session and abort barriers',async t=>{
 const f=await fixture(t);f.add('First');f.add('Second');let access={accountId:f.accountId,sessionId:f.session.id};
 const original=(await f.request(f.url)).body;
 let reply=structuredClone(original),afterRead=()=>{};
 const client=createChartClient({getSession:()=>access,fetch:async()=>{afterRead();return Response.json(reply);}});
 const bad=[
  {...original,accountId:'999'}, {...original,marker:'01'}, {...original,entries:undefined},
  {...original,entries:[original.entries[0],original.entries[0]]}, {...original,entries:[...original.entries].reverse()},
  {...original,nextCursor:original.entries[0].id}, {...original,kind:'unchanged'},
  ...[
   (row:any)=>{row.source='manual';},
   (row:any)=>{row.birthDate='2000-02-30';},
   (row:any)=>{row.birthTime='24:00';},
   (row:any)=>{row.packages.card.sourceKey='[]';},
   (row:any)=>{row.packages.day.ref.sourceKey=JSON.stringify(['2001-01-01','UTC']);},
   (row:any)=>{row.packages.majorReturns.sourceKey='broken';},
   (row:any)=>{row.packages.majorReturns.readyFamilies=['sun'];},
  ].map(alter=>{const value=structuredClone(original);alter(value.entries[0]);return value;}),
 ];
 for(const [index,value] of bad.entries()){reply=value;await assert.rejects(client.catalog({expectedAccountId:f.accountId}),{code:'invalid_response'},'invalid catalogue '+index);}
 reply={...original,kind:'confirmed',marker:'999'};
 await assert.rejects(client.confirmCatalog({expectedAccountId:f.accountId,marker:original.marker}),{code:'invalid_response'});
 reply=structuredClone(original);reply.entries[0].note='must not cross light boundary';reply.entries[0].activations={private:true};
 const valid=await client.catalog({expectedAccountId:f.accountId});assert.equal(valid.kind,'page');
 if(valid.kind==='page'){assert.equal(Object.hasOwn(valid.entries[0]!,'note'),false);assert.equal(Object.hasOwn(valid.entries[0]!,'activations'),false);}
 await assert.rejects(client.catalog({expectedAccountId:f.accountId,marker:'999'}),{code:'invalid_response'});
 afterRead=()=>{access={...access,sessionId:'replacement'};};
 await assert.rejects(client.catalog({expectedAccountId:f.accountId}),{code:'account_changed'});
 const controller=new AbortController();afterRead=()=>controller.abort();
 await assert.rejects(client.catalog({expectedAccountId:f.accountId},controller.signal),{name:'AbortError'});
});

test('only a complete main family advances readiness; whole reads preserve exact UTC and corruption invalidates it',async t=>{
  const f=await fixture(t),content={...accountNatalChart(),utc:'2000-01-01T12:00:00.123456Z'};
  const id=f.records.create({...f.intent(),content}).chartId,birth=f.records.getOwn(id)!;
  const events=['2029-01-01T12:00:00.654321Z','2058-01-01T12:00:00.765432Z'],body='saturn',range=mainReturnRange(birth.utc)!;
  const input={birthUtc:birth.utc,timezone:birth.timezone,body,...range};
  const query={chartId:id,expectedAccountId:f.accountId,birth,input};
  const sourceKey=returnSourceKey({birthUtc:birth.utc,timezone:birth.timezone!});
  const url=`/api/charts/${id}/returns/${body}/package?accountId=${f.accountId}&sourceKey=${encodeURIComponent(sourceKey)}`;
  assert.equal((await f.request(url)).body.kind,'not-ready');
  const local=createAccountLibraryStore({indexedDB:new IDBFactory()});t.after(()=>local.close());
  const active=await local.activate(f.accountId);assert.equal(active.status,'stored');if(active.status!=='stored')throw Error('local account');
  await local.put(active.lease,[birth]);let requests=0;
  const client=createCyclesClient({library:local,returnStorage:null,request:async(url,options)=>{
    requests++;const reply=await f.request(url,options.method);assert.equal(reply.status,200);return reply.body;
  }});t.after(()=>client.close());
  const owner={chartId:id,expectedAccountId:f.accountId,record:birth};
  assert.deepEqual(await client.fetchFamily({...input,timezone:birth.timezone!},owner),{status:'not-ready'});
  const marker=(await f.request(f.url)).body.marker;
  f.records.saveReturn({...query,action:'events'},{range,events:events.map((utc,index)=>({utc,body,id:`${body}:${utc}`,
    age:cycleAge(utc,birth.utc),cycle:index+1,cycleId:`${body}:${index+1}`,pass:1,direction:'direct'}))});
  for(const [index,utc] of events.entries()) {
    f.queries.length=0;
    f.records.saveReturn({...query,action:'chart',input:{...input,eventUtc:utc}},
      {chart:{...accountNatalChart(),source:'calculated',utc,timezone:birth.timezone!,designUtc:'2028-10-10T01:00:00Z',designArcResidualDegrees:1e-9}});
    if(index===0) {
      assert.equal(f.queries.filter(sql=>sql.startsWith('SELECT action,eventUtc,content')).length,0,'partial inventory never decodes the full family');
      assert.equal((await f.request(`${f.url}&knownMarker=${marker}`)).body.kind,'unchanged');
    }
  }
  const catalog=await f.request(`${f.url}&knownMarker=${marker}`);
  assert.equal(catalog.body.kind,'page');assert.deepEqual(catalog.body.entries[0].packages.majorReturns.readyFamilies,['saturn']);
  f.queries.length=0;
  const ready=await f.request(url);assert.equal(ready.status,200);assert.equal(ready.body.kind,'ready');
  assert.equal(f.queries.filter(sql=>sql.startsWith('SELECT * FROM account_charts')).length,1,'one owned source read per whole package');
  assert.equal(f.queries.filter(sql=>sql.startsWith('UPDATE account_sessions')).length,1);
  assert.deepEqual(ready.body.payload.charts.map((value:{chart:{utc:string}})=>value.chart.utc),events);
  const before=f.database.connection.prepare('SELECT total_changes() AS n').get()!.n;
  assert.deepEqual((await f.request(url)).body,ready.body);
  assert.equal(f.database.connection.prepare('SELECT total_changes() AS n').get()!.n,before);
  const prepared=await client.fetchFamily({...input,timezone:birth.timezone!},owner);
  assert.deepEqual(prepared,{status:'stored',payload:ready.body.payload});assert.equal(requests,2,'one not-ready and one ready transfer, no hidden POST');
  assert.deepEqual(await client.fetchFamily({...input,timezone:birth.timezone!},owner),{status:'no-op',payload:ready.body.payload});assert.equal(requests,2,'a durable whole family never repeats HTTP');
  f.database.connection.prepare("UPDATE account_chart_returns SET content=x'00' WHERE chartId=? AND eventUtc=?").run(id,events[1]);
  assert.equal((await f.request(url)).body.kind,'not-ready');
  const invalidated=await f.request(`${f.url}&knownMarker=${catalog.body.marker}`);
  assert.equal(invalidated.body.kind,'page');assert.deepEqual(invalidated.body.entries[0].packages.majorReturns.readyFamilies,[]);
});

test('one shared natal completion advances every referenced account exactly once, and invalidation does the same',async t=>{
  const f=await fixture(t);f.add('A');f.add('B');
  const otherId=String(createAccountStorage(f.database).ensureAccount('other@example.test').id);
  const other=f.records.withAuthorization(()=>({accountId:otherId}));
  other.create({operationId:chartId(900),expectedAccountId:otherId,content:accountNatalChart()});
  const first=(await f.request(f.url)).body,second=other.catalog({expectedAccountId:otherId});
  const day=natalDayFixture({date:'2000-01-01',samples:10});
  const packet={bytes:await compressDayPacket(await encodeNatalDayPacket({...day,columns:day.columns.map(column=>Array.from(column))}),{quality:9})};
  f.records.packages.putDay({date:day.date,timezone:day.timezone},packet);
  const fresh=(await f.request(f.url)).body,freshOther=other.catalog({expectedAccountId:otherId});
  assert.equal(BigInt(fresh.marker),BigInt(first.marker)+1n);assert.equal(BigInt(freshOther.marker),BigInt(second.marker)+1n);
  assert.ok(fresh.entries.every((entry:{packages:{day:{ready:boolean}}})=>entry.packages.day.ready));
  f.database.connection.exec("UPDATE library_natal_days SET br=x'00'");
  assert.equal(f.records.packages.readDay({date:day.date,timezone:day.timezone}),null);
  assert.equal(BigInt((await f.request(f.url)).body.marker),BigInt(fresh.marker)+1n);
  assert.equal(BigInt(other.catalog({expectedAccountId:otherId}).marker),BigInt(freshOther.marker)+1n);
});

test('catalogue pages contain row metadata and exact package sources, and a changed marker restarts the walk',async t=>{
  const f=await fixture(t),id=f.add('First');f.add('Second');
  const first=await f.request(`${f.url}&limit=1`);assert.equal(first.body.kind,'page');
  const row=first.body.entries[0];assert.ok(row.id);assert.ok(first.body.nextCursor);
  assert.equal(row.packages.card.sourceKey,JSON.stringify([row.id,row.revision]));
  assert.equal(row.packages.day.ref.sourceKey,JSON.stringify(['2000-01-01','UTC']));
  assert.equal(row.packages.day.ready,false);assert.deepEqual(row.packages.majorReturns.readyFamilies,[]);
  for(const key of ['note','activations','personality','design','events'])assert.equal(Object.hasOwn(row,key),false);
  f.records.update({...f.intent(),chartId:id,name:'Changed'});
  const next=await f.request(`${f.url}&marker=${first.body.marker}&after=${first.body.nextCursor}`);
  assert.equal(next.body.kind,'restart');assert.equal(next.body.entries,undefined);
  const confirmation=await f.request(`/api/charts/catalog/confirm?accountId=${f.accountId}&marker=${first.body.marker}`);
  assert.equal(confirmation.body.kind,'restart');
});

function emptyFamily(f:Awaited<ReturnType<typeof fixture>>,id:string,body='saturn') {
  const birth=f.records.getOwn(id)!,range=mainReturnRange(birth.utc)!;
  const query={chartId:id,expectedAccountId:f.accountId,birth,action:'events' as const,
    input:{birthUtc:birth.utc,timezone:birth.timezone,body,...range}};
  const result={range,events:[]};f.records.saveReturn(query,result);return {query,result};
}
const confirmPath=(accountId:string,marker:string)=>`/api/charts/catalog/confirm?accountId=${accountId}&marker=${marker}`;

test('a complete walk is bounded and ordered; insert behind the cursor, delete and readiness each force restart',async t=>{
  const f=await fixture(t),ids=[f.add('A'),f.add('B'),f.add('C'),f.add('D'),f.add('E')],seen:string[]=[];
  let page=await f.request(`${f.url}&limit=2`),marker=page.body.marker;
  for(;;) {
    assert.equal(page.body.kind,'page');assert.equal(page.body.marker,marker);assert.equal(page.body.entries.length,Math.min(2,ids.length-seen.length));
    seen.push(...page.body.entries.map((entry:{id:string})=>entry.id));
    if(!page.body.nextCursor)break;
    page=await f.request(`${f.url}&limit=2&marker=${marker}&after=${page.body.nextCursor}`);
  }
  assert.deepEqual(seen,ids);assert.equal((await f.request(confirmPath(f.accountId,marker))).body.kind,'confirmed');
  for(const change of [()=>{f.setNextId(1_000_000_000);f.add('Behind cursor');},
    ()=>f.records.remove({...f.intent(),chartId:ids[2]!}),()=>emptyFamily(f,ids[0]!)]) {
    const first=(await f.request(`${f.url}&limit=1`)).body;marker=first.marker;change();
    const next=(await f.request(`${f.url}&limit=1&marker=${marker}&after=${first.nextCursor}`)).body;
    assert.equal(next.kind,'restart');assert.equal(next.entries,undefined);
    assert.equal((await f.request(confirmPath(f.accountId,marker))).body.kind,'restart');
  }
});

test('empty confirmed families are ready; no-op writes and rolled-back work leave catalogue state unchanged',async t=>{
  const f=await fixture(t),id=f.add(),initial=(await f.request(f.url)).body.marker;
  const {query,result}=emptyFamily(f,id),ready=(await f.request(f.url)).body;
  assert.deepEqual(ready.entries[0].packages.majorReturns.readyFamilies,['saturn']);
  const sourceKey=ready.entries[0].packages.majorReturns.sourceKey;
  const url=`/api/charts/${id}/returns/saturn/package?accountId=${f.accountId}&sourceKey=${encodeURIComponent(sourceKey)}`;
  assert.deepEqual((await f.request(url)).body.payload.charts,[]);
  f.records.saveReturn(query,result);f.records.update({...f.intent(),chartId:id,name:'Name'});
  assert.equal((await f.request(`${f.url}&knownMarker=${ready.marker}`)).body.kind,'unchanged');
  assert.throws(()=>f.database.transaction(()=>{emptyFamily(f,id,'chiron');f.add('Rollback');throw Error('rollback');}),/rollback/);
  assert.equal((await f.request(`${f.url}&knownMarker=${ready.marker}`)).body.kind,'unchanged');
  f.records.update({...f.intent(),chartId:id,note:{seenRevision:1,value:'New private note'}});
  const edited=(await f.request(f.url)).body;
  assert.notEqual(edited.marker,ready.marker);assert.notEqual(edited.entries[0].packages.card.sourceKey,ready.entries[0].packages.card.sourceKey);
  assert.equal(edited.entries[0].packages.majorReturns.sourceKey,sourceKey);
  f.records.update({...f.intent(),chartId:id,birth:{...accountNatalChart(),utc:'2000-01-02T12:00:00Z',birthDate:'2000-01-02'}});
  assert.deepEqual((await f.request(f.url)).body.entries[0].packages.majorReturns.readyFamilies,[]);
  assert.equal((await f.request(url)).status,409);
  f.records.remove({...f.intent(),chartId:id});assert.deepEqual((await f.request(f.url)).body.entries,[]);
  assert.notEqual((await f.request(f.url)).body.marker,initial);
  assert.equal(f.database.connection.prepare('SELECT count(*) AS n FROM library_ready_families').get()!.n,0);
  assert.equal((await f.request(url)).status,404);
});

test('migration checks legacy prepared families once; reconstruction reads ready metadata without decoding packages',async t=>{
  const f=await fixture(t),id=f.add();emptyFamily(f,id);
  f.database.connection.exec("DELETE FROM library_ready_families; DELETE FROM chart_storage_migrations WHERE name='library_catalog_readiness'");
  const recreate=()=>createChartRecords({database:f.database,authorize:()=>({accountId:f.accountId}),now:f.now});
  const migrated=recreate();assert.deepEqual(migrated.catalog({expectedAccountId:f.accountId}).kind,'page');
  assert.equal(f.database.connection.prepare('SELECT count(*) AS n FROM library_ready_families').get()!.n,1);
  f.queries.length=0;const reopened=recreate();
  assert.equal(f.queries.filter(sql=>sql.includes('SELECT') && (sql.includes('FROM account_charts') || sql.includes('FROM account_chart_returns'))).length,0);
  const catalog=reopened.catalog({expectedAccountId:f.accountId});assert.equal(catalog.kind,'page');
  if(catalog.kind==='page')assert.deepEqual(catalog.entries[0]!.packages.majorReturns?.readyFamilies,['saturn']);
});

test('transit entries have no natal packages and another account cannot read owner packages or confirm its marker',async t=>{
  const f=await fixture(t),id=f.add(),sourceKey=returnSourceKey({birthUtc:accountNatalChart().utc,timezone:'UTC'});
  const path=`/api/charts/${id}/returns/saturn/package?accountId=${f.accountId}&sourceKey=${encodeURIComponent(sourceKey)}`;
  assert.equal((await f.request(path,'GET',false)).status,401);
  assert.equal((await f.request(path.replace(`accountId=${f.accountId}`,'accountId=999'))).status,409);
  const otherId=String(createAccountStorage(f.database).ensureAccount('other@example.test').id);
  const foreign=f.records.withAuthorization(()=>({accountId:otherId}));
  const other=foreign.create({expectedAccountId:otherId,operationId:chartId(900),content:accountNatalChart()});
  assert.equal((await f.request(path.replace(id,other.chartId))).status,404);
  f.records.create({...f.intent(),content:{...accountChart(),name:'Transit'}});
  const catalog=(await f.request(f.url)).body;
  assert.deepEqual(catalog.entries.find((row:{source:string})=>row.source==='transit').packages,
    {card:{kind:'card',sourceKey:JSON.stringify(['3000000002',1])},day:null,majorReturns:null});
  f.database.connection.prepare('DELETE FROM account_sessions WHERE id=?').run(f.session.id);
  for(const url of [f.url,confirmPath(f.accountId,catalog.marker),path]) {
    const response=await f.request(url);assert.equal(response.status,401);assert.equal(response.headers['Set-Cookie'],undefined);
  }
});

test('catalogue and package HTTP reject ambiguous parameters and unsupported methods before touching account state',async t=>{
  const f=await fixture(t),id=f.add();
  const confirm=confirmPath(f.accountId,'0'),family=`/api/charts/${id}/returns/saturn/package?accountId=${f.accountId}&sourceKey=x`;
  const bad=[`${f.url}&knownMarker=00`,`${f.url}&marker=-1`,`${f.url}&marker=9223372036854775808`,
    `${f.url}&knownMarker=0&marker=0`,`${f.url}&after=${id}`,`${f.url}&after=bad&marker=0`,
    `${f.url}&limit=0`,`${f.url}&limit=101`,`${f.url}&limit=1.5`,`${f.url}&limit=NaN`,
    `${f.url}&unknown=1`,`${f.url}&accountId=${f.accountId}`,`${confirm}&marker=0`,
    `/api/charts/catalog/confirm?accountId=${f.accountId}`,`${family}&fromAge=1`,`${family}&sourceKey=y`,
    family.replace('saturn/package','moon/package'),family.replace('sourceKey=x','sourceKey='),family.replace(`accountId=${f.accountId}`,'accountId=bad'),family.replace(id,'bad')];
  f.queries.length=0;
  for(const url of bad)assert.equal((await f.request(url)).status,400,url);
  assert.equal(f.queries.length,0,'invalid requests do not renew a session or read storage');
  for(const url of [f.url,confirm,family])for(const method of ['HEAD','POST','PATCH','DELETE','OPTIONS']) {
    const response=await f.request(url,method);assert.equal(response.status,405);assert.equal(response.headers.Allow,'GET');
  }
  assert.equal(f.queries.length,0);
});


test('catalogue markers and complete-family descriptors survive a database close and reopen without number rounding',t=>{
  const directory=mkdtempSync(path.join(tmpdir(),'forma-catalog-')),file=path.join(directory,'library.sqlite');
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let database=openDatabase(file);t.after(()=>database.close());
  const accountId=String(createAccountStorage(database).ensureAccount('owner@example.test').id);
  let records=createChartRecords({database,authorize:()=>({accountId})});
  const outcome=records.create({expectedAccountId:accountId,operationId:chartId(1),content:accountNatalChart()});
  const birth=records.getOwn(outcome.chartId)!,range=mainReturnRange(birth.utc)!;
  records.saveReturn({chartId:birth.id,expectedAccountId:accountId,birth,action:'events',input:{birthUtc:birth.utc,body:'saturn',...range}},{range,events:[]});
  database.connection.prepare('UPDATE library_catalog_markers SET marker=? WHERE accountId=?').run(9_007_199_254_740_993n,accountId);
  records.update({expectedAccountId:accountId,operationId:chartId(2),chartId:birth.id,name:'Edited'});
  const expected=records.catalog({expectedAccountId:accountId});assert.equal(expected.marker,'9007199254740994');
  database.close();database=openDatabase(file);records=createChartRecords({database,authorize:()=>({accountId})});
  assert.deepEqual(records.catalog({expectedAccountId:accountId}),expected);
  assert.equal(database.connection.prepare('SELECT total_changes() AS n').get()!.n,0);
  assert.equal(records.confirmCatalog(accountId,expected.marker).kind,'confirmed');
});

test('owned ready-day GET returns stored bytes or bounded not-ready, never starts computation',async t=>{
 const f=await fixture(t),id=f.add(),source={date:'2000-01-01',timezone:'UTC'},ref={kind:'day',sourceKey:natalDaySourceKey(source)};
 const path=`/api/charts/${id}/day?`+new URLSearchParams({accountId:f.accountId,sourceKey:ref.sourceKey});
 const pending=await f.request(path);assert.equal(pending.status,202);assert.deepEqual(pending.body,{kind:'not-ready',ref});assert.equal(pending.headers['Retry-After'],'1');
 const transit=f.records.create({...f.intent(),content:accountChart()}).chartId!;
 assert.equal((await f.request(path.replace(id!,transit))).status,400,'a transit record cannot acquire a natal day by matching dates');
 assert.equal((await f.request(path,'POST')).status,405);assert.equal((await f.request(path,'GET',false)).status,401);
 assert.equal((await f.request(path.replace('accountId='+f.accountId,'accountId=999'))).status,409);
 assert.equal((await f.request(path+'&sourceKey=duplicate')).status,400);
 assert.equal((await f.request(path.replace(encodeURIComponent(ref.sourceKey),encodeURIComponent('["2001-01-01","UTC"]')))).status,409);
 const day=natalDayFixture({...source,samples:10}),packet={bytes:await compressDayPacket(await encodeNatalDayPacket({...day,columns:day.columns.map(column=>Array.from(column))}),{quality:9})};
 f.records.packages.putDay(source,packet);f.queries.length=0;
 for(const encoding of ['identity','br','gzip'] as const){
  const ready=await f.request(path,'GET',true,encoding);assert.equal(ready.status,200);
  assert.deepEqual(ready.body,packet.bytes[encoding]);assert.equal(ready.headers['Content-Encoding'],encoding==='identity'?undefined:encoding);assert.ok(ready.headers['Set-Cookie']);
 }
 assert.ok(!f.queries.some(sql=>/INSERT INTO library_preparation|INSERT INTO account_chart_returns|INSERT INTO library_natal_days/.test(sql)));
 assert.equal((await f.request(path,'GET',true,'identity;q=0, br;q=0, gzip;q=0')).status,406);
 f.database.connection.exec("UPDATE library_natal_days SET br=x'00'");assert.equal((await f.request(path)).status,202);
 f.records.remove({...f.intent(),chartId:id!});assert.equal((await f.request(path)).status,404);
});

test('ready-day transport keeps binary packets separate from placement and rejects late foreign sessions',async t=>{
 const f=await fixture(t),id=f.add()!,source={date:'2000-01-01',timezone:'UTC'},ref={kind:'day' as const,sourceKey:natalDaySourceKey(source)};
 let access={accountId:f.accountId,sessionId:f.session.id},after=()=>{},calls=0;
 const client=createChartClient({getSession:()=>access,fetch:async(path,options)=>{
  assert.equal(options?.method,'GET');calls++;const reply=await f.request(String(path));after();
  return reply.headers['Content-Type']==='application/octet-stream'?new Response(reply.body,{status:reply.status}):Response.json(reply.body,{status:reply.status,headers:reply.headers as HeadersInit});
 }});
 assert.equal(typeof client.readyDay,'function');
 const input={chartId:id,expectedAccountId:f.accountId,ref};
 assert.deepEqual(await client.readyDay(input),{kind:'not-ready',ref,retryAfterMs:1000});
 const day=natalDayFixture({...source,samples:10}),packet={bytes:await compressDayPacket(await encodeNatalDayPacket({...day,columns:day.columns.map(column=>Array.from(column))}))};
 f.records.packages.putDay(source,packet);
 const ready=await client.readyDay(input);assert.equal(ready.kind,'ready');if(ready.kind==='ready')assert.deepEqual(Buffer.from(ready.payload),packet.bytes.identity);
 after=()=>{access={...access,sessionId:'new'};};await assert.rejects(client.readyDay(input),{code:'account_changed'});
 after=()=>{};const stopped=new AbortController();stopped.abort();const previous=calls;
 await assert.rejects(client.readyDay(input,stopped.signal),{name:'AbortError'});assert.equal(calls,previous);
});

test('ready-day transport rejects malformed readiness instead of treating it as a valid wait',async()=>{
 const ref={kind:'day' as const,sourceKey:'["2000-01-01","UTC"]'},input={chartId:chartId(1),expectedAccountId:'1',ref};
 let body:unknown={kind:'not-ready',ref},calls=0;
 const client=createChartClient({getSession:()=>({accountId:'1',sessionId:'s'}),fetch:async()=>{calls++;return Response.json(body,{status:202});}});
 for(const bad of [null,{kind:'ready',ref},{kind:'not-ready',ref:null},{kind:'not-ready',ref:{...ref,kind:'major-returns'}},{kind:'not-ready',ref:{...ref,sourceKey:'different'}}]){
  body=bad;await assert.rejects(client.readyDay(input),{code:'invalid_response'});
 }
 const prior=calls;
 for(const bad of [{...ref,kind:'major-returns'},{...ref,sourceKey:''}])await assert.rejects(client.readyDay({...input,ref:bad as never}),{code:'invalid_request'});
 assert.equal(calls,prior,'invalid address cannot start HTTP');
});
