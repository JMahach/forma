import {parseJournalEvent,type JournalEvent} from './events.ts';
import {JOURNAL_POLICY,type JournalResult} from './policy.ts';

export interface WriterUsage {
 ready:boolean;diskBytes:number|null;externalBytes:number|null;
 bufferReservedBytes:number;pendingBytes:number;pendingCount:number;
}
/** Local and remote writers expose the same receipt; transport never owns the archive. */
export interface JournalWriterPort {
 write(event:JournalEvent):Promise<JournalResult>;
 usage():Promise<WriterUsage>;
 drain():Promise<void>;
 close():Promise<void>;
}
export type WriterCommand={kind:'write';event:JournalEvent}|{kind:'usage'};
export const WRITER_FRAME_BYTES=JOURNAL_POLICY.maxEventBytes+1024;
export const WRITER_REPLY_BYTES=1024;
export const WRITER_DEADLINE_MS=1000;
function record(value:unknown):value is Record<string,unknown> {
 return !!value && typeof value==='object' && !Array.isArray(value);
}
function unsigned(value:unknown):value is number {return Number.isSafeInteger(value) && (value as number)>=0;}
function receipt(value:Record<string,unknown>):JournalResult|null {
 if(Object.keys(value).length!==3 || !unsigned(value.receivedAt) || typeof value.duplicate!=='boolean')return null;
 return {status:'accepted',receivedAt:value.receivedAt,duplicate:value.duplicate};
}
export function readWriterCommand(value:unknown):WriterCommand|null {
 if(!record(value))return null;
 const keys=Object.keys(value);
 if(value.kind==='usage' && keys.length===1)return {kind:'usage'};
 if(value.kind!=='write' || keys.length!==2 || !keys.includes('event'))return null;
 const event=parseJournalEvent(value.event);
 return event?{kind:'write',event}:null;
}
export function readWriterResult(value:unknown):JournalResult|null {
 if(!record(value))return null;
 if(value.status==='accepted')return receipt(value);
 if(!['invalid','conflict','retryable'].includes(value.status as string) || Object.keys(value).length!==2)return null;
 return typeof value.reason==='string' && /^[a-z_]{1,80}$/.test(value.reason)?value as JournalResult:null;
}
export function readWriterUsage(value:unknown):WriterUsage|null {
 if(!record(value) || Object.keys(value).length!==6 || typeof value.ready!=='boolean')return null;
 for(const key of ['diskBytes','externalBytes'])if(value[key]!==null && !unsigned(value[key]))return null;
 for(const key of ['bufferReservedBytes','pendingBytes','pendingCount'])if(!unsigned(value[key]))return null;
 return value as unknown as WriterUsage;
}
