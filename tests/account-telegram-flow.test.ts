import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccountSession} from '../src/state/account-session.ts';
import type {AccountClient} from '../src/data/account-client.ts';
import type {AccountLogoutStore} from '../src/data/account-logout-store.ts';
import type {SavedAccountView} from '../src/data/view-store.ts';
import type {TelegramLogin} from '../src/data/telegram-login.ts';
import type {AuthAttemptProgress,ConfirmedAccount} from '../shared/account-contract.ts';
const id='a'.repeat(32),expiresAt=1801000;
const account={id:'7',email:'owner@example.org',telegramLinked:true,telegramHandle:null};
function fixture({needsEmail=false,saved=null as SavedAccountView|null,stage='telegram' as AuthAttemptProgress['stage']}={}){
  let activation=true,mode:'online'|'offline'='online',time=1000,phase=stage,current:ConfirmedAccount|null=null;
  let holdStart=false,startFinish:(()=>void)|null=null;
  let token:((value:string)=>void)|null=null, verifyFinish:(()=>void)|null=null,holdVerify=false,loseConfirm=false;
  const events:string[]=[], starts:(string|undefined)[]=[],emails:(string|undefined)[]=[],proofs:string[]=[],closes:string[]=[];
  const attempt={id,expiresAt,codeExpiresAt:0,resendAt:0};
  const telegram:TelegramLogin={reserve(signal,onCancel){
    assert.equal(activation,true,'popup reservation precedes every asynchronous continuation');events.push('reserve');
    return {authenticate:async start=>{assert.equal(start.attempt.expiresAt,expiresAt);events.push('popup');
      return new Promise((resolve,reject)=>{token=resolve;signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});});},close(){events.push('close-popup');}};
  },destroy(){}};
  const client={now:()=>time,current:async()=>{events.push('current');return current;},
    startTelegram:async(replaceId:string|undefined)=>{events.push('start');starts.push(replaceId);
      if(holdStart){holdStart=false;await new Promise<void>(resolve=>{startFinish=resolve;});}
      return {attempt:{id,expiresAt},telegram:{clientId:'123',nonce:'n'.repeat(43),scope:['profile']}};},
    verifyTelegram:async(attemptId:string,value:string)=>{assert.equal(attemptId,id);events.push('verify-telegram');proofs.push(value);
      if(holdVerify)await new Promise<void>(resolve=>{verifyFinish=resolve;});
      phase=needsEmail?'email':'verified';return {attemptId:id,needsEmail,needsConfirmation:!needsEmail};},
    progress:async()=>{events.push('progress');return {...attempt,stage:phase,canConfirm:phase==='verified',
      ...(phase==='code'?{codeExpiresAt:601000,resendAt:61000}:{})};},
    confirm:async()=>{events.push('confirm');current={account,session:{id,expiresAt:999999999}};
      if(loseConfirm)throw Object.assign(new Error('lost'),{code:'connection_failed'});return current;},
    start:async(_email:string,replaceId:string|undefined)=>{events.push('email');emails.push(replaceId);phase='code';return {...attempt,codeExpiresAt:601000,resendAt:61000};},
    resend:async()=>({...attempt,codeExpiresAt:601000,resendAt:61000}),
    verify:async()=>{events.push('verify-code');phase='verified';},cancel:async(value:string)=>{closes.push(value);},logout:async()=>{},
  } as unknown as AccountClient;
  const logoutStore={list:async()=>{events.push('flush');return [];},add:async()=>{},remove:async()=>{},close(){}} as AccountLogoutStore;
  const owner=createAccountSession({client,logoutStore,connection:()=>mode,saved,telegram});
  return {owner,flow:owner.flow,events,starts,emails,proofs,closes,
    token(value='signed.token.value'){assert.ok(token,'the SDK has been opened');token(value);},
    endClick(){activation=false;},click(){activation=true;},holdStart(){holdStart=true;},finishStart(){assert.ok(startFinish);startFinish();},holdVerify(){holdVerify=true;},finishVerify(){assert.ok(verifyFinish);verifyFinish();},
    loseConfirm(){loseConfirm=true;},setTime(value:number){time=value;},offline(){mode='offline';owner.flow.connectionChanged();},
    setCurrent(value:ConfirmedAccount){current=value;},
  };
}
const tick=async()=>{for(let i=0;i<14;i++)await Promise.resolve();};

