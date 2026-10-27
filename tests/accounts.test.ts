import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/storage/database.ts';
import { createAccounts, type AccountCredentials } from '../server/services/accounts.ts';
import type { CodeMail } from '../server/mail/code-mail.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const empty = (): AccountCredentials => ({ bindings: {}, sessions: {} });
function fixture(t: { after: (fn: () => void) => void }) {
  const database = openDatabase(':memory:');
  t.after(() => database.close());
  let time = 1_000_000;
  const mails: CodeMail[] = [], cancelled: string[] = [];
  const accounts = createAccounts({ database, key: Buffer.alloc(32, 1), now: () => time,
    mail: { async enqueue(value) { mails.push(value); }, async cancel(id) { cancelled.push(id); } } });
  const credentials = empty();
  return { accounts, mails, cancelled, credentials, database,
    now: () => time, advance(ms: number) { time += ms; },
    async start(email = 'person@example.test', supplied = credentials, replaceId?: string) {
      const result = await accounts.start({ email, ip: '192.0.2.1', credentials: supplied, replaceId });
      supplied.bindings[result.attempt.id] = result.binding.secret;
      return result;
    },
    verify(id: string, supplied = credentials) {
      const code = mails.findLast(value => value.contextId === id)!.code;
      const result = accounts.verify(id, code, supplied);
      supplied.sessions[id] = result.secret;
      return result;
    },
  };
}

test('a code only creates an account after the browser proves receipt of the rotated secret', async t => {
  const f = fixture(t), started = await f.start();
  assert.equal(f.accounts.current(f.credentials), null);
  const grant = f.verify(started.attempt.id);
  assert.notEqual(grant.secret, started.binding.secret);
  assert.equal(f.accounts.current(f.credentials), null);
  const result = f.accounts.confirm(started.attempt.id, f.credentials);
  assert.equal(result.account.email, 'person@example.test');
  assert.equal(result.session.expiresAt, f.now() + 90 * DAY);
  assert.equal(f.accounts.current(f.credentials)?.account.id, result.account.id);
  assert.deepEqual(f.accounts.confirm(started.attempt.id, f.credentials), result);
  assert.throws(() => f.accounts.verify(started.attempt.id, f.mails[0]!.code, f.credentials), { code: 'attempt_expired' });
});

test('the old binding cannot read the account or issue another session secret', async t => {
  const f = fixture(t), started = await f.start();
  const bindingOnly = structuredClone(f.credentials);
  f.verify(started.attempt.id);
  assert.throws(() => f.accounts.verify(started.attempt.id, f.mails[0]!.code, bindingOnly), { code: 'code_used' });
  assert.throws(() => f.accounts.confirm(started.attempt.id, bindingOnly), { code: 'auth_required' });
  f.accounts.confirm(started.attempt.id, f.credentials);
  assert.equal(f.accounts.current(bindingOnly), null);
});

test('logout before delayed verify headers keeps the later cookie invalid', async t => {
  const f = fixture(t), started = await f.start();
  const grant = f.accounts.verify(started.attempt.id, f.mails[0]!.code, f.credentials);
  await f.accounts.logout(started.attempt.id, f.credentials);
  f.credentials.sessions[started.attempt.id] = grant.secret;
  assert.equal(f.accounts.current(f.credentials), null);
  assert.throws(() => f.accounts.confirm(started.attempt.id, f.credentials), { code: 'attempt_expired' });
});

test('a lost confirm response can be followed by logout of the known context', async t => {
  const f = fixture(t), started = await f.start();
  f.verify(started.attempt.id);
  f.accounts.confirm(started.attempt.id, f.credentials);
  await f.accounts.logout(started.attempt.id, f.credentials);
  assert.equal(f.accounts.current(f.credentials), null);
  await f.accounts.logout(started.attempt.id, empty());
});

test('late logout of an old context never logs out the newly confirmed account', async t => {
  const f = fixture(t), a = await f.start('first@example.test');
  f.verify(a.attempt.id); f.accounts.confirm(a.attempt.id, f.credentials);
  const b = await f.start('second@example.test');
  f.verify(b.attempt.id); const current = f.accounts.confirm(b.attempt.id, f.credentials);
  await f.accounts.logout(a.attempt.id, f.credentials);
  assert.equal(f.accounts.current(f.credentials)?.account.id, current.account.id);
});

