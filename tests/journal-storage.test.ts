import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { openJournalStore } from '../server/journal/store.ts';
import type { ServerJournalEvent } from '../server/journal/events.ts';

const DAY = 86400000;
const NOW = 40 * DAY;
function event(id = 'event:1', overrides: Partial<ServerJournalEvent> = {}): ServerJournalEvent {
  return {schemaVersion:1,eventId:id,occurredAt:NOW,environment:'stand',source:'runtime',
    event:'account_cleanup_failed',level:'error',outcome:'failed',...overrides};
}
function fixture(t: {after(fn: () => void): void}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forma-journal-'));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  return directory;
}
function segments(directory: string) { return fs.readdirSync(directory).filter(name=>name.endsWith('.jsonl')).sort(); }

test('durable JSONL is the sole payload; a restart preserves the first ACK and detects an ID conflict', t => {
  const directory=fixture(t);
  let store=openJournalStore({directory});
  assert.deepEqual(store.append(event(),NOW,0),{status:'accepted',receivedAt:NOW,duplicate:false});
  store.close();
  const line=JSON.parse(fs.readFileSync(path.join(directory,segments(directory)[0]),'utf8'));
  assert.equal(line.eventId,'event:1'); assert.equal(line.receivedAt,NOW); assert.match(line.checksum,/^[a-f0-9]{64}$/);
  const db=new DatabaseSync(path.join(directory,'index.sqlite'));
  assert.deepEqual(db.prepare('PRAGMA table_info(events)').all().map(row=>row.name),['id','hash','segment','offset','receivedAt','expiresAt']);
  assert.equal(fs.readFileSync(path.join(directory,'index.sqlite')).includes(Buffer.from('account_cleanup_failed')),false);
  db.close();
  store=openJournalStore({directory});
  assert.deepEqual(store.append(event(),NOW+1000,0),{status:'accepted',receivedAt:NOW,duplicate:true});
  assert.deepEqual(store.append(event('event:1',{environment:'production'}),NOW+1000,0),{status:'conflict',reason:'event_id_conflict'});
  store.close();
  assert.equal(fs.readFileSync(path.join(directory,segments(directory)[0]),'utf8').trim().split('\n').length,1);
});

test('a lost index and an incomplete final append recover the complete durable records', t => {
  const directory=fixture(t);
  let store=openJournalStore({directory});
  store.append(event(),NOW,0); store.close();
  fs.rmSync(path.join(directory,'index.sqlite'));
  const filename=path.join(directory,segments(directory)[0]);
  const size=fs.statSync(filename).size;
  fs.appendFileSync(filename,'{"schemaVersion":1,"eventId":"interrupted');
  store=openJournalStore({directory});
  assert.equal(fs.statSync(filename).size,size);
  assert.deepEqual(store.append(event(),NOW+1,0),{status:'accepted',receivedAt:NOW,duplicate:true});
  store.close();
});

test('completed-line corruption is fail closed, including when the index is missing', t => {
  const directory=fixture(t);
  const store=openJournalStore({directory});
  store.append(event('first'),NOW,0); store.append(event('second'),NOW,0); store.close();
  const filename=path.join(directory,segments(directory)[0]);
  fs.writeFileSync(filename,fs.readFileSync(filename,'utf8').replace('first','third'));
  fs.rmSync(path.join(directory,'index.sqlite'));
  assert.throws(()=>openJournalStore({directory}),/corrupt/i);
  assert.equal(fs.readFileSync(filename,'utf8').includes('third'),true);
});

