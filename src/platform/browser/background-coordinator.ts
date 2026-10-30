import type {BackgroundCoordinator,BackgroundRequest,CheckResult} from '../../application/background-work.ts';
import type {BackgroundControl,BackgroundLeader,BackgroundStore,CheckAuthority,CheckPermit,CheckReason,CheckTarget} from '../../domain/background-check.ts';
import {claimCheck,claimLeader,finishCheck,nextCheckAt,sameLeader,samePermit,HOUR,CHECK_TIMEOUT} from '../../domain/background-policy.ts';
import type {PageLifecycle} from './lifecycle.ts';
import {isChartIdentifier} from '../../../shared/chart-record-contract.ts';

interface Channel {
 postMessage(value:unknown):void;close():void;
 addEventListener(type:'message',listener:(event:MessageEvent)=>void):void;
 removeEventListener(type:'message',listener:(event:MessageEvent)=>void):void;
}
export interface BackgroundClock {now():number;after(ms:number,callback:()=>void):()=>void}
interface Options {owner:string;store:BackgroundStore;lifecycle:PageLifecycle;channel:Channel|null;clock?:BackgroundClock;id?:()=>string}
interface Assignment {executor:string;epoch:string;target:CheckTarget;permit:CheckPermit;recipients:Record<string,string>}
interface Flight {assignment:Assignment;controller:AbortController;cancel:()=>void}
type Choice=Pick<Assignment,'executor'|'epoch'|'target'>;
interface ScheduledCheck {at:number;target:CheckTarget}
const clock:BackgroundClock={now:Date.now,after(ms,callback){const timer=setTimeout(callback,ms);return()=>clearTimeout(timer);}};
const object=(value:unknown):value is Record<string,unknown>=>!!value && typeof value==='object' && !Array.isArray(value);
function target(value:unknown):value is CheckTarget {
 if(!object(value) || !object(value.scope) || typeof value.key!=='string')return false;
 if(!optionalText(value.instance) || !optionalText(value.sessionId))return false;
 return scopeMatches(value.scope,value.key);
}
const optionalText=(value:unknown)=>value===undefined || typeof value==='string';
function scopeMatches(scope:Record<string,unknown>,key:string){
 if(scope.kind==='app')return key==='app';
 if(scope.kind==='library')return typeof scope.accountId==='string' && /^[1-9][0-9]{0,19}$/.test(scope.accountId) && key===`library:${scope.accountId}`;
 return scope.kind==='public' && isChartIdentifier(scope.chartId) && key===`public:${scope.chartId}`;
}
function scheduledChecks(control:BackgroundControl,targets:CheckTarget[],now:number):ScheduledCheck[]{
 return targets.flatMap(target=>{const at=nextCheckAt(control.checks[target.key],target,now);return at===null?[]:[{at,target}];});
}
function elapsedChecks(control:BackgroundControl,due:ScheduledCheck[],next:number){
 return Object.fromEntries(due.filter(value=>value.at===next).flatMap(({target})=>{
  const record=control.checks[target.key];return record && record.retryNotBefore<=record.nextDueAt?[[target.key,record.lastAttemptAt]]:[];
 }));
}
function planningDeadline(due:ScheduledCheck[],now:number){
 const next=due.length?Math.min(...due.map(value=>value.at)):null;
 return {next,until:Math.min(now+HOUR+CHECK_TIMEOUT,Math.max(now,next??now)+CHECK_TIMEOUT)};
}
function permitEnvelope(value:Record<string,unknown>,key:string,owner:string){
 return typeof value.token==='string' && value.owner===owner && value.key===key && Number.isFinite(value.expiresAt) && Number.isFinite(value.startedAt);
}
const sameTarget=(a:CheckTarget,b:CheckTarget)=>a.key===b.key && a.sessionId===b.sessionId && a.instance===b.instance;

