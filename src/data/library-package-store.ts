import {TransactionPlacement,replaceAfterQuota,type PlacementProgress} from './library-package-placement.ts';
import type {StoragePressure} from './storage-pressure.ts';
import type {AccountChart} from '../../shared/chart-record-contract.ts';
import {natalDaySourceKey,returnSourceKey,validMajorReturnsPackage,type PackageRef,type MajorReturnsPackage} from '../../shared/library-package-contract.ts';
import {decodeNatalDay} from '../../shared/day-packets/decode.ts';
import {sameLibraryLease,type LibraryLease,type LibraryPackageMetadata} from './account-library-schema.ts';
import type {createIndexedDatabase} from './indexed-db.ts';

export type LibraryPartRef=Exclude<PackageRef,{kind:'card'}>;
export type LibraryPackageWrite='stored'|'no-op'|'stale'|'invalid'|'quota'|'unavailable';
type Database=Pick<ReturnType<typeof createIndexedDatabase>,'transactionResult'|'transaction'>;
export const libraryPackageId=(ref:LibraryPartRef)=>JSON.stringify(ref.kind==='day'
 ?{kind:ref.kind,sourceKey:ref.sourceKey}:{kind:ref.kind,sourceKey:ref.sourceKey,family:ref.family});

function matchesChart(ref:LibraryPartRef,chart:AccountChart) {
 return chart.source==='calculated' && (ref.kind==='day'
  ?ref.sourceKey===natalDaySourceKey({date:chart.birthDate,timezone:chart.timezone||'UTC'})
  :ref.sourceKey===returnSourceKey({birthUtc:chart.utc,timezone:chart.timezone||'UTC'}));
}
export function validLibraryPayload(ref:LibraryPartRef,payload:unknown):payload is ArrayBuffer|MajorReturnsPackage {
 try {
  if(ref.kind==='major-returns')return validMajorReturnsPackage(ref,payload);
  const day=decodeNatalDay(payload);
  return payload instanceof ArrayBuffer && natalDaySourceKey(day)===ref.sourceKey;
 }catch{return false;}
}

/** Links belong to explicit record identity. Removing one never removes another card's numbers. */
export function unlinkLibraryPackages(tx:IDBTransaction,chartId:string,replacement?:AccountChart) {
 const metadata=tx.objectStore('packageMetadata'),cursor=metadata.index('cards').openCursor(chartId);
 cursor.onsuccess=()=>{
  const entry=cursor.result;if(!entry)return;
  const row=entry.value as LibraryPackageMetadata;
  if(!replacement || !matchesChart(row.ref,replacement)) {
   const chartIds=row.chartIds.filter(id=>id!==chartId);
   if(chartIds.length)entry.update({...row,chartIds});
   else {entry.delete();tx.objectStore('packages').delete(row.id);tx.objectStore('usage').delete(row.id);}
  }
  entry.continue();
 };
}

export function linkLibraryPackages(tx:IDBTransaction,chart:AccountChart) {
 if(chart.source!=='calculated')return;
 const metadata=tx.objectStore('packageMetadata');
 for(const sourceKey of [natalDaySourceKey({date:chart.birthDate,timezone:chart.timezone||'UTC'}),
  returnSourceKey({birthUtc:chart.utc,timezone:chart.timezone||'UTC'})]) {
  const read=metadata.index('source').openCursor(sourceKey);read.onsuccess=()=>{
   const cursor=read.result;if(!cursor)return;const row=cursor.value as LibraryPackageMetadata;
   if(!row.chartIds.includes(chart.id))cursor.update({...row,chartIds:[...row.chartIds,chart.id]});
   cursor.continue();
  };
 }
}

// Only confirmed damage starts a write. Recheck inside that transaction so a
// replacement from another tab cannot be removed after our earlier read.
function discardBrokenPackage(database:Database,seen:LibraryLease,ref:LibraryPartRef) {
 return database.transaction('readwrite',(tx)=>{
  const owner=tx.objectStore('context').get('owner');owner.onsuccess=()=>{
   if(!sameLibraryLease(owner.result,seen))return;
   const rows=tx.objectStore('packages'),id=libraryPackageId(ref),read=rows.get(id);read.onsuccess=()=>{
    if(!read.result || validLibraryPayload(ref,read.result.payload))return;
    rows.delete(id);tx.objectStore('packageMetadata').delete(id);tx.objectStore('usage').delete(id);
   };
  };
 });
}

interface IncomingPackage {
 seen:LibraryLease;chart:AccountChart;ref:LibraryPartRef;id:string;payload:unknown;
 openedAt:number|undefined;isCurrent:()=>boolean;needsPayload:boolean;
}

