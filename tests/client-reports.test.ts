import test from 'node:test';
import assert from 'node:assert/strict';
import {createClientReports,clientFailureReason} from '../src/diagnostics/client-reports.ts';
import type {ClientReport, ClientReportMetadata} from '../shared/client-report-contract.ts';
function present<T>(value:T|null|undefined):T {assert.ok(value!=null);return value;}
const id=(n:number)=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
function harness(options:Partial<Parameters<typeof createClientReports>[0]>={}) {
  let next=1,clock=10;const sent:ClientReport[]=[];
  const metadata:ClientReportMetadata & {browser:{name:'firefox';version:string}}={environment:'production',appVersion:'test-1',accountId:null,browser:{name:'firefox',version:'120.0'}};
  const adapter=createClientReports({metadata:()=>metadata,enqueue:async report=>{sent.push(report);return true;},now:()=>1700000000000,monotonicNow:()=>clock,newId:()=>id(next++),...options});
  return {adapter,sent,metadata,setClock(value:number){clock=value;}};
}
const action={action:'calculate',component:'calculator'} as const;
const failure={stage:'request',reason:'connection_failed'} as const;

test('begin captures original attribution and metadata; reports expose queue admission separately',async()=>{
  const h=harness(),work=h.adapter.begin(action);work.step({stage:'request',requestId:id(50)});
  h.metadata.accountId='42';h.metadata.appVersion='test-2';h.metadata.browser.version='121.0';h.setClock(25);
  const result=present(await work.reportFailure(failure));assert.equal(result.queued,true);assert.equal(h.sent.length,1);
  assert.equal(result.report.accountId,null);assert.equal(result.report.appVersion,'test-1');assert.equal(result.report.browser!.version,'120.0');assert.equal(result.report.durationMs,15);
  assert.equal(result.report.context![0].requestId,id(50));assert.ok(Object.isFrozen(result.report));
});
test('all actions share ten bounded context steps instead of receiving ten each',async()=>{
  const h=harness(),a=h.adapter.begin(action),b=h.adapter.begin(action);
  for(let i=0;i<6;i++)a.step({stage:'wait',durationMs:i});for(let i=0;i<6;i++)b.step({stage:'response',durationMs:i});
  const first=present(await a.reportFailure(failure)),second=present(await b.reportFailure(failure));
  assert.equal(first.report.context!.length,4);assert.equal(second.report.context!.length,6);
  assert.ok(new TextEncoder().encode(JSON.stringify([...first.report.context!,...second.report.context!])).byteLength<=8000);
});
test('shared explicit episodes enqueue one failure and one genuine recovery',async()=>{
  const h=harness(),a=h.adapter.begin({...action,episodeId:id(100)}),b=h.adapter.begin({...action,episodeId:id(100)});
  const results=await Promise.all([a.reportFailure(failure),b.reportFailure(failure)]);assert.equal(results.filter(Boolean).length,1);
  const recovery=present(await b.reportRecovery({stage:'response'}));assert.equal(recovery.report.event,'client_recovered');assert.equal(recovery.report.reason,'connection_failed');
  assert.equal(await a.reportRecovery({stage:'response'}),null);assert.equal(h.sent.length,2);assert.notEqual(h.sent[0].eventId,h.sent[1].eventId);assert.equal(h.sent[0].contextId,h.sent[1].contextId);
  assert.equal(await h.adapter.begin(action).reportRecovery({stage:'response'}),null);
});
test('repeated handlers of one failure do not inflate its count or change queued bytes',async()=>{
  let now=1700000000000;const h=harness({now:()=>now}),work=h.adapter.begin({...action,episodeId:id(100)});
  const first=present(await work.reportFailure(failure)),original=JSON.stringify(first.report);
  now+=10;assert.equal(await work.reportFailure(failure),null);
  now+=10;assert.equal(await h.adapter.begin({...action,episodeId:id(100)}).reportFailure(failure),null);
  now+=30;const recovered=present(await work.reportRecovery({stage:'response'}));
  assert.equal(JSON.stringify(first.report),original);assert.equal(h.sent.length,2);
  assert.equal(recovered.report.repeatCount,undefined);assert.equal(recovered.report.firstOccurredAt,undefined);assert.equal(recovered.report.lastOccurredAt,undefined);
  assert.equal(first.report.repeatCount,undefined);
  assert.equal(recovered.report.occurredAt,1700000000050);
});
test('finishing one handler does not reopen the same reported episode in another handler',async()=>{
  const h=harness(),a=h.adapter.begin({...action,episodeId:id(100)}),b=h.adapter.begin({...action,episodeId:id(100)});
  await a.reportFailure(failure);a.finishSuccess();assert.equal(await b.reportFailure(failure),null);
  assert.equal(present(await b.reportRecovery({stage:'response'})).report.repeatCount,undefined);assert.equal(h.sent.length,2);
});
test('evicted shared markers cannot reopen a failure already observed by the same handle',async()=>{
  const h=harness(),actions=[];
  const handler=h.adapter.begin({...action,episodeId:id(100)});
  for(let i=0;i<11;i++){const work=h.adapter.begin({...action,episodeId:id(100+i)});actions.push(work);await work.reportFailure(failure);}
  assert.equal(await actions[0].reportFailure(failure),null);assert.equal(h.sent.length,11);
  assert.equal(await actions[0].reportRecovery({stage:'response'}),null);
  assert.equal(present(await actions[10].reportRecovery({stage:'response'})).report.repeatCount,undefined);
  // A separate handler that never saw the failure has no permanent cross-handle
  // history after bounded eviction. There is deliberately no forever ID registry.
  assert.ok(await handler.reportFailure(failure));
});
test('a deduplicated handler remembers the failure even after its shared marker is evicted',async()=>{
  const h=harness(),first=h.adapter.begin({...action,episodeId:id(100)}),second=h.adapter.begin({...action,episodeId:id(100)});
  await first.reportFailure(failure);assert.equal(await second.reportFailure(failure),null);
  for(let i=1;i<=10;i++)await h.adapter.begin({...action,episodeId:id(100+i)}).reportFailure(failure);
  assert.equal(await second.reportFailure(failure),null);assert.equal(h.sent.length,11);
});
test('normal offline, cancellation, replacement, waiting and cache misses are context only',async()=>{
  const h=harness();for(const reason of ['offline','cancelled','superseded','cache_miss','busy','ambiguous_time','duplicate_chart'] as const) {
    const work=h.adapter.begin(action);work.step({stage:'wait',reason});assert.equal(await work.reportFailure({...failure,reason}),null);work.finishSuccess();
  }assert.equal(h.sent.length,0);
  const finished=h.adapter.begin(action);finished.step({stage:'request'});finished.finishSuccess();assert.equal(await finished.reportFailure(failure),null);
});
test('snapshots remain immutable while later stages and enqueue failures are independent',async()=>{
  let finish!:(value:boolean)=>void;const pending=new Promise<boolean>(resolve=>finish=resolve),h=harness({enqueue:()=>pending}),work=h.adapter.begin(action);
  work.step({stage:'request'});const result=work.reportFailure(failure);work.step({stage:'response'});finish(false);
  const failed=present(await result);assert.equal(failed.queued,false);assert.deepEqual(failed.report.context!,[{stage:'request'}]);
  const other=harness({enqueue:async()=>{throw Error('private storage error');}});assert.equal(present(await other.adapter.begin(action).reportFailure(failure)).queued,false);
});
test('clear and close revoke late handles without changing a previously created report',async()=>{
  const h=harness(),old=h.adapter.begin(action);old.step({stage:'request'});h.adapter.clearContext();
  old.step({stage:'response'});assert.equal(await old.reportFailure(failure),null);
  const fresh=h.adapter.begin(action),result=present(await fresh.reportFailure(failure));assert.deepEqual(result.report.context!,[]);
  h.adapter.close();assert.equal(await fresh.reportRecovery({stage:'response'}),null);assert.equal(await h.adapter.begin(action).reportFailure(failure),null);assert.equal(h.sent.length,1);
});
test('missing trusted version and arbitrary error strings cannot become diagnostic payloads',async()=>{
  // Missing appVersion deliberately tests runtime rejection of untrusted metadata.
  const h=harness({metadata:()=>({environment:'production',accountId:null} as ClientReportMetadata)});assert.equal(await h.adapter.begin(action).reportFailure(failure),null);
  assert.equal(clientFailureReason({code:'invalid_response',message:'private'}),'invalid_response');assert.equal(clientFailureReason({code:'secret_name'}),'unclassified_error');
  let touched=false;assert.equal(clientFailureReason(Object.defineProperty({},'code',{get(){touched=true;return 'invalid_response';}})),'unclassified_error');assert.equal(touched,false);
});


test('an early source fact retains its original observation time and rejects invalid or future times',async()=>{
 const h=harness(),work=h.adapter.begin(action,1699999999000);const result=present(await work.reportFailure(failure));
 assert.equal(result.report.occurredAt,1699999999000);
 assert.equal(present(await work.reportRecovery({stage:'response'})).report.occurredAt,1700000000000);
 for(const value of [-1,NaN,Infinity,1.5,1700000000001,8.64e15+1])
  assert.equal(await h.adapter.begin(action,value).reportFailure(failure),null);
 assert.equal(h.sent.length,2);
});
