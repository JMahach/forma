import {validateLibraryCatalogSnapshot,validateLibraryCatalogEntry} from '../domain/library-catalog.ts';
import {isLibraryCatalogMarker} from '../../shared/library-catalog-contract.ts';
import {isChartIdentifier} from '../../shared/chart-record-contract.ts';
import type {ChartClient} from '../data/chart-client.ts';
import type {LibraryCatalogSnapshot,LibraryCatalogPage} from '../../shared/library-catalog-contract.ts';
import type {LibraryCatalogEntry} from '../../shared/library-catalog-contract.ts';
import type {AccountChart} from '../../shared/chart-record-contract.ts';
import type {LibraryLease} from '../data/account-library-store.ts';
import {cardSourceKey,natalDaySourceKey,returnSourceKey} from '../../shared/library-package-contract.ts';

type Client=Pick<ChartClient,'catalog'|'confirmCatalog'>;
export function libraryRecordEntry(chart:AccountChart,previous?:LibraryCatalogEntry):LibraryCatalogEntry {
 const {id,revision,name,source,birthDate,birthTime}=chart;
 const card={kind:'card' as const,sourceKey:cardSourceKey(chart)};
 const packages=source==='calculated'?{card,...recordPackages(chart,previous)}:{card,day:null,majorReturns:null};
 return {id,revision,name,source,birthDate,birthTime,packages};
}
function recordPackages(chart:AccountChart,previous?:LibraryCatalogEntry) {
 const timezone=chart.timezone||'UTC';
 const dayKey=natalDaySourceKey({date:chart.birthDate,timezone}),returnKey=returnSourceKey({birthUtc:chart.utc,timezone});
 const day=previous?.packages.day;
 const majorReturns=previous?.packages.majorReturns;
 return {
  day:day?.ref.sourceKey===dayKey?day:{ref:{kind:'day' as const,sourceKey:dayKey},ready:false},
  majorReturns:majorReturns?.sourceKey===returnKey?majorReturns:{sourceKey:returnKey,readyFamilies:[]},
 };
}
function retainEntries(rows:Iterable<LibraryCatalogEntry>,previous:readonly LibraryCatalogEntry[]) {
 const old=new Map(previous.map(row=>[row.id,row]));
 const next=[...rows].sort((a,b)=>a.id.localeCompare(b.id)).map(row=>{
  const prior=old.get(row.id);return prior && JSON.stringify(prior)===JSON.stringify(row)?prior:row;
 });
 return next.length===previous.length && next.every((row,index)=>row===previous[index])?previous:next;
}
/** Light list rows remain separate from complete records used by the chart and note editor. */
export function projectLibraryEntries(catalog:LibraryCatalogSnapshot|null,charts:readonly AccountChart[],previous:readonly LibraryCatalogEntry[]) {
 const rows=new Map(catalog?.entries.map(row=>[row.id,row]));
 for(const chart of charts){const row=rows.get(chart.id);if(!row || row.revision<chart.revision)rows.set(chart.id,libraryRecordEntry(chart,row));}
 return retainEntries(rows.values(),previous);
}
export type LibraryCatalogRead={status:'complete'|'unchanged';catalog:LibraryCatalogSnapshot}|{status:'unstable'};
async function finishWalk(client:Client,page:LibraryCatalogPage,signal:AbortSignal,limit:number):Promise<LibraryCatalogSnapshot|null> {
 const {accountId,marker}=page,entries=[...page.entries];let after=page.nextCursor;
 while(after){
  const next=await client.catalog({expectedAccountId:accountId,marker,after,limit},signal);signal.throwIfAborted();
  if(next.kind!=='page')return null;
  entries.push(...next.entries);after=next.nextCursor;
 }
 const confirmation=await client.confirmCatalog({expectedAccountId:accountId,marker},signal);signal.throwIfAborted();
 return confirmation.kind==='confirmed'?{accountId,marker,entries}:null;
}
/** A bounded, staged read. No partial page can authorize deletion or publish a marker. */
export async function readCompleteLibraryCatalog(client:Client,accountId:string,known:LibraryCatalogSnapshot|null,
 signal:AbortSignal,limit=100):Promise<LibraryCatalogRead> {
 for(let attempt=0;attempt<2;attempt++){
  signal.throwIfAborted();
  const page=await client.catalog({expectedAccountId:accountId,limit,...(known?{knownMarker:known.marker}:{})},signal);
  signal.throwIfAborted();
  if(page.kind==='unchanged' && known)return {status:'unchanged',catalog:known};
  if(page.kind!=='page')continue;
  const catalog=await finishWalk(client,page,signal,limit);
  if(catalog)return {status:'complete',catalog};
 }
 return {status:'unstable'};
}

