import { isIP } from 'node:net';
import { parseClientReport, type ClientReport } from '../../shared/client-report-contract.ts';

export type HttpFailureComponent = 'routing' | 'public_files' | 'cities' | 'calculator' | 'account' | 'charts' | 'cycles' | 'lifetime' | 'transit_day' | 'natal_day';
export type StartupComponent = HttpFailureComponent | 'configuration' | 'listener';
const systemReasons=['exit','signal','oom','timeout','resources','watchdog','protocol','start_limit'] as const;
const serviceReasons={
 lifetime_prepare:['spawn','process'],return_index_prepare:['spawn','process'],postfix:['process','cleanup'],
 application_service:systemReasons,nginx_service:systemReasons,postfix_service:systemReasons,
 nginx_proxy:['bad_gateway','gateway_timeout'],
} as const;
export type ServiceFailure = {[K in keyof typeof serviceReasons]:{component:K;reason:typeof serviceReasons[K][number]}}[keyof typeof serviceReasons];
export type ServerFailure =
 | {event:'startup_failed'; component:StartupComponent; reason:'unexpected'}
 | {event:'http_request_failed'; component:HttpFailureComponent; reason:'unexpected'}
 | {event:'prepared_data_failed'; component:'lifetime'; reason:'open'|'read'};
export type ServerFailureReport = (fact:ServerFailure & {occurredAt:number}) => unknown;

export interface ServerJournalEvent {
 schemaVersion:1; eventId:string; occurredAt:number; environment:'stand'|'production';
 source:'account'|'mail'|'runtime'|'calculation'; event:string; level:'info'|'warn'|'error'; outcome:string;
 contextId?:string; accountId?:string; codeId?:string; recipient?:string; reason?:string; component?:StartupComponent|ServiceFailure['component'];
}

export type BrowserJournalEvent = ClientReport & Readonly<{deliveryIp:string}>;
export type JournalEvent = ServerJournalEvent | BrowserJournalEvent;

export function isJournalDeliveryIp(value:unknown):value is string {
 return typeof value==='string' && !value.includes('%') && isIP(value)!==0;
}

/** The caller supplies the connection IP separately; client fields never supply or override it. */
export function browserJournalEvent(report:unknown,deliveryIp:unknown):BrowserJournalEvent|null {
 const event=parseClientReport(report);
 if(!event || !isJournalDeliveryIp(deliveryIp))return null;
 return Object.freeze({...event,deliveryIp});
}

type Shape = readonly [ServerJournalEvent['source'], ServerJournalEvent['level'], string, readonly string[], readonly string[]];
const shapes: Record<string, Shape> = {
 service_failed:['runtime','error','failed',['component','reason'],[]],
 startup_failed:['runtime','error','failed',['component','reason'],[]],
 http_request_failed:['runtime','error','failed',['component','reason'],[]],
 prepared_data_failed:['runtime','error','failed',['component','reason'],[]],
 calculation_failed:['calculation','error','failed',['component','reason'],[]],
 auth_login:['account','info','succeeded',['accountId','contextId'],[]],
 auth_logout:['account','info','succeeded',['accountId','contextId'],[]],
 mail_queued:['mail','info','pending',['codeId','contextId','recipient'],[]],
 mail_handed_off:['mail','info','handed_off',['codeId','contextId','recipient','reason'],[]],
 mail_rejected:['mail','warn','rejected',['codeId','contextId','recipient','reason'],[]],
 mail_expired:['mail','info','expired',['codeId','contextId','recipient','reason'],[]],
 mail_outcome_unknown:['mail','warn','unknown',['codeId','contextId','recipient','reason'],[]],
 mail_attempt_failed:['mail','warn','retryable',['codeId','contextId'],['recipient','reason']],
 mail_enqueue_failed:['mail','warn','failed',['contextId'],['codeId','recipient','reason']],
 mail_cancel_failed:['mail','warn','unknown',['contextId'],['codeId','recipient','reason']],
 mail_queue_unavailable:['mail','error','unavailable',[],[]],
 account_cleanup_failed:['runtime','error','failed',[],[]],
 chart_cleanup_failed:['runtime','error','failed',[],[]],
 library_preparation_failed:['runtime','error','failed',['reason'],[]],
};
const core = ['schemaVersion','eventId','occurredAt','environment','source','event','level','outcome'];
const opaqueId = (value: unknown): value is string => typeof value==='string'
 && /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(value);
