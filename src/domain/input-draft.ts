// Text and selection only. Field owners retain validation and reset rules.
export interface TextSelection { start: number; end: number; direction: 'none' | 'forward' | 'backward' }
export interface SavedLifetimeDraft {
  fromDate: string; toDate: string;
  focus: (TextSelection & { field: 'fromDate' | 'toDate' }) | null;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function normalizeTextSelection(value: unknown, text: string): TextSelection | null {
  if (!object(value) || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end)
    || (value.start as number) < 0 || (value.end as number) < (value.start as number)) return null;
  return {start:Math.min(value.start as number,text.length),end:Math.min(value.end as number,text.length),
    direction:value.direction === 'forward' || value.direction === 'backward' ? value.direction : 'none'};
}
export function normalizeLifetimeDraft(value: unknown): SavedLifetimeDraft | null {
  if (!object(value) || typeof value.fromDate !== 'string' || typeof value.toDate !== 'string') return null;
  if (value.focus === null) return {fromDate:value.fromDate,toDate:value.toDate,focus:null};
  if (!object(value.focus)) return null;
  const field=value.focus.field;
  if (field !== 'fromDate' && field !== 'toDate') return null;
  const focus=normalizeTextSelection(value.focus,field === 'fromDate' ? value.fromDate : value.toDate);
  return focus ? {fromDate:value.fromDate,toDate:value.toDate,focus:{field,...focus}} : null;
}
