import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application/application.ts';
import type {BackgroundRequest} from '../src/application/background-work.ts';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('the application owns background lifetime and dispatches only a current admitted task',async()=>{
 let receive:(request:BackgroundRequest)=>void=()=>{},updates=0,stops=0,calls=0,answer:unknown;
 const target={key:'app',scope:{kind:'app' as const}},controller=new AbortController();
 const authority={permit:{key:'app',token:'t',owner:'A',startedAt:1,expiresAt:30001},signal:controller.signal,current:async()=>!controller.signal.aborted};
 const application=createApplication({runtimeId:'A',route:()=>assert.fail('no route'),background:{
  coordinator:{start(listener){receive=listener;},update(){updates++;},stop(){controller.abort();stops++;}},
  tasks:()=>[{target,async run(){calls++;return {outcome:{kind:'success'}};}}],
 }});
 application.start();receive({kind:'check',target,authority,finish(result){answer=result;}});await tick();
 assert.equal(calls,1);assert.deepEqual(answer,{outcome:{kind:'success'}});
 application.send({type:'BackgroundChanged'});assert.equal(updates,2);
 await application.stop();await application.stop();assert.equal(stops,1);
 receive({kind:'check',target,authority,finish(){}});await tick();assert.equal(calls,1);
});
test('unavailable coordination admits one initial library read per confirmed session and no retry on resume',async()=>{
 let receive:(request:BackgroundRequest)=>void=()=>{},sessionId='first',reads=0;
 const signal=new AbortController().signal;
 const application=createApplication({runtimeId:'A',route:()=>assert.fail('no route'),background:{
  coordinator:{start(listener){receive=listener;},update(){receive({kind:'unavailable',signal});},stop(){}},
  tasks:()=>[{target:{key:'library:1',scope:{kind:'library',accountId:'1'},sessionId},run:async()=>assert.fail('no shared permission'),
   initial:async()=>{reads++;throw new Error('unavailable');}}],
 }});
 application.start();await tick();assert.equal(reads,1);
 application.send({type:'BackgroundChanged'});receive({kind:'unavailable',signal});await tick();assert.equal(reads,1);
 sessionId='second';application.send({type:'BackgroundChanged'});await tick();assert.equal(reads,2);
 await application.stop();
});
