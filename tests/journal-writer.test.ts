import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJournalWriter } from '../server/journal/writer.ts';
import type { JournalEvent, ServerJournalEvent } from '../server/journal/events.ts';

const DAY=86400000, NOW=40*DAY;
const event=(id='event:1'):ServerJournalEvent=>({schemaVersion:1,eventId:id,occurredAt:NOW,environment:'stand',
  source:'runtime',event:'account_cleanup_failed',level:'error',outcome:'failed'});
const mail:JournalEvent={schemaVersion:1,eventId:'mail:'+'a'.repeat(32)+':handed_off',occurredAt:NOW,
  environment:'stand',source:'mail',event:'mail_handed_off',level:'info',outcome:'handed_off',
  codeId:'a'.repeat(32),contextId:'a'.repeat(32),recipient:'person@example.test',reason:'dsn:2.0.0'};
function fixture(t:{after(fn:()=>void):void}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'forma-journal-writer-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;
}
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test('worker ACK corresponds to durable JSONL, survives restart, and keeps the submitted snapshot', async t=>{
  const directory=fixture(t);let now=NOW;
  let writer=createJournalWriter({directory,now:()=>now,externalReservedBytes:1024});
  const input={...mail},pending=writer.write(input);input.environment='production';
  assert.deepEqual(await pending,{status:'accepted',receivedAt:NOW,duplicate:false});
  const archive=fs.readdirSync(directory).filter(name=>name.endsWith('.jsonl'));
  const line=JSON.parse(fs.readFileSync(path.join(directory,archive[0]),'utf8'));
  assert.equal(line.environment,'stand');assert.equal(line.recipient,mail.recipient);assert.equal(line.reason,'dsn:2.0.0');
  await writer.close();now++;
  writer=createJournalWriter({directory,now:()=>now,externalReservedBytes:1024});
  assert.deepEqual(await writer.write({...mail}),{status:'accepted',receivedAt:NOW,duplicate:true});
  assert.equal((await writer.write({...mail,environment:'production'})).status,'conflict');
  await writer.close();
});

test('initialization and external reservation waits have bounded count and bytes without blocking the server thread', async t=>{
  const directory=fixture(t);let release!:(n:number)=>void;
  const reservation=new Promise<number>(resolve=>release=resolve);
  const writer=createJournalWriter({directory,now:()=>NOW,externalReservedBytes:()=>reservation,
    policy:{maxPendingCount:2,maxPendingBytes:1024,maxBatchBytes:512,maxEventBytes:512,segmentBytes:1024}});
  const a=writer.write(event('a')),b=writer.write(event('b'));
  assert.deepEqual(await writer.write(event('c')),{status:'retryable',reason:'journal_queue_full'});
  assert.equal((await writer.usage()).pendingCount,2);
  let yielded=false;await new Promise<void>(resolve=>setImmediate(()=>{yielded=true;resolve();}));assert.equal(yielded,true);
  assert.equal(fs.readdirSync(directory).length,0);
  release(1024);assert.equal((await a).status,'accepted');assert.equal((await b).status,'accepted');
  assert.equal((await writer.usage()).pendingBytes,0);await writer.close();
});

test('byte admission is independent of count and a close returns retryable for unconfirmed work', async t=>{
  const directory=fixture(t);let release!:(n:number)=>void;
  const writer=createJournalWriter({directory,now:()=>NOW,externalReservedBytes:()=>new Promise<number>(resolve=>release=resolve),
    policy:{maxPendingCount:100,maxPendingBytes:1024,maxBatchBytes:512,maxEventBytes:512,segmentBytes:1024}});
  const pending=Array.from({length:10},(_,i)=>writer.write(event('x'.repeat(150)+i)));
  const usage=await writer.usage();assert.ok(usage.pendingBytes<=1024);assert.ok(usage.pendingCount>0&&usage.pendingCount<10);
  await writer.close();release(0);
  const outcomes=await Promise.all(pending);assert.ok(outcomes.every(result=>result.status==='retryable'));
  assert.equal((await writer.write(event())).status,'retryable');
  assert.equal(fs.readdirSync(directory).length,0);
});

test('idle maintenance expires the archive without a new event or a repeated ACK extending its lifetime', async t=>{
  const directory=fixture(t);let now=NOW;
  const writer=createJournalWriter({directory,now:()=>now,externalReservedBytes:0,policy:{maintenanceMs:10}});
  try {
    assert.equal((await writer.write(event())).status,'accepted');now+=29*DAY;
    assert.deepEqual(await writer.write(event()),{status:'accepted',receivedAt:NOW,duplicate:true});
    now+=DAY;
    for(let i=0;i<100&&fs.readdirSync(directory).some(name=>name.endsWith('.jsonl'));i++)await sleep(10);
    assert.equal(fs.readdirSync(directory).some(name=>name.endsWith('.jsonl')),false);
  } finally {await writer.close();}
});

test('invalid events, excessive event bytes, and a missing external reservation never become accepted', async t=>{
  const directory=fixture(t);
  let writer=createJournalWriter({directory,now:()=>NOW,externalReservedBytes:0,policy:{maxEventBytes:100}});
  assert.deepEqual(await writer.write(event()),{status:'invalid',reason:'event_too_large'});
  assert.equal((await writer.write({...event(),password:'secret'} as JournalEvent)).status,'invalid');await writer.close();
  writer=createJournalWriter({directory,now:()=>NOW,externalReservedBytes:()=>Promise.reject(new Error('reservation unavailable'))});
  assert.equal((await writer.write(event())).status,'retryable');await writer.close();
});

