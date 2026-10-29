import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { captureResponse } from './helpers/http-response.ts';
import { createRequestHandler } from '../server/http/app.ts';
import { createCityCatalog } from '../server/services/cities.ts';
import { openDatabase } from '../server/storage/database.ts';
import { createAccounts, type AccountCredentials } from '../server/services/accounts.ts';
import { ACCOUNT_POLICY } from '../server/services/account-policy.ts';
import type { ClientReport } from '../shared/client-report-contract.ts';
import type { CodeMail } from '../server/mail/code-mail.ts';

const uuid=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const report=(n=1,accountId:string|null=null):ClientReport=>({schemaVersion:1,eventId:uuid(n),occurredAt:1,
 source:'browser',environment:'stand',accountId,appVersion:'0.2',contextId:uuid(100),action:'chart_open',
 component:'chart',stage:'request',reason:'server_error',event:'client_failed',level:'error',outcome:'failed'});
function request(body:unknown,options:{method?:string;origin?:string|null;ip?:string;cookie?:string;forwarded?:string;diagnosticProof?:string}={}) {
 return Object.assign(Readable.from([JSON.stringify(body)]),{url:'/api/diagnostics',method:options.method??'POST',
  headers:{host:'forma.example.test','content-type':'application/json',cookie:options.cookie??'',
   ...(options.origin===null?{}:{origin:options.origin??'https://forma.example.test'}),
   ...(options.forwarded?{'x-real-ip':options.forwarded}:{}),
   ...(options.diagnosticProof===undefined?{}:{'x-forma-diagnostic-proof':options.diagnosticProof})},socket:{remoteAddress:options.ip??'192.0.2.12'}}) as unknown as IncomingMessage;
}
const body=(...reports:unknown[])=>({schemaVersion:1,reports});
async function handler(options:Record<string,unknown>={}) {
 const {createDiagnosticHandler}=await import('../server/http/diagnostics.ts');
 return createDiagnosticHandler({origins:['https://forma.example.test'],
  accounts:{diagnosticOwner:()=>null},write:async()=>({status:'accepted',receivedAt:100,duplicate:false}),...options});
}
async function call(handle:Awaited<ReturnType<typeof handler>>,input:unknown,options:Parameters<typeof request>[1]={}) {
 const res=captureResponse();await handle(request(input,options),res);
 return{status:res.status,body:JSON.parse(res.body),headers:res.headers};
}
test('diagnostic route never falls through to the application shell when unavailable',async()=>{
 const handle=createRequestHandler({root:'/unused',cities:createCityCatalog([]),calculate:async()=>{throw new Error('unused');},
  publicFiles:async(_req,res)=>{res.writeHead(200,{});res.end('application shell');}});
 const res=captureResponse();await handle(request(body(report())),res);
 assert.equal(res.status,503);assert.deepEqual(JSON.parse(res.body),{error:'diagnostics_unavailable'});
});
test('a diagnostic ACK waits for the durable writer and preserves the delivery address',async()=>{
 let release!:(value:unknown)=>void,written:unknown;
 const pending=new Promise(resolve=>{release=resolve;});
 const handle=await handler({write:(value:unknown)=>{written=value;return pending;}});
 let replied=false;const response=call(handle,body(report()),{forwarded:'203.0.113.99'}).then(value=>{replied=true;return value;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(replied,false);
 assert.deepEqual(written,{...report(),deliveryIp:'192.0.2.12'});
 release({status:'accepted',receivedAt:100,duplicate:false});
 const result=await response;assert.equal(result.status,200);
 assert.deepEqual(result.body,{schemaVersion:1,results:[{eventId:uuid(1),status:'accepted',receivedAt:100,duplicate:false}]});
 assert.equal(result.headers['Set-Cookie'],undefined);
});
test('partial batches preserve ownership and reject only definitively malformed reports',async()=>{
 const written:unknown[]=[];
 const handle=await handler({accounts:{diagnosticOwner:()=> '5'},write:async(value:unknown)=>{written.push(value);return{status:'accepted',receivedAt:100,duplicate:false};}});
 const result=await call(handle,body(report(1),report(2,'5'),report(3,'6'),{...report(4),note:'PRIVATE'},report(5)),{});
 assert.deepEqual(result.body.results.map((r:{status:string})=>r.status),['accepted','accepted','retryable','invalid','accepted']);
 assert.equal(result.body.results[2].reason,'ownership_unverified');
 assert.equal(result.body.results[3].final,true);
 assert.deepEqual(written.map((r:any)=>r.accountId),[null,'5',null]);
 assert.equal(JSON.stringify(written).includes('PRIVATE'),false);
});
test('expired credentials neither delete the old report nor turn it into a guest report',async()=>{
 let writes=0;const handle=await handler({write:async()=>{writes++;throw new Error('must not write');}});
 const result=await call(handle,body(report(1,'5')));
 assert.deepEqual(result.body.results,[{eventId:uuid(1),status:'retryable',reason:'ownership_unverified'}]);assert.equal(writes,0);
});
test('same origin, bounded envelope and unique report IDs are checked before admission',async()=>{
 let writes=0;const handle=await handler({write:async()=>{writes++;throw new Error('must not write');}});
 for(const origin of [null,'https://other.example.test'])assert.equal((await call(handle,body(report()),{origin})).status,403);
 assert.equal((await call(handle,body(report()),{method:'GET'})).status,405);
 assert.equal((await call(handle,body(report(),report()))).status,400);
 assert.equal((await call(handle,body(...Array.from({length:33},(_,i)=>report(i))))).status,400);
 assert.equal((await call(handle,{schemaVersion:1,reports:[],extra:'not allowed'})).status,400);
 assert.equal((await call(handle,body({...report(),extra:'x'.repeat(65536)}))).status,413);
 assert.equal((await call(handle,body({...report(),eventId:'invalid'}))).status,400);
 assert.equal(writes,0);
});
test('only an explicitly trusted loopback proxy supplies the delivery address',async()=>{
 let written:any;const handle=await handler({trustLoopbackProxy:true,write:async(value:unknown)=>{written=value;return{status:'accepted',receivedAt:100,duplicate:false};}});
 await call(handle,body(report()),{ip:'::ffff:127.0.0.1',forwarded:'203.0.113.9'});assert.equal(written.deliveryIp,'203.0.113.9');
 await call(handle,body(report()),{ip:'192.0.2.2',forwarded:'203.0.113.9'});assert.equal(written.deliveryIp,'192.0.2.2');
 assert.equal((await call(handle,body(report()),{ip:'not an ip'})).status,503);
});
test('writer failures and pressure are retryable, content conflicts are final',async()=>{
 const responses=[{status:'retryable',reason:'journal_queue_full'},{status:'conflict',reason:'event_id_conflict'},{status:'invalid',reason:'event_too_large'}];
 const handle=await handler({write:async()=>responses.shift()});
 const result=await call(handle,body(report(1),report(2),report(3)));
 assert.deepEqual(result.body.results,[{eventId:uuid(1),status:'retryable',reason:'unavailable'},
  {eventId:uuid(2),status:'invalid',final:true,reason:'event_id_conflict'},
  {eventId:uuid(3),status:'invalid',final:true,reason:'report_too_large'}]);
 const failed=await handler({write:async()=>{throw new Error('private failure details');}});
 assert.deepEqual((await call(failed,body(report()))).body.results,[{eventId:uuid(1),status:'retryable',reason:'unavailable'}]);
});
test('bounded concurrent admission returns retryable pressure before allocating another body',async()=>{
 let release!:(value:any)=>void;const pending=new Promise(resolve=>{release=resolve;});
 const handle=await handler({write:()=>pending});
 const requests=Array.from({length:8},(_,i)=>call(handle,body(report(i))));
 await new Promise(resolve=>setImmediate(resolve));
 const blocked=await call(handle,body(report(20)));assert.equal(blocked.status,429);
 assert.equal(blocked.headers['Retry-After'],'1');
 release({status:'accepted',receivedAt:100,duplicate:false});await Promise.all(requests);
 assert.equal((await call(handle,body(report(21)))).status,200);
});
test('diagnostic ownership lookup never extends a session or creates access after expiry',async t=>{
 const database=openDatabase(':memory:');t.after(()=>database.close());let time=1_000_000;const mail:CodeMail[]=[];
 const accounts=createAccounts({database,key:Buffer.alloc(32,9),now:()=>time,
  mail:{async enqueue(value){mail.push(value);},async cancel(){}}});
 const proof:AccountCredentials={bindings:{},sessions:{}};
 const start=await accounts.start({email:'owner@example.test',ip:'192.0.2.1',credentials:proof});
 proof.bindings[start.attempt.id]=start.binding.secret;
 const grant=accounts.verify(start.attempt.id,mail[0]!.code,proof);proof.sessions[start.attempt.id]=grant.secret;
 const login=accounts.confirm(start.attempt.id,proof);
 time+=1000;assert.equal(accounts.diagnosticOwner(proof),login.account.id);
 assert.equal(accounts.diagnosticOwner({bindings:proof.bindings,sessions:{}}),null);
 time=1_000_000+ACCOUNT_POLICY.sessionMs;
 assert.equal(accounts.diagnosticOwner(proof),null);
 assert.equal(accounts.current(proof),null);
});

test('a scoped transport IP cannot make a valid client report definitively invalid',async()=>{
 let writes=0;const handle=await handler({write:async()=>{writes++;return{status:'invalid',reason:'invalid_event'};}});
 assert.equal((await call(handle,body(report()),{ip:'fe80::1%en0'})).status,503);
 assert.equal(writes,0);
});
test('a report preserves its original valid environment after deployment changes',async()=>{
 let recorded:any;const handle=await handler({environment:'production',write:async(value:unknown)=>{recorded=value;return{status:'accepted',receivedAt:100,duplicate:false};}});
 const result=await call(handle,body(report()));
 assert.equal(result.body.results[0].status,'accepted');assert.equal(recorded.environment,'stand');
});


async function signedAccount(t:{after:(fn:()=>void)=>void}) {
 const database=openDatabase(':memory:');t.after(()=>database.close());let time=1_000_000;const mails:CodeMail[]=[];
 const key=Buffer.alloc(32,9),mail={async enqueue(value:CodeMail){mails.push(value);},async cancel(){}};
 const accounts=createAccounts({database,key,now:()=>time,mail});
 const credentials:AccountCredentials={bindings:{},sessions:{}};
 const start=await accounts.start({email:'origin@example.test',ip:'192.0.2.1',credentials});
 credentials.bindings[start.attempt.id]=start.binding.secret;
 const grant=accounts.verify(start.attempt.id,mails[0]!.code,credentials);credentials.sessions[start.attempt.id]=grant.secret;
 const login=accounts.confirm(start.attempt.id,credentials);
 return {database,key,mail,accounts,credentials,login,now:()=>time,advance:(ms:number)=>{time+=ms;}};
}

test('signed report origin survives session expiry and cleanup without restoring account access',async t=>{
 const f=await signedAccount(t),signature=f.login.session.diagnosticProof;
 assert.equal(typeof signature,'string');
 assert.equal(f.accounts.current(f.credentials)?.session.diagnosticProof,signature);
 f.advance(ACCOUNT_POLICY.sessionMs+1);f.accounts.cleanup();
 assert.equal(f.database.connection.prepare('SELECT count(*) n FROM account_sessions').get()!.n,0);
 assert.equal(f.accounts.current(f.credentials),null);
 const impersonation={bindings:{},sessions:{[f.login.session.id]:signature!}};
 assert.equal(f.accounts.current(impersonation),null);
 const {createChartRuntime}=await import('../server/charts.ts');
 const charts=createChartRuntime({database:f.database,accounts:f.accounts,cities:createCityCatalog([]),
  calculate:Object.assign(async()=>{throw new Error('Diagnostic proof must not trigger a chart calculation');},{async close(){}}),
  origins:['https://forma.example.test'],now:f.now});
 const url=new URL('/api/charts?accountId='+f.login.account.id,'https://forma.example.test');
 const req=Object.assign(request(undefined,{method:'GET',diagnosticProof:signature}),{url:url.pathname+url.search});
 const res=captureResponse();await charts.handler(req,res,url);
 assert.equal(res.status,401);assert.equal(JSON.parse(res.body).error,'auth_required');
 const written:unknown[]=[];
 const handle=await handler({accounts:f.accounts,write:async(value:unknown)=>{written.push(value);return {status:'accepted',receivedAt:100,duplicate:false};}});
 const original={...report(1,f.login.account.id),occurredAt:f.now()};
 const result=await call(handle,body(original,report(2),report(3,'999')),{diagnosticProof:signature});
 assert.deepEqual(result.body.results.map((r:{status:string})=>r.status),['accepted','accepted','retryable']);
 assert.deepEqual(written,[{...original,deliveryIp:'192.0.2.12'},{...report(2),deliveryIp:'192.0.2.12'}]);
 assert.equal(JSON.stringify(written).includes(signature!),false);
 assert.equal(f.accounts.current(f.credentials),null);
 assert.equal(f.database.connection.prepare('SELECT count(*) n FROM account_sessions').get()!.n,0);
});

test('diagnostic origin is purpose-bound and cannot be relabelled or fall back from a forged proof',async t=>{
 const f=await signedAccount(t),token=f.login.session.diagnosticProof!;
 assert.equal(typeof token,'string');
 const empty={bindings:{},sessions:{}};
 const {createHmac}=await import('node:crypto');
 const payload=`v1.${f.login.account.id}.${f.login.session.id}`;
 const wrongPurpose=payload+'.'+createHmac('sha256',f.key).update('forma:calculation-receipt:v1\0').update(payload).digest('base64url');
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
 const noncanonical=token.slice(0,-1)+alphabet[alphabet.indexOf(token.at(-1)!)|1];
 assert.deepEqual(Buffer.from(noncanonical.split('.').at(-1)!,'base64url'),Buffer.from(token.split('.').at(-1)!,'base64url'));
 const otherKey=createAccounts({database:f.database,key:Buffer.alloc(32,8),mail:f.mail,now:f.now});
 assert.equal(otherKey.diagnosticOwner(empty,token),null);
 for(const wrong of ['',token+'x',token.replace(/^v1\.[^.]+/, 'v1.999'),token.replace(f.login.session.id,'f'.repeat(32)),
   token.slice(0,-1)+(token.endsWith('a')?'b':'a'),wrongPurpose,noncanonical,'x'.repeat(129),[token]]) {
  assert.equal(f.accounts.diagnosticOwner(f.credentials,wrong),null,'A supplied invalid proof never borrows the active cookie identity');
 }
 assert.equal(f.accounts.diagnosticOwner(f.credentials),f.login.account.id);
 assert.equal(f.accounts.diagnosticOwner(empty,token),f.login.account.id);
 const expiresAt=f.database.connection.prepare('SELECT expiresAt FROM account_sessions WHERE id=?').get(f.login.session.id)!.expiresAt;
 f.advance(1000);assert.equal(f.accounts.diagnosticOwner(empty,token),f.login.account.id);
 assert.equal(f.database.connection.prepare('SELECT expiresAt FROM account_sessions WHERE id=?').get(f.login.session.id)!.expiresAt,expiresAt);
 await f.accounts.logout(f.login.session.id,f.credentials);
 assert.equal(f.accounts.current(f.credentials),null);
 // Origin is not a revocable access grant; a final exit request may arrive after logout.
 assert.equal(f.accounts.diagnosticOwner(empty,token),f.login.account.id);
});
