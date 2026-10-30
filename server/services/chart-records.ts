import {canStoreServerReturn,returnSourceKey,type PackageRef} from '../../shared/library-package-contract.ts';
import {validCycleResult,type CycleInput,type CycleResult} from '../../shared/cycles-format.ts';
import { canonicalChartId, isOperationIdentifier, chartOutcomeTarget, CHART_ID_MIN_DIGITS, CHART_ID_MAX_DIGITS } from '../../shared/chart-record-contract.ts';
import {isMainReturnBody} from '../../shared/chart-return-contract.ts';
import { randomInt } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {isLibraryCatalogMarker,type LibraryCatalogReply,type LibraryCatalogConfirmation} from '../../shared/library-catalog-contract.ts';
import type { Database } from '../storage/database.ts';
import { createChartRecordStorage } from '../storage/chart-records.ts';
import { CHART_POLICY } from './chart-policy.ts';
import type { AccountChart, AccountChartContent, AccountChartBirth, PublicAccountChart, ChartWriteIntent, ChartUpdate,
  ChartWriteOutcome, ChartOutcome } from '../../shared/chart-record-contract.ts';

export class ChartRecordError extends Error {
  constructor(code: 'auth_required' | 'account_changed' | 'invalid_chart' | 'invalid_operation' | 'chart_unavailable' | 'not_found' | 'source_changed') {
    super(code); this.code = code;
  }
  readonly code: 'auth_required' | 'account_changed' | 'invalid_chart' | 'invalid_operation' | 'chart_unavailable' | 'not_found' | 'source_changed';
}
const contentFields = ['name','note','birthDate','birthTime','birthPlace','source','personality','design','activations',
  'utc','timezone','utcOffset','fold','designUtc','designArcResidualDegrees','engine','ephemeris','timezoneDatabase',
  'nodeModel','zodiac','verification','cityId','city'] as const;
function contentOf(input: AccountChartContent): AccountChartContent {
  return structuredClone(Object.fromEntries(contentFields.filter(key => Object.hasOwn(input, key))
    .map(key => [key, input[key]]))) as AccountChartContent;
}
function publicContent(input: AccountChartContent) {
  const {note: _note, ...visible} = contentOf(input);
  return visible;
}
function birthContent(input: AccountChartBirth) {
  const {name: _name, note: _note, ...birth} = contentOf({...input,name:'',note:''});
  return birth;
}
function identity(content: AccountChartContent) {
  const milliseconds = Date.parse(content.utc);
  if (typeof content.name !== 'string' || !content.name.replace(/\s/gu, '') || content.name.length > 80
    || typeof content.note !== 'string' || content.note.length > 2000
    || !Number.isFinite(milliseconds)
    || !['calculated','transit'].includes(content.source)) throw new ChartRecordError('invalid_chart');
  return {nameKey: content.name.replace(/\s/gu, '').toLowerCase(), birthMinute: Math.floor(milliseconds / 60_000)};
}
function operationId(value: string) {
  if (!isOperationIdentifier(value)) {
    throw new ChartRecordError('invalid_operation');
  }
}

// Decimal text preserves the full random identifier without JavaScript number rounding.
function newChartId(digits = CHART_ID_MIN_DIGITS) {
  let id = String(randomInt(1, 10));
  for (let digit = 1; digit < digits; digit++) id += String(randomInt(0, 10));
  return id;
}

export interface ChartReturnQuery {
  chartId:string; expectedAccountId:string; birth:AccountChartBirth;
  action:'events'|'chart'; input:CycleInput;
}
export interface PreparationNotice {kind:'queued'|'removed';chartId:string}
type PreparationListener=(notice:PreparationNotice)=>void;
type Authorize=(serverTime:number,options?:{renew?:boolean})=>{accountId:string}|null;

/** Mutable observation accompanies a receipt; it never changes the stored operation fact. */
function observeOutcome(storage:ReturnType<typeof createChartRecordStorage>,owner:string,result:ChartOutcome):
 ChartOutcome & {catalogMarker:string;chart?:AccountChart} {
  const target=chartOutcomeTarget(result) ?? (result.kind==='deleted' || result.kind==='absent'
    || result.kind==='rejected' && result.code==='not_found'
    ?{id:result.chartId,revision:1}:null);
  if(!target)return {...result,catalogMarker:storage.catalog.marker(owner)};
  const {chart,catalogMarker}=storage.observeOwn(owner,target.id);
  return {...result,catalogMarker,...(chart && chart.revision>=target.revision?{chart}:{})};
}

