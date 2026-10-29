import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateCalculationMetadata, migrateDayPacket, migrateCalculationKey, migrateLifetimeFileMetadata } from '../shared/calculation-storage-transition.ts';
import { encodeNatalDay, encodeTransitDay } from '../server/packets/encode.ts';
import { decodeNatalDay, decodeTransitDay } from '../shared/day-packets/decode.ts';
import { natalDayFixture } from './fixtures/natal-day.ts';
import { accountChart } from './helpers/account-chart.ts';
import { openDatabase, type Database } from '../server/storage/database.ts';
import { createChartRecordStorage } from '../server/storage/chart-records.ts';
import { migrateStoredCalculations } from '../server/storage/calculation-transition.ts';
import { LIFETIME_FILE_VERSION, LIFETIME_FILE_FORMAT, LIFETIME_FIELDS } from '../shared/lifetime-format.ts';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IDBFactory, IDBCursorWithValue, IDBObjectStore } from 'fake-indexeddb';
import { createAccountLibraryStore } from '../src/data/account-library-store.ts';
import { createIndexedDatabase } from '../src/data/indexed-db.ts';
import { migrateAccountCalculations } from '../src/data/account-calculation-transition.ts';
import { migrateCalculationCache } from '../src/data/calculation-cache-transition.ts';
import { createCalculationCache } from '../src/data/calculation-cache.ts';
import { estimateBytes } from '../src/data/memory-cache.ts';
import fs from 'node:fs/promises';
import { migratePreparedLifetimeFile } from '../server/services/lifetime-transition.ts';
import { lifetimeFileFixture } from './helpers/lifetime-file.ts';

const revision = 'a'.repeat(64);
const payload = (packet:Uint8Array) => packet.subarray(8 + new DataView(packet.buffer, packet.byteOffset).getUint32(4, true));

