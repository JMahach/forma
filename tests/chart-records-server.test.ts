import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/storage/database.ts';
import { createAccountStorage } from '../server/storage/accounts.ts';
import { createChartRecords } from '../server/services/chart-records.ts';
import type { AccountChartContent, ChartWriteOutcome } from '../shared/chart-record-contract.ts';

function rejectedCode(result: ChartWriteOutcome) {
  assert.ok(result.kind === 'rejected');
  return result.code;
}
const HOUR = 60 * 60 * 1000;
const operation = (n: number) => n.toString(16).padStart(32, '0');
function content(overrides: Partial<AccountChartContent> = {}): AccountChartContent {
  return { name: 'Анна Иванова', note: 'Личная заметка', birthDate: '2000-01-01', birthTime: '12:00',
    birthPlace: 'UTC', source: 'calculated', personality: [1], design: [2],
    activations: { personality: [], design: [] }, utc: '2000-01-01T12:00:00Z',
    calculationVersion: 'test-calculation-version', ...overrides };
}
function fixture(t: {after(fn: () => void): void}) {
  const database = openDatabase(':memory:'); t.after(() => database.close());
  const accounts = createAccountStorage(database);
  const a = String(accounts.ensureAccount('a@example.test').id), b = String(accounts.ensureAccount('b@example.test').id);
  let account: string | null = a, time = 10 * HOUR, serial = 0;
  const records = createChartRecords({ database, authorize: () => account ? {accountId: account} : null,
    now: () => time, newId: () => (++serial).toString(16).padStart(32, '0') });
  return {database, records, a, b, now: () => time, setAccount(value: string | null) {account = value;},
    advance(ms: number) {time += ms;}, create(n = 1, value = content()) {
      return records.create({operationId: operation(n), expectedAccountId: a, content: value});
    }};
}

test('a lost result is read without repeating the write, including after the chart is deleted', t => {
  const f = fixture(t), result = f.create();
  assert.equal(result.kind, 'created');
  assert.deepEqual(f.records.outcome({operationId: operation(1), expectedAccountId: f.a}), result);
  f.records.remove({operationId: operation(2), expectedAccountId: f.a, chartId: result.chartId!});
  assert.equal(f.records.getOwn(result.chartId!), null);
  assert.deepEqual(f.create(1, content({name: 'Another request using the same ID'})), result);
  assert.equal(f.records.list().length, 0);
});

test('receipt expiry neither removes the chart nor turns an unknown outcome into failure', t => {
  const f = fixture(t), result = f.create();
  f.advance(48 * HOUR - 1);
  assert.deepEqual(f.records.outcome({operationId: operation(1), expectedAccountId: f.a}), result);
  f.advance(1); f.records.cleanup();
  assert.deepEqual(f.records.outcome({operationId: operation(1), expectedAccountId: f.a}), {kind: 'unknown'});
  assert.ok(f.records.getOwn(result.chartId!));
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS count FROM chart_operation_outcomes').get()!.count, 0);
});

test('deduplication compares normalized name and UTC minute, and preserves the existing content', t => {
  const f = fixture(t), first = f.create();
  const duplicate = f.create(2, content({name: ' АННА\tИВАНОВА ', utc: '2000-01-01T15:00:59+03:00', note: 'Must not replace'}));
  assert.equal(duplicate.kind, 'existing');
  assert.equal(duplicate.chartId, first.chartId);
  assert.equal(f.records.getOwn(first.chartId!)!.note, 'Личная заметка');
  assert.equal(f.records.getOwn(first.chartId!)!.utc, '2000-01-01T12:00:00Z');
  assert.equal(f.create(3, content({name: 'Другая Анна'})).kind, 'created');
  assert.equal(f.create(4, content({utc: '2000-01-01T12:01:00Z'})).kind, 'created');
  assert.equal(f.records.list().length, 3);
});

