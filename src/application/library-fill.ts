import {fromCallback} from 'xstate';
import {waitForIdle} from './update.ts';
import type {LibraryCatalogEntry} from '../../shared/library-catalog-contract.ts';
import type {LibraryInventory,LibraryLease} from '../domain/library-maintenance.ts';
import {planLibraryFill,reserveFill,finishFill,pruneFillBudgets,type FillCandidate,type FillAuthority,type FillControlStore,type FillPermit,type FillOutcome,type FillReceipt,type FillPlacement} from '../domain/library-fill.ts';
export interface LibraryFillScope {lease:LibraryLease;sessionId:string;catalogMarker:string;visible:boolean;foreground:boolean;online:boolean}
export type {FillReceipt,FillPlacement} from '../domain/library-fill.ts';
export interface LibraryFillPorts {
 scope():LibraryFillScope|null;/** Return only the complete accepted catalogue; null means it is not available yet. */
 entries():readonly LibraryCatalogEntry[]|null;
 control:FillControlStore;inventory(lease:LibraryLease):Promise<LibraryInventory|null>;
 present(candidate:FillCandidate,lease:LibraryLease):Promise<boolean>;
 /** The existing client validates the received complete packet before returning ready. No placement here. */
 receive(candidate:FillCandidate,signal:AbortSignal):Promise<FillReceipt>;
 place(candidate:FillCandidate,payload:unknown,authority:FillAuthority):Promise<FillPlacement>;
 accepted?(candidate:FillCandidate,payload:unknown,authority:FillAuthority):void;
 clock:{now():number;after(ms:number,run:()=>void):()=>void};id:()=>string;
}
export type LibraryFillEvent={type:'FillWake';at:number;reason:'lifecycle'|'hourly'|'library'|'use'|'space'}|{type:'FillChanged'}|{type:'FillIdle';complete():void;signal?:AbortSignal};
type Wake=Extract<LibraryFillEvent,{type:'FillWake'}>;
interface FillRun {scope:LibraryFillScope;key:string;wake:Wake;controller:AbortController}
type WorkMode='planning'|'waiting'|'receiving'|'placing';
interface Continuation {key:string;wake:Wake}
type FillState={mode:'idle'|'stopped'}|{mode:'paused';resume:Continuation}
 | {mode:WorkMode;run:FillRun;next:Continuation|null}
 | {mode:'cleanup';run:FillRun;next:Continuation|null;origin:'network'|'local'}
 | {mode:'cancelling';run:FillRun;next:Continuation|null;resume:Continuation|null}
 | {mode:'stopping';run:FillRun};
