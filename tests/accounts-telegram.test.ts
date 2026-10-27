import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/storage/database.ts';
import { createAccounts, type AccountCredentials } from '../server/services/accounts.ts';
import type { CodeMail } from '../server/mail/code-mail.ts';
import type { TelegramProvider } from '../server/services/telegram-provider.ts';
import type { TelegramIdentity } from '../server/services/telegram-identity.ts';
const empty = (): AccountCredentials => ({bindings:{},sessions:{}});
const minute=60_000;
function fixture(t:{after:(fn:()=>void)=>void}) {
 const database=openDatabase(':memory:');t.after(()=>database.close());let time=1_800_000_000_000;
 const mails:CodeMail[]=[];let pending:Promise<TelegramIdentity>|undefined;let calls=0;
 const identity=(id='123',username:string|null=null):TelegramIdentity=>({subject:'unrelated-subject',userId:id,username,expiresAt:time+minute});
 let value=identity();
 const provider:TelegramProvider={clientId:'42',async verify(){calls++;return pending??value;}};
 const controller=new AbortController();
 const accounts=createAccounts({database,key:Buffer.alloc(32,4),now:()=>time,telegram:provider,signal:controller.signal,
  mail:{async enqueue(m){mails.push(m);},async cancel(){}}});
 const proof=empty();
 const start=(credentials=proof,replaceId?:string)=>{const r=accounts.startTelegram({credentials,replaceId});credentials.bindings[r.attempt.id]=r.binding.secret;return r;};
 const verify=async(id:string,credentials=proof)=>{const r=await accounts.verifyTelegram(id,'signed',credentials);if(r.grant)credentials.sessions[id]=r.grant.secret;return r;};
 const email=async(address:string,id?:string,credentials=proof)=>{
  const r=await accounts.start({email:address,ip:'192.0.2.1',credentials,replaceId:id});credentials.bindings[r.attempt.id]=r.binding.secret;
  const grant=accounts.verify(r.attempt.id,mails.at(-1)!.code,credentials);credentials.sessions[r.attempt.id]=grant.secret;return r;
 };
 return {database,accounts,proof,mails,start,verify,email,identity,controller,
  calls:()=>calls,now:()=>time,advance:(ms:number)=>{time+=ms;},setIdentity:(v:TelegramIdentity)=>{value=v;},wait:(p:Promise<TelegramIdentity>)=>{pending=p;}};
}

test('new Telegram requires confirmed email, keeps one attempt and binds profile id only on common confirm',async t=>{
 const f=fixture(t),a=f.start();assert.deepEqual(a.telegram.scope,['profile']);assert.equal(f.accounts.progress(a.attempt.id,f.proof).stage,'telegram');
 await assert.rejects(f.accounts.start({email:'a@example.test',ip:'x',credentials:f.proof,replaceId:a.attempt.id}),{code:'telegram_required'});
 const verified=await f.verify(a.attempt.id);assert.equal(verified.needsEmail,true);assert.equal(f.accounts.current(f.proof),null);
 assert.equal(f.accounts.progress(a.attempt.id,f.proof).stage,'email');
 f.advance(2*minute);const b=await f.email('a@example.test',a.attempt.id);
 assert.equal(b.attempt.id,a.attempt.id);assert.equal(b.attempt.expiresAt,a.attempt.expiresAt);
 const result=f.accounts.confirm(a.attempt.id,f.proof);assert.equal(result.account.telegramLinked,true);assert.equal(result.account.telegramHandle,null);
 assert.equal(f.database.connection.prepare('SELECT telegramId FROM accounts').get()!.telegramId,'123');
 assert.deepEqual(f.accounts.confirm(a.attempt.id,f.proof),result);
});

test('linked Telegram without username signs into its existing account without another email',async t=>{
 const f=fixture(t),a=f.start();await f.verify(a.attempt.id);await f.email('a@example.test',a.attempt.id);const original=f.accounts.confirm(a.attempt.id,f.proof);
 const other=empty(),b=f.start(other);const reply=await f.verify(b.attempt.id,other);assert.equal(reply.needsEmail,false);assert.equal(f.mails.length,1);
 assert.equal(f.accounts.confirm(b.attempt.id,other).account.id,original.account.id);
});

test('linking requires the original full session and cannot change account through email',async t=>{
 const f=fixture(t),a=await f.email('a@example.test');const account=f.accounts.confirm(a.attempt.id,f.proof);
 const b=f.start();await f.verify(b.attempt.id);
 await assert.rejects(f.accounts.start({email:'other@example.test',ip:'x',credentials:f.proof,replaceId:b.attempt.id}),{code:'code_used'});
 assert.equal(f.accounts.confirm(b.attempt.id,f.proof).account.id,account.account.id);
});

test('old binding alone is not authority to link a Telegram identity',async t=>{
 const f=fixture(t),a=await f.email('a@example.test');f.accounts.confirm(a.attempt.id,f.proof);
 const old:AccountCredentials={bindings:{[a.attempt.id]:a.binding.secret},sessions:{}};
 const b=f.start(old);assert.equal((await f.verify(b.attempt.id,old)).needsEmail,true);
 assert.equal(f.database.connection.prepare('SELECT telegramId FROM accounts').get()!.telegramId,null);
});

test('different email in a Telegram attempt preserves original identity, nonce consumption and deadline',async t=>{
 const f=fixture(t),a=f.start();await f.verify(a.attempt.id);
 const b=await f.accounts.start({email:'first@example.test',ip:'x',credentials:f.proof,replaceId:a.attempt.id});
 f.advance(3*minute);const c=await f.accounts.start({email:'second@example.test',ip:'x',credentials:f.proof,replaceId:b.attempt.id});
 assert.equal(c.attempt.id,a.attempt.id);assert.equal(c.attempt.expiresAt,a.attempt.expiresAt);
 const row=f.database.connection.prepare('SELECT * FROM account_attempts').get()!;assert.equal(row.telegramId,'123');assert.equal(row.telegramNonce,null);
 await assert.rejects(f.verify(a.attempt.id),{code:'telegram_used'});
});

