import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticClient, type DiagnosticRequest } from '../src/data/diagnostic-client.ts';
import { createHttpTransport, type ConnectionSource, type ConnectionMode } from '../src/data/http-transport.ts';
import { DIAGNOSTIC_BATCH_MAX_BYTES, type ClientReport, type ClientContextStep } from '../shared/client-report-contract.ts';

const id=(n:number)=>`${n.toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`;
const report=(n=1):ClientReport=>({schemaVersion:1,eventId:id(n),occurredAt:1700000000000,
  environment:'production',source:'browser',event:'client_failed',level:'error',outcome:'failed',accountId:null,
  appVersion:'test-1',contextId:id(100),action:'calculate',component:'calculator',stage:'request',reason:'connection_failed'});
const body=(reports=[report()])=>({schemaVersion:1 as const,reports});
const accepted=(eventId=id(1))=>({eventId,status:'accepted',receivedAt:1700000001000,duplicate:false});
// The mock wire response deliberately accepts malformed bodies as well as valid ACKs.
const reply=(results:readonly unknown[]=[accepted()])=>Response.json({schemaVersion:1,results});
const options=(exit=false)=>({signal:new AbortController().signal,exit});
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('normal and exit requests send the same strict JSON through the fixed same-origin endpoint',async()=>{
  const calls:{url:Parameters<typeof fetch>[0];init:RequestInit}[]=[],input=body();
  const client=createDiagnosticClient({fetch:async(url,init)=>{assert.ok(init);calls.push({url,init});return reply();}});
  const normal=await client(input,options()),exit=await client(input,options(true));
  assert.deepEqual(normal,exit);assert.equal(calls.length,2);
  assert.equal(calls[0].url,'/api/diagnostics');assert.equal(calls[0].init.method,'POST');
  assert.equal(calls[0].init.credentials,'same-origin');assert.equal(new Headers(calls[0].init.headers).get('Content-Type'),'application/json');
  assert.equal(calls[0].init.body,JSON.stringify(input));assert.equal(calls[1].init.body,calls[0].init.body);
  assert.equal(calls[0].init.keepalive,false);assert.equal(calls[1].init.keepalive,true);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});
