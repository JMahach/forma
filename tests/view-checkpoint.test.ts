import test from 'node:test';
import assert from 'node:assert/strict';
import {createViewStore,VIEW_STORAGE_KEY} from '../src/data/view-store.ts';
import {createViewCheckpoint} from '../src/state/view-checkpoint.ts';

function fixture(){
 const records=new Map<string,string>(),events=new EventTarget(),visibility=Object.assign(new EventTarget(),{hidden:false});
 let writes=0,fail=false;
 const storage={getItem:(key:string)=>records.get(key)??null,setItem(key:string,value:string){if(fail)throw new Error('quota');writes++;records.set(key,value);},removeItem(key:string){if(fail)throw new Error('quota');records.delete(key);}};
 const store=createViewStore({getStorage:()=>storage});
 const pending=new Map<number,()=>void>();let serial=0;
 const writer=createViewCheckpoint({store,eventTarget:events,interactionTarget:visibility,
  schedule:((run:()=>void)=>{const id=++serial;pending.set(id,run);return id;}) as unknown as typeof setTimeout,
  cancel:((id:number)=>{pending.delete(id);}) as unknown as typeof clearTimeout});
 return {store,writer,records,events,visibility,get writes(){return writes;},get pending(){return pending.size;},fail(value:boolean){fail=value;},tick(){const work=[...pending.values()];pending.clear();for(const run of work)run();}};
}

test('one snapshot writer coalesces camera input and hands off without allowing the old source to write',async()=>{
 const h=fixture();let x=0;
 const early=h.writer.claim(()=>({version:1,camera:{x,y:0,k:1},selectedId:'current-transit'}));
 for(x=1;x<=100;x++)early.schedule();x=100;
 assert.equal(h.pending,1);assert.equal(h.writer.pending,true);assert.equal(h.writes,0);h.tick();assert.equal(h.writer.pending,false);
 assert.equal(h.writes,1);assert.equal(h.store.read()?.camera?.x,100);
 x=101;early.schedule();
 const current=h.writer.claim(()=>({version:1,camera:{x:200,y:0,k:1},selectedId:'current-transit'}));
 assert.equal(h.store.read()?.camera?.x,101);assert.equal(h.pending,0);
 early.schedule();assert.equal(early.flush().kind,'failed');assert.equal(h.pending,0);
 current.schedule();h.events.dispatchEvent(new Event('pagehide'));
 assert.equal(h.pending,0);assert.equal(h.store.read()?.camera?.x,200);assert.equal(h.writes,3);
 assert.equal((await current.checkpoint('update')).kind,'stored');assert.equal(h.writes,3);
 h.visibility.hidden=true;current.schedule();h.visibility.dispatchEvent(new Event('visibilitychange'));assert.equal(h.writer.pending,false);
 h.writer.destroy();h.events.dispatchEvent(new Event('pagehide'));assert.equal(h.writes,3);
 assert.throws(()=>h.writer.claim(()=>({version:1})),/stopped/);assert.equal(current.flush().kind,'failed');
});

test('checkpoint distinguishes stored, RAM fallback and failed production without losing current input',async()=>{
 const h=fixture();let email='first@example.invalid';
 const source=h.writer.claim(()=>({version:1,account:{email,attemptEmail:'',attemptId:null,step:'email',verificationPending:false}}));
 assert.equal((await source.checkpoint('write')).kind,'stored');
 h.fail(true);email='current@example.invalid';
 const result=source.flush();assert.equal(result.kind,'memory-only');assert.notEqual(result.kind,'stored');
 assert.equal(h.store.read()?.account?.email,email);assert.equal(JSON.parse(h.records.get(VIEW_STORAGE_KEY)!).account.email,'first@example.invalid');
 h.fail(false);assert.equal((await source.checkpoint('handoff')).kind,'stored');assert.equal(h.writes,2);
 const cause=new Error('source unavailable'),broken=h.writer.claim(()=>{throw cause;});
 assert.deepEqual(broken.flush(),{kind:'failed',cause});assert.equal(h.store.read()?.account?.email,email);
 assert.equal(h.writer.claim(()=>null).flush().kind,'failed');
 assert.equal(h.writer.claim(()=>({version:2} as never)).flush().kind,'failed');
 h.writer.destroy();
});


test('logout replaces a private snapshot once while retaining an independent tab source',()=>{
 const h=fixture();
 const source=h.writer.claim(()=>({version:1,selectedId:'private-card',account:{email:'private@example.invalid',attemptEmail:'',attemptId:null,step:'email',verificationPending:false}}));
 source.flush();source.schedule();
 const before=h.writes;
 assert.equal(h.writer.clear({version:1,selectedId:'current-transit'}).kind,'stored');
 assert.equal(h.writes-before,1);assert.equal(h.pending,0);assert.equal(h.store.read()?.account,undefined);
 assert.equal(h.writer.clear({version:2} as never).kind,'failed');
 h.fail(true);assert.equal(h.writer.clear().kind,'memory-only');assert.equal(h.store.read(),null);
 h.fail(false);assert.equal(h.writer.clear().kind,'stored');assert.equal(h.records.has(VIEW_STORAGE_KEY),false);
 h.writer.destroy();assert.equal(h.writer.clear().kind,'failed');
 const writer=createViewCheckpoint({store:{write:()=>true}});
 assert.equal(writer.clear().kind,'failed','missing deletion capability cannot claim a stored clear');
 assert.equal(writer.clear({version:1}).kind,'stored');
 writer.claim(()=>({version:1}),()=>{throw new Error('observer');});assert.equal(writer.flushForPageHide().kind,'stored');
 writer.destroy();
});
