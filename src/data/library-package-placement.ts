import type {PackageRef} from '../../shared/library-package-contract.ts';
import type {LibraryPackageMetadata} from './account-library-schema.ts';
import type {IndexedResult} from './indexed-db.ts';

export interface PlacementProgress {released:number;remaining:boolean;ready:boolean}
/** Commit quota rolls back the whole prefix. Grow it geometrically, not 1+2+3+….
 * Each attempt selects and checks current victims inside its own transaction. */
export async function replaceAfterQuota<T>(attempt:(limit:number,progress:PlacementProgress)=>Promise<IndexedResult<T>>) {
 let limit=1;
 for(;;) {
  const progress:PlacementProgress={released:0,remaining:false,ready:false};
  const result=await attempt(limit,progress);
  if(result.status!=='quota' || !progress.ready || !progress.remaining)return result;
  limit=Math.max(limit,progress.released)*2;
 }
}

interface Candidate {id:string;kind:PackageRef['kind'];chartIds:string[];openedAt?:number}
interface Victim {id:string;kind:PackageRef['kind'];used:number;metadata?:LibraryPackageMetadata}
const rank={card:3,day:2,'major-returns':1};
const compareIds=(a:string,b:string)=>a<b?-1:a>b?1:0;
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

/** One transaction visits each admissible victim at most once. Abort restores all victims. */
export class TransactionPlacement {
 private victims:Victim[]|undefined;
 private next=0;
 private tx:IDBTransaction;private incoming:Candidate;private limit:number;private progress:PlacementProgress;
 private isCurrent:()=>boolean;private fail:(cause?:unknown)=>void;
 constructor(tx:IDBTransaction,incoming:Candidate,limit:number,isCurrent:()=>boolean,fail:(cause?:unknown)=>void,
  progress:PlacementProgress={released:0,remaining:false,ready:false}) {
  this.tx=tx;this.incoming=incoming;this.limit=limit;this.isCurrent=isCurrent;this.fail=fail;this.progress=progress;
 }
 private release(retry:()=>void) {
  if(!this.isCurrent()){this.fail();return;}
  if(!this.limit){this.fail(new DOMException('No admissible replacement','QuotaExceededError'));return;}
  if(!this.victims) {
   const keys=this.tx.objectStore('charts').getAllKeys(),metadata=this.tx.objectStore('packageMetadata').getAll();
   const marks=this.tx.objectStore('usage').getAll();marks.onsuccess=()=>{
    this.victims=selectVictims(keys.result,metadata.result,marks.result,this.incoming);this.release(retry);
   };return;
  }
  const victim=this.victims[this.next++];
  this.progress.remaining=this.next<this.victims.length;
  if(!victim){this.fail(new DOMException('No admissible replacement','QuotaExceededError'));return;}
  // Keep real-use ownership after payload eviction. Explicit removal of the
  // final card can then release the mark; an evicted row is never a new victim.
  const removed=this.tx.objectStore(victim.kind==='card'?'charts':'packages').delete(victim.id);
  removed.onsuccess=()=>{
   this.progress.released++;
   try {
    if(victim.metadata)this.tx.objectStore('packageMetadata').put({...victim.metadata,evicted:true}).onsuccess=retry;
    else retry();
   }catch(error){this.fail(error);}
  };
 }
 write(write:()=>IDBRequest,accepted:()=>void) {
  const rejected=(cause:unknown)=>{
   if((cause as DOMException)?.name==='QuotaExceededError')this.release(()=>this.write(write,accepted));else this.fail(cause);
  };
  try {
   const request=write();request.onsuccess=accepted;
   request.onerror=event=>{event.preventDefault();event.stopPropagation();rejected(request.error);};
  }catch(error){rejected(error);}
 }
 start(save:()=>void) {
  if(!this.limit){save();return;}
  const reserve=()=>this.release(()=>{
   if(this.progress.released<this.limit && this.progress.remaining)reserve();else save();
  });
  reserve();
 }
}