/** One origin scheduler; each admitted contour belongs to one suitable live participant. */
class BrowserBackgroundCoordinator implements BackgroundCoordinator {
 private options:Options;private clock:BackgroundClock;private id:()=>string;
 private targets:readonly CheckTarget[]=[];private peers=new Map<string,{targets:readonly CheckTarget[];epoch:string}>();private epoch='';
 private listener:(request:BackgroundRequest)=>void=()=>{};private disconnect=()=>{};
 private stopped=true;private paused=false;private active=false;private leader:BackgroundLeader|null=null;
 private cancelTimer=()=>{};private round:CheckReason|null=null;private elapsed:Record<string,number>={};
 private operations=Promise.resolve();private flights=new Map<string,Flight>();
 private eligibility=new AbortController();
 constructor(options:Options){this.options=options;this.clock=options.clock??clock;this.id=options.id??(()=>crypto.randomUUID());this.message=this.message.bind(this);}
 private enqueue(work:()=>Promise<void>){this.operations=this.operations.then(async()=>{if(!this.stopped && !this.paused)await work();}).catch(()=>this.pause());}
 private post(message:object){
  try{if(!this.stopped)this.options.channel?.postMessage({version:1,owner:this.options.owner,epoch:this.epoch,...message});}
  catch{this.pause();}
 }
 private present(){this.post({kind:'presence',targets:this.active?this.targets:[]});}
 private setTimer(delay:number,callback:()=>void){this.cancelTimer();this.cancelTimer=this.clock.after(Math.max(0,delay),callback);}
 private pause(){this.paused=true;this.cancelTimer();this.round=null;this.cancelFlights();if(this.active)this.listener({kind:'unavailable',signal:this.eligibility.signal});}
 private cancelFlights(){for(const flight of this.flights.values()){flight.controller.abort();flight.cancel();}this.flights.clear();}
 private withdraw(){
  this.eligibility.abort();
  this.cancelTimer();this.round=null;this.cancelFlights();this.present();
  const leader=this.leader;this.leader=null;
  void this.options.store.update(control=>{
   if(leader && sameLeader(control.leader,leader))control.leader=null;
   for(const record of Object.values(control.checks))if(record.permit?.owner===this.options.owner)
    finishCheck(control,record.permit,{kind:'cancelled'},this.clock.now());
   return true;
  }).then(()=>this.post({kind:'changed'})).catch(()=>{});
 }
 private lifecycle=(returned:boolean)=>{
  if(this.stopped)return;
  const wasActive=this.active;this.active=this.options.lifecycle.active;
  if(!this.active){this.withdraw();return;}
  if(!wasActive){this.epoch=this.id();this.eligibility=new AbortController();}
  this.listener({kind:'foreground',signal:this.eligibility.signal});
  if(!this.options.channel){this.pause();return;}
  this.paused=false;this.present();this.post({kind:'hello'});
  this.wake(returned?'lifecycle':'changed');
 };
 start(listener:(request:BackgroundRequest)=>void){
  if(!this.stopped)return;this.stopped=false;this.listener=listener;
  this.options.channel?.addEventListener('message',this.message);
  this.disconnect=this.options.lifecycle.subscribe(this.lifecycle);this.lifecycle(true);
 }
 update(targets:readonly CheckTarget[]){
  if(this.active && !this.stopped)this.listener({kind:'foreground',signal:this.eligibility.signal});
  if(this.active && !this.stopped && this.paused){
   this.targets=targets.map(value=>({...value}));
   this.listener({kind:'unavailable',signal:this.eligibility.signal});return;
  }
  if(JSON.stringify(this.targets)===JSON.stringify(targets))return;
  this.targets=targets.map(value=>({...value}));
  // Source/account owners cancel departed reads. A successful absence may
  // remove its own target synchronously before its result reaches peers.
  if(!this.active || this.stopped)return;
  this.present();this.wake('changed');
 }
 stop(){
  if(this.stopped)return;this.active=false;this.withdraw();this.stopped=true;this.disconnect();
  this.options.channel?.removeEventListener('message',this.message);this.options.channel?.close();this.peers.clear();
 }
 private participants(){return new Map([[this.options.owner,{targets:this.targets,epoch:this.epoch}],...this.peers]);}
 private choices(){
  const choices=new Map<string,Choice>();
  for(const [executor,{targets,epoch}] of this.participants())for(const target of targets)if(!choices.has(target.key))choices.set(target.key,{executor,epoch,target});
  return [...choices.values()];
 }
 private recipients(key:string){
  const recipients:Record<string,string>={};
  for(const [owner,{targets,epoch}] of this.participants()){
   const entry=targets.find(value=>value.key===key);if(entry?.instance)recipients[owner]=`${epoch}:${entry.instance}`;
  }
  return recipients;
 }
 private reserve(control:BackgroundControl,choices:Choice[],reason:CheckReason,elapsed:Record<string,number>,now:number):Assignment[]{
  const alive=new Set(choices.map(({target})=>target.key));
  for(const [key,record] of Object.entries(control.checks))if(record.target.scope.kind==='public' && !alive.has(key) && !(record.permit && record.permit.expiresAt>now))delete control.checks[key];
  return choices.flatMap(choice=>{
   const permit=claimCheck(control,choice.target,choice.executor,now,reason,this.id(),elapsed[choice.target.key]);
   return permit?[{...choice,permit,recipients:this.recipients(choice.target.key)}]:[];
  });
 }
 private wake(reason:CheckReason,elapsed:Record<string,number>={}){
  if(!this.active || this.paused)return;
  this.post({kind:'wake',reason});this.beginRound(reason,elapsed);
 }
 private beginRound(reason:CheckReason,elapsed:Record<string,number>={}){
  this.enqueue(async()=>{
   await this.plan();if(!this.leader || !this.active)return;
   if(this.round){if(reason==='lifecycle')this.round=reason;Object.assign(this.elapsed,elapsed);return;}
   this.round=reason;this.elapsed=elapsed;
   // Only replies from live participants take part in this pass. Closed public
   // sources are never rediscovered from an old stored list.
   this.peers.clear();this.post({kind:'hello'});
   this.setTimer(25,()=>this.enqueue(()=>this.dispatch()));
  });
 }
 private async dispatch(){
  const reason=this.round,elapsed=this.elapsed;this.round=null;this.elapsed={};
  if(!reason || !this.active || !this.leader)return;
  const leader=this.leader,now=this.clock.now(),choices=this.choices();
  const assignments=await this.options.store.update(control=>{
   if(!sameLeader(control.leader,leader))return [];
   return this.reserve(control,choices,reason,elapsed,now);
  });
  if(!assignments){this.pause();return;}
  for(const assignment of assignments){
   if(assignment.executor===this.options.owner)this.execute(assignment);
   else this.post({kind:'execute',assignment});
  }
  this.post({kind:'changed'});await this.plan();
 }
 private async plan(elapsedLeader?:BackgroundLeader){
  if(!this.active || this.round)return;
  const now=this.clock.now(),targets=this.choices().map(value=>value.target);
  const planned=await this.options.store.update(control=>{
   const due=scheduledChecks(control,targets,now),{next,until}=planningDeadline(due,now),previous=control.leader;
   const current=claimLeader(control,this.options.owner,now,until,this.id(),elapsedLeader)??control.leader;
   return current && {control,due,next,previous,current};
  });
  if(!planned){this.pause();return;}
  const {control,due,next,previous,current}=planned;
  if(!this.active){await this.releaseInactive(current);return;}
  this.leader=current.owner===this.options.owner?current:null;
  this.announceLeader(previous,current);
  this.arm(current,control,due,next,now);
 }

