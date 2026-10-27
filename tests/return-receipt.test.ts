import test from 'node:test';
import assert from 'node:assert/strict';
import {createReturnReceipts} from '../server/services/return-receipt.ts';
import {createReturnStorage} from '../src/data/return-storage.ts';
import {IDBFactory} from 'fake-indexeddb';
import {accountNatalChart} from './helpers/account-chart.ts';
import type {CycleEventsResult,CycleChartResult} from '../shared/cycles-format.ts';
const key=new Uint8Array(32).fill(17),cyclesVersion='a'.repeat(64);
const input={birthUtc:'2000-01-01T12:00:00Z',body:'saturn',fromAge:0,toAge:36525/365.2425,
  eventUtc:'2029-01-01T12:00:00.123456Z',timezone:'UTC'};
const raw:CycleEventsResult={range:{fromAge:input.fromAge,toAge:input.toAge},events:[{
  body:'saturn',utc:input.eventUtc,id:`saturn:${input.eventUtc}`,age:29.002648929041426,
  cycle:1,pass:1,cycleId:'saturn:1',direction:'direct',
}]};
const result:CycleChartResult={chart:{...accountNatalChart(),source:'calculated',utc:input.eventUtc,timezone:'UTC',
  designUtc:'2028-10-10T01:00:00.123456Z',designArcResidualDegrees:1e-9}};

test('a compact proof accepts normalized trusted numbers and rejects altered input, numbers, key and action',()=>{
  const owner=createReturnReceipts({key,cyclesVersion}),proof=owner.issue('chart',input,result);
  assert.equal(typeof proof,'string');assert.ok(proof!.length<200);
  assert.equal((owner.read('chart',input,result,proof) as CycleChartResult).chart.utc,input.eventUtc);
  const altered=structuredClone(result);altered.chart.activations.personality[0]!.longitude+=1;
  for(const [request,value] of [[{...input,body:'uranus'},result],[{...input,birthUtc:'2000-01-02T12:00:00Z'},result],
    [{...input,eventUtc:'2029-01-01T12:00:00.223456Z'},result],[input,altered]] as const) {
    assert.throws(()=>owner.read('chart',request,value,proof),TypeError);
  }
  assert.throws(()=>owner.read('events',input,raw,proof),TypeError);
  assert.throws(()=>createReturnReceipts({key:new Uint8Array(32).fill(18),cyclesVersion}).read('chart',input,result,proof),TypeError);
});

test('proof survives event compression and restored derived metadata, including floating-point age',async()=>{
  const owner=createReturnReceipts({key,cyclesVersion}),proof=owner.issue('events',input,raw);
  assert.equal(typeof proof,'string');
  const storage=createReturnStorage({indexedDB:new IDBFactory()});
  const cacheKey=JSON.stringify(['events',cyclesVersion,input.birthUtc,input.body,input.fromAge,input.toAge]);
  try {
    await storage.putEvents(cacheKey,input,raw);
    const restored=await storage.getEvents(cacheKey);assert.ok(restored);
    assert.equal((owner.read('events',input,restored,proof) as CycleEventsResult).events[0]!.utc,input.eventUtc);
  } finally {storage.close();}
});

test('receipt acceptance strips personal and display-only fields instead of trusting them',()=>{
  const owner=createReturnReceipts({key,cyclesVersion});
  const decorated={...result,proof:'ignored',event:{cycle:999},chart:{...result.chart,note:'secret',name:'fake',id:'fake',createdAt:'fake'}};
  const proof=owner.issue('chart',input,decorated)!;
  const restored=owner.read('chart',input,{...decorated,chart:{...decorated.chart,note:'different',name:'different'}},proof) as CycleChartResult;
  for(const field of ['note','name','id','createdAt'])assert.equal(field in restored.chart,false);
  assert.equal('event' in restored,false);assert.equal('proof' in restored,false);
});

test('key order and omitted defaults do not change proof; old versions never become current data',()=>{
  const owner=createReturnReceipts({key,cyclesVersion}),proof=owner.issue('chart',input,result)!;
  const chart=Object.fromEntries(Object.entries(result.chart).reverse());
  assert.ok(owner.read('chart',{body:input.body,eventUtc:input.eventUtc,birthUtc:input.birthUtc},{chart},proof));
  assert.equal(createReturnReceipts({key,cyclesVersion:'b'.repeat(64)}).read('chart',input,result,proof),null);
  for(const invalid of [null,'v1.bad','x'.repeat(1000),proof.slice(0,-1)+'!'])assert.throws(()=>owner.read('chart',input,result,invalid),TypeError);
});

test('non-main, arbitrary-range, out-of-lifetime and malformed results cannot get a reusable proof',()=>{
  const owner=createReturnReceipts({key,cyclesVersion});
  assert.equal(owner.issue('events',{...input,body:'sun'},raw),undefined);
  assert.equal(owner.issue('events',{...input,fromAge:1},{...raw,range:{fromAge:1,toAge:input.toAge}}),undefined);
  assert.equal(owner.issue('chart',{...input,eventUtc:'2101-01-01T12:00:00Z'},{chart:{...result.chart,utc:'2101-01-01T12:00:00Z'}}),undefined);
  assert.equal(owner.issue('chart',input,{chart:{...result.chart,designUtc:'not a date'}}),undefined);
  assert.throws(()=>createReturnReceipts({key:new Uint8Array(2),cyclesVersion}),TypeError);
});
