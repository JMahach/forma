export const JOURNAL_POLICY = Object.freeze({
  maxBytes:500_000_000, retentionMs:30*86400000, maxEventBytes:16*1024,
  maxPendingBytes:1024*1024, maxPendingCount:1024, maxBatchBytes:256*1024,
  segmentBytes:256*1024, maintenanceMs:60_000,
});
export type JournalPolicy = {[Key in keyof typeof JOURNAL_POLICY]:number};
export type JournalResult = {status:'accepted';receivedAt:number;duplicate:boolean}
  | {status:'invalid'|'conflict'|'retryable';reason:string};
export interface JournalUsage {
  diskBytes:number; bufferReservedBytes:number; externalBytes:number;
}
export interface JournalWorkerData {
  directory:string;policy:JournalPolicy;now:number;externalReservedBytes:number;
}
export type JournalWorkerRequest = {kind:'batch';now:number;externalReservedBytes:number;
  entries:{id:number;bytes:ArrayBuffer}[]} | {kind:'maintain';now:number;externalReservedBytes:number};
export type JournalWorkerReply = {kind:'ready'|'maintained';usage:JournalUsage;more:boolean}
  | {kind:'batch';results:{id:number;result:JournalResult}[];usage:JournalUsage} | {kind:'failed'};
/** Overrides can tighten engineering limits; they cannot enlarge the agreed policy. */
export function journalPolicy(overrides: Partial<JournalPolicy> = {}): JournalPolicy {
  const policy={...JOURNAL_POLICY,...overrides};
  for (const key of Object.keys(JOURNAL_POLICY) as (keyof JournalPolicy)[]) {
    if (!Number.isSafeInteger(policy[key]) || policy[key]<=0 || policy[key]>JOURNAL_POLICY[key]) {
      throw new RangeError(`Invalid journal policy: ${key}`);
    }
  }
  if (policy.maxEventBytes+256>policy.segmentBytes || policy.maxEventBytes>policy.maxBatchBytes
    || policy.maxBatchBytes>policy.maxPendingBytes) throw new RangeError('Inconsistent journal buffer limits');
  return policy;
}
/** UTF-8 queue, transient strings/copies, batch/compaction buffers, small SQLite cache and bounded queue metadata. */
export function bufferReserve(policy: JournalPolicy) {
  return 4*policy.maxPendingBytes + 2*policy.maxBatchBytes + 2*policy.segmentBytes + 256*1024;
}
/** A segment replacement coexists with the original; the derivative index has no WAL/rollback journal. */
export function workspaceReserve(policy: JournalPolicy) { return policy.segmentBytes+64*1024; }
export function validReservedBytes(value: number) { return Number.isSafeInteger(value) && value>=0; }
export function canonicalJSON(value: Record<string,unknown>): string {
  const ordered=(input:unknown):unknown=>Array.isArray(input)?input.map(ordered)
    :input && typeof input==='object'
      ?Object.fromEntries(Object.keys(input).sort().map(key=>[key,ordered((input as Record<string,unknown>)[key])]))
      :input;
  return JSON.stringify(ordered(value));
}
