import test from 'node:test';
import assert from 'node:assert/strict';
import {createActor} from 'xstate';
import {createLibraryLocalAudit} from '../src/application/library-local-audit.ts';
import type {LibraryAuditCheckpoint,LibraryAuditCursor,LibraryAuditPage} from '../src/domain/library-maintenance.ts';
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(){
 let now=10000,serial=0,visible=true,foreground=false,sessionId='s',checkpoint:LibraryAuditCheckpoint|null=null;
 let unavailable=false,readCount=0,writes=0,changes=0;let broken:boolean|string=false;const lease={accountId:'1',generation:'g'};
 const timers=new Map<number,{at:number;run():void}>(),pages:{cursor:LibraryAuditCursor|null;signal:AbortSignal}[]=[];
 let held:((value:LibraryAuditPage|null)=>void)|null=null,hold=false;
 const store={
  async readAuditCheckpoint(){readCount++;return structuredClone(checkpoint);},
  async saveAuditCheckpoint(_lease:unknown,expected:LibraryAuditCheckpoint|null,next:LibraryAuditCheckpoint){writes++;if(unavailable)return 'unavailable' as const;if(JSON.stringify(checkpoint)!==JSON.stringify(expected))return 'superseded' as const;checkpoint=structuredClone(next);return 'stored' as const;},
  async auditPage(_lease:unknown,cursor:LibraryAuditCursor|null,_limit:number,signal:AbortSignal){pages.push({cursor,signal});if(hold)return new Promise<LibraryAuditPage|null>(resolve=>{held=resolve;});if(broken===true || broken===cursor?.after)return null;
   return {checked:2,removed:0,next:cursor?.after==='second'?null:{phase:'charts' as const,after:cursor?.after?'second':'first'}};
  },
 };
 const ports={store,scope:()=>({lease,sessionId,visible,foreground}),
  clock:{now:()=>now,after(ms:number,run:()=>void){const id=++serial;timers.set(id,{at:now+ms,run});return()=>{timers.delete(id);};}},id:()=>`run-${++serial}`,changed(){changes++;},pageSize:2};
 const make=()=>createActor(createLibraryLocalAudit(ports)).start(),actor=make();
 async function advance(ms:number){const end=now+ms;for(let i=0;i<100;i++){
  await flush();const first=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!first){now=end;await flush();return;}
  timers.delete(first[0]);now=first[1].at;first[1].run();
 }throw Error('unbounded audit loop');}
 return {actor,pages,advance,lease,peer:make,setCheckpoint(value:LibraryAuditCheckpoint){checkpoint=value;},wake(){actor.send({type:'AuditWake',at:now});},change(value:{visible?:boolean;foreground?:boolean;sessionId?:string}){visible=value.visible??visible;foreground=value.foreground??foreground;sessionId=value.sessionId??sessionId;actor.send({type:'AuditChanged'});},
  hold(){hold=true;},release(page:LibraryAuditPage|null){hold=false;held?.(page);},failWrites(){unavailable=true;},failPages(after?:string){broken=after??true;},
  get checkpoint(){return checkpoint;},get writes(){return writes;},get readCount(){return readCount;},get changes(){return changes;},get timers(){return timers.size;}};
}
test('the local audit waits for a real occasion, yields bounded pages, and has no daily timer',async()=>{
 const f=fixture();await f.advance(1000);assert.equal(f.pages.length,0);f.wake();await f.advance(0);
 assert.equal(f.pages.length,3);assert.equal(f.checkpoint?.cursor,null);assert.equal(f.checkpoint?.completedAt,11000);assert.equal(f.timers,0);
 await f.advance(3600000);f.wake();await f.advance(0);assert.equal(f.pages.length,3);
 await f.advance(24*3600000);f.wake();await f.advance(0);assert.equal(f.pages.length,6);f.actor.stop();
});
test('foreground and hidden departures abort a page; late completion cannot advance the audit',async()=>{
 const f=fixture();f.hold();f.wake();await f.advance(0);assert.equal(f.pages.length,1);
 f.change({foreground:true});assert.equal(f.pages[0].signal.aborted,true);f.release({checked:2,removed:1,next:null});await f.advance(0);
 assert.notEqual(f.checkpoint?.completedAt,10000);assert.equal(f.changes,0);assert.equal(f.timers,0);
 f.change({foreground:false,visible:false});f.wake();await f.advance(1000);assert.equal(f.pages.length,1);
 f.change({visible:true});f.wake();await f.advance(0);assert.equal(f.pages.length,4);f.actor.stop();
});
test('a failed progress write keeps bounded RAM continuation without retrying the mark on every page',async()=>{
 const f=fixture();f.failWrites();f.wake();await f.advance(0);assert.equal(f.pages.length,3);assert.equal(f.writes,2);assert.equal(f.timers,0);
 await f.advance(3600000);f.wake();await f.advance(0);assert.equal(f.pages.length,3);assert.equal(f.writes,2);f.actor.stop();
});
test('unavailable local storage has finite retries and requires a new later occasion',async()=>{
 const f=fixture();f.failPages();f.wake();await f.advance(120000);assert.equal(f.pages.length,3);assert.equal(f.timers,0);
 f.actor.send({type:'AuditWake',at:10000});await f.advance(1000);assert.equal(f.pages.length,3);
 f.wake();await f.advance(10000);assert.equal(f.pages.length,6);f.actor.stop();
});

