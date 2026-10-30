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
 | {kind:'result';key:string;instance:string;data:unknown}|{kind:'unavailable';signal:AbortSignal};
export interface BackgroundCoordinator {
 start(listener:(request:BackgroundRequest)=>void):void;
 update(targets:readonly CheckTarget[]):void;
 stop():void;
}
export interface BackgroundWorkPorts {coordinator:BackgroundCoordinator;tasks():readonly BackgroundTask[]}
export interface ReleaseCheckPort {check(signal:AbortSignal):Promise<void>;observe():void;stop():void}
export type BackgroundWorkEvent={type:'BackgroundChanged'};
function failure(error:unknown):CheckOutcome {
 const value=error as {status?:number;code?:string;retryAfterMs?:number};
 if(value?.status===401)return {kind:'unauthorized'};
 return {kind:'failed',retryAfterMs:value?.retryAfterMs};
}
async function perform(task:BackgroundTask|undefined,request:Extract<BackgroundRequest,{kind:'check'}>,initial:InitialLibraryRead) {
 if(!task || !await request.authority.current())return request.finish({outcome:{kind:'cancelled'}});
 if(initial.pending(task.target))return request.finish({outcome:{kind:'cancelled'}});
 initial.started(task.target);
 try{request.finish(await task.run(request.authority));}
 catch(error){request.finish({outcome:request.authority.signal.aborted?{kind:'cancelled'}:failure(error)});}
}
const sessionKey=(target:CheckTarget)=>`${target.key}/${target.sessionId}`;
/** A failed shared coordinator must not turn an initial sign-in into an empty library.
 * This foreground allowance is consumed once, even when its read fails. */
class InitialLibraryRead {
 private current:{key:string;issued:boolean;pending:boolean;run?:BackgroundTask['initial']}|null=null;
 configure(tasks:readonly BackgroundTask[]){
  const task=tasks.find(value=>value.target.scope.kind==='library');if(!task)return;
  const key=sessionKey(task.target);if(this.current?.key===key)return;
  this.current={key,issued:false,pending:false,run:task.initial};
 }
 pending(target:CheckTarget){return this.current?.key===sessionKey(target) && this.current.pending;}
 started(target:CheckTarget){if(this.current?.key===sessionKey(target))this.current.issued=true;}
 unavailable(signal:AbortSignal){
  const current=this.current;if(!current || current.issued)return;
  current.issued=true;if(!current.run || signal.aborted)return;
  current.pending=true;void current.run(signal).catch(()=>{}).finally(()=>{current.pending=false;});
 }
}
/** The child dispatches only work admitted by the shared platform coordinator. */
export function createBackgroundWork(ports:BackgroundWorkPorts) {
 return fromCallback<BackgroundWorkEvent>(({receive})=>{
  let tasks:readonly BackgroundTask[]=[];
  const initial=new InitialLibraryRead();
  const update=()=>{tasks=ports.tasks();initial.configure(tasks);ports.coordinator.update(tasks.map(task=>task.target));};
  ports.coordinator.start(request=>{
   if(request.kind==='unavailable'){initial.unavailable(request.signal);return;}
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
