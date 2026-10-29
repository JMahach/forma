import type { ChartRecord, ChartActivations } from './chart-types.ts';

export const MAX_CALCULATION_RECEIPT_LENGTH=10000;

/** Full data prepared by the calculation owner, not an untrusted HTTP command. */
export type AccountChartContent = Omit<ChartRecord, 'id' | 'createdAt' | 'updatedAt' | 'source' | 'calculationReceipt'> & {
  source: 'calculated' | 'transit';
  activations: ChartActivations;
  utc: string;
};
export type AccountChartBirth = Omit<AccountChartContent, 'name' | 'note'>;
export type AccountChart = AccountChartContent & {
  id: string; accountId: string; revision: number; noteRevision: number; publicRevision: number;
};
export type PublicAccountChart = Omit<AccountChart, 'accountId' | 'note' | 'noteRevision' | 'publicRevision'>;
export type ChartWriteOutcome =
  | { kind: 'created' | 'updated' | 'existing'; chartId: string; revision: number }
  | { kind: 'deleted' | 'absent'; chartId: string }
  | { kind: 'rejected'; chartId: string; code: 'not_found' | 'duplicate_chart' | 'note_conflict' | 'source_changed'; revision?: number };
export type ChartOutcome = ChartWriteOutcome | { kind: 'unknown' };
export interface ChartWriteIntent { operationId: string; expectedAccountId: string }
export interface ChartUpdate extends ChartWriteIntent {
  chartId: string; name?: string; birth?: AccountChartBirth;
  note?: { value: string; seenRevision: number };
}

/** Listing transfers saved ready records without recalculating them. */
export interface AccountChartPage {
  charts: AccountChart[];
  nextCursor: string | null;
}

/** Write-operation IDs are independent of the public chart address. */
export function isOperationIdentifier(value:unknown):value is string {
 return typeof value==='string' && /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(value);
}
/** Decimal chart addresses stay strings; old UUIDs remain readable. */
export const CHART_ID_MIN_DIGITS=10, CHART_ID_MAX_DIGITS=19;
/** The former 39-digit addresses were shortened to their unique first ten digits. */
export function canonicalChartId(value:string):string {
 return /^[1-9][0-9]{38}$/.test(value)?value.slice(0,CHART_ID_MIN_DIGITS):value;
}
export function isChartIdentifier(value:unknown):value is string {
 return typeof value==='string' && (/^[1-9][0-9]{9,18}$/.test(value) || /^[1-9][0-9]{38}$/.test(value) || isOperationIdentifier(value));
}
