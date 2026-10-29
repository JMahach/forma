import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application/application.ts';

async function fixture() {
  let selected='current-transit',ready=true,durable:boolean|Promise<boolean>=true,stored=true,writes=0,reads=0;
  const app=createApplication({runtimeId:'update',route:()=>assert.fail('no route expected'),startup:{
    ready:async()=>{},route:async()=>{},current:()=>true,restore:async()=>true,resume(){},commit(){},report(){},changed(){},
  },update:{restored:()=>true,ready:()=>ready,selection:()=>selected,
    canRestore(){reads++;return durable;},checkpoint(){writes++;return stored;}}});
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
