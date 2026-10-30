import test from 'node:test';
import assert from 'node:assert/strict';
import {claimCheck,finishCheck,nextCheckAt,HOUR,CHECK_TIMEOUT,claimLeader,samePermit} from '../src/domain/background-policy.ts';
import type {BackgroundControl,CheckTarget} from '../src/domain/background-check.ts';
const app:CheckTarget={key:'app',scope:{kind:'app'}};
const library:CheckTarget={key:'library:1',scope:{kind:'library',accountId:'1'},sessionId:'a'};
const empty=():BackgroundControl=>({leader:null,checks:{}});
test('independent contours coalesce across tabs and a real return replaces only its own hour',()=>{
 const state=empty();
 const a=claimCheck(state,app,'A',10000,'lifecycle','a')!;
 const b=claimCheck(state,library,'B',10000,'lifecycle','b')!;
 assert.equal(claimCheck(state,app,'B',10001,'lifecycle','c'),null);
 finishCheck(state,a,{kind:'success'},10005);finishCheck(state,b,{kind:'success'},10005);
 assert.equal(claimCheck(state,app,'B',10020,'lifecycle','c'),null);
 assert.equal(claimCheck(state,app,'B',10000+59*60000,'hourly','c'),null);
 const returned=claimCheck(state,app,'B',10000+50*60000,'lifecycle','c')!;
 finishCheck(state,returned,{kind:'success'},returned.startedAt+10);
 assert.equal(state.checks.app.nextDueAt,10000+110*60000);
 assert.equal(state.checks[library.key].nextDueAt,10000+HOUR);
});
test('401 and Retry-After survive a new owner; errors never become success',()=>{
 const state=empty(),a=claimCheck(state,library,'A',10000,'lifecycle','a')!;
 finishCheck(state,a,{kind:'unauthorized'},10001);
 assert.equal(state.checks[library.key].lastSuccessAt,null);
 assert.equal(nextCheckAt(state.checks[library.key],library,10002),null);
 assert.equal(claimCheck(state,library,'B',10000+2*HOUR,'lifecycle','b'),null);
 const renewed={...library,sessionId:'b'},b=claimCheck(state,renewed,'B',10002,'changed','b')!;
 assert.ok(b);finishCheck(state,b,{kind:'failed',retryAfterMs:2*HOUR},10003);
 assert.equal(claimCheck(state,renewed,'C',10003+HOUR,'lifecycle','c'),null);
 assert.equal(nextCheckAt(state.checks[library.key],renewed,10004),10003+2*HOUR);
});
test('expired owners cannot finish and missed hours do not accumulate',()=>{
 const state=empty(),a=claimCheck(state,app,'A',10000,'lifecycle','a')!;
 assert.equal(finishCheck(state,a,{kind:'success'},a.expiresAt),false);
 const b=claimCheck(state,app,'B',10000+3*HOUR,'hourly','b')!;
 assert.ok(b);assert.equal(state.checks.app.nextDueAt,10000+4*HOUR);
 assert.equal(finishCheck(state,a,{kind:'success'},b.startedAt),false);
 assert.equal(claimCheck(state,app,'C',b.startedAt,'hourly','c'),null);
});
test('clock rollback and an elapsed monotonic due cannot leave a check waiting forever',()=>{
 const state=empty(),a=claimCheck(state,app,'A',10*HOUR,'lifecycle','a')!;
 finishCheck(state,a,{kind:'success'},a.startedAt+1);
 assert.ok(claimCheck(state,app,'B',HOUR,'hourly','b'));
 const state2=empty(),b=claimCheck(state2,app,'A',10*HOUR,'lifecycle','b')!;
 finishCheck(state2,b,{kind:'success'},b.startedAt+1);
 assert.ok(claimCheck(state2,app,'B',10*HOUR+1000,'hourly','c',b.startedAt));
});
test('one leader survives ordinary events, and only its expired published lease can be replaced',()=>{
 const state=empty();const a=claimLeader(state,'A',10000,10000+HOUR,'a')!;
 assert.equal(claimLeader(state,'B',10001,10001+HOUR,'b'),null);
 assert.equal(claimLeader(state,'B',10002,10002+HOUR,'b',{...a,expiresAt:a.expiresAt+1}),null);
 const b=claimLeader(state,'B',10002,10002+HOUR,'b',a)!;
 assert.equal(b.owner,'B');assert.equal(CHECK_TIMEOUT,30000);
});

test('permission identity includes token, owner, contour and session even before expiry',()=>{
 const state=empty(),permit=claimCheck(state,library,'A',10000,'lifecycle','token')!;
 assert.equal(samePermit(undefined,permit),false);
 for(const key of ['token','owner','key','sessionId'] as const){
  const other={...permit,[key]:'different'};
  assert.equal(samePermit(other,permit),false);
  assert.equal(finishCheck(state,other,{kind:'success'},10001),false);
 }
 assert.equal(finishCheck(state,permit,{kind:'success'},10001),true);
 assert.equal(finishCheck(state,permit,{kind:'success'},10002),false);
});
test('the exact deadline admits one attempt, including a renewed session after server pause',()=>{
 for(const changeSession of [false,true]){
  const state=empty(),permit=claimCheck(state,library,'A',10000,'lifecycle','a')!;
  finishCheck(state,permit,{kind:'failed',retryAfterMs:120000},10001);
  const target=changeSession?{...library,sessionId:'new'}:library;
  assert.equal(claimCheck(state,target,'B',130000,'lifecycle','b'),null);
  assert.ok(claimCheck(state,target,'B',130001,'lifecycle','b'));
 }
 for(const complete of [false,true]){
  const state=empty(),permit=claimCheck(state,app,'A',10000,'lifecycle','a')!;
  if(complete)finishCheck(state,permit,{kind:'success'},10001);
  const due=complete?10000+HOUR:permit.expiresAt;
  assert.ok(claimCheck(state,app,'B',due,complete?'hourly':'lifecycle','b'));
 }
});
