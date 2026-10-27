import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {createServiceInput, reportServiceFailure, serviceSocketPath, SERVICE_INPUT_RESERVED_BYTES} from '../server/journal/service-input.ts';
import {createJournalRuntime} from '../server/journal/runtime.ts';

test('private service facts reach the existing archive without arbitrary content',async t=>{
 const directory=await fs.mkdtemp('/private/tmp/forma-service-');
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const journal=createJournalRuntime({directory,environment:'stand',clientReservedBytes:SERVICE_INPUT_RESERVED_BYTES});
 const input=createServiceInput({directory,report:journal.report});
 try {
  assert.equal(await input.ready,true);
  const socket=serviceSocketPath(directory);assert.equal((await fs.stat(socket)).mode&0o777,0o600);
  for(const component of ['lifetime_prepare','return_index_prepare','postfix'] as const) {
   assert.equal(await reportServiceFailure(socket,component==='postfix'?{component,reason:'cleanup'}:{component,reason:'process'}),true);
  }
  const send=(value:unknown)=>new Promise<string>(resolve=>{
   const connection=net.createConnection(socket,()=>connection.end(JSON.stringify(value)+'\n'));
   let reply='';connection.on('data',chunk=>reply+=chunk);connection.on('close',()=>resolve(reply));
  });
  assert.notEqual(await send({event:'service_failed',eventId:'a',occurredAt:Date.now(),component:'postfix',reason:'cleanup',message:'PRIVATE'}),'1\n');
  assert.notEqual(await send({event:'service_failed',eventId:'b',occurredAt:Date.now(),component:'postfix',reason:'spawn'}),'1\n');
 } finally {await input.close();await journal.close();}
 const archive=path.join(directory,'archive');
 const content=(await Promise.all((await fs.readdir(archive)).filter(n=>n.endsWith('.jsonl')).map(n=>fs.readFile(path.join(archive,n),'utf8')))).join('');
 const rows=content.trim().split('\n').map(line=>JSON.parse(line));assert.equal(rows.length,3);
 assert.ok(rows.every(row=>row.source==='runtime' && row.event==='service_failed'));assert.equal(content.includes('PRIVATE'),false);
 assert.equal(await fs.stat(serviceSocketPath(directory)).then(()=>true,()=>false),false);
});

test('a stopped site does not create a queue; unsafe and live socket paths are preserved',async t=>{
 const directory=await fs.mkdtemp('/private/tmp/forma-service-');t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const socket=serviceSocketPath(directory);
 assert.equal(await reportServiceFailure(socket,{component:'postfix',reason:'process'}),false);
 assert.deepEqual(await fs.readdir(directory),[]);
 await fs.mkdir(path.dirname(socket),{mode:0o700});await fs.writeFile(socket,'PRIVATE');
 const blocked=createServiceInput({directory,report:async()=>true});assert.equal(await blocked.ready,false);await blocked.close();
 assert.equal(await fs.readFile(socket,'utf8'),'PRIVATE');await fs.unlink(socket);
 const first=createServiceInput({directory,report:async()=>true});assert.equal(await first.ready,true);
 const second=createServiceInput({directory,report:async()=>true});assert.equal(await second.ready,false);await second.close();
 assert.equal(await reportServiceFailure(socket,{component:'postfix',reason:'process'}),true);
 await first.close();
 const replacement=createServiceInput({directory,report:async()=>true});
 try {
  assert.equal(await replacement.ready,true);
  await first.close(); // Repeating an already completed close cannot affect the new owner.
  assert.equal(await reportServiceFailure(socket,{component:'postfix',reason:'process'}),true);
 } finally {await replacement.close();}
});

test('a crashed owner leaves a stale socket that the next start can reclaim',async t=>{
 const directory=await fs.mkdtemp('/private/tmp/forma-service-');t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const socket=serviceSocketPath(directory);await fs.mkdir(path.dirname(socket),{mode:0o700});
 await new Promise<void>((resolve,reject)=>execFile(process.execPath,['--input-type=module','-e',
  "import net from 'node:net';net.createServer().listen(process.argv[1],()=>process.exit(0));",socket],
  error=>error?reject(error):resolve()));
 assert.equal((await fs.lstat(socket)).isSocket(),true);
 const input=createServiceInput({directory,report:async()=>true});
 try {
  assert.equal(await input.ready,true);
  assert.equal(await reportServiceFailure(socket,{component:'postfix',reason:'process'}),true);
 } finally {await input.close();}
 assert.equal(await fs.stat(socket).then(()=>true,()=>false),false);
});

test('oversized and incomplete submissions cannot hold the private input open',async t=>{
 const directory=await fs.mkdtemp('/private/tmp/forma-service-');t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 let calls=0;const input=createServiceInput({directory,report:async()=>{calls++;return true;}});
 try {
  assert.equal(await input.ready,true);
  for(const body of ['x'.repeat(2048),'{'])await new Promise<void>((resolve,reject)=>{
   const socket=net.createConnection(serviceSocketPath(directory),()=>socket.write(body));
   socket.on('error',()=>{});socket.on('close',resolve);setTimeout(()=>{socket.destroy();reject(Error('input deadline failed'));},2000).unref();
  });
  assert.equal(calls,0);
 } finally {await input.close();}
});
