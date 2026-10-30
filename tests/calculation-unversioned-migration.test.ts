import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateCalculationMetadata, migrateDayPacket, migrateCalculationKey, migrateLifetimeFileMetadata } from '../shared/calculation-storage-transition.ts';
import { encodeNatalDay, encodeTransitDay } from '../server/packets/encode.ts';
import { decodeNatalDay, decodeTransitDay } from '../shared/day-packets/decode.ts';
import { natalDayFixture } from './fixtures/natal-day.ts';
import { accountChart, accountNatalChart } from './helpers/account-chart.ts';
import { createReturnReceipts } from '../server/services/return-receipt.ts';
import { openDatabase, type Database } from '../server/storage/database.ts';
import { createChartRecordStorage } from '../server/storage/chart-records.ts';
import { migrateStoredCalculations } from '../server/storage/calculation-transition.ts';
import { LIFETIME_FILE_VERSION, LIFETIME_FILE_FORMAT, LIFETIME_FIELDS } from '../shared/lifetime-format.ts';
import { createHash, createHmac } from 'node:crypto';
import { normalizeMainReturn } from '../shared/chart-return-contract.ts';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IDBFactory, IDBCursorWithValue, IDBObjectStore } from 'fake-indexeddb';
import { createAccountLibraryStore } from '../src/data/account-library-store.ts';
import { createIndexedDatabase } from '../src/data/indexed-db.ts';
import { upgradeAccountLibrary } from '../src/data/account-library-schema.ts';
import { migrateCalculationCache } from '../src/data/calculation-cache-transition.ts';
import { createCalculationCache } from '../src/data/calculation-cache.ts';
import { createNatalDayStorage } from '../src/data/natal-day-storage.ts';
import { createNatalDayClient } from '../src/data/natal-day-client.ts';
import { estimateBytes } from '../src/data/memory-cache.ts';
import fs from 'node:fs/promises';
import { migratePreparedLifetimeFile } from '../server/services/lifetime-transition.ts';
import { lifetimeFileFixture } from './helpers/lifetime-file.ts';

const revision = 'a'.repeat(64);
const payload = (packet:Uint8Array) => packet.subarray(8 + new DataView(packet.buffer, packet.byteOffset).getUint32(4, true));

// Historical fixture bytes are built explicitly; the current encoder no longer emits these fields.
function historicalPacket(packet:Uint8Array, markers:Record<string,unknown>) {
  const length=new DataView(packet.buffer,packet.byteOffset).getUint32(4,true);
  const metadata=JSON.parse(new TextDecoder().decode(packet.subarray(8,8+length)));
  const header=new TextEncoder().encode(JSON.stringify({...metadata,...markers}));
  const numbers=payload(packet), result=new Uint8Array(8+header.byteLength+numbers.byteLength);
  result.set(packet.subarray(0,4));new DataView(result.buffer).setUint32(4,header.byteLength,true);
  result.set(header,8);result.set(numbers,8+header.byteLength);return result;
}

test('removing calculation metadata preserves record numbers, ownership and format revisions without mutating the source', () => {
  const source = {...accountChart(), calculationVersion:revision, engine:'Swiss Ephemeris 2.10.03', version:'3', cacheVersion:revision, cyclesVersion:revision};
  const before = structuredClone(source), result = migrateCalculationMetadata(source);
  const {calculationVersion, cyclesVersion, cacheVersion, ...expected} = before;
  assert.deepEqual(result, {...expected, engine:'Swiss Ephemeris'});
  assert.deepEqual(source, before);
  assert.equal(result.activations, source.activations, 'numeric arrays are reused, never recalculated');
  assert.equal(migrateCalculationMetadata(result), result, 'a finished transition does no further work');
  for (const invalid of [null, 1, [], {engine:1}])
    assert.throws(() => migrateCalculationMetadata(invalid as unknown as typeof source));
});

test('only calculation components leave persistent keys; exact input instants and format versions remain', () => {
  const natal = `natal-day:${revision}:1:2026-09-24:city:with:colon`;
  assert.equal(migrateCalculationKey('natal', natal), 'natal-day:1:2026-09-24:city:with:colon');
  assert.equal(migrateCalculationKey('transit', `${revision}:2026-09-24`), '2026-09-24');
  for (const [kind, parts] of [
    ['return-events', ['events', revision, '2000-01-01T12:00:00.123456Z', 'saturn', 0, 100]],
    ['return-charts', ['chart', revision, '2000-01-01T12:00:00.123456Z', 'saturn', '2029-01-01T01:23:45.654321Z', 'Europe/Moscow']],
  ] as const) {
    const expected = JSON.stringify([parts[0], ...parts.slice(2)]);
    assert.equal(migrateCalculationKey(kind, JSON.stringify(parts)), expected);
    assert.equal(migrateCalculationKey(kind, expected), expected);
  }
  assert.equal(migrateCalculationKey('natal', 'natal-day:1:2026-09-24:city:with:colon'), 'natal-day:1:2026-09-24:city:with:colon');
  assert.equal(migrateCalculationKey('transit', '2026-09-24'), '2026-09-24');
  assert.throws(() => migrateCalculationKey('natal', 'unrecognised:source'));
  assert.throws(() => migrateCalculationKey('return-charts', JSON.stringify(['events', revision, 'birth', 'saturn', 0, 100])));
  assert.equal(migrateCalculationKey('return-events', JSON.stringify(['events', null, '2000-01-01T12:00:00Z', 'saturn', 0, 100])),
    JSON.stringify(['events', '2000-01-01T12:00:00Z', 'saturn', 0, 100]));
  for (const invalid of [null, {}, ['events'], ['events', 'birth', 'saturn', 0, 100],
    ['events', 4, 'saturn', 0, 100], ['events', ['2000-01-01T12:00:00Z'], 'saturn', 0, 100],
    ['events', 'unknown', 'birth', 'saturn', 0, 100],
    ['events', [revision], 'birth', 'saturn', 0, 100], ['events', revision, 'birth', 'saturn', 0, 100, 'extra']])
    assert.throws(() => migrateCalculationKey('return-events', JSON.stringify(invalid)));
});

