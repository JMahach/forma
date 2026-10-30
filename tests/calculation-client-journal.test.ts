import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createJournal } from '../src/journal.ts';
import { createCalculationClients } from '../src/data/calculation-clients.ts';
import { createReturnsController } from './fixtures/returns.ts';
import { createMomentTimeline } from './fixtures/lifetime.ts';
import { libraryRecordAtMinute,natalDayFixture,personalChartFixture } from './fixtures/natal-day.ts';
import { CYCLE_BODIES, DEFAULT_CYCLE_BODIES } from '../src/domain/cycles.ts';
import { LIFETIME_PLANETS } from '../shared/lifetime-format.ts';
import type { ClientReport } from '../shared/client-report-contract.ts';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(check:()=>boolean,attempts=150){for(let i=0;i<attempts;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('Expected diagnostic was not delivered');}
async function journalFixture(t:test.TestContext){
 const reports:ClientReport[]=[];
 const journal=createJournal({appVersion:'test-1',environment:'stand',indexedDB:new IDBFactory(),connection:()=> 'online',
  send:async body=>{reports.push(...body.reports);return {schemaVersion:1,results:body.reports.map(r=>({eventId:r.eventId,status:'accepted',receivedAt:1,duplicate:false}))};}});
 t.after(()=>journal.close());await journal.wake();return {journal,reports,observe:journal.begin};
}
const natal=()=>libraryRecordAtMinute(natalDayFixture({date:'2000-01-01'}),0,personalChartFixture({id:'saved-natal',name:'Private name'}));
const metadata={engine:'test',startUtc:'1801-01-01T00:00:00Z',endExclusiveUtc:'2400-01-01T00:00:00Z',stepSeconds:600,
 samples:(Date.parse('2400-01-01')-Date.parse('1801-01-01'))/600000,planets:[...LIFETIME_PLANETS]};

test('local window failure reaches the journal without a version request',async t=>{
 const h=await journalFixture(t);
 const clients=createCalculationClients({cacheOptions:{indexedDB:null},observe:h.observe});t.after(()=>clients.close());
 assert.deepEqual(await clients.syncTransitWindow({dates:['2026-09-30'],expiresAt:Date.now()+86400000}),{status:'unavailable'});
 await until(()=>h.reports.length===1);
 assert.deepEqual(h.reports.map(r=>[r.action,r.component,r.stage,r.reason]),[['data_read','storage','commit','storage_unavailable']]);
});

test('one return search failure is reported for its bodies, while repeated reads add no duplicates',async t=>{
 const h=await journalFixture(t);let calls=0;
 const control=createReturnsController({observe:h.observe,client:{events:async()=>{calls++;throw Object.assign(new Error('private birth'),{code:'server_unavailable'});}}});
 await control.select(natal());await control.open();await control.setYear(2028);await control.open();
 await until(()=>h.reports.length===1);assert.ok(calls>1);assert.equal(h.reports[0]!.component,'cycles');assert.equal(h.reports[0]!.reason,'server_unavailable');
 assert.doesNotMatch(JSON.stringify(h.reports),/private birth|Private name|2000-01-01/);
});

test('lifetime automatic retries keep one observation and do not report preparation as a failure',async t=>{
 const h=await journalFixture(t);let calls=0;
 const explorer=createMomentTimeline({observe:h.observe,client:{getMeta:async()=>{calls++;throw Object.assign(new Error('private response'),{code:'connection_failed'});}}});t.after(()=>explorer.close());
 await explorer.open();await until(()=>h.reports.length===1);
 await until(()=>calls===2,750);await explorer.retry();await tick();assert.equal(calls,3);assert.equal(h.reports.length,1);
 explorer.close();
 const preparing=createMomentTimeline({observe:h.observe,client:{getMeta:async()=>{throw Object.assign(new Error('preparing'),{code:'lifetime_preparing'});}}});t.after(()=>preparing.close());
 await preparing.open();await tick();assert.equal(h.reports.length,1);assert.equal(preparing.state.status,'preparing');
});

test('coalesced lifetime movement discards a superseded failure and records only the final target failure',async t=>{
 const h=await journalFixture(t);const pending:{reject:(reason:unknown)=>void}[]=[];
 const explorer=createMomentTimeline({observe:h.observe,client:{getMeta:async()=>metadata,
  getPoint:()=>new Promise((_resolve,reject)=>pending.push({reject}))}});t.after(()=>explorer.close());
 await explorer.open();const work=explorer.setDateRange('2000-01-01','2001-01-01');await until(()=>pending.length===1);
 void explorer.scrub(Date.parse('2000-07-01T00:00:00Z'));
 pending[0]!.reject(Object.assign(new Error('old'),{code:'server_error'}));await until(()=>pending.length===2);
 assert.equal(h.reports.length,0);
 pending[1]!.reject(Object.assign(new Error('final'),{code:'invalid_response'}));await work;
 await until(()=>h.reports.length===1);assert.equal(h.reports[0]!.reason,'invalid_response');
});


test('return restoration keeps an observation until all new bodies settle, without delaying its chosen event',async t=>{
 const h=await journalFixture(t),extra=CYCLE_BODIES.find(body=>!DEFAULT_CYCLE_BODIES.includes(body.id))!.id;
 let rejectExtra:(reason:unknown)=>void=()=>{throw new Error('extra body was not requested');};
 const control=createReturnsController({observe:h.observe,client:{events:async input=>{
  if(input.body===extra)return new Promise((_resolve,reject)=>{rejectExtra=reject;});return {events:[]};
 }}});await control.select(natal());
 assert.equal(await control.restore({opened:true,bodies:[extra],year:null,eventId:`${DEFAULT_CYCLE_BODIES[0]}:2001-01-01T00:00:00Z`}),true);
 assert.equal(h.reports.length,0);
 rejectExtra(Object.assign(new Error('hidden body failed'),{code:'server_error'}));
 await until(()=>h.reports.length===1);assert.equal(h.reports[0]!.reason,'server_error');
});

test('abandoned return requests do not report late failures for a new selection',async t=>{
 const h=await journalFixture(t),rejects:((reason:unknown)=>void)[]=[];
 const control=createReturnsController({observe:h.observe,client:{events:()=>new Promise((_resolve,reject)=>rejects.push(reject))}});
 const work=control.select(natal());await tick();control.select(null);
 for(const reject of rejects)reject(Object.assign(new Error('old owner'),{code:'server_error'}));
 await work;await tick();assert.equal(h.reports.length,0);
});
