import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {createJournalWriterClient} from '../server/journal/writer-client.ts';
import {createJournalWriter} from '../server/journal/writer.ts';
import {createServiceInput,reportServiceFailure,serviceSocketPath} from '../server/journal/service-input.ts';
import {createServerReporter} from '../server/journal/report.ts';
import {browserJournalEvent,completeJournalEvent} from '../server/journal/events.ts';
import {socketDirectory} from './helpers/socket-directory.ts';
import {deferred} from './helpers/deferred.ts';
import {WRITER_FRAME_BYTES} from '../server/journal/writer-protocol.ts';

const event=(id='first')=>completeJournalEvent({event:'service_failed',component:'postfix',reason:'process'},
 {environment:'stand',occurredAt:1_000_000,eventId:id})!;

test('private writer client returns the exact durable receipt and duplicate identity; old service sources still work',async t=>{
 const directory=await socketDirectory('forma-writer-ipc-');
 const writer=createJournalWriter({directory:path.join(directory,'archive'),externalReservedBytes:0,now:()=>1_000_100});
 const input=createServiceInput({directory,writer,report:createServerReporter({environment:'stand',write:writer.write})});
 const client=createJournalWriterClient({socketPath:serviceSocketPath(directory)});
 t.after(async()=>{await client.close();await input.close();await writer.close();await fs.rm(directory,{recursive:true,force:true});});
 assert.equal(await input.ready,true);
 assert.deepEqual(await client.write(event()),{status:'accepted',receivedAt:1_000_100,duplicate:false});
 assert.deepEqual(await client.write(event()),{status:'accepted',receivedAt:1_000_100,duplicate:true});
 assert.deepEqual(await client.write({...event(),reason:'cleanup'}),{status:'conflict',reason:'event_id_conflict'});
 assert.equal(await reportServiceFailure(serviceSocketPath(directory),{component:'postfix',reason:'cleanup'}),true);
 assert.equal((await client.usage()).ready,true);
 await client.drain();await client.close();
 assert.deepEqual(await client.write(event('after-close')),{status:'retryable',reason:'journal_unavailable'});
 assert.equal((await client.usage()).ready,false);
 assert.equal((await writer.usage()).ready,true,'closing one producer never closes the writer');
 const rows=(await Promise.all((await fs.readdir(path.join(directory,'archive'))).filter(name=>name.endsWith('.jsonl'))
  .map(name=>fs.readFile(path.join(directory,'archive',name),'utf8')))).join('').trim().split('\n');
 assert.equal(rows.length,2);
});

test('bounded admission and close release producers without false ACK or a disk fallback',async t=>{
 const directory=await socketDirectory('forma-client-bound-'),gate=deferred<{status:'accepted';receivedAt:number;duplicate:boolean}>();
 let calls=0;
 const writer={write:async()=>{calls++;return gate.promise;},usage:async()=>assert.fail('no automatic usage polling')};
 const input=createServiceInput({directory,writer,report:async()=>false});
 const client=createJournalWriterClient({socketPath:serviceSocketPath(directory)});
 t.after(async()=>{gate.resolve({status:'accepted',receivedAt:1,duplicate:false});await client.close();await input.close();await fs.rm(directory,{recursive:true,force:true});});
 assert.equal(await input.ready,true);
 const pending=Array.from({length:128},(_,index)=>client.write(event('event-'+index)));
 assert.deepEqual(await client.write(event('overflow')),{status:'retryable',reason:'journal_queue_full'});
 const drained=client.drain();await client.close();await drained;
 assert.ok((await Promise.all(pending)).every(result=>result.status==='retryable'));
 assert.ok(calls<=4);assert.deepEqual(await fs.readdir(directory),['run']);
 assert.deepEqual(await client.write(event('closed')),{status:'retryable',reason:'journal_unavailable'});
});

test('a missing or silent writer gets one bounded attempt; invalid events never connect or create files',async t=>{
 const directory=await socketDirectory('forma-client-dead-'),socketPath=serviceSocketPath(directory);
 const client=createJournalWriterClient({socketPath});
 let connections=0;
 const silent=net.createServer(socket=>{connections++;socket.on('error',()=>{});socket.on('data',()=>{});});
 t.after(async()=>{await client.close();if(silent.listening)await new Promise<void>(resolve=>silent.close(()=>resolve()));await fs.rm(directory,{recursive:true,force:true});});
 assert.equal((await client.write(event())).status,'retryable');
 assert.deepEqual(await fs.readdir(directory),[]);
 await fs.mkdir(path.dirname(socketPath),{mode:0o700});await new Promise<void>(resolve=>silent.listen(socketPath,resolve));
 assert.deepEqual(await client.write({...event(),reason:'PRIVATE'}),{status:'invalid',reason:'invalid_event'});
 assert.equal(connections,0);
 const started=Date.now();assert.equal((await client.write(event())).status,'retryable');
 assert.ok(Date.now()-started<1500);await client.drain();assert.equal(connections,1);
 assert.deepEqual(await fs.readdir(directory),['run']);
});