 private async releaseInactive(leader:BackgroundLeader){
  await this.options.store.update(control=>{
   if(!this.active && leader.owner===this.options.owner && sameLeader(control.leader,leader))control.leader=null;
   return true;
  });
  this.post({kind:'changed'});
 }
 private announceLeader(previous:BackgroundLeader|null,current:BackgroundLeader){
  if(!previous || !sameLeader(previous,current) || previous.expiresAt!==current.expiresAt)this.post({kind:'changed'});
 }
 private arm(current:BackgroundLeader,snapshot:BackgroundControl,due:ScheduledCheck[],next:number|null,now:number){
  this.cancelTimer();
  if(next===null)return;
  if(!this.leader){this.setTimer(current.expiresAt-now,()=>this.enqueue(async()=>{await this.plan(current);if(this.leader)this.beginRound('hourly');}));return;}
  const elapsed=elapsedChecks(snapshot,due,next);
  if(next>now+HOUR)this.setTimer(HOUR,()=>this.enqueue(()=>this.plan()));
  else this.setTimer(next-now,()=>this.wake('hourly',elapsed));
 }
 private execute(assignment:Assignment){
  if(!this.active || assignment.epoch!==this.epoch || !this.targets.some(value=>sameTarget(value,assignment.target)))return;
  if(this.flights.has(assignment.permit.token))return;
  const controller=new AbortController();
  const flight:Flight={assignment,controller,cancel:()=>{}};
  const authority:CheckAuthority={permit:assignment.permit,signal:controller.signal,current:()=>this.current(flight)};
  this.flights.set(assignment.permit.token,flight);
  flight.cancel=this.clock.after(assignment.permit.expiresAt-this.clock.now(),()=>{controller.abort();this.flights.delete(assignment.permit.token);});
  this.listener({kind:'check',target:assignment.target,authority,finish:result=>{void this.finish(flight,result).catch(()=>this.pause());}});
 }
 private async current(flight:Flight){
  if(!this.accepts(flight))return false;
  const state=await this.options.store.read(),permit=flight.assignment.permit;
  return this.accepts(flight) && !!state && samePermit(state.checks[permit.key]?.permit,permit);
 }
 private accepts(flight:Flight){return this.active && !this.stopped && !flight.controller.signal.aborted && this.clock.now()<flight.assignment.permit.expiresAt;}
 private async finish(flight:Flight,result:CheckResult){
  const {assignment}=flight;if(!this.accepts(flight))return;
  const accepted=await this.options.store.update(control=>this.accepts(flight) && finishCheck(control,assignment.permit,result.outcome,this.clock.now()));
  flight.cancel();this.flights.delete(assignment.permit.token);
  if(!accepted || !this.accepts(flight))return;
  if(result.data!==undefined)this.post({kind:'result',key:assignment.target.key,recipients:assignment.recipients,data:result.data});
  this.post({kind:'changed'});this.enqueue(()=>this.plan());
 }
 private message(event:MessageEvent){
  const value=event.data;if(this.stopped || !object(value) || value.version!==1 || typeof value.owner!=='string' || typeof value.epoch!=='string' || value.owner===this.options.owner)return;
  if(value.kind==='presence'){this.receivePresence(value.owner,value.epoch,value.targets);return;}
  if(!this.active || this.paused)return;
  this.receiveActive(value);
 }
 private receivePresence(owner:string,epoch:string,targets:unknown){
  if(!Array.isArray(targets) || !targets.every(target))return;
  const previous=this.peers.get(owner),next=targets.length?{targets,epoch}:undefined;
  if(JSON.stringify(previous)===JSON.stringify(next))return;
  if(next)this.peers.set(owner,next);else this.peers.delete(owner);
  this.enqueue(()=>this.plan());
 }
 private receiveActive(value:Record<string,unknown>){
  switch(value.kind){
   case 'hello':this.present();break;
   case 'changed':this.enqueue(()=>this.plan());break;
   case 'wake':
    if(this.peers.get(String(value.owner))?.epoch===value.epoch && ['lifecycle','hourly','changed'].includes(String(value.reason)))this.beginRound(value.reason as CheckReason);
    break;
   case 'execute':this.receiveAssignment(value.assignment);break;
   case 'result':this.receiveResult(value);break;
  }
 }
 private receiveResult(value:Record<string,unknown>){
  if(typeof value.key!=='string' || !object(value.recipients))return;
  const token=value.recipients[this.options.owner],prefix=`${this.epoch}:`;
  if(typeof token==='string' && token.startsWith(prefix))this.listener({kind:'result',key:value.key,instance:token.slice(prefix.length),data:value.data});
 }

 private receiveAssignment(value:unknown){
  if(!object(value) || value.executor!==this.options.owner || value.epoch!==this.epoch || !target(value.target) || !object(value.permit) || !object(value.recipients))return;
  const permit=value.permit;
  if(!permitEnvelope(permit,value.target.key,this.options.owner))return;
  this.execute(value as unknown as Assignment);
 }
}
export function createBackgroundCoordinator(options:Options):BackgroundCoordinator{return new BrowserBackgroundCoordinator(options);}