test('new Telegram reserves on click, verifies proof and continues the same attempt through email confirmation',async()=>{
  const f=fixture({needsEmail:true});const work=f.flow.telegram();assert.equal(f.events[0],'reserve');f.endClick();await tick();
  assert.equal(f.flow.snapshot?.attemptId,id);assert.equal(f.flow.state.attempt?.expiresAt,expiresAt);
  assert.doesNotMatch(JSON.stringify(f.flow.snapshot),/nonce|signed|clientId|id_token/);
  f.token();await work;assert.equal(f.flow.state.step,'email');assert.equal(f.flow.state.telegramPending,true);
  assert.equal(f.events.includes('confirm'),false);f.flow.input('email','owner@example.org');await f.flow.submit();
  assert.deepEqual(f.emails,[id]);assert.equal(f.flow.state.attempt?.expiresAt,expiresAt);
  f.flow.input('code','123456');await f.flow.submit();assert.equal(f.flow.state.screen,'linked');assert.equal(f.flow.state.session?.id,id);
});
test('a linked Telegram confirms directly without sending email',async()=>{
  const f=fixture(),work=f.flow.telegram();await tick();f.token();await work;
  assert.equal(f.flow.state.screen,'linked');assert.deepEqual(f.emails,[]);assert.deepEqual(f.proofs,['signed.token.value']);
  assert.ok(f.events.indexOf('verify-telegram')<f.events.indexOf('confirm'));
});
test('closing after token verification began cannot confirm a late response',async()=>{
  const f=fixture();f.holdVerify();const work=f.flow.telegram();await tick();f.token();await tick();
  f.flow.close();f.finishVerify();await work;assert.equal(f.events.includes('confirm'),false);
  assert.equal(f.flow.state.screen,'guest');assert.deepEqual(f.closes,[id]);
});
test('cancelling and reopening Telegram reuses the original attempt and expiry',async()=>{
  const f=fixture(),first=f.flow.telegram();await tick();f.flow.cancel();await first;
  f.click();const second=f.flow.telegram();await tick();f.token();await second;
  assert.deepEqual(f.starts,[undefined,id]);assert.deepEqual(f.proofs,['signed.token.value']);
});
test('reload of a Telegram attempt only reads progress and requires a new click to reopen the SDK',async()=>{
  const saved={email:'',attemptEmail:'',attemptId:id,step:'telegram',verificationPending:false} as SavedAccountView;
  const f=fixture({saved});await f.owner.refresh();assert.equal(f.flow.state.step,'telegram');
  assert.equal(f.events.includes('reserve'),false);assert.equal(f.events.includes('start'),false);assert.equal(f.events.includes('confirm'),false);
  const work=f.flow.submit();assert.ok(f.events.includes('reserve'));await tick();f.token();await work;
  assert.deepEqual(f.starts,[id]);assert.equal(f.flow.state.screen,'linked');
});
test('reload of already verified Telegram never automatically confirms or asks for an email code',async()=>{
  const saved={email:'',attemptEmail:'',attemptId:id,step:'telegram',verificationPending:true} as SavedAccountView;
  const f=fixture({saved,stage:'verified'});await f.owner.refresh();assert.equal(f.flow.state.step,'telegram');
  assert.equal(f.flow.state.verificationPending,true);assert.equal(f.events.includes('confirm'),false);
  await f.flow.submit();assert.equal(f.flow.state.screen,'linked');assert.equal(f.events.includes('popup'),false);assert.deepEqual(f.starts,[]);
});
test('a lost confirmation is recovered by reading the existing session without repeating proof',async()=>{
  const f=fixture();f.loseConfirm();const work=f.flow.telegram();await tick();f.token();await work;
  assert.equal(f.flow.state.screen,'guest');await f.owner.refresh();assert.equal(f.flow.state.screen,'linked');
  assert.equal(f.events.filter(e=>e==='confirm').length,1);assert.equal(f.proofs.length,1);
});
test('restored Telegram email confirmation retains its attempt rather than starting registration again',async()=>{
  const saved={email:'typed@example.org',attemptEmail:'',attemptId:id,step:'telegram',verificationPending:true} as SavedAccountView;
  const f=fixture({saved,needsEmail:true,stage:'email'});await f.owner.refresh();
  assert.equal(f.flow.state.step,'email');assert.equal(f.flow.state.telegramPending,true);assert.equal(f.flow.state.attempt?.id,id);
  await f.flow.submit();assert.deepEqual(f.emails,[id]);assert.equal(f.events.includes('reserve'),false);
});
test('zero email-code timestamps do not mark an active Telegram attempt as expired',async()=>{
  const saved={email:'',attemptEmail:'',attemptId:id,step:'telegram',verificationPending:false} as SavedAccountView;
  const f=fixture({saved}),issue=()=>f.flow.state.issue;await f.owner.refresh();f.flow.tick();assert.equal(issue(),null);
  f.setTime(expiresAt);f.flow.tick();assert.equal(issue()?.code,'attempt_expired');
});

test('starting again after the original attempt expired does not claim its previous Telegram proof survives',async()=>{
  const f=fixture({needsEmail:true}),work=f.flow.telegram();await tick();f.token();await work;
  assert.equal(f.flow.state.telegramPending,true);f.setTime(expiresAt);f.flow.tick();f.flow.back();
  assert.equal(f.flow.state.attempt,null);assert.equal(f.flow.state.telegramPending,false);
});


test('a late cancelled start cannot open a provider window or replace the next action',async()=>{
  const f=fixture();f.holdStart();const first=f.flow.telegram();await tick();
  assert.equal(f.events.includes('popup'),false);f.flow.cancel();
  f.click();const second=f.flow.telegram();await tick();
  assert.equal(f.events.filter(event=>event==='popup').length,1);
  f.finishStart();await first;
  assert.equal(f.events.filter(event=>event==='popup').length,1);
  assert.equal(f.flow.state.busy,'telegram');assert.deepEqual(f.proofs,[]);
  f.token();await second;assert.equal(f.flow.state.screen,'linked');
  assert.equal(f.events.filter(event=>event==='confirm').length,1);
});
