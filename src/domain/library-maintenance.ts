import type {PackageRef} from '../../shared/library-package-contract.ts';

export interface LibraryLease {accountId:string;generation:string}
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
export interface LibraryAuditCheckpoint {runId:string;cursor:LibraryAuditCursor|null;completedAt:number}
export type LibraryCheckpointWrite='stored'|'superseded'|'stale'|'unavailable';
