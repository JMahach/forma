import {isLibraryCatalogMarker} from '../../shared/library-catalog-contract.ts';
import type {LibraryCatalogSnapshot} from '../../shared/library-catalog-contract.ts';
import {validateLibraryCatalogSnapshot} from '../domain/library-catalog.ts';
import {createRandomId} from '../domain/chart-record.ts';
import {readLibraryLease,sameLibraryLease,type LibraryLease} from './account-library-schema.ts';
import {unlinkLibraryPackages} from './library-package-store.ts';
import type {createIndexedDatabase} from './indexed-db.ts';
import type {BackgroundControl,CheckAuthority} from '../domain/background-check.ts';
import {BACKGROUND_CHECK_KEY,backgroundAuthorityCurrent,backgroundPermitCurrent,readBackgroundControl} from './background-check-store.ts';

type Database=Pick<ReturnType<typeof createIndexedDatabase>,'transaction'>;
export interface LibraryCatalogBase {lease:LibraryLease;mutation:string|null;minimumMarker?:string;catalog:LibraryCatalogSnapshot|null}
export type LibraryCatalogWrite={status:'stored';lease:LibraryLease;removed:string[]}
 | {status:'stale'|'superseded'|'unavailable'};
const mutation=(value:{mutation?:unknown})=>typeof value.mutation==='string'?value.mutation:null;
export function readStoredLibraryCatalog(value:unknown,accountId:string) {
 try{return validateLibraryCatalogSnapshot(value,accountId);}catch{return null;}
}
export function libraryMarker(value:unknown):string {return isLibraryCatalogMarker(value)?value:'0';}
export function newerLibraryMarker(a:unknown,b:unknown):string {
 const left=libraryMarker(a),right=libraryMarker(b);return BigInt(left)>BigInt(right)?left:right;
}
function admission(owner:Record<string,unknown>,prior:unknown,base:LibraryCatalogBase,snapshot:LibraryCatalogSnapshot) {
 if(!sameLibraryLease(owner,base.lease))return 'stale';
 if(mutation(owner)!==base.mutation || BigInt(libraryMarker(owner.catalogMarker))>BigInt(snapshot.marker))return 'superseded';
 const previous=readStoredLibraryCatalog(prior,base.lease.accountId);
 if(previous && BigInt(previous.marker)>BigInt(snapshot.marker))return 'superseded';
 return previous?.marker===snapshot.marker && (prior as {complete?:boolean}).complete!==false?'same':'replace';
}
/** Only accepted changes to card content fence a catalogue walk; use marks and numeric packages do not. */
export function markLibraryMutation(tx:IDBTransaction,owner:Record<string,unknown>,marker?:string) {
 tx.objectStore('context').put({...owner,mutation:createRandomId(),catalogMarker:newerLibraryMarker(owner.catalogMarker,marker)});
}
function removeAbsent(tx:IDBTransaction,snapshot:LibraryCatalogSnapshot,current:()=>boolean,finish:(removed:string[])=>void) {
 const keep=new Set(snapshot.entries.map(entry=>entry.id)),rows=tx.objectStore('charts'),keys=rows.getAllKeys();
 keys.onsuccess=()=>{
  if(!current()){tx.abort();return;}
  const removed=keys.result.map(String).filter(id=>!keep.has(id));
  for(const id of removed){unlinkLibraryPackages(tx,id);rows.delete(id);tx.objectStore('usage').delete(id);}
  finish(removed);
 };
}
function abortWithSignal(tx:IDBTransaction,signal:AbortSignal) {
 const abort=()=>{try{tx.abort();}catch{/* Already completed or rolled back. */}};
 const clear=()=>{signal.removeEventListener('abort',abort);tx.removeEventListener('complete',clear);tx.removeEventListener('abort',clear);};
 tx.addEventListener('complete',clear);tx.addEventListener('abort',clear);
 signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
}
function transactionAuthority(tx:IDBTransaction,authority:CheckAuthority|undefined,now:()=>number,accountId:string) {
 const guard={retired:false,current:()=>true};if(!authority)return guard;
 abortWithSignal(tx,authority.signal);if(authority.signal.aborted){guard.retired=true;return guard;}
 const proof=tx.objectStore('context').get(BACKGROUND_CHECK_KEY);
 let control:BackgroundControl|null=null;
 proof.onsuccess=()=>{control=readBackgroundControl(proof.result);};
 guard.current=()=>{
  guard.retired=authority.signal.aborted || !backgroundPermitCurrent(control,authority.permit,now(),accountId);
  return !guard.retired;
 };
 return guard;
}
function replaceCatalog(tx:IDBTransaction,snapshot:LibraryCatalogSnapshot,owner:Record<string,unknown>,seen:LibraryLease,
 current:()=>boolean,done:(value:LibraryCatalogWrite)=>void,fail:(cause?:unknown)=>void) {
 removeAbsent(tx,snapshot,current,removed=>{
  try{
   if(!current()){tx.abort();return;}
   // Complete absence fences acquisitions even for IDs not yet stored here.
   const lease={...seen,generation:createRandomId()},contexts=tx.objectStore('context');
   contexts.put({key:'catalog',...snapshot});
   contexts.put({...owner,...lease,mutation:createRandomId(),catalogMarker:newerLibraryMarker(owner.catalogMarker,snapshot.marker)});
   done({status:'stored',lease,removed});
  }catch(error){fail(error);}
 });
}
function admitCatalog(tx:IDBTransaction,base:LibraryCatalogBase,snapshot:LibraryCatalogSnapshot,current:()=>boolean,
 done:(value:LibraryCatalogWrite)=>void,fail:(cause?:unknown)=>void) {
 const contexts=tx.objectStore('context'),owner=contexts.get('owner'),prior=contexts.get('catalog');
 prior.onsuccess=()=>{
  if(!current()){done({status:'superseded'});return;}
  const decision=admission(owner.result,prior.result,base,snapshot);
  if(decision==='same'){done({status:'stored',lease:base.lease,removed:[]});return;}
  if(decision!=='replace'){done({status:decision});return;}
  replaceCatalog(tx,snapshot,owner.result,base.lease,current,done,fail);
 };
}
class LibraryCatalogStore {
 private database:Database;
 private now:()=>number;
 constructor(database:Database,now:()=>number){this.database=database;this.now=now;}
  async readCatalog():Promise<LibraryCatalogBase|null> {
   return this.database.transaction('readonly',(tx,done)=>{
    const rows=tx.objectStore('context'),owner=rows.get('owner'),saved=rows.get('catalog');
    saved.onsuccess=()=>{
     const lease=readLibraryLease(owner.result);if(!lease)return;
     done({lease,mutation:mutation(owner.result),minimumMarker:libraryMarker(owner.result.catalogMarker),catalog:saved.result?.complete===false?null:readStoredLibraryCatalog(saved.result,lease.accountId)});
    };
   });
  }
  async putCatalog(base:LibraryCatalogBase,value:LibraryCatalogSnapshot,authority?:CheckAuthority):Promise<LibraryCatalogWrite> {
   if(authority && !await backgroundAuthorityCurrent(authority))return {status:'superseded'};
   base={...base,lease:{...base.lease}};
   const snapshot=validateLibraryCatalogSnapshot(value,base.lease.accountId),seen=base.lease;
   let guard:ReturnType<typeof transactionAuthority>|undefined;
   const saved=await this.database.transaction<LibraryCatalogWrite>('readwrite',(tx,done,fail)=>{
    guard=transactionAuthority(tx,authority,this.now,seen.accountId);
    if(!guard.retired)admitCatalog(tx,base,snapshot,guard.current,done,fail);
   });
   return saved??{status:guard?.retired || authority?.signal.aborted?'superseded':'unavailable'};
  }
}
/** The complete light catalogue and its marker commit together with confirmed absence. */
export function createLibraryCatalogStore(database:Database,now=Date.now) {
 const store=new LibraryCatalogStore(database,now);
 return {readCatalog:store.readCatalog.bind(store),putCatalog:store.putCatalog.bind(store)};
}