test('day transition rewrites only metadata and preserves every numeric byte for ordinary, short and long days', () => {
  const days = [
    natalDayFixture(),
    natalDayFixture({date:'2024-03-10', timezone:'America/New_York', samples:1380, segments:[
      {index:0, startUtc:'2024-03-10T05:00:00Z', offsetSeconds:-18000, utcOffset:'UTC−05:00', fold:0},
      {index:120, startUtc:'2024-03-10T07:00:00Z', offsetSeconds:-14400, utcOffset:'UTC−04:00', fold:0},
    ]}),
    natalDayFixture({date:'2024-11-03', timezone:'America/New_York', samples:1500, segments:[
      {index:0, startUtc:'2024-11-03T04:00:00Z', offsetSeconds:-14400, utcOffset:'UTC−04:00', fold:0},
      {index:120, startUtc:'2024-11-03T06:00:00Z', offsetSeconds:-18000, utcOffset:'UTC−05:00', fold:1},
      {index:180, startUtc:'2024-11-03T07:00:00Z', offsetSeconds:-18000, utcOffset:'UTC−05:00', fold:0},
    ]}),
  ];
  for (const day of days) {
    day.columns[0].set([-0, Number.MIN_VALUE, 359.99999999999994]);
    const original = historicalPacket(encodeNatalDay({...day, engine:'Swiss Ephemeris 2.10.03'}), {calculationVersion:revision});
    const before = original.slice(), migrated = migrateDayPacket('natal', original);
    assert.deepEqual(payload(migrated), payload(original));
    const decoded = decodeNatalDay(migrated);
    assert.deepEqual(decoded.columns, day.columns);
    assert.deepEqual(decoded.segments, day.segments);
    assert.equal(Object.hasOwn(decoded,'calculationVersion'),false);
    assert.equal(decoded.engine, 'Swiss Ephemeris');
    assert.deepEqual(original, before);
    assert.equal(migrateDayPacket('natal', migrated), migrated);
  }
  const transit = historicalPacket(encodeTransitDay({...days[0], engine:'Swiss Ephemeris 2.10.03'}), {calculationVersion:revision});
  const migrated = migrateDayPacket('transit', transit);
  assert.deepEqual(payload(migrated), payload(transit));
  assert.deepEqual(decodeTransitDay(migrated).columns, days[0].columns);
  assert.throws(() => migrateDayPacket('transit', transit.subarray(0, transit.length - 1)));
  assert.throws(() => migrateDayPacket('natal', transit));
});

function storedLibrary() {
  const database = openDatabase(':memory:');
  database.connection.exec('CREATE TABLE accounts (id INTEGER PRIMARY KEY) STRICT; INSERT INTO accounts VALUES (1)');
  const storage = createChartRecordStorage(database);
  // The historical physical return table is explicit: current producers must
  // no longer be able to create the obsolete format used by this fixture.
  database.connection.exec(`DROP TABLE IF EXISTS account_chart_returns;
    CREATE TABLE account_chart_returns (
      chartId TEXT NOT NULL REFERENCES account_charts(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK(action IN ('events','chart')),
      body TEXT NOT NULL, eventUtc TEXT NOT NULL,
      calculationVersion TEXT NOT NULL, cyclesVersion TEXT NOT NULL, content TEXT NOT NULL,
      PRIMARY KEY(chartId,action,body,eventUtc),
      CHECK((action='events' AND eventUtc='') OR (action='chart' AND length(eventUtc)>0))
    ) STRICT;
    CREATE INDEX account_chart_returns_versions ON account_chart_returns(calculationVersion,cyclesVersion);`);
  const insertReturn=database.connection.prepare('INSERT INTO account_chart_returns VALUES (?,?,?,?,?,?,?)');
  const charts = [accountChart(1), accountChart(2)].map(chart => ({...chart, calculationVersion:'current', engine:'Swiss Ephemeris 2.10.03'}));
  for (const chart of charts) {
    storage.insert(chart, chart.name, Date.parse(chart.utc) / 60000, chart);
    insertReturn.run(chart.id, 'chart', 'saturn', '2029-01-01T01:23:45.654321Z', revision, revision, JSON.stringify({chart, proof:'retained-proof'}));
    insertReturn.run(chart.id, 'events', 'saturn', '', revision, revision, JSON.stringify({range:{fromAge:0, toAge:100}, events:[]}));
  }
  return {database, charts};
}

function storedRows(database:Database) {
  const sql = database.connection;
  return {
    schema:sql.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),
    charts:sql.prepare('SELECT * FROM account_charts ORDER BY id').all(),
    returns:sql.prepare('SELECT * FROM account_chart_returns ORDER BY chartId,action').all(),
    ids:sql.prepare('SELECT * FROM chart_identifiers ORDER BY id').all(),
  };
}

// Real SQLite statements execute first, then the injected interruption forces
// the real transaction owner to roll back. No production fault hooks are added.
function interruptWrites(database:Database, interruptAt:number) {
  let writes = 0;
  const after = <T>(value:T) => { if (++writes === interruptAt) throw new Error('interrupted'); return value; };
  const connection = new Proxy(database.connection, {get(target, name) {
    if (name === 'exec') return (sql:string) => after(target.exec(sql));
    if (name === 'prepare') return (sql:string) => {
      const statement = target.prepare(sql);
      return new Proxy(statement, {get(target, name) {
        if (name === 'run') return (...args:Parameters<typeof target.run>) => after(target.run(...args));
        const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
      }});
    };
    const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
  }});
  return {database:{...database, connection}, count:()=>writes};
}

