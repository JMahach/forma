import type {SavedChart} from '../../shared/chart-types.ts';
export type LibraryListChart=SavedChart|LibraryCatalogEntry;
import {canonicalChartId,isChartIdentifier} from '../../shared/chart-record-contract.ts';
import {isLibraryCatalogMarker,type LibraryCatalogEntry,type LibraryCatalogSnapshot,type LibraryCatalogReply,type LibraryCatalogConfirmation} from '../../shared/library-catalog-contract.ts';
import {cardSourceKey} from '../../shared/library-package-contract.ts';
import {MAIN_RETURN_BODIES,isMainReturnBody} from '../../shared/chart-return-contract.ts';
import {utcMilliseconds} from '../../shared/utc-format.ts';

const object=(value:unknown):value is Record<string,unknown>=>!!value && typeof value==='object' && !Array.isArray(value);
const text=(value:unknown,max:number):value is string=>typeof value==='string' && value.length<=max;
const invalid=()=>new TypeError('invalid_catalog');
function sourcePair(value:unknown) {
 if(!text(value,512))throw invalid();
 const pair:unknown=JSON.parse(value);
 if(!Array.isArray(pair) || pair.length!==2 || !text(pair[0],40) || !text(pair[1],100) || !pair[1].trim()
  || JSON.stringify(pair)!==value)throw invalid();
 return pair as [string,string];
}
function packages(value:unknown,card:Omit<LibraryCatalogEntry,'packages'>):LibraryCatalogEntry['packages'] {
 if(!object(value) || !object(value.card) || value.card.kind!=='card' || value.card.sourceKey!==cardSourceKey(card))throw invalid();
 const ref={kind:'card' as const,sourceKey:value.card.sourceKey};
 if(card.source==='transit'){
  if(value.day!==null || value.majorReturns!==null)throw invalid();
  return {card:ref,day:null,majorReturns:null};
 }
 return {card:ref,...natalPackages(value,card.birthDate)};
}
function natalPackages(value:Record<string,unknown>,birthDate:string) {
 const {day,majorReturns}=value;
 if(!object(day) || !object(day.ref) || day.ref.kind!=='day' || typeof day.ready!=='boolean' || !object(majorReturns))throw invalid();
 const [date,zone]=sourcePair(day.ref.sourceKey),[utc,returnZone]=sourcePair(majorReturns.sourceKey);
 if(date!==birthDate || returnZone!==zone || !Number.isFinite(utcMilliseconds(utc)))throw invalid();
 return {day:{ref:{kind:'day' as const,sourceKey:day.ref.sourceKey as string},ready:day.ready},
  majorReturns:{sourceKey:majorReturns.sourceKey as string,readyFamilies:readyFamilies(majorReturns.readyFamilies)}};
}
function readyFamilies(bodies:unknown) {
 if(!Array.isArray(bodies) || bodies.length>MAIN_RETURN_BODIES.length || !bodies.every(isMainReturnBody)
  || new Set(bodies).size!==bodies.length)throw invalid();
 return MAIN_RETURN_BODIES.filter(body=>bodies.includes(body));
}
function identity(value:Record<string,unknown>) {
 if(!isChartIdentifier(value.id) || canonicalChartId(value.id)!==value.id
  || !Number.isSafeInteger(value.revision) || (value.revision as number)<1
  || !text(value.name,80) || !value.name.trim())throw invalid();
 return {id:value.id,revision:value.revision as number,name:value.name};
}
function birth(value:Record<string,unknown>):Pick<LibraryCatalogEntry,'source'|'birthDate'|'birthTime'> {
 if(value.source!=='calculated' && value.source!=='transit' || !text(value.birthDate,10) || !/^\d{4}-\d{2}-\d{2}$/.test(value.birthDate)
  || !Number.isFinite(utcMilliseconds(value.birthDate+'T00:00:00Z'))
  || !text(value.birthTime,5) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.birthTime))throw invalid();
 return {source:value.source,birthDate:value.birthDate,birthTime:value.birthTime};
}
/** Light navigation metadata only; no accepted record, calculation or offline proof is fabricated. */
export function validateLibraryCatalogEntry(value:unknown):LibraryCatalogEntry {
 if(!object(value))throw invalid();
 const card={...identity(value),...birth(value)};
 return {...card,packages:packages(value.packages,card)};
}
function state(value:unknown,accountId:string) {
 if(!object(value) || value.accountId!==accountId || !/^[1-9][0-9]{0,19}$/.test(accountId)
  || !isLibraryCatalogMarker(value.marker))throw invalid();
 return value as Record<string,unknown> & {accountId:string;marker:string};
}
function entries(value:unknown,after='') {
 if(!Array.isArray(value))throw invalid();
 const result:LibraryCatalogEntry[]=[];let prior=after;
 for(const item of value){const row=validateLibraryCatalogEntry(item);if(row.id<=prior)throw invalid();result.push(row);prior=row.id;}
 return result;
}
export function validateLibraryCatalogSnapshot(value:unknown,accountId:string):LibraryCatalogSnapshot {
 const row=state(value,accountId);return {accountId,marker:row.marker,entries:entries(row.entries)};
}
export interface CatalogQuery {knownMarker?:string;marker?:string;after?:string;limit?:number}
function page(value:Record<string,unknown> & {marker:string},query:CatalogQuery) {
 if(query.marker!==undefined && query.marker!==value.marker)throw invalid();
 const items=entries(value.entries,query.after),limit=query.limit??100;
 if(items.length>limit || value.nextCursor!==null && (items.length!==limit || value.nextCursor!==items.at(-1)?.id))throw invalid();
 return {kind:'page' as const,entries:items,nextCursor:value.nextCursor as string|null};
}
export function validateLibraryCatalogReply(value:unknown,accountId:string,query:CatalogQuery):LibraryCatalogReply {
 const row=state(value,accountId),base={accountId,marker:row.marker};
 if(row.kind==='restart')return {...base,kind:'restart'};
 if(row.kind==='unchanged'){
  if(query.knownMarker!==row.marker)throw invalid();
  return {...base,kind:'unchanged'};
 }
 if(row.kind!=='page')throw invalid();
 return {...base,...page(row,query)};
}
export function validateLibraryCatalogConfirmation(value:unknown,accountId:string,marker:string):LibraryCatalogConfirmation {
 const row=state(value,accountId);
 if(row.kind!=='restart' && (row.kind!=='confirmed' || row.marker!==marker))throw invalid();
 return {accountId,marker:row.marker,kind:row.kind as 'confirmed'|'restart'};
}
