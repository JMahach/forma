import { parseClientReport, parseDiagnosticResponse, DIAGNOSTIC_BATCH_MAX_BYTES, DIAGNOSTIC_BATCH_MAX_COUNT,
  type ClientReport } from '../../shared/client-report-contract.ts';
import { parseDiagnosticProof, DIAGNOSTIC_PROOF_HEADER } from '../../shared/account-contract.ts';
import { fetchResource, retryAfterMilliseconds } from './http-transport.ts';

export interface DiagnosticRequest {readonly schemaVersion:1;readonly reports:readonly ClientReport[]}
/** Only a bounded, checked per-ID response is an ACK. HTTP and transport failures reject. */
export type DiagnosticTransport=(body:DiagnosticRequest,options:{signal:AbortSignal;exit:boolean;diagnosticProof?:string})=>Promise<unknown>;
const encoder=new TextEncoder();
function serialize(input:unknown) {
  const invalid=()=>new Error('Invalid diagnostic request');
  if(!input || typeof input!=='object' || Array.isArray(input)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw invalid();
  const fields=Object.getOwnPropertyDescriptors(input);
  if(Object.getOwnPropertySymbols(input).length || Object.keys(fields).length!==2
    || !['schemaVersion','reports'].every(key=>fields[key]?.enumerable && 'value' in fields[key])
    || fields.schemaVersion!.value!==1)throw invalid();
  const values:unknown=fields.reports!.value;
  if(!Array.isArray(values) || Object.getPrototypeOf(values)!==Array.prototype || values.length>DIAGNOSTIC_BATCH_MAX_COUNT
    || Object.getOwnPropertySymbols(values).length)throw invalid();
  const entries=Object.getOwnPropertyDescriptors(values);
  if(Object.keys(entries).length!==values.length+1)throw invalid();
  const reports:ClientReport[]=[],ids=new Set<string>();
  for(let i=0;i<values.length;i++) {
    const field=entries[String(i)];if(!field?.enumerable || !('value' in field))throw invalid();
    const report=parseClientReport(field.value);if(!report || ids.has(report.eventId))throw invalid();
    reports.push(report);ids.add(report.eventId);
  }
  const text=JSON.stringify({schemaVersion:1,reports});
  if(encoder.encode(text).byteLength>DIAGNOSTIC_BATCH_MAX_BYTES)throw invalid();
  return {text,ids,reports};
}

export function createDiagnosticClient({fetch:send=fetchResource}:{fetch?:typeof globalThis.fetch}={}):DiagnosticTransport {
  return async(input,{signal,exit,diagnosticProof})=>{
    signal.throwIfAborted();const {text,ids,reports}=serialize(input);
    if(diagnosticProof!==undefined){const proof=parseDiagnosticProof(diagnosticProof);
      if(!proof || reports.some(report=>report.accountId!==null && report.accountId!==proof.accountId))throw new Error('Invalid diagnostic origin');}
    const controller=new AbortController();let reject!:(reason:unknown)=>void;
    const interrupted=new Promise<never>((_resolve,no)=>{reject=no;});interrupted.catch(()=>{});
    const abort=()=>{controller.abort(signal.reason);reject(signal.reason);};
    signal.addEventListener('abort',abort,{once:true});
    let response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    try {
      signal.throwIfAborted();
      response=await Promise.race([send('/api/diagnostics',{method:'POST',credentials:'same-origin',
        headers:{'Content-Type':'application/json',...(diagnosticProof?{[DIAGNOSTIC_PROOF_HEADER]:diagnosticProof}:{})},body:text,signal:controller.signal,keepalive:exit,redirect:'error',cache:'no-store'}),interrupted]);
      signal.throwIfAborted();
      if(!response.ok)throw Object.assign(new Error('Diagnostic HTTP request failed'),{status:response.status,
        retryAfterMs:retryAfterMilliseconds(response.headers.get('Retry-After'))});
      const length=response.headers.get('Content-Length');
      if(length!==null && /^\d+$/.test(length) && Number(length)>DIAGNOSTIC_BATCH_MAX_BYTES)throw new Error('Diagnostic response too large');
      if(!response.body)throw new Error('Invalid diagnostic response');
      reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});
      let bytes=0,content='';
      while(true) {
        const chunk=await Promise.race([reader.read(),interrupted]);signal.throwIfAborted();
        if(chunk.done)break;
        bytes+=chunk.value.byteLength;
        if(bytes>DIAGNOSTIC_BATCH_MAX_BYTES)throw new Error('Diagnostic response too large');
        content+=decoder.decode(chunk.value,{stream:true});
      }
      content+=decoder.decode();signal.throwIfAborted();
      const result=parseDiagnosticResponse(JSON.parse(content));
      if(!result || result.results.some(entry=>!ids.has(entry.eventId)))throw new Error('Invalid diagnostic response');
      signal.throwIfAborted();return result;
    }finally {
      signal.removeEventListener('abort',abort);
      try{if(reader){void reader.cancel().catch(()=>{});reader.releaseLock();}else if(response?.body)void response.body.cancel().catch(()=>{});}catch{}
      // Streaming bypasses the shared transport's json/text wrappers. Ending our
      // request signal also releases its stand gate and cancels any unread body.
      controller.abort();
    }
  };
}
