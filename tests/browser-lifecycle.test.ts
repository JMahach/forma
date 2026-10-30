import test from 'node:test';
import assert from 'node:assert/strict';
import {createPageLifecycle} from '../src/platform/browser/lifecycle.ts';
test('pagehide and freeze revoke activity until an online visible return, with detachable listeners',()=>{
 const events=new EventTarget(),visibility=Object.assign(new EventTarget(),{hidden:false});let online=true,connection=()=>{},stopped=0;
 const page=createPageLifecycle({events,visibility,online:()=>online,subscribeConnection(listener){connection=listener;return()=>{stopped++;};}});
 const changes:boolean[]=[];const stop=page.subscribe(returned=>changes.push(returned));
 assert.equal(page.active,true);events.dispatchEvent(new Event('pagehide'));assert.equal(page.active,false);
 online=false;events.dispatchEvent(new Event('pageshow'));assert.equal(page.active,false);
 online=true;connection();assert.equal(page.active,true);assert.equal(changes.at(-1),true);
 visibility.dispatchEvent(new Event('freeze'));assert.equal(page.active,false);
 visibility.dispatchEvent(new Event('resume'));assert.equal(page.active,true);
 visibility.hidden=true;visibility.dispatchEvent(new Event('visibilitychange'));assert.equal(page.active,false);
 visibility.hidden=false;visibility.dispatchEvent(new Event('visibilitychange'));assert.equal(changes.at(-1),true);
 stop();const count=changes.length;events.dispatchEvent(new Event('pagehide'));assert.equal(changes.length,count);assert.equal(stopped,1);
});