for(const action of ['cancel','logout','expire','token-expire','nonce','shutdown'] as const)test(`late verification cannot revive ${action}`,async t=>{
 const f=fixture(t),a=f.start();let resolve!:(v:TelegramIdentity)=>void;f.wait(new Promise(r=>{resolve=r;}));
 const pending=f.verify(a.attempt.id);const identity=f.identity();
 if(action==='cancel')await f.accounts.cancel(a.attempt.id,f.proof);
 if(action==='logout')await f.accounts.logout(a.attempt.id,f.proof);
 if(action==='expire')f.advance(30*minute);
 if(action==='token-expire')f.advance(minute);
 if(action==='nonce')f.database.connection.prepare('UPDATE account_attempts SET telegramNonce=?').run('x'.repeat(43));
 if(action==='shutdown')f.controller.abort();
 resolve(identity);await assert.rejects(pending);assert.equal(f.accounts.current(f.proof),null);
 assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS n FROM accounts').get()!.n,0);
});

test('unknown browser never invokes Telegram verification; repeats cannot mint another secret',async t=>{
 const f=fixture(t),a=f.start();await assert.rejects(f.verify(a.attempt.id,empty()),{code:'auth_required'});assert.equal(f.calls(),0);
 await f.verify(a.attempt.id);await assert.rejects(f.verify(a.attempt.id),{code:'telegram_used'});assert.equal(f.calls(),1);
});

test('two pending accounts cannot claim the same Telegram; losing confirmation rolls back account creation',async t=>{
 const f=fixture(t),a=f.start();await f.verify(a.attempt.id);await f.email('a@example.test',a.attempt.id);
 const other=empty(),b=f.start(other);await f.verify(b.attempt.id,other);await f.email('b@example.test',b.attempt.id,other);
 f.accounts.confirm(a.attempt.id,f.proof);assert.throws(()=>f.accounts.confirm(b.attempt.id,other),{code:'telegram_conflict'});
 assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS n FROM accounts').get()!.n,1);
});

test('two Telegram identities cannot replace one account; losing confirmation leaves current session alive',async t=>{
 const f=fixture(t),email=await f.email('a@example.test');f.accounts.confirm(email.attempt.id,f.proof);
 f.advance(minute);const p2=empty(),second=await f.email('a@example.test',undefined,p2);const old=f.accounts.confirm(second.attempt.id,p2);
 f.setIdentity(f.identity());
 const a=f.start();await f.verify(a.attempt.id);
 f.setIdentity(f.identity('456'));const b=f.start(p2);await f.verify(b.attempt.id,p2);
 f.accounts.confirm(a.attempt.id,f.proof);
 assert.throws(()=>f.accounts.confirm(b.attempt.id,p2),{code:'telegram_conflict'});
 assert.equal(f.accounts.current(p2)!.session.id,old.session.id);
 assert.equal(f.database.connection.prepare('SELECT telegramId FROM accounts').get()!.telegramId,'123');
});

test('logout of the linking session during IO cannot bind or create a replacement session',async t=>{
 const f=fixture(t),a=await f.email('a@example.test');f.accounts.confirm(a.attempt.id,f.proof);const b=f.start();
 let resolve!:(v:TelegramIdentity)=>void;f.wait(new Promise(r=>{resolve=r;}));const pending=f.verify(b.attempt.id);
 await f.accounts.logout(a.attempt.id,f.proof);resolve(f.identity());await assert.rejects(pending,{code:'account_changed'});
 assert.equal(f.database.connection.prepare('SELECT telegramId FROM accounts').get()!.telegramId,null);
});


test('a link grant still needs the full original session at confirmation',async t=>{
 const f=fixture(t),email=await f.email('a@example.test');f.accounts.confirm(email.attempt.id,f.proof);
 const a=f.start();await f.verify(a.attempt.id);delete f.proof.sessions[email.attempt.id];
 assert.throws(()=>f.accounts.confirm(a.attempt.id,f.proof),{code:'account_changed'});
 assert.equal(f.database.connection.prepare('SELECT telegramId FROM accounts').get()!.telegramId,null);
});

test('the signed token expiry is rechecked after waiting for the database transaction',async t=>{
 const f=fixture(t),a=f.start(),transaction=f.database.transaction;
 f.database.transaction=run=>{f.advance(minute);return transaction(run);};
 await assert.rejects(f.verify(a.attempt.id),{code:'telegram_invalid'});
 assert.equal(f.database.connection.prepare('SELECT telegramId FROM account_attempts').get()!.telegramId,null);
});

test('storage failure atomically rolls back account, Telegram and session, allowing safe confirm retry',async t=>{
 const f=fixture(t),a=f.start();await f.verify(a.attempt.id);await f.email('a@example.test',a.attempt.id);
 f.database.connection.exec("CREATE TRIGGER fail_session BEFORE INSERT ON account_sessions BEGIN SELECT RAISE(ABORT,'test failure'); END");
 assert.throws(()=>f.accounts.confirm(a.attempt.id,f.proof));
 assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS n FROM accounts').get()!.n,0);
 assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS n FROM account_sessions').get()!.n,0);
 f.database.connection.exec('DROP TRIGGER fail_session');assert.equal(f.accounts.confirm(a.attempt.id,f.proof).account.telegramLinked,true);
});