interface CatalogQuery {expectedAccountId:string;knownMarker?:string;marker?:string;after?:string;limit?:number}
function validateCatalogPosition({knownMarker,marker,after}:CatalogQuery) {
  for(const value of [knownMarker,marker])if(value!==undefined && !isLibraryCatalogMarker(value))throw new ChartRecordError('invalid_operation');
  if(knownMarker!==undefined && marker!==undefined || after && marker===undefined)throw new ChartRecordError('invalid_operation');
}
function validateCatalogQuery(input:CatalogQuery) {
  const {limit=100,after=''}=input;
  if(!Number.isInteger(limit) || limit<1 || limit>100 || typeof after!=='string' || after.length>80)throw new ChartRecordError('invalid_operation');
  validateCatalogPosition(input);
}
function readCatalog(catalog:ReturnType<typeof createChartRecordStorage>['catalog'],owner:string,{knownMarker,marker,after='',limit=100}:CatalogQuery):LibraryCatalogReply {
  const current=catalog.marker(owner),state={accountId:owner,marker:current};
  if(marker!==undefined && marker!==current)return {...state,kind:'restart'};
  if(knownMarker===current)return {...state,kind:'unchanged'};
  const rows=catalog.page(owner,after,limit+1),entries=rows.slice(0,limit);
  return {...state,kind:'page',entries,nextCursor:rows.length>limit?entries.at(-1)!.id:null};
}
function readOwnedFamily(storage:ReturnType<typeof createChartRecordStorage>,owner:string,id:string,ref:Extract<PackageRef,{kind:'major-returns'}>) {
  if(ref.kind!=='major-returns' || !isMainReturnBody(ref.family))throw new ChartRecordError('invalid_chart');
  const chart=storage.get(owner,id);
  if(!chart)throw new ChartRecordError('not_found');
  if(chart.source!=='calculated')throw new ChartRecordError('invalid_chart');
  const source={birthUtc:chart.utc,timezone:chart.timezone||'UTC'};
  if(returnSourceKey(source)!==ref.sourceKey)throw new ChartRecordError('source_changed');
  return {source,...storage.readReturnFamily(id,ref.family)};
}

