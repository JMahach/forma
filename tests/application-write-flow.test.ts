import test from 'node:test';
import assert from 'node:assert/strict';
import {createActor,waitFor} from 'xstate';
import {createWriteContinuationMachine,writeContinuationView} from '../src/application/write-continuation.ts';
import {createChartActions} from '../src/state/chart-actions.ts';
import {accountChart,chartId} from './helpers/account-chart.ts';
import type {SavedChart} from '../shared/chart-types.ts';
import type {ChartWriteOutcome} from '../shared/chart-record-contract.ts';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(shared=false) {
  const {accountId,revision,noteRevision,publicRevision,...numbers}=accountChart();
  const source={...numbers,id:'temporary',createdAt:'',updatedAt:'',...(shared?{revision:1}:{})} as SavedChart & {revision?:number};
  let current:{accountId:string;sessionId:string}|null=null,writes=0,adoptions=0,reads=0;
  let temporary:SavedChart|null=shared?null:source,selected:SavedChart|null=source,screen='chart',hold=Promise.resolve(),readyWait=Promise.resolve(),lost=false,saves=0;
  const own=accountChart(2),notices:string[]=[],effects:string[]=[],waitingAtSignIn:boolean[]=[];
  let rejection:Extract<ChartWriteOutcome,{kind:'rejected'}>['code']|null=null,publicWait=Promise.resolve(),responseWait=Promise.resolve();
  const actions=createChartActions({getSession:()=>current,newId:()=>chartId(9),
    prepareWrite:async()=>{await hold;return {kind:'memory-only'};},
    library:{async open(){reads++;return own;},async forget(){}},client:{
      async create(intent){writes++;await responseWait;if(lost)throw Error('lost reply');return {...intent,outcome:rejection
        ?{kind:'rejected',code:rejection,chartId:source.id}:{kind:'created',chartId:own.id,revision:1}};},
      async outcome(intent){return {...intent,outcome:{kind:'created',chartId:own.id,revision:1}};},
      async update(){throw Error('unused');},async remove(){throw Error('unused');},async addFromSource(){throw Error('unused');},
    }});
  const save=actions.saveSource;actions.saveSource=(...args)=>{saves++;return save(...args);};
  const actor=createActor(createWriteContinuationMachine({actions,online:()=>true,getSession:()=>current,ready:()=>readyWait,
    selection:{get record(){return selected;},get selectedId(){return selected?.id??'current-transit';},adopt(){adoptions++;return true;}},
    temporary:()=>temporary,hasOwn:()=>false,
    retire:()=>{temporary=null;},public:async()=>{await publicWait;return own;},acceptPublic:()=>{effects.push('public');},clearPublic:()=>false,
    view:{signIn(){waitingAtSignIn.push(writeContinuationView(actor.getSnapshot()).waitingForLogin);screen='account';},select(id){effects.push(id);},isChartScreen:()=>screen==='chart',showChart(){screen='chart';},publishChart(){},changeChart(){},refresh(){},
      changed(){},checkpoint(){},report(kind){notices.push(kind);}},
  }));actor.start();
  const settled=()=>waitFor(actor,state=>!writeContinuationView(state).busy);
  return {actor,source,actions,settled,coreCalls:()=>saves,ready(promise:Promise<void>){readyWait=promise;},counts:()=>({writes,adoptions,reads}),screen:()=>screen,notices,effects,waitingAtSignIn,select(){selected=source;},
    reject(code:NonNullable<typeof rejection>,wait=Promise.resolve()){rejection=code;publicWait=wait;},
    response(promise:Promise<void>){responseWait=promise;},expire(){current=null;},
    login(){current={accountId:'1',sessionId:'one'};actor.send({type:'ResumeWrite'});},
    hold(promise:Promise<void>){hold=promise;},lose(){lost=true;},leave(){selected=null;actor.send({type:'CancelWrite'});}};
}