test('closing a form after confirm does not revoke the completed login', async t => {
  const f = fixture(t), a = await f.start();
  f.verify(a.attempt.id); f.accounts.confirm(a.attempt.id, f.credentials);
  await f.accounts.cancel(a.attempt.id, f.credentials);
  assert.ok(f.accounts.current(f.credentials));
});

test('an unrelated browser cannot cancel an existing context by its public ID', async t => {
  const f = fixture(t), a = await f.start();
  await assert.rejects(f.accounts.logout(a.attempt.id, empty()), { code: 'auth_required' });
  f.verify(a.attempt.id); f.accounts.confirm(a.attempt.id, f.credentials);
  await assert.rejects(f.accounts.logout(a.attempt.id, empty()), { code: 'auth_required' });
  assert.ok(f.accounts.current(f.credentials));
});

test('the original attempt deadline still applies after verification and resending', async t => {
  const f = fixture(t), a = await f.start();
  const first = f.mails[0]!;
  f.advance(25 * MINUTE);
  const resent = await f.accounts.resend(a.attempt.id, '192.0.2.1', f.credentials);
  assert.equal(resent.expiresAt, a.attempt.expiresAt);
  assert.equal(resent.codeExpiresAt, a.attempt.expiresAt);
  assert.equal(f.accounts.isMailCurrent(first.id), false);
  assert.throws(() => f.accounts.verify(a.attempt.id, first.code, f.credentials), { code: 'code_invalid' });
  f.verify(a.attempt.id);
  f.advance(5 * MINUTE);
  assert.throws(() => f.accounts.confirm(a.attempt.id, f.credentials), { code: 'attempt_expired' });
  assert.equal(f.accounts.current(f.credentials), null);
});

test('changing a mistyped email cancels its pending code and creates a distinct attempt', async t => {
  const f = fixture(t), a = await f.start('typo@example.test');
  const oldMail = f.mails[0]!;
  const b = await f.start('person@example.test', f.credentials, a.attempt.id);
  assert.notEqual(b.attempt.id, a.attempt.id);
  assert.equal(f.accounts.isMailCurrent(oldMail.id), false);
  assert.ok(f.cancelled.includes(oldMail.id));
  assert.throws(() => f.accounts.verify(a.attempt.id, oldMail.code, f.credentials), { code: 'attempt_expired' });
  f.verify(b.attempt.id);
  assert.equal(f.accounts.confirm(b.attempt.id, f.credentials).account.email, 'person@example.test');
});

test('start with the same normalized email and replaceId is a resend, never a new thirty minutes', async t => {
  const f = fixture(t), a = await f.start('person@example.test');
  f.advance(25 * MINUTE);
  const repeated = await f.start('  PERSON@example.test  ', f.credentials, a.attempt.id);
  assert.equal(repeated.attempt.id, a.attempt.id);
  assert.equal(repeated.attempt.expiresAt, a.attempt.expiresAt);
  assert.equal(repeated.attempt.codeExpiresAt, a.attempt.expiresAt);
  assert.equal(repeated.binding.secret, a.binding.secret);
});

for (const order of ['older-first', 'newer-first'] as const) {
  test(`competing tabs have one confirmed winner (${order}, delayed start response)`, async t => {
    const f = fixture(t);
    const aJar = empty(), bJar = empty();
    const a = await f.start('first@example.test', aJar);
    const b = await f.start('second@example.test', bJar);
    // A sent its next request before B's start headers. B then received A's cookie.
    bJar.bindings[a.attempt.id] = aJar.bindings[a.attempt.id]!;
    f.verify(a.attempt.id, aJar); f.verify(b.attempt.id, bJar);
    const first = order === 'older-first' ? { a, jar: aJar } : { a: b, jar: bJar };
    const second = order === 'older-first' ? { a: b, jar: bJar } : { a, jar: aJar };
    const winner = f.accounts.confirm(first.a.attempt.id, first.jar);
    assert.throws(() => f.accounts.confirm(second.a.attempt.id, second.jar));
    assert.equal(f.accounts.current(first.jar)?.account.id, winner.account.id);
  });
}

