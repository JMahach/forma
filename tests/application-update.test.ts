import {createUpdatePreparation} from '../src/application/update.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application/application.ts';

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
