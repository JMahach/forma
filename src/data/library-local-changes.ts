import type {LibraryLease,LibraryLocalChange} from '../domain/library-maintenance.ts';
export type LibraryLocalListener=(change:LibraryLocalChange)=>void;
export type ChangedLibraryKeys=(keys:string[],payloadStored?:true)=>void;

/** Payloads stay in IndexedDB. A hint is published only after its transaction commits. */
export function trackLibraryChanges(tx:IDBTransaction,changed?:ChangedLibraryKeys,payloadStored?:true) {
 const keys=new Set<string>();
 return (key:string)=>{
  if(!changed)return;
  if(!keys.size)tx.addEventListener('complete',()=>changed([...keys],payloadStored));
  keys.add(key);
 };
}

export function createLibraryLocalChanges(now:()=>number=Date.now) {
 const listeners=new Set<LibraryLocalListener>();let closed=false;
 return {
  subscribeLocal(listener:LibraryLocalListener){
   if(!closed)listeners.add(listener);
   return ()=>{listeners.delete(listener);};
  },
  changed(lease:LibraryLease):ChangedLibraryKeys {
   const current={...lease};
   return (keys,payloadStored)=>{
    const change={lease:current,keys,...(payloadStored?{payloadStoredAt:now()}:{})};
    for(const listener of listeners){try{listener(change);}catch{/* Observation cannot reject a committed write. */}}
   };
  },
  close(){closed=true;listeners.clear();},
 };
}
