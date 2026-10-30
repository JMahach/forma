import {createUpdatePreparation} from '../src/application/update.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application/application.ts';
import {createChartActions} from '../src/state/chart-actions.ts';
import {accountChart,chartId} from './helpers/account-chart.ts';

async function fixture() {
  let selected='owned',ready=true,durable:boolean|Promise<boolean>=true,stored=true,writes=0,reads=0;
  const app=createApplication({runtimeId:'update',startup:{
    library:{get:()=>null,open:async()=>{}},view:{interrupted:false,savedSelection:undefined,restore:async()=>true,resume(){},flush(){}},
    form:{pending:null,opened:false,clearPending(){},restore(){}},report(){},changed(){},
  },update:{restored:()=>true,ready:()=>ready,selection:()=>selected,
    sources:{temporaryId:null,publicId:null,hasOwn:()=>true,canRestore(){reads++;return durable;}},checkpoint(){writes++;return stored;}}});
  app.start();await app.whenRestored();
  return {app,setSelected(value:string){selected=value;},setReady(value:boolean){ready=value;},
    setDurable(value:boolean|Promise<boolean>){durable=value;},setStored(value:boolean){stored=value;},
    get writes(){return writes;},get reads(){return reads;}};
}

test('release preparation requires a durable selection and one accepted checkpoint',async()=>{
  const h=await fixture();h.setReady(false);
  assert.equal(h.app.prepareUpdate(),false);assert.equal(h.reads,0);assert.equal(h.writes,0);
  h.setReady(true);h.setDurable(false);
  assert.equal(h.app.prepareUpdate(),false);assert.equal(h.writes,0);
  h.setDurable(true);h.setStored(false);
  assert.equal(h.app.prepareUpdate(),false);assert.equal(h.writes,1);
  h.setStored(true);assert.equal(h.app.prepareUpdate(),true);assert.equal(h.writes,2);
  await h.app.stop();assert.equal(h.app.prepareUpdate(),false);assert.equal(h.writes,2);
});

for(const boundary of ['selection','input','stop','failure'] as const)test(`release revalidates after the durable read: ${boundary}`,async()=>{
  const h=await fixture();let resolve!:(value:boolean)=>void,reject!:(reason:unknown)=>void;
  h.setDurable(new Promise((yes,no)=>{resolve=yes;reject=no;}));
  const preparing=h.app.prepareUpdate();
  if(boundary==='selection')h.setSelected('another');
  if(boundary==='input')h.setReady(false);
  if(boundary==='stop')await h.app.stop();
  if(boundary==='failure')reject(new Error('storage unavailable'));else resolve(true);
  assert.equal(await preparing,false);assert.equal(h.writes,0);
  await h.app.stop();
});

test('preparation waits for the active write, then holds its own permission until cancellation',async()=>{
 let release!:()=>void,writes=0,changes=0;
 const idle=new Promise<void>(resolve=>{release=resolve;});
 const owner=createUpdatePreparation({restored:()=>true,ready:()=>true,selection:()=> 'current-transit',
  sources:{temporaryId:null,publicId:null,hasOwn:()=>false,canRestore:()=>false},checkpoint(){writes++;return true;}},
  {ready:()=>true,changed(){changes++;},idle:()=>idle});
 const first=new AbortController(),second=new AbortController();
 const abandoned=owner.prepare(first.signal);assert.equal(owner.active,true);assert.equal(writes,0);
 first.abort();assert.equal(await abandoned,false);assert.equal(owner.active,false);
 const accepted=owner.prepare(second.signal);release();assert.equal(await accepted,true);assert.equal(writes,1);assert.equal(owner.active,true);
 first.abort();assert.equal(owner.active,true,'a retired preparation cannot release the new one');
 second.abort();assert.equal(owner.active,false);assert.equal(changes,4);owner.stop();
});

