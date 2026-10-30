import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application/application.ts';

for(const held of ['read','restore','resume'] as const)test(`stopped startup cannot persist after late ${held}`,async()=>{
  let release!:()=>void,persisted=false,reports=0;const calls:string[]=[];
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const app=createApplication({runtimeId:'retired',startup:{
    library:{get:()=>true,async open(){calls.push('read');if(held==='read')await gate;}},
    view:{interrupted:false,savedSelection:'saved',
      restore:async()=>{calls.push('restore');if(held==='restore')await gate;return true;},
      resume:async()=>{calls.push('resume');if(held==='resume')await gate;return true;},flush(){persisted=true;}},
    form:{pending:null,opened:false,clearPending(){},restore(){}},report(){reports++;},changed(){},
  }});
  app.start();const restoration=app.whenRestored();await new Promise(resolve=>setImmediate(resolve));
  await app.stop();await restoration;release();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,['read','restore','resume'].slice(0,['read','restore','resume'].indexOf(held)+1),'stopping prevents later owners from starting');
  assert.equal(persisted,false,'the old runtime cannot overwrite the tab checkpoint');
  assert.equal(reports,0);assert.equal(app.startup.restored,false);
});