test('two tabs share one active audit lease and a later peer does not repeat a completed walk',async()=>{
 const f=fixture(),peer=f.peer();f.hold();f.wake();await f.advance(0);
 peer.send({type:'AuditWake',at:10000});await f.advance(0);assert.equal(f.pages.length,1);
 f.release({checked:2,removed:0,next:{phase:'charts',after:'first'}});await f.advance(0);assert.equal(f.pages.length,3);
 peer.send({type:'AuditWake',at:10001});await f.advance(0);assert.equal(f.pages.length,3);
 f.actor.stop();peer.stop();
});
test('account-session replacement and disposal reject late pages and leave no continuation timer',async()=>{
 const f=fixture();f.hold();f.wake();await f.advance(0);
 f.change({sessionId:'replacement'});assert.equal(f.pages[0].signal.aborted,true);
 f.release({checked:2,removed:1,next:null});await f.advance(0);assert.equal(f.changes,0);assert.notEqual(f.checkpoint?.completedAt,10000);
 f.hold();f.wake();await f.advance(0);assert.equal(f.pages.length,2);f.actor.stop();
 assert.equal(f.pages[1].signal.aborted,true);f.release({checked:2,removed:1,next:null});await f.advance(0);
 assert.equal(f.changes,0);assert.equal(f.timers,0);
});
test('an expired peer cursor resumes and a clock moving backwards cannot suppress audit forever',async()=>{
 const f=fixture();f.setCheckpoint({runId:'old',cursor:{phase:'charts',after:'first'},completedAt:0,lease:{owner:'lost',expiresAt:9999}});
 f.wake();await f.advance(0);assert.equal(f.pages.length,2);assert.deepEqual(f.pages[0].cursor,{phase:'charts',after:'first'});f.actor.stop();
 const other=fixture();other.setCheckpoint({runId:'future',cursor:null,completedAt:999999999});other.wake();await other.advance(0);
 assert.equal(other.pages.length,3);assert.equal(other.checkpoint?.completedAt,10000);other.actor.stop();
});
test('daily and retry deadlines admit exactly at the boundary, and expiry at now releases a peer',async()=>{
 const f=fixture();f.setCheckpoint({runId:'old',cursor:null,completedAt:1});f.wake();await f.advance(0);assert.equal(f.pages.length,0);
 await f.advance(24*3600000-9999);f.wake();await f.advance(0);assert.equal(f.pages.length,3);f.actor.stop();
 const retry=fixture();retry.failPages();retry.wake();await retry.advance(66000);assert.equal(retry.pages.length,3);
 retry.wake();await retry.advance(0);assert.equal(retry.pages.length,4);retry.actor.stop();
 const peer=fixture();peer.setCheckpoint({runId:'old',cursor:{phase:'charts'},completedAt:0,lease:{owner:'gone',expiresAt:10000}});
 peer.wake();await peer.advance(0);assert.equal(peer.pages.length,3);peer.actor.stop();
});
test('a recent completed audit is retained even when its wall clock is far from zero',async()=>{
 const f=fixture();await f.advance(12*3600000);f.wake();await f.advance(0);assert.equal(f.pages.length,3);
 await f.advance(1000);f.wake();await f.advance(0);assert.equal(f.pages.length,3);f.actor.stop();
});
test('committed repairs notify once; a superseded checkpoint cannot overwrite another walker',async()=>{
 const f=fixture();f.hold();f.wake();await f.advance(0);f.release({checked:1,removed:1,next:null});await f.advance(0);assert.equal(f.changes,1);f.actor.stop();
 const peer=fixture();peer.hold();peer.wake();await peer.advance(0);
 const newer={runId:'other',cursor:{phase:'packages' as const},completedAt:0,lease:{owner:'other',expiresAt:40000}};
 peer.setCheckpoint(newer);peer.release({checked:1,removed:0,next:{phase:'charts',after:'first'}});await peer.advance(0);
 assert.deepEqual(peer.checkpoint,newer);assert.equal(peer.pages.length,1);assert.equal(peer.timers,0);peer.actor.stop();
});