test('private input keeps its work bound after producers disconnect and rejects malformed frames',async t=>{
 const directory=await socketDirectory('forma-input-bound-');
 const gate=deferred<{status:'accepted';receivedAt:number;duplicate:boolean}>();let calls=0;
 const input=createServiceInput({directory,report:async()=>false,
  writer:{write:async()=>{calls++;return gate.promise;},usage:async()=>assert.fail('unexpected usage')}});
 t.after(async()=>{gate.resolve({status:'accepted',receivedAt:1,duplicate:false});await input.close();await fs.rm(directory,{recursive:true,force:true});});
 assert.equal(await input.ready,true);
 const send=(bytes:string|Buffer)=>new Promise<string>(resolve=>{
  const socket=net.createConnection(serviceSocketPath(directory),()=>socket.end(bytes));let reply='';
  socket.on('data',chunk=>{reply+=chunk;});socket.on('error',()=>{});socket.on('close',()=>resolve(reply));
 });
 const command=JSON.stringify({kind:'write',event:event()});
 for(const bytes of [command+'\n{}\n','x'.repeat(WRITER_FRAME_BYTES+1),Buffer.from([255,10]),
  JSON.stringify({kind:'write',event:{...event(),message:'PRIVATE'}})+'\n']) {
  assert.notEqual(await send(bytes),'1\n');
 }
 assert.equal(calls,0);
 assert.deepEqual(await Promise.all(Array.from({length:4},()=>send(command+'\n'))),['','','','']);
 assert.equal(calls,4);
 assert.equal(await send(command+'\n'),'');
 assert.equal(calls,4,'disconnected requests awaiting the writer still occupy the four work slots');
});

test('writer clients never turn invalid, truncated or oversized replies into acceptance',async t=>{
 const directory=await socketDirectory('forma-bad-ack-'),socketPath=serviceSocketPath(directory);
 await fs.mkdir(path.dirname(socketPath),{mode:0o700});
 let connections=0,reply='';
 const server=net.createServer(socket=>{connections++;socket.on('error',()=>{});socket.once('data',()=>socket.end(reply));});
 const client=createJournalWriterClient({socketPath});
 t.after(async()=>{await client.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(directory,{recursive:true,force:true});});
 await new Promise<void>(resolve=>server.listen(socketPath,resolve));
 for(const invalid of ['1\n','{}\n','{"status":"accepted","receivedAt":1}\n',
  '{"status":"accepted","receivedAt":-1,"duplicate":false}\n',
  '{"status":"accepted","receivedAt":1,"duplicate":false,"extra":true}\n',
  '{"status":"accepted","receivedAt":1,"duplicate":false}',
  '{"status":"accepted","receivedAt":1,"duplicate":false}\n{}\n','x'.repeat(1025),
  '{"status":"retryable","reason":"PRIVATE DATA"}\n']) {
  reply=invalid;assert.deepEqual(await client.write(event()),{status:'retryable',reason:'journal_unavailable'});
 }
 const before=connections;
 reply='{"ready":true,"diskBytes":0,"externalBytes":0,"bufferReservedBytes":0,"pendingBytes":0,"pendingCount":0}\n';
 assert.equal((await client.usage()).ready,true);
 for(const bad of [{ready:true},{ready:true,diskBytes:-1,externalBytes:0,bufferReservedBytes:0,pendingBytes:0,pendingCount:0},
  {ready:true,diskBytes:0,externalBytes:null,bufferReservedBytes:0,pendingBytes:0,pendingCount:0.5}]) {
  reply=JSON.stringify(bad)+'\n';assert.equal((await client.usage()).ready,false);
 }
 assert.equal(connections,before+4,'usage is explicit; no reconnect or background probe');
});

test('byte admission bounds large browser facts independently of the command count',async()=>{
 const client=createJournalWriterClient({socketPath:'/missing/forma-journal.sock'});
 const uuid='00000000-0000-4000-8000-000000000001';
 const large=browserJournalEvent({schemaVersion:1,eventId:uuid,occurredAt:1,source:'browser',environment:'stand',
  accountId:null,appVersion:'0.2',contextId:uuid,action:'chart_open',component:'chart',stage:'request',reason:'server_error',
  event:'client_failed',level:'error',outcome:'failed',context:Array.from({length:10},()=>({stage:'request',
   reason:'server_unavailable',operationId:uuid,requestId:uuid,taskId:uuid,wait:{kind:'network',durationMs:1}}))},'192.0.2.1');
 assert.ok(large);
 const pending=Array.from({length:128},()=>client.write(large));
 await client.close();
 const results=await Promise.all(pending);
 assert.ok(results.some(result=>result.status==='retryable' && result.reason==='journal_queue_full'));
 assert.ok(results.every(result=>result.status==='retryable'));
});