test('the write machine continues explicit login once and cancels a held preparation without sending',async()=>{
  const f=fixture();try{
    f.actor.send({type:'SaveRequested',source:f.source});await f.settled();
    assert.equal(f.screen(),'account');assert.equal(f.counts().writes,0);
    assert.equal(writeContinuationView(f.actor.getSnapshot()).waitingForLogin,true);
    f.login();await f.settled();assert.deepEqual(f.counts(),{writes:1,adoptions:1,reads:1});
  }finally{f.actor.send({type:'Stop'});}
  for(const stop of [false,true]){const g=fixture();try{
    g.login();let release!:()=>void;g.hold(new Promise(resolve=>{release=resolve;}));
    g.actor.send({type:'SaveRequested',source:g.source});await tick();
    assert.equal(g.counts().writes,0);if(stop)g.actor.send({type:'Stop'});else g.leave();release();await tick();
    assert.equal(g.counts().writes,0);assert.deepEqual(g.actions.pending,[]);
  }finally{g.actor.send({type:'Stop'});}}
});

test('session expiry while the command replies ends the continuation without a false read failure or adoption',async()=>{
  const f=fixture();try{
    let release!:()=>void;f.login();f.response(new Promise(resolve=>{release=resolve;}));
    f.actor.send({type:'SaveRequested',source:f.source});await tick();assert.equal(f.counts().writes,1);
    f.expire();release();await f.settled();
    assert.equal(writeContinuationView(f.actor.getSnapshot()).source,null);
    assert.deepEqual(f.counts(),{writes:1,adoptions:0,reads:0});assert.deepEqual(f.notices,[]);
  }finally{f.actor.send({type:'Stop'});}
});

test('definitive refusals clear the continuation and a late public refresh cannot reopen a departed source',async()=>{
  for(const code of ['source_changed','not_found','note_conflict'] as const) {
    const f=fixture();try{
      f.login();f.reject(code);f.actor.send({type:'SaveRequested',source:f.source});await f.settled();
      assert.equal(f.counts().writes,1);assert.equal(f.counts().adoptions,0);
      assert.equal(writeContinuationView(f.actor.getSnapshot()).source,null);
      assert.deepEqual(f.effects,code==='source_changed'?['public',chartId(2)]:code==='not_found'?['current-transit']:[]);
      assert.deepEqual(f.notices,code==='note_conflict'?['failed']:[]);
    }finally{f.actor.send({type:'Stop'});}
  }
  for(const change of ['leave','rename','expire'] as const){const f=fixture();try{
    let release!:()=>void;f.login();f.reject('source_changed',new Promise(resolve=>{release=resolve;}));
    f.actor.send({type:'SaveRequested',source:f.source});await tick();
    if(change==='leave')f.leave();else if(change==='rename')f.source.name='Changed';else f.expire();
    release();await tick();assert.deepEqual(f.effects,[],change);
  }finally{f.actor.send({type:'Stop'});}}
});

test('unknown live save and simultaneous recovery reconcile one identity without repeating POST',async()=>{
  const f=fixture();try{
    f.login();f.lose();f.actor.send({type:'SaveRequested',source:f.source});await f.settled();
    assert.equal(f.counts().writes,1);assert.deepEqual(f.notices,['unconfirmed']);
    f.actor.send({type:'SaveRequested',source:f.source});f.actor.send({type:'RecoverWrites'});
    await f.settled();await tick();
    assert.deepEqual(f.counts(),{writes:1,adoptions:1,reads:1});assert.deepEqual(f.actions.pending,[]);
  }finally{f.actor.send({type:'Stop'});}
});

