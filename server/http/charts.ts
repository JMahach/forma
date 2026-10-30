import type {createReturnReceipts} from '../services/return-receipt.ts';
import { reportServerFailure, type ServerFailureReport } from '../journal/report.ts';
import { isChartIdentifier, isOperationIdentifier, canonicalChartId, chartOutcomeTarget } from '../../shared/chart-record-contract.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccountChartBirth, ChartWriteIntent, ChartOutcome } from '../../shared/chart-record-contract.ts';
import type { createChartReturns } from '../services/chart-returns.ts';
import { CycleError, validateCycleRequest } from '../services/cycles.ts';
import { ChartCalculationError } from '../services/chart-calculation.ts';
import { AccountError, type Accounts } from '../services/accounts.ts';
import { ChartRecordError, type createChartRecords, type ChartRecordAccess } from '../services/chart-records.ts';
import { createAccountSecurity } from './account-security.ts';
import { HttpInputError, readJSONObject, sendJSON } from './json.ts';
import { requestSignal } from './request-signal.ts';
import { rejectApiMethod } from './api-methods.ts';
import {isMainReturnBody} from '../../shared/chart-return-contract.ts';

interface ChartHttpOptions {
  report?: ServerFailureReport;
  records: ReturnType<typeof createChartRecords>;
  accounts: Pick<Accounts, 'current'>;
  prepareBirth(input: unknown, options: {signal: AbortSignal;receipt?:unknown}): Promise<AccountChartBirth>;
  returns?: Pick<ReturnType<typeof createChartReturns>,'events'|'chart'|'accept'|'readPackage'>;
  issueReturnReceipt?:ReturnType<typeof createReturnReceipts>['issue'];
  origins: string[];
  now?: () => number;
}
const invalid = () => new HttpInputError('invalid_request', 400);
function identifier(value: unknown) {
  if (!isChartIdentifier(value)) throw invalid();
  return canonicalChartId(value);
}
function operationIdentifier(value: unknown) {
  if (!isOperationIdentifier(value)) throw invalid();
  return value;
}
function accountId(value: unknown) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value)) throw invalid();
  return value;
}
function text(value: unknown, maximum: number, required = false) {
  if (typeof value !== 'string' || value.length > maximum || required && !value.trim()) throw invalid();
  return value;
}
function fields(input: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw invalid();
}
function queryFields(url:URL,allowed:readonly string[]) {
  for(const key of url.searchParams.keys())if(!allowed.includes(key) || url.searchParams.getAll(key).length!==1)throw invalid();
}
function note(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  fields(input, ['value', 'seenRevision']);
  if (!Number.isSafeInteger(input.seenRevision) || (input.seenRevision as number) < 1) throw invalid();
  return {value:text(input.value, 2000), seenRevision:input.seenRevision as number};
}

function readCatalogRequest(url:URL,access:ChartRecordAccess) {
  queryFields(url,['accountId','knownMarker','marker','after','limit']);
  const after=url.searchParams.get('after')??'';if(after)identifier(after);
  return access.catalog({expectedAccountId:accountId(url.searchParams.get('accountId')),
    knownMarker:url.searchParams.get('knownMarker')??undefined,marker:url.searchParams.get('marker')??undefined,after,
    limit:url.searchParams.has('limit')?Number(url.searchParams.get('limit')):100});
}

/** Metadata sync and ready-package reads share the existing authenticated record owner. */
function readLibraryRequest(url:URL,access:ChartRecordAccess,
  returns:ChartHttpOptions['returns'],consumer:{signal:AbortSignal}) {
  if(url.pathname==='/api/charts/catalog')return readCatalogRequest(url,access);
  if(url.pathname==='/api/charts/catalog/confirm') {
    queryFields(url,['accountId','marker']);
    return access.confirmCatalog(accountId(url.searchParams.get('accountId')),url.searchParams.get('marker')??'');
  }
  const packageMatch=/^\/api\/charts\/([^/]+)\/returns\/([^/]+)\/package$/.exec(url.pathname);
  if(packageMatch) {
    if(!returns)throw new HttpInputError('chart_unavailable',503);
    queryFields(url,['accountId','sourceKey']);
    const family=packageMatch[2];if(!isMainReturnBody(family))throw invalid();
    const ref={kind:'major-returns' as const,family,sourceKey:text(url.searchParams.get('sourceKey'),512,true)};
    const id=identifier(packageMatch[1]),owner=accountId(url.searchParams.get('accountId'));
    const packet=returns.readPackage(access,id,owner,ref,consumer);
    return packet?{kind:'ready',...packet}:{kind:'not-ready',ref};
  }
}

