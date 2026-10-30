/** Check identity is separate from card content and calculation identity. */
export type CheckScope={kind:'app'}|{kind:'library';accountId:string}|{kind:'public';chartId:string};
export interface CheckTarget {key:string;scope:CheckScope;sessionId?:string;instance?:string}
export interface CheckRecord {
 target:CheckTarget;lastAttemptAt:number;lastSuccessAt:number|null;nextDueAt:number;retryNotBefore:number;
 blockedSessionId?:string;permit?:CheckPermit;
}
export interface CheckPermit {key:string;token:string;owner:string;startedAt:number;expiresAt:number;sessionId?:string}
export interface BackgroundLeader {owner:string;token:string;expiresAt:number}
export interface BackgroundControl {leader:BackgroundLeader|null;checks:Record<string,CheckRecord>}
export interface BackgroundStore {
 read():Promise<BackgroundControl|null>;
 update<T>(change:(control:BackgroundControl)=>T):Promise<T|null>;
}
/** The storage proof and the local cancellation both remain valid until acceptance. */
export interface CheckAuthority {
 permit:CheckPermit;signal:AbortSignal;
 current():Promise<boolean>;
}
export type CheckOutcome={kind:'success';checkedAt?:number}|{kind:'failed';retryAfterMs?:number}|{kind:'unauthorized'}|{kind:'cancelled'};
export type CheckReason='lifecycle'|'hourly'|'changed';
