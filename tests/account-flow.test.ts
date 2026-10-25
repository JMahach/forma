import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountFlow, type AccountReply, type AccountRequest } from '../src/state/account-flow.ts';

function harness() {
  let mode: 'online'|'offline'|'server' = 'online', now = 1000;
  const pending: {request:AccountRequest; signal:AbortSignal; resolve:(reply:AccountReply)=>void; reject:(e:unknown)=>void}[] = [];
  const flow = createAccountFlow({initial:'guest', now:()=>now, connection:()=>mode,
    request:(request,signal)=>new Promise((resolve,reject)=>pending.push({request,signal,resolve,reject}))});
  return {flow,pending,setMode(value:typeof mode){mode=value;flow.connectionChanged();},setNow(value:number){now=value;flow.tick();},
    async start(){const p=flow.begin();pending.at(-1)!.resolve({});await p;},
    async code(){await this.start();flow.input('email','anna@example.com');const p=flow.submit();pending.at(-1)!.resolve({attempt:{id:'a',expiresAt:1_801_000,codeExpiresAt:601_000,resendAt:61_000}});await p;}};
}

test('email validates before a request; success opens code without pretending to log in',async()=>{
 const h=harness();await h.start();assert.equal(h.flow.state.step,'email');
 await h.flow.submit();assert.equal(h.flow.state.issue?.code,'email_required');assert.equal(h.pending.length,1);
 h.flow.input('email','wrong');await h.flow.submit();assert.equal(h.flow.state.issue?.code,'email_invalid');
 h.flow.input('email',' anna@example.com ');const p=h.flow.submit();assert.equal(h.flow.state.busy,'send');
 h.pending.at(-1)!.resolve({attempt:{id:'a',expiresAt:1801000,codeExpiresAt:601000,resendAt:61000}});await p;
 assert.equal(h.flow.state.step,'code');assert.equal(h.flow.state.email,'anna@example.com');assert.equal(h.flow.state.screen,'guest');
});
test('code validation and wrong code retain email/attempt until explicit success',async()=>{
 const h=harness();await h.code();h.flow.input('code','12');await h.flow.submit();assert.equal(h.flow.state.issue?.code,'code_invalid');
 h.flow.input('code','654321');const p=h.flow.submit();h.pending.at(-1)!.reject({code:'code_invalid'});await p;
 assert.equal(h.flow.state.step,'code');assert.equal(h.flow.state.email,'anna@example.com');
 h.flow.input('code','123456');const success=h.flow.submit();h.pending.at(-1)!.resolve({screen:'unlinked'});await success;
 assert.equal(h.flow.state.screen,'unlinked');assert.equal(h.flow.state.step,'account');assert.equal(h.flow.state.code,'');
});
test('offline blocks requests; server failure is visible and never manufactures success',async()=>{
 const h=harness();h.setMode('offline');await h.flow.begin();assert.equal(h.pending.length,0);assert.equal(h.flow.state.issue?.code,'offline');
 h.setMode('server');const p=h.flow.begin();h.pending.at(-1)!.reject({code:'server_unavailable'});await p;
 assert.equal(h.flow.state.issue?.code,'server_unavailable');assert.equal(h.flow.state.screen,'guest');
});
test('connection loss during request clears wait, retains input, rejects late reply, reconnect never resends',async()=>{
 const h=harness();await h.start();h.flow.input('email','anna@example.com');const p=h.flow.submit();const old=h.pending.at(-1)!;
 h.setMode('offline');assert.equal(old.signal.aborted,true);assert.equal(h.flow.state.busy,null);assert.equal(h.flow.state.email,'anna@example.com');
 h.setMode('online');assert.equal(h.pending.length,2);assert.equal(h.flow.state.issue,null);
 old.resolve({screen:'linked'});await p;assert.equal(h.flow.state.screen,'guest');assert.equal(h.flow.state.step,'email');
});
test('close and state replacement invalidate late replies; logout always works locally',async()=>{
 const h=harness();const p=h.flow.begin();const old=h.pending[0];h.flow.close();old.resolve({screen:'linked'});await p;
 assert.equal(h.flow.state.screen,'guest');assert.equal(h.flow.state.step,'account');
 h.flow.choose('linked');h.setMode('offline');h.flow.logout();assert.equal(h.flow.state.screen,'guest');assert.equal(h.flow.state.email,'');
 const p2=h.flow.begin();await p2;assert.equal(h.pending.length,1);
});
test('busy submit is single flight; cancel returns to current form without new send',async()=>{
 const h=harness();await h.start();h.flow.input('email','anna@example.com');const p=h.flow.submit();await h.flow.submit();assert.equal(h.pending.length,2);
 h.flow.cancel();assert.equal(h.flow.state.step,'email');assert.equal(h.flow.state.busy,null);assert.equal(h.flow.state.email,'anna@example.com');
 h.pending.at(-1)!.resolve({screen:'linked'});await p;assert.equal(h.flow.state.screen,'guest');
});
test('resend interval, code expiry and attempt expiry have distinct actions',async()=>{
 const h=harness();await h.code();await h.flow.resend();assert.equal(h.pending.length,2);assert.equal(h.flow.state.resendSeconds,60);
 h.setNow(61001);const p=h.flow.resend();h.pending.at(-1)!.resolve({attempt:{id:'a',expiresAt:1801000,codeExpiresAt:661001,resendAt:121001}});await p;
 h.setNow(661002);assert.equal(h.flow.state.issue?.code,'code_expired');assert.equal(h.flow.state.step,'code');
 h.setNow(1801001);assert.equal(h.flow.state.issue?.code,'attempt_expired');assert.equal(h.flow.state.step,'code');
 const count=h.pending.length;h.flow.input('code','123456');await h.flow.submit();await h.flow.resend();assert.equal(h.pending.length,count);
 h.flow.back();assert.equal(h.flow.state.step,'email');assert.equal(h.flow.state.email,'anna@example.com');
});
test('network restoration does not clear confirmed field failure',async()=>{
 const h=harness();await h.code();h.flow.input('code','999999');const p=h.flow.submit();h.pending.at(-1)!.reject({code:'code_invalid'});await p;
 h.setMode('offline');h.setMode('online');assert.equal(h.flow.state.issue?.code,'code_invalid');
});
test('Telegram without confirmed mail continues to email; linking conflict retains existing account',async()=>{
 const h=harness();await h.start();const p=h.flow.telegram();h.pending.at(-1)!.resolve({needsEmail:true});await p;
 assert.equal(h.flow.state.step,'email');assert.equal(h.flow.state.screen,'guest');assert.equal(h.flow.state.telegramPending,true);
 h.flow.choose('unlinked');const link=h.flow.telegram();h.pending.at(-1)!.reject({code:'telegram_conflict'});await link;
 assert.equal(h.flow.state.screen,'unlinked');assert.equal(h.flow.state.issue?.code,'telegram_conflict');
});
test('new state selection aborts old form and clears code, attempt and errors',async()=>{
 const h=harness();await h.code();h.flow.input('code','123456');const p=h.flow.submit();h.flow.choose('expired');
 h.pending.at(-1)!.resolve({screen:'linked'});await p;assert.equal(h.flow.state.screen,'expired');assert.equal(h.flow.state.code,'');assert.equal(h.flow.state.attempt,null);
});

