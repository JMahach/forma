import test from 'node:test';
import assert from 'node:assert/strict';
import {createCyclesClient} from '../src/data/cycles-client.ts';
import {createReturnsController} from '../src/state/returns.ts';
import {createReturnReceipts} from '../server/services/return-receipt.ts';
import {accountNatalChart} from './helpers/account-chart.ts';

const version='a'.repeat(64),range={fromAge:0,toAge:36525/365.2425};
const input={birthUtc:'2000-01-01T12:00:00Z',body:'saturn',timezone:'UTC',...range};
const event={body:'saturn',utc:'2029-01-01T12:00:00Z',id:'saturn:2029-01-01T12:00:00Z',age:10593/365.2425,cycle:1,pass:1,cycleId:'saturn:1',direction:'direct' as const};
const exact={...input,eventUtc:event.utc};
const raw={chart:{...accountNatalChart(),source:'calculated' as const,utc:event.utc,timezone:'UTC',designUtc:'2028-10-10T01:00:00Z',designArcResidualDegrees:1e-9}};
const receipts=createReturnReceipts({key:new Uint8Array(32).fill(17),cyclesVersion:version});
const full={...raw,proof:receipts.issue('chart',exact,raw)!};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('adopting a restored ready signed chart must attach it even without a cached events list',async t=>{
  const sent:string[]=[],client=createCyclesClient({cacheVersion:version,returnStorage:null,request:async url=>{
    sent.push(url);if(url.endsWith('/accept'))return {accepted:true};
    if(url.endsWith('/chart'))return full;
    throw Object.assign(Error('events unavailable'),{code:'server_unavailable'});
  }});t.after(()=>client.close());
  await client.chart(exact,undefined,{event});
  const temporary={...accountNatalChart(),id:'temporary'},saved={...accountNatalChart(),id:'saved'};
  const control=createReturnsController({client,getOwner:chart=>chart.id==='saved'?{chartId:'saved',expectedAccountId:'1'}:null});
  await control.select(temporary);
  assert.equal(await control.restore({opened:true,bodies:['saturn'],year:null,eventId:event.id}),true);
  assert.equal(control.current!.utc,event.utc);
  assert.equal(control.adopt(saved),true);await tick();await tick();
  assert.equal(control.current!.utc,event.utc);
  assert.equal(sent.filter(url=>url.endsWith('/accept')).length,1,'signed ready full chart was not attached');
});

for (const method of ['adopt','select'] as const) test(`${method} attaches guest-prepared data when the same chart becomes owned`,async t=>{
  const sent:string[]=[],client=createCyclesClient({cacheVersion:version,returnStorage:null,request:async(url,{body})=>{
    sent.push(url);if(url.endsWith('/accept'))return {accepted:true};
    const request=JSON.parse(String(body));const data={range:{fromAge:request.fromAge,toAge:request.toAge},events:[]};
    return {...data,proof:receipts.issue('events',request,data)!};
  }});t.after(()=>client.close());let signedIn=false;
  const own=accountNatalChart(),control=createReturnsController({client,getOwner:chart=>signedIn?{chartId:chart.id!,expectedAccountId:'1'}:null});
  await control.select(own);signedIn=true;
  await control[method]({...own});await tick();await tick();
  assert.equal(sent.filter(url=>url.endsWith('/accept')).length,5,'same ID hid the change from guest to owner');
  await control[method]({...own});await tick();await tick();
  assert.equal(sent.filter(url=>url.endsWith('/accept')).length,5,'unchanged ownership repeated the attachment');
});
