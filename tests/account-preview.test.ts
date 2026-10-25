import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountAdapter, accountPreviewIdentity, type AccountScenario } from '../src/dev/account-adapter.ts';
import { standConnection } from '../src/dev/stand-connection.ts';
import { readModuleSource } from './helpers/module-source.ts';
import { isDevelopmentPort } from '../shared/development.ts';
import type { AccountRequest } from '../src/state/account-flow.ts';

const request: AccountRequest = {operation:'send',email:'anna@example.com',code:'',attempt:null,screen:'guest',telegramPending:false};
const signal = () => new AbortController().signal;
for (const mode of ['offline','server'] as const) test(`account stand ${mode} reports a cause without a fake login`,async()=>{
 standConnection.set(mode);
 try {await assert.rejects(createAccountAdapter({delay:0})(request,signal()), e=>e.code===(mode==='offline'?'offline':'server_unavailable'));}
 finally {standConnection.set('online');}
});
test('stand code, deadlines and Telegram mail gate match the review flow without real mail',async()=>{
 const adapter=createAccountAdapter({delay:0,now:()=>1000});
 const sent=await adapter(request,signal());assert.equal(sent.attempt?.expiresAt,1801000);assert.equal(sent.attempt?.codeExpiresAt,601000);assert.equal(sent.attempt?.resendAt,61000);
 await assert.rejects(adapter({...request,operation:'verify',code:'999999'},signal()),e=>e.code==='code_invalid');
 assert.equal((await adapter({...request,operation:'verify',code:'123456'},signal())).screen,'unlinked');
 const telegram=createAccountAdapter({delay:0,scenario:()=> 'new-telegram'});
 assert.deepEqual(await telegram({...request,operation:'telegram'},signal()),{needsEmail:true});
 assert.equal((await adapter({...request,operation:'verify',code:'123456',telegramPending:true},signal())).screen,'linked');
});
for (const [scenario,operation,code] of [
 ['send-failed','send','code_send_failed'],['delivery-failed','send','code_delivery_failed'],['rate-limit','verify','auth_rate_limited'],['verify-failed','verify','code_verify_failed'],['telegram-conflict','telegram','telegram_conflict']
] as const) test(`account ${scenario} remains a distinct failure`,async()=>{
 await assert.rejects(createAccountAdapter({delay:0,scenario:()=>scenario})({...request,operation},signal()),e=>e.code===code);
});
test('stand request cancellation rejects rather than delivering success',async()=>{
 const c=new AbortController();const pending=createAccountAdapter({delay:20})(request,c.signal);c.abort();
 await assert.rejects(pending,{name:'AbortError'});
});
const source=readModuleSource(new URL('../src/dev/account-preview.ts',import.meta.url)).replace(/^import[^\n]*\n/gm,'');
for(const port of ['', '80','443','8080','3637']) test(`account study is inert on ordinary port ${port||'default'}`,()=>{
 const forbidden=new Proxy({}, {get(){throw new Error('Stand code ran on a release port');}});
 new Function('location','document','sessionStorage','isDevelopmentPort',source)({port},forbidden,forbidden,isDevelopmentPort);
});


test('only the stand adapter supplies sample account identities and keeps explicitly entered mail', async () => {
 assert.equal(accountPreviewIdentity('guest'),null);
 assert.equal(accountPreviewIdentity('error'),null);
 assert.deepEqual(accountPreviewIdentity('linked'),{email:'anna@example.com',telegramHandle:'@username'});
 assert.deepEqual(accountPreviewIdentity('unlinked'),{email:'anna@example.com',telegramHandle:null});
 assert.deepEqual(accountPreviewIdentity('expired'),accountPreviewIdentity('linked'));
 const adapter=createAccountAdapter({delay:0});
 const email='rustam@example.org';
 const linked=await adapter({...request,email,operation:'telegram'},signal());
 assert.deepEqual(linked.identity,{email,telegramHandle:'@username'});
 const verified=await adapter({...request,email,operation:'verify',code:'123456'},signal());
 assert.deepEqual(verified.identity,{email,telegramHandle:null});
 const restored=await adapter({...request,operation:'retry'},signal());
 assert.deepEqual(restored.identity,accountPreviewIdentity('linked'));
});