test('input is snapshotted before fetch and arbitrary fields or getters never cross the boundary',async()=>{
  const mutableReport={...report()},input=body([mutableReport]),calls:string[]=[];
  const client=createDiagnosticClient({fetch:async(_url,init)=>{assert.ok(init && typeof init.body==='string');calls.push(init.body);mutableReport.appVersion='changed';return reply();}});
  await client(input,options());assert.equal(JSON.parse(calls[0]).reports[0].appVersion,'test-1');
  let touched=false;
  const getter=Object.defineProperty({schemaVersion:1},'reports',{enumerable:true,get(){touched=true;return [report()];}});
  const hidden=Object.defineProperty(body(),'secret',{value:'private'}),symbolic=Object.assign(body(),{[Symbol('private')]:'private'});
  const array=Object.assign([report()],{extra:'private'});
  // Untrusted runtime values intentionally violate DiagnosticRequest; do not normalize them.
  for(const invalid of [{...body(),secret:'private'},{...body(),reports:[{...report(),email:'private@example.org'}]},getter,hidden,symbolic,
    {schemaVersion:1,reports:array},{schemaVersion:2,reports:[report()]}])await assert.rejects(client(invalid as unknown as DiagnosticRequest,options()));
  assert.equal(touched,false);assert.equal(calls.length,1);
});
test('count, duplicate IDs and UTF-8 request bytes are checked before sending',async()=>{
  let calls=0;const client=createDiagnosticClient({fetch:async()=>{calls++;return reply([]);}});
  await client(body(Array.from({length:32},(_,i)=>report(i+1))),options());assert.equal(calls,1);
  await assert.rejects(client(body(Array.from({length:33},(_,i)=>report(i+1))),options()));
  await assert.rejects(client(body([report(),report()]),options()));
  const context=Array.from({length:10},():ClientContextStep=>({stage:'validate',reason:'engine_unavailable',durationMs:1000,
    wait:{kind:'calculation_queue',durationMs:1000},operationId:id(400),requestId:id(401),taskId:id(402)}));
  const large=body(Array.from({length:32},(_,i)=>({...report(i+1),context})));
  assert.ok(new TextEncoder().encode(JSON.stringify(large)).byteLength>DIAGNOSTIC_BATCH_MAX_BYTES);
  await assert.rejects(client(large,options()));assert.equal(calls,1);
});
test('partial per-ID outcomes are returned without relabelling retryable or final rejection as acceptance',async()=>{
  const results=[accepted(),{eventId:id(2),status:'invalid',final:true,reason:'event_id_conflict'},
    {eventId:id(3),status:'retryable',reason:'auth_required'}];
  const client=createDiagnosticClient({fetch:async()=>reply(results)});
  assert.deepEqual(await client(body([report(1),report(2),report(3),report(4)]),options()),{schemaVersion:1,results});
});
test('generic HTTP failures and network errors never authorize an ACK, even with an acceptance body',async()=>{
  for(const status of [401,403,429,500,503]) {
    const client=createDiagnosticClient({fetch:async()=>new Response(JSON.stringify({schemaVersion:1,results:[accepted()]}),{status})});
    await assert.rejects(client(body(),options()));
  }
  const error=new TypeError('Network failed'),client=createDiagnosticClient({fetch:async()=>{throw error;}});
  await assert.rejects(client(body(),options()),value=>value===error);
});
test('unknown, duplicated or unrelated ACK IDs and malformed bodies reject the complete response',async()=>{
  for(const response of [reply([accepted(id(99))]),reply([accepted(),accepted()]),reply([{...accepted(),details:'private'}]),
    new Response('not JSON'),new Response(new Uint8Array([0xff])),new Response(null,{status:204})]) {
    const client=createDiagnosticClient({fetch:async()=>response});await assert.rejects(client(body(),options()));
  }
});
test('actual response bytes are bounded independently of a false Content-Length and unread tails are cancelled',async()=>{
  let cancelled=false,pulls=0;
  const response=new Response(new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(32*1024));},cancel(){cancelled=true;}}),
    {headers:{'Content-Length':'1'}});
  const client=createDiagnosticClient({fetch:async()=>response});await assert.rejects(client(body(),options()));
  assert.equal(cancelled,true);assert.ok(pulls<=4);
  let headerCancelled=false;
  const declared=new Response(new ReadableStream({cancel(){headerCancelled=true;}}),{headers:{'Content-Length':String(DIAGNOSTIC_BATCH_MAX_BYTES+1)}});
  await assert.rejects(createDiagnosticClient({fetch:async()=>declared})(body(),options()));assert.equal(headerCancelled,true);
});
test('an already aborted request does not fetch and abort after headers cannot publish a response',async()=>{
  const controller=new AbortController(),reason=new Error('stopped');controller.abort(reason);let calls=0;
  const client=createDiagnosticClient({fetch:async()=>{calls++;return reply();}});
  await assert.rejects(client(body(),{signal:controller.signal,exit:false}),value=>value===reason);assert.equal(calls,0);
  const late=new AbortController();
  const afterHeaders=createDiagnosticClient({fetch:async()=>{late.abort(reason);return reply();}});
  await assert.rejects(afterHeaders(body(),{signal:late.signal,exit:false}),value=>value===reason);
});
test('abort interrupts a stalled body reader and cancels its stream without waiting for new bytes',async()=>{
  let cancelled=false;const controller=new AbortController(),reason=new Error('closed');
  const client=createDiagnosticClient({fetch:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}))});
  const pending=client(body(),{signal:controller.signal,exit:false}),outcome=pending.then(()=>null,error=>error);
  await flush();controller.abort(reason);assert.equal(await outcome,reason);assert.equal(cancelled,true);
});
test('abort arriving with the last body chunk prevents publication',async()=>{
  const controller=new AbortController(),reason=new Error('closed');
  const client=createDiagnosticClient({fetch:async()=>new Response(new ReadableStream({pull(stream){
    stream.enqueue(new TextEncoder().encode(JSON.stringify({schemaVersion:1,results:[accepted()]})));stream.close();controller.abort(reason);
  }}))});
  await assert.rejects(client(body(),{signal:controller.signal,exit:false}),value=>value===reason);
});
test('an injected transport respects its connection and releases its subscription after streaming',async()=>{
  const listeners=new Set<Parameters<ConnectionSource['subscribe']>[0]>(),connection:ConnectionSource & {current:ConnectionMode}={current:'online',subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);}};
  let calls=0;const client=createDiagnosticClient({fetch:createHttpTransport({connection,fetch:async()=>{calls++;return reply();}})});await client(body(),options());assert.equal(calls,1);assert.equal(listeners.size,0);
    connection.current='offline';await assert.rejects(client(body(),options()),{code:'offline'});assert.equal(calls,1);
});


test('diagnostic origin travels only in a bounded header and cannot relabel another account',async()=>{
 const proof=`v1.17.${'a'.repeat(32)}.${'A'.repeat(43)}`,input=body([{...report(),accountId:'17'}]);
 let calls=0;
 const client=createDiagnosticClient({fetch:async(_url,init)=>{calls++;
  assert.equal(new Headers(init?.headers).get('X-Forma-Diagnostic-Proof'),proof);
  assert.equal(init?.body,JSON.stringify(input));return reply();}});
 await client(input,{...options(true),diagnosticProof:proof});
 for(const bad of ['bad',proof.replace('v1.17.','v1.18.')])await assert.rejects(client(input,{...options(),diagnosticProof:bad}));
 assert.equal(calls,1);
});
