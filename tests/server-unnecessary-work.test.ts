import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { openDatabase } from '../server/storage/database.ts';
import { createAccountStorage } from '../server/storage/accounts.ts';
import { createChartRecordStorage } from '../server/storage/chart-records.ts';
import { canonicalChartId } from '../shared/chart-record-contract.ts';
import { createAccounts } from '../server/services/accounts.ts';
import { openMailBuffer } from '../server/journal/mail-buffer.ts';
import { accountNatalChart } from './helpers/account-chart.ts';
import { ACCOUNT_POLICY } from '../server/services/account-policy.ts';

function fixture(t: test.TestContext) {
 const db=openDatabase(':memory:');t.after(()=>db.close());
 const accounts=createAccountStorage(db),owner=String(accounts.ensureAccount('synthetic@example.test').id);
 const storage=createChartRecordStorage(db,canonicalChartId),chart=accountNatalChart(1,owner);
 const {id,accountId,revision,noteRevision,publicRevision,...content}=chart;
 storage.insert(chart,chart.name,1,content);
 const changes=()=>Number(db.connection.prepare('SELECT total_changes() n').get()!.n);
 return {db,accounts,owner,storage,chart,changes};
}
test('library pagination uses an account and ID index without sorting another account',t=>{
 const f=fixture(t);
 const plan=f.db.connection.prepare('EXPLAIN QUERY PLAN SELECT * FROM account_charts WHERE accountId=? AND id>? ORDER BY id LIMIT ?').all(f.owner,'',101);
 assert.ok(plan.some(row=>String(row.detail).includes('account_charts_account_id')));
 assert.ok(plan.every(row=>!String(row.detail).includes('TEMP B-TREE')));
});
test('identical prepared returns change one row, while versions and changed content still replace it',t=>{
 const f=fixture(t),before=f.changes();
 for(let i=0;i<3;i++)f.storage.saveReturn(f.chart.id,'events','saturn','','numbers','cycles',{events:[]});
 assert.equal(f.changes()-before,1);
 f.storage.saveReturn(f.chart.id,'events','saturn','','numbers','next',{events:[]});
 f.storage.saveReturn(f.chart.id,'events','saturn','','numbers','next',{events:[1]});
 assert.equal(f.changes()-before,3);
});
test('issued ID migration runs once and retains addresses reserved for deleted charts',t=>{
 const f=fixture(t);f.storage.remove(f.owner,f.chart.id);
 let calls=0;
 for(let i=0;i<3;i++)createChartRecordStorage(f.db,id=>{calls++;return canonicalChartId(id);});
 assert.equal(calls,0);
 assert.equal(f.storage.identifierUsed(f.chart.id),true);
});
test('identical clock session reads make no row change but still check credentials and exact expiry',t=>{
 const f=fixture(t),id='c'.repeat(32),secret='synthetic-secret';let time=1_000_000;
 f.accounts.saveSession({id,accountId:Number(f.owner),secretHash:createHash('sha256').update(secret).digest('hex'),
  createdAt:time,expiresAt:time+ACCOUNT_POLICY.sessionMs,bindingHash:null,bindingExpiresAt:0});
 const accounts=createAccounts({database:f.db,key:new Uint8Array(32),now:()=>time,
  mail:{async enqueue(){assert.fail('must not send');},async cancel(){}}});
 const credentials={bindings:{},sessions:{[id]:secret}},before=f.changes();
 accounts.current(credentials);accounts.current(credentials);assert.equal(f.changes()-before,0);
 time++;accounts.current(credentials);assert.equal(f.changes()-before,1);
 assert.equal(f.accounts.session(id)!.expiresAt,time+ACCOUNT_POLICY.sessionMs);
 assert.equal(accounts.current({bindings:{},sessions:{[id]:'wrong'}}),null);
 time+=ACCOUNT_POLICY.sessionMs;assert.equal(accounts.current(credentials),null);
});
test('empty mail buffer batches keep safety checks without write transactions or directory syncs',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'forma-empty-mail-'));fs.chmodSync(directory,0o700);
 const buffer=openMailBuffer({filename:path.join(directory,'pending.sqlite'),now:()=>1_000_000});
 t.after(()=>{buffer.close();fs.rmSync(directory,{recursive:true,force:true});});
 let begins=0,syncs=0,checks=0;
 const exec=DatabaseSync.prototype.exec,sync=fs.fsyncSync,lstat=fs.lstatSync;
 DatabaseSync.prototype.exec=function(sql){if(sql==='BEGIN IMMEDIATE')begins++;return exec.call(this,sql);};
 fs.fsyncSync=(fd)=>{syncs++;return sync(fd);};
 Object.defineProperty(fs,'lstatSync',{value:(...args: Parameters<typeof fs.lstatSync>)=>{checks++;return lstat(...args);}});
 try{for(let i=0;i<10;i++)assert.deepEqual(buffer.batch(),[]);}
 finally{DatabaseSync.prototype.exec=exec;fs.fsyncSync=sync;Object.defineProperty(fs,'lstatSync',{value:lstat});}
 assert.equal(begins,0);assert.equal(syncs,0);assert.ok(checks>=40);
});

test('account cleanup clears expired secrets once and keeps live secrets until their deadline',t=>{
 const f=fixture(t);
 for(const [suffix,secretDeadline] of [['expired',100],['live',200]] as const){
  f.accounts.saveAttempt({id:`attempt-${suffix}`,email:'synthetic@example.test',bindingHash:'binding',
   createdAt:0,expiresAt:300,previousSessionId:null,codeId:`code-${suffix}`,codeHash:'code-hash',
   codeExpiresAt:secretDeadline,resendAt:0,mailExpiresAt:300,sessionHash:null,
   telegramNonce:null,telegramId:null,telegramHandle:null,targetAccountId:null});
  f.accounts.saveSession({id:`session-${suffix}`,accountId:Number(f.owner),secretHash:'session-secret',
   createdAt:0,expiresAt:300,bindingHash:'binding-hash',bindingExpiresAt:secretDeadline});
 }
 let before=f.changes();f.accounts.cleanup(100);assert.equal(f.changes()-before,2);
 assert.equal(f.accounts.attempt('attempt-expired')!.codeHash,null);
 assert.equal(f.accounts.session('session-expired')!.bindingHash,null);
 assert.equal(f.accounts.attempt('attempt-live')!.codeHash,'code-hash');
 assert.equal(f.accounts.session('session-live')!.bindingHash,'binding-hash');
 before=f.changes();f.accounts.cleanup(101);assert.equal(f.changes()-before,0);
 f.accounts.cleanup(200);assert.equal(f.changes()-before,2);
 before=f.changes();f.accounts.cleanup(299);assert.equal(f.changes()-before,0);
 f.accounts.cleanup(300);assert.equal(f.changes()-before,4);
 assert.equal(f.accounts.attempt('attempt-expired'),undefined);
 assert.equal(f.accounts.session('session-live'),undefined);
});