test('a note uses its shown revision without rolling back newer name and birth data', t => {
  const f = fixture(t), first = f.create(), id = first.chartId!;
  f.records.update({operationId: operation(2), expectedAccountId: f.a, chartId: id, name: 'Новое имя'});
  const note = f.records.update({operationId: operation(3), expectedAccountId: f.a, chartId: id,
    note: {value: 'Мой текст', seenRevision: 1}});
  assert.equal(note.kind, 'updated');
  assert.equal(f.records.getOwn(id)!.name, 'Новое имя');
  const conflict = f.records.update({operationId: operation(4), expectedAccountId: f.a, chartId: id,
    note: {value: 'Не показанную редакцию не стираем', seenRevision: 1}});
  assert.equal(conflict.kind, 'rejected');
  assert.equal(conflict.code, 'note_conflict');
  assert.equal(f.records.getOwn(id)!.note, 'Мой текст');
});

test('editing a removed chart cannot recreate it and editing into a duplicate changes neither record', t => {
  const f = fixture(t), first = f.create(), second = f.create(2, content({name: 'Вторая'}));
  const duplicate = f.records.update({operationId: operation(3), expectedAccountId: f.a,
    chartId: second.chartId!, name: 'Анна Иванова'});
  assert.equal(rejectedCode(duplicate), 'duplicate_chart');
  assert.equal(f.records.getOwn(second.chartId!)!.name, 'Вторая');
  f.records.remove({operationId: operation(4), expectedAccountId: f.a, chartId: first.chartId!});
  assert.equal(rejectedCode(f.records.update({operationId: operation(5), expectedAccountId: f.a,
    chartId: first.chartId!, name: 'Снова'})), 'not_found');
  assert.equal(f.records.list().length, 1);
});

test('authorization and the original intended account guard writes and result lookups', t => {
  const f = fixture(t), first = f.create();
  f.setAccount(f.b);
  assert.throws(() => f.create(2), {code: 'account_changed'});
  assert.throws(() => f.records.outcome({operationId: operation(1), expectedAccountId: f.a}), {code: 'account_changed'});
  assert.equal(f.records.getOwn(first.chartId!), null);
  assert.equal(f.records.list().length, 0);
  const own = f.records.create({operationId: operation(1), expectedAccountId: f.b, content: content()});
  assert.equal(own.kind, 'created'); assert.notEqual(own.chartId, first.chartId);
  f.setAccount(null); assert.throws(() => f.create(3), {code: 'auth_required'});
});

test('chart mutation and its small receipt roll back together on a storage error', t => {
  const f = fixture(t);
  f.database.connection.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON chart_operation_outcomes BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END");
  assert.throws(() => f.create(), /receipt rejected/);
  assert.equal(f.records.list().length, 0);
  f.database.connection.exec('DROP TRIGGER reject_receipt');
  const created = f.create();
  const row = f.database.connection.prepare('SELECT * FROM chart_operation_outcomes').get()!;
  assert.deepEqual(Object.keys(row).sort(), ['accountId','operationId','createdAt','outcome'].sort());
  assert.equal(JSON.stringify(row).includes('Личная заметка'), false);
  assert.equal(JSON.stringify(row).includes('birthDate'), false);
  assert.equal(JSON.parse(String(row.outcome)).chartId, created.chartId);
});

test('public reads omit private notes and account identifiers', t => {
  const f = fixture(t), created = f.create();
  f.setAccount(null);
  const shared = f.records.getPublic(created.chartId!)!;
  assert.equal(shared.name, 'Анна Иванова');
  assert.equal(Object.hasOwn(shared, 'note'), false);
  assert.equal(Object.hasOwn(shared, 'accountId'), false);
  assert.equal(Object.hasOwn(shared, 'noteRevision'), false);
});

