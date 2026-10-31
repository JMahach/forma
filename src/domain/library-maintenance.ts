import type {PackageRef} from '../../shared/library-package-contract.ts';
import {isMainReturnBody} from '../../shared/chart-return-contract.ts';

export interface LibraryLease {accountId:string;generation:string}
export interface LibraryLocalChange {lease:LibraryLease;keys:string[];payloadStoredAt?:number}
export type LibraryLocalNotice=LibraryLocalChange & {kind:'local-storage';sessionId:string};

function matchesLocalScope(row:Partial<LibraryLocalNotice>,lease:LibraryLease,sessionId:string) {
 return row.kind==='local-storage' && row.sessionId===sessionId && row.lease?.accountId===lease.accountId && row.lease.generation===lease.generation
  && (row.payloadStoredAt===undefined || Number.isFinite(row.payloadStoredAt));
}
function validChangeKeys(keys:unknown):keys is string[] {
 return Array.isArray(keys) && keys.length>0 && keys.length<=10000 && keys.every(key=>typeof key==='string' && key.length>0 && key.length<=1024);
}
/** A peer may announce changed keys, never numerical payloads or a new owner. */
export function readLibraryLocalNotice(value:unknown,lease:LibraryLease|null,sessionId:string|undefined):LibraryLocalChange|null {
 if(!lease || !sessionId || !value || typeof value!=='object')return null;
 const row=value as Partial<LibraryLocalNotice>;
 if(!matchesLocalScope(row,lease,sessionId) || !validChangeKeys(row.keys))return null;
 return {lease:{...lease},keys:[...new Set(row.keys)],...(row.payloadStoredAt===undefined?{}:{payloadStoredAt:row.payloadStoredAt})};
}

export function readLibraryPackageKey(key:string):Exclude<PackageRef,{kind:'card'}>|null {
 try {
  const ref=JSON.parse(key);if(!ref || typeof ref.sourceKey!=='string' || ref.sourceKey.length>512)return null;
  if(ref.kind==='day')return {kind:'day',sourceKey:ref.sourceKey};
  if(ref.kind==='major-returns' && isMainReturnBody(ref.family))return {kind:'major-returns',sourceKey:ref.sourceKey,family:ref.family};
 }catch{/* Card keys and damaged metadata are not numeric references. */}
 return null;
}
export interface LibraryUsage {id:string;openedAt:number;evicted?:true}
export interface LibraryInventory {
 lease:LibraryLease;
 cards:{id:string;revision:number}[];
 packages:{id:string;ref:Exclude<PackageRef,{kind:'card'}>;chartIds:string[];evicted:boolean;present:boolean}[];
 usage:LibraryUsage[];
}
export type LibraryAuditPhase='charts'|'packageMetadata'|'packages';
export interface LibraryAuditCursor {phase:LibraryAuditPhase;after?:string}
export interface LibraryAuditPage {checked:number;removed:number;next:LibraryAuditCursor|null}
export interface LibraryAuditCheckpoint {runId:string;cursor:LibraryAuditCursor|null;completedAt:number;lease?:{owner:string;expiresAt:number}}
export type LibraryCheckpointWrite='stored'|'superseded'|'stale'|'unavailable';