test('update waits for real recovery acceptance, then blocks new recovery without waiting for unknown intents',async t=>{
 const chart=accountChart(),intent={expectedAccountId:chart.accountId,operationId:chartId(80)},unknown={...intent,operationId:chartId(81)};
 let release!:()=>void,restore!:()=>void,reads=0,placements=0,checkpoints=0,prepared=false,restoring=false;
 const restoration=new Promise<void>(resolve=>{restore=resolve;});
 const placement=new Promise<void>(resolve=>{release=resolve;}),control=new AbortController(),session={accountId:chart.accountId,sessionId:'update'};
 const actions=createChartActions({getSession:()=>session,initialPending:[intent,unknown],
  library:{async open(){placements++;await placement;return chart;},async forget(){}},
  client:{async outcome(value){reads++;return {...value,outcome:value.operationId===unknown.operationId?{kind:'unknown'}:{kind:'created',chartId:chart.id,revision:1}};},
   create:async()=>assert.fail('recovery cannot POST'),update:async()=>assert.fail('recovery cannot update'),remove:async()=>assert.fail('recovery cannot remove'),addFromSource:async()=>assert.fail('recovery cannot add')},
 });
 const app=createApplication({runtimeId:'recovery-update',account:{
  ready:Promise.resolve(),getSession:()=>session,subscribeSession:()=>()=>{},subscribeLogout:()=>()=>{},
  library:{storageAvailable:true,accountId:session.accountId,restore:async()=>{},connect:async()=>{},clear:async()=>({accountId:session.accountId,status:'cleared'}),retryClear:async()=> 'cleared'},
  writes:actions,binding:{accountId:null,clear(){}},form:{pending:null,snapshot:null,opened:false,clearPending(){},discardInput(){},close(){}},
  editing:{reset(){}},checkpoint:{clearPersonal:()=>true,flush:()=>true},changed(){},storageUnavailable(){assert.fail('no storage failure');},
 },background:{coordinator:{start(){},update(){},stop(){}},clock:{now:()=>0},release:null,journal:null,
  environment:{visible:()=>true,online:()=>true,connected:()=>true,busy:()=>false,transitTimeZone:()=>undefined},local:{changed(){},broadcast(){}},
 },startup:{
  library:{get:()=>null,open:async()=>{}},view:{interrupted:false,savedSelection:undefined,async restore(){restoring=true;await restoration;return true;},resume(){},flush(){}},
  form:{pending:null,opened:false,clearPending(){},restore(){}},report(){},changed(){},
 },write:{actions,online:()=>true,getSession:()=>session,selection:{record:null,selectedId:'current-transit',adopt:()=>false},
  temporary:()=>null,hasOwn:()=>false,retire(){},public:async()=>assert.fail('no public read'),acceptPublic(){},clearPublic:()=>false,
  view:{isChartScreen:()=>true,showChart(){},changeChart(){},refresh(){},changed(){},checkpoint(){},report(){}},
 },update:{restored:()=>true,ready:()=>true,selection:()=> 'current-transit',sources:{temporaryId:null,publicId:null,hasOwn:()=>false,canRestore:()=>false},checkpoint(){checkpoints++;return true;}}});
 t.after(async()=>{restore();release();control.abort();await app.stop();});app.start();
 for(let turn=0;turn<20 && !restoring;turn++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(restoring,true);assert.equal(reads,0,'account readiness alone must not recover before the tab restores');
 restore();await app.whenRestored();
 await new Promise(resolve=>setImmediate(resolve));assert.equal(placements,1);
 const preparing=Promise.resolve(app.prepareUpdate(control.signal)).then(value=>{prepared=true;return value;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(prepared,false);assert.equal(checkpoints,0);
 release();assert.equal(await preparing,true);assert.equal(checkpoints,1);assert.equal(reads,2);assert.deepEqual(actions.pending,[unknown]);
 app.environmentChanged({reason:'lifecycle',returned:true});app.send({type:'RecoverWrites'});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,2,'update permission blocks both automatic and explicit recovery');
 control.abort();app.environmentChanged({reason:'connection'});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,2,'an unchanged online status must not poll unknown outcomes');
 app.environmentChanged({reason:'lifecycle',returned:true});await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,3);
});
