import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { createAccountRuntime } from '../server/accounts.ts';
import { accountEnvironment } from '../server/runtime/account-environment.ts';
import { openDatabase } from '../server/storage/database.ts';
import { createAccountStorage } from '../server/storage/accounts.ts';
import { captureResponse } from './helpers/http-response.ts';
const time=1_800_000_000_000;
const pair=await generateKeyPair('RS256',{extractable:true});
const keys={keys:[{...await exportJWK(pair.publicKey),kid:'test',alg:'RS256',use:'sig'}]};
const signed=(nonce:string,extra={})=>new SignJWT({iss:'https://oauth.telegram.org',aud:'42',sub:'independent',id:123,
 iat:time/1000,exp:time/1000+600,nonce,...extra}).setProtectedHeader({alg:'RS256',kid:'test'}).sign(pair.privateKey);
interface Body {error?:string;attempt?:{id:string;expiresAt:number};telegram?:{nonce:string;clientId:string;scope:string[]};
 needsEmail?:boolean;needsConfirmation?:boolean;stage?:string;canConfirm?:boolean;account?:{id:string;telegramLinked:boolean;telegramHandle:string|null}|null}
async function fixture(t:{after:(fn:()=>Promise<void>)=>void},enabled=true,fetch?:typeof globalThis.fetch){
 const directory=await mkdtemp(path.join(os.tmpdir(),'forma-telegram-runtime-'));
 const runtime=await createAccountRuntime({configuration:accountEnvironment({FORMA_STATE_DIR:directory,
  ...(enabled?{FORMA_TELEGRAM_CLIENT_ID:'42'}:{})},3636),now:()=>time,telegramFetch:fetch??(async()=>Response.json(keys))});
 t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
 const jar=new Map<string,string>();
 async function query(url:string,body?:unknown,origin='http://localhost:3636'){
  const req=Object.assign(Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]),{method:body===undefined?'GET':'POST',url,
   headers:{host:'localhost:3636',origin,'content-type':'application/json',cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')},socket:{remoteAddress:'127.0.0.1'}}) as unknown as IncomingMessage;
  const res=captureResponse();await runtime.handler(req,res,new URL(url,'http://localhost:3636'));
  const cookies=res.headers['Set-Cookie'] as string[]|undefined;
  for(const c of cookies??[]){const [pair]=c.split(';'),index=pair!.indexOf('='),name=pair!.slice(0,index),value=pair!.slice(index+1);
   if(/Max-Age=0(?:;|$)/.test(c))jar.delete(name);else jar.set(name,value);}
  return {status:res.status,body:JSON.parse(res.body) as Body,headers:res.headers};
 }
 return {runtime,directory,query,jar};
}
test('Telegram configuration is optional, explicit, validated and unavailable when absent',async t=>{
 assert.equal(accountEnvironment({},3636).telegramClientId,undefined);
 assert.equal(accountEnvironment({FORMA_TELEGRAM_CLIENT_ID:'42'},3636).telegramClientId,'42');
 for(const value of ['', 'abc','-1','0','42.5',' 42'])assert.throws(()=>accountEnvironment({FORMA_TELEGRAM_CLIENT_ID:value},3636));
 const f=await fixture(t,false);const r=await f.query('/api/auth/telegram/start',{});
 assert.equal(r.status,503);assert.equal(r.body.error,'telegram_unavailable');
});
test('locally signed test token uses common HTTP attempt/confirm and persists a linked account without exposing secrets',async t=>{
 const f=await fixture(t),db=openDatabase(path.join(f.directory,'forma.sqlite'));
 const storage=createAccountStorage(db),account=storage.ensureAccount('a@example.test');storage.linkTelegram(account.id,'123',null);db.close();
 const start=await f.query('/api/auth/telegram/start',{});assert.equal(start.status,200);assert.equal(start.body.telegram!.clientId,'42');
 assert.deepEqual(start.body.telegram!.scope,['profile']);const attemptId=start.body.attempt!.id;
 assert.equal((await f.query('/api/auth/attempt?id='+attemptId)).body.stage,'telegram');
 // Bigger than the email endpoint's 4 KiB limit, but below the bounded Telegram token limit.
 const idToken=await signed(start.body.telegram!.nonce,{padding:'x'.repeat(4000)});
 assert.ok(idToken.length>4096);
 const verified=await f.query('/api/auth/telegram/verify',{attemptId,idToken});assert.equal(verified.status,200);
 assert.equal(verified.body.needsEmail,false);assert.equal(verified.body.needsConfirmation,true);
 assert.equal(JSON.stringify(verified.body).includes('secret'),false);assert.equal((await f.query('/api/account')).body.account,null);
 const progress=await f.query('/api/auth/attempt?id='+attemptId);assert.equal(progress.body.canConfirm,true);
 const confirmed=await f.query('/api/auth/confirm',{attemptId});assert.equal(confirmed.status,200);
 assert.equal(confirmed.body.account!.id,String(account.id));assert.equal(confirmed.body.account!.telegramLinked,true);
 assert.equal(confirmed.body.account!.telegramHandle,null);assert.deepEqual((await f.query('/api/auth/confirm',{attemptId})).body,confirmed.body);
 assert.equal(verified.headers['Cache-Control'],'private, no-store');
});
test('new Telegram account needs email, cancellation consumes access, and old aliases are gone',async t=>{
 const f=await fixture(t);const start=await f.query('/api/auth/telegram/start',{});const attemptId=start.body.attempt!.id;
 const idToken=await signed(start.body.telegram!.nonce);const verified=await f.query('/api/auth/telegram/verify',{attemptId,idToken});
 assert.equal(verified.body.needsEmail,true);assert.equal(verified.body.needsConfirmation,false);
 assert.equal((await f.query('/api/auth/attempt?id='+attemptId)).body.stage,'email');
 assert.equal((await f.query('/api/auth/cancel',{attemptId})).status,200);
 assert.equal((await f.query('/api/auth/telegram/verify',{attemptId,idToken})).status,410);
 for(const action of ['confirm','cancel'])assert.equal((await f.query('/api/auth/email/'+action,{attemptId})).status,404);
 assert.equal((await f.query('/api/auth/email/attempt?id='+attemptId)).status,404);
});
test('origin, ownership and body limits are enforced before external verification',async t=>{
 let calls=0;const f=await fixture(t,true,async()=>{calls++;return Response.json(keys);});
 assert.equal((await f.query('/api/auth/telegram/start',{},'https://evil.test')).status,403);
 const start=await f.query('/api/auth/telegram/start',{}),attemptId=start.body.attempt!.id;
 assert.equal((await f.query('/api/auth/telegram/verify',{attemptId,idToken:'x'.repeat(21*1024)})).status,413);
 f.jar.clear();assert.equal((await f.query('/api/auth/telegram/verify',{attemptId,idToken:'signed'})).status,401);assert.equal(calls,0);
});
test('runtime shutdown cancels pending key fetching and late work never touches closed storage',async t=>{
 let entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;});let aborted=false;
 const f=await fixture(t,true,async(_input,options)=>new Promise((_resolve,reject)=>{
  entered();options!.signal!.addEventListener('abort',()=>{aborted=true;reject(new DOMException('Aborted','AbortError'));},{once:true});
 }));
 const start=await f.query('/api/auth/telegram/start',{}),attemptId=start.body.attempt!.id;
 const pending=f.query('/api/auth/telegram/verify',{attemptId,idToken:await signed(start.body.telegram!.nonce)});
 await ready;await f.runtime.close();await pending;assert.equal(aborted,true);
});
