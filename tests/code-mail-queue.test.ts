import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/storage/database.ts';
import { createMailStorage } from '../server/storage/mail-queue.ts';
import { createCodeMailQueue, type MailEvent } from '../server/mail/queue.ts';
import type { PostfixQueue, PostfixEntry } from '../server/mail/postfix.ts';
import { MAIL_POLICY } from '../server/mail/policy.ts';
import type { CodeMail } from '../server/mail/code-mail.ts';

function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const db = openDatabase(':memory:'); let time = 1_000_000, valid = true, loseReply = false;
  const entries = new Map<string, PostfixEntry>(), attempts: string[] = [], events: string[] = [];
  let submissions = 0, journalAccepts = true;
  const facts: MailEvent[] = [];
  let reporter: (event: MailEvent) => void | boolean | Promise<void | boolean> = () => journalAccepts;
  const postfix: PostfixQueue = {
    async list() { return [...entries.values()]; },
    async submit(mail, bytes) {
      submissions++;
      const queueId = `Queue${submissions}`;
      entries.set(queueId, { queueId, codeId: mail.id, contextId: mail.contextId, discardAt: mail.discardAt,
        arrivedAt: time, messageBytes: bytes.length, state: 'hold' });
      if (loseReply) throw new Error('Final SMTP acknowledgement lost');
      return queueId;
    },
    async remove(row) { entries.delete(row.queueId); },
    async send(row) { attempts.push(row.queueId); return true; },
    close() {},
  };
  const queue = createCodeMailQueue({ database: db, postfix, isCurrent: () => valid, now: () => time,
    report: event => { events.push(event.event); facts.push(event); return reporter(event); } });
  const mail: CodeMail = { id: 'a'.repeat(32), contextId: 'b'.repeat(32), code: '123456',
    email: 'person@example.test', createdAt: time, discardAt: time + 300_000 };
  t.after(async () => { await queue.close(); db.close(); });
  return { queue, db, postfix, entries, attempts, events, facts, mail,
    report: (value: typeof reporter) => { reporter = value; }, setValid: (value: boolean) => { valid = value; },
    advance: (ms: number) => { time += ms; }, loseReply: () => { loseReply = true; }, submissions: () => submissions, journalAccepts: (value: boolean) => { journalAccepts = value; } };
}

test('queue retains metadata only and retries an accepted mail at most once a minute', async t => {
  const f = fixture(t); await f.queue.enqueue(f.mail);
  assert.equal(f.submissions(), 1); assert.equal(f.attempts.length, 1);
  const row = f.db.connection.prepare('SELECT * FROM mail_queue').get()!;
  assert.equal(Object.hasOwn(row, 'code'), false); assert.equal(Object.hasOwn(row, 'body'), false);
  assert.equal(row.recipient, f.mail.email);
  f.advance(59_999); await f.queue.tick(); assert.equal(f.attempts.length, 1);
  f.advance(1); await f.queue.tick(); assert.equal(f.attempts.length, 2);
});

test('used or expired codes are deleted before another delivery attempt', async t => {
  const f = fixture(t); await f.queue.enqueue(f.mail); f.setValid(false); f.advance(60_000);
  await f.queue.tick(); assert.equal(f.entries.size, 0); assert.equal(f.attempts.length, 1);
  f.setValid(true); f.advance(240_000);
  await assert.rejects(f.queue.enqueue(f.mail)); assert.equal(f.submissions(), 1);
});

test('a lost SMTP acknowledgement is reconciled by code ID without resubmitting the body', async t => {
  const f = fixture(t); f.loseReply();
  await assert.rejects(f.queue.enqueue(f.mail));
  assert.equal(f.db.connection.prepare('SELECT count(*) AS count FROM mail_queue').get()!.count, 1);
  await f.queue.tick(); assert.equal(f.submissions(), 1); assert.equal(f.attempts.length, 1);
  assert.equal(f.db.connection.prepare('SELECT queueId FROM mail_queue').get()!.queueId, 'Queue1');
});

test('restart validates stored reservations and removes unowned queue entries without sending', async t => {
  const f = fixture(t), store = createMailStorage(f.db, MAIL_POLICY);
  store.reserve({ id: f.mail.id, contextId: f.mail.contextId, reservedBytes: 1000,
    createdAt: f.mail.createdAt, discardAt: f.mail.discardAt });
  f.entries.set('KnownQueue', { queueId: 'KnownQueue', codeId: f.mail.id, contextId: f.mail.contextId,
    arrivedAt: f.mail.createdAt, discardAt: f.mail.discardAt, state: 'hold', messageBytes: 1000 });
  f.entries.set('UnknownQueue', { ...f.entries.get('KnownQueue')!, queueId: 'UnknownQueue', codeId: 'c'.repeat(32) });
  f.setValid(false); await f.queue.tick();
  assert.equal(f.entries.size, 0); assert.equal(f.attempts.length, 0);
});

