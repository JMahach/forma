import { isChartIdentifier as identifier, isOperationIdentifier, MAX_CALCULATION_RECEIPT_LENGTH, canonicalChartId } from '../../shared/chart-record-contract.ts';
import type { AccountChart, PublicAccountChart, AccountChartPage, ChartWriteIntent, ChartWriteOutcome, ChartOutcome } from '../../shared/chart-record-contract.ts';
import { validateAccountChart, validatePublicAccountChart } from '../domain/account-chart.ts';
import { ConnectionError, fetchResource, responseError } from './http-transport.ts';

/** Source input may carry an opaque proof of server-calculated numbers; no unsigned activations cross the write boundary. */
export type ChartBirthInput =
  | {source: 'transit'; utc: string}
  | {source: 'calculated'; date: string; time: string; cityId: string | number; cityName?: string; fold?: 0 | 1};
export interface ChartCreateInput extends ChartWriteIntent { name: string; note: string; birth: ChartBirthInput; calculationReceipt?:string }
export interface ChartPatchInput extends ChartWriteIntent {
  chartId: string; name?: string; birth?: ChartBirthInput; note?: {value: string; seenRevision: number};
}
/** An immutable command fact, never a current chart or permission to show one. */
export interface ChartReceipt<T extends ChartOutcome = ChartOutcome> extends ChartWriteIntent { outcome: T }
interface Session { accountId: string; sessionId: string }
interface Options { fetch?: typeof globalThis.fetch; getSession: () => Session | null }

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const accountId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown, max = Infinity): value is string => typeof value === 'string' && value.length <= max;
const nonempty = (value: unknown, max = Infinity): value is string => text(value, max) && !!value.trim();
const invalid = () => responseError(200, {error: 'invalid_response'}, 'invalid_response');
const badInput = () => responseError(undefined, {error: 'invalid_request'}, 'invalid_request');
const accountChanged = () => responseError(undefined, {error: 'account_changed'}, 'account_changed');
function validated<T>(read: () => T): T { try { return read(); } catch { throw invalid(); } }
function active(signal?: AbortSignal) { signal?.throwIfAborted(); }
function id(value: unknown) { if (!identifier(value)) throw badInput(); return canonicalChartId(value); }
function intent(input: ChartWriteIntent): ChartWriteIntent {
  if (!object(input) || !accountId(input.expectedAccountId) || !isOperationIdentifier(input.operationId)) throw badInput();
  return {operationId: input.operationId, expectedAccountId: input.expectedAccountId};
}
function birth(input: ChartBirthInput): ChartBirthInput {
  if (!object(input)) throw badInput();
  if (input.source === 'transit' && text(input.utc, 24)
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.utc)) {
    return {source: 'transit', utc: input.utc};
  }
  if (input.source !== 'calculated' || !text(input.date) || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)
    || !text(input.time) || !/^\d{2}:\d{2}$/.test(input.time)
    || !(text(input.cityId, 40) || typeof input.cityId === 'number' && Number.isSafeInteger(input.cityId))
    || input.cityName !== undefined && !nonempty(input.cityName, 160)
    || input.fold !== undefined && input.fold !== 0 && input.fold !== 1) throw badInput();
  return {source: 'calculated', date: input.date, time: input.time, cityId: input.cityId,
    ...(input.cityName === undefined ? {} : {cityName: input.cityName}),
    ...(input.fold === undefined ? {} : {fold: input.fold})};
}
function outcome(value: unknown): ChartOutcome {
  if (!object(value)) throw invalid();
  if (value.kind === 'unknown') return {kind: 'unknown'};
  if (!identifier(value.chartId)) throw invalid();
  if (value.kind === 'created' || value.kind === 'updated' || value.kind === 'existing') {
    if (!positive(value.revision)) throw invalid();
    return {kind: value.kind, chartId: value.chartId, revision: value.revision};
  }
  if (value.kind === 'deleted' || value.kind === 'absent') return {kind: value.kind, chartId: value.chartId};
  if (value.kind !== 'rejected' || typeof value.code !== 'string'
    || !['not_found','duplicate_chart','note_conflict','source_changed'].includes(value.code)
    || value.revision !== undefined && !positive(value.revision)) throw invalid();
  return {kind: 'rejected', chartId: value.chartId, code: value.code as Extract<ChartOutcome, {kind: 'rejected'}>['code'],
    ...(value.revision === undefined ? {} : {revision: value.revision as number})};
}

