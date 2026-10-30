import type {LibraryLease,LibraryLocalChange} from '../domain/library-maintenance.ts';
export type LibraryLocalListener=(change:LibraryLocalChange)=>void;
export type ChangedLibraryKeys=(keys:string[])=>void;

/** Payloads stay in IndexedDB. A hint is published only after its transaction commits. */
export function trackLibraryChanges(tx:IDBTransaction,changed?:ChangedLibraryKeys) {
 const keys=new Set<string>();
 return (key:string)=>{
  if(!changed)return;
  if(!keys.size)tx.addEventListener('complete',()=>changed([...keys]));
  keys.add(key);
 };
}

export function createLibraryLocalChanges() {
 const listeners=new Set<LibraryLocalListener>();let closed=false;
 return {
  subscribeLocal(listener:LibraryLocalListener){
   if(!closed)listeners.add(listener);
   return ()=>{listeners.delete(listener);};
  },
  changed(lease:LibraryLease):ChangedLibraryKeys {
   const current={...lease};
   return keys=>{for(const listener of listeners){try{listener({lease:current,keys});}catch{/* Observation cannot reject a committed write. */}}};
  },
  close(){closed=true;listeners.clear();},
 };
}
