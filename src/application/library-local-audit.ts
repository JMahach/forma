import {fromCallback} from 'xstate';
import type {LibraryLease,LibraryAuditCursor,LibraryAuditPage,LibraryAuditCheckpoint,LibraryCheckpointWrite} from '../domain/library-maintenance.ts';
export interface LibraryAuditScope {lease:LibraryLease;sessionId:string;visible:boolean;foreground:boolean}
export interface LibraryAuditPorts {
 scope():LibraryAuditScope|null;
 store:{auditPage(lease:LibraryLease,cursor:LibraryAuditCursor|null,limit:number,signal:AbortSignal,expectedAudit?:LibraryAuditCheckpoint):Promise<LibraryAuditPage|null>;
  readAuditCheckpoint(lease:LibraryLease):Promise<LibraryAuditCheckpoint|null>;
  saveAuditCheckpoint(lease:LibraryLease,expected:LibraryAuditCheckpoint|null,next:LibraryAuditCheckpoint,signal?:AbortSignal):Promise<LibraryCheckpointWrite>};
 clock?:{now():number;after(ms:number,callback:()=>void):()=>void};id?:()=>string;pageSize?:number;changed?():void;
}
export type LibraryAuditEvent={type:'AuditWake';at:number}|{type:'AuditChanged'};
const DAY=24*3600000,LEASE=30000;
const recent=(at:number,now:number)=>at>0 && now>=at && now-at<DAY;
function occupied(value:LibraryAuditCheckpoint|null,now:number){
 return !!value?.lease && value.lease.expiresAt>now && value.lease.expiresAt<=now+LEASE;
}
function resume(prior:LibraryAuditCheckpoint|null,owner:string,now:number):LibraryAuditCheckpoint {
 return {runId:prior?.cursor?prior.runId:owner,cursor:prior?.cursor??{phase:'charts'},completedAt:prior?.completedAt??0,lease:{owner,expiresAt:now+LEASE}};
}
function advance(prior:LibraryAuditCheckpoint,page:LibraryAuditPage,owner:string,now:number):LibraryAuditCheckpoint {
 return {runId:prior.runId,cursor:page.next,completedAt:page.next===null?now:prior.completedAt,
  ...(page.next===null?{}:{lease:{owner,expiresAt:now+LEASE}})};
}
const scopeKey=(scope:LibraryAuditScope)=>JSON.stringify([scope.lease.accountId,scope.lease.generation,scope.sessionId]);
const eligible=(scope:LibraryAuditScope|null):scope is LibraryAuditScope=>!!scope && scope.visible && !scope.foreground;
interface AuditRun {
 scope:LibraryAuditScope;key:string;control:AbortController;expected:LibraryAuditCheckpoint|null;
 value:LibraryAuditCheckpoint;persistent:boolean;occasion:number;
}
interface AuditMemory {key:string;completedAt:number;failures:number;blockedUntil:number;occasion:number}
/** One cursor, never a second library. Timers belong only to the finite current walk. */
class LocalAudit {
 private ports:LibraryAuditPorts;
 private clock:NonNullable<LibraryAuditPorts['clock']>;
 private owner:string;
 private active:AuditRun|null=null;
 private memory:AuditMemory|null=null;
 private pending:number|null=null;
 private paused:AuditRun|null=null;
 private stopped=false;
 constructor(ports:LibraryAuditPorts){
  this.ports=ports;this.clock=ports.clock??{now:Date.now,after(ms,run){const timer=setTimeout(run,ms);return()=>clearTimeout(timer);}};
  this.owner=ports.id?.()??crypto.randomUUID();
 }
 private current(run:AuditRun){
  const scope=this.ports.scope();
  return !this.stopped && !run.control.signal.aborted && eligible(scope) && scopeKey(scope)===run.key;
 }
 private checkScope(){
  const scope=this.ports.scope(),key=scope?scopeKey(scope):null;
  if(this.paused?.key!==key)this.paused=null;
  const run=this.active;if(!run || run.control.signal.aborted || this.current(run))return;
  this.paused=key===run.key?run:null;run.control.abort();
 }
 changed(){this.checkScope();this.continue();}
 private continue(){
  if(this.stopped || this.active || !this.paused)return;
  const scope=this.ports.scope();if(!eligible(scope))return;
  const paused=this.paused;this.paused=null;if(scopeKey(scope)===paused.key)this.wake(paused.occasion,paused);
 }
 stop(){this.stopped=true;this.pending=null;this.paused=null;this.active?.control.abort();}
 wake(at:number,paused?:AuditRun){
  if(this.stopped || !Number.isFinite(at))return;
  this.checkScope();
  if(this.active){this.pending=Math.max(this.pending??at,at);return;}
  const scope=this.ports.scope();if(!eligible(scope))return;
  const key=scopeKey(scope);if(!this.admitted(key,at))return;
  const run:AuditRun={scope:{...scope,lease:{...scope.lease}},key,control:new AbortController(),expected:null,
   value:{runId:this.owner,cursor:{phase:'charts'},completedAt:0},persistent:true,occasion:at};
  if(paused && !paused.persistent){run.value=paused.value;run.persistent=false;}
  this.paused=null;this.active=run;void this.run(run).catch(()=>{}).finally(()=>this.finished(run));
 }
 private admitted(key:string,at:number){
  const now=this.clock.now();
  if(this.memory?.key!==key)this.memory={key,completedAt:0,failures:0,blockedUntil:0,occasion:0};
  const memory=this.memory;if(recent(memory.completedAt,now))return false;
  if(memory.failures>=3){if(now<memory.blockedUntil || at<=memory.occasion)return false;memory.failures=0;}
  memory.occasion=Math.max(memory.occasion,at);return true;
 }
 private async finished(run:AuditRun){
  await this.release(run);
  if(this.active===run)this.active=null;
  const next=this.pending;this.pending=null;if(next!==null)this.wake(next);else this.continue();
 }
 private async release(run:AuditRun){
  if(!run.persistent || run.expected?.lease?.owner!==this.owner)return;
  const {lease:_,...next}=run.expected;
  try{await this.ports.store.saveAuditCheckpoint(run.scope.lease,run.expected,next);}catch{/* Lease expires without a cleanup loop. */}
 }
 private async claim(run:AuditRun){
  if(!run.persistent)return this.current(run);
  run.expected=await this.ports.store.readAuditCheckpoint(run.scope.lease);
  if(!this.current(run))return false;
  const prior=run.expected,now=this.clock.now();
  if(occupied(prior,now) || prior?.cursor===null && recent(prior.completedAt,now))return false;
  run.value=resume(prior,this.owner,now);
  return this.save(run);
 }
 private async save(run:AuditRun){
  if(!this.current(run))return false;
  let result:LibraryCheckpointWrite;
  try{result=await this.ports.store.saveAuditCheckpoint(run.scope.lease,run.expected,run.value,run.control.signal);}
  catch{result='unavailable';}
  if(result==='stored')run.expected=structuredClone(run.value);
  if(!this.current(run))return false;
  if(result==='unavailable'){run.persistent=false;return true;}
  return result==='stored';
 }
 private wait(run:AuditRun,ms:number):Promise<boolean>{
  return new Promise(resolve=>{
   if(!this.current(run)){resolve(false);return;}
   const signal=run.control.signal;
   const finish=()=>{cancel();signal.removeEventListener('abort',finish);resolve(this.current(run));};
   const cancel=this.clock.after(ms,finish);signal.addEventListener('abort',finish,{once:true});
  });
 }
 private async readPage(run:AuditRun){
  const proof=run.persistent?run.expected??undefined:undefined;
  try{return await this.ports.store.auditPage(run.scope.lease,run.value.cursor,this.ports.pageSize??16,run.control.signal,proof);}
  catch{return null;}
 }
 private async page(run:AuditRun):Promise<LibraryAuditPage|null>{
  const memory=this.memory!;
  while(this.current(run)){
   if(memory.blockedUntil>this.clock.now() && !await this.wait(run,memory.blockedUntil-this.clock.now()))return null;
   const page=await this.readPage(run);
   if(!this.current(run))return null;
   if(page){memory.failures=0;return page;}
   memory.failures++;
   memory.blockedUntil=this.clock.now()+(memory.failures>=3?60000:memory.failures===1?1000:5000);
   if(memory.failures>=3)return null;
  }
  return null;
 }
 private async accept(run:AuditRun,page:LibraryAuditPage){
  if(!this.current(run))return false;
  if(page.removed)this.ports.changed?.();
  const complete=page.next===null;
  run.value=advance(run.value,page,this.owner,this.clock.now());
  if((run.persistent || complete) && !await this.save(run))return false;
  if(complete){this.memory!.completedAt=run.value.completedAt;return false;}
  return this.wait(run,0);
 }
 private async run(run:AuditRun){
  if(!await this.claim(run))return;
  while(this.current(run)){
   const page=await this.page(run);if(!page || !await this.accept(run,page))return;
  }
 }
}
export function createLibraryLocalAudit(ports:LibraryAuditPorts){
 return fromCallback<LibraryAuditEvent>(({receive})=>{
  const owner=new LocalAudit(ports);
  receive(event=>event.type==='AuditWake'?owner.wake(event.at):owner.changed());
  return()=>owner.stop();
 });
}
