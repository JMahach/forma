import test from 'node:test';
import assert from 'node:assert/strict';
import {createActor} from 'xstate';
import {createPublicRefreshMachine,publicRefreshCheck} from '../src/application/public-refresh.ts';
import {accountNatalChart} from './helpers/account-chart.ts';
function view() {return {isChartScreen:()=>true,selectTransit(){},changeChart(){},refresh(){},checkpoint(){}};}
const library={has:()=>false,get:()=>null};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('a public HTTP response after background permission is revoked cannot update the source',async()=>{
 const own=accountNatalChart();const {accountId,note,noteRevision,publicRevision,...source}=own;
 let release!:(value:typeof source)=>void,accepted=0;
 const read=new Promise<typeof source>(resolve=>{release=resolve;});
 const controller=new AbortController(),authority={signal:controller.signal,permit:{key:'public:'+source.id,token:'x',owner:'A',startedAt:1,expiresAt:30001},current:async()=>!controller.signal.aborted};
 const actor=createActor(createPublicRefreshMachine({sources:{get publicChart(){return source;},acceptPublic(){accepted++;},clearPublic(){accepted++;}},session:{selectedId:source.id,refreshRecord(){}},library,id:()=>"id",getSession:()=>null,read:()=>read,view:view()},()=>true)).start();
 actor.send({type:'RefreshPublicSource',authority});await tick();controller.abort();release(source);await tick();
 assert.equal(accepted,0);actor.stop();
});
test('one public read reports its real outcome and peers cannot replace another selection or newer revision',async()=>{
 const {accountId,note,noteRevision,publicRevision,...original}=accountNatalChart();
 let source=original,missing=0,mode='success',access:{accountId:string;sessionId:string}|null={accountId:'1',sessionId:'s'};
 const actor=createActor(createPublicRefreshMachine({sources:{get publicChart(){return source;},acceptPublic(next){source=next;},clearPublic(){missing++;}},session:{get selectedId(){return source.id;},refreshRecord(){}},library,id:()=>"id",view:view(),getSession:()=>access,
  async read(){if(mode!=='success')throw {code:mode,retryAfterMs:120000};return {...source,revision:source.revision+1};},
 },()=>true)).start();
 const results:unknown[]=[];actor.send({type:'RefreshPublicSource',completed:value=>results.push(value)});
 const target=publicRefreshCheck(actor.getSnapshot())!.target;await tick();actor.send({type:'PublicRefreshChanged'});
 assert.equal(publicRefreshCheck(actor.getSnapshot())!.target,target,'accepted content preserves the existing check identity');
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

test('a route read satisfies the immediate public check but not a later hourly check',async()=>{
 const {accountId,note,noteRevision,publicRevision,...source}=accountNatalChart();let reads=0;
 const actor=createActor(createPublicRefreshMachine({sources:{get publicChart(){return source;},acceptPublic(){},clearPublic(){}},session:{selectedId:source.id,refreshRecord(){}},library,id:()=>"id",view:view(),getSession:()=>null,
  read:async()=>{reads++;return source;},
 },()=>true)).start();
 actor.send({type:'PublicSourceRead',source,checkedAt:10000,receivedAt:20000});
 const signal=new AbortController().signal,results:unknown[]=[];
 const check=(at:number)=>actor.send({type:'RefreshPublicSource',authority:{signal,current:async()=>true,
  permit:{key:'public:'+source.id,token:'p',owner:'A',startedAt:at,expiresAt:at+30000}},completed:value=>results.push(value)});
 check(20001);await tick();assert.equal(reads,0);assert.equal(results.length,1);
 check(22000);await tick();assert.equal(reads,1);actor.stop();
});

test('a route receipt remains fresh before startup has selected the accepted public card',async()=>{
 const {accountId,note,noteRevision,publicRevision,...source}=accountNatalChart();let selected='current-transit',reads=0;
 const actor=createActor(createPublicRefreshMachine({sources:{publicChart:source,acceptPublic(){},clearPublic(){}},
  session:{get selectedId(){return selected;},refreshRecord(){}},library,id:()=>crypto.randomUUID(),view:view(),getSession:()=>null,
  read:async()=>{reads++;return source;},
 },()=>true)).start();
 actor.send({type:'PublicSourceRead',source,checkedAt:10000,receivedAt:20000});selected=source.id;
 actor.send({type:'PublicRefreshChanged'});
 actor.send({type:'RefreshPublicSource',authority:{signal:new AbortController().signal,current:async()=>true,
  permit:{key:'public:'+source.id,token:'p',owner:'A',startedAt:20001,expiresAt:50000}}});
 await tick();assert.equal(reads,0);actor.stop();
});

for(const departed of ['source','session','permission'] as const)test(`late public reply needs current ${departed} even when transport is not aborted`,async()=>{
 const {accountId,note,noteRevision,publicRevision,...original}=accountNatalChart();let source=original,access={accountId:'1',sessionId:'old'},permitted=true,accepted=0;
 let finish!:(value:typeof original)=>void;
 const signal=new AbortController().signal,results:unknown[]=[];
 const actor=createActor(createPublicRefreshMachine({sources:{get publicChart(){return source;},acceptPublic(){accepted++;},clearPublic(){accepted++;}},
  session:{get selectedId(){return source.id;},refreshRecord(){}},library,id:()=>crypto.randomUUID(),view:view(),getSession:()=>access,
  read:()=>new Promise(resolve=>{finish=resolve;}),
 },()=>true)).start();
 actor.send({type:'RefreshPublicSource',authority:{signal,current:async()=>permitted,permit:{key:'public:'+source.id,token:'p',owner:'A',startedAt:1,expiresAt:30000}},completed:value=>results.push(value)});
 await tick();
 if(departed==='source')source={...source,revision:source.revision+1};
 if(departed==='session')access={...access,sessionId:'new'};
 if(departed==='permission')permitted=false;
 finish(original);await tick();assert.equal(signal.aborted,false);assert.equal(accepted,0);assert.deepEqual(results,[{outcome:{kind:'cancelled'}}]);actor.stop();
});

test('a fresh route read from the previous session cannot replace the new session check',async()=>{
 const {accountId,note,noteRevision,publicRevision,...source}=accountNatalChart();let access={accountId:'1',sessionId:'old'},reads=0;
 const actor=createActor(createPublicRefreshMachine({sources:{publicChart:source,acceptPublic(){},clearPublic(){}},
  session:{selectedId:source.id,refreshRecord(){}},library,id:()=>crypto.randomUUID(),view:view(),getSession:()=>access,
  read:async()=>{reads++;return source;},
 },()=>true)).start();
 actor.send({type:'PublicSourceRead',source,checkedAt:10000,receivedAt:20000});access={accountId:'2',sessionId:'new'};
 actor.send({type:'RefreshPublicSource',authority:{signal:new AbortController().signal,current:async()=>true,
  permit:{key:'public:'+source.id,token:'p',owner:'A',startedAt:20001,expiresAt:50000}}});
 await tick();assert.equal(reads,1);actor.stop();
});
