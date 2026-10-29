import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application/application.ts';

for(const held of ['ready','restore','resume'] as const)test(`stopped startup cannot persist after late ${held}`,async()=>{
  let release!:()=>void,persisted=false,reports=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const app=createApplication({runtimeId:'retired',route:()=>assert.fail('no address was requested'),startup:{
    ready:async()=>{if(held==='ready')await gate;},route:async()=>{},current:()=>true,
    restore:async()=>{if(held==='restore')await gate;return true;},
    resume:async()=>{if(held==='resume')await gate;return true;},
    commit(){persisted=true;},report(){reports++;},changed(){},
  }});
  app.start();const restoration=app.whenRestored();await new Promise(resolve=>setImmediate(resolve));
  await app.stop();await restoration;release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(persisted,false,'the old runtime cannot overwrite the tab checkpoint');
  assert.equal(reports,0);assert.equal(app.startup.restored,false);
});