for(const pause of ['foreground','hidden'] as const)test(`audit resumes an interrupted ${pause} pass with its original retry budget`,async()=>{
 const f=fixture();f.failPages();f.wake();await f.advance(0);assert.equal(f.pages.length,1);
 f.change(pause==='foreground'?{foreground:true}:{visible:false});await f.advance(120000);assert.equal(f.pages.length,1);
 f.change({foreground:false,visible:true});await f.advance(10000);assert.equal(f.pages.length,3);
 const reads=f.readCount;f.change({foreground:true});await f.advance(120000);f.change({foreground:false});await f.advance(120000);
 assert.equal(f.pages.length,3);assert.equal(f.readCount,reads);assert.equal(f.timers,0);f.actor.stop();
});
test('a paused audit waits for its cancelled page to settle then resumes the saved cursor exactly once',async()=>{
 const f=fixture();f.setCheckpoint({runId:'prior',cursor:{phase:'charts',after:'first'},completedAt:0});
 f.hold();f.wake();await f.advance(0);f.change({foreground:true});f.change({foreground:false});await f.advance(0);
 assert.equal(f.pages.length,1);assert.equal(f.pages[0].signal.aborted,true);
 f.release({checked:2,removed:1,next:null});await f.advance(0);
 assert.equal(f.pages.length,3);assert.deepEqual(f.pages[1].cursor,{phase:'charts',after:'first'});
 assert.equal(f.changes,0);assert.equal(f.checkpoint?.cursor,null);assert.equal(f.timers,0);
 const reads=f.readCount;f.change({foreground:true});f.change({foreground:false});await f.advance(0);
 assert.equal(f.pages.length,3);assert.equal(f.readCount,reads);f.actor.stop();
});
test('a paused audit never resumes after replacement of session, lease, or owner disposal',async()=>{
 for(const replacement of ['session','lease','stop'] as const){
  const f=fixture();f.failPages();f.wake();await f.advance(0);f.change({foreground:true});await f.advance(0);
  if(replacement==='lease')f.lease.generation='new';
  if(replacement==='stop')f.actor.stop();
  f.change({foreground:false,...(replacement==='session'?{sessionId:'new'}:{})});await f.advance(120000);
  assert.equal(f.pages.length,1);assert.equal(f.timers,0);f.actor.stop();
 }
});

test('a short foreground pause preserves the remaining audit retry delay',async()=>{
 const f=fixture();f.failPages();f.wake();await f.advance(0);await f.advance(400);
 f.change({foreground:true});f.change({foreground:false});await f.advance(599);assert.equal(f.pages.length,1);
 await f.advance(1);assert.equal(f.pages.length,2);await f.advance(4999);assert.equal(f.pages.length,2);
 await f.advance(1);assert.equal(f.pages.length,3);f.actor.stop();
});

test('a paused audit retains its RAM cursor when progress cannot be saved',async()=>{
 const f=fixture();f.failWrites();f.hold();f.wake();await f.advance(0);
 f.release({checked:2,removed:0,next:{phase:'charts',after:'first'}});await flush();
 f.change({foreground:true});await f.advance(0);f.change({foreground:false});await f.advance(0);
 assert.equal(f.pages.length,3);assert.deepEqual(f.pages[1].cursor,{phase:'charts',after:'first'});f.actor.stop();
});

test('invalid audit occasions do not read the checkpoint',async()=>{
 const f=fixture();f.actor.send({type:'AuditWake',at:NaN});await f.advance(0);
 assert.equal(f.readCount,0);assert.equal(f.pages.length,0);f.actor.stop();
});
test('an exhausted resumed audit requires the whole cooldown and a genuinely later occasion',async()=>{
 const f=fixture();f.failPages();f.wake();await f.advance(0);f.change({foreground:true});f.change({foreground:false});
 await f.advance(65999);assert.equal(f.pages.length,3);f.wake();await f.advance(0);assert.equal(f.pages.length,3);
 await f.advance(1);f.actor.send({type:'AuditWake',at:10000});await f.advance(0);assert.equal(f.pages.length,3);
 f.wake();await f.advance(0);assert.equal(f.pages.length,4);f.actor.stop();
});

test('an unchanged audit scope notice cannot cancel a live page',async()=>{
 const f=fixture();f.hold();f.wake();await f.advance(0);f.change({foreground:false});
 assert.equal(f.pages[0].signal.aborted,false);f.release({checked:2,removed:1,next:null});await f.advance(0);
 assert.equal(f.pages.length,1);assert.equal(f.changes,1);assert.equal(f.checkpoint?.cursor,null);f.actor.stop();
});
test('a successful resumed audit page restores the retry allowance for the next page',async()=>{
 const f=fixture();f.failPages();f.wake();await f.advance(0);f.change({foreground:true});f.change({foreground:false});
 f.failPages('first');await f.advance(10000);assert.equal(f.pages.length,5);assert.equal(f.timers,0);f.actor.stop();
});