test('a missing Postfix file is never reported as delivered or resubmitted', async t => {
  const f = fixture(t); await f.queue.enqueue(f.mail); f.entries.clear();
  f.advance(60_000); await f.queue.tick();
  assert.equal(f.submissions(), 1); assert.equal(f.attempts.length, 1);
  assert.equal(f.events.some(event => /delivered|handed_off/.test(event)), false);
  assert.equal(f.db.connection.prepare('SELECT count(*) AS count FROM mail_queue').get()!.count, 1);
});

test('500 confirmed transfers release capacity before the next admission without resubmission', async t => {
  const f = fixture(t), store = createMailStorage(f.db, MAIL_POLICY);
  for (let i = 0; i < 500; i++) {
    const id = i.toString(16).padStart(32, '0');
    store.reserve({ id, contextId: f.mail.contextId, reservedBytes: 1000, createdAt: 1_000_000, discardAt: 1_300_000 });
    store.bind(id, `CompletedQueue${i}`);
    f.db.connection.prepare('UPDATE mail_queue SET outcome = ?, completedAt = ? WHERE id = ?').run('handed_off', 1_000_001, id);
  }
  await assert.doesNotReject(f.queue.enqueue(f.mail));
  assert.equal(f.submissions(), 1);
  assert.equal(f.events.filter(event => event === 'mail_handed_off').length, 0);
  while (f.db.connection.prepare('SELECT count(*) AS n FROM mail_queue WHERE outcome IS NOT NULL').get()!.n) await f.queue.drain();
  assert.equal(f.events.filter(event => event === 'mail_handed_off').length, 500);
  assert.equal(f.db.connection.prepare('SELECT count(*) AS count FROM mail_queue').get()!.count, 1);
});

test('a final refusal releases a reservation but a vanished unknown message still holds one', async t => {
  const f = fixture(t); await f.queue.enqueue(f.mail); f.entries.clear();
  f.db.connection.prepare('UPDATE mail_queue SET outcome = ?, completedAt = ? WHERE id = ?').run('rejected', 1_000_001, f.mail.id);
  await f.queue.tick(); await f.queue.drain();
  assert.equal(f.db.connection.prepare('SELECT count(*) AS count FROM mail_queue').get()!.count, 0);
  assert.equal(f.events.includes('mail_rejected'), true); assert.equal(f.submissions(), 1);
});

test('a receipt arriving during queue inspection remains confirmed even past the unknown deadline', async t => {
  const f = fixture(t); await f.queue.enqueue(f.mail); f.entries.clear(); f.advance(360_000);
  f.postfix.list = async () => {
    f.db.connection.prepare('UPDATE mail_queue SET outcome = ?, completedAt = ? WHERE id = ?').run('handed_off', 1_360_000, f.mail.id);
    return [];
  };
  await f.queue.tick(); await f.queue.drain();
  assert.equal(f.events.includes('mail_outcome_unknown'), false);
  assert.equal(f.events.filter(event => event === 'mail_handed_off').length, 1);
  assert.equal(f.submissions(), 1);
});


test('a terminal outcome stays durable until the common journal explicitly accepts it', async t => {
  const f = fixture(t); await f.queue.enqueue(f.mail); f.entries.clear(); f.journalAccepts(false);
  f.db.connection.prepare('UPDATE mail_queue SET outcome = ?, completedAt = ?').run('handed_off', 1_000_001);
  await f.queue.tick(); await f.queue.drain();
  assert.equal(f.db.connection.prepare('SELECT outcome FROM mail_queue').get()?.outcome, 'handed_off');
  f.journalAccepts(true); await f.queue.tick(); await f.queue.drain(); await f.queue.drain();
  assert.equal(f.db.connection.prepare('SELECT count(*) AS count FROM mail_queue').get()!.count, 0);
  assert.equal(f.submissions(), 1);
});


