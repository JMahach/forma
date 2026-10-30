import type {FillControl,FillControlStore,FillAuthority,FillPermit,FillBudget} from '../domain/library-fill.ts';
import {sameFillPermit} from '../domain/library-fill.ts';
import {sameLibraryLease,validLibraryAccountId,readLibraryLease} from './account-library-schema.ts';
import type {LibraryLease} from '../domain/library-maintenance.ts';
import type {createIndexedDatabase} from './indexed-db.ts';
const KEY='library-fill';
type Database=Pick<ReturnType<typeof createIndexedDatabase>,'transaction'>;
function object(value:unknown):Record<string,unknown>{if(!value || typeof value!=='object' || Array.isArray(value))throw new TypeError('Invalid fill control');return value as Record<string,unknown>;}
function text(value:unknown):string{if(typeof value!=='string' || !value)throw new TypeError('Invalid fill identity');return value;}
function time(value:unknown):number{if(typeof value!=='number' || !Number.isSafeInteger(value) || value<0)throw new TypeError('Invalid fill time');return value;}
function budget(value:unknown):FillBudget {
 const row=object(value),attempts=time(row.attempts);if(attempts>3)throw new TypeError('Invalid fill budget');
 return {attempts,occasion:time(row.occasion),notBefore:time(row.notBefore),...(row.blockedSessionId===undefined?{}:{blockedSessionId:text(row.blockedSessionId)})};
}
function permit(value:unknown):FillPermit|null {
 if(value===null)return null;const row=object(value),lease=readLibraryLease(row.lease);if(!lease)throw new TypeError('Invalid fill lease');
 const kind=row.kind;if(kind!=='card' && kind!=='day' && kind!=='major-returns')throw new TypeError('Invalid fill kind');
 const startedAt=time(row.startedAt),expiresAt=time(row.expiresAt);if(expiresAt<=startedAt)throw new TypeError('Invalid fill expiry');
 return {key:text(row.key),kind,chartId:text(row.chartId),revision:time(row.revision),owner:text(row.owner),token:text(row.token),sessionId:text(row.sessionId),lease,startedAt,expiresAt};
}
function control(value:unknown):FillControl {
 const row=object(value),flight=permit(row.flight),budgets=Object.fromEntries(Object.entries(object(row.budgets)).map(([key,value])=>[key,budget(value)]));
 if(flight && !Object.hasOwn(budgets,flight.key))throw new TypeError('Missing fill budget');
 return {flight,budgets,...(row.quota===undefined?{}:{quota:{occasion:time(object(row.quota).occasion)}}),
  ...(row.blockedSessionId===undefined?{}:{blockedSessionId:text(row.blockedSessionId)})};
}
export function readFillControl(value:unknown,accountId:string):FillControl|null {
 if(value===undefined)return {flight:null,budgets:{}};
 try{const row=object(value);if(!validLibraryAccountId(row.accountId))return null;
  if(row.accountId!==accountId)return {flight:null,budgets:{}};
  const result=control(row.value);if(result.flight && result.flight.lease.accountId!==accountId)return null;return result;
 }catch{return null;}
}
export function createLibraryFillStore(database:Database):FillControlStore {
 return {
  read(lease){lease={...lease};return database.transaction<FillControl>('readonly',(tx,done)=>{
   const owner=tx.objectStore('context').get('owner');owner.onsuccess=()=>{
    if(!sameLibraryLease(owner.result,lease))return;
    const read=tx.objectStore('context').get(KEY);read.onsuccess=()=>{const value=readFillControl(read.result,lease.accountId);if(value)done(value);};
   };
  });},
  update(lease,change){lease={...lease};return database.transaction('readwrite',(tx,done,fail)=>{
   const rows=tx.objectStore('context'),owner=rows.get('owner');owner.onsuccess=()=>{
    if(!sameLibraryLease(owner.result,lease))return;
    const read=rows.get(KEY);read.onsuccess=()=>{
     try{const value=readFillControl(read.result,lease.accountId);if(!value)return;
      const before=JSON.stringify(value),result=change(value),next=control(value);
      if(next.flight && next.flight.lease.accountId!==lease.accountId)throw new TypeError('Foreign fill right');
      if(JSON.stringify(next)!==before)rows.put({key:KEY,accountId:lease.accountId,value:next});done(result);
     }catch(error){fail(error);}
    };
   };
  });},
 };
}
/** Validate the current fill right inside the same transaction that writes numbers. */
function rightCurrent(value:FillControl|null,permit:FillPermit,now:number){
 return sameFillPermit(value?.flight??null,permit) && !!value?.flight && value.flight.expiresAt>now && permit.expiresAt>now;
}
export function admitFillTransaction(tx:IDBTransaction,authority:FillAuthority|undefined,seen:LibraryLease,now:()=>number,done:(allowed:boolean)=>void){
 if(!authority){done(true);return;}
 const {signal,permit}=authority,abort=()=>{try{tx.abort();}catch{/* Already settled. */}};
 if(signal.aborted || !sameLibraryLease(permit.lease,seen)){done(false);return;}
 const clean=()=>signal.removeEventListener('abort',abort);signal.addEventListener('abort',abort,{once:true});
 tx.addEventListener('complete',clean,{once:true});tx.addEventListener('abort',clean,{once:true});
 const read=tx.objectStore('context').get(KEY);read.onsuccess=()=>{
  const value=readFillControl(read.result,permit.lease.accountId);
  done(!signal.aborted && rightCurrent(value,permit,now()));
 };
}