test('a prepared replacement birth block cannot retain old optional city or calculation metadata', t => {
  const f = fixture(t), first = f.create(1, content({cityId:'old-city', city:{name:'Old'}, engine:'old-engine'}));
  const {name: _name, note: _note, ...birth} = content({utc:'2001-01-01T12:00:00Z', birthDate:'2001-01-01'});
  f.records.update({operationId:operation(2), expectedAccountId:f.a, chartId:first.chartId!, birth});
  const current = f.records.getOwn(first.chartId!)!;
  assert.equal(current.utc, '2001-01-01T12:00:00Z');
  assert.equal(Object.hasOwn(current, 'cityId'), false);
  assert.equal(Object.hasOwn(current, 'engine'), false);
  assert.equal(current.note, 'Личная заметка');
});

test('public revision changes for visible edits, not for a private note', t => {
  const f = fixture(t), first = f.create(), id = first.chartId!;
  const shown = f.records.getPublic(id)!;
  f.records.update({operationId:operation(2), expectedAccountId:f.a, chartId:id, note:{value:'New private note', seenRevision:1}});
  assert.deepEqual(f.records.getPublic(id), shown);
  f.records.update({operationId:operation(3), expectedAccountId:f.a, chartId:id, name:'Visible change'});
  assert.ok(f.records.getPublic(id)!.revision > shown.revision);
});

test('adding a source rechecks its visible revision, excludes its note, and creates an independent record', t => {
  const f = fixture(t), first = f.create(), original = first.chartId!, shown = f.records.getPublic(original)!;
  f.records.update({operationId:operation(2), expectedAccountId:f.a, chartId:original, note:{value:'Secret',seenRevision:1}});
  f.setAccount(f.b);
  const added = f.records.addFromSource({operationId:operation(3),expectedAccountId:f.b,
    sourceId:original, seenRevision:shown.revision});
  assert.equal(added.kind, 'created'); assert.notEqual(added.chartId, original);
  assert.equal(f.records.getOwn(added.chartId!)!.note, '');
  f.setAccount(f.a);
  f.records.update({operationId:operation(4),expectedAccountId:f.a,chartId:original,name:'Changed original'});
  f.setAccount(f.b); assert.equal(f.records.getOwn(added.chartId!)!.name, 'Анна Иванова');
  const changed = f.records.addFromSource({operationId:operation(5),expectedAccountId:f.b,sourceId:original,seenRevision:shown.revision});
  assert.equal(rejectedCode(changed), 'source_changed');
  f.setAccount(f.a); f.records.remove({operationId:operation(6),expectedAccountId:f.a,chartId:original});
  f.setAccount(f.b);
  assert.equal(rejectedCode(f.records.addFromSource({operationId:operation(7),expectedAccountId:f.b,sourceId:original,seenRevision:shown.revision})), 'not_found');
  assert.ok(f.records.getOwn(added.chartId!));
});

test('the database itself enforces a duplicate boundary and UTC minutes work before 1970', t => {
  const f = fixture(t), first = f.create(1, content({utc:'1969-12-31T23:59:00Z'}));
  assert.equal(f.create(2, content({utc:'1969-12-31T23:59:59Z'})).chartId, first.chartId);
  assert.equal(f.create(3, content({utc:'1970-01-01T00:00:00Z'})).kind, 'created');
  assert.throws(() => f.database.connection.prepare(`INSERT INTO account_charts
    SELECT ?, accountId, nameKey, birthMinute, revision, noteRevision, publicRevision, content
    FROM account_charts WHERE id = ?`).run(operation(900), first.chartId!), /UNIQUE/);
});

test('authorization uses the time after the transaction lock is acquired', t => {
  const f = fixture(t); let waiting = false;
  const database = {...f.database, transaction<T>(run: () => T): T {
    return f.database.transaction(() => {if (waiting) f.advance(HOUR); return run();});
  }};
  const expiresAt = f.now() + 1;
  const records = createChartRecords({database, now:f.now, authorize: time => time < expiresAt ? {accountId:f.a} : null});
  waiting = true;
  assert.throws(() => records.create({operationId:operation(1),expectedAccountId:f.a,content:content()}), {code:'auth_required'});
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS count FROM account_charts').get()!.count, 0);
});

