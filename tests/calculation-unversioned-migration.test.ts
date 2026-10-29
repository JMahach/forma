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
import { IDBFactory, IDBCursorWithValue } from 'fake-indexeddb';
import { createAccountLibraryStore } from '../src/data/account-library-store.ts';
import { createIndexedDatabase } from '../src/data/indexed-db.ts';
import { migrateAccountCalculations } from '../src/data/account-calculation-transition.ts';

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