test('SQL transition preserves two cards sharing calculation input and all exact return data, then becomes a no-op', () => {
  const {database, charts} = storedLibrary();
  try {
    const before = storedRows(database), instrumented = interruptWrites(database, Infinity);
    assert.equal(migrateStoredCalculations(instrumented.database), true);
    const after = storedRows(database);
    assert.deepEqual(after.ids, before.ids);
    assert.deepEqual(database.connection.prepare('PRAGMA foreign_key_check').all(), []);
    for (let i = 0; i < charts.length; i++) {
      assert.deepEqual(JSON.parse(after.charts[i].content as string), migrateCalculationMetadata(charts[i]));
      assert.deepEqual({...after.charts[i], content:before.charts[i].content}, {...before.charts[i]});
      const {calculationVersion, cyclesVersion, content, ...link} = before.returns[i * 2];
      assert.deepEqual({...after.returns[i * 2]}, {...link, content:JSON.stringify({chart:migrateCalculationMetadata(charts[i]), proof:'retained-proof'})});
      const {calculationVersion:oldCalculation, cyclesVersion:oldCycles, ...events} = before.returns[i * 2 + 1];
      assert.deepEqual({...after.returns[i * 2 + 1]}, events);
    }
    const writes = instrumented.count();
    assert.equal(migrateStoredCalculations(instrumented.database), false);
    assert.equal(instrumented.count(), writes, 'no repeat updates or schema writes');
    assert.deepEqual(storedRows(database), after);
  } finally { database.close(); }
});

test('every interrupted SQL write restores old schema, values and references; the next attempt succeeds', () => {
  const complete = storedLibrary(), instrumented = interruptWrites(complete.database, Infinity);
  migrateStoredCalculations(instrumented.database);
  const boundaries = instrumented.count(); complete.database.close();
  assert.equal(boundaries, 7, 'two cards, two returns, index and two columns');
  for (let at = 1; at <= boundaries; at++) {
    const {database} = storedLibrary();
    try {
      const before = storedRows(database), interrupted = interruptWrites(database, at);
      assert.throws(() => migrateStoredCalculations(interrupted.database), /interrupted/);
      assert.deepEqual(storedRows(database), before, `write ${at} rolls back data and schema together`);
      assert.equal(migrateStoredCalculations(database), true);
      assert.equal(migrateStoredCalculations(database), false);
    } finally { database.close(); }
  }
});

test('malformed SQL contents abort the transition without discarding the original row', () => {
  const {database} = storedLibrary();
  try {
    // This fixture represents a damaged backup predating prepared-day references.
    database.connection.exec('DROP TRIGGER library_natal_day_change; DROP INDEX account_charts_return_source');
    for (const content of ['not json', 'null', '42', '[]', '{"engine":23}']) {
      database.connection.prepare('UPDATE account_charts SET content=? WHERE id=(SELECT max(id) FROM account_charts)').run(content);
      const before = storedRows(database);
      assert.throws(() => migrateStoredCalculations(database));
      assert.deepEqual(storedRows(database), before);
    }
  } finally { database.close(); }
});

test('prepared lifetime metadata loses only calculation markers while its numeric file and checksum remain untouched', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forma-unversioned-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const file = path.join(directory, 'sample.f64le');
  const values = new Float64Array(Array.from({length:24}, (_, i) => i + 0.123456789));
  const bytes = Buffer.from(values.buffer);
  await writeFile(file, bytes);
  const before = await stat(file);
  const original = {version:LIFETIME_FILE_VERSION, format:LIFETIME_FILE_FORMAT, columns:[...LIFETIME_FIELDS],
    sampleCount:1, stepSeconds:600, flags:258, engine:'Swiss Ephemeris 2.10.03', bytes:bytes.length,
    startUtc:'2000-01-01T00:00:00Z', endExclusiveUtc:'2000-01-01T00:10:00Z',
    sha256:createHash('sha256').update(bytes).digest('hex'), generationSeconds:123,
    provenance:{version:'1', calculationFingerprint:revision},
    compatibility:{version:'1', change:'shared-date-limits', calculationFingerprint:revision, sha256:revision}};
  const migrated = migrateLifetimeFileMetadata(original);
  const {provenance, compatibility, ...expected} = original;
  assert.deepEqual(migrated, {...expected, engine:'Swiss Ephemeris'});
  for (const markers of [{provenance}, {compatibility}])
    assert.deepEqual(migrateLifetimeFileMetadata({...expected, ...markers}), migrated);
  assert.equal(migrateLifetimeFileMetadata(migrated), migrated);
  assert.deepEqual(await readFile(file), bytes);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  assert.equal(migrated.sha256, createHash('sha256').update(await readFile(file)).digest('hex'));
  assert.ok(original.provenance, 'transition leaves the input metadata intact until its owner commits');
  const metadataFile = path.join(directory, 'sample.metadata.json');
  await writeFile(metadataFile, JSON.stringify(original)); await fs.chmod(metadataFile, 0o640);
  const owner = await stat(metadataFile), group = process.getgroups?.().find(value => value !== owner.gid);
  if (group !== undefined) await fs.chown(metadataFile, owner.uid, group);
  assert.equal(await migratePreparedLifetimeFile({file, metadataFile}), true);
  assert.deepEqual(JSON.parse(await readFile(metadataFile, 'utf8')), migrated);
  assert.equal((await stat(metadataFile)).mode & 0o777, 0o640);
  assert.equal((await stat(metadataFile)).uid, owner.uid);
  assert.equal((await stat(metadataFile)).gid, group ?? owner.gid);
  assert.deepEqual(await readFile(file), bytes); assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  const finished = await stat(metadataFile);
  const open = fs.open; let repeatedNumericReads = 0;
  fs.open = (...args) => {if (args[0] === file) repeatedNumericReads++; return open(...args);};
  try {assert.equal(await migratePreparedLifetimeFile({file, metadataFile}), false);}
  finally {fs.open = open;}
  assert.equal(repeatedNumericReads, 0, 'a finished migration never scans the numeric file again');
  assert.equal((await stat(metadataFile)).mtimeMs, finished.mtimeMs, 'no repeat metadata write');
  await writeFile(metadataFile, JSON.stringify(original));
  const damaged = Buffer.from(bytes); damaged[0] ^= 1; await writeFile(file, damaged);
  await assert.rejects(migratePreparedLifetimeFile({file, metadataFile}));
  assert.deepEqual(await readFile(file), damaged, 'a corrupt source is never replaced or calculated again');
  assert.deepEqual(JSON.parse(await readFile(metadataFile, 'utf8')), original);
  await writeFile(file, Buffer.concat([bytes, Buffer.from([0])]));
  await assert.rejects(migratePreparedLifetimeFile({file, metadataFile}), /Invalid prepared numeric file/);
  assert.deepEqual(JSON.parse(await readFile(metadataFile, 'utf8')), original);
});