class LibraryPackageOwner {
 private database:Database;
 private pressure:StoragePressure|undefined;
 private now:()=>number;
 constructor(database:Database,pressure:StoragePressure|undefined,now:()=>number) {
  this.database=database;this.pressure=pressure;this.now=now;
 }
 private async read(seen:LibraryLease,ref:LibraryPartRef,openedAt?:number) {
  const id=libraryPackageId(ref);let validated=false;
  const result=await this.database.transaction<{payload:ArrayBuffer|MajorReturnsPackage|null;broken:boolean}>(openedAt===undefined?'readonly':'readwrite',(tx,done,fail)=>{
   const owner=tx.objectStore('context').get('owner');owner.onsuccess=()=>{
    if(!sameLibraryLease(owner.result,seen))return;
    const row=tx.objectStore('packages').get(id);row.onsuccess=()=>{
     const payload:unknown=row.result?.payload,valid=validLibraryPayload(ref,payload);validated=valid;
     try {if(validated && openedAt!==undefined)tx.objectStore('usage').put({id,openedAt});}catch(error){fail(error);return;}
     done({payload:valid?payload:null,broken:!!row.result && !validated});
    };
   };
  });
  return {result,validated};
 }
 async readPackage(seen:LibraryLease,ref:LibraryPartRef,{opened=false}:{opened?:boolean}={}) {
  seen={...seen};ref={...ref};
  let {result,validated}=await this.read(seen,ref,opened?Math.max(1,this.now()):undefined);
  // A failed use mark must not hide numbers. Obtain fresh read-only proof once.
  if(!result && validated && opened)({result}=await this.read(seen,ref));
  if(result?.broken)await discardBrokenPackage(this.database,seen,ref);
  return result?.payload??null;
 }
 async touchPackage(seen:LibraryLease,ref:LibraryPartRef):Promise<boolean> {
  seen={...seen};const id=libraryPackageId(ref),openedAt=Math.max(1,this.now());
  return await this.database.transaction<boolean>('readwrite',(tx,done,fail)=>{
   const owner=tx.objectStore('context').get('owner');owner.onsuccess=()=>{
    if(!sameLibraryLease(owner.result,seen)){done(false);return;}
    const present=tx.objectStore('packages').getKey(id);present.onsuccess=()=>{
     if(present.result===undefined){done(false);return;}
     try{tx.objectStore('usage').put({id,openedAt});done(true);}catch(error){fail(error);}
    };
   };
  })??false;
 }
 private writePackage(tx:IDBTransaction,input:IncomingPackage,prior:LibraryPackageMetadata|undefined,
  chartIds:string[],limit:number,done:(value:LibraryPackageWrite)=>void,fail:(cause?:unknown)=>void,
  progress:PlacementProgress={released:0,remaining:false,ready:false}) {
  const {id,ref,payload,openedAt,isCurrent}=input;
  const linked=prior && !prior.evicted && chartIds.every(id=>prior.chartIds.includes(id));
  const placement=new TransactionPlacement(tx,{id,kind:ref.kind,chartIds,openedAt},input.needsPayload?limit:0,isCurrent,fail,progress);
  const finish=()=>{progress.ready=true;done(linked && !input.needsPayload?'no-op':'stored');};
  const saveUse=()=>openedAt===undefined?finish():placement.write(()=>tx.objectStore('usage').put({id,openedAt}),finish);
  const saveLink=()=>linked?saveUse():placement.write(()=>tx.objectStore('packageMetadata').put({id,ref,chartIds}),saveUse);
  placement.start(()=>input.needsPayload?placement.write(()=>tx.objectStore('packages').put({id,payload}),saveLink):saveLink());
 }
 private attempt(input:IncomingPackage,limit:number,progress?:PlacementProgress) {
  const {seen,chart,ref,id,isCurrent}=input;
  return this.database.transactionResult<LibraryPackageWrite>('readwrite',(tx,done,fail)=>{
   const owner=tx.objectStore('context').get('owner');owner.onsuccess=()=>{
    if(!sameLibraryLease(owner.result,seen) || !isCurrent()){done('stale');return;}
    const card=tx.objectStore('charts').index('recordSource').getKey([chart.id,chart.revision,chart.birthDate,chart.timezone||'UTC',chart.utc]);
    card.onsuccess=()=>{
     if(!card.result){done('stale');return;}
     const prior=tx.objectStore('packageMetadata').get(id);
     const payload=tx.objectStore('packages').getKey(id);
     const source=ref.kind==='day'?chart.birthDate:chart.utc;
     const related=tx.objectStore('charts').index(ref.kind==='day'?'natalDay':'returnSource').getAllKeys(['calculated',source,chart.timezone||'UTC']);
     related.onsuccess=()=>{
      input.needsPayload=payload.result===undefined;
      this.writePackage(tx,input,prior.result,related.result.map(String),limit,done,fail,progress);
     };
    };
   };
  });
 }
 private async place(input:IncomingPackage):Promise<LibraryPackageWrite> {
  const first=()=>this.attempt(input,0);
  let result=this.pressure?await this.pressure.write(first,{atomicLibrary:true}):await first();
  if(result.status==='quota' && input.needsPayload && input.isCurrent())
   result=await replaceAfterQuota((limit,progress)=>this.attempt(input,limit,progress));
  return result.status==='complete'?result.value??'unavailable':result.status;
 }
 async putPackage(seen:LibraryLease,chart:AccountChart,ref:LibraryPartRef,payload:unknown,{opened=false}:{opened?:boolean}={}):Promise<LibraryPackageWrite> {
  seen={...seen};chart={...chart};ref={...ref};
  const isCurrent=this.pressure?.capture()??(()=>true);
  if(chart.accountId!==seen.accountId || !matchesChart(ref,chart) || !validLibraryPayload(ref,payload))return 'invalid';
  return this.place({seen,chart,ref,id:libraryPackageId(ref),payload:structuredClone(payload),
   openedAt:opened?Math.max(1,this.now()):undefined,isCurrent,needsPayload:true});
 }
}

/** Private facade over the account owner's transaction, never a second database. */
export function createLibraryPackageStore(database:Database,{pressure,now=Date.now}:{pressure?:StoragePressure;now?:()=>number}={}) {
 const owner=new LibraryPackageOwner(database,pressure,now);
 return {readPackage:owner.readPackage.bind(owner),putPackage:owner.putPackage.bind(owner),touchPackage:owner.touchPackage.bind(owner)};
}