test('TTL compaction preserves a fresh tail, does not refresh duplicates, and rejects expired server events', t => {
  const directory=fixture(t);
  const store=openJournalStore({directory});
  store.append(event('older',{occurredAt:NOW-29*DAY}),NOW,0);
  store.append(event('fresh'),NOW,0);
  store.maintain(NOW+2*DAY,0);
  const text=segments(directory).map(name=>fs.readFileSync(path.join(directory,name),'utf8')).join('');
  assert.equal(text.includes('older'),false); assert.equal(text.includes('fresh'),true);
  assert.deepEqual(store.append(event('fresh'),NOW+2*DAY,0),{status:'accepted',receivedAt:NOW,duplicate:true});
  assert.deepEqual(store.append(event('old',{occurredAt:NOW-30*DAY}),NOW,0),{status:'invalid',reason:'expired'});
  store.close();
});

test('fsync and index failures never ACK; reopening can confirm the already written event', t => {
  for(const point of ['file','directory','index'] as const) {
    const directory=fixture(t);let store=openJournalStore({directory});
    const originalSync=fs.fsyncSync, originalPrepare=DatabaseSync.prototype.prepare;
    try {
      if(point==='index') DatabaseSync.prototype.prepare=function(sql) {
        if(sql.startsWith('INSERT INTO events'))throw new Error('index write failed');
        return originalPrepare.call(this,sql);
      };
      else fs.fsyncSync=fd=>{
        if(fs.fstatSync(fd).isDirectory()===(point==='directory'))throw new Error('sync failed');
        return originalSync(fd);
      };
      assert.equal(store.append(event(),NOW,0).status,'retryable');
    } finally {fs.fsyncSync=originalSync;DatabaseSync.prototype.prepare=originalPrepare;}
    assert.equal(store.append(event(),NOW,0).status,'retryable');
    store.close();store=openJournalStore({directory});
    assert.deepEqual(store.append(event(),NOW+1,0),{status:'accepted',receivedAt:NOW,duplicate:true});
    store.close();
  }
});

test('the combined file, buffer and external reservation budget evicts oldest receipts without permanent tombstones', t => {
  const directory=fixture(t), policy={maxBytes:800000,maxEventBytes:1024,maxPendingBytes:4096,
    maxPendingCount:8,maxBatchBytes:2048,segmentBytes:2048};
  const store=openJournalStore({directory,policy});
  const external=360000;
  for(let i=0;i<200;i++) {
    assert.equal(store.append(event(`event:${i}`),NOW+i,external).status,'accepted');
    const usage=store.usage();
    assert.ok(usage.diskBytes+usage.bufferReservedBytes+usage.externalBytes<=policy.maxBytes);
    assert.equal(fs.readdirSync(directory).some(name=>/-wal$|-journal$|\.tmp$/.test(name)),false);
  }
  assert.deepEqual(store.append(event('event:199'),NOW+300,external),{status:'accepted',receivedAt:NOW+199,duplicate:true});
  assert.deepEqual(store.append(event('event:0'),NOW+301,external),{status:'accepted',receivedAt:NOW+301,duplicate:false});
  while(store.maintain(NOW+31*DAY,external).more) {} assert.deepEqual(segments(directory),[]);
  store.close();
});

test('a future event expires from reception; retention and size limits cannot be enlarged', t => {
  const directory=fixture(t);const store=openJournalStore({directory});
  store.append(event('future',{occurredAt:NOW+100*DAY}),NOW,0);
  store.maintain(NOW+30*DAY,0);assert.deepEqual(segments(directory),[]);store.close();
  assert.throws(()=>openJournalStore({directory,policy:{maxBytes:500000001}}),/policy/);
  const small=openJournalStore({directory,policy:{maxEventBytes:100}});
  assert.deepEqual(small.append(event(),NOW,0),{status:'invalid',reason:'event_too_large'});small.close();
});

