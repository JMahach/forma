import test from 'node:test';
import assert from 'node:assert/strict';
import {createActor,waitFor} from 'xstate';
import {createWriteContinuationMachine,writeContinuationView} from '../src/application/write-continuation.ts';
import {createChartActions} from '../src/state/chart-actions.ts';
import {accountChart,chartId} from './helpers/account-chart.ts';
import type {SavedChart} from '../shared/chart-types.ts';
import type {ChartWriteOutcome} from '../shared/chart-record-contract.ts';
import type {TemporaryWriteBinding} from '../src/application/write-continuation.ts';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture() {
  const {accountId,revision,noteRevision,publicRevision,...numbers}=accountChart();
  const source={...numbers,id:'temporary',createdAt:'',updatedAt:''} as SavedChart;
  let current:{accountId:string;sessionId:string}|null=null,binding:TemporaryWriteBinding|null=null,writes=0,adoptions=0,reads=0;
  let temporary:SavedChart|null=source,selected:SavedChart|null=source,screen='chart',hold=Promise.resolve(),lost=false;
  const own=accountChart(2),notices:string[]=[],effects:string[]=[];
  let rejection:Extract<ChartWriteOutcome,{kind:'rejected'}>['code']|null=null,publicWait=Promise.resolve(),responseWait=Promise.resolve();
  const actions=createChartActions({getSession:()=>current,newId:()=>chartId(9),calculate:async()=>{throw Error('unused');},
    prepareWrite:async()=>{await hold;return {kind:'memory-only'};},
    library:{async open(){reads++;return own;},async forget(){}},client:{
      async create(intent){writes++;await responseWait;if(lost)throw Error('lost reply');return {...intent,outcome:rejection
        ?{kind:'rejected',code:rejection,chartId:source.id}:{kind:'created',chartId:own.id,revision:1}};},
      async outcome(intent){return {...intent,outcome:{kind:'created',chartId:own.id,revision:1}};},
      async update(){throw Error('unused');},async remove(){throw Error('unused');},async addFromSource(){throw Error('unused');},
    }});
  const actor=createActor(createWriteContinuationMachine({actions,online:()=>true,getSession:()=>current,ready:async()=>{},
    source:()=>selected,temporary:()=>temporary,hasOwn:()=>false,binding:()=>binding,bind:value=>{binding=value;},
    retire:()=>{temporary=null;},public:async()=>{await publicWait;return own;},acceptPublic:()=>{effects.push('public');},clearPublic:()=>false,
    view:{signIn(){screen='account';},select(id){effects.push(id);},adopt(){adoptions++;},deleted(){},
      changed(){},checkpoint(){},report(kind){notices.push(kind);}},
  }));actor.start();
  const settled=()=>waitFor(actor,state=>!writeContinuationView(state).busy);
  return {actor,source,actions,settled,counts:()=>({writes,adoptions,reads}),screen:()=>screen,notices,effects,
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
  const f=fixture();try{
    let release!:()=>void;f.login();f.reject('source_changed',new Promise(resolve=>{release=resolve;}));
    f.actor.send({type:'SaveRequested',source:f.source});await tick();f.leave();release();await tick();
    assert.deepEqual(f.effects,[]);
  }finally{f.actor.send({type:'Stop'});}
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
