import {trackLibraryChanges,type ChangedLibraryKeys} from './library-local-changes.ts';
import type {PackageRef} from '../../shared/library-package-contract.ts';
import type {LibraryPackageMetadata} from './account-library-schema.ts';
import type {IndexedResult} from './indexed-db.ts';
import type {StorageRelief} from './storage-pressure.ts';

export interface PlacementProgress {released:boolean}
/** The pressure owner alone decides whether cleanup may run and retries the write. */
export async function releaseLibrarySpace<T>(release:(progress:PlacementProgress)=>Promise<IndexedResult<T>>):Promise<StorageRelief> {
 const progress:PlacementProgress={released:false};
 const freed=await release(progress);
 if(freed.status!=='complete')return freed.status==='quota'?'empty':'unavailable';
 return progress.released?'released':'empty';
}

interface Candidate {id:string;kind:PackageRef['kind'];chartIds:string[];openedAt?:number}
interface Victim {id:string;kind:PackageRef['kind'];used:number;metadata?:LibraryPackageMetadata}
const rank={card:3,day:2,'major-returns':1};
const compareIds=(a:string,b:string)=>a<b?-1:a>b?1:0;
export function restoreCardUsage(tx:IDBTransaction,id:string) {
 const rows=tx.objectStore('usage'),read=rows.get(id);read.onsuccess=()=>{
  if(read.result?.evicted)rows.put({id,openedAt:read.result.openedAt});
 };
}
function lowerPriority(row:Victim,incoming:Candidate,threshold:number) {
 if(row.id===incoming.id)return false;
 return rank[row.kind]<rank[incoming.kind] || rank[row.kind]===rank[incoming.kind]
  && (row.used<threshold || row.used===threshold && compareIds(row.id,incoming.id)<0);
}
function selectVictims(keys:IDBValidKey[],packages:LibraryPackageMetadata[],marks:{id:string;openedAt:number}[],incoming:Candidate) {
 const used=new Map(marks.map(row=>[row.id,Number.isFinite(row.openedAt)?Math.max(0,row.openedAt):0]));
 const priority=(id:string,chartIds:string[])=>Math.max(used.get(id)??0,...chartIds.map(id=>used.get(id)??0));
 const threshold=Math.max(incoming.openedAt??0,priority(incoming.id,incoming.chartIds));
 const candidates:Victim[]=[...keys.map(key=>({id:String(key),kind:'card' as const,used:used.get(String(key))??0})),
  ...packages.filter(row=>!row.evicted).map(row=>({id:row.id,kind:row.ref.kind,used:priority(row.id,row.chartIds),metadata:row}))];
 return candidates.filter(row=>lowerPriority(row,incoming,threshold))
  .sort((a,b)=>rank[a.kind]-rank[b.kind] || a.used-b.used || compareIds(a.id,b.id));
}

/** This transaction contains only intentional eviction and its ownership marks.
 * Failure rolls back this batch; a later failed payload write cannot restore it. */
export class LibrarySpaceRelease {
 private changed:(key:string)=>void;
 private tx:IDBTransaction;private incoming:Candidate;private progress:PlacementProgress;
 private isCurrent:()=>boolean;private fail:(cause?:unknown)=>void;
 constructor(tx:IDBTransaction,incoming:Candidate,isCurrent:()=>boolean,fail:(cause?:unknown)=>void,
  progress:PlacementProgress,changed?:ChangedLibraryKeys) {
  this.changed=trackLibraryChanges(tx,changed);
  this.tx=tx;this.incoming=incoming;this.isCurrent=isCurrent;this.fail=fail;this.progress=progress;
 }
 private release(victim:Victim|undefined,done:()=>void) {
  if(!this.isCurrent()){this.fail();return;}
  if(!victim){done();return;}
  // Keep real-use ownership after payload eviction. Explicit removal of the
  // final card can then release the mark; an evicted row is never a new victim.
  const removed=this.tx.objectStore(victim.kind==='card'?'charts':'packages').delete(victim.id);
  removed.onsuccess=()=>{
   this.progress.released=true;this.changed(victim.id);
   try {
    if(victim.metadata)this.tx.objectStore('packageMetadata').put({...victim.metadata,evicted:true}).onsuccess=done;
    else this.tx.objectStore('usage').put({id:victim.id,openedAt:victim.used,evicted:true}).onsuccess=done;
   }catch(error){this.fail(error);}
  };
 }
 start(done:()=>void) {
  const keys=this.tx.objectStore('charts').getAllKeys(),metadata=this.tx.objectStore('packageMetadata').getAll();
  const marks=this.tx.objectStore('usage').getAll();marks.onsuccess=()=>{
   this.release(selectVictims(keys.result,metadata.result,marks.result,this.incoming)[0],done);
  };
 }
}
