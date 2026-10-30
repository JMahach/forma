import type {AccountChart} from '../../shared/chart-record-contract.ts';
import {validCycleResult,type CycleInput,type CycleEvent} from '../../shared/cycles-format.ts';
import {isMainReturnBody,mainReturnRange} from '../../shared/chart-return-contract.ts';
import {returnSourceKey,validMajorReturnsPackage,type MajorReturnsPackage,type PackageRef} from '../../shared/library-package-contract.ts';
import type {AccountLibraryStore,LibraryLease} from './account-library-store.ts';
import {returnStorageKey,type ReturnStorage} from './return-storage.ts';
import type {MemoryCache} from './memory-cache.ts';
import {createAbortError,shareRequest,type SharedRequest} from '../runtime/shared-request.ts';

export interface CycleOwner {chartId:string;expectedAccountId:string;record?:AccountChart}
type Library=Pick<AccountLibraryStore,'capture'|'readPackage'|'putPackage'|'touchPackage'>;
type FamilyRef=Extract<PackageRef,{kind:'major-returns'}>;
interface Destination {lease:LibraryLease;card:AccountChart;ref:FamilyRef;key:string}
interface ReadOptions {signal:AbortSignal;opened?:boolean;durable?:boolean}
interface ClientOptions {library?:Library;memory:MemoryCache;legacy:ReturnStorage|null;
 request:(url:string,options:RequestInit)=>Promise<unknown>;timeoutMs:number}
export type FamilyTransfer={status:'not-ready'|'stale'|'invalid'}
 | {status:'stored'|'no-op'|'quota'|'unavailable';payload:MajorReturnsPackage};

function ownsSource(card:AccountChart|undefined,input:CycleInput,owner:CycleOwner):card is AccountChart {
 return !!card && card.id===owner.chartId && card.accountId===owner.expectedAccountId && card.source==='calculated'
  && card.utc===input.birthUtc && (card.timezone||'UTC')===(input.timezone||'UTC');
}
function destination(library:Library|undefined,input:CycleInput,owner:CycleOwner):Destination|null {
 const card=owner.record;if(!isMainReturnBody(input.body) || !ownsSource(card,input,owner))return null;
 const lease=library?.capture(owner.expectedAccountId);if(!lease)return null;
 const ref:FamilyRef={kind:'major-returns',sourceKey:returnSourceKey({birthUtc:input.birthUtc,timezone:input.timezone||'UTC'}),family:input.body};
 return {lease,card:{...card},ref,key:`return-family:${ref.sourceKey}:${ref.family}`};
}
function parseReply(value:unknown,ref:FamilyRef) {
 const reply=value as {kind?:unknown;ref?:Partial<FamilyRef>;payload?:unknown}|null;
 const invalid=()=>Object.assign(new Error('Invalid return package'),{code:'invalid_response'});
 if(!reply || reply.ref?.kind!==ref.kind || reply.ref.sourceKey!==ref.sourceKey || reply.ref.family!==ref.family)throw invalid();
 if(reply.kind==='not-ready')return null;
 if(reply.kind!=='ready' || !validMajorReturnsPackage(ref,reply.payload))throw invalid();
 return reply.payload;
}
async function readLegacyParts(legacy:ReturnStorage,input:CycleInput,events:CycleEvent[],signal:AbortSignal) {
 const keys:string[]=[],charts:unknown[]=[];
 for(const event of events) {
  const key=returnStorageKey('chart',{...input,eventUtc:event.utc}),part=await legacy.getChart(key);
  if(signal.aborted)throw createAbortError();
  if(!part)return null;
  keys.push(key);charts.push(part);
 }
 return {keys,charts};
}
async function readLegacyFamily(legacy:ReturnStorage,target:Destination,signal:AbortSignal) {
 const input={birthUtc:target.card.utc,timezone:target.card.timezone||'UTC',body:target.ref.family,...mainReturnRange(target.card.utc)};
 const key=returnStorageKey('events',input),dates=await legacy.getEvents(key);
 if(signal.aborted)throw createAbortError();
 if(!validCycleResult('events',dates,input) || dates.events.length>2000)return null;
 const parts=await readLegacyParts(legacy,input,dates.events,signal);if(!parts)return null;
 const {keys,charts}=parts;
 const packet={source:{birthUtc:input.birthUtc,timezone:input.timezone},family:target.ref.family,dates,charts};
 return validMajorReturnsPackage(target.ref,packet)?{packet,keys,key}:null;
}
async function discardLegacy(legacy:ReturnStorage,partKeys:string[],dateKey:string,signal:AbortSignal) {
 // Optional duplicate cleanup cannot hide the complete committed replacement.
 try {for(const key of partKeys){if(signal.aborted)return;await legacy.removeChart(key);}if(!signal.aborted)await legacy.removeEvents(dateKey);}catch{}
}