function nextWake(previous:Continuation|null,incoming:Continuation,scope:LibraryFillScope):Continuation {
 if(!previous || !continuationCurrent(scope,previous))return incoming;
 if(previous.wake.reason==='space' && incoming.wake.reason!=='space')return previous;
 if(incoming.wake.reason==='space' && previous.wake.reason!=='space')return incoming;
 return previous.wake.at>incoming.wake.at?previous:incoming;
}
// A payload commit remains evidence across catalogue updates within its login and library owner.
const scopeKey=(scope:LibraryFillScope,wake?:Wake)=>JSON.stringify([scope.lease.accountId,scope.lease.generation,scope.sessionId,...(wake?.reason==='space'?[]:[scope.catalogMarker])]);
const continuationCurrent=(scope:LibraryFillScope|null,next:Continuation|null)=>!!scope && !!next && next.key===scopeKey(scope,next.wake);
const eligible=(scope:LibraryFillScope|null):scope is LibraryFillScope=>!!scope && scope.visible && !scope.foreground;
const canReceive=(scope:LibraryFillScope|null):scope is LibraryFillScope=>eligible(scope) && scope.online;
function aborted(){return new DOMException('Fill cancelled','AbortError');}
function cancellable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{
  if(signal.aborted){void promise.catch(()=>{});reject(aborted());return;}
  const abort=()=>reject(aborted()),clean=()=>signal.removeEventListener('abort',abort);
  signal.addEventListener('abort',abort,{once:true});promise.then(value=>{clean();resolve(value);},error=>{clean();reject(error);});
 });
}
function placementOutcome(placed:FillPlacement):FillOutcome {
 if(placed==='stored' || placed==='no-op')return {kind:'success'};
 if(placed==='quota')return {kind:'quota'};
 return placed==='stale'?{kind:'cancelled'}:{kind:'storage-unavailable'};
}
function failed(error:unknown):FillOutcome {
 const value=error as {status?:number;retryAfterMs?:number}|null;
 return value?.status===401?{kind:'unauthorized'}:{kind:'failed',retryAfterMs:value?.retryAfterMs};
}
/** One account permit and one transient packet. Catalog/number owners remain behind ports. */
class LibraryFill {
 private ports:LibraryFillPorts;private clock:LibraryFillPorts['clock'];private owner:string;
 private state:FillState={mode:'idle'};private idle=new Set<()=>void>();
 whenIdle(complete:()=>void,signal?:AbortSignal){waitForIdle('run' in this.state,this.idle,complete,signal);}
 private settled(){if(!('run' in this.state)){for(const complete of this.idle)complete();this.idle.clear();}}
 constructor(ports:LibraryFillPorts){
  this.ports=ports;this.clock=ports.clock;
  this.owner=ports.id();
 }
 private current(run:FillRun){
  const state=this.state,scope=this.ports.scope();
  return 'run' in state && state.run===run && state.mode!=='cancelling' && state.mode!=='stopping'
   && !run.controller.signal.aborted && eligible(scope) && scopeKey(scope)===run.key;
 }
 private online(run:FillRun){return this.current(run) && this.ports.scope()?.online===true;}
 private enter(run:FillRun,mode:WorkMode|'cleanup'){
  const state=this.state;
  if(!('next' in state) || state.run!==run || state.mode==='cancelling')return;
  const origin=state.mode==='cleanup'?state.origin:state.mode==='placing'?'local':'network';
  this.state=mode==='cleanup'?{mode,run,next:state.next,origin}:{mode,run,next:state.next};
 }
 private checkScope(){
  const state=this.state,scope=this.ports.scope();
  if(state.mode==='paused'){if(!continuationCurrent(scope,state.resume))this.state={mode:'idle'};return;}
  if(!('run' in state) || state.mode==='stopping')return;
  if(state.mode==='cancelling'){if(!continuationCurrent(scope,state.resume))this.state={...state,resume:null};return;}
  const {run,next}=state;
  const local=state.mode==='placing' || state.mode==='cleanup' && state.origin==='local';
  if(local?this.current(run):this.online(run))return;
  const resume={key:scopeKey(run.scope,run.wake),wake:run.wake};
  this.state={mode:'cancelling',run,next,resume:continuationCurrent(scope,resume)?resume:null};
  run.controller.abort();
 }
 changed(){this.checkScope();this.resume();}
 private resume(){
  const state=this.state;if(state.mode!=='paused')return;
  const scope=this.ports.scope();if(!canReceive(scope))return;
  this.state={mode:'idle'};if(continuationCurrent(scope,state.resume))this.wake(state.resume.wake);
 }
 stop(){
  const state=this.state;
  if('run' in state){this.state={mode:'stopping',run:state.run};state.run.controller.abort();}
  else this.state={mode:'stopped'};
 }
 wake(event:Wake){
  if(this.state.mode==='stopped' || this.state.mode==='stopping' || !Number.isFinite(event.at))return;
  this.checkScope();const state=this.state;
  const scope=this.ports.scope();if(!scope)return;
  const incoming={key:scopeKey(scope,event),wake:event};
  if('next' in state){this.state={...state,next:nextWake(state.next,incoming,scope)};return;}
  const pending=state.mode==='paused'?nextWake(state.resume,incoming,scope):incoming;
  if(!canReceive(scope) || pending.wake.reason==='space' && !this.ports.entries()){
   if(pending.wake.reason==='space')this.state={mode:'paused',resume:pending};return;
  }
  const run:FillRun={scope:{...scope,lease:{...scope.lease}},key:scopeKey(scope),wake:pending.wake,controller:new AbortController()};
  this.state={mode:'planning',run,next:null};void this.run(run).catch(()=>{}).finally(()=>this.finished(run));
 }
 private finished(run:FillRun){
  const state=this.state;if(!('run' in state) || state.run!==run)return;
  if(state.mode==='stopping')this.state={mode:'stopped'};
  else {
   this.state=state.mode==='cancelling' && state.resume?{mode:'paused',resume:state.resume}:{mode:'idle'};
   const scope=this.ports.scope();
   if(state.next && continuationCurrent(scope,state.next))this.wake(state.next.wake);else this.resume();
  }
  this.settled();
 }
 private wait(run:FillRun,ms:number):Promise<boolean>{
  this.enter(run,'waiting');return new Promise(resolve=>{
   if(!this.online(run)){resolve(false);return;}
   const signal=run.controller.signal,finish=()=>{cancel();signal.removeEventListener('abort',finish);resolve(this.online(run));};
   const cancel=this.clock.after(Math.max(0,ms),finish);signal.addEventListener('abort',finish,{once:true});
  });
 }
 private reserve(run:FillRun,candidate:FillCandidate){
  const token=this.ports.id();
  return this.ports.control.update(run.scope.lease,control=>reserveFill(control,{candidate,lease:run.scope.lease,sessionId:run.scope.sessionId,
   owner:this.owner,token,now:this.clock.now(),occasion:run.wake.at,spaceRelief:run.wake.reason==='space'}));
 }
 private async place(run:FillRun,candidate:FillCandidate,receipt:FillReceipt,authority:FillAuthority):Promise<FillOutcome>{
  if(receipt.kind==='not-ready')return {kind:'failed',retryAfterMs:receipt.retryAfterMs};
  this.enter(run,'placing');if(!this.current(run) || authority.signal.aborted)return {kind:'cancelled'};
  const placed=await this.ports.place(candidate,receipt.payload,authority);
  if(!this.current(run) || authority.signal.aborted)return {kind:'cancelled'};
  if(placed==='stored')this.ports.accepted?.(candidate,receipt.payload,authority);
  return placementOutcome(placed);
 }
 private async perform(run:FillRun,candidate:FillCandidate,permit:FillPermit):Promise<FillOutcome>{
  const timeout=new AbortController(),signal=AbortSignal.any([run.controller.signal,timeout.signal]);
  const cancel=this.clock.after(Math.max(0,permit.expiresAt-this.clock.now()),()=>timeout.abort());
  try{
   if(!this.online(run) || signal.aborted)return {kind:'cancelled'};
   this.enter(run,'receiving');const receipt=await cancellable(this.ports.receive(candidate,signal),signal);
   return await this.place(run,candidate,receipt,{permit,signal});
  }catch(error){return run.controller.signal.aborted?{kind:'cancelled'}:failed(error);}
  finally{cancel();}
 }
 private async attempt(run:FillRun,candidate:FillCandidate,permit:FillPermit){
  const outcome=await this.perform(run,candidate,permit);
  this.enter(run,'cleanup');
  const saved=await this.ports.control.update(run.scope.lease,control=>finishFill(control,permit,outcome,this.clock.now()));
  if(!saved || !this.current(run))return 'stop';
  if(outcome.kind==='success')return 'next';
  return outcome.kind==='failed'?'retry':'stop';
 }
 private async candidate(run:FillRun,candidate:FillCandidate):Promise<boolean>{
  this.enter(run,'planning');
  while(this.online(run)){
   if(await this.ports.present(candidate,run.scope.lease))return true;
   if(!this.online(run))return false;
   const reservation=await this.reserve(run,candidate);
   if(!reservation || reservation.kind==='blocked')return false;
   if(reservation.kind==='wait'){if(!await this.wait(run,reservation.at-this.clock.now()))return false;continue;}
   const step=await this.attempt(run,candidate,reservation.permit);if(step!=='retry')return step==='next';
  }
  return false;
 }
 private async plan(run:FillRun){
  const entries=this.ports.entries();if(!entries)return;
  const inventory=await this.ports.inventory(run.scope.lease);if(!inventory || !this.online(run))return;
  const plan=planLibraryFill(entries,inventory,{reconsiderEvicted:run.wake.reason==='space'});
  if(!await this.ports.control.update(run.scope.lease,control=>pruneFillBudgets(control,entries)) || !this.online(run))return;
  return plan;
 }
 private async run(run:FillRun){
  const plan=await this.plan(run);if(!plan)return;
  for(const tier of plan){
   for(const candidate of tier.candidates){if(!await this.candidate(run,candidate) || !await this.wait(run,0))return;}
   if(tier.blocked)return;
  }
 }
}
export function createLibraryFill(ports:LibraryFillPorts){return fromCallback<LibraryFillEvent>(({receive})=>{
 const owner=new LibraryFill(ports);receive(event=>event.type==='FillWake'?owner.wake(event):event.type==='FillIdle'?owner.whenIdle(event.complete,event.signal):owner.changed());return()=>owner.stop();
});}