test('removing calculation metadata preserves record numbers, ownership and format revisions without mutating the source', () => {
  const source = {...accountChart(), engine:'Swiss Ephemeris 2.10.03', version:'3', cacheVersion:revision, cyclesVersion:revision};
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
    const original = encodeNatalDay({...day, calculationVersion:revision, engine:'Swiss Ephemeris 2.10.03'});
    const before = original.slice(), migrated = migrateDayPacket('natal', original);
    assert.deepEqual(payload(migrated), payload(original));
    const decoded = decodeNatalDay(migrated);
    assert.deepEqual(decoded.columns, day.columns);
    assert.deepEqual(decoded.segments, day.segments);
    assert.equal(decoded.calculationVersion, undefined);
    assert.equal(decoded.engine, 'Swiss Ephemeris');
    assert.deepEqual(original, before);
    assert.equal(migrateDayPacket('natal', migrated), migrated);
  }
  const transit = encodeTransitDay({...days[0], calculationVersion:revision, engine:'Swiss Ephemeris 2.10.03'});
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
  const charts = [accountChart(1), accountChart(2)].map(chart => ({...chart, engine:'Swiss Ephemeris 2.10.03'}));
  for (const chart of charts) {
    storage.insert(chart, chart.name, Date.parse(chart.utc) / 60000, chart);
    storage.saveReturn(chart.id, 'chart', 'saturn', '2029-01-01T01:23:45.654321Z', revision, revision, {chart, proof:'retained-proof'});
    storage.saveReturn(chart.id, 'events', 'saturn', '', revision, revision, {range:{fromAge:0, toAge:100}, events:[]});
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

test('each interrupted prepared-file write leaves either the original or complete new metadata; retry never rewrites planetary bytes', async t => {
  const fixture = await lifetimeFileFixture(t, 3), {file, metadataFile, metadata, bytes} = fixture;
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
  const fixture = await lifetimeFileFixture(t, 3), {file, metadataFile, metadata, bytes} = fixture;
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
  const storage = createAccountLibraryStore({indexedDB, databaseName:deviceName});
  const active = await storage.activate('1');
  assert.equal(active.status, 'stored');
  await storage.put(active.lease, [accountChart(1), accountChart(2)]);
  storage.close();
  return indexedDB;
}
function deviceDatabase(indexedDB:IDBFactory, version:number) {
  return createIndexedDatabase({indexedDB, databaseName:deviceName, version, stores:['charts','context'],
    upgrade:(_, tx) => migrateAccountCalculations(tx)});
}
function deviceRows(database:ReturnType<typeof createIndexedDatabase>) {
  return database.transaction('readonly', (tx, result) => {
    const charts = tx.objectStore('charts').getAll(), context = tx.objectStore('context').getAll();
    context.onsuccess = () => result({charts:charts.result, context:context.result});
  });
}

test('an IndexedDB schema transition retains card numbers, recency and account lease, and fences the old writer', async () => {
  const indexedDB = await storedDevice(), old = deviceDatabase(indexedDB, 3);
  const before = await deviceRows(old) as {charts:unknown[];context:unknown[]}; old.close();
  const current = deviceDatabase(indexedDB, 4);
  try {
    const after = await deviceRows(current) as typeof before;
    assert.deepEqual(after.context, before.context);
    assert.deepEqual(after.charts, before.charts.map(row => migrateCalculationMetadata(row as ReturnType<typeof accountChart>)));
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
    const next = deviceDatabase(indexedDB, 4);
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
    const retry = deviceDatabase(indexedDB, 4);
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
  const indexedDB = new IDBFactory(), cache = createCalculationCache({indexedDB, databaseName:cacheName, legacySources:[], now:() => 100});
  const natal = `natal-day:${revision}:1:2026-09-24:city`, transit = `${revision}:2026-09-24`;
  const events = JSON.stringify(['events', revision, '2000-01-01T12:00:00.123456Z', 'saturn', 0, 100]);
  const chart = JSON.stringify(['chart', revision, '2000-01-01T12:00:00.123456Z', 'saturn', '2029-01-01T01:23:45.654321Z', 'Europe/Moscow']);
  const packet = encodeNatalDay({...natalDayFixture(), calculationVersion:revision, engine:'Swiss Ephemeris 2.10.03'});
  assert.equal(await cache.put('natal', natal, packet.slice().buffer, {version:revision}), true);
  assert.equal(await cache.put('return-events', events, {key:events, birthUtc:'2000-01-01T12:00:00.123456Z',
    body:'saturn', range:{fromAge:0, toAge:100}, events:[{utc:'2029-01-01T01:23:45.654321Z', cycle:1, pass:1, direction:'direct'}]}), true);
  assert.equal(await cache.put('return-charts', chart, {chart:accountChart(), event:{utc:'2029-01-01T01:23:45.654321Z'}}), true);
  assert.equal((await cache.setTransitWindow({version:revision, dates:['2026-09-24'], expiresAt:10000}))?.status, 'applied');
  assert.equal(await cache.put('transit', transit, {key:transit, day:new Float64Array([1, -0, Number.MIN_VALUE]),
    meta:{engine:'Swiss Ephemeris 2.10.03', ephemeris:'Swiss Ephemeris'}}, {version:revision, date:'2026-09-24'}), true);
  cache.close();
  const old = cacheDatabase(indexedDB, 2);
  await old.transaction('readwrite', (tx, result) => {
    // A still-accounted old physical row and its cursor must not be renamed:
    // the interrupted importer needs them to finish deleting the source.
    tx.objectStore('catalogue').put({id:'legacy-source-row', kind:'natal', key:natal, version:revision,
      bytes:1000, legacyBytes:600, lru:50, family:'natal', location:'legacy', personalEpoch:0,
      source:'natal', store:'packets', sourceKey:natal, stage:'copied'});
    tx.objectStore('control').put({key:'source:natal', definition:{id:'natal', databaseName:'bodygraph-chart-days',
      version:3, stores:['packets','metadata'], family:'natal'}, after:natal, storeIndex:0,
      scanned:false, finished:false, personalEpoch:0});
    const budget = tx.objectStore('control').get('budget');
    budget.onsuccess = () => {tx.objectStore('control').put({...budget.result, phase:'migrating', legacyBytes:600,
      accountedBytes:budget.result.accountedBytes + 1000}); result(true);};
  });
  const before = (await cacheRows(old))!; old.close();
  return {indexedDB, before, natal, transit, events, chart};
}

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
            value = encodeNatalDay({...day, calculationVersion:revision, engine:'Swiss Ephemeris 2.10.03'}).slice().buffer;
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
