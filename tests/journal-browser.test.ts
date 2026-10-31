import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJSON } from '../server/journal/policy.ts';
import * as events from '../server/journal/events.ts';
import type { ClientReport } from '../shared/client-report-contract.ts';
import { parseClientReport } from '../shared/client-report-contract.ts';
import { openJournalStore } from '../server/journal/store.ts';
import { createJournalWriter } from '../server/journal/writer.ts';

const DAY=86400000, NOW=40*DAY;
function report(n=1):ClientReport {
  return {schemaVersion:1,eventId:`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`,
    occurredAt:DAY,source:'browser',event:'client_failed',level:'error',outcome:'failed',
    environment:'stand',accountId:null,appVersion:'0.2',contextId:'10000000-0000-0000-0000-000000000001',
    action:'chart_open',component:'chart',stage:'request',reason:'connection_failed',
    browser:{name:'firefox',version:'130'},wait:{kind:'network',durationMs:123},
    context:[{stage:'request',durationMs:120,wait:{kind:'network',durationMs:120}}]};
}
const browser=(n=1,deliveryIp='192.0.2.1')=>({...report(n),deliveryIp});
function fixture(t:{after(fn:()=>void):void}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'forma-journal-browser-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;
}
function lines(directory:string):Record<string,unknown>[] {
  return fs.readdirSync(directory).filter(name=>name.endsWith('.jsonl')).sort()
    .flatMap(name=>fs.readFileSync(path.join(directory,name),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
}

test('archived retired metadata stays readable and checksummed without widening new reports',t=>{
  const startup={schemaVersion:1,eventId:'startup:legacy',occurredAt:NOW,environment:'stand',source:'runtime',
    event:'startup_failed',level:'error',outcome:'failed',component:'configuration',reason:'unexpected'};
  for(const [current,legacy] of [
    [browser(),{...browser(),calculationVersion:'a'.repeat(64)}],
    [browser(),{...browser(),reason:'versions_unavailable',
      context:[{stage:'request',reason:'versions_unavailable'}]}],
    [startup,{...startup,component:'versions'}],
  ]) {
    const directory=fixture(t),filename=path.join(directory,'0000000000000001.jsonl');
    const stored={...legacy,receivedAt:NOW};
    const checksum=createHash('sha256').update(canonicalJSON(stored)).digest('hex');
    const bytes=canonicalJSON({...stored,checksum})+'\n';
    fs.writeFileSync(filename,bytes);
    assert.equal(events.parseJournalEvent(legacy),null,'live input stays strict');
    const store=openJournalStore({directory});
    try {
      assert.deepEqual(store.append(current,NOW+1,0),{status:'conflict',reason:'event_id_conflict'},
        'the original immutable payload hash survives reopening');
      assert.equal(fs.readFileSync(filename,'utf8'),bytes,'opening does not rewrite archived facts');
    } finally {store.close();}
    fs.writeFileSync(filename,bytes.replace('a'.repeat(64),'b'.repeat(64))
      .replaceAll('versions_unavailable','server_error').replace('"versions"','"configuration"'));
    assert.throws(()=>openJournalStore({directory}),/corrupt/i,'retired metadata is still covered by the checksum');
  }
});

test('browser facts use the strict client owner and a separately validated delivery IP',()=>{
  const input=report();assert.ok(parseClientReport(input));
  assert.ok('browserJournalEvent' in events,'the server composition accepts the report and connection IP separately');
  for(const ip of ['192.0.2.1','2001:db8::1','::ffff:192.0.2.1']) {
    const event=events.browserJournalEvent(input,ip);
    assert.deepEqual(event,{...input,deliveryIp:ip});assert.deepEqual(events.parseJournalEvent(event),event);
  }
  assert.equal(events.browserJournalEvent({...input,deliveryIp:'192.0.2.2'},'192.0.2.1'),null);
  assert.equal(events.browserJournalEvent({...input,accountId:'secret'},'192.0.2.1'),null);
  for(const ip of ['',null,123,'not-an-ip','192.0.2.1, 192.0.2.2','[::1]','192.0.2.1:80','fe80::1%en0']) {
    assert.equal(events.browserJournalEvent(input,ip),null);
    assert.equal(events.parseJournalEvent({...input,deliveryIp:ip}),null);
  }
  for(const key of ['ip','code','cookie','body','error','stack','recipient','receivedAt','checksum']) {
    assert.equal(events.parseJournalEvent({...browser(),[key]:'forbidden'}),null,key);
  }
  assert.equal(events.parseJournalEvent({...browser(),context:[{stage:'request',body:'secret'}]}),null);
  const hidden={...browser()};Object.defineProperty(hidden,'deliveryIp',{get(){throw Error('must not execute');},enumerable:true});
  assert.equal(events.parseJournalEvent(hidden),null);
  assert.equal(events.parseJournalEvent({...browser(),deliveryIp:undefined}),null);
});

test('late browser events live for thirty days from receipt while server TTL stays unchanged',t=>{
  const directory=fixture(t),store=openJournalStore({directory});
  try {
    assert.deepEqual(store.append(browser(),NOW,0),{status:'accepted',receivedAt:NOW,duplicate:false});
    const server={schemaVersion:1 as const,eventId:'runtime:old',occurredAt:NOW-29*DAY,environment:'stand' as const,
      source:'runtime' as const,event:'account_cleanup_failed',level:'error' as const,outcome:'failed'};
    assert.equal(store.append(server,NOW,0).status,'accepted');
    assert.equal(store.append({...browser(2),occurredAt:NOW+100*DAY},NOW,0).status,'accepted');
    while(store.maintain(NOW+29*DAY,0).more) {}
    assert.equal(lines(directory).length,2);assert.ok(lines(directory).every(line=>line.source==='browser'));
    assert.equal(lines(directory).find(line=>line.eventId===report().eventId)?.occurredAt,DAY);
    assert.deepEqual(store.append(browser(1,'2001:db8::2'),NOW+30*DAY-1,0),{status:'accepted',receivedAt:NOW,duplicate:true});
    while(store.maintain(NOW+30*DAY,0).more) {}
    assert.deepEqual(lines(directory),[]);
    assert.deepEqual(store.append(browser(1,'2001:db8::2'),NOW+30*DAY,0),{status:'accepted',receivedAt:NOW+30*DAY,duplicate:false});
    assert.equal(lines(directory)[0].deliveryIp,'2001:db8::2');
  } finally {store.close();}
});

test('reopening preserves the first IP and receipt, canonical nested fields and real content conflicts',t=>{
  const directory=fixture(t);let store=openJournalStore({directory});
  try {
    assert.equal(store.append(browser(),NOW,0).status,'accepted');store.close();
    store=openJournalStore({directory});
    const reordered={...browser(1,'2001:db8::2'),browser:{version:'130',name:'firefox' as const},
      wait:{durationMs:123,kind:'network' as const},context:[{wait:{durationMs:120,kind:'network' as const},durationMs:120,stage:'request' as const}]};
    assert.deepEqual(store.append(reordered,NOW+DAY,0),{status:'accepted',receivedAt:NOW,duplicate:true});
    for(const change of [{reason:'server_error'},{occurredAt:DAY+1},{accountId:'2'},
      {context:[{stage:'request',durationMs:121}]}]) {
      assert.deepEqual(store.append({...browser(),...change} as events.JournalEvent,NOW+DAY,0),{status:'conflict',reason:'event_id_conflict'});
    }
    const stored=lines(directory);assert.equal(stored.length,1);assert.equal(stored[0].deliveryIp,'192.0.2.1');assert.equal(stored[0].receivedAt,NOW);
  } finally {store.close();}
});

test('expiry found by append also removes the old receipt before accepting a new delivery',t=>{
  const directory=fixture(t),store=openJournalStore({directory});
  try {
    assert.equal(store.append(browser(),NOW,0).status,'accepted');
    assert.deepEqual(store.append(browser(1,'2001:db8::2'),NOW+30*DAY,0),{status:'accepted',receivedAt:NOW+30*DAY,duplicate:false});
    const stored=lines(directory);assert.equal(stored.length,1);assert.equal(stored[0].deliveryIp,'2001:db8::2');
  } finally {store.close();}
});

test('the immutable report hash does not weaken the checksum of the stored first IP',t=>{
  const directory=fixture(t),store=openJournalStore({directory});
  try {assert.equal(store.append(browser(),NOW,0).status,'accepted');} finally {store.close();}
  const file=path.join(directory,fs.readdirSync(directory).find(name=>name.endsWith('.jsonl'))!);
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('192.0.2.1','192.0.2.2'));
  assert.throws(()=>openJournalStore({directory}),/corrupt/i);
});

test('the complete browser event including its IP counts toward store and writer byte admission',async t=>{
  const input=browser(),size=Buffer.byteLength(JSON.stringify(input)),directory=fixture(t);
  const policy={maxEventBytes:size-1};
  const store=openJournalStore({directory,policy});
  assert.deepEqual(store.append(input,NOW,0),{status:'invalid',reason:'event_too_large'});store.close();
  const writer=createJournalWriter({directory,policy,now:()=>NOW,externalReservedBytes:0});
  try {
    assert.deepEqual(await writer.write(input),{status:'invalid',reason:'event_too_large'});
    assert.equal((await writer.usage()).pendingCount,0);
  } finally {await writer.close();}
});

test('browser delivery uses the bounded worker and preserves first ACK and IP across a restart',async t=>{
  const directory=fixture(t);let now=NOW,release!:(bytes:number)=>void;
  const reservation=new Promise<number>(resolve=>{release=resolve;});
  let writer=createJournalWriter({directory,now:()=>now,externalReservedBytes:()=>reservation,policy:{maxPendingCount:1}});
  try {
    const pending=writer.write(browser());
    assert.deepEqual(await writer.write(browser(2)),{status:'retryable',reason:'journal_queue_full'});
    assert.deepEqual(lines(directory),[]);release(8*1024*1024);
    assert.deepEqual(await pending,{status:'accepted',receivedAt:NOW,duplicate:false});
    assert.equal(lines(directory)[0].deliveryIp,'192.0.2.1');await writer.close();
    now+=DAY;writer=createJournalWriter({directory,now:()=>now,externalReservedBytes:8*1024*1024});
    assert.deepEqual(await writer.write(browser(1,'2001:db8::3')),{status:'accepted',receivedAt:NOW,duplicate:true});
    assert.equal(lines(directory).length,1);assert.equal(lines(directory)[0].deliveryIp,'192.0.2.1');
  } finally {release?.(0);await writer.close();}
});

test('browser records share the existing budget and lose dedup after oldest-first eviction',t=>{
  const directory=fixture(t),policy={maxBytes:800000,maxEventBytes:1024,maxPendingBytes:4096,
    maxPendingCount:8,maxBatchBytes:2048,segmentBytes:2048},external=360000;
  const store=openJournalStore({directory,policy});
  try {
    assert.equal(store.append(browser(),NOW,external).status,'accepted');
    for(let i=2;i<=160;i++) {
      assert.equal(store.append(browser(i),NOW+i,external).status,'accepted');
      const usage=store.usage();assert.ok(usage.diskBytes+usage.bufferReservedBytes+usage.externalBytes<=policy.maxBytes);
    }
    assert.equal(lines(directory).some(line=>line.eventId===report().eventId),false);
    assert.deepEqual(store.append(browser(1,'2001:db8::4'),NOW+200,external),{status:'accepted',receivedAt:NOW+200,duplicate:false});
    assert.equal(lines(directory).find(line=>line.eventId===report().eventId)?.deliveryIp,'2001:db8::4');
  } finally {store.close();}
});