test('idle cleanup reads no fresh payload and processes at most one expired segment per pass', t=>{
  const directory=fixture(t);
  const store=openJournalStore({directory,policy:{maxEventBytes:256,segmentBytes:700}});
  for(let i=0;i<7;i++)store.append(event(`old:${i}`,{occurredAt:NOW-29*DAY}),NOW,0);
  const before=segments(directory).length;
  const original=fs.readSync;
  try {
    fs.readSync=()=>{throw new Error('Fresh payload should not be read');};
    assert.doesNotThrow(()=>store.maintain(NOW,0));
  } finally {fs.readSync=original;}
  assert.deepEqual(store.maintain(NOW+2*DAY,0),{more:true});
  assert.equal(segments(directory).length,before-1);
  while(store.maintain(NOW+2*DAY,0).more) {}
  assert.deepEqual(segments(directory),[]);store.close();
});

test('recovery respects the external reservation before growing the disposable index', t=>{
  const directory=fixture(t),policy={maxBytes:800000,maxEventBytes:1024,maxPendingBytes:4096,
    maxPendingCount:8,maxBatchBytes:2048,segmentBytes:2048};
  let store=openJournalStore({directory,policy});
  for(let i=0;i<200;i++)assert.equal(store.append(event(`event:${i}`),NOW,0).status,'accepted');
  const reservedBuffers=store.usage().bufferReservedBytes;store.close();
  fs.rmSync(path.join(directory,'index.sqlite'));
  assert.throws(()=>openJournalStore({directory,policy,externalReservedBytes:420000}));
  const total=fs.readdirSync(directory).reduce((sum,name)=>sum+fs.statSync(path.join(directory,name)).size,0);
  assert.ok(total+reservedBuffers+420000<=policy.maxBytes);
  store=openJournalStore({directory,policy});
  assert.deepEqual(store.append(event('event:199'),NOW+1,0),{status:'accepted',receivedAt:NOW,duplicate:true});store.close();
});

test('an already occupied budget cannot grow even the initial index header', t=>{
  const directory=fixture(t),policy={maxBytes:800000,maxEventBytes:1024,maxPendingBytes:4096,
    maxPendingCount:8,maxBatchBytes:2048,segmentBytes:2048};
  const store=openJournalStore({directory,policy}),buffers=store.usage().bufferReservedBytes;store.close();
  fs.rmSync(path.join(directory,'index.sqlite'));
  const fd=fs.openSync(path.join(directory,'reserved.bin'),'w');fs.ftruncateSync(fd,policy.maxBytes-buffers-1024);fs.closeSync(fd);
  assert.throws(()=>openJournalStore({directory,policy}));
  const bytes=fs.readdirSync(directory).reduce((sum,name)=>sum+fs.statSync(path.join(directory,name)).size,0);
  assert.ok(bytes+buffers<=policy.maxBytes);
  assert.equal(fs.existsSync(path.join(directory,'index.sqlite')),false);
});

test('creating a journal directory also synchronizes its parent before any event can be acknowledged', t=>{
  const parent=fixture(t),directory=path.join(parent,'new-journal');
  const parentInode=fs.statSync(parent).ino,original=fs.fsyncSync;
  let synchronized=false;
  try {
    fs.fsyncSync=fd=>{if(fs.fstatSync(fd).ino===parentInode)synchronized=true;return original(fd);};
    const store=openJournalStore({directory});
    assert.equal(store.append(event(),NOW,0).status,'accepted');store.close();
  } finally {fs.fsyncSync=original;}
  assert.equal(synchronized,true);
});

test('a damaged derivative index is recreated without changing the archive receipt', t=>{
  for(const damage of ['header','table-page']) {
    const directory=fixture(t);let store=openJournalStore({directory});
    store.append(event(),NOW,0);store.close();
    if(damage==='header')fs.writeFileSync(path.join(directory,'index.sqlite'),'not a SQLite database');
    else {const fd=fs.openSync(path.join(directory,'index.sqlite'),'r+');fs.writeSync(fd,Buffer.alloc(4096,255),0,4096,8192);fs.closeSync(fd);}
    store=openJournalStore({directory});
    assert.deepEqual(store.append(event(),NOW+1,0),{status:'accepted',receivedAt:NOW,duplicate:true});store.close();
  }
});