export interface LibrarySession {accountId:string;sessionId:string}
export type LibraryNotice={kind:'changed'}|({accountId:string;sessionId:string;durable:boolean} & (
 {kind:'catalog';catalog:LibraryCatalogSnapshot}|{kind:'record';marker:string;entry:LibraryCatalogEntry}|{kind:'removed';marker:string;chartId:string}));
export function sameLibrarySession(a:LibrarySession|null,b:LibrarySession|null) {
 return a?.accountId===b?.accountId && a?.sessionId===b?.sessionId;
}
export function sameWorkingLease(a:LibraryLease|null,b:LibraryLease|null) {
 return !!a && !!b && a.accountId===b.accountId && a.generation===b.generation;
}
export function catalogIsOlder(candidate:LibraryCatalogSnapshot|null|undefined,reference:LibraryCatalogSnapshot|null|undefined) {
 return BigInt(candidate?.marker??'0')<BigInt(reference?.marker??'0');
}
function retainedRecord(prior:AccountChart|undefined,chart:AccountChart) {
 if(prior?.accountId!==chart.accountId)return chart;
 return prior.revision>chart.revision || prior.revision===chart.revision && prior.noteRevision===chart.noteRevision
  && prior.publicRevision===chart.publicRevision?prior:chart;
}
export function mergeLibraryRecords(previous:readonly AccountChart[],stored:readonly AccountChart[],pending:ReadonlyMap<string,unknown>,
 retainMissing:boolean,present:ReadonlySet<string>|null) {
 const old=new Map(previous.map(chart=>[chart.id,chart]));
 const next=new Map(stored.filter(chart=>!pending.has(chart.id)).map(chart=>[chart.id,retainedRecord(old.get(chart.id),chart)]));
 if(retainMissing)for(const chart of previous) {
  if(!pending.has(chart.id) && (!present || present.has(chart.id)) && !next.has(chart.id))next.set(chart.id,chart);
 }
 return [...next.values()];
}

function noticePayload(row:Record<string,unknown>,accountId:string) {
 if(row.kind==='catalog')return {kind:'catalog' as const,catalog:validateLibraryCatalogSnapshot(row.catalog,accountId)};
 if(!isLibraryCatalogMarker(row.marker))return null;
 if(row.kind==='record')return {kind:'record' as const,marker:row.marker,entry:validateLibraryCatalogEntry(row.entry)};
 if(row.kind==='removed' && isChartIdentifier(row.chartId))return {kind:'removed' as const,marker:row.marker,chartId:row.chartId};
 return null;
}
export function parseLibraryNotice(value:unknown,session:LibrarySession|null):LibraryNotice|null {
 if(!value || typeof value!=='object')return null;
 const row=value as Record<string,unknown>;
 if(row.kind==='changed')return {kind:'changed'};
 if(!session || !sameLibrarySession(row as unknown as LibrarySession,session) || typeof row.durable!=='boolean')return null;
 try{const payload=noticePayload(row,session.accountId);return payload?{...session,durable:row.durable,...payload}:null;}catch{return null;}
}