test('recovery discards a public source only after current absence, never from an old receipt alone',async()=>{
 const intent={expectedAccountId:'1',operationId:chartId(90)},own=accountChart(),outcome={kind:'absent' as const,chartId:own.id};
 for(const current of ['present','unavailable','absent'] as const) {
  let cleared=0,deleted=0;
  const actor=createActor(createWriteContinuationMachine({
   actions:{pending:[intent],saveSource(){throw Error('no command');},async recover(){return {kind:'settled',receipt:{...intent,outcome},active:true,
    chart:current==='present'?own:null,...(current==='unavailable'?{readError:Error('offline')}:{})};}},
   online:()=>true,getSession:()=>({accountId:'1',sessionId:'one'}),ready:async()=>{},selection:{record:{...own,createdAt:'',updatedAt:''},selectedId:own.id,adopt:()=>false},temporary:()=>null,
   hasOwn:()=>false,retire(){},public:async()=>own,acceptPublic(){},clearPublic(){cleared++;return true;},
   view:{signIn(){},select(){deleted++;},isChartScreen:()=>true,showChart(){},publishChart(){},changeChart(){},refresh(){},changed(){},checkpoint(){},report(){}},
  }));actor.start();actor.send({type:'RecoverWrites'});await tick();
  assert.equal(cleared,current==='absent'?1:0,current);assert.equal(deleted,cleared);actor.send({type:'Stop'});
 }
});


test('Save publishes waiting before sign-in navigation reads whether to preserve its continuation',async()=>{
 const f=fixture();try{
  f.actor.send({type:'SaveRequested',source:f.source});await f.settled();
  assert.deepEqual(f.waitingAtSignIn,[true]);
  f.login();await f.settled();assert.equal(f.counts().writes,1);
 }finally{f.actor.send({type:'Stop'});}
});

test('double Add shares one held command and a later Add after unknown and navigation reads its original outcome',async()=>{
 const f=fixture();try{
  f.login();f.lose();let release!:()=>void;f.response(new Promise(resolve=>{release=resolve;}));
  f.actor.send({type:'SaveRequested',source:f.source});await tick();
  f.actor.send({type:'SaveRequested',source:f.source});assert.equal(f.counts().writes,1);
  release();await f.settled();f.leave();f.select();
  f.actor.send({type:'SaveRequested',source:f.source});await f.settled();
  assert.deepEqual(f.counts(),{writes:1,adoptions:1,reads:1});
 }finally{f.actor.send({type:'Stop'});}
});

for(const change of ['cancel','source','revision','navigation'] as const)test(`login cannot continue Save after ${change}`,async()=>{
 const f=fixture(change==='revision');try{
  f.actor.send({type:'SaveRequested',source:f.source});await f.settled();
  if(change==='cancel')f.actor.send({type:'CancelWrite'});
  if(change==='source')f.source.name='Changed';
  if(change==='revision')f.source.revision!++;
  if(change==='navigation')f.leave();
  f.login();await f.settled();assert.deepEqual(f.counts(),{writes:0,adoptions:0,reads:0});
 }finally{f.actor.send({type:'Stop'});}
});

test('disposing the owning actor during checkpoint aborts the unsent command and drops its pointer',async()=>{
 const f=fixture();f.login();let release!:()=>void;f.hold(new Promise(resolve=>{release=resolve;}));
 f.actor.send({type:'SaveRequested',source:f.source});await tick();
 assert.equal(f.counts().writes,0);f.actor.stop();release();await tick();
 assert.equal(f.counts().writes,0);assert.deepEqual(f.actions.pending,[]);
});


test('stopping while account readiness waits never enters the command owner',async()=>{
 const f=fixture();f.login();let release!:()=>void;f.ready(new Promise(resolve=>{release=resolve;}));
 f.actor.send({type:'SaveRequested',source:f.source});await tick();f.actor.stop();release();await tick();
 assert.equal(f.coreCalls(),0);assert.equal(f.counts().writes,0);assert.deepEqual(f.actions.pending,[]);
});

test('a late unknown reply after actor disposal cannot show a notice or restore its source',async()=>{
 const f=fixture();f.login();f.lose();let release!:()=>void;f.response(new Promise(resolve=>{release=resolve;}));
 f.actor.send({type:'SaveRequested',source:f.source});await tick();assert.equal(f.counts().writes,1);
 f.actor.stop();release();await tick();assert.deepEqual(f.notices,[]);assert.equal(f.counts().adoptions,0);
});
