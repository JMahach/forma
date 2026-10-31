import {fromCallback} from 'xstate';
import {waitForIdle} from './update.ts';
import type {AccountLibrary} from '../state/account-library.ts';
import type {LibraryFillScope,LibraryFillEvent} from './library-fill.ts';
import {readLibraryLocalNotice} from '../domain/library-maintenance.ts';
import type {LibraryLocalChange,LibraryLocalNotice} from '../domain/library-maintenance.ts';
import type {CheckAuthority,CheckOutcome,CheckTarget} from '../domain/background-check.ts';
export interface CheckResult {outcome:CheckOutcome;data?:unknown}
export interface BackgroundTask {
 target:CheckTarget;
 run(authority:CheckAuthority):Promise<CheckResult>;
 receive?(data:unknown):void;
 initial?(signal:AbortSignal):Promise<void|'cancelled'>;
}
export type BackgroundRequest={kind:'check';target:CheckTarget;authority:CheckAuthority;finish(result:CheckResult):void}
 | {kind:'result';key:string;instance:string;data:unknown}|{kind:'unavailable';signal:AbortSignal}|{kind:'foreground';signal:AbortSignal};
export interface BackgroundCoordinator {
 start(listener:(request:BackgroundRequest)=>void):void;
 update(targets:readonly CheckTarget[]):void;
 stop():void;
}
export interface BackgroundWorkPorts {
 coordinator:BackgroundCoordinator;
 clock:{now():number};
 environment:{visible():boolean;online():boolean;connected():boolean;busy():boolean;transitTimeZone():string|undefined};
 library?:Pick<AccountLibrary,'session'|'workingLease'|'completeCatalog'|'load'|'cancelCatalogReads'|'markOpened'|'receive'|'refreshLocal'>;
 readonly release:ReleaseCheckPort|null;
 readonly journal:{wake():unknown}|null;
 calculations?:{syncTodayTransitWindow(timeZone:string,now:number,refresh?:boolean):Promise<unknown>|void};
 local:{changed(change:LibraryLocalChange):void;broadcast(notice:LibraryLocalNotice):void};
}
export interface BackgroundRuntime {
 state():{running:boolean;restored:boolean;accountReady:boolean;opening:boolean;writing:boolean;preparingUpdate:boolean};
 publicTask():BackgroundTask|null;
 changed():void;
 wake(at:number,reason:Extract<LibraryFillEvent,{type:'FillWake'}>['reason']):void;
 environmentChanged(facts:{connected:boolean;resumed:boolean}):void;
}
export type EnvironmentChange={reason:'lifecycle'|'connection'|'visibility';returned?:boolean};
export interface ReleaseCheckPort {install?(signal:AbortSignal):Promise<void>;check(signal:AbortSignal):Promise<void>;observe():void;stop():void}
export type BackgroundWorkEvent={type:'BackgroundChanged'}|{type:'BackgroundActivityChanged'}|{type:'LibraryUsed';id:string}
 | {type:'BackgroundEnvironment';change:EnvironmentChange}|{type:'TransitWindowObserved'}
 | {type:'BackgroundIdle';complete():void;signal?:AbortSignal}
 | {type:'LibraryLocalChanged';change:LibraryLocalChange}|{type:'LibraryReceived';data:unknown;completed?:()=>void};
function failure(error:unknown):CheckOutcome {
 const value=error as {status?:number;code?:string;retryAfterMs?:number};
 if(value?.status===401)return {kind:'unauthorized'};
 return {kind:'failed',retryAfterMs:value?.retryAfterMs};
}
async function perform(task:BackgroundTask|undefined,request:Extract<BackgroundRequest,{kind:'check'}>,initial:InitialForegroundWork,admitted:()=>boolean) {
 if(!task || !await request.authority.current() || !admitted())return request.finish({outcome:{kind:'cancelled'}});
 if(initial.pending(task.target))return request.finish({outcome:{kind:'cancelled'}});
 initial.started(task.target);
 try{request.finish(await task.run(request.authority));}
 catch(error){request.finish({outcome:request.authority.signal.aborted?{kind:'cancelled'}:failure(error)});}
}
const sessionKey=(target:CheckTarget)=>`${target.key}/${target.sessionId}`;
/** Failed shared coordination must not block initial library access or offline installation.
 * A failed foreground attempt is consumed once; only explicit update cancellation returns its allowance. */