test('session use extends inactivity expiry and expired credentials never grant access before cleanup', async t => {
  const f = fixture(t), a = await f.start();
  f.verify(a.attempt.id); f.accounts.confirm(a.attempt.id, f.credentials);
  f.advance(89 * DAY);
  assert.equal(f.accounts.current(f.credentials)?.session.expiresAt, f.now() + 90 * DAY);
  f.advance(90 * DAY);
  assert.equal(f.accounts.current(f.credentials), null);
  f.accounts.cleanup();
  assert.equal(f.database.connection.prepare('SELECT count(*) AS n FROM account_sessions').get()?.n, 0);
});

function delayNextTransaction(f: ReturnType<typeof fixture>, delay: number) {
  const transaction = f.database.transaction;
  let pending = true;
  f.database.transaction = run => transaction(() => {
    if (pending) { pending = false; f.advance(delay); }
    return run();
  });
}

test('a code that expires while waiting for the database lock is rejected', async t => {
  const f = fixture(t), a = await f.start();
  f.advance(10 * MINUTE - 1);
  delayNextTransaction(f, 2);
  assert.throws(() => f.verify(a.attempt.id), { code: 'code_expired' });
});

test('confirm cannot create a session after the attempt expired while waiting for the lock', async t => {
  const f = fixture(t), a = await f.start();
  f.verify(a.attempt.id);
  f.advance(30 * MINUTE - 1);
  delayNextTransaction(f, 2);
  assert.throws(() => f.accounts.confirm(a.attempt.id, f.credentials), { code: 'attempt_expired' });
});

test('waiting for the database lock cannot revive an expired session', async t => {
  const f = fixture(t), a = await f.start();
  f.verify(a.attempt.id); f.accounts.confirm(a.attempt.id, f.credentials);
  f.advance(90 * DAY - 1);
  delayNextTransaction(f, 2);
  assert.equal(f.accounts.current(f.credentials), null);
});

test('logout records a transition once and ignores unknown public IDs', async t => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const events: string[] = [];
  const accounts = createAccounts({ database: db, key: Buffer.alloc(32, 1),
    mail: { async enqueue() {}, async cancel() {} }, report: value => { events.push(value.event); } });
  await accounts.logout('unknown', empty());
  assert.deepEqual(events, []);
});


test('async journal failure cannot undo successful login or logout and timestamps describe the transition', async t => {
  const database=openDatabase(':memory:'); t.after(()=>database.close());
  const mails: CodeMail[]=[];
  const facts: {event:string;occurredAt?:number}[]=[];
  let time=1000000;
  const accounts=createAccounts({database,key:Buffer.alloc(32,1),now:()=>time,
    mail:{async enqueue(mail){mails.push(mail);},async cancel(){}},
    report:async event=>{facts.push(event);throw new Error('journal unavailable');}});
  const credentials=empty();
  const started=await accounts.start({email:'person@example.test',ip:'192.0.2.1',credentials});
  credentials.bindings[started.attempt.id]=started.binding.secret;
  credentials.sessions[started.attempt.id]=accounts.verify(started.attempt.id,mails[0]!.code,credentials).secret;
  time+=50; const result=accounts.confirm(started.attempt.id,credentials);
  assert.equal(accounts.current(credentials)?.account.id,result.account.id);
  time+=50; await accounts.logout(started.attempt.id,credentials);
  assert.equal(accounts.current(credentials),null);
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.deepEqual(facts.map(({event,occurredAt})=>({event,occurredAt})),[
    {event:'auth_login',occurredAt:1000050},{event:'auth_logout',occurredAt:1000100}]);
});

test('DEL cannot enter an account email or the mail queue',async t=>{
  const f=fixture(t);
  await assert.rejects(f.start('person\u007f@example.test'),{code:'email_invalid'});
  assert.equal(f.mails.length,0);
});