const reasons: Record<string, RegExp> = {
 library_preparation_failed:/^(?:prepare|schedule)$/,
 startup_failed:/^unexpected$/,
 http_request_failed:/^unexpected$/,
 prepared_data_failed:/^(?:open|read)$/,
 calculation_failed:/^(?:process|timeout|invalid_result)$/,
 mail_handed_off:/^dsn:2\.\d{1,3}\.\d{1,3}$/,
 mail_rejected:/^(?:delivery_rejected|dsn:5\.\d{1,3}\.\d{1,3})$/,
 mail_expired:/^(?:expired|dsn:4\.4\.7)$/,
 mail_outcome_unknown:/^outcome_unknown$/,
 mail_attempt_failed:/^(?:attempt_failed|dsn:4\.\d{1,3}\.\d{1,3})$/,
 mail_enqueue_failed:/^enqueue_failed$/,
 mail_cancel_failed:/^cancel_failed$/,
};
/** The journal accepts explicit facts, never a raw exception/request/message object. */
export function parseJournalEvent(value: unknown): JournalEvent | null {
 if (!value || typeof value!=='object' || Array.isArray(value)) return null;
 const prototype=Object.getPrototypeOf(value);
 if (prototype!==Object.prototype && prototype!==null) return null;
 const descriptors=Object.getOwnPropertyDescriptors(value);
 if (Object.getOwnPropertySymbols(value).length || Object.values(descriptors).some(field=>!field.enumerable || !('value' in field))) return null;
 const v=value as Record<string,unknown>;
 if(v.source==='browser') {
  const {deliveryIp,...report}=v;
  return browserJournalEvent(report,deliveryIp);
 }
 if(v.schemaVersion!==1 || typeof v.event!=='string' || !Object.hasOwn(shapes,v.event))return null;
 const [source,level,outcome,required,optional]=shapes[v.event];
 const allowed=new Set([...core,...required,...optional]);
 if(Object.keys(descriptors).some(key=>!allowed.has(key)) || [...core,...required].some(key=>!Object.hasOwn(v,key)))return null;
 if(v.source!==source || v.level!==level || v.outcome!==outcome
  || v.environment!=='stand' && v.environment!=='production'
  || typeof v.eventId!=='string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(v.eventId)
  || typeof v.occurredAt!=='number' || !Number.isSafeInteger(v.occurredAt)
  || v.occurredAt<0 || v.occurredAt>8.64e15)return null;
 for(const key of ['contextId','codeId'])if(Object.hasOwn(v,key) && !opaqueId(v[key]))return null;
 if(Object.hasOwn(v,'accountId') && (typeof v.accountId!=='string' || !/^[1-9][0-9]{0,19}$/.test(v.accountId)))return null;
 if(Object.hasOwn(v,'recipient') && (typeof v.recipient!=='string' || !v.recipient.includes('@')
  || v.recipient.trim()!==v.recipient || /[\s<>\x00-\x1f\x7f]/u.test(v.recipient)
  || v.recipient.length>254 || Buffer.byteLength(v.recipient,'utf8')>1024))return null;
 if(Object.hasOwn(v,'component')) {
  const components = v.event==='service_failed' ? Object.keys(serviceReasons)
   : v.event==='startup_failed'
   ? ['configuration','listener','routing','public_files','cities','calculator','account','charts','cycles','lifetime','transit_day','natal_day']
   : v.event==='http_request_failed'
   ? ['routing','public_files','cities','calculator','account','charts','cycles','lifetime','transit_day','natal_day']
   : v.event==='prepared_data_failed' ? ['lifetime'] : ['calculator','transit_day','natal_day','cycles'];
  if(!components.includes(v.component as string))return null;
 }
 if(v.event==='service_failed' && !(serviceReasons[v.component as keyof typeof serviceReasons] as readonly unknown[]).includes(v.reason))return null;
 if(v.event!=='service_failed' && Object.hasOwn(v,'reason') && (typeof v.reason!=='string'
  || !reasons[v.event]?.test(v.reason)))return null;
 return Object.freeze({...v}) as unknown as JournalEvent;
}

/** Add standard metadata at composition; the source supplies only its own facts. */
export function completeJournalEvent(fact: unknown, defaults: {
 environment:JournalEvent['environment']; occurredAt:number; eventId:string;
}):ServerJournalEvent|null {
 if(!fact || typeof fact!=='object' || Array.isArray(fact))return null;
 const fields=Object.getOwnPropertyDescriptors(fact);
 const allowed=new Set(['event','eventId','occurredAt','contextId','accountId','codeId','recipient','reason','component']);
 if(Object.getOwnPropertySymbols(fact).length || Object.entries(fields).some(([key,d])=>!allowed.has(key) || !d.enumerable || !('value' in d)))return null;
 const v=fact as Record<string,unknown>;
 if(typeof v.event!=='string' || !Object.hasOwn(shapes,v.event))return null;
 const [source,level,outcome]=shapes[v.event];
 const terminalMail=['mail_handed_off','mail_rejected','mail_expired','mail_outcome_unknown'].includes(v.event);
 if((source==='account' || terminalMail) && typeof v.occurredAt!=='number')return null;
 if(terminalMail && typeof v.eventId!=='string')return null;
 return parseJournalEvent({schemaVersion:1, ...defaults, source,level,outcome,...v}) as ServerJournalEvent|null;
}