test('a queued burst is split into bounded worker batches without losing or duplicating events',async t=>{
  const directory=fixture(t);let release!:(n:number)=>void;
  const reservation=new Promise<number>(resolve=>release=resolve);
  const writer=createJournalWriter({directory,now:()=>NOW,externalReservedBytes:()=>reservation,
    policy:{maxPendingBytes:8192,maxPendingCount:32,maxEventBytes:256,maxBatchBytes:512,segmentBytes:1024}});
  const pending=Array.from({length:20},(_,i)=>writer.write(event(`burst:${i}`)));
  release(0);
  try {
    const outcomes=await Promise.all(pending);assert.ok(outcomes.every(result=>result.status==='accepted'));
    const lines=fs.readdirSync(directory).filter(name=>name.endsWith('.jsonl'))
      .flatMap(name=>fs.readFileSync(path.join(directory,name),'utf8').trim().split('\n').map(line=>JSON.parse(line)));
    assert.equal(lines.length,20);assert.equal(new Set(lines.map(line=>line.eventId)).size,20);
  } finally {await writer.close();}
});

test('archive corruption makes the asynchronous writer retryable and never returns a false ACK',async t=>{
  const directory=fixture(t);fs.writeFileSync(path.join(directory,'0000000000000001.jsonl'),'not-json\n');
  const writer=createJournalWriter({directory,now:()=>NOW,externalReservedBytes:0});
  assert.equal((await writer.write(event())).status,'retryable');await writer.close();
  assert.equal(fs.readFileSync(path.join(directory,'0000000000000001.jsonl'),'utf8'),'not-json\n');
});

test('a continuously nonempty queue shares bounded slots with TTL cleanup in both directions',async t=>{
  const directory=fixture(t);let now=NOW,serial=0,accepted=0,removedAt:number|null=null,remainingAtFirstAck=0;
  t.mock.timers.enable({apis:['setInterval']});
  const writer=createJournalWriter({directory,now:()=>now,externalReservedBytes:0,
    policy:{maintenanceMs:50,maxEventBytes:256,maxBatchBytes:256,maxPendingBytes:8192,maxPendingCount:32,segmentBytes:700}});
  const oldCount=()=>fs.readdirSync(directory).filter(name=>name.endsWith('.jsonl')).reduce((sum,name)=>{
    let content:string;
    try{content=fs.readFileSync(path.join(directory,name),'utf8');}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return sum;throw error;}
    return sum+content.trim().split('\n').filter(line=>line && JSON.parse(line).eventId.startsWith('ttl-old:')).length;
  },0);
  try {
    for(let i=0;i<12;i++)assert.equal((await writer.write(event(`ttl-old:${i}`))).status,'accepted');
    const expiredSegments=fs.readdirSync(directory).filter(name=>name.endsWith('.jsonl')).length;
    assert.ok(expiredSegments>=4);now+=31*DAY;
    const lanes=Array.from({length:8},async()=>{
      for(let i=0;i<10;i++) {
        const result=await writer.write({...event(`fresh:${serial++}`),occurredAt:now});
        assert.equal(result.status,'accepted');accepted++;
        const remaining=oldCount();
        if(accepted===1)remainingAtFirstAck=remaining;
        if(remaining===0 && removedAt===null)removedAt=accepted;
      }
    });
    // The only scheduled cleanup request arrives while the first batch is already busy.
    t.mock.timers.tick(50);
    await Promise.all(lanes);
    assert.ok(remainingAtFirstAck>0,'writes must progress before a multi-segment cleanup finishes');
    assert.ok(removedAt!==null && removedAt<=expiredSegments+2,
      `cleanup must progress between batches, observed removal after ${removedAt} ACKs`);
  } finally {await writer.close();t.mock.timers.reset();}
});

test('concurrent close callers both wait for worker termination before reopening the directory',async t=>{
  const directory=fixture(t),writer=createJournalWriter({directory,now:()=>NOW,externalReservedBytes:0});
  assert.equal((await writer.write(event())).status,'accepted');
  let firstFinished=false;
  const first=writer.close().then(()=>{firstFinished=true;});
  await writer.close();
  assert.equal(firstFinished,true,'the second close must not finish while the first still owns the worker');
  await first;
  const reopened=createJournalWriter({directory,now:()=>NOW+1,externalReservedBytes:0});
  try{assert.deepEqual(await reopened.write(event()),{status:'accepted',receivedAt:NOW,duplicate:true});}
  finally{await reopened.close();}
});

test('drain shares one wait for admitted writes and abrupt close releases it without a false ACK',async t=>{
  const directory=fixture(t);let release!:(n:number)=>void;
  const held=new Promise<number>(resolve=>release=resolve);
  const writer=createJournalWriter({directory,now:()=>NOW,externalReservedBytes:()=>held});
  const result=writer.write(event('last'));
  const first=writer.drain(),second=writer.drain();
  assert.equal(first,second);
  let drained=false;void first.then(()=>{drained=true;});
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(drained,false);
  await writer.close();await first;
  assert.equal((await result).status,'retryable');
  release(0);
});
