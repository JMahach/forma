import test from 'node:test';
import assert from 'node:assert/strict';
import {parseClientReport,parseDiagnosticResponse,CLIENT_REPORT_MAX_BYTES,DIAGNOSTIC_BATCH_MAX_COUNT,DIAGNOSTIC_BATCH_MAX_BYTES,CLIENT_CONTEXT_MAX_BYTES} from '../shared/client-report-contract.ts';
const id=(n:number)=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const report=()=>({schemaVersion:1,eventId:id(1),occurredAt:1700000000000,environment:'production',source:'browser',event:'client_failed',level:'error',outcome:'failed',accountId:null,appVersion:'test-1',contextId:id(2),action:'calculate',component:'calculator',stage:'request',reason:'connection_failed'});

test('valid reports are independent immutable snapshots, including nested context',()=>{
  const input={...report(),browser:{name:'firefox',version:'120.0'},os:'linux',device:'desktop',context:[{stage:'wait',requestId:id(3),wait:{kind:'network',durationMs:12.5}}]};
  const parsed=parseClientReport(input)!;assert.ok(parsed);input.context[0].wait.durationMs=100;
  assert.equal(parsed.context![0].wait!.durationMs,12.5);assert.ok(Object.isFrozen(parsed));assert.ok(Object.isFrozen(parsed.context));assert.ok(Object.isFrozen(parsed.context![0].wait));
  assert.equal(CLIENT_REPORT_MAX_BYTES,16*1024);assert.equal(DIAGNOSTIC_BATCH_MAX_COUNT,32);assert.equal(DIAGNOSTIC_BATCH_MAX_BYTES,64*1024);assert.equal(CLIENT_CONTEXT_MAX_BYTES,8000);
});
test('event, level and outcome have exact meanings',()=>{
  assert.ok(parseClientReport({...report(),event:'client_outcome_unknown',level:'warn',outcome:'unknown'}));
  assert.ok(parseClientReport({...report(),event:'client_recovered',level:'info',outcome:'recovered'}));
  for(const patch of [{event:'arbitrary'},{outcome:'unknown'},{level:'warn'},{source:'runtime'},{reason:'offline'},{reason:'a_secret_that_looks_like_a_code'}])assert.equal(parseClientReport({...report(),...patch}),null);
});
test('bounded episode measurements are all present together and remain numeric',()=>{
  const measurements={repeatCount:3,firstOccurredAt:1700000000000,lastOccurredAt:1700000000020};
  assert.ok(parseClientReport({...report(),...measurements}));
  for(const patch of [{repeatCount:0},{repeatCount:1.5},{firstOccurredAt:undefined},{lastOccurredAt:Infinity}])assert.equal(parseClientReport({...report(),...measurements,...patch}),null);
  assert.equal(parseClientReport({...report(),repeatCount:1}),null);
});
test('the exact allowlist rejects personal data and raw exception fields at every level',()=>{
  for(const patch of [{message:'private'},{stack:'private'},{url:'/charts/private'},{browser:{name:'firefox',userAgent:'private'}},{context:[{stage:'request',details:'private'}]},{context:[{stage:'request',cacheKey:'private'}]},{wait:{kind:'network',durationMs:1,request:'private'}}])assert.equal(parseClientReport({...report(),...patch}),null);
  assert.equal(parseClientReport({...report(),context:Array.from({length:11},()=>({stage:'request'}))}),null);
  assert.equal(parseClientReport({...report(),appVersion:'x'.repeat(CLIENT_REPORT_MAX_BYTES)}),null);
});
test('required metadata and numeric measurements reject guessed or malformed values',()=>{
  for(const patch of [{appVersion:undefined},{appVersion:''},{accountId:0},{accountId:'0'},{accountId:'name'},{environment:'local'},{occurredAt:-1},{occurredAt:Infinity},{durationMs:NaN},{durationMs:-1},{calculationVersion:'old'},{eventId:'not-uuid'},{browser:{name:'browser',version:'120'}},{browser:{name:'chrome',version:'120 private'}}])assert.equal(parseClientReport({...report(),...patch}),null);
  assert.ok(parseClientReport({...report(),accountId:'42',calculationVersion:'a'.repeat(64),durationMs:0}));
});
test('parsers never invoke accessors and do not accept hidden or symbolic data',()=>{
  let touched=false;const input={...report()};Object.defineProperty(input,'reason',{enumerable:true,get(){touched=true;return 'connection_failed';}});
  assert.equal(parseClientReport(input),null);assert.equal(touched,false);
  assert.equal(parseClientReport({...report(),[Symbol('secret')]:'secret'}),null);
  assert.equal(parseClientReport(new Proxy({}, {ownKeys(){throw Error('trap');}})),null);
});
test('responses distinguish durable acceptance, final invalidity and retryable rejection per ID',()=>{
  const response={schemaVersion:1,results:[{eventId:id(1),status:'accepted',receivedAt:1700000000001,duplicate:true},{eventId:id(2),status:'invalid',final:true,reason:'event_id_conflict'},{eventId:id(3),status:'retryable',reason:'ownership_unverified'}]};
  const parsed=parseDiagnosticResponse(response)!;assert.deepEqual(parsed,response);assert.ok(Object.isFrozen(parsed.results[0]));
  assert.ok(parseDiagnosticResponse({schemaVersion:1,results:[]}));
});
test('malformed, duplicate or oversized response results never authorize removal',()=>{
  const accepted={eventId:id(1),status:'accepted',receivedAt:1700000000001,duplicate:false};
  for(const results of [[accepted,accepted],[{...accepted,extra:true}],[{eventId:id(1),status:'invalid',reason:'invalid_report'}],[{eventId:id(1),status:'invalid',final:false,reason:'invalid_report'}],[{eventId:id(1),status:'retryable',reason:'invalid_report'}],[{...accepted,receivedAt:NaN}],Array.from({length:33},(_,i)=>({...accepted,eventId:id(i+1)}))])assert.equal(parseDiagnosticResponse({schemaVersion:1,results}),null);
  assert.equal(parseDiagnosticResponse({schemaVersion:2,results:[]}),null);assert.equal(parseDiagnosticResponse({schemaVersion:1,results:[],accepted:true}),null);
});
