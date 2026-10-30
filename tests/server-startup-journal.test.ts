import test, {mock} from 'node:test';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/server.ts';
import {deferred} from './helpers/deferred.ts';
import {lifetimeFileFixture} from './helpers/lifetime-file.ts';
import { completeJournalEvent } from '../server/journal/events.ts';

const project=fileURLToPath(new URL('../',import.meta.url));
async function fixture(t:{after(fn:()=>Promise<void>):void}) {
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'forma-startup-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const env={FORMA_STATE_DIR:path.join(directory,'state'),FORMA_JOURNAL_DIR:path.join(directory,'journal'),
  FORMA_JOURNAL_WRITER:'embedded',FORMA_ACCOUNT_ORIGINS:'http://localhost:3636',TRANSIT_CACHE_DIR:path.join(directory,'transit'),HOST:'127.0.0.1',PORT:'65536'};
 async function records() {
  const archive=path.join(env.FORMA_JOURNAL_DIR,'archive');
  const names=await fs.readdir(archive);
  return (await Promise.all(names.filter(name=>name.endsWith('.jsonl')).map(name=>fs.readFile(path.join(archive,name),'utf8'))))
   .join('').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as Record<string,unknown>);
 }
 const root=path.join(directory,'project');await fs.mkdir(root);
 // Only immutable inputs are shared. Startup must never open the real 6 GB file.
 for(const name of ['data','server','shared','requirements.txt','.venv'])
  await fs.symlink(path.join(project,name),path.join(root,name));
 return {directory,root,env,records};
}

test('startup facts accept a known stage and reject raw exception, paths and user details',()=>{
 const defaults={environment:'stand' as const,occurredAt:1000,eventId:'startup'};
 for(const component of ['configuration','cities','public_files','account','listener']) {
  const fact={event:'startup_failed',component,reason:'unexpected'};
  assert.ok(completeJournalEvent(fact,defaults));
  for(const extra of [{error:Error('PRIVATE')},{path:'/PRIVATE'},{message:'PRIVATE'},{recipient:'private@example.test'},
   {accountId:'1'},{reason:'PRIVATE'},{component:'PRIVATE'}]) assert.equal(completeJournalEvent({...fact,...extra},defaults),null);
 }
});

test('writer mode is explicit before opening any archive',async t=>{
 const f=await fixture(t);
 await assert.rejects(startServer({root:f.root,env:{...f.env,FORMA_JOURNAL_WRITER:undefined}}),/FORMA_JOURNAL_WRITER/);
 assert.equal(await fs.stat(path.join(f.env.FORMA_JOURNAL_DIR,'archive')).then(()=>true,()=>false),false);
});