class InitialForegroundWork {
 private current=new Map<string,{kind:'app'|'library';issued:boolean;pending:boolean;run?:BackgroundTask['initial']}>();
 configure(tasks:readonly BackgroundTask[]){
  const next:typeof this.current=new Map();
  for(const task of tasks) {
   if(task.target.scope.kind!=='library' && task.target.scope.kind!=='app')continue;
   const key=sessionKey(task.target),current=this.current.get(key)??{kind:task.target.scope.kind,issued:false,pending:false};
   current.run=task.initial;next.set(key,current);
  }
  this.current=next;
 }
 pending(target:CheckTarget){return this.current.get(sessionKey(target))?.pending;}
 started(target:CheckTarget){const current=this.current.get(sessionKey(target));if(current?.run)current.issued=true;}
 run(signal:AbortSignal,allowLibrary:boolean,reconsider:()=>void){
  for(const [key,current] of this.current) {
   if(current.kind==='library' && !allowLibrary)continue;
   if(current.issued || current.pending || !current.run || signal.aborted)continue;
   current.issued=true;current.pending=true;
   let cancelled=false;
   void current.run(signal).then(result=>{cancelled=result==='cancelled';}).catch(()=>{}).finally(()=>{
    current.pending=false;
    if(cancelled && current.kind==='library' && this.current.get(key)===current){current.issued=false;reconsider();}
   });
  }
 }
}
/** Task policy and in-flight usage live here, never in a browser scope callback. */
class BackgroundWork {
 private pendingUses=0;private stopped=true;private previousVisible=false;private previousOnline=false;private previousBusy=false;private active=0;
 private ports:BackgroundWorkPorts;private runtime:BackgroundRuntime;
 constructor(ports:BackgroundWorkPorts,runtime:BackgroundRuntime){this.ports=ports;this.runtime=runtime;}
 private idle=new Set<()=>void>();
 private track<T>(work:Promise<T>):Promise<T>{this.active++;return work.finally(()=>{if(--this.active===0){for(const complete of this.idle)complete();this.idle.clear();}});}
 scope():LibraryFillScope|null {
  const state=this.runtime.state(),library=this.ports.library,lease=library?.workingLease,access=library?.session;
  if(this.stopped || !state.running || !state.restored || !state.accountReady || !lease || !access)return null;
  return {lease,sessionId:access.sessionId,catalogMarker:library.completeCatalog?.marker??'',visible:this.ports.environment.visible(),
   foreground:state.preparingUpdate || this.pendingUses>0 || this.ports.environment.busy() || state.opening || state.writing,online:this.ports.environment.online()};
 };
 private wake(reason:Extract<LibraryFillEvent,{type:'FillWake'}>['reason'],at=this.ports.clock.now()){if(!this.stopped)this.runtime.wake(at,reason);};
 private changed(){if(!this.stopped)this.runtime.changed();};
 private appTask(release:ReleaseCheckPort|null):BackgroundTask {
  return {target:{key:'app',scope:{kind:'app'},instance:'release'},
   run:async authority=>{void this.ports.journal?.wake();await release?.check(authority.signal);return {outcome:{kind:'success'},data:{checked:true}};},
   initial:release?.install?signal=>this.track(release.install!(signal)):undefined,receive:()=>{this.ports.release?.observe();}};
 }
 private libraryTask(access:NonNullable<NonNullable<BackgroundWorkPorts['library']>['session']>):BackgroundTask {
  return {target:{key:`library:${access.accountId}`,scope:{kind:'library',accountId:access.accountId},sessionId:access.sessionId},
   run:async authority=>{const result=await this.ports.library!.load(authority),ready=result.status==='complete'||result.status==='unchanged';
    if(ready)this.wake('hourly');return {outcome:{kind:ready?'success':'cancelled'}};},
   initial:this.ports.environment.visible() && this.ports.environment.online()?async signal=>{
    const result=await this.track(this.ports.library!.load(undefined,signal));
    if(result.status==='cancelled')return 'cancelled';
    if(result.status==='complete' || result.status==='unchanged')this.wake('library');
   }:undefined};
 }
 private tasks():BackgroundTask[]{
  const result:BackgroundTask[]=[],state=this.runtime.state(),access=this.ports.library?.session;
  if(state.preparingUpdate)return result;
  if(this.ports.release || this.ports.journal)result.push(this.appTask(this.ports.release));
  if(state.accountReady && state.restored && access)result.push(this.libraryTask(access));
  if(state.restored){const task=this.runtime.publicTask();if(task)result.push(task);}
  return result;
 }
 private used(id:string){
  if(!this.ports.library || this.runtime.state().preparingUpdate)return;
  this.pendingUses++;this.changed();
  void this.track(this.ports.library.markOpened(id)).finally(()=>{this.pendingUses--;if(!this.stopped){this.changed();this.wake('use');}}).catch(()=>{});
 }
 private transit(refresh=false){
  const zone=this.ports.environment.transitTimeZone();
  if(zone && !this.runtime.state().preparingUpdate){const work=this.ports.calculations?.syncTodayTransitWindow(zone,this.ports.clock.now(),refresh);if(work)void this.track(work);}
 }
 private environment(change:EnvironmentChange){
  const visible=this.ports.environment.visible(),online=this.ports.environment.online();
  const appeared=visible&&!this.previousVisible,returned=online&&!this.previousOnline;
  this.previousVisible=visible;this.previousOnline=online;
  const resumed=change.returned || appeared || returned;
  if(resumed && !this.runtime.state().preparingUpdate)void this.ports.journal?.wake();
  if(appeared || returned)this.transit(true);
  if(visible && change.reason==='visibility' && this.runtime.state().accountReady){const work=this.ports.library?.refreshLocal();if(work)void this.track(work).catch(()=>{});}
  this.runtime.environmentChanged({connected:change.reason==='connection' && this.ports.environment.connected(),resumed:!!resumed});
 }
 private local(value:unknown){
  const notice=readLibraryLocalNotice(value,this.ports.library?.workingLease??null,this.ports.library?.session?.sessionId);
  if(!notice)return false;this.ports.local.changed(notice);
  if(notice.payloadStoredAt!==undefined)this.wake('space',notice.payloadStoredAt);return true;
 }
 private async received(data:unknown){
  if(this.local(data) || !this.runtime.state().accountReady || !this.ports.library)return;
  const prior=this.ports.library.completeCatalog;
  await this.ports.library.receive(data).catch(()=>{});
  if(this.stopped)return;this.changed();
  if(this.ports.library.completeCatalog && this.ports.library.completeCatalog!==prior)this.wake('library');
 }
 private currentTasks:readonly BackgroundTask[]=[];
 private initial=new InitialForegroundWork();
 private update(){
  if(this.runtime.state().preparingUpdate)this.ports.library?.cancelCatalogReads();
  this.currentTasks=this.tasks();
  if(!this.runtime.state().preparingUpdate)this.initial.configure(this.currentTasks);
  this.ports.coordinator.update(this.currentTasks.map(task=>task.target));
 }
 private request(request:BackgroundRequest){
  if(this.stopped)return;
  if(request.kind==='unavailable' || request.kind==='foreground'){
   if(!this.runtime.state().preparingUpdate)this.initial.run(request.signal,request.kind==='unavailable',()=>{if(!this.stopped)this.update();});return;
  }
  if(request.kind==='check'){
   const task=this.currentTasks.find(task=>task.target.key===request.target.key && task.target.instance===request.target.instance && task.target.sessionId===request.target.sessionId);
   void this.track(perform(task,request,this.initial,()=>!this.stopped && !this.runtime.state().preparingUpdate));return;
  }
  this.currentTasks.find(task=>task.target.key===request.key && task.target.instance===request.instance)?.receive?.(request.data);
 }
 private localChanged(change:LibraryLocalChange){
  const sessionId=this.ports.library?.session?.sessionId;if(!sessionId)return;
  const notice:LibraryLocalNotice={kind:'local-storage',sessionId,...change};
  if(this.local(notice))this.ports.local.broadcast(notice);
 }
 private event(event:BackgroundWorkEvent){
  if(this.stopped)return;
  switch(event.type){
   case 'LibraryUsed':this.used(event.id);return;
   case 'BackgroundActivityChanged':{
    const busy=this.ports.environment.busy();if(busy===this.previousBusy)return;
    this.previousBusy=busy;this.changed();return;
   }
   case 'BackgroundEnvironment':this.environment(event.change);return;
   case 'TransitWindowObserved':this.transit();return;
   case 'LibraryReceived':void this.track(this.received(event.data)).finally(event.completed);return;
   case 'BackgroundIdle':waitForIdle(this.active>0,this.idle,event.complete,event.signal);return;
   case 'LibraryLocalChanged':this.localChanged(event.change);return;
   case 'BackgroundChanged':this.update();
  }
 }
 readonly logic=fromCallback<BackgroundWorkEvent>(({receive})=>{
  this.stopped=false;this.previousVisible=this.ports.environment.visible();this.previousOnline=this.ports.environment.online();this.previousBusy=this.ports.environment.busy();
  this.ports.coordinator.start(request=>this.request(request));receive(event=>this.event(event));this.update();
  return()=>{this.stopped=true;this.ports.coordinator.stop();};
 });
}

export function createBackgroundWork(ports:BackgroundWorkPorts,runtime:BackgroundRuntime){return new BackgroundWork(ports,runtime);}
