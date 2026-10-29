import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createJournalRuntime } from '../server/journal/runtime.ts';
const NOW=40*86400000, id='a'.repeat(32);
const fact={event:'mail_handed_off',eventId:'mail:'+id+':handed_off',occurredAt:NOW,
 codeId:id,contextId:id,recipient:'person@example.test',reason:'dsn:2.0.0'};
function fixture(t:{after(fn:()=>void):void}) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'forma-journal-runtime-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;
}
function archive(directory:string):Record<string,unknown>[] {
 const location=path.join(directory,'archive');
 return fs.readdirSync(location).filter(n=>n.endsWith('.jsonl')).flatMap(n=>
 fs.readFileSync(path.join(location,n),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
}
function pending(directory:string) {
 const db=new DatabaseSync(path.join(directory,'mail-pending','pending.sqlite'));
 try{return Number(db.prepare('SELECT count(*) n FROM pending').get()!.n);}finally{db.close();}
}
test('runtime joins account reports and durable terminal-mail handoff into one archive',async t=>{
 const directory=fixture(t),runtime=createJournalRuntime({directory,environment:'stand',now:()=>NOW});
 try{
  assert.equal(await runtime.report({event:'auth_login',contextId:id,accountId:'1',occurredAt:NOW}),true);
  assert.deepEqual(await runtime.handoffMailReport(fact),{status:'buffered'});
  await runtime.flushMail();
 }finally{await runtime.close();}
 const rows=archive(directory);
 assert.equal(rows.length,2);
 assert.deepEqual(new Set(rows.map(r=>r.event)),new Set(['auth_login','mail_handed_off']));
 assert.equal(pending(directory),0);
 assert.equal(rows.find(r=>r.event==='mail_handed_off')!.occurredAt,NOW);
 assert.ok(rows.every(r=>!('body' in r)&&!('code' in r)&&!('cookie' in r)));
});
test('a failed archive retains durable handoff for restart and preserves original time',async t=>{
 const directory=fixture(t),blocked=path.join(directory,'archive');
 fs.writeFileSync(blocked,'blocked');
 let runtime=createJournalRuntime({directory,environment:'production',now:()=>NOW});
 try{
  assert.equal(await runtime.report({event:'auth_logout',contextId:id,accountId:'1',occurredAt:NOW}),false);
  assert.deepEqual(await runtime.handoffMailReport(fact),{status:'buffered'});
  assert.equal(await runtime.flushMail(),0);
 }finally{await runtime.close();}
 assert.equal(pending(directory),1);
 fs.unlinkSync(blocked);
 runtime=createJournalRuntime({directory,environment:'production',now:()=>NOW+1000});
 try{await runtime.flushMail();}finally{await runtime.close();}
 const rows=archive(directory);assert.equal(rows.length,1);
 assert.equal(rows[0].eventId,fact.eventId);assert.equal(rows[0].occurredAt,NOW);
 assert.equal(rows[0].receivedAt,NOW+1000);assert.equal(pending(directory),0);
});
test('handoff replay after final acceptance never duplicates the journal event',async t=>{
 const directory=fixture(t);
 let runtime=createJournalRuntime({directory,environment:'stand',now:()=>NOW});
 try{
  assert.deepEqual(await runtime.handoffMailReport(fact),{status:'buffered'});
  await runtime.flushMail();
 }finally{await runtime.close();}
 runtime=createJournalRuntime({directory,environment:'stand',now:()=>NOW+1});
 try{
  assert.deepEqual(await runtime.handoffMailReport(fact),{status:'buffered'});
  await runtime.flushMail();
 }finally{await runtime.close();}
 assert.equal(archive(directory).length,1);assert.equal(pending(directory),0);
});
test('invalid handoff and closed runtime do not return a durable acknowledgement',async t=>{
 const directory=fixture(t),runtime=createJournalRuntime({directory,environment:'stand',now:()=>NOW});
 assert.deepEqual(await runtime.handoffMailReport({...fact,body:'secret'}),{status:'unavailable'});
 assert.deepEqual(await runtime.handoffMailReport({event:'mail_queued',codeId:id,contextId:id,recipient:fact.recipient}),{status:'unavailable'});
 await runtime.close();
 assert.deepEqual(await runtime.handoffMailReport(fact),{status:'unavailable'});
 assert.equal(await runtime.report({event:'auth_login',contextId:id,accountId:'1',occurredAt:NOW}),false);
});

import { openDatabase } from '../server/storage/database.ts';
import { createAccounts, type AccountCredentials } from '../server/services/accounts.ts';
import type { CodeMail } from '../server/mail/code-mail.ts';
for(const unavailable of [false,true])test('real account transitions remain successful with journal unavailable='+unavailable,async t=>{
 const directory=fixture(t);
 if(unavailable)fs.writeFileSync(path.join(directory,'archive'),'blocked');
 const runtime=createJournalRuntime({directory,environment:'stand',now:()=>NOW});
 const database=openDatabase(':memory:'),mails:CodeMail[]=[],reports:Promise<boolean>[]=[];
 const accounts=createAccounts({database,key:Buffer.alloc(32,1),now:()=>NOW,
  mail:{async enqueue(mail){mails.push(mail);},async cancel(){}},
  report:fact=>{const result=runtime.report(fact);reports.push(result);return result;}});
 const credentials:AccountCredentials={bindings:{},sessions:{}};
 try{
  const started=await accounts.start({email:'person@example.test',ip:'192.0.2.1',credentials});
  credentials.bindings[started.attempt.id]=started.binding.secret;
  const grant=accounts.verify(started.attempt.id,mails[0]!.code,credentials);
  credentials.sessions[started.attempt.id]=grant.secret;
  const account=accounts.confirm(started.attempt.id,credentials);
  assert.equal(accounts.current(credentials)?.account.id,account.account.id);
  await accounts.logout(started.attempt.id,credentials);
  assert.equal(accounts.current(credentials),null);
  assert.deepEqual(await Promise.all(reports),[!unavailable,!unavailable]);
 }finally{database.close();await runtime.close();}
 if(!unavailable){
  const rows=archive(directory);assert.deepEqual(rows.map(row=>row.event),['auth_login','auth_logout']);
  assert.ok(rows.every(row=>!('email'in row)&&!('recipient'in row)&&!('code'in row)&&!('cookie'in row)));
 }
});

test('shutdown rejects new reports immediately while completing the already admitted final fact',async t=>{
 const directory=fixture(t),runtime=createJournalRuntime({directory,environment:'stand',now:()=>NOW});
 const admitted=runtime.report({event:'chart_cleanup_failed',occurredAt:NOW});
 const first=runtime.close(),second=runtime.close();
 assert.equal(first,second);
 assert.equal(await runtime.report({event:'account_cleanup_failed',occurredAt:NOW}),false);
 await first;
 assert.equal(await admitted,true);
 assert.deepEqual(archive(directory).map(row=>row.event),['chart_cleanup_failed']);
});

test('shutdown deadline releases an unconfirmed fact without a success acknowledgement',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const directory=fixture(t),runtime=createJournalRuntime({directory,environment:'stand',now:()=>NOW});
 const admitted=runtime.report({event:'chart_cleanup_failed',occurredAt:NOW});
 const stopped=runtime.close();
 // Advance the shutdown deadline before the cold worker can acknowledge startup.
 t.mock.timers.tick(5_000);
 try{await stopped;assert.equal(await admitted,false);}
 finally{await runtime.close();t.mock.timers.reset();}
});

test('browser receipt uses the same durable archive and preserves first delivery metadata on retry',async t=>{
 const directory=fixture(t),runtime=createJournalRuntime({directory,environment:'stand',now:()=>NOW,
  clientReservedBytes:2*1024*1024});
 const client={schemaVersion:1 as const,eventId:'00000000-0000-4000-8000-000000000001',occurredAt:1,
  source:'browser' as const,environment:'stand' as const,accountId:null,appVersion:'0.2',
  contextId:'00000000-0000-4000-8000-000000000002',action:'chart_open' as const,component:'chart' as const,
  stage:'request' as const,reason:'server_error' as const,event:'client_failed' as const,level:'error' as const,outcome:'failed' as const};
 try {
  assert.deepEqual(await runtime.receiveClient(client,'192.0.2.1'),{status:'accepted',receivedAt:NOW,duplicate:false});
  assert.deepEqual(await runtime.receiveClient(client,'192.0.2.2'),{status:'accepted',receivedAt:NOW,duplicate:true});
  assert.equal((await runtime.usage()).journal.externalBytes,8*1024*1024+2*1024*1024);
 }finally{await runtime.close();}
 const rows=archive(directory);assert.equal(rows.length,1);assert.equal(rows[0].deliveryIp,'192.0.2.1');
 assert.equal(rows[0].occurredAt,1);assert.equal(rows[0].receivedAt,NOW);
 assert.deepEqual(await runtime.receiveClient(client,'192.0.2.1'),{status:'retryable',reason:'journal_unavailable'});
});

test('recovered mail handoff admits a bounded writer batch and preserves every individual durable ACK',async t=>{
 const {openMailBuffer}=await import('../server/journal/mail-buffer.ts');
 const {Worker}=await import('node:worker_threads');
 const directory=fixture(t),mailDirectory=path.join(directory,'mail-pending');
 fs.mkdirSync(mailDirectory,{mode:0o700});
 const buffer=openMailBuffer({filename:path.join(mailDirectory,'pending.sqlite'),now:()=>NOW});
 const {completeJournalEvent}=await import('../server/journal/events.ts');
 for(let i=0;i<32;i++){
  const event=completeJournalEvent({...fact,eventId:'mail:synthetic:'+i},{environment:'stand',occurredAt:NOW,eventId:'unused'});
  assert.ok(event);assert.equal(buffer.stage(event).status,'buffered');
 }
 buffer.close();
 const post=Worker.prototype.postMessage,batches:number[]=[];
 Worker.prototype.postMessage=function(value:unknown,...args:Parameters<typeof post> extends [unknown,...infer Rest]?Rest:never){
  if(value && typeof value==='object' && 'kind'in value && value.kind==='batch' && 'entries'in value && Array.isArray(value.entries))batches.push(value.entries.length);
  return post.call(this,value,...args);
 };
 const runtime=createJournalRuntime({directory,environment:'stand',now:()=>NOW});
 try{await runtime.flushMail();}finally{await runtime.close();Worker.prototype.postMessage=post;}
 assert.equal(archive(directory).length,32);assert.equal(pending(directory),0);
 assert.ok(batches.some(length=>length===32),JSON.stringify(batches));
});

test('a conflict in a recovered batch keeps only that pending event while later durable ACKs release theirs',async t=>{
 const {openMailBuffer}=await import('../server/journal/mail-buffer.ts');
 const {openJournalStore}=await import('../server/journal/store.ts');
 const {completeJournalEvent}=await import('../server/journal/events.ts');
 const directory=fixture(t),mailDirectory=path.join(directory,'mail-pending');fs.mkdirSync(mailDirectory,{mode:0o700});
 const event=completeJournalEvent(fact,{environment:'stand',occurredAt:NOW,eventId:'unused'});assert.ok(event);
 const archiveStore=openJournalStore({directory:path.join(directory,'archive')});
 assert.equal(archiveStore.append({...event,recipient:'previous@example.test'},NOW,0).status,'accepted');archiveStore.close();
 const buffer=openMailBuffer({filename:path.join(mailDirectory,'pending.sqlite'),now:()=>NOW});
 assert.equal(buffer.stage(event).status,'buffered');
 for(let i=0;i<31;i++)assert.equal(buffer.stage({...event,eventId:'mail:later:'+i}).status,'buffered');buffer.close();
 const runtime=createJournalRuntime({directory,environment:'stand',now:()=>NOW});
 try{assert.equal(await runtime.flushMail(),31);}finally{await runtime.close();}
 assert.equal(archive(directory).length,32);assert.equal(pending(directory),1);
});