test('an unavailable external writer does not stop HTTP or create an embedded archive or receiver',async t=>{
 const f=await fixture(t);
 const server=await startServer({root:f.root,env:{...f.env,FORMA_JOURNAL_WRITER:'external',PORT:'0'}});
 try {
  const port=(server.address() as import('node:net').AddressInfo).port;
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/cities?q=Moscow`)).status,200);
  for(const name of ['archive','run'])assert.equal(await fs.stat(path.join(f.env.FORMA_JOURNAL_DIR,name)).then(()=>true,()=>false),false,name);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('configuration and early file failures survive shutdown in the existing archive',async t=>{
 const f=await fixture(t);
 await assert.rejects(startServer({root:f.directory,env:{...f.env,FORMA_ENVIRONMENT:'production'}}),/FORMA_APP_VERSION/);
 await assert.rejects(startServer({root:path.join(f.directory,'PRIVATE'),env:f.env}),{code:'ENOENT'});
 const rows=await f.records();
 assert.deepEqual(rows.map(row=>[row.event,row.component,row.reason]),[
  ['startup_failed','configuration','unexpected'],['startup_failed','cities','unexpected']]);
 assert.equal(JSON.stringify(rows).includes('PRIVATE'),false);
});

test('failed listener closes initialized resources and a second attempt preserves state',async t=>{
 const f=await fixture(t),signals=['SIGINT','SIGTERM'] as const;
 const listeners=signals.map(signal=>process.listenerCount(signal));
 await assert.rejects(startServer({root:f.root,env:f.env}),{code:'ERR_SOCKET_BAD_PORT'});
 const key=await fs.readFile(path.join(f.env.FORMA_STATE_DIR,'keys/account-hmac.bin'));
 await assert.rejects(startServer({root:f.root,env:f.env}),{code:'ERR_SOCKET_BAD_PORT'});
 assert.deepEqual(await fs.readFile(path.join(f.env.FORMA_STATE_DIR,'keys/account-hmac.bin')),key);
 assert.deepEqual(signals.map(signal=>process.listenerCount(signal)),listeners);
 const rows=await f.records();assert.equal(rows.length,2);
 assert.ok(rows.every(row=>row.event==='startup_failed' && row.component==='listener'));
 assert.notEqual(rows[0]!.eventId,rows[1]!.eventId);
});

test('an unavailable journal never replaces or retries the original startup failure',async t=>{
 const f=await fixture(t),blocked=path.join(f.directory,'blocked');await fs.writeFile(blocked,'PRIVATE');
 await assert.rejects(startServer({root:path.join(f.directory,'missing'),env:{...f.env,FORMA_JOURNAL_DIR:blocked}}),{code:'ENOENT'});
 assert.equal(await fs.readFile(blocked,'utf8'),'PRIVATE');
});


test('an asynchronous bind failure preserves the same error and records one safe fact',async t=>{
 const f=await fixture(t),failure=Object.assign(new Error('PRIVATE occupied interface'),{code:'EADDRINUSE'});
 const server=Object.assign(new EventEmitter(),{listening:false,listen(){queueMicrotask(()=>server.emit('error',failure));return server;}});
 const create=mock.method(http,'createServer',()=>server as unknown as http.Server);
 try {
  await assert.rejects(startServer({root:f.root,env:f.env}),error=>error===failure);
 } finally {create.mock.restore();}
 const rows=await f.records();assert.equal(rows.length,1);
 assert.equal(rows[0]!.component,'listener');assert.equal(JSON.stringify(rows).includes('PRIVATE'),false);
});


test('HTTP opens only after the prepared lifetime is verified, and first requests reuse that file',async t=>{
 const f=await fixture(t),input=await lifetimeFileFixture(t);
 const directory=path.join(f.root,'.cache/lifetime');await fs.mkdir(directory,{recursive:true});
 const file=path.join(directory,'lifetime-1801-2400.f64le');
 await fs.rename(input.file,file);await fs.rename(input.metadataFile,file.replace('.f64le','.metadata.json'));
 let opens=0,reads=0,closes=0;const closed=deferred();
 const originalOpen=fs.open.bind(fs);
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await originalOpen(...args);
  if(args[0]===file){
   opens++;const read=handle.read.bind(handle),close=handle.close.bind(handle);
   t.mock.method(handle,'read',async(...args:unknown[])=>{
    const result=await Reflect.apply(read,handle,args) as Awaited<ReturnType<typeof read>>;reads++;return result;
   });
   t.mock.method(handle,'close',async()=>{closes++;await close();closed.resolve();});
  }
  return handle;
 });
 const create=http.createServer.bind(http);
 t.mock.method(http,'createServer',(...args:Parameters<typeof http.createServer>)=>{
  assert.equal(opens,1,'HTTP cannot open before the lifetime file has been verified');
  assert.equal(reads,1,'digest verification must finish before the first visitor');
  return create(...args);
 });
 const server=await startServer({root:f.root,env:{...f.env,PORT:'0'}});
 try {
  const port=(server.address() as import('node:net').AddressInfo).port;
  const metadata=await fetch(`http://127.0.0.1:${port}/api/lifetime/meta`);assert.equal(metadata.status,200);
  const body=await metadata.json() as {samples:number};assert.equal(body.samples,17);
  const point=await fetch(`http://127.0.0.1:${port}/api/lifetime?index=8`);
  assert.equal(point.status,200);assert.equal((await point.json() as {index:number}).index,8);
  assert.equal(opens,1);assert.equal(reads,2,'the first point needs only its small positional read');
 } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
 // Cleanup runs after HTTP has drained.
 await closed.promise;
 assert.equal(closes,1);
});

test('damaged prepared lifetime prevents startup instead of failing the first visitor',async t=>{
 const f=await fixture(t),input=await lifetimeFileFixture(t);
 const directory=path.join(f.root,'.cache/lifetime');await fs.mkdir(directory,{recursive:true});
 await fs.copyFile(input.file,path.join(directory,'lifetime-1801-2400.f64le'));
 await fs.writeFile(path.join(directory,'lifetime-1801-2400.metadata.json'),JSON.stringify({...input.metadata,sha256:'0'.repeat(64)}));
 await assert.rejects(startServer({root:f.root,env:f.env}),{code:'lifetime_unavailable'});
 const rows=await f.records();
 assert.equal(rows.filter(row=>row.event==='startup_failed' && row.component==='lifetime').length,1);
 assert.equal(rows.filter(row=>row.event==='prepared_data_failed').length,1);
});


test('startup without a completed lifetime keeps other routes open and adopts the completed file later',async t=>{
 const f=await fixture(t),input=await lifetimeFileFixture(t);
 const server=await startServer({root:f.root,env:{...f.env,PORT:'0'}});
 try {
  const port=(server.address() as import('node:net').AddressInfo).port,origin=`http://127.0.0.1:${port}`;
  assert.equal((await fetch(origin+'/api/cities?q=Moscow')).status,200);
  const preparing=await fetch(origin+'/api/lifetime/meta');assert.equal(preparing.status,503);
  assert.equal((await preparing.json() as {error:string}).error,'lifetime_preparing');
  const directory=path.join(f.root,'.cache/lifetime');await fs.mkdir(directory,{recursive:true});
  await fs.copyFile(input.file,path.join(directory,'lifetime-1801-2400.f64le'));
  await fs.copyFile(input.metadataFile,path.join(directory,'lifetime-1801-2400.metadata.json'));
  const ready=await fetch(origin+'/api/lifetime/meta');assert.equal(ready.status,200);
  assert.equal((await ready.json() as {samples:number}).samples,17);
 } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