/** No retries, queues, local storage, navigation or implicit account selection. */
export function createChartClient({fetch: send = fetchResource, getSession}: Options) {
  function session(expectedAccountId: string): Session {
    if (!accountId(expectedAccountId)) throw badInput();
    const current = getSession();
    if (!current || current.accountId !== expectedAccountId || !current.sessionId) throw accountChanged();
    return {...current};
  }
  function stillCurrent(seen: Session) {
    const current = getSession();
    if (!current || current.accountId !== seen.accountId || current.sessionId !== seen.sessionId) throw accountChanged();
  }
  async function request(path: string, method = 'GET', body?: object, signal?: AbortSignal): Promise<Record<string, unknown>> {
    active(signal);
    let response: Response;
    try {
      response = await send(path, {method, credentials: 'same-origin', cache: 'no-store', signal,
        headers: {Accept: 'application/json', ...(body ? {'Content-Type': 'application/json'} : {})},
        ...(body ? {body: JSON.stringify(body)} : {})});
    } catch (error) {
      active(signal);
      if (object(error) && typeof error.code === 'string') throw error;
      throw new ConnectionError('connection_failed');
    }
    active(signal);
    let value: unknown;
    try { value = await response.json(); } catch (error) {
      active(signal);
      if (!response.ok && error instanceof SyntaxError) throw responseError(response.status, null, 'chart_unavailable');
      if (object(error) && typeof error.code === 'string') throw error;
      if (error instanceof TypeError) throw new ConnectionError('connection_failed');
      throw invalid();
    }
    active(signal);
    if (!response.ok) throw responseError(response.status, value, 'chart_unavailable');
    if (!object(value)) throw invalid();
    return value;
  }
  async function privateRead(seen: Session, path: string, signal?: AbortSignal) {
    try {
      const value = await request(path, 'GET', undefined, signal);
      stillCurrent(seen);
      return value;
    } catch (error) {
      stillCurrent(seen);
      throw error;
    }
  }
  async function command(base: ChartWriteIntent, path: string, method: string, body: object, signal?: AbortSignal): Promise<ChartReceipt<ChartWriteOutcome>> {
    session(base.expectedAccountId);
    const result = outcome(await request(path, method, body, signal));
    if (result.kind === 'unknown') throw invalid();
    // A changed session cannot undo a committed command. Return only its tagged
    // fact; current chart reads independently guard the active account/session.
    return {...base, outcome: result};
  }
  return {
    async create(input: ChartCreateInput, signal?: AbortSignal) {
      const base = intent(input);
      if (!nonempty(input.name, 80) || !text(input.note, 2000)) throw badInput();
      if(input.calculationReceipt!==undefined && (!nonempty(input.calculationReceipt,MAX_CALCULATION_RECEIPT_LENGTH)))throw badInput();
      return command(base, '/api/charts', 'POST', {...base, name: input.name, note: input.note, birth: birth(input.birth),
        ...(input.calculationReceipt===undefined?{}:{calculationReceipt:input.calculationReceipt})}, signal);
    },
    async update(input: ChartPatchInput, signal?: AbortSignal) {
      const base = intent(input), chartId = id(input.chartId);
      if (input.name === undefined && input.note === undefined && input.birth === undefined) throw badInput();
      if (input.name !== undefined && !nonempty(input.name, 80)
        || input.note !== undefined && (!object(input.note) || !text(input.note.value, 2000) || !positive(input.note.seenRevision))) throw badInput();
      const body = {...base, ...(input.name === undefined ? {} : {name: input.name}),
        ...(input.note === undefined ? {} : {note: {value: input.note.value, seenRevision: input.note.seenRevision}}),
        ...(input.birth === undefined ? {} : {birth: birth(input.birth)})};
      return command(base, '/api/charts/' + chartId, 'PATCH', body, signal);
    },
    async remove(input: ChartWriteIntent & {chartId: string}, signal?: AbortSignal) {
      const base = intent(input);
      return command(base, '/api/charts/' + id(input.chartId), 'DELETE', base, signal);
    },
    async addFromSource(input: ChartWriteIntent & {sourceId: string; seenRevision: number}, signal?: AbortSignal) {
      const base = intent(input);
      if (!positive(input.seenRevision)) throw badInput();
      return command(base, '/api/charts/add', 'POST', {...base, sourceId: id(input.sourceId), seenRevision: input.seenRevision}, signal);
    },
    async outcome(input: ChartWriteIntent, signal?: AbortSignal): Promise<ChartReceipt> {
      const base = intent(input), seen = session(base.expectedAccountId);
      const result = outcome(await privateRead(seen, '/api/charts/operations/' + base.operationId + '?accountId=' + base.expectedAccountId, signal));
      return {...base, outcome: result};
    },
    async own(input: {chartId: string; expectedAccountId: string}, signal?: AbortSignal): Promise<AccountChart> {
      const chartId = id(input.chartId), seen = session(input.expectedAccountId);
      const value = await privateRead(seen, '/api/charts/' + chartId + '?accountId=' + seen.accountId, signal);
      const result = validated(() => validateAccountChart(value.chart, seen.accountId));
      if (result.id !== chartId) throw invalid();
      return result;
    },
    async public(chartId: string, signal?: AbortSignal): Promise<PublicAccountChart> {
      chartId=id(chartId);
      const value = await request('/api/shared-charts/' + chartId, 'GET', undefined, signal);
      const result = validated(() => validatePublicAccountChart(value.chart));
      if (result.id !== chartId) throw invalid();
      return result;
    },
    async list(input: {expectedAccountId: string; after?: string; limit?: number}, signal?: AbortSignal): Promise<AccountChartPage> {
      const seen = session(input.expectedAccountId), limit = input.limit ?? 100, after = input.after;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw badInput();
      if (after !== undefined) id(after);
      const value = await privateRead(seen, '/api/charts?accountId=' + seen.accountId + '&limit=' + limit + (after ? '&after=' + after : ''), signal);
      if (!Array.isArray(value.charts) || value.charts.length > limit || !nonempty(value.calculationVersion)
        || value.nextCursor !== null && !identifier(value.nextCursor)) throw invalid();
      const version = value.calculationVersion;
      const charts = value.charts.map(raw => {
        const result = validated(() => validateAccountChart(raw, seen.accountId));
        if (!object(raw) || typeof raw.calculationCurrent !== 'boolean' || raw.calculationCurrent !== (result.calculationVersion === version)) throw invalid();
        return {...result, calculationCurrent: raw.calculationCurrent};
      });
      let previous = after ?? '';
      for (const row of charts) { if (row.id <= previous) throw invalid(); previous = row.id; }
      if (value.nextCursor !== null && (charts.length !== limit || value.nextCursor !== charts.at(-1)?.id)) throw invalid();
      return {charts, nextCursor: value.nextCursor as string | null, calculationVersion: version};
    },
  };
}
export type ChartClient = ReturnType<typeof createChartClient>;
