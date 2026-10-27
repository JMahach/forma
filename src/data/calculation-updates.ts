import type { ObserveClientAction, ClientObservation, ClientContextStep } from '../../shared/client-report-contract.ts';
import { requestJSON } from './api-client.ts';
import type { CalculationClients } from './calculation-clients.ts';
import type { LocalDayTimeline } from '../domain/day-timeline.ts';

interface Versions {calculationVersion:string;cyclesVersion:string}
type Snapshot=Awaited<ReturnType<CalculationClients['status']>>;
export type CalculationWindowUpdate={status:'applied';revision:number}|{
  status:'unconfirmed'|'incompatible'|'stale'|'unavailable'|'invalid'|'cancelled';
};
export type CalculationVersionUpdate={status:'confirmed';versions:Versions;window:CalculationWindowUpdate}
  |{status:'incompatible';versions:Versions}
  |{status:'stale'|'unavailable'|'invalid'|'cancelled'};
interface Options {
  observe?:ObserveClientAction;
  clients:CalculationClients;
  expected:{calculationVersion?:string|null;cyclesVersion?:string|null};
  timeline?:LocalDayTimeline|null;
  request?:(url:string,options:RequestInit)=>Promise<unknown>;
  timeoutMs?:number;
}
const hash=(value:unknown):value is string=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
function versions(value:unknown):Versions|null {
  if(!value || typeof value!=='object' || Array.isArray(value))return null;
  const data=value as Record<string,unknown>;
  return hash(data.calculationVersion) && hash(data.cyclesVersion)
    ?{calculationVersion:data.calculationVersion,cyclesVersion:data.cyclesVersion}:null;
}

