export const CLIENT_REPORT_MAX_BYTES=16*1024;
export const DIAGNOSTIC_BATCH_MAX_COUNT=32;
export const DIAGNOSTIC_BATCH_MAX_BYTES=64*1024;
export const CLIENT_CONTEXT_MAX_STEPS=10;
export const CLIENT_CONTEXT_MAX_BYTES=8000;

export const CLIENT_ACTIONS=['runtime','startup','restore','chart_open','calculate','chart_save','chart_delete','data_read','account_login','account_logout'] as const;
export const CLIENT_COMPONENTS=['runtime','entry','startup','chart','account','calculator','transit_day','natal_day','cycles','lifetime','storage','transport'] as const;
export const CLIENT_STAGES=['start','cache_read','storage_read','request','wait','response','validate','commit','restore','render'] as const;
export const CLIENT_REPORT_REASONS=['connection_failed','server_unavailable','server_error','request_failed','invalid_response',
  'engine_unavailable','lifetime_unavailable','cycles_unavailable','timeout','calculation_failed','invalid_calculation','unsupported_version',
  'chart_unavailable','account_unavailable','note_conflict','source_changed','not_found','invalid_request',
  'storage_unavailable','quota_exceeded','corrupt_data','restore_failed','unclassified_error','outcome_unknown'] as const;
export const CLIENT_CONTEXT_REASONS=[...CLIENT_REPORT_REASONS,'offline','cancelled','superseded','cache_miss','busy',
  'ambiguous_time','nonexistent_time','nonexistent_date','duplicate_chart','auth_required','account_changed',
  'email_required','email_invalid','code_required','code_invalid','code_expired','code_used','attempt_expired','auth_rate_limited'] as const;
type Action=typeof CLIENT_ACTIONS[number];
type Component=typeof CLIENT_COMPONENTS[number];
type Stage=typeof CLIENT_STAGES[number];
export type ClientReportReason=typeof CLIENT_REPORT_REASONS[number];
export type ClientContextReason=typeof CLIENT_CONTEXT_REASONS[number];
const browsers=['chrome','chromium','firefox','safari','edge','opera','samsung_internet'] as const;
const systems=['windows','macos','linux','android','ios','chromeos'] as const;
const devices=['desktop','tablet','phone'] as const;
const waits=['network','calculation_queue','storage'] as const;
interface Correlations {operationId?:string;requestId?:string;taskId?:string}
export interface ClientReportMetadata {
  environment:'stand'|'production';accountId:string|null;appVersion:string;
  browser?:Readonly<{name:typeof browsers[number];version?:string}>;os?:typeof systems[number];device?:typeof devices[number];
}
export interface ClientActionContext extends Correlations {action:Action;component:Component;episodeId?:string}
export interface ClientContextStep extends Correlations {
  stage:Stage;reason?:ClientContextReason;durationMs?:number;wait?:Readonly<{kind:typeof waits[number];durationMs:number}>;
}
/** Existing journal.begin port for product sources; no queue or transport access. */
export interface ClientObservation {
  reportError(error:unknown,step:Omit<ClientContextStep,'reason'>):Promise<unknown>;
  reportFailure(fact:ClientContextStep & {reason:ClientContextReason;outcome?:'failed'|'unknown'}):Promise<unknown>;
  finishSuccess():void;
}
export type ObserveClientAction=(action:ClientActionContext)=>ClientObservation|undefined;
type ReportShape={event:'client_failed';level:'error';outcome:'failed'}
  |{event:'client_outcome_unknown';level:'warn';outcome:'unknown'}|{event:'client_recovered';level:'info';outcome:'recovered'};
export type ClientReport=Readonly<ClientReportMetadata & Correlations & ReportShape & {
  schemaVersion:1;eventId:string;occurredAt:number;source:'browser';contextId:string;action:Action;component:Component;
  stage:Stage;reason:ClientReportReason;durationMs?:number;wait?:ClientContextStep['wait'];context?:readonly Readonly<ClientContextStep>[];
  repeatCount?:number;firstOccurredAt?:number;lastOccurredAt?:number;
}>;
export type DiagnosticResult=Readonly<{eventId:string} & (
  {status:'accepted';receivedAt:number;duplicate:boolean}
  |{status:'invalid';final:true;reason:'invalid_report'|'unsupported_schema'|'report_too_large'|'event_id_conflict'}
  |{status:'retryable';reason:'unavailable'|'rate_limited'|'ownership_unverified'|'auth_required'})>;
