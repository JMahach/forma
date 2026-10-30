import test from 'node:test';
import {completeJournalEvent} from '../server/journal/events.ts';
import assert from 'node:assert/strict';
import { parseJournalEvent } from '../server/journal/events.ts';
const id='a'.repeat(32);
const mail={schemaVersion:1,eventId:'mail:'+id+':handed_off',occurredAt:1000,environment:'stand',
 source:'mail',event:'mail_handed_off',level:'info',outcome:'handed_off',codeId:id,contextId:id,
 recipient:'person@example.test',reason:'dsn:2.0.0'};
test('mail facts retain only the permitted recipient and structured delivery reason',()=>{
 assert.deepEqual(parseJournalEvent(mail),mail);
 assert.notEqual(parseJournalEvent(mail),mail);
 for(const key of ['code','secret','cookie','body','request','error','stack','url','ip','accountId','receivedAt','checksum']){
  assert.equal(parseJournalEvent({...mail,[key]:'forbidden'}),null,key);
 }
 assert.equal(parseJournalEvent({...mail,reason:'550 mailbox person@example.test code123456'}),null);
 assert.equal(parseJournalEvent({...mail,recipient:'person@example.test\r\ncode:123456'}),null);
});
test('account facts require the original account and cannot carry mail or browser information',()=>{
 const auth={schemaVersion:1,eventId:'auth:'+id+':login',occurredAt:1000,environment:'production',
  source:'account',event:'auth_login',level:'info',outcome:'succeeded',accountId:'42',contextId:id};
 assert.deepEqual(parseJournalEvent(auth),auth);
 for(const change of [{accountId:'person@example.test'},{recipient:'person@example.test'},
 {source:'mail'},{outcome:'handed_off'}])assert.equal(parseJournalEvent({...auth,...change}),null);
});
test('refusal, expiry and unknown outcome remain distinct from success',()=>{
 for(const [event,level,outcome,reason]of[
 ['mail_rejected','warn','rejected','dsn:5.1.1'],['mail_expired','info','expired','expired'],
 ['mail_outcome_unknown','warn','unknown','outcome_unknown']]){
  const value={...mail,eventId:'mail:'+id+':'+outcome,event,level,outcome,reason};
  assert.deepEqual(parseJournalEvent(value),value);
  assert.equal(parseJournalEvent({...value,outcome:'succeeded'}),null);
 }
});
test('unknown event kinds, malformed identifiers, bad clocks and accessors are rejected',()=>{
 for(const change of[{schemaVersion:2},{event:'page_view'},{environment:'dev'},
 {eventId:'https://site/card/secret'},{codeId:'123456'},{occurredAt:NaN},{occurredAt:Infinity},
 {occurredAt:-1},{occurredAt:1.5},{recipient:{}},{reason:'dsn:9.1.1'}]){
  assert.equal(parseJournalEvent({...mail,...change}),null);
 }
 assert.equal(parseJournalEvent(null),null);assert.equal(parseJournalEvent([]),null);
 const unsafe={...mail};
 Object.defineProperty(unsafe,'recipient',{enumerable:true,get(){throw Error('must not execute');}});
 assert.equal(parseJournalEvent(unsafe),null);
});

test('non-enumerable required fields cannot disappear from the accepted fact',()=>{
 const hidden={...mail};Object.defineProperty(hidden,'eventId',{value:mail.eventId,enumerable:false});
 assert.equal(parseJournalEvent(hidden),null);
});

import { createServerReporter } from '../server/journal/report.ts';
test('the composition reporter fills common fields once and acknowledges only durable acceptance',async()=>{
 const received:unknown[]=[];
 const reporter=createServerReporter({environment:'stand',now:()=>2000,
  write:async event=>{received.push(event);return {status:'accepted'};}});
 assert.equal(await reporter({event:'auth_login',contextId:id,accountId:'42',occurredAt:2000}),true);
 assert.deepEqual(received[0],{schemaVersion:1,eventId:'auth_login:'+id,occurredAt:2000,
  environment:'stand',source:'account',event:'auth_login',level:'info',outcome:'succeeded',
  contextId:id,accountId:'42'});
});
test('reporter preserves the first mail timestamp and refuses missing recipients and raw extras',async()=>{
 const received:unknown[]=[];
 const reporter=createServerReporter({environment:'production',now:()=>9999,
  write:async event=>{received.push(event);return {status:'accepted'};}});
 const fact={event:'mail_handed_off',eventId:mail.eventId,occurredAt:1000,
  codeId:id,contextId:id,recipient:mail.recipient,reason:'dsn:2.0.0'};
 assert.equal(await reporter(fact),true);
 assert.equal((received[0] as {occurredAt:number}).occurredAt,1000);
 assert.equal(await reporter({...fact,recipient:undefined}),false);
 assert.equal(await reporter({...fact,code:'123456'}),false);
 assert.equal(received.length,1);
});
test('journal failure never escapes the report port or becomes an acknowledgement',async()=>{
 for(const status of ['invalid','conflict','retryable'] as const){
  const report=createServerReporter({environment:'stand',write:async()=>({status})});
  assert.equal(await report({event:'auth_logout',contextId:id,accountId:'42',occurredAt:1000}),false);
 }
 const report=createServerReporter({environment:'stand',write:async()=>{throw Error('disk failed');}});
 assert.equal(await report({event:'auth_logout',contextId:id,accountId:'42',occurredAt:1000}),false);
});

