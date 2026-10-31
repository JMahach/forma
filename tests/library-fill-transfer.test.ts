import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {createActor} from 'xstate';
import {createAccountLibraryStore} from '../src/data/account-library-store.ts';
import {createChartClient} from '../src/data/chart-client.ts';
import {createCyclesClient} from '../src/data/cycles-client.ts';
import {createLibraryFillTransfer} from '../src/data/library-fill-transfer.ts';
import {createLibraryFill} from '../src/application/library-fill.ts';
import {accountNatalChart} from './helpers/account-chart.ts';
import {natalDayFixture} from './fixtures/natal-day.ts';
import {encodeNatalDay} from '../server/packets/encode.ts';
import {cardSourceKey,natalDaySourceKey,returnSourceKey} from '../shared/library-package-contract.ts';
import {mainReturnRange} from '../shared/chart-return-contract.ts';
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('the real clients, account store and fill owner restore two cards, one shared day and one complete family without POST or repeated writes',async t=>{
 const store=createAccountLibraryStore({indexedDB:new IDBFactory()});t.after(()=>store.close());const activation=await store.activate('1');if(activation.status!=='stored')throw Error('owner');
 const lease=activation.lease,cards=[accountNatalChart(),accountNatalChart(2)],chart=cards[0],source={birthUtc:chart.utc,timezone:chart.timezone!};
 const ref={kind:'day' as const,sourceKey:natalDaySourceKey({date:chart.birthDate,timezone:chart.timezone!})},familyRef={kind:'major-returns' as const,sourceKey:returnSourceKey(source),family:'saturn' as const};
 const packet={source,family:'saturn' as const,dates:{range:mainReturnRange(chart.utc)!,events:[]},charts:[]};
 const day=encodeNatalDay(natalDayFixture({date:chart.birthDate,samples:10})).slice().buffer,requests:string[]=[],notices:string[]=[];
 const charts=createChartClient({getSession:()=>({accountId:'1',sessionId:'s'}),fetch:async(url,options)=>{
  assert.equal(options?.method,'GET');const path=String(url);requests.push(path);
  return path.includes('/day?')?new Response(day):Response.json({chart:cards.find(card=>path.includes(card.id)),catalogMarker:'1'});
 }});
 const cycles=createCyclesClient({library:store,returnStorage:null,request:async(url,options)=>{
  assert.equal(options?.method,'GET');requests.push(url);return {kind:'ready',ref:familyRef,payload:packet};
 }});t.after(()=>cycles.close());
 const entries=cards.map(card=>({id:card.id,revision:card.revision,name:card.name,birthDate:card.birthDate,birthTime:card.birthTime,source:card.source,
  packages:{card:{kind:'card' as const,sourceKey:cardSourceKey(card)},day:{ref,ready:true},majorReturns:{sourceKey:familyRef.sourceKey,readyFamilies:['saturn' as const]}}}));
 const transfer=createLibraryFillTransfer({store,charts,cycles,lease:()=>lease});let numericPuts=0,controlPuts=0;
 const local:{payloadStoredAt?:number}[]=[];store.subscribeLocal(change=>local.push(change));
 const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,...args){if(['charts','packages'].includes(this.name))numericPuts++;if(this.name==='context' && value.key==='library-fill')controlPuts++;return original.call(this,value,...args);};
 t.after(()=>{IDBObjectStore.prototype.put=original;});
 const actor=createActor(createLibraryFill({...transfer,clock:{now:Date.now,after(ms,run){const t=setTimeout(run,ms);return()=>clearTimeout(t);}},id:()=>crypto.randomUUID(),scope:()=>({lease,sessionId:'s',catalogMarker:'1',visible:true,foreground:false,online:true}),entries:()=>entries,
  control:store.fill,inventory:store.maintenance.inventory,accepted(candidate){notices.push(candidate.key);}})).start();t.after(()=>actor.stop());
 actor.send({type:'FillWake',at:Date.now(),reason:'lifecycle'});
 for(let i=0;notices.length<4 && i<500;i++)await flush();assert.equal(notices.length,4);
 for(let i=0;i<20;i++)await flush();
 assert.equal(requests.length,4);assert.equal(numericPuts,4);assert.equal(controlPuts,8);
 assert.ok(local.every(change=>change.payloadStoredAt===undefined),'background placement must not wake itself after quota');
 const inventory=await store.maintenance.inventory(lease);assert.equal(inventory?.cards.length,2);assert.equal(inventory?.packages.length,2);
 assert.deepEqual(await store.readPackage(lease,ref),day);assert.deepEqual(await store.readPackage(lease,familyRef),packet);
 actor.send({type:'FillWake',at:Date.now()+1,reason:'hourly'});for(let i=0;i<30;i++)await flush();assert.equal(requests.length,4);assert.equal(numericPuts,4);assert.equal(controlPuts,8);
 t.diagnostic('2 cards + shared day + whole family: 4 GET, 0 POST/compute, 4 numeric puts, 8 fill-control puts, 4 notices; next wake adds 0 GET/numeric/control writes.');
});
test('the transfer adapter preserves not-ready replies and rejects changed sources before transport or placement',async t=>{
 const store=createAccountLibraryStore({indexedDB:new IDBFactory()});t.after(()=>store.close());const activation=await store.activate('1');if(activation.status!=='stored')throw Error();
 const lease=activation.lease,chart=accountNatalChart();await store.put(lease,[chart]);let calls=0;
 const ref={kind:'day' as const,sourceKey:natalDaySourceKey({date:chart.birthDate,timezone:chart.timezone!})},familyRef={kind:'major-returns' as const,sourceKey:returnSourceKey({birthUtc:chart.utc,timezone:chart.timezone!}),family:'saturn' as const};
 const charts=createChartClient({getSession:()=>({accountId:'1',sessionId:'s'}),fetch:async()=>{calls++;return Response.json({kind:'not-ready',ref},{status:202,headers:{'Retry-After':'2'}});}});
 const cycles=createCyclesClient({library:store,returnStorage:null,request:async()=>{calls++;return {kind:'not-ready',ref:familyRef};}});t.after(()=>cycles.close());
 const transfer=createLibraryFillTransfer({store,charts,cycles,lease:()=>lease}),candidate={key:'day',chartId:chart.id,revision:1,ref},signal=new AbortController().signal;
 assert.equal((await transfer.receive(candidate,signal)).kind,'not-ready');
 assert.equal((await transfer.receive({...candidate,ref:familyRef},signal)).kind,'not-ready');assert.equal(calls,2);
 await assert.rejects(transfer.receive({...candidate,revision:2},signal),{code:'stale_library'});
 await assert.rejects(transfer.receive({...candidate,ref:{...ref,sourceKey:'wrong'}},signal),{code:'stale_library'});assert.equal(calls,2);
 const authority={signal,permit:{key:'day',kind:'day' as const,chartId:chart.id,revision:1,token:'x',owner:'x',lease,sessionId:'s',startedAt:1,expiresAt:2}};
 assert.equal(await transfer.place(candidate,null,authority),'invalid');
 assert.equal(await transfer.place(candidate,{kind:'card',chart},authority),'invalid');
 assert.equal(await transfer.place(candidate,{kind:'day',chart:{...chart,source:'transit'},payload:new ArrayBuffer(0)},authority),'invalid');
 assert.equal(await transfer.place(candidate,{kind:'day',chart,payload:new ArrayBuffer(0)},{...authority,signal:AbortSignal.abort()}),'stale');
 const empty=createLibraryFillTransfer({store,charts,cycles,lease:()=>null});await assert.rejects(empty.receive(candidate,signal),{name:'AbortError'});
});