/** Explicit version refresh and local timeline synchronization; never polls or updates client code. */
export function createCalculationUpdates({clients,expected,timeline:initialTimeline=null,
  request=requestJSON,timeoutMs=10_000,observe}:Options) {
  if(!Number.isFinite(timeoutMs) || timeoutMs<=0)throw new RangeError('Invalid version request deadline');
  const expectedVersions=versions(expected);
  let timeline=initialTimeline,timelineRevision=0,confirmed=false,closed=false;
  let active:AbortController|null=null;
  let windowTail:Promise<unknown>=Promise.resolve();
  function matching(value:Versions) {
    return expectedVersions?.calculationVersion===value.calculationVersion && expectedVersions.cyclesVersion===value.cyclesVersion;
  }
  function synchronize(snapshot?:Snapshot,isCurrent=()=>true,parent?:ClientObservation):Promise<CalculationWindowUpdate> {
    const observation=parent??observe?.({action:'data_read',component:'storage'});
    const unavailable=()=>{void observation?.reportFailure({stage:'commit',reason:'storage_unavailable'});return {status:'unavailable' as const};};
    const work=windowTail.then(async():Promise<CalculationWindowUpdate>=>{
      if(closed || !isCurrent())return {status:'cancelled'};
      if(!confirmed || !expectedVersions || !timeline)return {status:'unconfirmed'};
      // HTTP uses its original snapshot. Local-only changes read inside this
      // queue, after preceding writes, so an earlier window cannot win later.
      const before=snapshot??await clients.status();
      if(closed || !isCurrent())return {status:'cancelled'};
      if(!('versions' in before))return unavailable();
      if(!snapshot && (before.versions.natal!==expectedVersions.calculationVersion || before.versions.returns!==expectedVersions.cyclesVersion)){
        confirmed=false;return {status:'incompatible'};
      }
      const target=timeline,selection=timelineRevision;
      if(!target)return {status:'unconfirmed'};
      const result=await clients.setTransitWindow({version:expectedVersions.calculationVersion,
        dates:target.packetDates,expiresAt:target.endUtc},
      {previousVersion:before.window?.version,expectedRevision:before.window?.revision,
        expectedVersions:{natal:expectedVersions.calculationVersion,returns:expectedVersions.cyclesVersion}});
      if(closed || !isCurrent())return {status:'cancelled'};
      if(selection!==timelineRevision)return {status:'stale'};
      if(!result)return unavailable();
      if(result.status!=='applied'){if(result.status==='invalid')void observation?.reportFailure({stage:'commit',reason:'invalid_request'});return result;}
      // The early startup fetch may have finished before any window was known.
      // Re-admit only the exact current packets, through the normal validator.
      for(const date of target.packetDates){
        const day=clients.transit.peekDay(date);
        if(day?.calculationVersion===expectedVersions.calculationVersion)clients.transit.days.putDay(day);
      }
      await clients.transit.days.flush();
      if(closed || !isCurrent())return {status:'cancelled'};
      return selection===timelineRevision?result:{status:'stale'};
    }).catch((error):CalculationWindowUpdate=>{
      if(!closed && isCurrent())void observation?.reportError(error,{stage:'commit'});
      return {status:'unavailable'};
    }).finally(()=>{if(!parent)observation?.finishSuccess();});
    windowTail=work;return work;
  }
  return {
    async refresh({signal}:{signal?:AbortSignal}={}):Promise<CalculationVersionUpdate> {
      if(closed || signal?.aborted)return {status:'cancelled'};
      active?.abort();const controller=new AbortController();active=controller;
      const observation=observe?.({action:'data_read',component:'transport'});
      let stage:ClientContextStep['stage']='storage_read';
      const unavailable=()=>{void observation?.reportFailure({stage,reason:'storage_unavailable'});return {status:'unavailable' as const};};
      let timedOut=false;
      const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});
      const deadline=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
      const isCurrent=()=>!closed && active===controller && !controller.signal.aborted;
      const stopped=():CalculationVersionUpdate=>{
        if(timedOut)void observation?.reportFailure({stage:'wait',reason:'timeout'});
        return {status:timedOut?'unavailable':'cancelled'};
      };
      let detach=()=>{};
      const interrupted=new Promise<CalculationVersionUpdate>(resolve=>{
        const aborted=()=>resolve(stopped());controller.signal.addEventListener('abort',aborted,{once:true});
        detach=()=>controller.signal.removeEventListener('abort',aborted);
      });
      const work=(async():Promise<CalculationVersionUpdate>=>{
        // Capture before HTTP, not after a potentially late server response.
        const before=await clients.status();if(!isCurrent())return stopped();
        stage='request';
        const received=versions(await request('/api/versions',{method:'GET',cache:'no-store',signal:controller.signal}));
        if(!isCurrent())return stopped();
        if(!received){void observation?.reportFailure({stage:'validate',reason:'invalid_response'});return {status:'invalid'};}
        if(!matching(received)){confirmed=false;return {status:'incompatible',versions:received};}
        if(!('versions' in before)){stage='storage_read';return unavailable();}
        stage='commit';
        const result=await clients.confirmVersions({natal:received.calculationVersion,returns:received.cyclesVersion},{previous:before.versions});
        if(!isCurrent())return stopped();
        if(!result)return unavailable();
        if(result.status!=='applied'){if(result.status==='invalid')void observation?.reportFailure({stage:'commit',reason:'invalid_request'});return result;}
        confirmed=true;
        const window=await synchronize(before,isCurrent,observation);
        if(!isCurrent())return stopped();
        return {status:'confirmed',versions:received,window};
      })().catch((error):CalculationVersionUpdate=>{
        if(!isCurrent())return stopped();
        void observation?.reportError(error,{stage});return {status:'unavailable'};
      });
      try{return await Promise.race([work,interrupted]);}
      finally{observation?.finishSuccess();clearTimeout(deadline);detach();signal?.removeEventListener('abort',cancel);if(active===controller)active=null;}
    },
    syncWindow(){return synchronize();},
    onTimelineChanged(next:LocalDayTimeline|null){if(next!==timeline){timeline=next;timelineRevision++;}return synchronize();},
    close(){if(closed)return;closed=true;active?.abort();active=null;},
  };
}
