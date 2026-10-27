import {parseClientReport,parseClientReportMetadata,parseClientActionContext,parseClientContextStep,
  CLIENT_CONTEXT_MAX_STEPS,CLIENT_CONTEXT_MAX_BYTES,CLIENT_CONTEXT_REASONS,CLIENT_REPORT_REASONS,
  type ClientReport,type ClientReportMetadata,type ClientActionContext,type ClientContextStep,type ClientContextReason,type ClientReportReason} from '../../shared/client-report-contract.ts';

export interface ClientReportAdmission {report:ClientReport;queued:boolean}
interface Options {
  metadata:()=>ClientReportMetadata;
  enqueue:(report:ClientReport)=>Promise<boolean>;
  now?:()=>number;monotonicNow?:()=>number;newId?:()=>string;
}
type Failure=ClientContextStep & {reason:ClientContextReason;outcome?:'failed'|'unknown'};
type Recovery=Omit<ClientContextStep,'reason'>;
interface Episode {failed:boolean;recovered:boolean;reason?:ClientReportReason}
interface ContextEntry {contextId:string;step:Readonly<ClientContextStep>}
const encoder=new TextEncoder();
export {clientFailureReason} from '../../shared/client-report-contract.ts';

/** Ephemeral action facts only. The injected queue owns persistence, retry and delivery.
 * An explicit episode identifies one failure, including its repeated handlers.
 * At most ten shared markers survive in RAM; a handle remembers its own outcome,
 * but an unseen handler cannot deduplicate an episode after its shared eviction.
 * Distinct failures need distinct episode IDs; this adapter does not aggregate them.
 */
export function createClientReports({metadata,enqueue,now=Date.now,monotonicNow=()=>performance.now(),newId=()=>crypto.randomUUID()}:Options) {
  const context:ContextEntry[]=[],episodes=new Map<string,Episode>();
  let generation=0,closed=false;
  function forget(contextId:string) {
    for(let i=context.length-1;i>=0;i--)if(context[i].contextId===contextId)context.splice(i,1);
  }
  function episode(contextId:string) {
    let value=episodes.get(contextId);
    if(!value) {
      while(episodes.size>=CLIENT_CONTEXT_MAX_STEPS)episodes.delete(episodes.keys().next().value!);
      value={failed:false,recovered:false};episodes.set(contextId,value);
    }
    return value;
  }
  function trim() {
    // Include the small dedupe markers in the same bounded context content.
    const bytes=()=>encoder.encode(JSON.stringify({context,episodes:[...episodes]})).byteLength;
    while(context.length && (context.length>CLIENT_CONTEXT_MAX_STEPS || bytes()>CLIENT_CONTEXT_MAX_BYTES))context.shift();
    while(episodes.size && bytes()>CLIENT_CONTEXT_MAX_BYTES)episodes.delete(episodes.keys().next().value!);
  }
  function begin(input:ClientActionContext,observedAt?:number) {
    const ownedGeneration=generation;
    let finished=closed,failureObserved=false,contextId='',captured:Readonly<ClientReportMetadata>|null=null,action:Readonly<ClientActionContext>|null=null,start:number|undefined;
    try {if(!closed) {
      captured=parseClientReportMetadata(metadata());action=parseClientActionContext(input);
      if(!captured || !action)finished=true;
      else {
        contextId=action.episodeId??newId();
        if(!parseClientActionContext({...action,episodeId:contextId}))finished=true;
        else {start=monotonicNow();episode(contextId);trim();}
      }
    }}catch{finished=true;}
    const active=()=>!closed && !finished && generation===ownedGeneration;
    function measured(step:Readonly<ClientContextStep>) {
      if(step.durationMs!==undefined)return step;
      let elapsed:number|undefined;try{const end=monotonicNow();if(start!==undefined && Number.isFinite(start) && Number.isFinite(end) && end>=start)elapsed=end-start;}catch{}
      return elapsed===undefined?step:{...step,durationMs:elapsed};
    }
    async function report(fact:Failure|Recovery,recovery:boolean):Promise<ClientReportAdmission|null> {
      if(!active() || !captured || !action || !recovery && failureObserved)return null;
      // Validate without spreading an arbitrary caller object or invoking getters.
      let outcome:'failed'|'unknown'='failed',step:Readonly<ClientContextStep>|null;
      try {
        if(!fact || typeof fact!=='object' || Array.isArray(fact))return null;
        const fields=Object.getOwnPropertyDescriptors(fact);
        if(Object.getOwnPropertySymbols(fact).length || Object.values(fields).some(field=>!field.enumerable || !('value' in field)))return null;
        const values=Object.fromEntries(Object.entries(fields).map(([key,field])=>[key,field.value]));
        if(recovery && Object.hasOwn(values,'reason'))return null;
        if(Object.hasOwn(values,'outcome')) {
          if(recovery || !['failed','unknown'].includes(values.outcome as string))return null;
          outcome=values.outcome as 'failed'|'unknown';delete values.outcome;
        }
        step=parseClientContextStep(values);
      }catch{return null;}
      if(!step)return null;
      const status=recovery?episodes.get(contextId):episode(contextId);
      if(!status || recovery && !status.failed)return null;
      if(status.recovered){finished=true;return null;}
      const reason=recovery?status.reason:step.reason;
      if(!reason || !CLIENT_REPORT_REASONS.includes(reason as ClientReportReason))return null;
      if(!recovery && status.failed){failureObserved=true;return null;}
      let occurredAt:number;try{const currentTime=now();occurredAt=recovery?currentTime:observedAt??currentTime;if(occurredAt>currentTime)return null;}catch{return null;}
      if(!Number.isSafeInteger(occurredAt) || occurredAt<0 || occurredAt>8.64e15)return null;
      const {episodeId:_,...identity}=action;
      let snapshot:ClientReport|null;
      try {
        snapshot=parseClientReport({schemaVersion:1,...captured,...identity,...measured(step),reason,
          eventId:newId(),occurredAt,contextId,source:'browser',
          ...(recovery?{event:'client_recovered',level:'info',outcome:'recovered'}:outcome==='unknown'
            ?{event:'client_outcome_unknown',level:'warn',outcome:'unknown'}:{event:'client_failed',level:'error',outcome:'failed'}),
          context:context.filter(entry=>entry.contextId===contextId).map(entry=>entry.step)});
      }catch{return null;}
      if(!snapshot)return null;
      if(recovery){status.recovered=true;finished=true;}
      else{status.failed=true;status.reason=reason as ClientReportReason;failureObserved=true;}
      forget(contextId);trim();
      let queued=false;try{queued=await enqueue(snapshot)===true;}catch{}
      return {report:snapshot,queued};
    }
    return {
      step(value:ClientContextStep) {
        if(!active())return;
        const parsed=parseClientContextStep(value);if(!parsed)return;
        if(episodes.get(contextId)?.recovered)return;
        context.push({contextId,step:parsed});trim();
      },
      finishSuccess() {
        if(!active())return;finished=true;forget(contextId);
        if(!episodes.get(contextId)?.failed)episodes.delete(contextId);
      },
      reportFailure:(fact:Failure)=>report(fact,false),
      reportRecovery:(fact:Recovery)=>report(fact,true),
    };
  }
  function clearContext(){generation++;context.length=0;episodes.clear();}
  return {begin,clearContext,close(){closed=true;clearContext();}};
}
