import {MAIN_RETURN_BODIES} from '../../shared/chart-return-contract.ts';
import type {LibraryCatalogEntry} from '../../shared/library-catalog-contract.ts';
import type {PackageRef} from '../../shared/library-package-contract.ts';
import type {LibraryInventory,LibraryLease} from './library-maintenance.ts';
export interface FillCandidate {key:string;chartId:string;revision:number;ref:PackageRef}
export interface FillTier {kind:PackageRef['kind'];candidates:FillCandidate[];missing:boolean;blocked:boolean}
export interface FillBudget {attempts:number;occasion:number;notBefore:number;blockedSessionId?:string}
export interface FillPermit {key:string;kind:PackageRef['kind'];chartId:string;revision:number;token:string;owner:string;lease:LibraryLease;sessionId:string;startedAt:number;expiresAt:number}
export interface FillControl {flight:FillPermit|null;budgets:Record<string,FillBudget>;quota?:{occasion:number};blockedSessionId?:string}
export interface FillControlStore {
 read(lease:LibraryLease):Promise<FillControl|null>;
 update<T>(lease:LibraryLease,change:(control:FillControl)=>T):Promise<T|null>;
}
export interface FillAuthority {permit:FillPermit;signal:AbortSignal}
export const fillPackageKey=(ref:PackageRef)=>JSON.stringify(ref.kind==='major-returns'?{kind:ref.kind,sourceKey:ref.sourceKey,family:ref.family}:{kind:ref.kind,sourceKey:ref.sourceKey});
interface PlannedPart {candidate:FillCandidate;present:boolean;evicted:boolean;ready:boolean;used:number}
function cardPart(entry:LibraryCatalogEntry,cards:Map<string,number>,usage:Map<string,LibraryInventory['usage'][number]>):PlannedPart {
 const use=usage.get(entry.id),ref=entry.packages.card;
 return {candidate:{key:fillPackageKey(ref),chartId:entry.id,revision:entry.revision,ref},present:(cards.get(entry.id)??0)>=entry.revision,
  evicted:use?.evicted===true,ready:true,used:use?.openedAt??0};
}
function numericalPart(entry:LibraryCatalogEntry,ref:Exclude<PackageRef,{kind:'card'}>,ready:boolean,
 packages:Map<string,LibraryInventory['packages'][number]>,usage:Map<string,LibraryInventory['usage'][number]>):PlannedPart {
 const key=fillPackageKey(ref),stored=packages.get(key);
 return {candidate:{key,chartId:entry.id,revision:entry.revision,ref},present:!!stored?.present && !stored.evicted,
  evicted:stored?.evicted===true,ready,used:Math.max(usage.get(key)?.openedAt??0,usage.get(entry.id)?.openedAt??0)};
}
function tier(kind:PackageRef['kind'],parts:PlannedPart[],reconsider:boolean):FillTier {
 const ordered=parts.filter(part=>!part.present).sort((a,b)=>b.used-a.used || a.candidate.chartId.localeCompare(b.candidate.chartId));
 const seen=new Set<string>(),candidates:FillCandidate[]=[];let blocked=false;
 for(const part of ordered){
  if(seen.has(part.candidate.key))continue;seen.add(part.candidate.key);
  if(part.ready && (!part.evicted || reconsider))candidates.push(part.candidate);else blocked=true;
 }
 return {kind,candidates,missing:ordered.length>0,blocked};
}
/** Full-library tiers are barriers. An intentional miss or server-not-ready day never opens the lower tier. */
export function planLibraryFill(entries:readonly LibraryCatalogEntry[],inventory:LibraryInventory,{reconsiderEvicted=false}:{reconsiderEvicted?:boolean}={}):FillTier[]{
 const cards=new Map(inventory.cards.map(row=>[row.id,row.revision])),packages=new Map(inventory.packages.map(row=>[row.id,row])),usage=new Map(inventory.usage.map(row=>[row.id,row]));
 const days:PlannedPart[]=[],families:PlannedPart[]=[];
 for(const entry of entries){
  const day=entry.packages.day;if(day)days.push(numericalPart(entry,day.ref,day.ready,packages,usage));
  const returns=entry.packages.majorReturns;if(!returns)continue;
  for(const family of MAIN_RETURN_BODIES)families.push(numericalPart(entry,{kind:'major-returns',sourceKey:returns.sourceKey,family},returns.readyFamilies.includes(family),packages,usage));
 }
 return [tier('card',entries.map(entry=>cardPart(entry,cards,usage)),reconsiderEvicted),tier('day',days,reconsiderEvicted),tier('major-returns',families,reconsiderEvicted)];
}
export type FillReservation={kind:'acquired';permit:FillPermit}|{kind:'wait';at:number}|{kind:'blocked'};
export interface FillRequest {candidate:FillCandidate;lease:LibraryLease;sessionId:string;owner:string;token:string;now:number;occasion:number;spaceRelief?:boolean}
function expireFlight(control:FillControl,now:number){
 const prior=control.flight;if(!prior || prior.expiresAt>now)return;
 const budget=control.budgets[prior.key];if(budget){budget.attempts=3;budget.notBefore=Math.max(budget.notBefore,prior.expiresAt+60000);}
 control.flight=null;
}
function admittedBudget(control:FillControl,request:FillRequest):FillBudget|null {
 const {candidate,sessionId,occasion,now}=request;
 const budget=control.budgets[candidate.key]??{attempts:0,occasion,notBefore:0};
 if(budget.blockedSessionId===sessionId)return null;
 if(budget.blockedSessionId){delete budget.blockedSessionId;budget.attempts=0;}
 if(budget.attempts>=3){if(now<budget.notBefore || occasion<=budget.occasion)return null;budget.attempts=0;}
 control.budgets[candidate.key]=budget;return budget;
}
export function reserveFill(control:FillControl,request:FillRequest):FillReservation {
 const {now,occasion,spaceRelief}=request;expireFlight(control,now);
 if(control.blockedSessionId===request.sessionId)return {kind:'blocked'};
 if(control.blockedSessionId)delete control.blockedSessionId;
 if(control.flight)return {kind:'blocked'};
 if(control.quota){if(!spaceRelief || occasion<=control.quota.occasion)return {kind:'blocked'};delete control.quota;}
 const budget=admittedBudget(control,request);if(!budget)return {kind:'blocked'};
 if(now<budget.notBefore)return {kind:'wait',at:budget.notBefore};
 budget.attempts++;budget.occasion=Math.max(budget.occasion,occasion);
 const permit:FillPermit={key:request.candidate.key,kind:request.candidate.ref.kind,chartId:request.candidate.chartId,revision:request.candidate.revision,token:request.token,owner:request.owner,lease:{...request.lease},sessionId:request.sessionId,startedAt:now,expiresAt:now+30000};
 control.flight=permit;return {kind:'acquired',permit};
}
export type FillOutcome={kind:'success'|'cancelled'|'quota'|'unauthorized'|'storage-unavailable'}|{kind:'failed';retryAfterMs?:number};
export function finishFill(control:FillControl,permit:FillPermit,outcome:FillOutcome,now:number):boolean {
 if(!sameFillPermit(control.flight,permit))return false;
 control.flight=null;const budget=control.budgets[permit.key];if(!budget)return false;
 if(now>=permit.expiresAt || outcome.kind==='storage-unavailable'){budget.attempts=3;budget.notBefore=Math.max(budget.notBefore,now+60000);return true;}
 return applyOutcome(control,permit,budget,outcome,now);
}
function applyOutcome(control:FillControl,permit:FillPermit,budget:FillBudget,outcome:FillOutcome,now:number){
 if(outcome.kind==='success'){delete control.budgets[permit.key];return true;}
 if(outcome.kind==='quota'){control.quota={occasion:budget.occasion};delete control.budgets[permit.key];return true;}
 if(outcome.kind==='unauthorized'){control.blockedSessionId=permit.sessionId;budget.blockedSessionId=permit.sessionId;return true;}
 const delay=budget.attempts>=3?60000:budget.attempts===1?1000:5000;
 const retryAfter=outcome.kind==='failed'?outcome.retryAfterMs:0;
 const server=Number.isFinite(retryAfter)?Math.max(0,retryAfter??0):0;
 budget.notBefore=Math.max(budget.notBefore,now+delay,now+server);return true;
}
export function sameFillPermit(a:FillPermit|null,b:FillPermit){return !!a && a.kind===b.kind && a.chartId===b.chartId && a.revision===b.revision && a.token===b.token && a.owner===b.owner && a.key===b.key && a.sessionId===b.sessionId && a.lease.accountId===b.lease.accountId && a.lease.generation===b.lease.generation;}

export type FillReceipt={kind:'ready';payload:unknown}|{kind:'not-ready';retryAfterMs?:number};
export type FillPlacement='stored'|'no-op'|'quota'|'stale'|'unavailable'|'invalid';

/** Deleted/replaced catalogue sources no longer own retry metadata. Existing keys keep their budget. */
export function pruneFillBudgets(control:FillControl,entries:readonly LibraryCatalogEntry[]){
 const keys=new Set<string>();
 for(const entry of entries){
  keys.add(fillPackageKey(entry.packages.card));
  if(entry.packages.day)keys.add(fillPackageKey(entry.packages.day.ref));
  const returns=entry.packages.majorReturns;if(returns)for(const family of MAIN_RETURN_BODIES)keys.add(fillPackageKey({kind:'major-returns',sourceKey:returns.sourceKey,family}));
 }
 for(const key of Object.keys(control.budgets))if(key!==control.flight?.key && !keys.has(key))delete control.budgets[key];
 return true;
}
