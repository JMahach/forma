import type {BackgroundControl,BackgroundLeader,CheckOutcome,CheckPermit,CheckReason,CheckRecord,CheckTarget} from './background-check.ts';
export const HOUR=60*60*1000,CHECK_TIMEOUT=30000,MIN_RETRY_PAUSE=60000,COALESCE_WINDOW=2000;
export const samePermit=(left:CheckPermit|undefined,right:CheckPermit)=>left?.token===right.token && left.owner===right.owner && left.key===right.key && left.sessionId===right.sessionId;
export const sameLeader=(left:BackgroundLeader|null,right:BackgroundLeader)=>left?.token===right.token && left.owner===right.owner;
const backwards=(record:CheckRecord,now:number)=>record.lastAttemptAt>now+COALESCE_WINDOW;
const unauthorized=(record:CheckRecord,target:CheckTarget)=>!!record.blockedSessionId && record.blockedSessionId===target.sessionId;
const newSession=(record:CheckRecord,target:CheckTarget)=>target.sessionId!==record.target.sessionId;

export function nextCheckAt(record:CheckRecord|undefined,target:CheckTarget,now:number):number|null {
 if(!record)return now;
 if(newSession(record,target))return record.blockedSessionId?now:Math.max(now,record.retryNotBefore);
 if(unauthorized(record,target))return null;
 if(backwards(record,now))return now;
 return Math.max(record.nextDueAt,record.retryNotBefore);
}
function checkAllowed(record:CheckRecord|undefined,target:CheckTarget,now:number,reason:CheckReason,elapsedAttempt?:number) {
 if(!record)return true;
 if(unauthorized(record,target))return false;
 if(backwards(record,now))return true;
 if(newSession(record,target))return !!record.blockedSessionId || now>=record.retryNotBefore;
 if(now<record.retryNotBefore || now<(record.permit?.expiresAt??0))return false;
 return reasonAllows(record,now,reason,elapsedAttempt);
}
function reasonAllows(record:CheckRecord,now:number,reason:CheckReason,elapsedAttempt?:number) {
 if(reason==='changed')return false;
 if(reason==='hourly')return now>=record.nextDueAt || elapsedAttempt===record.lastAttemptAt;
 return now-record.lastAttemptAt>=COALESCE_WINDOW;
}
/** Claim precedes HTTP. A crashed writer leaves its next hour and retry budget intact. */
export function claimCheck(control:BackgroundControl,target:CheckTarget,owner:string,now:number,reason:CheckReason,token:string,elapsedAttempt?:number):CheckPermit|null {
 const previous=control.checks[target.key];
 if(!checkAllowed(previous,target,now,reason,elapsedAttempt))return null;
 const permit:CheckPermit={key:target.key,token,owner,startedAt:now,expiresAt:now+CHECK_TIMEOUT,...(target.sessionId?{sessionId:target.sessionId}:{})};
 control.checks[target.key]={target,lastAttemptAt:now,lastSuccessAt:previous?.lastSuccessAt??null,
  nextDueAt:now+HOUR,retryNotBefore:0,permit};
 return permit;
}
export function finishCheck(control:BackgroundControl,permit:CheckPermit,outcome:CheckOutcome,now:number):boolean {
 const record=control.checks[permit.key];
 if(!record || !samePermit(record.permit,permit) || now>=permit.expiresAt)return false;
 delete record.permit;
 if(outcome.kind==='success')recordSuccess(record,outcome.checkedAt,now);
 else recordFailure(record,permit,outcome,now);
 return true;
}
function recordSuccess(record:CheckRecord,checkedAt:number|undefined,now:number) {
 record.lastSuccessAt=now;
 if(checkedAt!==undefined && checkedAt<=now && now-checkedAt<HOUR){record.lastAttemptAt=checkedAt;record.nextDueAt=checkedAt+HOUR;}
}
function recordFailure(record:CheckRecord,permit:CheckPermit,outcome:Exclude<CheckOutcome,{kind:'success'}>,now:number) {
  const retry=outcome.kind==='failed'?outcome.retryAfterMs??0:0;
  record.retryNotBefore=now+Math.max(MIN_RETRY_PAUSE,Number.isFinite(retry)?retry:0);
  if(outcome.kind==='unauthorized')record.blockedSessionId=permit.sessionId;
}
const leaderAlive=(leader:BackgroundLeader,now:number)=>now<leader.expiresAt && leader.expiresAt<=now+HOUR+CHECK_TIMEOUT;
/** An elapsed watchdog carries the exact observed deadline, never a generic right to steal. */
export function claimLeader(control:BackgroundControl,owner:string,now:number,until:number,token:string,elapsed?:BackgroundLeader):BackgroundLeader|null {
 const previous=control.leader;
 if(previous && previous.owner!==owner && leaderAlive(previous,now)) {
  if(!elapsed || !sameLeader(previous,elapsed) || previous.expiresAt!==elapsed.expiresAt)return null;
 }
 const leader={owner,token:previous?.owner===owner?previous.token:token,expiresAt:until};
 control.leader=leader;return leader;
}