test('unknown lookup is read-only, and repeat of a rejected intent preserves its first outcome and age', t => {
  const f = fixture(t), first = f.create(), id = first.chartId!;
  const before = f.database.connection.prepare('SELECT total_changes() AS count').get()!.count;
  assert.deepEqual(f.records.outcome({operationId:operation(999),expectedAccountId:f.a}), {kind:'unknown'});
  assert.equal(f.database.connection.prepare('SELECT total_changes() AS count').get()!.count, before);
  const bad = f.records.update({operationId:operation(2),expectedAccountId:f.a,chartId:id,note:{value:'Rejected',seenRevision:0}});
  const receipt = f.database.connection.prepare('SELECT createdAt FROM chart_operation_outcomes WHERE operationId = ?').get(operation(2))!;
  f.advance(HOUR);
  assert.deepEqual(f.records.update({operationId:operation(2),expectedAccountId:f.a,chartId:id,name:'Must not execute'}), bad);
  assert.equal(f.records.getOwn(id)!.name, 'Анна Иванова');
  assert.equal(f.database.connection.prepare('SELECT createdAt FROM chart_operation_outcomes WHERE operationId = ?').get(operation(2))!.createdAt, receipt.createdAt);
});

test('records and compact successful or rejected outcomes survive a database restart', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'forma-chart-records-'));
  const file = path.join(folder, 'primary.sqlite'); let database = openDatabase(file);
  t.after(() => { database.close(); fs.rmSync(folder, {recursive:true,force:true}); });
  const accountId = String(createAccountStorage(database).ensureAccount('restart@example.test').id);
  let time = 1000;
  const open = () => createChartRecords({database, now:() => time, authorize:() => ({accountId})});
  let records = open();
  const intent = {operationId:operation(1),expectedAccountId:accountId,content:content()};
  const saved = records.create(intent);
  const rejected = records.update({operationId:operation(2),expectedAccountId:accountId,
    chartId:saved.chartId,note:{value:'Not accepted',seenRevision:0}});
  database.close(); database = openDatabase(file); records = open();
  assert.deepEqual(records.outcome(intent), saved);
  assert.deepEqual(records.outcome({operationId:operation(2),expectedAccountId:accountId}), rejected);
  assert.equal(records.getOwn(saved.chartId)!.note, 'Личная заметка');
  time += 48 * HOUR;
  assert.deepEqual(records.outcome(intent), {kind:'unknown'}, 'expiry applies before physical cleanup');
  database.close(); database = openDatabase(file); records = open();
  assert.deepEqual(records.outcome(intent), {kind:'unknown'});
  assert.equal(database.connection.prepare('SELECT COUNT(*) AS count FROM chart_operation_outcomes').get()!.count, 0);
  assert.ok(records.getOwn(saved.chartId));
});

test('a failed chart write cannot leave a successful receipt', t => {
  const f = fixture(t);
  f.database.connection.exec("CREATE TRIGGER reject_chart BEFORE INSERT ON account_charts BEGIN SELECT RAISE(ABORT, 'chart rejected'); END");
  assert.throws(() => f.create(), /chart rejected/);
  assert.deepEqual(f.records.outcome({operationId:operation(1),expectedAccountId:f.a}), {kind:'unknown'});
});

test('adding an already matching source keeps the recipient own note and revisions unchanged', t => {
  const f = fixture(t), source = f.create(), publicSource = f.records.getPublic(source.chartId)!;
  f.setAccount(f.b);
  const own = f.records.create({operationId:operation(2),expectedAccountId:f.b,content:content({note:'Recipient note'})});
  const before = f.records.getOwn(own.chartId)!;
  const result = f.records.addFromSource({operationId:operation(3),expectedAccountId:f.b,
    sourceId:source.chartId,seenRevision:publicSource.revision});
  assert.equal(result.kind, 'existing'); assert.equal(result.chartId, own.chartId);
  assert.deepEqual(f.records.getOwn(own.chartId), before);
});

