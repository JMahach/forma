import type {ChartClient} from './chart-client.ts';
import type {CyclesClient} from './cycles-client.ts';
import type {AccountLibraryStore,LibraryLease} from './account-library-store.ts';
import type {FillAuthority,FillCandidate,FillReceipt,FillPlacement} from '../domain/library-fill.ts';
import type {AccountChart} from '../../shared/chart-record-contract.ts';
import type {MajorReturnsPackage} from '../../shared/library-package-contract.ts';
import {natalDaySourceKey,returnSourceKey} from '../../shared/library-package-contract.ts';
import {mainReturnRange} from '../../shared/chart-return-contract.ts';
import {createAbortError} from '../runtime/shared-request.ts';
interface Ports {store:AccountLibraryStore;charts:Pick<ChartClient,'own'|'readyDay'>;cycles:Pick<CyclesClient,'receiveFamily'>;lease():LibraryLease|null}
export type LibraryFillPacket={kind:'card';chart:AccountChart;marker:string}|{kind:'day'|'major-returns';chart:AccountChart;payload:ArrayBuffer|MajorReturnsPackage};
const stale=()=>Object.assign(new Error('Library source changed'),{code:'stale_library'});
function matches(candidate:FillCandidate,chart:AccountChart){
 if(chart.id!==candidate.chartId || chart.revision<candidate.revision)return false;
 if(candidate.ref.kind==='card')return true;
 if(chart.source!=='calculated')return false;
 return candidate.ref.sourceKey===(candidate.ref.kind==='day'?natalDaySourceKey({date:chart.birthDate,timezone:chart.timezone||'UTC'}):returnSourceKey({birthUtc:chart.utc,timezone:chart.timezone||'UTC'}));
}
async function receiveCard(ports:Ports,candidate:FillCandidate,lease:LibraryLease,signal:AbortSignal):Promise<FillReceipt>{
 const reply=await ports.charts.own({chartId:candidate.chartId,expectedAccountId:lease.accountId},signal);
 if(!matches(candidate,reply.chart))throw stale();
 return {kind:'ready',payload:{kind:'card',chart:reply.chart,marker:reply.catalogMarker} satisfies LibraryFillPacket};
}
async function receiveNumbers(ports:Ports,candidate:FillCandidate,lease:LibraryLease,chart:AccountChart,signal:AbortSignal):Promise<FillReceipt>{
 const ref=candidate.ref;if(ref.kind==='card')throw stale();
 if(ref.kind==='day'){
  const reply=await ports.charts.readyDay({chartId:chart.id,expectedAccountId:lease.accountId,ref},signal);
  return reply.kind==='ready'?{kind:'ready',payload:{kind:'day',chart,payload:reply.payload} satisfies LibraryFillPacket}:reply;
 }
 const input={birthUtc:chart.utc,timezone:chart.timezone||'UTC',body:ref.family,...mainReturnRange(chart.utc)!};
 const reply=await ports.cycles.receiveFamily(input,{chartId:chart.id,expectedAccountId:lease.accountId,record:chart},{signal});
 if(reply.status==='stale')throw stale();
 return reply.status==='ready'?{kind:'ready',payload:{kind:'major-returns',chart,payload:reply.payload} satisfies LibraryFillPacket}:{kind:'not-ready'};
}
async function packet(ports:Ports,candidate:FillCandidate,lease:LibraryLease,signal:AbortSignal):Promise<FillReceipt>{
 if(candidate.ref.kind==='card')return receiveCard(ports,candidate,lease,signal);
 const chart=await ports.store.maintenance.readCard(lease,candidate.chartId);if(signal.aborted)throw createAbortError();
 if(!chart || !matches(candidate,chart))throw stale();
 return receiveNumbers(ports,candidate,lease,chart,signal);
}
async function placeCard(ports:Ports,packet:Extract<LibraryFillPacket,{kind:'card'}>,authority:FillAuthority):Promise<FillPlacement>{
 const result=await ports.store.put(authority.permit.lease,[packet.chart],packet.marker,authority);
 if(result.status==='stored')return result.changed===false?'no-op':'stored';
 return result.status==='partial'?'unavailable':result.status;
}
async function placePacket(ports:Ports,candidate:FillCandidate,payload:unknown,authority:FillAuthority):Promise<FillPlacement>{
 const packet=payload as LibraryFillPacket;if(!packet || packet.kind!==candidate.ref.kind || !packet.chart || !matches(candidate,packet.chart))return 'invalid';
 if(authority.signal.aborted)return 'stale';
 if(packet.kind==='card')return placeCard(ports,packet,authority);
 if(candidate.ref.kind==='card')return 'invalid';
 return ports.store.putPackage(authority.permit.lease,packet.chart,candidate.ref,packet.payload,{authority});
}
/** Existing clients own validation; existing storage owns admission. This adapter holds no numerical cache. */
export function createLibraryFillTransfer(ports:Ports){
 return {
  present(candidate:FillCandidate,lease:LibraryLease){return ports.store.maintenance.contains(lease,candidate.ref,candidate.chartId,candidate.revision);},
  async receive(candidate:FillCandidate,signal:AbortSignal):Promise<FillReceipt>{
   const lease=ports.lease();if(!lease || signal.aborted)throw createAbortError();
   const reply=await packet(ports,candidate,lease,signal);if(signal.aborted)throw createAbortError();return reply;
  },
  place:(candidate:FillCandidate,payload:unknown,authority:FillAuthority)=>placePacket(ports,candidate,payload,authority),
 };
}