async function historicalLifetimeFixture(t:test.TestContext, count:number) {
  const fixture=await lifetimeFileFixture(t,count);
  const metadata={...fixture.metadata,engine:'Swiss Ephemeris 2.10.03',provenance:{version:'1',calculationFingerprint:revision}};
  await writeFile(fixture.metadataFile,JSON.stringify(metadata));return {...fixture,metadata};
}

test('each interrupted prepared-file write leaves either the original or complete new metadata; retry never rewrites planetary bytes', async t => {
  const fixture = await historicalLifetimeFixture(t, 3), {file, metadataFile, metadata, bytes} = fixture;
  const expected = migrateLifetimeFileMetadata(metadata), before = await stat(file);
  const open = fs.open, rename = fs.rename;
  let boundaries = 0;
  for (let at = 0; at <= boundaries; at++) {
    await writeFile(metadataFile, JSON.stringify(metadata));
    let writes = 0;
    const written = () => {if (++writes === at) throw new Error('interrupted');};
    fs.open = async (...args) => {
      const handle = await open(...args);
      if (args[1] === 'wx') {
        try {written();} catch (error) {await handle.close(); throw error;}
      }
      return new Proxy(handle, {get(target, key) {
        const value = Reflect.get(target, key);
        if (['writeFile','chown','chmod','sync'].includes(String(key))) return async (...values:unknown[]) => {
          const result = await value.apply(target, values); written(); return result;
        };
        return typeof value === 'function' ? value.bind(target) : value;
      }});
    };
    fs.rename = async (...args) => {await rename(...args); written();};
    try {
      if (at === 0) {
        assert.equal(await migratePreparedLifetimeFile(fixture), true); boundaries = writes;
        assert.ok(boundaries > 0 && boundaries <= 6, 'no redundant ownership update for the same owner');
        t.diagnostic(`prepared metadata: ${boundaries} first-publication effects; repeat: 0 numeric reads, 0 metadata writes, directory durability sync only`);
      }
      else await assert.rejects(migratePreparedLifetimeFile(fixture), /interrupted/);
    } finally {fs.open = open; fs.rename = rename;}
    const after = JSON.parse(await readFile(metadataFile, 'utf8'));
    assert.deepEqual(after, after.engine === 'Swiss Ephemeris' ? expected : metadata);
    assert.deepEqual(await readFile(file), bytes); assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
    await migratePreparedLifetimeFile(fixture);
    assert.deepEqual(JSON.parse(await readFile(metadataFile, 'utf8')), expected);
    assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ['sample.f64le','sample.metadata.json']);
  }
});

test('a metadata transition refuses concurrent changes to either source instead of publishing over them', async t => {
  const fixture = await historicalLifetimeFixture(t, 3), {file, metadataFile, metadata, bytes} = fixture;
  const open = fs.open;
  for (const changed of ['metadata', 'numeric']) {
    await writeFile(file, bytes); await writeFile(metadataFile, JSON.stringify(metadata));
    const altered = {...metadata, generationSeconds:999};
    fs.open = async (...args) => {
      const handle = await open(...args);
      if (args[1] === 'wx') {
        if (changed === 'metadata') await writeFile(metadataFile, JSON.stringify(altered));
        else {
          const data = Buffer.from(bytes); data[0] ^= 1; await writeFile(file, data);
          const info = await stat(file); await fs.utimes(file, info.atime, new Date(info.mtimeMs - 1000));
        }
      }
      return handle;
    };
    try {await assert.rejects(migratePreparedLifetimeFile(fixture), /Prepared inputs changed/);}
    finally {fs.open = open;}
    assert.deepEqual(JSON.parse(await readFile(metadataFile, 'utf8')), changed === 'metadata' ? altered : metadata);
    assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ['sample.f64le','sample.metadata.json']);
  }
});

const deviceName = 'transition-fixture';
async function storedDevice() {
  const indexedDB = new IDBFactory();
  const old = createIndexedDatabase({indexedDB, databaseName:deviceName, version:3, stores:['charts','context'],
    upgrade(db) {
      db.createObjectStore('charts',{keyPath:'id'}).createIndex('accessed','_accessedAt');
      db.createObjectStore('context',{keyPath:'key'});
    }});
  await old.transaction('readwrite',(tx,done)=>{
    tx.objectStore('context').put({key:'owner',accountId:'1',generation:'00112233-4455-6677-8899-aabbccddeeff'});
    for(const chart of [accountChart(1),accountChart(2)])tx.objectStore('charts').put({...chart,calculationVersion:'current',_accessedAt:0});
    done(true);
  }); old.close();
  return indexedDB;
}
function deviceDatabase(indexedDB:IDBFactory, version:number) {
  return createIndexedDatabase({indexedDB, databaseName:deviceName, version, stores:['charts','context'],
    upgrade:upgradeAccountLibrary});
}
function deviceRows(database:ReturnType<typeof createIndexedDatabase>) {
  return database.transaction<{charts:(ReturnType<typeof accountChart>&{_accessedAt:number;calculationVersion?:string})[];context:Record<string,unknown>[]}>('readonly', (tx, result) => {
    const charts = tx.objectStore('charts').getAll(), context = tx.objectStore('context').getAll();
    context.onsuccess = () => result({charts:charts.result, context:context.result});
  });
}

