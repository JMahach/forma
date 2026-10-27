import { DIAGNOSTIC_PROOF_HEADER } from '../../shared/account-contract.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isJournalDeliveryIp } from '../journal/events.ts';
import { parseClientReport, CLIENT_REPORT_MAX_BYTES, DIAGNOSTIC_BATCH_MAX_BYTES, DIAGNOSTIC_BATCH_MAX_COUNT,
 type ClientReport, type DiagnosticResult } from '../../shared/client-report-contract.ts';
import type { Accounts } from '../services/accounts.ts';
import type { JournalResult } from '../journal/policy.ts';
import { accountClientIp } from './accounts.ts';
import { createAccountSecurity } from './account-security.ts';
import { HttpInputError, readJSONObject, sendJSON } from './json.ts';

interface DiagnosticHttpOptions {
 origins:string[];trustLoopbackProxy?:boolean;
 accounts:Pick<Accounts,'diagnosticOwner'>;
 write:(report:ClientReport & {deliveryIp:string})=>Promise<JournalResult>;
}
/** Bounded transport admission; the journal runtime reserves this envelope inside its total budget. */
export const DIAGNOSTIC_HTTP_CONCURRENCY=8;
// Includes eight bounded bodies, normalized JSON structures and the peak synchronous parser allocation.
export const DIAGNOSTIC_HTTP_RESERVED_BYTES=16*1024*1024;
const uuid=(value:unknown):value is string=>typeof value==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
type ValidatedReport={report:ClientReport}|{result:DiagnosticResult};
/** No raw parsed request survives into the asynchronous writer loop. */
async function readValidatedBatch(req:IncomingMessage):Promise<ValidatedReport[]> {
 const input=await readJSONObject(req,DIAGNOSTIC_BATCH_MAX_BYTES);
 if(Object.keys(input).some(key=>!['schemaVersion','reports'].includes(key)) || input.schemaVersion!==1
   || !Array.isArray(input.reports) || input.reports.length>DIAGNOSTIC_BATCH_MAX_COUNT)throw new HttpInputError('invalid_request',400);
 const seen=new Set<string>();
 return input.reports.map((value:unknown):ValidatedReport=>{
  if(!value || typeof value!=='object' || !('eventId' in value) || !uuid(value.eventId) || seen.has(value.eventId))throw new HttpInputError('invalid_request',400);
  const eventId=value.eventId;seen.add(eventId);
  const report=parseClientReport(value);
  if(report)return{report};
  const reason=!('schemaVersion' in value) || value.schemaVersion!==1?'unsupported_schema'
   :Buffer.byteLength(JSON.stringify(value))>CLIENT_REPORT_MAX_BYTES?'report_too_large':'invalid_report';
  return{result:{eventId,status:'invalid',final:true,reason}};
 });
}
export function createDiagnosticHandler({origins,accounts,write,trustLoopbackProxy=false}:DiagnosticHttpOptions) {
 const security=createAccountSecurity({origins}),clientIp=accountClientIp(trustLoopbackProxy);
 let admitted=0;
 return async(req:IncomingMessage,res:ServerResponse)=>{
  let ownsSlot=false;
  try {
   security.assertOrigin(req);
   if(req.method!=='POST'){sendJSON(res,405,{error:'method_not_allowed'},{Allow:'POST'});return;}
   if(admitted>=DIAGNOSTIC_HTTP_CONCURRENCY){sendJSON(res,429,{error:'diagnostics_busy'},{'Retry-After':'1'});return;}
   admitted++;ownsSlot=true;
   const reports=await readValidatedBatch(req);
   const deliveryIp=clientIp(req);
   if(!isJournalDeliveryIp(deliveryIp)){sendJSON(res,503,{error:'diagnostics_unavailable'});return;}
   const proof=security.credentials(req.headers.cookie??'');
   const results:DiagnosticResult[]=[];
   for(const item of reports) {
    if('result' in item){results.push(item.result);continue;}
    const parsed=item.report,eventId=parsed.eventId;
    if(parsed.accountId!==null) {
     let owner:string|null=null;
     // Diagnostics must not refresh a session or gain access to personal records.
     try{owner=accounts.diagnosticOwner(proof,req.headers[DIAGNOSTIC_PROOF_HEADER.toLowerCase()]);}catch{/* Retain the report when identity cannot be established. */}
     if(owner!==parsed.accountId){results.push({eventId,status:'retryable',reason:'ownership_unverified'});continue;}
    }
    try {
     const result=await write({...parsed,deliveryIp});
     if(result.status==='accepted')results.push({eventId,...result});
     else if(result.status==='conflict')results.push({eventId,status:'invalid',final:true,reason:'event_id_conflict'});
     else if(result.status==='invalid')results.push({eventId,status:'invalid',final:true,
      reason:result.reason==='event_too_large'?'report_too_large':'invalid_report'});
     else results.push({eventId,status:'retryable',reason:'unavailable'});
    }catch{results.push({eventId,status:'retryable',reason:'unavailable'});}
   }
   sendJSON(res,200,{schemaVersion:1,results},{'Cache-Control':'private, no-store'});
  }catch(error) {
   if(error instanceof HttpInputError)sendJSON(res,error.status,{error:error.code});
   else sendJSON(res,503,{error:'diagnostics_unavailable'});
  }finally{if(ownsSlot)admitted--;}
 };
}
