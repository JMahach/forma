import type {SavedView,ViewStore} from '../data/view-store.ts';

export type CheckpointResult = {kind:'stored'} | {kind:'memory-only'} | {kind:'failed';cause:unknown};
export type CheckpointReason = 'write'|'handoff'|'update';
type Source={read:()=>Partial<SavedView>|null;stored:()=>void};
type SnapshotStore=Pick<ViewStore,'write'> & Partial<Pick<ViewStore,'clear'>>;
interface Options {
 store:SnapshotStore;
 eventTarget?:EventTarget|null;
 interactionTarget?:(EventTarget & {hidden:boolean})|null;
 schedule?:typeof globalThis.setTimeout;
 cancel?:typeof globalThis.clearTimeout;
 delay?:number;
}

// Persistence reports durability; source scheduling and ownership stay below.
function persistSource(source:Source|null,store:SnapshotStore):CheckpointResult {
 if(!source)return {kind:'failed',cause:new Error('Snapshot source is not ready')};
 try{
  const snapshot=source.read();
  if(!snapshot || snapshot.version!==1)return {kind:'failed',cause:new Error('Snapshot source is not ready')};
  if(!store.write(snapshot))return {kind:'memory-only'};
 }catch(cause){return {kind:'failed',cause};}
 try{source.stored();}catch{/* Observation cannot change a completed write. */}
 return {kind:'stored'};
}
function clearSnapshot(store:SnapshotStore,retained?:Partial<SavedView>):CheckpointResult {
 if(retained && retained.version!==1 || !retained && !store.clear)return {kind:'failed',cause:new Error('Snapshot cannot be cleared')};
 try{return {kind:(retained?store.write(retained):store.clear!())?'stored':'memory-only'};}
 catch(cause){return {kind:'failed',cause};}
}

/** One tab writer survives startup handoff; a replaced source cannot schedule or flush it. */
export function createViewCheckpoint({store,eventTarget,interactionTarget,schedule:defer=globalThis.setTimeout,
 cancel=globalThis.clearTimeout,delay=160}:Options){
 let source:Source|null=null,stopped=false,pending:ReturnType<typeof globalThis.setTimeout>|null=null;
 const cancelPending=()=>{if(pending!==null)cancel(pending);pending=null;};
 const flush=():CheckpointResult=>{cancelPending();return persistSource(source,store);};
 const pageHide=()=>{flush();},hidden=()=>{if(interactionTarget?.hidden)flush();};
 eventTarget?.addEventListener('pagehide',pageHide);
 interactionTarget?.addEventListener('visibilitychange',hidden);
 return {
  get pending(){return pending!==null;},
  claim(read:Source['read'],stored=()=>{}){
   if(stopped)throw new Error('Snapshot writer is stopped');
   if(pending!==null)flush();
   const owner:Source={read,stored};source=owner;
   const owned=():CheckpointResult=>source===owner?flush():{kind:'failed',cause:new Error('Snapshot source is no longer active')};
   return {
    schedule(){if(source===owner && pending===null)pending=defer(flush,delay);},
    flush:owned,
    async checkpoint(_reason:CheckpointReason){return owned();},
   };
  },
  flushForPageHide:flush,
  async checkpoint(_reason:CheckpointReason){return flush();},
  clear(retained?:Partial<SavedView>):CheckpointResult {
   cancelPending();
   if(stopped)return {kind:'failed',cause:new Error('Snapshot writer is stopped')};
   return clearSnapshot(store,retained);
  },
  destroy(){cancelPending();stopped=true;source=null;
   eventTarget?.removeEventListener('pagehide',pageHide);interactionTarget?.removeEventListener('visibilitychange',hidden);},
 };
}
export type ViewCheckpoint=ReturnType<typeof createViewCheckpoint>;