test('real SQL and account IDB owners activate the transition and read ready cards without repeat writes', async () => {
  const {database, charts} = storedLibrary();
  try {
    const measured = interruptWrites(database, Infinity), storage = createChartRecordStorage(measured.database);
    const writes = measured.count();
    for(const chart of charts) {
      assert.deepEqual(storage.get(chart.accountId, chart.id), migrateCalculationMetadata(chart));
      assert.deepEqual(storage.shared(chart.id), migrateCalculationMetadata(chart));
    }
    assert.equal(measured.count(), writes, 'ordinary reads never run the transition or rewrite records');
    assert.equal(migrateStoredCalculations(database), false);
  } finally {database.close();}
  const indexedDB = await storedDevice(), library = createAccountLibraryStore({indexedDB, databaseName:deviceName});
  const old = deviceDatabase(indexedDB, 3), before = (await deviceRows(old))!; old.close();
  const openCursor=IDBObjectStore.prototype.openCursor;let scans=0;
  IDBObjectStore.prototype.openCursor=function(...args){scans++;return openCursor.apply(this,args);};
  try {
    const read = await library.read();
    assert.deepEqual(read!.charts, [accountChart(1), accountChart(2)]);
    assert.equal(scans,1,'one schema pass migrates numerical metadata and lightweight use together');
    const raw = deviceDatabase(indexedDB, 7);
    try {
      const after = (await deviceRows(raw))!;
      assert.deepEqual(after.context, before.context);
      assert.deepEqual(after.charts, before.charts.map(({_accessedAt,...row}) => migrateCalculationMetadata(row)));
    } finally {raw.close();}
    const previousWriter = deviceDatabase(indexedDB, 3);
    try {assert.equal(await deviceRows(previousWriter), null);} finally {previousWriter.close();}
  } finally {IDBObjectStore.prototype.openCursor=openCursor;library.close();}
});

test('an IndexedDB schema transition retains card numbers, recency and account lease, and fences the old writer', async () => {
  const indexedDB = await storedDevice(), old = deviceDatabase(indexedDB, 3);
  const before = await deviceRows(old) as {charts:unknown[];context:unknown[]}; old.close();
  const current = deviceDatabase(indexedDB, 7);
  try {
    const after = await deviceRows(current) as typeof before;
    assert.deepEqual(after.context, before.context);
    assert.deepEqual(after.charts, before.charts.map(row => {const {_accessedAt,...card}=row as ReturnType<typeof accountChart>&{_accessedAt:number};return migrateCalculationMetadata(card);}));
    assert.deepEqual(await deviceRows(current), after);
    const oldWriter = deviceDatabase(indexedDB, 3);
    try { assert.equal(await deviceRows(oldWriter), null); } finally { oldWriter.close(); }
  } finally { current.close(); }
});

test('an interrupted IndexedDB card upgrade retains the original schema and every row before retry', async () => {
  const update = IDBCursorWithValue.prototype.update;
  for (const at of [1, 2]) {
    const indexedDB = await storedDevice(), old = deviceDatabase(indexedDB, 3);
    const before = await deviceRows(old); old.close();
    const next = deviceDatabase(indexedDB, 7);
    let writes = 0;
    IDBCursorWithValue.prototype.update = function(...args) {
      const result = update.apply(this, args);
      if (++writes === at) throw new Error('interrupted');
      return result;
    };
    try { assert.equal(await deviceRows(next), null); }
    finally { IDBCursorWithValue.prototype.update = update; next.close(); }
    const rollback = deviceDatabase(indexedDB, 3);
    assert.deepEqual(await deviceRows(rollback), before); rollback.close();
    const retry = deviceDatabase(indexedDB, 7);
    try { assert.ok(await deviceRows(retry)); } finally { retry.close(); }
  }
});

const cacheName = 'calculation-transition-fixture';
const cacheStores = ['payloads', 'catalogue', 'control'];
const cacheId = (kind:string, key:string) => JSON.stringify([kind, key]);
function cacheDatabase(indexedDB:IDBFactory, version:number) {
  return createIndexedDatabase({indexedDB, databaseName:cacheName, version, stores:cacheStores,
    upgrade:(db, tx) => {
      for (const name of cacheStores) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, {keyPath:name === 'control' ? 'key' : 'id'});
      migrateCalculationCache(tx);
    }});
}
function cacheRows(database:ReturnType<typeof createIndexedDatabase>) {
  return database.transaction<Record<string, any[]>>('readonly', (tx, result) => {
    const reads = Object.fromEntries(cacheStores.map(name => [name, tx.objectStore(name).getAll()]));
    reads.control.onsuccess = () => result(Object.fromEntries(Object.entries(reads).map(([name, read]) => [name, read.result])));
  });
}
async function storedCache() {
  const indexedDB=new IDBFactory(),old=cacheDatabase(indexedDB,2);
  const natal = `natal-day:${revision}:1:2026-09-24:city`, transit = `${revision}:2026-09-24`;
  const events = JSON.stringify(['events', revision, '2000-01-01T12:00:00.123456Z', 'saturn', 0, 100]);
  const chart = JSON.stringify(['chart', revision, '2000-01-01T12:00:00.123456Z', 'saturn', '2029-01-01T01:23:45.654321Z', 'Europe/Moscow']);
  const packet = historicalPacket(encodeNatalDay({...natalDayFixture(), engine:'Swiss Ephemeris 2.10.03'}), {calculationVersion:revision});
  const entries=[
    ['natal',natal,packet.slice().buffer],
    ['return-events',events,{key:events,birthUtc:'2000-01-01T12:00:00.123456Z',body:'saturn',range:{fromAge:0,toAge:100},
      events:[{utc:'2029-01-01T01:23:45.654321Z',cycle:1,pass:1,direction:'direct'}]}],
    ['return-charts',chart,{chart:{...accountChart(),engine:'Swiss Ephemeris 2.10.03'},event:{utc:'2029-01-01T01:23:45.654321Z'}}],
    ['transit',transit,{key:transit,day:new Float64Array([1,-0,Number.MIN_VALUE]),meta:{engine:'Swiss Ephemeris 2.10.03',ephemeris:'Swiss Ephemeris'}}],
  ] as const;
  await old.transaction('readwrite',(tx,result)=>{
    let accountedBytes=4096,clock=100;
    for(const [kind,key,value] of entries) {
      const id=cacheId(kind,key),payload={id,value},meta={id,kind,key,version:revision,bytes:0,lru:clock++,location:'data',
        family:kind==='natal'?'natal':kind==='transit'?'transit':'returns',personalEpoch:0,...(kind==='transit'?{date:'2026-09-24'}:{})};
      meta.bytes=estimateBytes(payload)+estimateBytes(meta);accountedBytes+=meta.bytes;
      tx.objectStore('payloads').put(payload);tx.objectStore('catalogue').put(meta);
    }
    // The unfinished import keeps its physical old address and checkpoint.
    tx.objectStore('catalogue').put({id:'legacy-source-row',kind:'natal',key:natal,version:revision,
      bytes:1000,legacyBytes:600,lru:50,family:'natal',location:'legacy',personalEpoch:0,
      source:'natal',store:'packets',sourceKey:natal,stage:'copied'});
    tx.objectStore('control').put({key:'source:natal',definition:{id:'natal',databaseName:'bodygraph-chart-days',
      version:3,stores:['packets','metadata'],family:'natal'},after:natal,storeIndex:0,scanned:false,finished:false,personalEpoch:0});
    tx.objectStore('control').put({key:'budget',phase:'migrating',accountedBytes:accountedBytes+1000,legacyBytes:600,clock,
      personalEpoch:0,revision:5,versions:{},window:{version:revision,dates:['2026-09-24'],expiresAt:10000,revision:1}});
    result(true);
  });
  const before=(await cacheRows(old))!;old.close();return {indexedDB,before,natal,transit,events,chart};
}