test('a rejected async journal retains a stable unknown outcome including its original recipient', async t => {
  const f = fixture(t); await f.queue.enqueue(f.mail); f.entries.clear();
  f.report(async () => { throw new Error('journal unavailable'); });
  f.advance(360_000); await f.queue.tick(); await f.queue.drain();
  const first = f.facts.findLast(event => event.event === 'mail_outcome_unknown')!;
  assert.equal(first.recipient, f.mail.email);
  assert.equal(first.reason, 'outcome_unknown');
  assert.equal(first.occurredAt, 1_360_000);
  assert.equal(first.eventId, `mail:${f.mail.id}:outcome_unknown`);
  f.advance(60_000); f.journalAccepts(true); f.report(async () => true); await f.queue.drain();
  assert.deepEqual(f.facts.findLast(event => event.event === 'mail_outcome_unknown'), first);
  assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM mail_queue').get()!.n, 0);
});

test('a stalled journal does not block mail admission, cancellation or shutdown; a late ACK is harmless', async t => {
  const f = fixture(t); await f.queue.enqueue(f.mail); f.entries.clear();
  f.db.connection.prepare("UPDATE mail_queue SET outcome='rejected', completedAt=1000001").run();
  let finish!: (accepted: boolean) => void;
  f.report(event => event.event === 'mail_rejected' ? new Promise<boolean>(resolve => { finish = resolve; }) : false);
  const draining = f.queue.drain();
  assert.equal(f.queue.drain(), draining, 'only one pending drain exists');
  await Promise.resolve();
  await f.queue.enqueue({ ...f.mail, id: 'c'.repeat(32) });
  await f.queue.cancel('c'.repeat(32));
  await f.queue.close();
  f.db.connection.prepare('DELETE FROM mail_queue').run();
  finish(true); await draining;
  assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM mail_queue').get()!.n, 0);
});

test('a drain reads one bounded batch and never deletes a changed terminal record', async t => {
  const f = fixture(t), store = createMailStorage(f.db, MAIL_POLICY);
  for (let i=0; i<70; i++) {
    const id=i.toString(16).padStart(32,'0');
    store.reserve({id,contextId:f.mail.contextId,recipient:f.mail.email,reservedBytes:1,createdAt:1000000,discardAt:1300000});
    f.db.connection.prepare("UPDATE mail_queue SET outcome='rejected',completedAt=1000001,reason='dsn:5.1.1' WHERE id=?").run(id);
  }
  f.report(async event => {
    f.db.connection.prepare('UPDATE mail_queue SET completedAt=1000002 WHERE id=?').run(event.codeId!);
    return true;
  });
  await f.queue.drain();
  assert.equal(f.facts.length, 32);
  assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM mail_queue').get()!.n, 70);
});

test('rejected old report batches do not starve later terminal events', async t => {
  const f=fixture(t), store=createMailStorage(f.db,MAIL_POLICY);
  for(let i=0;i<40;i++) {
    const id=i.toString(16).padStart(32,'0');
    store.reserve({id,contextId:f.mail.contextId,recipient:f.mail.email,reservedBytes:1,createdAt:1000000,discardAt:1300000});
    f.db.connection.prepare("UPDATE mail_queue SET outcome='rejected',completedAt=1000001,reason='dsn:5.1.1' WHERE id=?").run(id);
  }
  f.report(async()=>false);
  await f.queue.drain(); await f.queue.drain();
  assert.equal(new Set(f.facts.map(event=>event.eventId)).size,40);
});

test('buffered responsibility uses a distinct handoff result and never masquerades as a final report ACK',async t=>{
  const db=openDatabase(':memory:');let buffered=false;
  const storage=createMailStorage(db,MAIL_POLICY), original='a'.repeat(32);
  storage.reserve({id:original,contextId:'b'.repeat(32),recipient:'a@example.test',reservedBytes:1,createdAt:1000000,discardAt:1300000});
  db.connection.prepare("UPDATE mail_queue SET outcome='rejected',reason='dsn:5.1.1',completedAt=1000001").run();
  let finalReports=0;
  const queue=createCodeMailQueue({database:db,now:()=>1000002,isCurrent:()=>false,
    postfix:{async list(){return [];},async remove(){},async send(){return true;},async submit(){throw new Error('unused');},close(){}},
    report:async()=>{finalReports++;return true;},
    handoffTerminal:async()=>({status:buffered?'buffered':'unavailable'})});
  t.after(async()=>{await queue.close();db.close();});
  await queue.drain();assert.equal(storage.completed().length,1);
  buffered=true;await queue.drain();assert.equal(storage.completed().length,0);
  assert.equal(finalReports,0);
});