test('journal accepts every Unicode address length already admitted by account policy without truncating it',()=>{
 const recipient='я'.repeat(240)+'@example.test';
 assert.ok(Buffer.byteLength(recipient)>320);
 const parsed=parseJournalEvent({...mail,recipient});assert.equal(parsed?.source,'mail');
 assert.ok(parsed);assert.equal(parsed.recipient,recipient);
 assert.equal(parseJournalEvent({...mail,recipient:'a'.repeat(255)+'@x.test'}),null);
});
test('expiry preserves the controlled remote delivery-deadline reason',()=>{
 const event={...mail,event:'mail_expired',outcome:'expired',reason:'dsn:4.4.7'};
 assert.deepEqual(parseJournalEvent(event),event);
 assert.equal(parseJournalEvent({...event,reason:'dsn:2.0.0'}),null);
});

test('repeatable account and terminal mail facts require their original time and identity',async()=>{
 const written:unknown[]=[];
 const report=createServerReporter({environment:'stand',write:async event=>{written.push(event);return{status:'accepted'};}});
 assert.equal(await report({event:'auth_login',contextId:id,accountId:'42'}),false);
 const terminal={event:'mail_handed_off',codeId:id,contextId:id,recipient:mail.recipient,reason:'dsn:2.0.0'};
 assert.equal(await report(terminal),false);
 assert.equal(await report({...terminal,eventId:mail.eventId}),false);
 assert.equal(await report({...terminal,occurredAt:1000}),false);
 assert.deepEqual(written,[]);
});
test('repeating a source fact never changes its immutable timestamp or event ID',async()=>{
 let now=2000;const written:unknown[]=[];
 const report=createServerReporter({environment:'stand',now:()=>now++,
  write:async event=>{written.push(event);return{status:'accepted'};}});
 const fact={event:'auth_login',contextId:id,accountId:'42',occurredAt:1000};
 assert.equal(await report(fact),true);assert.equal(await report(fact),true);
 assert.deepEqual(written[0],written[1]);
});

test('failed enqueue does not assert remote rejection after a lost SMTP acknowledgement', async()=>{
 const written:unknown[]=[];
 const report=createServerReporter({environment:'stand',write:async event=>{written.push(event);return{status:'accepted'};}});
 assert.equal(await report({event:'mail_enqueue_failed',contextId:id,occurredAt:1000}),true);
 assert.equal((written[0] as {outcome:string}).outcome,'failed');
});
test('each failure event permits only reasons consistent with its own outcome',()=>{
 const cases=[
  ['mail_attempt_failed','retryable',['attempt_failed','dsn:4.2.0'],['dsn:2.0.0','dsn:5.1.1','expired','cancel_failed']],
  ['mail_enqueue_failed','failed',['enqueue_failed'],['dsn:2.0.0','dsn:5.1.1','expired','attempt_failed']],
  ['mail_cancel_failed','unknown',['cancel_failed'],['dsn:2.0.0','dsn:5.1.1','expired','enqueue_failed']],
 ] as const;
 for(const[event,outcome,allowed,denied]of cases){
  const base={...mail,event,outcome,level:'warn'};
  for(const reason of allowed)assert.notEqual(parseJournalEvent({...base,reason}),null,event+':'+reason);
  for(const reason of denied)assert.equal(parseJournalEvent({...base,reason}),null,event+':'+reason);
 }
});

test('calculation failures contain only a fixed component and controlled technical cause',async()=>{
 const received:unknown[]=[];
 const report=createServerReporter({environment:'stand',now:()=>1000,write:async event=>{received.push(event);return{status:'accepted'};}});
 for(const component of ['calculator','transit_day','natal_day','cycles']){
  for(const reason of ['process','timeout','invalid_result']){
   assert.equal(await report({event:'calculation_failed',component,reason,occurredAt:1000}),true);
  }
 }
 const valid=received[0] as Record<string,unknown>;
 assert.equal(valid.source,'calculation');assert.equal(valid.outcome,'failed');
 for(const fields of [{component:'other'},{reason:'busy'},{reason:'cancelled'},{reason:'invalid_time'},
  {reason:'raw stderr'},{date:'2000-01-01'},{accountId:'1'},{contextId:id},{codeId:id},{recipient:mail.recipient}]){
  assert.equal(parseJournalEvent({...valid,...fields}),null);
 }
});


test('library preparation failures contain only a bounded stage, never card data or exceptions',()=>{
 const fact={schemaVersion:1,eventId:'library-prepare',occurredAt:1000,environment:'stand',
  source:'runtime',event:'library_preparation_failed',level:'error',outcome:'failed',reason:'prepare'};
 for(const reason of ['prepare','schedule'])assert.ok(parseJournalEvent({...fact,reason}));
 for(const extra of [{reason:'PRIVATE'},{chartId:'PRIVATE'},{error:Error('PRIVATE')},{accountId:'1'}])
  assert.equal(parseJournalEvent({...fact,...extra}),null);
});

test('system facts admit only fixed service and proxy failure reasons',()=>{
 const defaults={environment:'production' as const,occurredAt:1000,eventId:'system'};
 for(const component of ['application_service','nginx_service','postfix_service'])for(const reason of ['exit','signal','oom','timeout','resources','watchdog','protocol','start_limit']) {
  assert.ok(completeJournalEvent({event:'service_failed',component,reason},defaults));
 }
 for(const reason of ['bad_gateway','gateway_timeout'])assert.ok(completeJournalEvent({event:'service_failed',component:'nginx_proxy',reason},defaults));
 for(const extra of [{reason:'PRIVATE'},{message:'PRIVATE'},{url:'/PRIVATE'},{ip:'192.0.2.1'},{component:'PRIVATE'}])
  assert.equal(completeJournalEvent({event:'service_failed',component:'application_service',reason:'exit',...extra},defaults),null);
 assert.equal(completeJournalEvent({event:'service_failed',component:'nginx_proxy',reason:'oom'},defaults),null);
});