test('recovery after process death between write, sync, index, and compaction keeps exactly the durable surviving records', t => {
  const moduleURL=new URL('../server/journal/store.ts',import.meta.url).href;
  for(const point of ['partial-write','write','file-sync','directory-sync','index','rename','replacement-sync']) {
    const directory=fixture(t);
    let store=openJournalStore({directory});
    store.append(event('older',{occurredAt:NOW-29*DAY}),NOW,0);
    store.append(event('fresh'),NOW,0);store.close();
    const script=`
      import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
      import {openJournalStore} from ${JSON.stringify(moduleURL)};
      const store=openJournalStore({directory:${JSON.stringify(directory)},policy:${JSON.stringify(point==='directory-sync'?{maxEventBytes:256,segmentBytes:700}:{})}});
      const point=${JSON.stringify(point)};const die=()=>process.kill(process.pid,'SIGKILL');
      if(point==='partial-write'){const original=fs.writeSync;fs.writeSync=(fd,bytes,offset,length)=>{original(fd,bytes,offset,Math.floor(length/2));die();return 0;};}
      if(point==='write'){const original=fs.writeSync;fs.writeSync=(...args)=>{const n=original(...args);die();return n;};}
      if(point==='file-sync'||point==='directory-sync'||point==='replacement-sync'){
        const original=fs.fsyncSync;fs.fsyncSync=fd=>{original(fd);if(fs.fstatSync(fd).isDirectory()===(point==='directory-sync'))die();};
      }
      if(point==='index'){const original=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(sql){
        const statement=original.call(this,sql);if(sql.startsWith('INSERT INTO events')){const run=statement.run.bind(statement);statement.run=(...args)=>{const value=run(...args);die();return value;};}return statement;};}
      if(point==='rename'){const original=fs.renameSync;fs.renameSync=(...args)=>{original(...args);die();};}
      if(point==='rename'||point==='replacement-sync')store.maintain(${NOW+2*DAY},0);
      else store.append(${JSON.stringify(event('new'))},${NOW+1},0);
    `;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
    assert.equal(child.signal,'SIGKILL',`${point}: ${child.stderr}`);
    store=openJournalStore({directory});store.maintain(NOW+2*DAY,0);
    assert.deepEqual(store.append(event('fresh'),NOW+2*DAY,0),{status:'accepted',receivedAt:NOW,duplicate:true});
    if(point==='partial-write') {
      assert.deepEqual(store.append(event('new'),NOW+2*DAY,0),{status:'accepted',receivedAt:NOW+2*DAY,duplicate:false});
    } else if(!['rename','replacement-sync'].includes(point)) {
      assert.deepEqual(store.append(event('new'),NOW+2*DAY,0),{status:'accepted',receivedAt:NOW+1,duplicate:true});
    }
    assert.equal(segments(directory).map(name=>fs.readFileSync(path.join(directory,name),'utf8')).join('').includes('older'),false);
    store.close();
  }
});


function allocatedBytes(directory:string) {
  return fs.readdirSync(directory).reduce((sum,name)=>{
    const info=fs.statSync(path.join(directory,name));
    return sum+Math.max(info.size,info.blocks*512);
  },0);
}

