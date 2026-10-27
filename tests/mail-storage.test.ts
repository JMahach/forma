import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/storage/database.ts';
import { createMailStorage } from '../server/storage/mail-queue.ts';
import { MAIL_POLICY } from '../server/mail/policy.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  return { db, store: createMailStorage(db, MAIL_POLICY) };
}
const job = (id: string, bytes = 100) => ({ id, contextId: 'context', reservedBytes: bytes,
  createdAt: 1000, discardAt: 301000 });

test('pending SMTP submissions count against the same queue limit', t => {
  const { store } = fixture(t);
  for (let i = 0; i < MAIL_POLICY.maxMessages; i++) assert.equal(store.reserve(job(String(i))), true);
  assert.equal(store.reserve(job('overflow')), false);
  store.remove('0'); assert.equal(store.reserve(job('replacement')), true);
});

test('byte reservations reject overflow atomically and never retain a mail body', t => {
  const { store, db } = fixture(t);
  assert.equal(store.reserve(job('first', MAIL_POLICY.maxBytes - 1)), true);
  assert.equal(store.reserve(job('second', 2)), false);
  assert.equal(store.reserve(job('second', 1)), true);
  const row = db.connection.prepare('SELECT * FROM mail_queue WHERE id = ?').get('first')!;
  for (const secret of ['code', 'body', 'email']) assert.equal(Object.hasOwn(row, secret), false);
});

test('binding a Postfix ID preserves the original age and one-minute retry gate', t => {
  const { store } = fixture(t);
  store.reserve(job('first')); store.bind('first', 'LongQueueId');
  assert.equal(store.claimAttempt('first', 1000), true);
  assert.equal(store.claimAttempt('first', 1001), false);
  assert.equal(store.claimAttempt('first', 61000), true);
  assert.equal(store.claimAttempt('first', 301000), false);
  assert.equal(store.rows()[0]!.createdAt, 1000);
  assert.equal(store.rows()[0]!.discardAt, 301000);
  assert.equal(store.rows()[0]!.queueId, 'LongQueueId');
});


test('terminal metadata is bounded and expires without changing active SMTP reservations', t => {
  const { store, db } = fixture(t);
  for (let i=0; i<2050; i++) {
    store.reserve(job(String(i)));
    db.connection.prepare("UPDATE mail_queue SET outcome='rejected',completedAt=?,reason='dsn:5.1.1' WHERE id=?").run(2000+i,String(i));
  }
  assert.equal(db.connection.prepare('SELECT count(*) AS n FROM mail_queue').get()!.n, 2048);
  store.reserve(job('active'));
  store.maintain(4050 + 30*86400000);
  assert.equal(db.connection.prepare('SELECT count(*) AS n FROM mail_queue').get()!.n, 1);
  assert.equal(store.rows()[0]!.id, 'active');
});

test('old reservations migrate transactionally and can retain a stable unknown outcome', t => {
  const db = openDatabase(':memory:'); t.after(()=>db.close());
  db.connection.exec(`CREATE TABLE mail_queue (
    id TEXT PRIMARY KEY,contextId TEXT NOT NULL,reservedBytes INTEGER NOT NULL,createdAt INTEGER NOT NULL,
    discardAt INTEGER NOT NULL,queueId TEXT UNIQUE,lastAttemptAt INTEGER,
    outcome TEXT CHECK(outcome IN ('handed_off','rejected','expired')),completedAt INTEGER) STRICT;
    INSERT INTO mail_queue VALUES ('legacy','context',100,1000,301000,'QueueOld',NULL,NULL,NULL);`);
  const store=createMailStorage(db,MAIL_POLICY);
  assert.equal(store.rows()[0]!.queueId,'QueueOld');
  assert.equal(store.completeUnknownBefore('legacy',301000,361000), true);
  const row=store.completed()[0]!;
  assert.equal(row.outcome,'outcome_unknown'); assert.equal(row.recipient,null);
  assert.equal(store.completeUnknownBefore('legacy',400000,460000),false);
  assert.equal(store.completed()[0]!.completedAt,361000);
});
