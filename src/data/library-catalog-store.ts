import {isLibraryCatalogMarker} from '../../shared/library-catalog-contract.ts';
import type {LibraryCatalogSnapshot} from '../../shared/library-catalog-contract.ts';
import {validateLibraryCatalogSnapshot} from '../domain/library-catalog.ts';
import {createRandomId} from '../domain/chart-record.ts';
import {readLibraryLease,sameLibraryLease,type LibraryLease} from './account-library-schema.ts';
import {unlinkLibraryPackages} from './library-package-store.ts';
import type {createIndexedDatabase} from './indexed-db.ts';

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
function removeAbsent(tx:IDBTransaction,snapshot:LibraryCatalogSnapshot,finish:(removed:string[])=>void) {
 const keep=new Set(snapshot.entries.map(entry=>entry.id)),rows=tx.objectStore('charts'),keys=rows.getAllKeys();
 keys.onsuccess=()=>{
  const removed=keys.result.map(String).filter(id=>!keep.has(id));
  for(const id of removed){unlinkLibraryPackages(tx,id);rows.delete(id);tx.objectStore('usage').delete(id);}
  finish(removed);
 };
}
class LibraryCatalogStore {
 private database:Database;
 constructor(database:Database){this.database=database;}
  async readCatalog():Promise<LibraryCatalogBase|null> {
   return this.database.transaction('readonly',(tx,done)=>{
    const rows=tx.objectStore('context'),owner=rows.get('owner'),saved=rows.get('catalog');
    saved.onsuccess=()=>{
     const lease=readLibraryLease(owner.result);if(!lease)return;
     done({lease,mutation:mutation(owner.result),minimumMarker:libraryMarker(owner.result.catalogMarker),catalog:saved.result?.complete===false?null:readStoredLibraryCatalog(saved.result,lease.accountId)});
    };
   });
  }
  async putCatalog(base:LibraryCatalogBase,value:LibraryCatalogSnapshot):Promise<LibraryCatalogWrite> {
   base={...base,lease:{...base.lease}};
   const snapshot=validateLibraryCatalogSnapshot(value,base.lease.accountId),seen=base.lease;
   return await this.database.transaction<LibraryCatalogWrite>('readwrite',(tx,done,fail)=>{
    const contexts=tx.objectStore('context'),owner=contexts.get('owner'),prior=contexts.get('catalog');
    prior.onsuccess=()=>{
     const decision=admission(owner.result,prior.result,base,snapshot);
     if(decision==='same'){done({status:'stored',lease:seen,removed:[]});return;}
     if(decision!=='replace'){done({status:decision});return;}
     removeAbsent(tx,snapshot,removed=>{
      try{
       // Complete absence also covers IDs that have never been stored here.
       // Retire earlier acquisitions even when there was no payload to delete.
       const lease={...seen,generation:createRandomId()};
       contexts.put({key:'catalog',...snapshot});
       contexts.put({...owner.result,...lease,mutation:createRandomId(),catalogMarker:newerLibraryMarker(owner.result.catalogMarker,snapshot.marker)});
       done({status:'stored',lease,removed});
      }catch(error){fail(error);}
     });
    };
   })??{status:'unavailable'};
  }
}
/** The complete light catalogue and its marker commit together with confirmed absence. */
export function createLibraryCatalogStore(database:Database) {
 const store=new LibraryCatalogStore(database);
 return {readCatalog:store.readCatalog.bind(store),putCatalog:store.putCatalog.bind(store)};
}