test('the real cache owner upgrades an unfinished old cache and the new natal client reads ready numbers without network', async t => {
  const {indexedDB,before,natal}=await storedCache();
  const cache=createCalculationCache({indexedDB,databaseName:cacheName,now:()=>100});t.after(()=>cache.close());
  let requests=0;
  const client=createNatalDayClient({persistentCache:createNatalDayStorage({cache}),fetch:async()=>{requests++;throw new Error('network must not run');}});
  const day=await client.getDay({birthDate:'2026-09-24',cityId:'city',timezone:'UTC'});
  const previous=decodeNatalDay(before.payloads.find(row=>row.id===cacheId('natal',natal))!.value);
  assert.deepEqual(day.columns,previous.columns);assert.deepEqual(day.segments,previous.segments);
  assert.equal(requests,0);assert.equal(Object.hasOwn(day,'calculationVersion'),false);
  const state=await cache.status();assert.equal(state.phase,'ready');assert.equal(state.legacyBytes,0);
  assert.equal(Object.hasOwn(state,'versions'),false);
  const oldWriter=cacheDatabase(indexedDB,2);
  try{assert.equal(await cacheRows(oldWriter),null);}finally{oldWriter.close();}
});

test('cache transition preserves the authenticated return snapshot so old ready numbers remain reusable', async () => {
  const {indexedDB, chart} = await storedCache(), old = cacheDatabase(indexedDB, 2);
  const [, , birthUtc, body, eventUtc, timezone] = JSON.parse(chart);
  const input = {birthUtc, body, eventUtc, timezone};
  const result = {chart:{...accountNatalChart(), utc:eventUtc, timezone, engine:'Swiss Ephemeris 2.10.03'}};
  const receipts = createReturnReceipts({key:new Uint8Array(32).fill(17)});
  const prepared = normalizeMainReturn('chart', input, result)!;
  const signature = createHmac('sha256', new Uint8Array(32).fill(17)).update('forma:return-receipt:v1\0')
    .update(JSON.stringify([revision, 'chart', prepared.input, prepared.result])).digest('base64url');
  const proof = `v1.${revision}.${signature}`;
  assert.ok(proof);
  const trusted = receipts.read('chart', input, result, proof);
  await old.transaction('readwrite', (tx, done) => {
    tx.objectStore('payloads').put({id:cacheId('return-charts', chart), value:{...result, proof}}); done(true);
    const normalizedKey = migrateCalculationKey('return-charts', chart), id = cacheId('return-charts', normalizedKey);
    const canonical = {...result, chart:{...result.chart, engine:'Swiss Ephemeris'}};
    tx.objectStore('payloads').put({id, value:{...canonical, proof:receipts.issue('chart', input, canonical)}});
    tx.objectStore('catalogue').put({id, kind:'return-charts', key:normalizedKey, bytes:1000, lru:0,
      family:'returns', location:'data', personalEpoch:0});
  }); old.close();
  const current = cacheDatabase(indexedDB, 3);
  try {
    const migrated = (await cacheRows(current))!.payloads.find(row => row.id === cacheId('return-charts', migrateCalculationKey('return-charts', chart)))!.value;
    assert.equal(migrated.proof, proof);
    assert.deepEqual(receipts.read('chart', input, migrated, migrated.proof), trusted);
    assert.equal(Object.hasOwn(migrated.chart, 'calculationVersion'), false);
  } finally {current.close();}
});

