import {isMainReturnBody} from '../../shared/chart-return-contract.ts';
import {validCycleResult,type CycleInput,type CycleResult} from '../../shared/cycles-format.ts';
import { canonicalChartId, isOperationIdentifier, CHART_ID_MIN_DIGITS, CHART_ID_MAX_DIGITS } from '../../shared/chart-record-contract.ts';
import { randomInt } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
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
  'nodeModel','zodiac','verification','cityId','city','calculationVersion'] as const;
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
    || !Number.isFinite(milliseconds) || typeof content.calculationVersion !== 'string' || !content.calculationVersion
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
  chartId:string; expectedAccountId:string; birth:AccountChartBirth; cyclesVersion:string;
  action:'events'|'chart'; input:CycleInput;
}

/** Receives trusted, prepared calculation data. HTTP must not forward user-supplied calculated numbers here. */
export function createChartRecords({ database, authorize: initialAuthorize, now = Date.now, newId = newChartId }: {
  database: Database;
  authorize: (serverTime: number) => { accountId: string } | null;
  now?: () => number; newId?: (digits?: number) => string;
}) {
  const storage = createChartRecordStorage(database,canonicalChartId);
  function allocateId() {
    for(let digits=CHART_ID_MIN_DIGITS;digits<=CHART_ID_MAX_DIGITS;digits++) {
      for(let attempt=0;attempt<32;attempt++) {
        const id=newId(digits);
        if(!storage.identifierUsed(id))return id;
      }
    }
    throw new ChartRecordError('chart_unavailable');
  }
  let returnVersions:{calculationVersion:string;cyclesVersion:string}|null=null;
  // Runtime setup, never an HTTP operation. A later version also fences pending old writes.
  function configureReturns(versions:{calculationVersion:string;cyclesVersion:string}) {
    if(!versions.calculationVersion || !/^[a-f0-9]{64}$/.test(versions.cyclesVersion))throw new ChartRecordError('invalid_chart');
    database.transaction(()=>storage.clearOldReturns(versions.calculationVersion,versions.cyclesVersion));
    returnVersions={...versions};
  }

  function withAuthorization(authorize: (serverTime: number) => { accountId: string } | null) {
  function account(time: number, expected?: string) {
    const current = authorize(time);
    if (!current) throw new ChartRecordError('auth_required');
    if (expected !== undefined && current.accountId !== expected) throw new ChartRecordError('account_changed');
    return current.accountId;
  }
  function write(intent: ChartWriteIntent, apply: (accountId: string) => ChartWriteOutcome): ChartWriteOutcome {
    operationId(intent.operationId);
    return database.transaction(() => {
      const time = now(), owner = account(time, intent.expectedAccountId);
      const prior = storage.outcome(owner, intent.operationId);
      if (prior && time < prior.createdAt + CHART_POLICY.outcomeLifetimeMs) return prior.outcome;
      // IDs are recognized only within the accepted receipt lifetime. Recovery
      // uses outcome(), never a repeated mutation; a new explicit action uses a new ID.
      if (prior) storage.removeOutcome(owner, intent.operationId);
      const result = apply(owner);
      storage.saveOutcome(owner, intent.operationId, time, result);
      return result;
    });
  }
  function returnContext(query:ChartReturnQuery) {
    const owner=account(now(),query.expectedAccountId), current=storage.get(owner,query.chartId);
    if(!current)throw new ChartRecordError('not_found');
    if(!returnVersions || query.cyclesVersion!==returnVersions.cyclesVersion
      || current.calculationVersion!==returnVersions.calculationVersion
      || !isDeepStrictEqual(birthContent(current),birthContent(query.birth)))throw new ChartRecordError('source_changed');
    if(current.source!=='calculated' || !isMainReturnBody(query.input.body))throw new ChartRecordError('invalid_chart');
  }
  function saveContent(owner: string, prepared: AccountChartContent): ChartWriteOutcome {
    const content = contentOf(prepared), key = identity(content);
    const existing = storage.match(owner, key.nameKey, key.birthMinute);
    if (existing) return {kind:'existing', chartId:existing.id, revision:existing.revision};
    const row: AccountChart = {...content, id:allocateId(), accountId:owner, revision:1, noteRevision:1, publicRevision:1};
    storage.insert(row, key.nameKey, key.birthMinute, content);
    return {kind:'created', chartId:row.id, revision:row.revision};
  }
  const api = {
    configureReturns,
    assertReturnCurrent(query:ChartReturnQuery) { database.transaction(()=>returnContext(query)); },
    readReturn(query:ChartReturnQuery):unknown {
      return database.transaction(()=>{
        returnContext(query);
        return storage.readReturn(query.chartId,query.action,query.input.body,query.action==='chart'?query.input.eventUtc!:'',
          query.birth.calculationVersion,query.cyclesVersion);
      });
    },
    // Only trusted, validated computation owners may call this; not browser-supplied numbers.
    saveReturn(query:ChartReturnQuery,result:CycleResult):void {
      if(!validCycleResult(query.action,result,query.input))throw new ChartRecordError('invalid_chart');
      database.transaction(()=>{
        returnContext(query);
        storage.saveReturn(query.chartId,query.action,query.input.body,query.action==='chart'?query.input.eventUtc!:'',
          query.birth.calculationVersion,query.cyclesVersion,result);
      });
    },
    create(intent: ChartWriteIntent & { content: AccountChartContent }): ChartWriteOutcome {
      return write(intent, owner => saveContent(owner, intent.content));
    },
    addFromSource(intent: ChartWriteIntent & {sourceId: string; seenRevision: number}): ChartWriteOutcome {
      return write(intent, owner => {
        const source = storage.shared(intent.sourceId);
        if (!source) return {kind:'rejected', chartId:intent.sourceId, code:'not_found'};
        if (source.publicRevision !== intent.seenRevision) {
          return {kind:'rejected', chartId:source.id, code:'source_changed'};
        }
        return saveContent(owner, {...contentOf(source), note:''});
      });
    },
    update(intent: ChartUpdate): ChartWriteOutcome {
      return write(intent, owner => {
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
        if(!isDeepStrictEqual(birthContent(current),birthContent(content)))storage.clearReturns(current.id);
        return {kind:'updated', chartId:current.id, revision:row.revision};
      });
    },
    remove(intent: ChartWriteIntent & {chartId: string}): ChartWriteOutcome {
      return write(intent, owner => ({kind:storage.remove(owner, intent.chartId) ? 'deleted' : 'absent', chartId:intent.chartId}));
    },
    outcome(intent: ChartWriteIntent): ChartOutcome {
      operationId(intent.operationId);
      return database.transaction(() => {
        const time = now(), owner = account(time, intent.expectedAccountId), prior = storage.outcome(owner, intent.operationId);
        return prior && time < prior.createdAt + CHART_POLICY.outcomeLifetimeMs ? prior.outcome : {kind:'unknown'};
      });
    },
    getOwn(id: string, expectedAccountId?: string) { return database.transaction(() => storage.get(account(now(), expectedAccountId), id)); },
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
    // A derived calculation refresh is not a user write or a replayed command.
    // The source birth must still be current; concurrent name/note edits are kept.
    refreshBirth(id: string, seen: AccountChartBirth, prepared: AccountChartBirth): 'updated' | 'changed' | 'missing' {
      return database.transaction(() => {
        const current = storage.shared(id);
        if (!current) return 'missing';
        if (!isDeepStrictEqual(birthContent(current),birthContent(seen))) return 'changed';
        const content = contentOf({...prepared,name:current.name,note:current.note}), key = identity(content);
        const duplicate = storage.match(current.accountId,key.nameKey,key.birthMinute);
        if (duplicate && duplicate.id !== id) return 'changed';
        const row: AccountChart = {...content,id,accountId:current.accountId,revision:current.revision+1,
          noteRevision:current.noteRevision,
          publicRevision:current.publicRevision+(isDeepStrictEqual(publicContent(content),publicContent(current)) ? 0 : 1)};
        if(!storage.update(row,key.nameKey,key.birthMinute,content))return 'missing';
        if(!isDeepStrictEqual(birthContent(current),birthContent(content)))storage.clearReturns(id);
        return 'updated';
      });
    },
    cleanup() { database.transaction(() => storage.cleanup(now() - CHART_POLICY.outcomeLifetimeMs)); },
  };
  return api;
  }
  const api = withAuthorization(initialAuthorize);
  api.cleanup();
  return {...api, withAuthorization};
}
export type ChartRecordAccess = ReturnType<ReturnType<typeof createChartRecords>['withAuthorization']>;
