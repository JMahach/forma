import { randomUUID } from 'node:crypto';
import { completeJournalEvent, type JournalEvent } from './events.ts';
export interface JournalReportOptions {
 environment: JournalEvent['environment']; now?:()=>number;
 write:(event:JournalEvent)=>Promise<{status:'accepted'|'invalid'|'conflict'|'retryable'}>;
}
/** Journal failure never changes the result of a completed business action. */
export function createServerReporter({environment,write,now=Date.now}:JournalReportOptions) {
 return async(fact:unknown):Promise<boolean>=>{
  try {
   // Sources with their own stable ID/time keep them. Auth transitions have a
   // unique context; other one-off facts receive a random event ID here.
   const record:Record<string,PropertyDescriptor>=fact && typeof fact==='object' ? Object.getOwnPropertyDescriptors(fact) : {};
   const name=record.event?.value, context=record.contextId?.value;
   const eventId=(name==='auth_login' || name==='auth_logout') && typeof context==='string'
    ? name+':'+context : randomUUID();
   const event=completeJournalEvent(fact,{environment,occurredAt:now(),eventId});
   return !!event && (await write(event)).status==='accepted';
  } catch { return false; }
 };
}

export type { ServerFailureReport, HttpFailureComponent } from './events.ts';
import type { ServerFailure, ServerFailureReport } from './events.ts';

/** Sources pass controlled facts only; exceptions, requests and paths never reach the writer. */
export function reportServerFailure(report: ServerFailureReport | undefined, fact: ServerFailure): void {
 try { void Promise.resolve(report?.({...fact, occurredAt: Date.now()})).catch(() => {}); }
 catch { /* A broken journal cannot replace the original outcome. */ }
}