test('cache schema upgrade keeps ready numbers and unfinished source cursors, rekeys atomically and accounts the new bytes', async () => {
  const {indexedDB, before, natal, transit, events, chart} = await storedCache();
  const current = cacheDatabase(indexedDB, 3);
  try {
    const after = (await cacheRows(current))!;
    assert.equal(after.payloads.length, 4);
    for (const [kind, key] of [['natal', natal], ['transit', transit], ['return-events', events], ['return-charts', chart]] as const) {
      const original = before.payloads.find(row => row.id === cacheId(kind, key)).value;
      const value = after.payloads.find(row => row.id === cacheId(kind, migrateCalculationKey(kind, key))).value;
      if (kind === 'natal') assert.deepEqual(payload(new Uint8Array(value)), payload(new Uint8Array(original)));
      else if (kind === 'transit') {
        assert.deepEqual(value.day, original.day); assert.equal(value.key, '2026-09-24');
        assert.equal(value.meta.engine, 'Swiss Ephemeris');
      } else if (kind === 'return-events') assert.deepEqual(value, {...original, key:migrateCalculationKey(kind, key)});
      else assert.deepEqual(value, {...original, chart:migrateCalculationMetadata(original.chart)});
    }
    const source = after.control.find(row => row.key === 'source:natal');
    assert.equal(source.after, natal); assert.equal(source.definition.legacyDatabaseName, 'bodygraph-chart-days');
    assert.equal(Object.hasOwn(source.definition, 'databaseName'), false);
    assert.equal(JSON.stringify(source.definition), JSON.stringify({id:'natal', legacyDatabaseName:'bodygraph-chart-days',
      version:3, stores:['packets','metadata'], family:'natal'}), 'the unfinished importer still recognises its canonical source identity');
    const legacy = after.catalogue.find(row => row.location === 'legacy');
    assert.equal(legacy.id, 'legacy-source-row'); assert.equal(legacy.sourceKey, natal);
    assert.equal(legacy.key, migrateCalculationKey('natal', natal)); assert.equal(legacy.stage, 'copied');
    for (const row of after.catalogue) {
      assert.equal(Object.hasOwn(row, 'version'), false);
      const size = row.location === 'legacy' ? row.legacyBytes : estimateBytes(after.payloads.find(value => value.id === row.id));
      assert.equal(row.bytes, size + estimateBytes(row));
    }
    const budget = after.control.find(row => row.key === 'budget');
    assert.equal(Object.hasOwn(budget, 'versions'), false); assert.equal(Object.hasOwn(budget.window, 'version'), false);
    assert.equal(budget.accountedBytes, 4096 + after.catalogue.reduce((size, row) => size + row.bytes, 0));
    assert.equal(budget.legacyBytes, 600); assert.equal(budget.phase, 'migrating');
    assert.equal(budget.personalEpoch, before.control.find(row => row.key === 'budget').personalEpoch);
    assert.deepEqual(await cacheRows(current), after);
    current.close();
    const repeated = cacheDatabase(indexedDB, 4);
    const put = IDBObjectStore.prototype.put, remove = IDBObjectStore.prototype.delete;
    let writes = 0;
    IDBObjectStore.prototype.put = function(...args) {writes++; return put.apply(this, args);};
    IDBObjectStore.prototype.delete = function(...args) {writes++; return remove.apply(this, args);};
    try {assert.deepEqual(await cacheRows(repeated), after);}
    finally {IDBObjectStore.prototype.put = put; IDBObjectStore.prototype.delete = remove; repeated.close();}
    assert.equal(writes, 0, 'a finished migration performs no repeat payload, catalogue or control writes');
    const oldWriter = cacheDatabase(indexedDB, 2);
    assert.equal(await cacheRows(oldWriter), null); oldWriter.close();
  } finally { current.close(); }
});

test('a new empty calculation database needs no transition writes or invented budget', async () => {
  const database = cacheDatabase(new IDBFactory(), 3);
  try {assert.deepEqual(await cacheRows(database), {payloads:[], catalogue:[], control:[]});}
  finally {database.close();}
});

test('every interrupted cache migration write rolls back; a retry keeps the original ready results', async t => {
  const put = IDBObjectStore.prototype.put, remove = IDBObjectStore.prototype.delete;
  let boundaries = 0;
  for (let at = 0; at <= boundaries; at++) {
    const {indexedDB, before} = await storedCache();
    let writes = 0;
    const written = () => {if (++writes === at) throw new Error('interrupted');};
    IDBObjectStore.prototype.put = function(...args) {const result = put.apply(this, args); written(); return result;};
    IDBObjectStore.prototype.delete = function(...args) {const result = remove.apply(this, args); written(); return result;};
    const next = cacheDatabase(indexedDB, 3);
    try {
      const result = await cacheRows(next);
      if (at === 0) {
        assert.ok(result); boundaries = writes; assert.ok(boundaries > 0 && boundaries <= 19);
        t.diagnostic(`calculation cache: ${boundaries} first-transition writes; repeat: 0 writes`);
      }
      else assert.equal(result, null);
    } finally {
      IDBObjectStore.prototype.put = put; IDBObjectStore.prototype.delete = remove; next.close();
    }
    if (at === 0) continue;
    const rollback = cacheDatabase(indexedDB, 2);
    assert.deepEqual(await cacheRows(rollback), before); rollback.close();
    const retry = cacheDatabase(indexedDB, 3);
    assert.ok(await cacheRows(retry)); retry.close();
  }
});

test('a cache collision cannot treat different container types or account generations as the same result', async () => {
  for (const mismatch of ['typed-record', 'array-record', 'primitive-record', 'record-primitive', 'null-record', 'account']) {
    const {indexedDB, chart} = await storedCache(), old = cacheDatabase(indexedDB, 2);
    await old.transaction('readwrite', (tx, result) => {
      const id = cacheId('return-charts', chart), otherKey = chart.replace(revision, 'b'.repeat(64));
      const otherId = cacheId('return-charts', otherKey), read = tx.objectStore('payloads').get(id);
      read.onsuccess = () => {
        const left = read.result.value, right = structuredClone(left);
        if (mismatch === 'typed-record') {left.chart.city = {}; right.chart.city = new Uint8Array();}
        if (mismatch === 'array-record') {left.chart.city = {}; right.chart.city = [];}
        if (mismatch === 'primitive-record') {left.chart.city = {}; right.chart.city = false;}
        if (mismatch === 'record-primitive') {left.chart.city = 1; right.chart.city = {};}
        if (mismatch === 'null-record') {left.chart.city = null; right.chart.city = {};}
        tx.objectStore('payloads').put({id, value:left});
        tx.objectStore('payloads').put({id:otherId, value:right});
        tx.objectStore('catalogue').put({id:otherId, kind:'return-charts', key:otherKey, version:'b'.repeat(64),
          bytes:1000, lru:999, family:'returns', location:'data', personalEpoch:mismatch === 'account' ? 1 : 0}); result(true);
      };
    });
    const before = await cacheRows(old); old.close();
    const next = cacheDatabase(indexedDB, 3);
    assert.equal(await cacheRows(next), null, mismatch); next.close();
    const rollback = cacheDatabase(indexedDB, 2);
    assert.deepEqual(await cacheRows(rollback), before); rollback.close();
  }
});

