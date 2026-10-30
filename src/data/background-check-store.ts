import type {BackgroundControl,BackgroundStore,CheckAuthority,CheckPermit,CheckRecord,CheckScope,CheckTarget} from '../domain/background-check.ts';
import {validLibraryAccountId} from './account-library-schema.ts';
import {isChartIdentifier} from '../../shared/chart-record-contract.ts';
import type {createIndexedDatabase} from './indexed-db.ts';

type Database=Pick<ReturnType<typeof createIndexedDatabase>,'transaction'>;
export const BACKGROUND_CHECK_KEY='background-checks';
const invalid=()=>new TypeError('Invalid background control');
function object(value:unknown):Record<string,unknown> {
 if(!value || typeof value!=='object' || Array.isArray(value))throw invalid();return value as Record<string,unknown>;
}
function text(value:unknown):string {if(typeof value!=='string' || !value.length)throw invalid();return value;}
function time(value:unknown):number {if(typeof value!=='number' || !Number.isSafeInteger(value) || value<0)throw invalid();return value;}
function session(value:unknown) {return value===undefined?{}:{sessionId:text(value)};}
function scope(value:unknown):CheckScope {
 const row=object(value);
 switch(row.kind){
  case 'app':return {kind:'app'};
  case 'library':if(validLibraryAccountId(row.accountId))return {kind:'library',accountId:row.accountId};break;
  case 'public':if(isChartIdentifier(row.chartId))return {kind:'public',chartId:row.chartId};break;
 }
 throw invalid();
}
function permit(value:unknown):CheckPermit {
 const row=object(value),startedAt=time(row.startedAt),expiresAt=time(row.expiresAt);
 if(expiresAt<=startedAt)throw invalid();
 return {key:text(row.key),token:text(row.token),owner:text(row.owner),startedAt,expiresAt,...session(row.sessionId)};
}
function scopeKey(value:CheckScope) {
 switch(value.kind){
  case 'app':return 'app';
  case 'library':return `library:${value.accountId}`;
  case 'public':return `public:${value.chartId}`;
 }
}
function record(key:string,value:unknown):CheckRecord {
 const row=object(value),targetRow=object(row.target);
 const target:CheckTarget={key:text(targetRow.key),scope:scope(targetRow.scope),...session(targetRow.sessionId)};
 if(targetRow.instance!==undefined)target.instance=text(targetRow.instance);
 if(target.key!==key || key!==scopeKey(target.scope))throw invalid();
 const result:CheckRecord={target,lastAttemptAt:time(row.lastAttemptAt),lastSuccessAt:row.lastSuccessAt===null?null:time(row.lastSuccessAt),
  nextDueAt:time(row.nextDueAt),retryNotBefore:time(row.retryNotBefore)};
 if(row.blockedSessionId!==undefined)result.blockedSessionId=text(row.blockedSessionId);
 if(row.permit!==undefined){
  result.permit=permit(row.permit);
  if(result.permit.key!==key || result.permit.sessionId!==target.sessionId)throw invalid();
 }
 return result;
}
function control(value:unknown):BackgroundControl {
 const row=object(value),leader=row.leader===null?null:object(row.leader);
 return {leader:leader && {owner:text(leader.owner),token:text(leader.token),expiresAt:time(leader.expiresAt)},
  checks:Object.fromEntries(Object.entries(object(row.checks)).map(([key,value])=>[key,record(key,value)]))};
}
/** Missing is fresh; corrupt is unavailable. Never turn damaged rights into a new election. */
export function readBackgroundControl(value:unknown):BackgroundControl|null {
 if(value===undefined)return {leader:null,checks:{}};
 try{return control(object(value).value);}catch{return null;}
}
export function backgroundPermitCurrent(read:BackgroundControl|null,expected:CheckPermit,now:number,accountId:string):boolean {
 if(!read || !Object.hasOwn(read.checks,expected.key))return false;
 const {target,permit}=read.checks[expected.key]!;
 return target.scope.kind==='library' && target.scope.accountId===accountId && !!permit
  && sameBackgroundPermit(permit,expected) && permit.expiresAt>now && expected.expiresAt>now;
}
function sameBackgroundPermit(a:CheckPermit,b:CheckPermit) {
 return a.key===b.key && a.token===b.token && a.owner===b.owner && a.sessionId===b.sessionId;
}
export async function backgroundAuthorityCurrent(authority:CheckAuthority):Promise<boolean> {
 return !authority.signal.aborted && await authority.current() && !authority.signal.aborted;
}
/** A single existing context row, with no memoized control or second database. */
export function createBackgroundCheckStore(database:Database):BackgroundStore {
 return {
  read(){return database.transaction<BackgroundControl>('readonly',(tx,done)=>{
   const read=tx.objectStore('context').get(BACKGROUND_CHECK_KEY);
   read.onsuccess=()=>{const value=readBackgroundControl(read.result);if(value)done(value);};
  });},
  update<T>(change:(value:BackgroundControl)=>T):Promise<T|null> {
   return database.transaction<T>('readwrite',(tx,done,fail)=>{
    const rows=tx.objectStore('context'),read=rows.get(BACKGROUND_CHECK_KEY);
    read.onsuccess=()=>{
     try{
      const value=readBackgroundControl(read.result);if(!value)return;
      const before=JSON.stringify(value),result=change(value),next=control(value);
      if(JSON.stringify(next)!==before)rows.put({key:BACKGROUND_CHECK_KEY,value:next});
      done(result);
     }catch(error){fail(error);}
    };
   });
  },
 };
}
