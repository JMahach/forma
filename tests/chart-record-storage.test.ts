import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/storage/database.ts';
import { createAccountStorage } from '../server/storage/accounts.ts';
import { createChartRecordStorage } from '../server/storage/chart-records.ts';
import { accountNatalChart } from './helpers/account-chart.ts';
import {canonicalChartId} from '../shared/chart-record-contract.ts';
import type { AccountChart } from '../shared/chart-record-contract.ts';

function fixture(t: test.TestContext) {
  const database = openDatabase(':memory:');
  t.after(() => database.close());
  const accounts = createAccountStorage(database);
  const a = String(accounts.ensureAccount('a@example.test').id), b = String(accounts.ensureAccount('b@example.test').id);
  const prepare = database.connection.prepare.bind(database.connection), compilations = new Map<string, number>();
  database.connection.prepare = query => {
    compilations.set(query, (compilations.get(query) ?? 0) + 1);
    return prepare(query);
  };
  const storage = createChartRecordStorage(database);
  const content = ({ id, accountId, revision, noteRevision, publicRevision, ...value }: AccountChart) => value;
  const insert = (row: AccountChart) => storage.insert(row, row.name, 1, content(row));
  return { database, storage, a, b, compilations, content, insert };
}

test('repeated library reads reuse SQL instructions while returning fresh, account-specific records', t => {
  const f = fixture(t), own = accountNatalChart(1, f.a), other = accountNatalChart(2, f.b);
  f.insert(own); f.insert(other);
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(f.storage.get(f.a, own.id), own);
    assert.equal(f.storage.get(f.b, own.id), null);
    assert.deepEqual(f.storage.shared(other.id), other);
    assert.deepEqual(f.storage.match(f.a, own.name, 1), own);
    assert.deepEqual(f.storage.list(f.b), [other]);
    assert.deepEqual(f.storage.page(f.a, '', 1), [own]);
    assert.deepEqual(f.storage.page(f.a, own.id, 1), []);
    f.storage.get(f.a, own.id)!.note = 'Only this returned object';
    assert.equal(f.storage.get(f.a, own.id)!.note, own.note);
  }
  for (const [query, count] of f.compilations) assert.equal(count, 1, `SQL prepared again: ${query}`);
});

test('reused writes observe rollback, constraints, current return versions and cascade deletion', t => {
  const f = fixture(t), own = accountNatalChart(1, f.a);
  f.insert(own);
  assert.throws(() => f.insert(own), /UNIQUE/);
  const second = accountNatalChart(2, f.a); f.insert(second);
  assert.throws(() => f.database.transaction(() => {
    f.storage.update({ ...own, revision: 2 }, own.name, 1, { ...f.content(own), note: 'Rolled back' });
    throw Error('rollback');
  }), /rollback/);
  assert.deepEqual(f.storage.get(f.a, own.id), own);
  const revised = { ...own, revision: 2, noteRevision: 2, note: 'Committed' };
  assert.equal(f.storage.update(revised, own.name, 1, f.content(revised)), true);
  assert.deepEqual(f.storage.get(f.a, own.id), revised);
  assert.equal(f.storage.update({ ...revised, accountId: f.b }, own.name, 1, f.content(revised)), false);

  for (const version of ['old', 'new']) {
    const result = { events: [], version };
    f.storage.saveReturn(own.id, 'events', 'saturn', '', 'numbers', version, result);
    assert.deepEqual(f.storage.readReturn(own.id, 'events', 'saturn', '', 'numbers', version), result);
    assert.equal(f.storage.readReturn(own.id, 'events', 'saturn', '', 'other-numbers', version), null);
  }
  assert.equal(f.storage.readReturn(own.id, 'events', 'saturn', '', 'numbers', 'old'), null);
  f.storage.clearOldReturns('numbers', 'new');
  assert.ok(f.storage.readReturn(own.id, 'events', 'saturn', '', 'numbers', 'new'));
  f.storage.clearReturns(own.id);
  assert.equal(f.storage.readReturn(own.id, 'events', 'saturn', '', 'numbers', 'new'), null);
  f.storage.saveReturn(second.id, 'events', 'saturn', '', 'numbers', 'new', { events: [] });
  assert.equal(f.storage.remove(f.b, second.id), false);
  assert.equal(f.storage.remove(f.a, second.id), true);
  assert.equal(f.storage.readReturn(second.id, 'events', 'saturn', '', 'numbers', 'new'), null);

  const outcome = { kind: 'updated', chartId: own.id, revision: 2 } as const;
  for (const account of [f.a, f.b]) f.storage.saveOutcome(account, 'operation', 100, outcome);
  assert.deepEqual(f.storage.outcome(f.a, 'operation'), { createdAt: 100, outcome });
  f.storage.removeOutcome(f.a, 'operation');
  assert.equal(f.storage.outcome(f.a, 'operation'), null);
  assert.ok(f.storage.outcome(f.b, 'operation'));
  f.storage.cleanup(99); assert.ok(f.storage.outcome(f.b, 'operation'));
  f.storage.cleanup(100); assert.equal(f.storage.outcome(f.b, 'operation'), null);
  for (const [query, count] of f.compilations) assert.equal(count, 1, `SQL prepared again: ${query}`);
});

