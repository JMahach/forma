import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { openMailBuffer, MAIL_BUFFER_LIMITS } from '../server/journal/mail-buffer.ts';
import { completeJournalEvent, type ServerJournalEvent, type JournalEvent } from '../server/journal/events.ts';
import { JOURNAL_POLICY } from '../server/journal/policy.ts';

const start=1_000_000;
function event(i=1,recipient='person@example.test'):ServerJournalEvent {
  const id=i.toString(16).padStart(32,'0');
  const result=completeJournalEvent({event:'mail_handed_off',occurredAt:start,eventId:`mail:${id}:handed_off`,
    codeId:id,contextId:'b'.repeat(32),recipient,reason:'dsn:2.0.0'},
  {environment:'stand',occurredAt:start,eventId:id});
  assert.ok(result);return result;
}
function fixture(t:{after:(fn:()=>void)=>void}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'forma-mail-buffer-'));
  fs.chmodSync(directory,0o700);
  let time=start;
  const filename=path.join(directory,'pending.sqlite');
  const buffer=openMailBuffer({filename,now:()=>time});
  t.after(()=>{buffer.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {buffer,filename,directory,advance:(ms:number)=>{time+=ms;}};
}

test('a buffered terminal survives reopen, deduplicates by stable content and requires the exact ACK snapshot',t=>{
  const f=fixture(t), original=event();
  assert.equal(f.buffer.stage(original).status,'buffered');
  assert.equal(f.buffer.stage({...original,reason:'dsn:2.1.0'}).status,'conflict');
  assert.equal(f.buffer.stage({...original}).status,'buffered');
  assert.equal(f.buffer.acknowledge({...original,occurredAt:start+1}),false);
  f.buffer.close();
  const reopened=openMailBuffer({filename:f.filename,now:()=>start});
  try {
    assert.deepEqual(reopened.batch(),[original]);
    assert.equal(reopened.acknowledge(original),true);
    assert.deepEqual(reopened.batch(),[]);
  } finally {reopened.close();}
});

test('only validated terminal mail events enter the temporary buffer',t=>{
  const {buffer}=fixture(t);
  for(const value of [{...event(),code:'123456'},{...event(),reason:'smtp says private detail'},
    completeJournalEvent({event:'auth_login',contextId:'b'.repeat(32),accountId:'1'},
      {environment:'stand',occurredAt:start,eventId:'login'}),
    completeJournalEvent({event:'mail_queued',codeId:'a'.repeat(32),contextId:'b'.repeat(32),recipient:'a@example.test'},
      {environment:'stand',occurredAt:start,eventId:'queued'})]) {
    assert.equal(buffer.stage(value as JournalEvent).status,'invalid');
  }
  assert.equal(buffer.stage(event(1,'\u044f'.repeat(235)+'@example.test')).status,'buffered');
});

test('buffer transfers never extend the original thirty-day retention and batches are bounded',t=>{
  const f=fixture(t);
  for(let i=0;i<40;i++)assert.equal(f.buffer.stage(event(i)).status,'buffered');
  assert.equal(f.buffer.batch().length,32);
  f.advance(JOURNAL_POLICY.retentionMs-1);
  assert.equal(f.buffer.stage(event()).status,'buffered');
  f.advance(1);f.buffer.maintain();
  assert.deepEqual(f.buffer.batch(),[]);
  assert.equal(f.buffer.stage(event()).status,'invalid');
});

test('real peak files, rollback and owned data stay inside the reserved eight MiB at capacity and during full expiry',t=>{
  const f=fixture(t), exec=DatabaseSync.prototype.exec;
  let peakDisk=0,peakRollback=0,peakCombined=0,commits=0;
  const sample=()=>{
    const usage=f.buffer.usage();
    peakDisk=Math.max(peakDisk,usage.diskBytes);
    peakRollback=Math.max(peakRollback,usage.rollbackBytes);
    peakCombined=Math.max(peakCombined,usage.diskBytes+usage.ownedBytesReserved);
    assert.ok(usage.databaseBytes<=MAIL_BUFFER_LIMITS.databaseBytes);
    assert.ok(usage.rollbackBytes<=MAIL_BUFFER_LIMITS.rollbackBytes);
    assert.ok(usage.diskBytes+usage.ownedBytesReserved<=MAIL_BUFFER_LIMITS.reservedBytes);
  };
  DatabaseSync.prototype.exec=function(sql:string){
    if(sql==='COMMIT'){commits++;sample();}
    const result=exec.call(this,sql);
    if(sql==='COMMIT')sample();
    return result;
  };
  try {
    let full=false;
    for(let i=0;i<MAIL_BUFFER_LIMITS.maxRecords+1;i++) {
      const result=f.buffer.stage(event(i,'\u4e00'.repeat(235)+'@example.test'));
      if(result.status==='full'){full=true;break;}
      assert.equal(result.status,'buffered');
    }
    assert.equal(full,true);
    assert.ok(f.buffer.usage().records<=2048);
    assert.ok(f.buffer.batch().length<=32);
    f.advance(JOURNAL_POLICY.retentionMs); f.buffer.maintain();
    assert.equal(f.buffer.usage().records,0);
    assert.ok(peakRollback>256*1024,'exercise a real large rollback, not only configured caps');
    assert.ok(commits>100);
    sample();
    console.log(JSON.stringify({mailBufferPeak:{peakDisk,peakRollback,peakCombined,reservedBytes:MAIL_BUFFER_LIMITS.reservedBytes,commits}}));
  } finally {DatabaseSync.prototype.exec=exec;}
});

test('process death during a transaction cannot acknowledge or corrupt a pending delivery',t=>{
  const f=fixture(t);f.buffer.stage(event(1));f.buffer.close();
  const script=`import {DatabaseSync} from 'node:sqlite';
    import {openMailBuffer} from './server/journal/mail-buffer.ts';
    const buffer=openMailBuffer({filename:process.argv[1],now:()=>${start}});
    const exec=DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT')process.kill(process.pid,'SIGKILL');return exec.call(this,sql);};
    buffer.stage(JSON.parse(process.argv[2]));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script,f.filename,JSON.stringify(event(2))],{cwd:process.cwd(),encoding:'utf8'});
  assert.equal(child.signal,'SIGKILL',child.stderr);
  const reopened=openMailBuffer({filename:f.filename,now:()=>start});
  try {assert.deepEqual(reopened.batch(),[event(1)]);}finally{reopened.close();}
});

test('failed final reports do not keep later buffered events out of every batch',t=>{
  const {buffer}=fixture(t);
  for(let i=0;i<40;i++)buffer.stage(event(i));
  const first=buffer.batch(),second=buffer.batch();
  assert.equal(first.length,32);assert.equal(second.length,8);
  assert.equal(new Set([...first,...second].map(value=>value.eventId)).size,40);
});

test('expiry and final ACK remove private payload from both the DB and retained rollback files',t=>{
  const f=fixture(t), recipient='retention-marker-unique@example.test', original=event(1,recipient);
  f.buffer.stage(original);assert.equal(f.buffer.acknowledge(original),true);
  const absent=()=>{for(const name of fs.readdirSync(f.directory))assert.equal(fs.readFileSync(path.join(f.directory,name)).includes(Buffer.from(recipient)),false,name);};
  absent();f.buffer.stage(event(2,recipient));f.advance(JOURNAL_POLICY.retentionMs);f.buffer.maintain();absent();
});

test('a failure after commit but before directory sync is retryable, never buffered',t=>{
  const {buffer}=fixture(t), sync=fs.fsyncSync;
  fs.fsyncSync=()=>{throw new Error('sync failed');};
  try{assert.equal(buffer.stage(event()).status,'retryable');}finally{fs.fsyncSync=sync;}
  assert.equal(buffer.stage(event()).status,'buffered');assert.equal(buffer.batch().length,1);
});
