import {validateAccountChart} from '../domain/account-chart.ts';
import type {LibraryLease,LibraryInventory,LibraryUsage,LibraryAuditCursor,LibraryAuditPage,LibraryAuditCheckpoint,LibraryCheckpointWrite} from '../domain/library-maintenance.ts';
import {sameLibraryLease,type LibraryPackageMetadata} from './account-library-schema.ts';
import {libraryPackageId,validLibraryPayload,unlinkLibraryPackages} from './library-package-store.ts';
import type {createIndexedDatabase} from './indexed-db.ts';
import {isMainReturnBody} from '../../shared/chart-return-contract.ts';

type Database=Pick<ReturnType<typeof createIndexedDatabase>,'transaction'>;
const AUDIT='library-audit';
const object=(value:unknown):value is Record<string,unknown>=>!!value && typeof value==='object' && !Array.isArray(value);
const time=(value:unknown):value is number=>typeof value==='number' && Number.isSafeInteger(value) && value>=0;
function packageRef(value:unknown):value is LibraryPackageMetadata['ref'] {
 return object(value) && typeof value.sourceKey==='string'
  && (value.kind==='day' || value.kind==='major-returns' && isMainReturnBody(value.family));
}
function linkedIds(value:unknown):value is string[]{return Array.isArray(value) && value.length>0 && value.every(id=>typeof id==='string');}
function metadata(value:unknown):value is LibraryPackageMetadata {
 if(!object(value) || typeof value.id!=='string' || !packageRef(value.ref) || !linkedIds(value.chartIds))return false;
 if(value.evicted!==undefined && value.evicted!==true)return false;
 return libraryPackageId(value.ref)===value.id;
}
function usages(rows:unknown[]):LibraryUsage[]{
 return rows.flatMap(row=>object(row) && typeof row.id==='string' && time(row.openedAt)
  ?[{id:row.id,openedAt:row.openedAt,...(row.evicted===true?{evicted:true as const}:{})}]:[]);
}
function validCursor(value:unknown):value is LibraryAuditCursor|null {
 return value===null || object(value) && ['charts','packageMetadata','packages'].includes(String(value.phase))
  && (value.after===undefined || typeof value.after==='string');
}
function validAuditLease(value:unknown):value is LibraryAuditCheckpoint['lease'] {
 return value===undefined || object(value) && typeof value.owner==='string' && !!value.owner && time(value.expiresAt);
}
function checkpoint(value:unknown):LibraryAuditCheckpoint|null {
 if(!object(value) || typeof value.runId!=='string' || !value.runId || !time(value.completedAt) || !validCursor(value.cursor))return null;
 if(!validAuditLease(value.lease))return null;
 return {runId:value.runId,cursor:value.cursor?{...value.cursor}:null,completedAt:value.completedAt,...(value.lease?{lease:{owner:value.lease.owner as string,expiresAt:value.lease.expiresAt as number}}:{})};
}
function guardTransaction(tx:IDBTransaction,signal?:AbortSignal):boolean {
 if(!signal)return true;
 const abort=()=>{try{tx.abort();}catch{/* The transaction has already settled. */}};
 if(signal.aborted){abort();return false;}
 const clean=()=>signal.removeEventListener('abort',abort);
 signal.addEventListener('abort',abort,{once:true});
 tx.addEventListener('complete',clean,{once:true});tx.addEventListener('abort',clean,{once:true});return true;
}
function owned<T>(database:Database,seen:LibraryLease,mode:IDBTransactionMode,work:(tx:IDBTransaction,done:(value:T)=>void)=>void,signal?:AbortSignal):Promise<T|null> {
 return database.transaction<T>(mode,(tx,done)=>{if(!guardTransaction(tx,signal))return;const owner=tx.objectStore('context').get('owner');
  owner.onsuccess=()=>{if(sameLibraryLease(owner.result,seen))work(tx,done);};
 });
}
function readInventory(tx:IDBTransaction,seen:LibraryLease,done:(value:LibraryInventory)=>void) {
 const cards:LibraryInventory['cards']=[],index=tx.objectStore('charts').index('recordRevision').openKeyCursor();
 index.onsuccess=()=>{const row=index.result;if(!row)return;
  const [id,revision]=row.key as [string,number];if(typeof id==='string' && time(revision) && revision>0)cards.push({id,revision});row.continue();};
 // The database resolves only after all cursor requests finish in this transaction.
 const keys=tx.objectStore('packages').getAllKeys(),parts=tx.objectStore('packageMetadata').getAll(),usage=tx.objectStore('usage').getAll();
 usage.onsuccess=()=>{
  const present=new Set(keys.result.map(String));
  done({lease:{...seen},cards,packages:parts.result.filter(metadata).map(row=>({id:row.id,ref:row.ref,chartIds:row.chartIds,
   evicted:row.evicted===true,present:present.has(row.id)})),usage:usages(usage.result)});
 };
}
function removePackage(tx:IDBTransaction,id:IDBValidKey) {
 tx.objectStore('packages').delete(id);tx.objectStore('packageMetadata').delete(id);tx.objectStore('usage').delete(id);
}
function auditCard(tx:IDBTransaction,key:IDBValidKey,value:unknown,seen:LibraryLease,done:(removed:boolean)=>void) {
 try{const chart=validateAccountChart(value,seen.accountId);if(chart.id!==key)throw Error('identity');done(false);}
 catch{tx.objectStore('charts').delete(key);if(typeof key==='string')unlinkLibraryPackages(tx,key);done(true);}
}
function matchingKeys(tx:IDBTransaction,ref:LibraryPackageMetadata['ref']):IDBRequest<IDBValidKey[]>|null {
 try{
  const source:unknown=JSON.parse(ref.sourceKey);if(!Array.isArray(source) || source.length!==2 || !source.every(value=>typeof value==='string'))return null;
  return tx.objectStore('charts').index(ref.kind==='day'?'natalDay':'returnSource').getAllKeys(['calculated',...source]);
 }catch{return null;}
}
function retainLinks(tx:IDBTransaction,row:LibraryPackageMetadata,retained:string[],done:(removed:boolean)=>void) {
 if(!retained.length){removePackage(tx,row.id);done(true);return;}
 if(retained.length!==row.chartIds.length)tx.objectStore('packageMetadata').put({...row,chartIds:retained});
 done(false);
}
function keepLink(tx:IDBTransaction,id:string,matching:Set<string>,done:(keep:boolean)=>void) {
 if(matching.has(id)){done(true);return;}
 const present=tx.objectStore('charts').getKey(id),use=tx.objectStore('usage').get(id);
 use.onsuccess=()=>done(present.result===undefined && use.result?.evicted===true);
}
function auditLinks(tx:IDBTransaction,row:LibraryPackageMetadata,done:(removed:boolean)=>void) {
 const matching=matchingKeys(tx,row.ref);if(!matching){removePackage(tx,row.id);done(true);return;}
 matching.onsuccess=()=>{
  const matchingIds=new Set(matching.result.map(String)),retained:string[]=[],ids=[...new Set(row.chartIds)];
  let pending=ids.length;
  for(const id of ids)keepLink(tx,id,matchingIds,keep=>{
   if(keep)retained.push(id);
   if(!--pending)retainLinks(tx,row,retained,done);
  });
 };
}
function auditMetadata(tx:IDBTransaction,key:IDBValidKey,value:unknown,done:(removed:boolean)=>void) {
 if(!metadata(value) || value.id!==key){removePackage(tx,key);done(true);return;}
 const row=value,read=tx.objectStore('packages').get(row.id);
 read.onsuccess=()=>{
  if(row.evicted){if(read.result)tx.objectStore('packages').delete(row.id);auditLinks(tx,row,done);return;}
  if(!validLibraryPayload(row.ref,read.result?.payload)){removePackage(tx,row.id);done(true);return;}
  auditLinks(tx,row,done);
 };
}
function auditEntry(tx:IDBTransaction,phase:LibraryAuditCursor['phase'],key:IDBValidKey,seen:LibraryLease,done:(removed:boolean)=>void) {
 if(phase==='packages') {
  const ref=tx.objectStore('packageMetadata').getKey(key);ref.onsuccess=()=>{const orphan=ref.result===undefined;if(orphan)tx.objectStore('packages').delete(key);done(orphan);};return;
 }
 const read=tx.objectStore(phase).get(key);read.onsuccess=()=>phase==='charts'?auditCard(tx,key,read.result,seen,done):auditMetadata(tx,key,read.result,done);
}
const nextPhase=(phase:LibraryAuditCursor['phase']):LibraryAuditCursor|null=>phase==='charts'?{phase:'packageMetadata'}:phase==='packageMetadata'?{phase:'packages'}:null;
class AuditWalk {
 private result:LibraryAuditPage;
 private tx:IDBTransaction;private seen:LibraryLease;private limit:number;private done:(value:LibraryAuditPage)=>void;
 constructor(tx:IDBTransaction,seen:LibraryLease,limit:number,done:(value:LibraryAuditPage)=>void,start:LibraryAuditCursor){
  this.tx=tx;this.seen=seen;this.limit=limit;this.done=done;this.result={checked:0,removed:0,next:start};
 }
 private finishPhase(position:LibraryAuditCursor){
  const next=nextPhase(position.phase);if(next){this.scan(next);return;}
  this.result.next=null;this.done(this.result);
 }
 private visit(position:LibraryAuditCursor,row:IDBCursor){
  auditEntry(this.tx,position.phase,row.primaryKey,this.seen,removed=>{
   this.result.checked++;if(removed)this.result.removed++;
   const after=typeof row.key==='string'?row.key:position.after;this.result.next={phase:position.phase,...(after===undefined?{}:{after})};
   if(this.result.checked>=this.limit){this.done(this.result);return;}row.continue();
  });
 }
 scan(position:LibraryAuditCursor){
  const request=this.tx.objectStore(position.phase).openKeyCursor();request.onsuccess=()=>{
   const row=request.result;if(!row){this.finishPhase(position);return;}
   if(position.after!==undefined && typeof row.key==='string' && row.key<=position.after){row.key<position.after?row.continue(position.after):row.continue();return;}
   this.visit(position,row);
  };
 }
}
/** Small cursored reads use the same account transaction; no second library or cached readiness. */
class LibraryMaintenanceStore {
 private database:Database;
 constructor(database:Database){this.database=database;}
  inventory(seen:LibraryLease){seen={...seen};return owned(this.database,seen,'readonly',(tx,done:(value:LibraryInventory)=>void)=>readInventory(tx,seen,done));}
  auditPage(seen:LibraryLease,cursor:LibraryAuditCursor|null,limit=16,signal?:AbortSignal,expectedAudit?:LibraryAuditCheckpoint):Promise<LibraryAuditPage|null> {
   if(!validCursor(cursor) || !Number.isInteger(limit) || limit<1 || limit>100)throw new TypeError('Invalid audit page');
   seen={...seen};const position=cursor?{...cursor}:{phase:'charts' as const};
   return owned(this.database,seen,'readwrite',(tx,done)=>{
    const scan=()=>new AuditWalk(tx,seen,limit,done,position).scan(position);
    if(expectedAudit===undefined){scan();return;}
    const read=tx.objectStore('context').get(AUDIT);read.onsuccess=()=>{
     if(sameLibraryLease(read.result,seen) && JSON.stringify(checkpoint(read.result.value))===JSON.stringify(expectedAudit))scan();
    };
   },signal);
  }
  readAuditCheckpoint(seen:LibraryLease):Promise<LibraryAuditCheckpoint|null> {
   seen={...seen};return owned<LibraryAuditCheckpoint|null>(this.database,seen,'readonly',(tx,done)=>{const read=tx.objectStore('context').get(AUDIT);
    read.onsuccess=()=>done(sameLibraryLease(read.result,seen)?checkpoint(read.result.value):null);});
  }
  saveAuditCheckpoint(seen:LibraryLease,expected:LibraryAuditCheckpoint|null,next:LibraryAuditCheckpoint,signal?:AbortSignal):Promise<LibraryCheckpointWrite> {
   seen={...seen};expected=expected?checkpoint(expected):null;const value=checkpoint(next);if(!value)throw new TypeError('Invalid audit checkpoint');
   return this.database.transaction<LibraryCheckpointWrite>('readwrite',(tx,done)=>{
    if(!guardTransaction(tx,signal))return;
    const rows=tx.objectStore('context'),owner=rows.get('owner');owner.onsuccess=()=>{
     if(!sameLibraryLease(owner.result,seen)){done('stale');return;}
     const read=rows.get(AUDIT);read.onsuccess=()=>{
      const prior=sameLibraryLease(read.result,seen)?checkpoint(read.result.value):null;
      if(JSON.stringify(prior)!==JSON.stringify(expected)){done('superseded');return;}
      if(JSON.stringify(prior)!==JSON.stringify(value))rows.put({key:AUDIT,...seen,value});done('stored');
     };
    };
   }).then(value=>value??'unavailable');
  }
}
export function createLibraryMaintenanceStore(database:Database) {
 const store=new LibraryMaintenanceStore(database);
 return {inventory:store.inventory.bind(store),auditPage:store.auditPage.bind(store),
  readAuditCheckpoint:store.readAuditCheckpoint.bind(store),saveAuditCheckpoint:store.saveAuditCheckpoint.bind(store)};
}