test('an unchanged prepared birth block and private note do not invalidate a shown public source', t => {
  const f = fixture(t), first = f.create(), id = first.chartId!;
  const before = f.records.getPublic(id)!;
  const {name: _name, note: _note, ...birth} = content();
  f.records.update({operationId:operation(2),expectedAccountId:f.a,chartId:id,birth,note:{value:'Private only',seenRevision:1}});
  assert.deepEqual(f.records.getPublic(id), before);
  f.setAccount(f.b);
  assert.equal(f.records.addFromSource({operationId:operation(3),expectedAccountId:f.b,
    sourceId:id,seenRevision:before.revision}).kind, 'created');
});

test('request access is isolated and pages remain bounded to their intended account', t => {
  const f = fixture(t), a = f.records.withAuthorization(() => ({accountId:f.a})),
    b = f.records.withAuthorization(() => ({accountId:f.b}));
  for (let n=1; n<=5; n++) a.create({operationId:operation(n), expectedAccountId:f.a, content:content({name:'Card '+n})});
  b.create({operationId:operation(1), expectedAccountId:f.b, content:content({name:'Other account'})});
  const first = a.page({expectedAccountId:f.a, limit:2});
  assert.equal(first.charts.length,2); assert.ok(first.nextCursor);
  const second = a.page({expectedAccountId:f.a, after:first.nextCursor!, limit:2});
  const last = a.page({expectedAccountId:f.a, after:second.nextCursor!, limit:2});
  assert.equal(last.charts.length,1); assert.equal(last.nextCursor,null);
  assert.equal(new Set([...first.charts,...second.charts,...last.charts].map(c=>c.id)).size,5);
  assert.equal(b.page({expectedAccountId:f.b}).charts.length,1);
  assert.throws(()=>b.page({expectedAccountId:f.a}),{code:'account_changed'});
  assert.throws(()=>b.getOwn(first.charts[0]!.id,f.a),{code:'account_changed'});
  assert.throws(()=>a.page({expectedAccountId:f.a,limit:1000}),{code:'invalid_operation'});
});

test('refreshing a calculation preserves concurrent private and name changes and cannot overwrite a newer birth', t => {
  const f=fixture(t), created=f.create(), id=created.chartId!;
  const old=f.records.getPublic(id)!;
  f.records.update({operationId:operation(2),expectedAccountId:f.a,chartId:id,
    name:'Latest name',note:{value:'Latest private note',seenRevision:1}});
  const next={...content(),calculationVersion:'new-version'};
  assert.equal(f.records.refreshBirth(id,old,next),'updated');
  assert.equal(f.records.getOwn(id)!.name,'Latest name');
  assert.equal(f.records.getOwn(id)!.note,'Latest private note');
  assert.equal(f.records.getOwn(id)!.noteRevision,2);
  assert.equal(f.records.getOwn(id)!.calculationVersion,'new-version');
  assert.equal(f.records.refreshBirth(id,old,{...next,utc:'2001-01-01T00:00:00Z'}),'changed');
  assert.equal(f.records.getOwn(id)!.utc,old.utc);
  f.records.remove({operationId:operation(3),expectedAccountId:f.a,chartId:id});
  assert.equal(f.records.refreshBirth(id,old,next),'missing');
  assert.equal(f.records.getPublic(id),null);
});