test('colliding calculation keys merge identical ready data with latest recency but never silently choose different numbers', async () => {
  for (const kind of ['natal', 'transit', 'return-events', 'return-charts'] as const) for (const conflict of [false, true]) {
    const fixture = await storedCache(), {indexedDB} = fixture, old = cacheDatabase(indexedDB, 2);
    const key = fixture[kind === 'return-events' ? 'events' : kind === 'return-charts' ? 'chart' : kind];
    await old.transaction('readwrite', (tx, result) => {
      const other = key.replace(revision, 'b'.repeat(64)), id = cacheId(kind, other);
      const rows = tx.objectStore('payloads').get(cacheId(kind, key));
      rows.onsuccess = () => {
        let value = rows.result.value;
        if (conflict) {
          if (kind === 'natal') {
            const day = natalDayFixture(); day.columns[0][0] = 0.123456789;
            value = historicalPacket(encodeNatalDay({...day, engine:'Swiss Ephemeris 2.10.03'}), {calculationVersion:revision}).slice().buffer;
          } else if (kind === 'transit') value.day[1] = 0; // Preserve even the sign of zero.
          else if (kind === 'return-events') value.events[0].utc = '2029-01-01T01:23:45.654322Z';
          else value.chart.activations.personality[0].longitude = 0.123456789;
        }
        if (kind === 'return-events' || kind === 'return-charts') value.proof = 'distinct-receipt-for-the-same-numbers';
        tx.objectStore('payloads').put({id, value});
        tx.objectStore('catalogue').put({id, kind, key:other, version:'b'.repeat(64),
          bytes:1000, lru:999, family:'returns', location:'data', personalEpoch:0}); result(true);
      };
    });
    const before = await cacheRows(old); old.close();
    const next = cacheDatabase(indexedDB, 3);
    const after = await cacheRows(next); next.close();
    if (conflict) {
      assert.equal(after, null);
      const rollback = cacheDatabase(indexedDB, 2);
      assert.deepEqual(await cacheRows(rollback), before); rollback.close();
    } else {
      assert.equal(after!.payloads.length, 4);
      const result = after!.catalogue.find(row => row.kind === kind && row.location === 'data');
      assert.equal(result.lru, 999);
      assert.equal(result.key, migrateCalculationKey(kind, key));
      if (kind === 'return-events' || kind === 'return-charts')
        assert.equal(after!.payloads.find(row => row.id === result.id).value.proof, 'distinct-receipt-for-the-same-numbers');
    }
  }
});

test('missing or unreadable cache payload aborts rekeying without discarding its catalogue or source', async () => {
  for (const damaged of ['missing', 'packet', 'key', 'window', 'source', 'budget', 'budget-and-catalogue', 'budget-and-payloads', null, [], 42]) {
    const {indexedDB, natal, chart} = await storedCache(), old = cacheDatabase(indexedDB, 2);
    await old.transaction('readwrite', (tx, result) => {
      const id = cacheId('natal', natal);
      if (damaged === 'missing') tx.objectStore('payloads').delete(id);
      else if (damaged === 'packet') tx.objectStore('payloads').put({id, value:new ArrayBuffer(12)});
      else if (damaged === 'key') {
        const row = tx.objectStore('catalogue').get(id);
        row.onsuccess = () => tx.objectStore('catalogue').put({...row.result, key:'unknown'});
      } else if (damaged === 'window' || damaged === 'source') {
        const row = tx.objectStore('control').get(damaged === 'window' ? 'budget' : 'source:natal');
        row.onsuccess = () => tx.objectStore('control').put({...row.result,
          ...(damaged === 'window' ? {window:42} : {definition:[]})});
      } else if (typeof damaged === 'string' && damaged.startsWith('budget')) {
        tx.objectStore('control').delete('budget');
        if (damaged === 'budget-and-catalogue') tx.objectStore('catalogue').clear();
        if (damaged === 'budget-and-payloads') tx.objectStore('payloads').clear();
      } else tx.objectStore('payloads').put({id:cacheId('return-charts', chart), value:damaged});
      result(true);
    });
    const before = await cacheRows(old); old.close();
    const next = cacheDatabase(indexedDB, 3);
    assert.equal(await cacheRows(next), null); next.close();
    const rollback = cacheDatabase(indexedDB, 2);
    assert.deepEqual(await cacheRows(rollback), before); rollback.close();
  }
});


test('explicit prepared-data command transitions both files once and can be retried without calculation', async t => {
  const fixture=await historicalLifetimeFixture(t,3),directory=path.dirname(fixture.file);
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
  const {fileURLToPath}=await import('node:url');
  const {pythonExecutable,pythonEnvironment}=await import('../server/runtime/python.ts');
  const root=fileURLToPath(new URL('../',import.meta.url)),run=promisify(execFile),returns=path.join(directory,'returns with spaces.bin');
  await run(pythonExecutable(root),['-c',"import sys; from server.python.return_index import prepare_index; prepare_index(sys.argv[1], start=2451544.5, end=2451584.5, bodies=('north_node',))",returns],{cwd:root,env:pythonEnvironment()});
  const source=await readFile(returns),length=source.readUInt32LE(8),header=JSON.parse(source.subarray(44,44+length).toString());
  header.provenance=revision;const encoded=Buffer.from(JSON.stringify(header)),prefix=Buffer.from(source.subarray(0,44));
  prefix.writeUInt32LE(encoded.length,8);createHash('sha256').update(encoded).digest().copy(prefix,12);
  const payload=source.subarray(44+length);await writeFile(returns,Buffer.concat([prefix,encoded,payload]));
  const args=['scripts/migrate-prepared-calculations.ts','--lifetime',fixture.file,'--returns',returns];
  const first=await run(process.execPath,args,{cwd:root,env:process.env});
  assert.deepEqual(first.stdout.trim().split('\n').map(line=>JSON.parse(line).migrated),[true,true]);
  const complete=await readFile(returns),newLength=complete.readUInt32LE(8);
  assert.deepEqual(complete.subarray(44+newLength),payload);assert.deepEqual(await readFile(fixture.file),fixture.bytes);
  const repeat=await run(process.execPath,args,{cwd:root,env:process.env});
  assert.deepEqual(repeat.stdout.trim().split('\n').map(line=>JSON.parse(line).migrated),[false,false]);
  assert.deepEqual(await readFile(returns),complete);
  const {createLifetimeFile}=await import('../server/services/lifetime.ts');
  const reader=await createLifetimeFile(fixture);try {assert.deepEqual((await reader.getPoint(1)).longitudes,fixture.columns.slice(0,11).map(column=>column[1]));}finally {await reader.close();}
  await assert.rejects(run(process.execPath,['scripts/migrate-prepared-calculations.ts'],{cwd:root}),/Specify prepared files explicitly/);
});
