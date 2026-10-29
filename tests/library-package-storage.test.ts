import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {openDatabase} from '../server/storage/database.ts';
import {createReturnPackets} from '../server/storage/library-packages.ts';
import {createAccountStorage} from '../server/storage/accounts.ts';
import {createChartRecords} from '../server/services/chart-records.ts';
import {createNatalDays,encodeNatalDayPacket} from '../server/services/natal-days.ts';
import {compressDayPacket} from '../server/packets/compression.ts';
import {decodeNatalDay} from '../shared/day-packets/decode.ts';
import {natalDayFixture} from './fixtures/natal-day.ts';
import {accountNatalChart,chartId} from './helpers/account-chart.ts';
import type {CycleChartResult} from '../shared/cycles-format.ts';

function library(t:test.TestContext) {
  const dir=mkdtempSync(path.join(tmpdir(),'forma-packages-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'forma.sqlite');
  const db=openDatabase(filename);t.after(()=>db.close());
  const accountId=String(createAccountStorage(db).ensureAccount('owner@example.test').id);
  const records=createChartRecords({database:db,authorize:()=>({accountId})});
  let operation=1;
  const intent=()=>({operationId:chartId(operation++),expectedAccountId:accountId});
  const add=(name:string,content:Partial<ReturnType<typeof accountNatalChart>>={})=>{
    const outcome=records.create({...intent(),content:{...accountNatalChart(),name,...content}});
    assert.equal(outcome.kind,'created');assert.ok('chartId' in outcome);return outcome.chartId;
  };
  return {db,filename,records,intent,add,accountId};
}

test('saved natal day survives expiry and a fresh database reader without computation or packing',async t=>{
  const f=library(t);f.add('A');let calculations=0,packs=0,now=0;
  const day=natalDayFixture({date:'2000-01-01'});
  day.columns[0]!.set([-0,0,Number.MIN_VALUE,307.62499999999994,307.625,359.99999999999994]);
  const first=createNatalDays({packages:f.records.packages,now:()=>now,
    generateDay:async()=>{calculations++;return day;},
    packDay:async value=>{packs++;return {bytes:await compressDayPacket(await encodeNatalDayPacket(value),{quality:9})};}});
  const expected=await first.get(day.date,day.timezone);now=600_001;
  assert.deepEqual((await first.get(day.date,day.timezone)).bytes,expected.bytes);
  const reopened=openDatabase(f.filename);t.after(()=>reopened.close());
  const records=createChartRecords({database:reopened,authorize:()=>({accountId:f.accountId})});
  const second=createNatalDays({packages:records.packages,
    generateDay:async()=>{assert.fail('saved day must not run Python after restart');},
    packDay:async()=>{assert.fail('saved day must not be compressed again');}});
  const restored=await second.get(day.date,day.timezone);
  assert.deepEqual(restored.bytes,expected.bytes);
  const decoded=decodeNatalDay(restored.bytes.identity);
  assert.deepEqual(decoded.columns.map(x=>Buffer.from(x.buffer)),day.columns.map(x=>Buffer.from(x.buffer)));
  assert.deepEqual({calculations,packs},{calculations:1,packs:1});
});

test('one shared day keeps independent card references; metadata makes no package writes',async t=>{
  const f=library(t),a=f.add('A'),b=f.add('B');let calls=0;
  const service=createNatalDays({packages:f.records.packages,generateDay:async(date,timezone)=>{calls++;return natalDayFixture({date,timezone});}});
  await service.get('2000-01-01','UTC');
  const count=()=>f.db.connection.prepare('SELECT count(*) AS n FROM library_natal_days').get()!.n;
  assert.equal(count(),1);
  const before=f.db.connection.prepare('SELECT total_changes() AS n').get()!.n as number;
  f.records.update({...f.intent(),chartId:a,name:'Renamed'});
  assert.equal((f.db.connection.prepare('SELECT total_changes() AS n').get()!.n as number)-before,2,'only record and immutable outcome change');
  f.records.remove({...f.intent(),chartId:a});assert.equal(count(),1);
  const replacement=createNatalDays({packages:f.records.packages,generateDay:async()=>{assert.fail('B still owns this ready day');}});
  await replacement.get('2000-01-01','UTC');
  f.records.remove({...f.intent(),chartId:b});assert.equal(count(),0);
  assert.equal(calls,1);
});

test('a newly saved source adopts its ready RAM day; unreferenced days stay nondurable',async t=>{
  const f=library(t);let calls=0;
  const service=createNatalDays({packages:f.records.packages,generateDay:async(date,timezone)=>{calls++;return natalDayFixture({date,timezone});}});
  await service.get('2000-01-01','UTC');
  assert.equal(f.records.packages.readDay({date:'2000-01-01',timezone:'UTC'}),null);
  f.add('A');await service.get('2000-01-01','UTC');
  assert.ok(f.records.packages.readDay({date:'2000-01-01',timezone:'UTC'}));assert.equal(calls,1);
});

test('changing birth date detaches only its old source; a late packet cannot restore that link',async t=>{
  const f=library(t),id=f.add('A');let release!:()=>void;
  const service=createNatalDays({packages:f.records.packages,generateDay:async(date,timezone)=>{
    await new Promise<void>(resolve=>{release=resolve;});return natalDayFixture({date,timezone});}});
  const pending=service.get('2000-01-01','UTC');
  const birth={...f.records.getOwn(id)!,birthDate:'2000-01-02',utc:'2000-01-02T12:00:00Z'};
  f.records.update({...f.intent(),chartId:id,birth});release();await pending;
  assert.equal(f.records.packages.readDay({date:'2000-01-01',timezone:'UTC'}),null);
  assert.equal(f.db.connection.prepare('SELECT sourceKey FROM library_natal_day_refs WHERE chartId=?').get(id)!.sourceKey,
    JSON.stringify(['2000-01-02','UTC']));
});

test('an interrupted packet publication leaves no partial result and a later request can complete it',async t=>{
  const f=library(t);f.add('A');let calls=0;
  f.db.connection.exec("CREATE TRIGGER refuse_packet BEFORE INSERT ON library_natal_days BEGIN SELECT RAISE(ABORT,'write failed'); END;");
  const service=createNatalDays({packages:f.records.packages,generateDay:async(date,timezone)=>{calls++;return natalDayFixture({date,timezone});}});
  await assert.rejects(service.get('2000-01-01','UTC'),/write failed/);
  assert.equal(f.records.packages.readDay({date:'2000-01-01',timezone:'UTC'}),null);
  f.db.connection.exec('DROP TRIGGER refuse_packet');await service.get('2000-01-01','UTC');
  assert.ok(f.records.packages.readDay({date:'2000-01-01',timezone:'UTC'}));
  assert.equal(calls,1,'retrying persistence must reuse the completed packet');
});

test('corrupted stored bytes are rejected and regenerated only for the still saved source',async t=>{
  const f=library(t);f.add('A');let calls=0;
  const make=()=>createNatalDays({packages:f.records.packages,generateDay:async(date,timezone)=>{calls++;return natalDayFixture({date,timezone});}});
  const expected=await make().get('2000-01-01','UTC');
  f.db.connection.exec("UPDATE library_natal_days SET br=x'00'");
  assert.deepEqual((await make().get('2000-01-01','UTC')).bytes,expected.bytes);assert.equal(calls,2);
});

test('a source mismatch or inconsistent wire representation cannot publish a saved day',async t=>{
  const f=library(t);f.add('A');
  const source={date:'2000-01-01',timezone:'UTC'};
  const packet=async(date:string,timezone:string)=>({bytes:await compressDayPacket(await encodeNatalDayPacket(natalDayFixture({date,timezone,samples:10})),{quality:4})});
  const good=await packet(source.date,source.timezone);
  const otherDate=await packet('2000-01-02','UTC'),otherZone=await packet(source.date,'Europe/Berlin');
  for(const invalid of [otherDate,otherZone,{bytes:{...good.bytes,br:otherDate.bytes.br}},
    {bytes:{...good.bytes,gzip:otherDate.bytes.gzip}},{bytes:{...good.bytes,identity:good.bytes.identity.subarray(0,30)}}]) {
    assert.throws(()=>f.records.packages.putDay(source,invalid));
    assert.equal(f.records.packages.readDay(source),null);
  }
  assert.equal(f.records.packages.putDay(source,good),'stored');
  assert.equal(f.records.packages.putDay(source,good),'no-op');
});

test('prepared primary return is compressed once and restores exact floating point values',t=>{
  const f=library(t),id=f.add('A'),birth=f.records.getOwn(id)!;
  const input={birthUtc:birth.utc,timezone:'UTC',body:'saturn',eventUtc:'2029-01-01T12:00:00Z'};
  const result:CycleChartResult={chart:{...structuredClone(birth),source:'calculated',timezone:'UTC',
    utc:input.eventUtc,designUtc:'2028-10-10T01:00:00Z',designArcResidualDegrees:1e-9}};
  result.chart.activations.personality[0]!.longitude=-0;
  result.chart.activations.personality[1]!.longitude=Number.MIN_VALUE;
  result.chart.activations.personality[2]!.longitude=307.62499999999994;
  const query={chartId:id,expectedAccountId:f.accountId,birth,action:'chart' as const,input};
  f.records.saveReturn(query,result);
  const stored=f.records.readReturn(query) as CycleChartResult;
  assert.deepEqual(Buffer.from(new Float64Array(stored.chart.activations.personality.map(item=>item.longitude)).buffer),
    Buffer.from(new Float64Array(result.chart.activations.personality.map(item=>item.longitude)).buffer));
  assert.equal(f.db.connection.prepare('SELECT typeof(content) AS type FROM account_chart_returns').get()!.type,'blob');
  const before=f.db.connection.prepare('SELECT total_changes() AS n').get()!.n;
  f.records.saveReturn(query,result);f.records.readReturn(query);
  assert.equal(f.db.connection.prepare('SELECT total_changes() AS n').get()!.n,before);
});

test('return reads and identical saves after reopening never recompress or write',t=>{
  const f=library(t),chartId=f.add('A');let compressions=0;
  const packets=createReturnPackets(f.db,{compress:raw=>{compressions++;return gzipSync(raw);}});
  const address={chartId,action:'events' as const,body:'saturn',eventUtc:''};
  const value={events:[],exact:[-0,Number.MIN_VALUE,307.62499999999994]};
  assert.equal(packets.save(address,value),true);
  const before=f.db.connection.prepare('SELECT total_changes() AS n').get()!.n;
  for(let i=0;i<4;i++) {
    assert.deepEqual(packets.read(address),value);
    assert.equal(packets.save(address,value),false);
  }
  assert.equal(compressions,1);
  assert.equal(f.db.connection.prepare('SELECT total_changes() AS n').get()!.n,before);
  const reopened=openDatabase(f.filename);t.after(()=>reopened.close());
  const next=createReturnPackets(reopened,{compress:()=>assert.fail('stored data needs no compression')});
  assert.deepEqual(next.read(address),value);assert.equal(next.save(address,value),false);
  assert.equal(reopened.connection.prepare('SELECT total_changes() AS n').get()!.n,0);
});

test('failed replacement leaves the previous return intact and corruption removes only its own part',t=>{
  const f=library(t),chartId=f.add('A');
  const packets=createReturnPackets(f.db),address={chartId,action:'events' as const,body:'saturn',eventUtc:''};
  const other={...address,body:'moon'},value={events:[]};
  packets.save(address,value);packets.save(other,value);
  f.db.connection.exec("CREATE TRIGGER refuse_return BEFORE UPDATE ON account_chart_returns BEGIN SELECT RAISE(ABORT,'write failed'); END;");
  assert.throws(()=>packets.save(address,{events:[{utc:'2029-01-01T12:00:00Z'}]}),/write failed/);
  assert.deepEqual(packets.read(address),value);
  f.db.connection.exec("DROP TRIGGER refuse_return; UPDATE account_chart_returns SET content=x'00' WHERE body='saturn'");
  assert.equal(packets.read(address),null);assert.deepEqual(packets.read(other),value);
  assert.equal(packets.save(address,value),true);
});

test('invalid packed representation or changed integrity metadata cannot become a ready return',t=>{
  const f=library(t),chartId=f.add('A'),address={chartId,action:'events' as const,body:'saturn',eventUtc:''};
  const packets=createReturnPackets(f.db),value={events:[]};
  const invalid=createReturnPackets(f.db,{compress:()=>gzipSync('{}')});
  assert.throws(()=>invalid.save(address,value),/Invalid compressed return/);
  assert.equal(packets.read(address),null);
  assert.throws(()=>packets.save(address,undefined),/Invalid prepared return/);
  assert.throws(()=>packets.save(address,'x'.repeat(2_000_001)),/Invalid prepared return/);
  packets.save(address,value);
  f.db.connection.exec("UPDATE account_chart_returns SET rawDigest='broken'");
  assert.equal(packets.read(address),null);
  assert.equal(packets.save(address,value),true);
});

function legacyReturns(t:test.TestContext) {
  const f=library(t),chartId=f.add('A'),sql=f.db.connection;
  sql.exec(`DROP TABLE account_chart_returns;
    CREATE TABLE account_chart_returns (
      chartId TEXT NOT NULL REFERENCES account_charts(id) ON DELETE CASCADE,
      action TEXT NOT NULL,body TEXT NOT NULL,eventUtc TEXT NOT NULL,content TEXT NOT NULL,
      PRIMARY KEY(chartId,action,body,eventUtc)
    ) STRICT;`);
  const insert=sql.prepare('INSERT INTO account_chart_returns VALUES(?,?,?,?,?)');
  const address={chartId,action:'events' as const,body:'saturn',eventUtc:''};
  insert.run(chartId,'events','saturn','','{"events":[],"exact":[-0,5e-324,307.62499999999994]}');
  insert.run(chartId,'events','moon','','{"events":[]}');
  const rows=()=>sql.prepare('SELECT * FROM account_chart_returns ORDER BY body').all();
  return {...f,address,rows};
}

test('interrupted legacy return migration rolls back every part and restarts without numeric changes',t=>{
  const f=legacyReturns(t),before=f.rows();let compressions=0;
  assert.throws(()=>createReturnPackets(f.db,{compress:raw=>{
    if(++compressions===2)throw Error('interrupted');return gzipSync(raw);
  }}),/interrupted/);
  assert.deepEqual(f.rows(),before);
  assert.equal(f.db.connection.prepare("SELECT name FROM sqlite_master WHERE name='account_chart_returns_next'").get(),undefined);
  compressions=0;
  const migrated=createReturnPackets(f.db,{compress:raw=>{compressions++;return gzipSync(raw);}});
  assert.deepEqual(migrated.read(f.address),{events:[],exact:[-0,Number.MIN_VALUE,307.62499999999994]});
  assert.equal(compressions,2);
  assert.ok(f.rows().every(row=>row.content instanceof Uint8Array));
  assert.deepEqual(createReturnPackets(f.db,{compress:()=>assert.fail('migration is once only')}).read(f.address),migrated.read(f.address));
});

for(const {date,samples,segments} of [
  {date:'2025-03-30',samples:1380,segments:[
    {index:0,startUtc:'2025-03-29T23:00:00Z',offsetSeconds:3600,utcOffset:'UTC+01:00',fold:0},
    {index:120,startUtc:'2025-03-30T01:00:00Z',offsetSeconds:7200,utcOffset:'UTC+02:00',fold:0}]},
  {date:'2025-10-26',samples:1500,segments:[
    {index:0,startUtc:'2025-10-25T22:00:00Z',offsetSeconds:7200,utcOffset:'UTC+02:00',fold:0},
    {index:180,startUtc:'2025-10-26T01:00:00Z',offsetSeconds:3600,utcOffset:'UTC+01:00',fold:1},
    {index:240,startUtc:'2025-10-26T02:00:00Z',offsetSeconds:3600,utcOffset:'UTC+01:00',fold:0}]},
])test(`persistent day preserves all ${samples} minutes, UTC and Design columns`,async t=>{
  const f=library(t),timezone='Europe/Berlin',day=natalDayFixture({date,timezone,samples,segments});
  f.add('A',{birthDate:date,timezone,utc:date+'T12:00:00Z'});
  await createNatalDays({packages:f.records.packages,generateDay:async()=>day}).get(date,timezone);
  const stored=f.records.packages.readDay({date,timezone});assert.ok(stored);
  const restored=decodeNatalDay(stored.bytes.identity);
  assert.deepEqual(restored.segments,segments);
  assert.deepEqual(restored.columns.map(x=>Buffer.from(x.buffer)),day.columns.map(x=>Buffer.from(x.buffer)));
});