test('39-digit IDs shorten atomically with owner, notes, returns and write outcomes preserved',t=>{
 const f=fixture(t),id='123456789012345678901234567890123456789',short=id.slice(0,10);
 const row={...accountNatalChart(1,f.a),id};f.insert(row);
 f.storage.saveReturn(id,'events','saturn','','numbers','cycles',{events:[]});
 f.storage.saveOutcome(f.a,'1'.repeat(32),100,{kind:'created',chartId:id,revision:1});
 const migrated=createChartRecordStorage(f.database,canonicalChartId);
 assert.deepEqual(migrated.get(f.a,short),{...row,id:short});assert.equal(migrated.get(f.b,short),null);
 assert.equal(migrated.get(f.a,id),null);
 assert.deepEqual(migrated.readReturn(short,'events','saturn','','numbers','cycles'),{events:[]});
 assert.equal(migrated.outcome(f.a,'1'.repeat(32))?.outcome.chartId,short);
 assert.deepEqual(f.database.connection.prepare('PRAGMA foreign_key_check').all(),[]);
 assert.deepEqual(createChartRecordStorage(f.database,canonicalChartId).list(f.a),[{...row,id:short}]);
});

test('a prefix collision aborts shortening without changing either record',t=>{
 const f=fixture(t),a={...accountNatalChart(1,f.a),id:'1234567890'+'1'.repeat(29)},b={...accountNatalChart(2,f.a),id:'1234567890'+'2'.repeat(29)};
 f.insert(a);f.insert(b);
 assert.throws(()=>createChartRecordStorage(f.database,canonicalChartId),/short_chart_id_collision/);
 assert.deepEqual(f.storage.get(f.a,a.id),a);assert.deepEqual(f.storage.get(f.a,b.id),b);
});

test('a backup without schema markers migrates outcome-only issued IDs, and failed migration leaves no marker',t=>{
 const f=fixture(t),old='2345678901'+'7'.repeat(29),other='2345678901'+'8'.repeat(29);
 f.database.connection.exec('DROP TABLE chart_storage_migrations');
 f.storage.saveOutcome(f.a,'a'.repeat(32),100,{kind:'deleted',chartId:old});
 f.storage.saveOutcome(f.a,'b'.repeat(32),100,{kind:'deleted',chartId:other});
 assert.throws(()=>createChartRecordStorage(f.database,canonicalChartId),/short_chart_id_collision/);
 assert.equal(f.database.connection.prepare('SELECT count(*) n FROM chart_storage_migrations').get()!.n,0);
 assert.equal(f.storage.outcome(f.a,'a'.repeat(32))!.outcome.chartId,old);
 f.storage.removeOutcome(f.a,'b'.repeat(32));
 const migrated=createChartRecordStorage(f.database,canonicalChartId);
 assert.equal(migrated.outcome(f.a,'a'.repeat(32))!.outcome.chartId,old.slice(0,10));
 assert.equal(migrated.identifierUsed(old.slice(0,10)),true);
 assert.equal(f.database.connection.prepare('SELECT count(*) n FROM chart_storage_migrations').get()!.n,2);
 // Old binaries ignore the additive markers. Their existing inserts still reserve every issued address.
 f.insert({...accountNatalChart(5,f.a),id:'3456789012'});
 assert.equal(createChartRecordStorage(f.database,canonicalChartId).identifierUsed('3456789012'),true);
});