test('default chart IDs are distinct 10-digit strings and operation UUIDs remain unchanged', t => {
  const f = fixture(t), records = createChartRecords({database: f.database, authorize: () => ({accountId: f.a})});
  const ids = new Set<string>();
  for (let n = 0; n < 24; n++) {
    const operationId = `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const result = records.create({operationId, expectedAccountId: f.a, content: content({name: `Chart ${n}`})});
    assert.equal(result.kind, 'created');
    assert.match(result.chartId, /^[1-9][0-9]{9}$/);
    assert.equal(ids.has(result.chartId), false);
    ids.add(result.chartId);
    assert.equal(records.getOwn(result.chartId)!.id, result.chartId);
    assert.deepEqual(records.outcome({operationId, expectedAccountId: f.a}), result);
    assert.equal(f.database.connection.prepare('SELECT operationId FROM chart_operation_outcomes WHERE operationId = ?').get(operationId)!.operationId, operationId);
  }
  assert.equal(ids.size, 24);
});

test('injected legacy IDs are preserved and remain readable beside new default IDs', t => {
  const f = fixture(t), legacyId = '10000000-0000-4000-8000-000000000001';
  const legacy = createChartRecords({database: f.database, authorize: () => ({accountId: f.a}), newId: () => legacyId});
  const old = legacy.create({operationId: operation(1), expectedAccountId: f.a, content: content()});
  assert.equal(old.chartId, legacyId);
  const current = createChartRecords({database: f.database, authorize: () => ({accountId: f.a})});
  const fresh = current.create({operationId: operation(2), expectedAccountId: f.a, content: content({name: 'New chart'})});
  assert.match(fresh.chartId, /^[1-9][0-9]{9}$/);
  assert.equal(current.getOwn(legacyId)!.id, legacyId);
  assert.equal(current.getPublic(legacyId)!.id, legacyId);
  assert.equal(current.list().length, 2);
});

test('decimal chart IDs cannot be used as write-operation identifiers', t => {
  const f = fixture(t), intent = {operationId: '1'.repeat(39), expectedAccountId: f.a};
  assert.throws(() => f.records.create({...intent, content: content()}), {code: 'invalid_operation'});
  assert.throws(() => f.records.outcome(intent), {code: 'invalid_operation'});
  assert.equal(f.records.list().length, 0);
});

test('short ID allocation skips issued IDs even after deletion and grows only after repeated collisions',t=>{
 const f=fixture(t);let next=0;
 const records=createChartRecords({database:f.database,authorize:()=>({accountId:f.a}),newId:(digits=10)=>{
   if(next++===0 || digits===10)return '1234567890';
   return '12345678901';
 }});
 const first=records.create({operationId:operation(41),expectedAccountId:f.a,content:content()});
 records.remove({operationId:operation(42),expectedAccountId:f.a,chartId:first.chartId});
 const second=records.create({operationId:operation(43),expectedAccountId:f.a,content:content({name:'Second'})});
 assert.equal(first.chartId,'1234567890');assert.equal(second.chartId,'12345678901');
 assert.equal(records.getPublic(first.chartId),null);
});

test('unchanged metadata preserves revisions but durably records each distinct operation and checks note CAS',t=>{
 const f=fixture(t),created=f.create(),id=created.chartId!,before=f.records.getOwn(id)!;
 const changes=()=>Number(f.database.connection.prepare('SELECT total_changes() n').get()!.n);
 const start=changes();
 for(const n of [2,3]) {
  const intent={operationId:operation(n),expectedAccountId:f.a,chartId:id,name:before.name,
   note:{value:before.note,seenRevision:before.noteRevision}};
  const result=f.records.update(intent);
  assert.deepEqual(result,{kind:'updated',chartId:id,revision:before.revision});
  assert.deepEqual(f.records.outcome(intent),result);
  assert.deepEqual(f.records.update(intent),result);
 }
 assert.equal(changes()-start,2,'only two distinct durable outcomes are written');
 assert.deepEqual(f.records.getOwn(id),before);
 assert.equal(rejectedCode(f.records.update({operationId:operation(4),expectedAccountId:f.a,chartId:id,
  note:{value:before.note,seenRevision:before.noteRevision+1}})),'note_conflict');
 f.setAccount(null);
 assert.throws(()=>f.records.update({operationId:operation(5),expectedAccountId:f.a,chartId:id,name:before.name}),{code:'auth_required'});
});
