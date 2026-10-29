import type { City } from '../../shared/chart-types.ts';

// Raw, unfinished input. Validation for submitting a chart stays in birth-form.
import { canonicalChartId } from '../../shared/chart-record-contract.ts';
export const BIRTH_DRAFT_FIELDS = ['chartName','birthDate','birthTime','birthPlace','chartNote'] as const;
export type BirthDraftField = typeof BIRTH_DRAFT_FIELDS[number];
export interface BirthDraftFocus {
  field: BirthDraftField | 'foldChoice'; start?: number; end?: number; direction?: 'forward'|'backward'|'none';
}
export interface BirthDraftFoldChoice { fold: 0|1; label: string }
export interface SavedBirthForm {
  editingId: string|null; accountId: string|null; calculationMode: 'calculated'|'manual';
  fields: Record<BirthDraftField,string>;
  city: Pick<City,'id'|'name'|'country'|'region'|'timezone'>|null;
  fold: {value: ''|'0'|'1'; choices: BirthDraftFoldChoice[]}|null;
  base: {note:string; revision?:number; noteRevision?:number}|null;
  focus: BirthDraftFocus|null;
}
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value && typeof value==='object' && !Array.isArray(value));
const revision=(value:unknown):value is number=>Number.isSafeInteger(value) && (value as number)>0;
const chartId=(value:unknown):value is string=>typeof value==='string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);

/** Only this small input contract enters the tab snapshot; no calculation, secret or command survives. */
export function normalizeBirthFormDraft(input:unknown):SavedBirthForm|null {
  if(!object(input) || !(input.editingId===null || chartId(input.editingId))
    || !(input.accountId===null || typeof input.accountId==='string' && /^[1-9][0-9]{0,19}$/.test(input.accountId))
    || !['calculated','manual'].includes(String(input.calculationMode)) || !object(input.fields)
    || !BIRTH_DRAFT_FIELDS.every(field=>typeof (input.fields as Record<string,unknown>)[field]==='string'))return null;
  const fields=Object.fromEntries(BIRTH_DRAFT_FIELDS.map(field=>[field,(input.fields as Record<string,string>)[field]])) as SavedBirthForm['fields'];
  let city:SavedBirthForm['city']=null,fold:SavedBirthForm['fold']=null,base:SavedBirthForm['base']=null,focus:BirthDraftFocus|null=null;
  const c=input.city;
  if(object(c) && (typeof c.id==='string' && c.id.length>0 || typeof c.id==='number' && Number.isSafeInteger(c.id))
    && typeof c.name==='string' && typeof c.timezone==='string')city={id:c.id as string|number,name:c.name,timezone:c.timezone,
      country:typeof c.country==='string'?c.country:'',region:typeof c.region==='string'?c.region:''};
  const f=input.fold;
  if(object(f) && ['', '0', '1'].includes(String(f.value)) && Array.isArray(f.choices) && f.choices.length<=2) {
    const choices=f.choices.filter((choice):choice is BirthDraftFoldChoice=>object(choice) && (choice.fold===0 || choice.fold===1) && typeof choice.label==='string')
      .map(choice=>({fold:choice.fold,label:choice.label}));
    if(choices.length===f.choices.length && new Set(choices.map(choice=>choice.fold)).size===choices.length
      && (f.value==='' || choices.some(choice=>String(choice.fold)===f.value)))fold={value:f.value as ''|'0'|'1',choices};
  }
  if(input.editingId!==null && object(input.base) && typeof input.base.note==='string')base={note:input.base.note,
    ...(revision(input.base.revision)?{revision:input.base.revision}:{}),...(revision(input.base.noteRevision)?{noteRevision:input.base.noteRevision}:{})};
  if(input.editingId!==null && !base)return null;
  const caret=input.focus;
  if(object(caret) && (BIRTH_DRAFT_FIELDS.includes(caret.field as BirthDraftField) || caret.field==='foldChoice' && fold)) {
    const field=caret.field as BirthDraftFocus['field'];focus={field};
    if(field!=='foldChoice' && Number.isSafeInteger(caret.start) && Number.isSafeInteger(caret.end)
      && (caret.start as number)>=0 && (caret.end as number)>=(caret.start as number)) {
      focus.start=Math.min(caret.start as number,fields[field].length);focus.end=Math.min(caret.end as number,fields[field].length);
      focus.direction=['forward','backward','none'].includes(String(caret.direction))?caret.direction as BirthDraftFocus['direction']:'none';
    }
  }
  // Legacy manual input stays raw input; the supported form validates it as natal data.
  return {editingId:input.editingId===null?null:canonicalChartId(input.editingId as string),accountId:input.accountId as string|null,
    calculationMode:'calculated',fields,city,fold,base,focus};
}