export type DiagnosticResponse=Readonly<{schemaVersion:1;results:readonly DiagnosticResult[]}>;
const encoder=new TextEncoder();
export const clientReportBytes=(value:ClientReport)=>encoder.encode(JSON.stringify(value)).byteLength;
const known=<T extends string>(values:readonly T[],value:unknown):value is T=>typeof value==='string' && values.includes(value as T);
const uuid=(value:unknown):value is string=>typeof value==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const timestamp=(value:unknown):value is number=>typeof value==='number' && Number.isSafeInteger(value) && value>=0 && value<=8.64e15;
const duration=(value:unknown):value is number=>typeof value==='number' && Number.isFinite(value) && value>=0 && value<=Number.MAX_SAFE_INTEGER;
const ids=['operationId','requestId','taskId'] as const;
const metadataKeys=['environment','accountId','appVersion','browser','os','device'] as const;
function record(value:unknown,allowed:readonly string[],required:readonly string[]=[]) {
  if(!value || typeof value!=='object' || Array.isArray(value))return null;
  const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype && prototype!==null)return null;
  const fields=Object.getOwnPropertyDescriptors(value);
  if(Object.getOwnPropertySymbols(value).length || Object.entries(fields).some(([key,d])=>!allowed.includes(key) || !d.enumerable || !('value' in d))
    || required.some(key=>!Object.hasOwn(fields,key)))return null;
  return Object.fromEntries(Object.entries(fields).map(([key,d])=>[key,d.value])) as Record<string,unknown>;
}
function list(value:unknown,max:number):unknown[]|null {
  if(!Array.isArray(value) || Object.getPrototypeOf(value)!==Array.prototype || value.length>max || Object.getOwnPropertySymbols(value).length)return null;
  const fields=Object.getOwnPropertyDescriptors(value);
  if(Object.keys(fields).length!==value.length+1)return null;
  const result=[];for(let i=0;i<value.length;i++){const field=fields[String(i)];if(!field?.enumerable || !('value' in field))return null;result.push(field.value);}
  return result;
}
function correlations(v:Record<string,unknown>) {return ids.every(key=>!Object.hasOwn(v,key) || uuid(v[key]));}
function measurement(v:Record<string,unknown>) {
  if(Object.hasOwn(v,'durationMs') && !duration(v.durationMs))return false;
  if(Object.hasOwn(v,'wait')) {
    const wait=record(v.wait,['kind','durationMs'],['kind','durationMs']);
    if(!wait || !known(waits,wait.kind) || !duration(wait.durationMs))return false;
    v.wait=Object.freeze(wait);
  }
  return true;
}
export function parseClientReportMetadata(value:unknown):Readonly<ClientReportMetadata>|null {
  try {
    const v=record(value,metadataKeys,['environment','accountId','appVersion']);if(!v)return null;
    if(!['stand','production'].includes(v.environment as string) || v.accountId!==null && (typeof v.accountId!=='string' || !/^[1-9][0-9]{0,19}$/.test(v.accountId))
      || typeof v.appVersion!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(v.appVersion))return null;
    if(Object.hasOwn(v,'browser')) {
      const browser=record(v.browser,['name','version'],['name']);if(!browser || !known(browsers,browser.name))return null;
      if(Object.hasOwn(browser,'version') && (typeof browser.version!=='string' || browser.version.length>32 || !/^\d+(?:\.\d+){0,3}$/.test(browser.version)))return null;
      v.browser=Object.freeze(browser);
    }
    if(Object.hasOwn(v,'os') && !known(systems,v.os) || Object.hasOwn(v,'device') && !known(devices,v.device))return null;
    return Object.freeze(v) as unknown as Readonly<ClientReportMetadata>;
  }catch{return null;}
}
export function parseClientActionContext(value:unknown):Readonly<ClientActionContext>|null {
  try {
    const v=record(value,['action','component','episodeId',...ids],['action','component']);
    if(!v || !known(CLIENT_ACTIONS,v.action) || !known(CLIENT_COMPONENTS,v.component) || !correlations(v)
      || Object.hasOwn(v,'episodeId') && !uuid(v.episodeId))return null;
    return Object.freeze(v) as unknown as Readonly<ClientActionContext>;
  }catch{return null;}
}
export function parseClientContextStep(value:unknown):Readonly<ClientContextStep>|null {
  try {
    const v=record(value,['stage','reason','durationMs','wait',...ids],['stage']);
    if(!v || !known(CLIENT_STAGES,v.stage) || !correlations(v) || !measurement(v)
      || Object.hasOwn(v,'reason') && !known(CLIENT_CONTEXT_REASONS,v.reason))return null;
    return Object.freeze(v) as unknown as Readonly<ClientContextStep>;
  }catch{return null;}
}
/** A strict wire boundary; arbitrary error objects and their nested data never enter a report. */
export function parseClientReport(value:unknown):ClientReport|null {
  try {
    const core=['schemaVersion','eventId','occurredAt','source','event','level','outcome','contextId','action','component','stage','reason'];
    const repeats=['repeatCount','firstOccurredAt','lastOccurredAt'];
    const v=record(value,[...core,...metadataKeys,...ids,...repeats,'context','durationMs','wait'],[...core,'environment','accountId','appVersion']);
    if(!v || v.schemaVersion!==1 || v.source!=='browser' || !uuid(v.eventId) || !uuid(v.contextId) || !timestamp(v.occurredAt)
      || !known(CLIENT_ACTIONS,v.action) || !known(CLIENT_COMPONENTS,v.component) || !known(CLIENT_STAGES,v.stage)
      || !known(CLIENT_REPORT_REASONS,v.reason) || !correlations(v) || !measurement(v))return null;
    if(repeats.some(key=>Object.hasOwn(v,key)) && (typeof v.repeatCount!=='number' || !Number.isSafeInteger(v.repeatCount) || v.repeatCount<1
      || !timestamp(v.firstOccurredAt) || !timestamp(v.lastOccurredAt)))return null;
    const shapes={client_failed:['error','failed'],client_outcome_unknown:['warn','unknown'],client_recovered:['info','recovered']} as const;
    if(typeof v.event!=='string' || !Object.hasOwn(shapes,v.event))return null;
    const [level,outcome]=shapes[v.event as keyof typeof shapes];if(v.level!==level || v.outcome!==outcome)return null;
    const metadata=parseClientReportMetadata(Object.fromEntries(metadataKeys.filter(key=>Object.hasOwn(v,key)).map(key=>[key,v[key]])));
    if(!metadata)return null;Object.assign(v,metadata);
    if(Object.hasOwn(v,'context')) {
      const values=list(v.context,CLIENT_CONTEXT_MAX_STEPS);if(!values)return null;
      const context=values.map(parseClientContextStep);if(context.some(step=>!step) || encoder.encode(JSON.stringify(context)).byteLength>CLIENT_CONTEXT_MAX_BYTES)return null;
      v.context=Object.freeze(context);
    }
    const result=Object.freeze(v) as unknown as ClientReport;
    return clientReportBytes(result)<=CLIENT_REPORT_MAX_BYTES?result:null;
  }catch{return null;}
}
/** HTTP status alone never proves acceptance or final invalidity of an individual report. */
export function parseDiagnosticResponse(value:unknown):DiagnosticResponse|null {
  try {
    const v=record(value,['schemaVersion','results'],['schemaVersion','results']);if(!v || v.schemaVersion!==1)return null;
    const values=list(v.results,DIAGNOSTIC_BATCH_MAX_COUNT);if(!values)return null;
    const seen=new Set<string>(),results:DiagnosticResult[]=[];
    for(const value of values) {
      const header=record(value,['eventId','status','receivedAt','duplicate','final','reason'],['eventId','status']);
      if(!header || !uuid(header.eventId) || seen.has(header.eventId))return null;seen.add(header.eventId);
      let result:Record<string,unknown>|null=null;
      if(header.status==='accepted') {
        result=record(value,['eventId','status','receivedAt','duplicate'],['eventId','status','receivedAt','duplicate']);
        if(!result || !timestamp(result.receivedAt) || typeof result.duplicate!=='boolean')return null;
      }else if(header.status==='invalid') {
        result=record(value,['eventId','status','final','reason'],['eventId','status','final','reason']);
        if(!result || result.final!==true || !known(['invalid_report','unsupported_schema','report_too_large','event_id_conflict'],result.reason))return null;
      }else if(header.status==='retryable') {
        result=record(value,['eventId','status','reason'],['eventId','status','reason']);
        if(!result || !known(['unavailable','rate_limited','ownership_unverified','auth_required'],result.reason))return null;
      }else return null;
      results.push(Object.freeze(result) as DiagnosticResult);
    }
    const response=Object.freeze({schemaVersion:1 as const,results:Object.freeze(results)});
    return encoder.encode(JSON.stringify(response)).byteLength<=DIAGNOSTIC_BATCH_MAX_BYTES?response:null;
  }catch{return null;}
}

// Invoke the platform's branded numeric accessor, never a property/getter on
// the supplied exception. Native AbortError has legacy code 20 in the platform.
const nativeExceptionCode=typeof DOMException==='function'?Object.getOwnPropertyDescriptor(DOMException.prototype,'code')?.get:undefined;
/** Only a recognized source code crosses the boundary; no stringification of exceptions. */
export function clientFailureReason(error:unknown):ClientContextReason {
  try {
    if(!error || typeof error!=='object')return 'unclassified_error';
    const field=Object.getOwnPropertyDescriptor(error,'code');
    if(field && 'value' in field){
      if(field.value==='write_unknown')return 'outcome_unknown';
      if(CLIENT_CONTEXT_REASONS.includes(field.value))return field.value;
    }
    const name=Object.getOwnPropertyDescriptor(error,'name');
    if(name && 'value' in name && name.value==='AbortError')return 'cancelled';
    if(nativeExceptionCode?.call(error)===20)return 'cancelled';
    return 'unclassified_error';
  }catch{return 'unclassified_error';}
}