test('the same elapsed code remains invalid after editing; only a new issued code clears expiry',async()=>{
 const h=harness();await h.code();h.setNow(601001);assert.equal(h.flow.state.issue?.code,'code_expired');
 h.flow.input('code','123456');assert.equal(h.flow.state.issue?.code,'code_expired');
 const before=h.pending.length;await h.flow.submit();assert.equal(h.pending.length,before);
 const resend=h.flow.resend();h.pending.at(-1)!.resolve({attempt:{id:'a',expiresAt:1801000,codeExpiresAt:1201001,resendAt:661001}});await resend;
 assert.equal(h.flow.state.issue,null);assert.equal(h.flow.state.code,'');assert.equal(h.flow.state.attempt?.expiresAt,1801000);
});


test('account identity comes from input data and is never invented by the state owner', async () => {
 const flow=createAccountFlow({initial:'linked',connection:()=> 'online',request:async()=>({})});
 assert.equal(flow.state.identity,null);
 assert.equal(flow.state.email,'');
 const identity={email:'timur@example.org',telegramHandle:'@timur'};
 flow.choose('linked',identity);
 assert.deepEqual(flow.state.identity,identity);
 assert.equal(flow.state.email,identity.email);
 flow.input('email','draft@example.org');
 assert.deepEqual(flow.state.identity,identity,'editing a login draft cannot change confirmed account details');
 flow.logout();
 assert.equal(flow.state.identity,null);
 assert.equal(flow.state.email,'');
});
test('only the current reply can supply confirmed account identity', async () => {
 const h=harness();await h.code();h.flow.input('code','123456');
 const current=h.flow.submit();
 const identity={email:'confirmed@example.org',telegramHandle:'@confirmed'};
 h.pending.at(-1)!.resolve({screen:'linked',identity});await current;
 assert.deepEqual(h.flow.state.identity,identity);
 assert.equal(h.flow.state.email,identity.email);
 const stale=h.flow.telegram();h.flow.logout();
 h.pending.at(-1)!.resolve({screen:'linked',identity});await stale;
 assert.equal(h.flow.state.identity,null);
});
