import {fromCallback} from 'xstate';
import type {LibraryCatalogEntry} from '../../shared/library-catalog-contract.ts';
import type {LibraryInventory,LibraryLease} from '../domain/library-maintenance.ts';
import {planLibraryFill,reserveFill,finishFill,pruneFillBudgets,type FillCandidate,type FillAuthority,type FillControlStore,type FillPermit,type FillOutcome,type FillReceipt,type FillPlacement} from '../domain/library-fill.ts';
export interface LibraryFillScope {lease:LibraryLease;sessionId:string;visible:boolean;foreground:boolean;online:boolean}
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
 clock?:{now():number;after(ms:number,run:()=>void):()=>void};id?:()=>string;
}
export type LibraryFillEvent={type:'FillWake';at:number;reason:'lifecycle'|'hourly'|'library'|'use'|'space'}|{type:'FillChanged'};
type Wake=Extract<LibraryFillEvent,{type:'FillWake'}>;
interface FillRun {scope:LibraryFillScope;key:string;wake:Wake;controller:AbortController;phase:'planning'|'waiting'|'receiving'|'placing'}
const scopeKey=(scope:LibraryFillScope)=>JSON.stringify([scope.lease.accountId,scope.lease.generation,scope.sessionId]);
const eligible=(scope:LibraryFillScope|null):scope is LibraryFillScope=>!!scope && scope.visible && !scope.foreground;
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
 private ports:LibraryFillPorts;private clock:NonNullable<LibraryFillPorts['clock']>;private owner:string;
 private active:FillRun|null=null;private pending:Wake|null=null;private paused:{key:string;wake:Wake}|null=null;private stopped=false;
 constructor(ports:LibraryFillPorts){
  this.ports=ports;this.clock=ports.clock??{now:Date.now,after(ms,run){const timer=setTimeout(run,ms);return()=>clearTimeout(timer);}};
  this.owner=ports.id?.()??crypto.randomUUID();
 }
 private current(run:FillRun){const scope=this.ports.scope();return !this.stopped && !run.controller.signal.aborted && eligible(scope) && scopeKey(scope)===run.key;}
 private online(run:FillRun){return this.current(run) && this.ports.scope()?.online===true;}
 private canContinue(run:FillRun){return run.phase==='placing'?this.current(run):this.online(run);}
 private checkScope(){
  const scope=this.ports.scope(),key=scope?scopeKey(scope):null;
  if(this.paused?.key!==key)this.paused=null;
  const run=this.active;if(!run || run.controller.signal.aborted)return;
  if(this.canContinue(run))return;
  this.paused=key===run.key?{key:run.key,wake:run.wake}:null;run.controller.abort();
 }
 changed(){this.checkScope();this.resume();}
 private resume(){
  if(this.stopped || this.active || !this.paused)return;
  const scope=this.ports.scope();if(!eligible(scope) || !scope.online)return;
  const paused=this.paused;this.paused=null;if(scopeKey(scope)===paused.key)this.wake(paused.wake);
 }
 stop(){this.stopped=true;this.pending=null;this.paused=null;this.active?.controller.abort();}
 wake(event:Wake){
  if(this.stopped || !Number.isFinite(event.at))return;
  this.checkScope();if(this.active){this.queue(event);return;}
  const scope=this.ports.scope();if(!eligible(scope) || !scope.online)return;
  const run:FillRun={scope:{...scope,lease:{...scope.lease}},key:scopeKey(scope),wake:event,controller:new AbortController(),phase:'planning'};
  this.paused=null;this.active=run;void this.run(run).catch(()=>{}).finally(()=>this.finished(run));
 }
 private finished(run:FillRun){
  if(this.active===run)this.active=null;const next=this.pending;this.pending=null;
  if(next)this.wake(next);else this.resume();
 }
 private queue(event:Wake){if(!this.pending || this.pending.at<=event.at)this.pending=event;}
 private wait(run:FillRun,ms:number):Promise<boolean>{
  run.phase='waiting';return new Promise(resolve=>{
   if(!this.online(run)){resolve(false);return;}
   const signal=run.controller.signal,finish=()=>{cancel();signal.removeEventListener('abort',finish);resolve(this.online(run));};
   const cancel=this.clock.after(Math.max(0,ms),finish);signal.addEventListener('abort',finish,{once:true});
  });
 }
 private reserve(run:FillRun,candidate:FillCandidate){
  const token=this.ports.id?.()??crypto.randomUUID();
  return this.ports.control.update(run.scope.lease,control=>reserveFill(control,{candidate,lease:run.scope.lease,sessionId:run.scope.sessionId,
   owner:this.owner,token,now:this.clock.now(),occasion:run.wake.at,spaceRelief:run.wake.reason==='space' || run.wake.reason==='use'}));
 }
 private async place(run:FillRun,candidate:FillCandidate,receipt:FillReceipt,authority:FillAuthority):Promise<FillOutcome>{
  if(receipt.kind==='not-ready')return {kind:'failed',retryAfterMs:receipt.retryAfterMs};
  run.phase='placing';if(!this.current(run) || authority.signal.aborted)return {kind:'cancelled'};
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
   run.phase='receiving';const receipt=await cancellable(this.ports.receive(candidate,signal),signal);
   return await this.place(run,candidate,receipt,{permit,signal});
  }catch(error){return run.controller.signal.aborted?{kind:'cancelled'}:failed(error);}
  finally{cancel();}
 }
 private async attempt(run:FillRun,candidate:FillCandidate,permit:FillPermit){
  const outcome=await this.perform(run,candidate,permit);
  const saved=await this.ports.control.update(run.scope.lease,control=>finishFill(control,permit,outcome,this.clock.now()));
  if(!saved || !this.current(run))return 'stop';
  if(outcome.kind==='success')return 'next';
  return outcome.kind==='failed'?'retry':'stop';
 }
 private async candidate(run:FillRun,candidate:FillCandidate):Promise<boolean>{
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
 const owner=new LibraryFill(ports);receive(event=>event.type==='FillWake'?owner.wake(event):owner.changed());return()=>owner.stop();
});}