/** Receives trusted, prepared calculation data. HTTP must not forward user-supplied calculated numbers here. */
export function createChartRecords({ database, authorize: initialAuthorize, now = Date.now, newId = newChartId }: {
  database: Database;
  authorize: Authorize;
  now?: () => number; newId?: (digits?: number) => string;
}) {
  const storage = createChartRecordStorage(database,canonicalChartId);
  const preparationListeners=new Set<PreparationListener>();
  function allocateId() {
    for(let digits=CHART_ID_MIN_DIGITS;digits<=CHART_ID_MAX_DIGITS;digits++) {
      for(let attempt=0;attempt<32;attempt++) {
        const id=newId(digits);
        if(!storage.identifierUsed(id))return id;
      }
    }
    throw new ChartRecordError('chart_unavailable');
  }
  function withAuthorization(authorize: Authorize) {
  function account(time: number, expected?: string, options?:{renew?:boolean}) {
    const current = authorize(time,options);
    if (!current) throw new ChartRecordError('auth_required');
    if (expected !== undefined && current.accountId !== expected) throw new ChartRecordError('account_changed');
    return current.accountId;
  }
  function write(intent: ChartWriteIntent, apply: (accountId: string,notice:PreparationListener) => ChartWriteOutcome): ChartWriteOutcome {
    operationId(intent.operationId);
    let notice:PreparationNotice|undefined;
    const outcome=database.transaction(() => {
      const time = now(), owner = account(time, intent.expectedAccountId);
      const prior = storage.outcome(owner, intent.operationId);
      if (prior && time < prior.createdAt + CHART_POLICY.outcomeLifetimeMs) return prior.outcome;
      // IDs are recognized only within the accepted receipt lifetime. Recovery
      // uses outcome(), never a repeated mutation; a new explicit action uses a new ID.
      if (prior) storage.removeOutcome(owner, intent.operationId);
      const result = apply(owner,value=>{notice=value;});
      storage.saveOutcome(owner, intent.operationId, time, result);
      return result;
    });
    if(notice)for(const listener of preparationListeners) {
      try {listener(notice);}catch { /* The committed destination survives a failed wake and resumes on restart. */ }
    }
    return outcome;
  }
  function returnContext(query:ChartReturnQuery) {
    const owner=account(now(),query.expectedAccountId), current=storage.get(owner,query.chartId);
    if(!current)throw new ChartRecordError('not_found');
    if(!isDeepStrictEqual(birthContent(current),birthContent(query.birth)))throw new ChartRecordError('source_changed');
    if(current.source!=='calculated' || !canStoreServerReturn(query.action,query.input.body))throw new ChartRecordError('invalid_chart');
  }
  function saveContent(owner: string, prepared: AccountChartContent,notice:PreparationListener): ChartWriteOutcome {
    const content = contentOf(prepared), key = identity(content);
    const existing = storage.match(owner, key.nameKey, key.birthMinute);
    if (existing) return {kind:'existing', chartId:existing.id, revision:existing.revision};
    const row: AccountChart = {...content, id:allocateId(), accountId:owner, revision:1, noteRevision:1, publicRevision:1};
    storage.insert(row, key.nameKey, key.birthMinute, content);
    if(row.source==='calculated') {storage.preparation.reset(row);notice({kind:'queued',chartId:row.id});}
    return {kind:'created', chartId:row.id, revision:row.revision};
  }
  const api = {
    catalog(input:CatalogQuery):LibraryCatalogReply {
      validateCatalogQuery(input);
      return database.transaction(()=>readCatalog(storage.catalog,account(now(),input.expectedAccountId),input));
    },
    confirmCatalog(expectedAccountId:string,marker:string):LibraryCatalogConfirmation {
      if(!isLibraryCatalogMarker(marker))throw new ChartRecordError('invalid_operation');
      return database.transaction(()=>{
        const owner=account(now(),expectedAccountId),current=storage.catalog.marker(owner);
        return {accountId:owner,marker:current,kind:marker===current?'confirmed':'restart'};
      });
    },
    assertReturnCurrent(query:ChartReturnQuery) { database.transaction(()=>returnContext(query)); },
    readReturn(query:ChartReturnQuery):unknown {
      return database.transaction(()=>{
        returnContext(query);
        return storage.readReturn(query.chartId,query.action,query.input.body,query.action==='chart'?query.input.eventUtc!:'');
      });
    },
    readReturnFamily(id:string,expectedAccountId:string,ref:Extract<PackageRef,{kind:'major-returns'}>) {
      return database.transaction(()=>readOwnedFamily(storage,account(now(),expectedAccountId),id,ref));
    },
    // Internal reuse only. The calculation service must project numeric data before returning or storing it.
    readRelatedReturn(query:ChartReturnQuery):unknown {
      return database.transaction(()=>{
        returnContext(query);
        return storage.readRelatedReturn(query.chartId,query.birth.utc,query.birth.timezone||'UTC',query.action,
          query.input.body,query.action==='chart'?query.input.eventUtc!:'');
      });
    },
    // Only trusted, validated computation owners may call this; not browser-supplied numbers.
    saveReturn(query:ChartReturnQuery,result:CycleResult):void {
      if(!validCycleResult(query.action,result,query.input))throw new ChartRecordError('invalid_chart');
      database.transaction(()=>{
        returnContext(query);
        storage.saveReturn(query.chartId,query.action,query.input.body,query.action==='chart'?query.input.eventUtc!:'',result);
      });
    },
    create(intent: ChartWriteIntent & { content: AccountChartContent }): ChartWriteOutcome {
      return write(intent, (owner,notice) => saveContent(owner, intent.content,notice));
    },
    addFromSource(intent: ChartWriteIntent & {sourceId: string; seenRevision: number}): ChartWriteOutcome {
      return write(intent, (owner,notice) => {
        const source = storage.shared(intent.sourceId);
        if (!source) return {kind:'rejected', chartId:intent.sourceId, code:'not_found'};
        if (source.publicRevision !== intent.seenRevision) {
          return {kind:'rejected', chartId:source.id, code:'source_changed'};
        }
        return saveContent(owner, {...contentOf(source), note:''},notice);
      });
    },
    update(intent: ChartUpdate): ChartWriteOutcome {
      return write(intent, (owner,notice) => {
        const current = storage.get(owner, intent.chartId);
        if (!current) return {kind:'rejected', chartId:intent.chartId, code:'not_found'};
        if (intent.note && intent.note.seenRevision !== current.noteRevision) {
          return {kind:'rejected', chartId:current.id, code:'note_conflict', revision:current.revision};
        }
        const content = contentOf({...(intent.birth ?? current),
          name:intent.name ?? current.name, note:intent.note ? intent.note.value : current.note});
        const key = identity(content), duplicate = storage.match(owner, key.nameKey, key.birthMinute);
        if (duplicate && duplicate.id !== current.id) return {kind:'rejected', chartId:current.id, code:'duplicate_chart'};
        // A distinct operation still receives its own durable outcome in write().
        // Authorization, note CAS, validation and duplicate detection have already run.
        if(isDeepStrictEqual(content,contentOf(current)))return {kind:'updated',chartId:current.id,revision:current.revision};
        const row: AccountChart = {...content, id:current.id, accountId:owner, revision:current.revision + 1,
          noteRevision:current.noteRevision + (content.note !== current.note ? 1 : 0),
          publicRevision:current.publicRevision + (isDeepStrictEqual(publicContent(content), publicContent(current)) ? 0 : 1)};
        if (!storage.update(row, key.nameKey, key.birthMinute, content)) {
          return {kind:'rejected', chartId:current.id, code:'not_found'};
        }
        if(!isDeepStrictEqual(birthContent(current),birthContent(content))) {
          storage.clearReturns(current.id);storage.preparation.reset(row);
          notice({kind:row.source==='calculated'?'queued':'removed',chartId:row.id});
        }
        return {kind:'updated', chartId:current.id, revision:row.revision};
      });
    },
    remove(intent: ChartWriteIntent & {chartId: string}): ChartWriteOutcome {
      return write(intent, (owner,notice) => {
        const removed=storage.remove(owner,intent.chartId);
        if(removed)notice({kind:'removed',chartId:intent.chartId});
        return {kind:removed?'deleted':'absent',chartId:intent.chartId};
      });
    },
    outcome(intent: ChartWriteIntent): ChartOutcome {
      operationId(intent.operationId);
      return database.transaction(() => {
        const time = now(), owner = account(time, intent.expectedAccountId), prior = storage.outcome(owner, intent.operationId);
        return prior && time < prior.createdAt + CHART_POLICY.outcomeLifetimeMs ? prior.outcome : {kind:'unknown'};
      });
    },
    getOwn(id: string, expectedAccountId?: string) { return database.transaction(() => storage.get(account(now(), expectedAccountId), id)); },
    observeOwn(id:string,expectedAccountId:string) {
      return database.transaction(()=>storage.observeOwn(account(now(),expectedAccountId),id));
    },
    observeOutcome(result:ChartOutcome,expectedAccountId:string) {
      return database.transaction(()=>observeOutcome(storage,account(now(),expectedAccountId,{renew:false}),result));
    },
    list() { return database.transaction(() => storage.list(account(now()))); },
    page({expectedAccountId, after = '', limit = 100}: {expectedAccountId: string; after?: string; limit?: number}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || typeof after !== 'string' || after.length > 80) {
        throw new ChartRecordError('invalid_operation');
      }
      return database.transaction(() => {
        const rows = storage.page(account(now(), expectedAccountId), after, limit + 1), more = rows.length > limit;
        const charts = rows.slice(0, limit);
        return {charts, nextCursor:more ? charts.at(-1)!.id : null};
      });
    },
    getPublic(id: string): PublicAccountChart | null {
      const row = storage.shared(id);
      if (!row) return null;
      return {...publicContent(row), id:row.id, revision:row.publicRevision};
    },
    cleanup() { database.transaction(() => storage.cleanup(now() - CHART_POLICY.outcomeLifetimeMs)); },
  };
  return api;
  }
  const api = withAuthorization(initialAuthorize);
  api.cleanup();
  return {...api, withAuthorization,packages:storage.packages,preparation:storage.preparation,
    subscribePreparation(listener:PreparationListener) {preparationListeners.add(listener);return ()=>{preparationListeners.delete(listener);};},
  };
}
export type ChartRecordAccess = ReturnType<ReturnType<typeof createChartRecords>['withAuthorization']>;