test('ordinary append and usage do not revisit the archive; rotation and cleanup update physical accounting',t=>{
  const directory=fixture(t),store=openJournalStore({directory,policy:{maxEventBytes:256,segmentBytes:700}});
  try {
    for(let i=0;i<30;i++)assert.equal(store.append(event(`catalog:${i}`),NOW+i,0).status,'accepted');
    const retired=new Set(segments(directory).slice(0,-1).map(name=>path.join(directory,name)));
    const readdir=fs.readdirSync,lstat=fs.lstatSync,stat=fs.statSync;
    let scans=0,retiredStats=0;
    try {
      fs.readdirSync=((...args:Parameters<typeof readdir>)=>{scans++;return Reflect.apply(readdir,fs,args);}) as typeof readdir;
      fs.lstatSync=((...args:Parameters<typeof lstat>)=>{if(retired.has(String(args[0])))retiredStats++;return Reflect.apply(lstat,fs,args);}) as typeof lstat;
      fs.statSync=((...args:Parameters<typeof stat>)=>{if(retired.has(String(args[0])))retiredStats++;return Reflect.apply(stat,fs,args);}) as typeof stat;
      for(let i=30;i<34;i++) {
        assert.equal(store.append(event(`catalog:${i}`),NOW+i,0).status,'accepted');
        store.usage();
      }
      assert.equal(scans,0,'append/usage must not enumerate the archive, including rotation');
      assert.equal(retiredStats,0,'unchanged segments must not be measured again');
    } finally {fs.readdirSync=readdir;fs.lstatSync=lstat;fs.statSync=stat;}
    assert.equal(store.usage().diskBytes,allocatedBytes(directory));
    assert.deepEqual(store.maintain(NOW+31*DAY,0),{more:true});
    assert.equal(store.append(event('during-prune',{occurredAt:NOW+31*DAY}),NOW+31*DAY,0).status,'accepted');
    while(store.maintain(NOW+31*DAY,0).more)assert.equal(store.usage().diskBytes,allocatedBytes(directory));
    assert.equal(segments(directory).length,1);
    assert.match(fs.readFileSync(path.join(directory,segments(directory)[0]),'utf8'),/during-prune/);
    assert.equal(store.append(event('after-prune',{occurredAt:NOW+31*DAY}),NOW+31*DAY,0).status,'accepted');
    assert.equal(store.usage().diskBytes,allocatedBytes(directory));
  } finally {store.close();}
});

test('journal accounting includes allocated blocks without discounting sparse logical content',t=>{
  const directory=fixture(t),store=openJournalStore({directory});
  try {
    assert.equal(store.append(event('small-file'),NOW,0).status,'accepted');
    const sparse=fs.openSync(path.join(directory,'reserved.bin'),'w');
    try{fs.ftruncateSync(sparse,2*1024*1024);}finally{fs.closeSync(sparse);}
    assert.equal(store.usage().diskBytes,allocatedBytes(directory));
  }finally{store.close();}
});

test('real allocated blocks and existing reservations stay inside the common budget through rotation and restart',t=>{
  const directory=fixture(t),policy={maxBytes:1_500_000,maxEventBytes:1024,maxPendingBytes:4096,
    maxPendingCount:8,maxBatchBytes:2048,segmentBytes:2048},external=360000;
  let store=openJournalStore({directory,policy,externalReservedBytes:external});
  const withinBudget=()=>{
    const usage=store.usage(),actual=allocatedBytes(directory)+usage.bufferReservedBytes+external;
    assert.ok(actual<=policy.maxBytes,`physical files and reservations: ${actual} > ${policy.maxBytes}`);
  };
  try {
    for(let i=0;i<1200;i++){
      assert.equal(store.append(event(`physical:${i}`),NOW+i,external).status,'accepted');
      withinBudget();
    }
    assert.deepEqual(store.append(event('physical:1199'),NOW+1200,external),
      {status:'accepted',receivedAt:NOW+1199,duplicate:true});
    assert.deepEqual(store.append(event('physical:0'),NOW+1201,external),
      {status:'accepted',receivedAt:NOW+1201,duplicate:false});
    withinBudget();store.close();
    fs.rmSync(path.join(directory,'index.sqlite'));
    store=openJournalStore({directory,policy,externalReservedBytes:external});withinBudget();
    assert.deepEqual(store.append(event('physical:1199'),NOW+1202,external),
      {status:'accepted',receivedAt:NOW+1199,duplicate:true});
    while(store.maintain(NOW+31*DAY,external).more)withinBudget();
    withinBudget();assert.deepEqual(segments(directory),[]);
  }finally{store.close();}
});
