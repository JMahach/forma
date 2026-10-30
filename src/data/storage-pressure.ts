import type { IndexedResult } from './indexed-db.ts';
export type ReliefGuard=()=>boolean;
export type StorageRelief = 'released' | 'empty' | 'unavailable';
export interface ProtectedWrite { calculation?:{kind:string;key:string}; accountLibrary?:boolean }
export interface PressureSources {
 diagnostics:(isCurrent:ReliefGuard)=>Promise<StorageRelief>;
 natalDays:(keep:number,exclude:string|undefined,isCurrent:ReliefGuard)=>Promise<StorageRelief>;
 returnCharts:(keep:number,exclude:string|undefined,isCurrent:ReliefGuard)=>Promise<StorageRelief>;
}
function browserLocks():Pick<LockManager,'request'>|null {
 try{return typeof navigator==='undefined'?null:navigator.locks??null;}catch{return null;}
}
/** Coordinates an already failed local write. Owners alone choose and remove
 * their records. Neither a new cache nor an estimate of free disk space. */
export function createStoragePressure({locks=browserLocks()}:{locks?:Pick<LockManager,'request'>|null}={}) {
 const sources:Partial<PressureSources>={};let tail:Promise<unknown>=Promise.resolve(),generation=0;
 const capture=():ReliefGuard=>{const seen=generation;return ()=>seen===generation;};
 async function attempt<T>(write:()=>Promise<IndexedResult<T>>):Promise<IndexedResult<T>> {
  try{return await write();}catch{return {status:'unavailable'};}
 }
 return {
  capture,
  invalidate(){generation++;},
  setSources(value:Partial<PressureSources>){Object.assign(sources,value);},
  async write<T>(write:()=>Promise<IndexedResult<T>>,protect:ProtectedWrite={}):Promise<IndexedResult<T>> {
   const isCurrent=capture(),accountLibrary=protect.accountLibrary===true;
   const initial=await attempt(write);if(initial.status!=='quota')return initial;
   const calculation=protect.calculation?{...protect.calculation}:undefined;
   const recover=async():Promise<IndexedResult<T>>=>{
    // Another writer may already have released enough while we waited.
    if(!isCurrent())return initial;
    let result=await attempt(write);
    while(result.status==='quota' && isCurrent()){
     const steps=[()=>sources.diagnostics?.(isCurrent),
      ()=>sources.natalDays?.(10,calculation?.kind==='natal'?calculation.key:undefined,isCurrent),
      ()=>sources.returnCharts?.(10,calculation?.kind==='return-charts'?calculation.key:undefined,isCurrent)];
     // The account owner alone ranks and releases its library copies.
     // This service may release only disposable diagnostics for that write.
     if(accountLibrary)steps.splice(1);
     let released=false;
     for(const step of steps){
      if(!isCurrent())return result;
      let relief:StorageRelief|undefined;try{relief=await step();}catch{return result;}
      if(!relief || relief==='unavailable')return result;
      if(relief==='released'){released=true;break;}
     }
     if(!released || !isCurrent())return result;
     result=await attempt(write);
    }
    return result;
   };
   const work=tail.then(()=>locks?locks.request('forma:storage-pressure',recover):recover());
   tail=work.catch(()=>{});return work.catch(()=>initial);
  },
 };
}
export type StoragePressure=ReturnType<typeof createStoragePressure>;