/** HTTP never accepts calculated activations or a client-selected record owner. */
export function createChartHandler({ report, records, accounts, prepareBirth, returns, issueReturnReceipt, origins, now = Date.now }: ChartHttpOptions) {
  const security = createAccountSecurity({origins, now});
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const consumer = requestSignal(req,res);
    let current: ReturnType<Accounts['current']> = null;
    let recover: (() => ChartOutcome) | undefined;
    let proof: ReturnType<typeof security.credentials> = {bindings:{}, sessions:{}};
    function reply(status: number, body: unknown, extra: Record<string,string> = {}) {
      if (consumer.signal.aborted) return;
      const headers = current ? {'Set-Cookie': [security.cookie('session', current.session.id,
        proof.sessions[current.session.id]!, current.session.expiresAt)]} : {};
      sendJSON(res, status, body, {'Cache-Control':'private, no-store', ...headers, ...extra});
    }
    try {
      security.assertOrigin(req);
      if (rejectApiMethod(req,res,url.pathname)) return;
      proof = security.credentials(req.headers.cookie ?? '');
      const access = records.withAuthorization(() => {
        current = accounts.current(proof);
        return current ? {accountId:current.account.id} : null;
      });
      function withCurrentChart(result:ChartOutcome, expectedAccountId:string) {
        const target=chartOutcomeTarget(result);
        if(target) {
          try {
            const chart=access.getOwn(target.id,expectedAccountId);
            if(chart && chart.revision>=target.revision)return {...result,chart};
          } catch { /* Read permission or availability cannot revoke a completed operation. */ }
        }
        return result;
      }
      const publicMatch = /^\/api\/shared-charts\/([^/]+)$/.exec(url.pathname);
      if (publicMatch) {
        const chart = access.getPublic(identifier(publicMatch[1]));
        reply(chart ? 200 : 404, chart ? {chart} : {error:'not_found'}); return;
      }
      const outcomeMatch = /^\/api\/charts\/operations\/([^/]+)$/.exec(url.pathname);
      if (outcomeMatch) {
        const intent={operationId:operationIdentifier(outcomeMatch[1]), expectedAccountId:accountId(url.searchParams.get('accountId'))};
        reply(200,withCurrentChart(access.outcome(intent),intent.expectedAccountId)); return;
      }
      const library=readLibraryRequest(url,access,returns,consumer);
      if(library){reply(200,library);return;}
      if (url.pathname === '/api/charts' && req.method === 'GET') {
        const expectedAccountId = accountId(url.searchParams.get('accountId'));
        const after = url.searchParams.get('after') ?? '';
        if (after) identifier(after);
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
        reply(200, access.page({expectedAccountId, after, limit})); return;
      }
      const returnMatch = /^\/api\/charts\/([^/]+)\/returns\/(events|chart|accept)$/.exec(url.pathname);
      if (returnMatch) {
        if (!returns) { reply(503,{error:'chart_unavailable'}); return; }
        if (returnMatch[2] === 'accept') {
          const packet=await readJSONObject(req,64*1024);
          fields(packet,['expectedAccountId','action','input','result','proof']);
          if(packet.action!=='events' && packet.action!=='chart')throw invalid();
          if(!packet.input || typeof packet.input!=='object' || Array.isArray(packet.input))throw invalid();
          const input=packet.input as Record<string,unknown>;
          fields(input,['birthUtc','body','timezone',...(packet.action==='events'?['fromAge','toAge']:['eventUtc'])]);
          const request=validateCycleRequest(input,packet.action);
          const prepared={...request,...(packet.action==='events'?{timezone:typeof input.timezone==='string'?input.timezone:undefined}:{})};
          reply(200,await returns.accept(access,identifier(returnMatch[1]),accountId(packet.expectedAccountId),
            {action:packet.action,input:prepared,result:packet.result,proof:packet.proof},consumer));return;
        }
        const action = returnMatch[2] as 'events' | 'chart';
        const input = await readJSONObject(req,2048);
        fields(input,['expectedAccountId','birthUtc','body','timezone',...(action === 'events' ? ['fromAge','toAge'] : ['eventUtc'])]);
        const expectedAccountId = accountId(input.expectedAccountId), id = identifier(returnMatch[1]);
        const request = validateCycleRequest(input,action);
        const result = await returns[action](access,id,expectedAccountId,
          {...request,...(action === 'events' ? {timezone:typeof input.timezone === 'string' ? input.timezone : undefined} : {})},consumer);
        const proof=issueReturnReceipt?.(action,request,result);
        reply(200,proof?{...result,proof}:result); return;
      }
      const recordMatch = /^\/api\/charts\/([^/]+)$/.exec(url.pathname);
      const adding = url.pathname === '/api/charts/add', creating = url.pathname === '/api/charts';
      const id = !adding && recordMatch ? identifier(recordMatch[1]) : null;
      if (id && req.method === 'GET') {
        const chart = access.getOwn(id, accountId(url.searchParams.get('accountId')));
        reply(chart ? 200 : 404, chart ? {chart} : {error:'not_found'}); return;
      }
      if (!creating && !adding && !id) { reply(404,{error:'not_found'}); return; }
      const input = await readJSONObject(req, 20_000);
      const base = ['operationId','expectedAccountId'];
      fields(input, [...base, ...(adding ? ['sourceId','seenRevision'] : req.method === 'DELETE' ? [] : ['name','note','birth','calculationReceipt'])]);
      const intent: ChartWriteIntent = {operationId:operationIdentifier(input.operationId), expectedAccountId:accountId(input.expectedAccountId)};
      // A completed action is immutable; do not repeat an expensive calculation.
      recover = () => withCurrentChart(access.outcome(intent),intent.expectedAccountId);
      const prior = recover();
      if (prior.kind !== 'unknown') { reply(200,prior); return; }
      if (adding) {
        if (!Number.isSafeInteger(input.seenRevision) || (input.seenRevision as number) < 1) throw invalid();
        reply(200, withCurrentChart(access.addFromSource({...intent,sourceId:identifier(input.sourceId),seenRevision:input.seenRevision as number}),intent.expectedAccountId)); return;
      }
      if (req.method === 'DELETE') { reply(200,access.remove({...intent,chartId:id!})); return; }
      const name = creating || input.name !== undefined ? text(input.name,80,true) : undefined;
      const nextNote = creating ? text(input.note,2000) : input.note === undefined ? undefined : note(input.note);
      if (!creating && name === undefined && nextNote === undefined && input.birth === undefined) throw invalid();
      if (creating && input.birth === undefined) throw invalid();
      try {
        const birth = input.birth === undefined ? undefined : await prepareBirth(input.birth,{signal:consumer.signal,receipt:input.calculationReceipt});
        if (consumer.signal.aborted) return;
        const result = creating
          ? access.create({...intent,content:{...birth!,name:name!,note:nextNote as string}})
          : access.update({...intent,chartId:id!,...(name === undefined ? {} : {name}),
            ...(birth === undefined ? {} : {birth}),
            ...(nextNote === undefined ? {} : {note:nextNote as ReturnType<typeof note>})});
        reply(200,withCurrentChart(result,intent.expectedAccountId));
      } finally { consumer.close(); }
    } catch (error) {
      if (consumer.signal.aborted) return;
      if (recover) {
        try {
          const outcome = recover();
          if (outcome.kind !== 'unknown') { reply(200,outcome); return; }
        } catch (authorizationOrStorageError) {
          error = authorizationOrStorageError;
        }
      }
      if (error instanceof CycleError) {
        reply(error.status,{error:error.code,message:error.message,...error.details},
          error.retryAfter === null ? {} : {'Retry-After':String(error.retryAfter)});
      } else if (error instanceof ChartCalculationError) {
        reply(error.status,error.payload);
      } else if (error instanceof AccountError || error instanceof HttpInputError) {
        reply(error.status,{error:error.code});
      } else if (error instanceof ChartRecordError) {
        reply(error.code === 'auth_required' ? 401 : error.code === 'account_changed' || error.code === 'source_changed' ? 409 : error.code === 'not_found' ? 404 : error.code === 'chart_unavailable' ? 503 : 400,{error:error.code});
      } else {
        reportServerFailure(report,{event:'http_request_failed',component:'charts',reason:'unexpected'});
        reply(500,{error:'internal_error'});
      }
    } finally { consumer.close(); }
  };
}
