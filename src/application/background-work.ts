import {fromCallback} from 'xstate';
import type {CheckAuthority,CheckOutcome,CheckTarget} from '../domain/background-check.ts';
export interface CheckResult {outcome:CheckOutcome;data?:unknown}
export interface BackgroundTask {
 target:CheckTarget;
 run(authority:CheckAuthority):Promise<CheckResult>;
 receive?(data:unknown):void;
 initial?(signal:AbortSignal):Promise<void>;
}
export type BackgroundRequest={kind:'check';target:CheckTarget;authority:CheckAuthority;finish(result:CheckResult):void}
 | {kind:'result';key:string;instance:string;data:unknown}|{kind:'unavailable';signal:AbortSignal}|{kind:'foreground';signal:AbortSignal};
export interface BackgroundCoordinator {
 start(listener:(request:BackgroundRequest)=>void):void;
 update(targets:readonly CheckTarget[]):void;
 stop():void;
}
export interface BackgroundWorkPorts {coordinator:BackgroundCoordinator;tasks():readonly BackgroundTask[]}
export interface ReleaseCheckPort {install?(signal:AbortSignal):Promise<void>;check(signal:AbortSignal):Promise<void>;observe():void;stop():void}
export type BackgroundWorkEvent={type:'BackgroundChanged'};
function failure(error:unknown):CheckOutcome {
 const value=error as {status?:number;code?:string;retryAfterMs?:number};
 if(value?.status===401)return {kind:'unauthorized'};
 return {kind:'failed',retryAfterMs:value?.retryAfterMs};
}
async function perform(task:BackgroundTask|undefined,request:Extract<BackgroundRequest,{kind:'check'}>,initial:InitialForegroundWork) {
 if(!task || !await request.authority.current())return request.finish({outcome:{kind:'cancelled'}});
 if(initial.pending(task.target))return request.finish({outcome:{kind:'cancelled'}});
 initial.started(task.target);
 try{request.finish(await task.run(request.authority));}
 catch(error){request.finish({outcome:request.authority.signal.aborted?{kind:'cancelled'}:failure(error)});}
}
const sessionKey=(target:CheckTarget)=>`${target.key}/${target.sessionId}`;
/** Failed shared coordination must not block initial library access or offline installation.
 * Each foreground allowance is consumed once; resumes never turn it into polling. */
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
 run(signal:AbortSignal,allowLibrary:boolean){
  for(const current of this.current.values()) {
   if(current.kind==='library' && !allowLibrary)continue;
   if(current.issued || !current.run || signal.aborted)continue;
   current.issued=true;current.pending=true;
   void current.run(signal).catch(()=>{}).finally(()=>{current.pending=false;});
  }
 }
}
/** The child dispatches only work admitted by the shared platform coordinator. */
export function createBackgroundWork(ports:BackgroundWorkPorts) {
 return fromCallback<BackgroundWorkEvent>(({receive})=>{
  let tasks:readonly BackgroundTask[]=[];
  const initial=new InitialForegroundWork();
  const update=()=>{tasks=ports.tasks();initial.configure(tasks);ports.coordinator.update(tasks.map(task=>task.target));};
  ports.coordinator.start(request=>{
   if(request.kind==='unavailable' || request.kind==='foreground'){
    initial.run(request.signal,request.kind==='unavailable');return;
   }
   if(request.kind==='check') {
    const task=tasks.find(task=>task.target.key===request.target.key && task.target.instance===request.target.instance && task.target.sessionId===request.target.sessionId);
    void perform(task,request,initial);return;
   }
   const task=tasks.find(task=>task.target.key===request.key && task.target.instance===request.instance);
   task?.receive?.(request.data);
  });
  receive(update);update();
  return()=>ports.coordinator.stop();
 });
}