class ReturnFamilyClient {
 private options:ClientOptions;
 private reads=new Map<string,SharedRequest<MajorReturnsPackage|null>>();
 private downloads=new Map<string,SharedRequest<FamilyTransfer>>();
 private uses=new Map<string,SharedRequest<void>>();
 constructor(options:ClientOptions){this.options=options;}
 private remember(target:Destination,packet:MajorReturnsPackage) {this.options.memory.put(target.key,packet);return packet;}
 private save(target:Destination,packet:MajorReturnsPackage,opened:boolean) {
  return this.options.library!.putPackage(target.lease,target.card,target.ref,packet,{opened});
 }
 private async use(target:Destination,packet:MajorReturnsPackage,signal:AbortSignal) {
  if(signal.aborted)return;
  if(!await this.options.library!.touchPackage(target.lease,target.ref) && !signal.aborted)await this.save(target,packet,true);
 }
 private async migrate(target:Destination,signal:AbortSignal,opened:boolean) {
  const {legacy}=this.options;if(!legacy)return null;
  const data=await readLegacyFamily(legacy,target,signal);if(!data)return null;
  const placed=await this.save(target,data.packet,opened);
  if(signal.aborted)throw createAbortError();
  if(placed!=='stored' && placed!=='no-op')return null;
  await discardLegacy(legacy,data.keys,data.key,signal);return data.packet;
 }
 private async load(target:Destination,signal:AbortSignal,opened:boolean) {
  const stored=await this.options.library!.readPackage(target.lease,target.ref,{opened});
  const packet=stored??await this.migrate(target,signal,opened);
  if(signal.aborted)throw createAbortError();
  return packet && !(packet instanceof ArrayBuffer)?this.remember(target,packet):null;
 }
 async read(input:CycleInput,owner:CycleOwner,{signal,opened=false,durable=false}:ReadOptions) {
  if(signal.aborted)throw createAbortError();
  const target=destination(this.options.library,input,owner);if(!target)return null;
  const useKey=JSON.stringify([target.key,target.lease]);
  if(!durable) {
   const ready=this.options.memory.get<MajorReturnsPackage>(target.key);
   if(ready){
    if(opened)void shareRequest(this.uses,useKey,({controller})=>this.use(target,ready,controller.signal),{signal}).catch(()=>{});
    return ready;
   }
  }
  // A new durable action observes the preceding optional admission, including
  // the gap between a missing lightweight use mark and the full fallback write.
  await this.uses.get(useKey)?.promise.catch(()=>{});
  if(signal.aborted)throw createAbortError();
  const key=JSON.stringify([target.key,target.lease,opened]);
  return shareRequest(this.reads,key,({controller})=>this.load(target,controller.signal,opened),{signal});
 }
 private async download(target:Destination,signal:AbortSignal):Promise<FamilyTransfer> {
  const query=new URLSearchParams({accountId:target.lease.accountId,sourceKey:target.ref.sourceKey});
  const value=await this.options.request(`/api/charts/${encodeURIComponent(target.card.id)}/returns/${target.ref.family}/package?${query}`,
   {method:'GET',cache:'no-store',signal});
  if(signal.aborted)throw createAbortError();
  const packet=parseReply(value,target.ref);if(!packet)return {status:'not-ready'};
  const status=await this.save(target,packet,false);
  if(signal.aborted)throw createAbortError();
  if(status==='stale' || status==='invalid')return {status};
  return {status,payload:this.remember(target,packet)};
 }
 async fetch(input:CycleInput,owner:CycleOwner,{signal}:ReadOptions):Promise<FamilyTransfer> {
  if(signal.aborted)throw createAbortError();
  const target=destination(this.options.library,input,owner);if(!target)return {status:'stale'};
  const stored=await this.read(input,owner,{signal,durable:true});if(stored)return {status:'no-op',payload:stored};
  const key=JSON.stringify([target.key,target.lease,target.card.id]);
  return shareRequest(this.downloads,key,async({controller})=>{
   let timedOut=false;
   const timer=setTimeout(()=>{timedOut=true;controller.abort();},this.options.timeoutMs);
   try{return await this.download(target,controller.signal);}
   catch(error){if(timedOut)throw Object.assign(new Error('Return package timeout'),{code:'server_unavailable'});throw error;}
   finally{clearTimeout(timer);}
  },{signal});
 }
}
/** Whole families share the existing library and bounded tab memory; transfer status never implies offline readiness. */
export function createReturnFamilyClient(options:ClientOptions) {
 const client=new ReturnFamilyClient(options);
 return {read:client.read.bind(client),fetch:client.fetch.bind(client)};
}
