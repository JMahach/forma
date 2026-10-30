import test from 'node:test';
import assert from 'node:assert/strict';
import {createActor} from 'xstate';
import {createPublicRefreshMachine} from '../src/application/public-refresh.ts';
import {accountNatalChart} from './helpers/account-chart.ts';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('a public HTTP response after background permission is revoked cannot update the source',async()=>{
 const own=accountNatalChart();const {accountId,note,noteRevision,publicRevision,...source}=own;
 let release!:(value:typeof source)=>void,accepted=0;
 const read=new Promise<typeof source>(resolve=>{release=resolve;});
 const controller=new AbortController(),authority={signal:controller.signal,permit:{key:'public:'+source.id,token:'x',owner:'A',startedAt:1,expiresAt:30001},current:async()=>!controller.signal.aborted};
 const actor=createActor(createPublicRefreshMachine({source:()=>source,getSession:()=>null,available:()=>true,read:()=>read,accept(){accepted++;},missing(){accepted++;}})).start();
 actor.send({type:'RefreshPublicSource',authority});await tick();controller.abort();release(source);await tick();
 assert.equal(accepted,0);actor.stop();
});
test('one public read reports its real outcome and peers cannot replace another selection or newer revision',async()=>{
 const {accountId,note,noteRevision,publicRevision,...original}=accountNatalChart();
 let source=original,missing=0,mode='success',access:{accountId:string;sessionId:string}|null={accountId:'1',sessionId:'s'};
 const actor=createActor(createPublicRefreshMachine({source:()=>source,getSession:()=>access,available:()=>true,
  async read(){if(mode!=='success')throw {code:mode,retryAfterMs:120000};return {...source,revision:source.revision+1};},
  accept(_old,next){source=next;},missing(){missing++;},
 })).start();
 const results:unknown[]=[];actor.send({type:'RefreshPublicSource',completed:value=>results.push(value)});await tick();
 assert.equal(source.revision,2);assert.equal(results.length,1);
 actor.send({type:'PublicSourceObserved',source:original,access,data:{missing:original.id}});assert.equal(missing,0);
 actor.send({type:'PublicSourceObserved',source,access,data:{chart:original}});assert.equal(source.revision,2);
 const previous=source;actor.send({type:'PublicSourceObserved',source,access,data:{chart:{...source,revision:3}}});assert.equal(source.revision,3);
 actor.send({type:'PublicSourceObserved',source,access:{accountId:'1',sessionId:'old'},data:{missing:source.id}});assert.equal(missing,0);
 actor.send({type:'PublicSourceObserved',source,access,data:{chart:{}}});assert.equal(source.revision,3);
 mode='not_found';actor.send({type:'RefreshPublicSource',completed:value=>results.push(value)});await tick();assert.equal(missing,1);
 mode='busy';actor.send({type:'RefreshPublicSource',completed:value=>results.push(value)});await tick();assert.deepEqual(results.at(-1),{outcome:{kind:'failed',retryAfterMs:120000}});
 access=null;actor.send({type:'PublicSourceObserved',source,access,data:{missing:source.id,revision:source.revision}});assert.equal(missing,2);actor.stop();
});
