import {createResourceScope} from '../runtime/resource-scope.ts';
import { BIRTH_DRAFT_FIELDS, normalizeBirthFormDraft, type SavedBirthForm, type BirthDraftFoldChoice } from '../domain/birth-form-draft.ts';
import type { City, CalculationRequest, SavedChart } from '../../shared/chart-types.ts';
import type { ChartSession } from '../state/chart-session.ts';
import type { Toast } from '../ui/toast.ts';
import type { ChartCalculation, BirthSubmission } from '../domain/chart-record.ts';
type FormError = Error & { code?: string; choices?: unknown };
type ConnectionMode = Parameters<typeof actionAvailability>[0]['connection'];
export interface RandomBirth { name: string; date: string; time: string; utc: string; fold: number }
interface BirthFormOptions {
  /** The account whose personal input may be restored; independent temporary input has no account. */
  getAccountId?: () => string|null; onDraftChange?: () => void;
  document: Document; getChart: (id: string | null) => SavedChart | undefined;
  submitChart?: (input: BirthSubmission, signal: AbortSignal) => Promise<{id: string; persisted: boolean; metadataOnly?: boolean}> | null;
  isCheckingSubmission?: () => boolean;
  /** Optional caption; omit until its words are approved. The comparison itself is accepted. */
  noteComparisonLabel?: string;
  saveChart: (chart: SavedChart, replacingId?: string | null) => boolean;
  findCities: (query: string, signal: AbortSignal) => Promise<City[]>;
  calculate: (payload: CalculationRequest, signal: AbortSignal) => Promise<ChartCalculation>;
  getConnectionMode: () => ConnectionMode; subscribeConnection: (listener: (mode: ConnectionMode) => void) => () => void;
  randomBirth?: () => RandomBirth; session: ChartSession; onSave: (id: string, options?: { metadataOnly?: boolean }) => void;
  beforeOpen?: () => void; toast: Toast; getFormData?: (form: HTMLFormElement) => FormData;
}
export type BirthForm = ReturnType<typeof attachBirthForm>;

import { natalDateAllowed, NATAL_DATE_MESSAGE } from '../../shared/date-limits.ts';
import { createRandomId, normalizeChartName } from '../domain/chart-record.ts';
import { bindNumericInput, formatDateInput, formatTimeInput, normalizeDate, normalizeTime } from './date-input.ts';
import { canManageLibraryRecord } from './chart-display.ts';
import { escapeHtml as esc } from '../ui/html.ts';
import { randomBirthMoment } from './random-chart.ts';
import { actionAvailability } from '../ui/action-state.ts';
import { createFeedback } from '../ui/feedback.ts';
import { failureMessage, UI_MESSAGES } from '../ui/messages.ts';

// Birth data, city search, DST ambiguity and calculation live within one dialog.
export function attachBirthForm({ document, getAccountId=()=>null, onDraftChange=()=>{}, getChart, saveChart, submitChart, isCheckingSubmission = () => false, noteComparisonLabel, findCities, calculate, getConnectionMode, subscribeConnection, randomBirth = randomBirthMoment, session, onSave, beforeOpen = () => {}, toast, getFormData = form => new FormData(form) }: BirthFormOptions) {
  const scope=createResourceScope();
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  let editingId: string | null = null, openedRecord: SavedChart | undefined, displayedRecord: SavedChart | undefined;
  type VersionedRecord = SavedChart & {revision?: number; noteRevision?: number};
  let comparedNote: VersionedRecord | null = null;
  let draftAccountId:string|null=null,restoringDraft=false;
  let foldChoices:BirthDraftFoldChoice[]=[];
  const draftChanged=()=>{if(!scope.stopped && !restoringDraft)onDraftChange();};
  const noteField = $<HTMLTextAreaElement>('chartNote');
  const notePanel = $('savedChartNote');
  if (notePanel) notePanel.hidden = true;
  function clearNoteComparison() {
    comparedNote = null;
    if (notePanel) { notePanel.hidden = true; notePanel.textContent = ''; }
  }
  function showNoteComparison(next?: VersionedRecord) {
    if (!notePanel) return;
    if (next && typeof next.noteRevision === 'number'
      && next.noteRevision > ((openedRecord as VersionedRecord | undefined)?.noteRevision ?? 0)) {
      comparedNote = next;
      // Advancing this revision is allowed only after rendering its saved text,
      // or when it exactly matches the draft already visible to the person.
      openedRecord = {...openedRecord!, note: next.note, noteRevision: next.noteRevision} as VersionedRecord;
    }
    notePanel.hidden = !comparedNote || comparedNote.note === noteField.value.trim();
    notePanel.textContent = '';
    if (notePanel.hidden) return;
    if (noteComparisonLabel) {
      const caption = document.createElement('strong'); caption.textContent = noteComparisonLabel; notePanel.append(caption);
    }
    const text = document.createElement('div'); text.textContent = comparedNote!.note;
    text.style.whiteSpace = 'pre-wrap'; notePanel.append(text);
  }
  noteField.addEventListener('input', () => showNoteComparison(), {signal:scope.signal});
  let serverPending = false, checkingSubmission = false;
  let formPurpose: 'natal' | 'metadata' = 'natal', selectedCity: Partial<City> | null = null, cityResults: City[] = [], activeCityIndex = -1;
  let cityTimer: ReturnType<typeof setTimeout> | undefined, cityController: AbortController | undefined, citySequence = 0, calculationController: AbortController | undefined, formBusy = false;
  const cityBlurTimers=new Set<ReturnType<typeof setTimeout>>();
  const randomButton = $<HTMLButtonElement>('randomChartButton');
  let randomController: AbortController | null = null;
  function setRandomBusy(busy: boolean) {
    if (randomButton) { randomButton.disabled = actionAvailability({connection:getConnectionMode(),requiresConnection:true,pending:busy}).disabled; randomButton.setAttribute('aria-busy', String(busy)); }
  }
  function cancelRandom() { randomController?.abort(); randomController = null; setRandomBusy(false); }

  const countryNames = new Intl.DisplayNames(['ru'], { type: 'region' });
  const countryLabel = (code: string | undefined) => /^[A-Z]{2}$/.test(code || '') ? countryNames.of(code!) : code || '';
  const cityLabel = (city: Partial<City>) => [...new Set([city.name, city.region, countryLabel(city.country)].filter(Boolean))].join(', ');

  bindNumericInput($<HTMLInputElement>('birthDate'), formatDateInput, scope.signal);
  bindNumericInput($<HTMLInputElement>('birthTime'), formatTimeInput, scope.signal);

  const fieldIds = ['chartName', 'birthDate', 'birthTime', 'birthPlace', 'foldChoice'] as const;
  type FieldId = typeof fieldIds[number];
  const fieldFeedback = Object.fromEntries(fieldIds.map(id => [id, createFeedback($(id + 'Error'), {kind:'field',field:$(id)})])) as Record<FieldId, ReturnType<typeof createFeedback>>;
  const formFeedback = createFeedback($('formError'), {kind:'action'});
  let formMessageKind: 'busy' | 'offline' | 'unavailable' | 'error' | null = null;
  function showForm(message = '', busy = false, code?: string) {
    formMessageKind = !message ? null : busy ? 'busy' : code === 'offline' ? 'offline' : code === 'busy' ? 'unavailable' : 'error';
    if (message) formFeedback.show({message,busy,tone:busy || code === 'busy' ? 'neutral' : 'error'});
    else formFeedback.clear();
  }
  function fieldError(id: FieldId, message = '') {
    if (message) fieldFeedback[id].show({message,tone:'error'});
    else fieldFeedback[id].clear();
  }
  function clearErrors() {
    fieldIds.forEach(id => fieldError(id));
    showForm();
  }
  for (const id of fieldIds) $(id).addEventListener(id === 'foldChoice' ? 'change' : 'input', () => fieldError(id), {signal:scope.signal});

  function resetFold() {
    foldChoices=[];
    fieldError('foldChoice');
    $('foldField').hidden = true; $('foldMessage').textContent = '';
    $<HTMLSelectElement>('foldChoice').innerHTML = '<option value="">Выберите вариант</option>';
  }
  function closeCityResults() {
    $('cityResults').hidden = true; $<HTMLInputElement>('birthPlace').setAttribute('aria-expanded', 'false');
    $<HTMLInputElement>('birthPlace').removeAttribute('aria-activedescendant'); activeCityIndex = -1;
  }
  function highlightCity(index: number) {
    activeCityIndex = index;
    $('cityResults').querySelectorAll('[role="option"]').forEach((option, i) => {
      option.setAttribute('aria-selected', String(i === index));
      if (i === index) { $<HTMLInputElement>('birthPlace').setAttribute('aria-activedescendant', option.id); option.scrollIntoView({ block: 'nearest' }); }
    });
  }
  function selectCity(city: City) {
    fieldError('birthPlace');
    selectedCity = city; $<HTMLInputElement>('birthPlace').value = cityLabel(city);
    $('cityStatus').textContent = `Часовой пояс: ${city.timezone}`;
    $('cityStatus').classList.remove('is-error'); closeCityResults(); resetFold();draftChanged();
  }
  async function searchCities(query: string) {
    if(scope.stopped)return;
    const sequence = ++citySequence;
    cityController?.abort();
    const controller = new AbortController();
    cityController = controller;
    $('cityStatus').textContent = 'Ищем город…'; $('cityStatus').classList.remove('is-error');
    try {
      const data = await findCities(query, controller.signal);
      if (controller.signal.aborted || sequence !== citySequence || formPurpose !== 'natal' || selectedCity) return;
      cityResults = data;
      $('cityResults').innerHTML = cityResults.map((city, i) => `<li role="option" id="city-option-${i}" data-city-index="${i}" aria-selected="false"><span>${esc(city.name)}</span><small>${esc([city.region, countryLabel(city.country)].filter(Boolean).join(' · '))}</small></li>`).join('');
      $('cityResults').hidden = !cityResults.length; $<HTMLInputElement>('birthPlace').setAttribute('aria-expanded', String(Boolean(cityResults.length)));
      $('cityStatus').textContent = cityResults.length ? 'Выберите город и страну из списка.' : 'Город не найден. Попробуйте другое написание.';
      activeCityIndex = -1;
    } catch (caught) {
      const error = caught as FormError;
      if (controller.signal.aborted || error.name === 'AbortError' || sequence !== citySequence) return;
      closeCityResults();
      $('cityStatus').textContent = failureMessage(error, error.message || UI_MESSAGES.cityLookupFailed, 'city');
      $('cityStatus').classList.add('is-error');
    }
  }
  function setFormPurpose(purpose:'natal'|'metadata') {
    formPurpose=purpose;resetFold();closeCityResults();
    for(const id of ['birthDate','birthTime','birthPlace']) {
      if(purpose==='metadata')$(id).setAttribute('readonly','');else $(id).removeAttribute('readonly');
    }
    const place=$('birthPlace');
    if(purpose==='natal') {
      place.setAttribute('role','combobox');place.setAttribute('aria-autocomplete','list');place.setAttribute('aria-expanded','false');
    } else {place.removeAttribute('role');place.removeAttribute('aria-autocomplete');place.removeAttribute('aria-expanded');}
    $('cityStatus').textContent=purpose==='metadata'?'':selectedCity?`Часовой пояс: ${selectedCity.timezone}`:'Выберите город из списка — часовой пояс определится автоматически.';
    $('saveChartButton').textContent=purpose==='natal'?'Рассчитать и сохранить':'Сохранить карту';
    clearErrors();if($<HTMLDialogElement>('chartDialog').open)draftChanged();
  }
  function setFormBusy(busy: boolean) {
    const serverLabel = checkingSubmission ? UI_MESSAGES.chartSaveChecking : UI_MESSAGES.chartSaving;
    if (busy) showForm(serverPending ? serverLabel : UI_MESSAGES.chartPreparing, true);
    else if (formMessageKind === 'busy') showForm();
    formBusy = busy; $<HTMLFormElement>('chartForm').setAttribute('aria-busy', String(busy));
    $<HTMLFormElement>('chartForm').querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('input, textarea, select, button').forEach(control => { if (control.id !== 'cancelDialog') control.disabled = actionAvailability({connection:getConnectionMode(),requiresConnection:true,pending:busy}).disabled; });
    $('saveChartButton').textContent = busy ? serverPending ? serverLabel : 'Рассчитываем…' : formPurpose === 'natal' ? 'Рассчитать и сохранить' : 'Сохранить карту';
  }
  let closedFormDiscarded = false;
  function discardClosedForm() {
    if (scope.stopped || closedFormDiscarded) return;
    closedFormDiscarded = true;
    cancelRandom(); calculationController?.abort(); calculationController = undefined;
    cityController?.abort(); cityController = undefined; clearTimeout(cityTimer); citySequence++;
    selectedCity = null; cityResults = []; closeCityResults();
    editingId = null; openedRecord = displayedRecord = undefined;draftAccountId=null;
    clearNoteComparison(); $<HTMLFormElement>('chartForm').reset();
    $('cityStatus').textContent = ''; resetFold(); clearErrors(); serverPending = false; setFormBusy(false);draftChanged();
  }
  function closeForm() { if(scope.stopped)return; $<HTMLDialogElement>('chartDialog').close(); discardClosedForm(); }

  scope.own(()=>{
    calculationController?.abort();calculationController=undefined;
    cityController?.abort();cityController=undefined;
    randomController?.abort();randomController=null;
    clearTimeout(cityTimer);for(const timer of cityBlurTimers)clearTimeout(timer);cityBlurTimers.clear();
    selectedCity=null;cityResults=[];foldChoices=[];editingId=null;openedRecord=displayedRecord=undefined;comparedNote=null;draftAccountId=null;
    const dialog=$<HTMLDialogElement>('chartDialog');if(dialog.open)dialog.close();
  });

  function refreshForm() {
    if(scope.stopped)return false;
    if (!$<HTMLDialogElement>('chartDialog').open || !editingId) return false;
    const next = getChart(editingId);
    if (!next) {closeForm(); return true;}
    if (next.source !== 'calculated' && next.source !== 'transit') return false;
    const revision = (next as SavedChart & {revision?: number}).revision;
    const seen = (displayedRecord as (SavedChart & {revision?: number}) | undefined)?.revision;
    if (typeof revision !== 'number' || typeof seen !== 'number' || revision <= seen) return false;
    // Only an edited note is a private draft. An untouched field follows the
    // confirmed record, so saving another field cannot restore an obsolete note.
    displayedRecord = next;
    const noteBaseline = openedRecord as VersionedRecord;
    if (noteField.value.trim() === noteBaseline.note.trim()) {
      noteField.value = next.note; openedRecord = next; clearNoteComparison();
    } else {
      openedRecord = {...next, note: noteBaseline.note, noteRevision: noteBaseline.noteRevision} as VersionedRecord;
      showNoteComparison(next);
    }
    cityController?.abort(); clearTimeout(cityTimer); citySequence++; cityResults = []; closeCityResults(); resetFold();
    selectedCity = next.city || (next.cityId != null ? {id: next.cityId, name: next.birthPlace, timezone: next.timezone} : null);
    const values = {chartName: next.name, birthDate: formatDateInput(next.birthDate || ''),
      birthTime: formatTimeInput(next.birthTime || ''), birthPlace: selectedCity ? cityLabel(selectedCity) : next.birthPlace || ''};
    for (const [id, value] of Object.entries(values)) {
      const field = $<HTMLInputElement>(id); if (field.value !== value) field.value = value;
      fieldError(id as FieldId);
    }
    $('cityStatus').textContent = formPurpose==='metadata'?'':selectedCity ? `Часовой пояс: ${selectedCity.timezone}` : 'Выберите город из списка — часовой пояс определится автоматически.';
    draftChanged();return true;
  }

  function openForm(edit = false, id?:string|null) {
    if(scope.stopped)return;
    if(id===undefined)id=session.selectedId;
    if (!restoringDraft && actionAvailability({connection:getConnectionMode(),requiresConnection:true}).disabled) return;
    cancelRandom();
    const c = getChart(id) || session.record;
    if (edit && !canManageLibraryRecord(c)) return;
    calculationController?.abort(); clearTimeout(cityTimer); cityController?.abort(); citySequence += 1;
    $<HTMLFormElement>('chartForm').reset(); showForm(); selectedCity = null; cityResults = []; closeCityResults();
    $('cityStatus').classList.remove('is-error');
    clearNoteComparison();
    draftAccountId=edit?(c as (SavedChart & {accountId?:string})|undefined)?.accountId??null:getAccountId();
    editingId = edit ? c!.id : null; openedRecord = displayedRecord = edit ? c! : undefined; serverPending = false;
    $('dialogTitle').textContent = edit ? 'Редактировать карту' : 'Новая карта';
    if (edit) {
      for (const name of ['name', 'birthPlace', 'note'] as const) ($<HTMLFormElement>('chartForm').elements as HTMLFormControlsCollection & Record<'name' | 'birthPlace' | 'note', HTMLInputElement | HTMLTextAreaElement>)[name].value = c![name] || '';
      $<HTMLInputElement>('birthDate').value = formatDateInput(c!.birthDate || ''); $<HTMLInputElement>('birthTime').value = formatTimeInput(c!.birthTime || '');
      if (c!.city?.id != null || c!.cityId != null) {
        selectedCity = c!.city || { id: c!.cityId!, name: c!.birthPlace, timezone: c!.timezone };
        $<HTMLInputElement>('birthPlace').value = cityLabel(selectedCity!);
      }
    }
    setFormPurpose(edit && c!.source === 'transit' ? 'metadata' : 'natal');setFormBusy(false);
    beforeOpen();if(scope.stopped)return;
    closedFormDiscarded = false;
    $<HTMLDialogElement>('chartDialog').showModal();draftChanged();
  }

  function renderFoldChoices() {
    $<HTMLSelectElement>('foldChoice').innerHTML='<option value="">Выберите вариант</option>'+foldChoices.map(choice=>`<option value="${choice.fold}">${esc(choice.label)}</option>`).join('');
  }
  function snapshot():SavedBirthForm|null {
    if(scope.stopped || !$<HTMLDialogElement>('chartDialog').open)return null;
    const fields=Object.fromEntries(BIRTH_DRAFT_FIELDS.map(id=>[id,$<HTMLInputElement>(id).value]));
    const active=document.activeElement as HTMLInputElement|HTMLTextAreaElement|null;
    const field=active?.id;
    const focus=field && ([...BIRTH_DRAFT_FIELDS,'foldChoice'] as string[]).includes(field)
      ?{field,start:active!.selectionStart,end:active!.selectionEnd,direction:active!.selectionDirection}:null;
    const base=editingId?{note:openedRecord?.note??'',revision:(displayedRecord as VersionedRecord|undefined)?.revision,
      noteRevision:(openedRecord as VersionedRecord|undefined)?.noteRevision}:null;
    return normalizeBirthFormDraft({editingId,accountId:draftAccountId,calculationMode:'calculated',fields,city:selectedCity,
      fold:$('foldField').hidden?null:{value:$<HTMLSelectElement>('foldChoice').value,choices:foldChoices},base,focus});
  }
  function restore(input:unknown):boolean {
    if(scope.stopped)return false;
    const draft=normalizeBirthFormDraft(input),dialog=$<HTMLDialogElement>('chartDialog');
    if(!draft || dialog.open || draft.accountId!==null && draft.accountId!==getAccountId())return false;
    const record=draft.editingId?getChart(draft.editingId):undefined;
    if(draft.editingId && (!record || !canManageLibraryRecord(record)
      || ((record as SavedChart & {accountId?:string}).accountId??null)!==draft.accountId
      || typeof (record as VersionedRecord).revision==='number' && draft.base?.revision!==undefined
        && (record as VersionedRecord).revision!<draft.base.revision))return false;
    restoringDraft=true;
    try {
      openForm(Boolean(draft.editingId),draft.editingId??session.selectedId);
      if(!dialog.open)return false;
      draftAccountId=draft.accountId;
      for(const id of BIRTH_DRAFT_FIELDS)$<HTMLInputElement>(id).value=draft.fields[id];
      selectedCity=draft.city;cityResults=[];closeCityResults();
      $('cityStatus').textContent=formPurpose==='metadata'?'':selectedCity?`Часовой пояс: ${selectedCity.timezone}`:'Выберите город из списка — часовой пояс определится автоматически.';
      if(formPurpose==='natal' && draft.fold){foldChoices=draft.fold.choices;$('foldField').hidden=false;renderFoldChoices();$<HTMLSelectElement>('foldChoice').value=draft.fold.value;}
      if(record && draft.base){
        openedRecord={...record,note:draft.base.note,noteRevision:draft.base.noteRevision} as VersionedRecord;
        displayedRecord={...record,...(draft.base.revision===undefined?{}:{revision:draft.base.revision})} as VersionedRecord;
        refreshForm();
      }
      setFormBusy(false);
      const caret=draft.focus;
      if(caret){
        const field=$<HTMLInputElement|HTMLTextAreaElement>(caret.field);field.focus({preventScroll:true});
        if(caret.start!==undefined && caret.end!==undefined && caret.field!=='foldChoice')
          field.setSelectionRange(Math.min(caret.start,field.value.length),Math.min(caret.end,field.value.length),caret.direction);
      }
      return true;
    }finally{restoringDraft=false;draftChanged();}
  }

  for (const id of ['closeDialog', 'cancelDialog']) $(id).addEventListener('click', closeForm, {signal:scope.signal});
  $<HTMLDialogElement>('chartDialog').addEventListener('cancel', closeForm, {signal:scope.signal});
  $<HTMLDialogElement>('chartDialog').addEventListener('close', () => {
    if (!$<HTMLDialogElement>('chartDialog').open) discardClosedForm();
  }, {signal:scope.signal});
  $<HTMLFormElement>('chartForm').addEventListener('submit', async e => {
    e.preventDefault(); if (scope.stopped || actionAvailability({connection:getConnectionMode(),requiresConnection:true,pending:formBusy}).disabled) return; clearErrors();
    const controller = new AbortController(); calculationController = controller;
    const submittedNoteRevision = (openedRecord as VersionedRecord | undefined)?.noteRevision ?? 0;
    try {
      const form = getFormData(e.target as HTMLFormElement), now = new Date().toISOString();
      const name = normalizeChartName(form.get('name'));
      let firstInvalid: FieldId | null = null;
      const invalid = (id: FieldId, message: string) => { fieldError(id, message); firstInvalid ||= id; };
      const readField = (id: FieldId, value: string, normalize: (value: string) => string) => {
        try { return normalize(value); }
        catch (caught) { const error = caught as Error; invalid(id, error.message); return ''; }
      };
      if (!name) invalid('chartName', 'Добавьте имя карты.');
      else if (name.length > 30) invalid('chartName', 'Не больше 30 символов');
      const previous=getChart(editingId);
      if(formPurpose==='metadata' && !previous)throw new Error(UI_MESSAGES.chartUnavailable);
      const dateValue=String(form.get('birthDate') || '').trim(),timeValue=String(form.get('birthTime') || '').trim();
      const birthDate=formPurpose==='natal'?readField('birthDate',dateValue,normalizeDate):previous!.birthDate;
      const birthTime=formPurpose==='natal'?readField('birthTime',timeValue,normalizeTime):previous!.birthTime;
      if (formPurpose === 'natal') {
        if (!selectedCity) invalid('birthPlace', 'Выберите город рождения из найденного списка.');
        if (!$('foldField').hidden && $<HTMLSelectElement>('foldChoice').value === '') invalid('foldChoice', 'Выберите один из двух вариантов местного времени.');
      }
      if (firstInvalid) { $(firstInvalid).focus(); return; }
      const unchanged = formPurpose === 'natal' && previous?.source === 'calculated' && Number.isFinite(Date.parse(previous.utc!))
        && birthDate === previous.birthDate && birthTime === formatTimeInput(previous.birthTime)
        && String(selectedCity!.id) === String(previous.cityId ?? previous.city?.id)
        && $('foldField').hidden;
      if (formPurpose === 'natal' && !unchanged && !natalDateAllowed(birthDate)) {
        fieldError('birthDate', NATAL_DATE_MESSAGE); $('birthDate').focus(); return;
      }
      const note = String(form.get('note') || '').trim();
      const fold = $<HTMLSelectElement>('foldChoice').value;
      const submitting = submitChart?.({previous: openedRecord, name, note,
        ...(formPurpose === 'natal' && !unchanged ? {birth: {source: 'calculated' as const,
          date: birthDate, time: birthTime, cityId: String(selectedCity!.id), cityName: selectedCity!.name,
          ...(!$('foldField').hidden && (fold === '0' || fold === '1') ? {fold: Number(fold) as 0 | 1} : {})}} : {})}, controller.signal);
      if (submitting) {
        serverPending = true; checkingSubmission = isCheckingSubmission(); setFormBusy(true);
        const saved = await submitting;
        if (controller.signal.aborted || calculationController !== controller || !$<HTMLDialogElement>('chartDialog').open) return;
        $<HTMLDialogElement>('chartDialog').close(); onSave(saved.id, {metadataOnly: saved.metadataOnly});
        if (!saved.persisted) toast('Карта открыта, но не сохранена в браузере.');
        return;
      }
      let result: ChartCalculation, metadataOnly = false;
      if (formPurpose === 'metadata') {result=previous!;metadataOnly=true;}
      else {
        // Names and notes describe the saved calculation. Compare the fields
        // this form actually edits; an untouched minute display must retain
        // stored seconds, the DST fold and every calculation metadata field.
        if (unchanged) { result = previous; metadataOnly = true; }
        else {
          const payload: CalculationRequest = { name, date: birthDate, time: birthTime, cityId: String(selectedCity!.id), cityName: selectedCity!.name, mode: 'natal' };
          if (!$('foldField').hidden) payload.fold = Number($<HTMLSelectElement>('foldChoice').value);
          setFormBusy(true);
          const data = await calculate(payload, controller.signal);
          // A cancelled or replaced dialog no longer owns this response, even if
          // the request happened to finish before transport cancellation arrived.
          if (controller.signal.aborted || calculationController !== controller || !$<HTMLDialogElement>('chartDialog').open) return;
          result = { ...data, source: 'calculated', cityId: String(selectedCity!.id), city: { ...selectedCity } };
        }
      }
      const c = { ...result, id: editingId || createRandomId(), name, note: String(form.get('note') || '').trim(), createdAt: previous?.createdAt || now, updatedAt: metadataOnly ? now : result.updatedAt || now };
      const persisted = saveChart(c, editingId);
      $<HTMLDialogElement>('chartDialog').close(); onSave(c.id, { metadataOnly });
      if (!persisted) toast('Карта открыта, но не сохранена в браузере.');
    } catch (caught) {
      const error = caught as FormError;
      if (controller.signal.aborted || calculationController !== controller || error.name === 'AbortError') return;
      if (error.code === 'note_conflict') {
        refreshForm();
        if (notePanel && comparedNote && (comparedNote.noteRevision ?? 0) > submittedNoteRevision) showForm();
        else showForm(UI_MESSAGES.chartSaveFailed);
      } else if (error.code === 'busy') {
        // A terminal refusal from another calculation port is not an active wait.
        // The HTTP client keeps confirmed queue-admission waits pending.
        showForm(UI_MESSAGES.calculationBusy, false, 'busy');
      } else if (error.code === 'ambiguous_time' && Array.isArray(error.choices)) {
        $('foldField').hidden = false; $('foldMessage').textContent = error.message;
        foldChoices=error.choices.filter(choice => (choice.fold===0 || choice.fold===1) && typeof choice.label==='string').map(choice=>({fold:choice.fold,label:choice.label}));
        renderFoldChoices();
        fieldError('foldChoice', 'Из-за перевода часов это время встречается дважды. Уточните вариант и повторите расчёт.');
        $('foldMessage').textContent = '';
        setFormBusy(false); $<HTMLSelectElement>('foldChoice').focus();
      } else {
        const field = ({ name_required: 'chartName', invalid_date: 'birthDate', unsupported_date: 'birthDate', nonexistent_time: 'birthTime' } as Partial<Record<string, FieldId>>)[error.code!];
        if (field) { setFormBusy(false); fieldError(field, error.message); $(field).focus(); }
        else showForm(failureMessage(error, error.message || UI_MESSAGES.chartCalculationFailed, 'chart-form'));
      }
    } finally { if (calculationController === controller) { serverPending = false; setFormBusy(false);draftChanged(); } }
  }, {signal:scope.signal});
  for (const id of ['birthDate', 'birthTime']) $(id).addEventListener('input', resetFold, {signal:scope.signal});
  $<HTMLInputElement>('birthPlace').addEventListener('input', () => {
    selectedCity = null; cityResults = []; citySequence += 1; cityController?.abort(); clearTimeout(cityTimer); closeCityResults(); resetFold();
    if (formPurpose !== 'natal') return;
    const query = $<HTMLInputElement>('birthPlace').value.trim(); $('cityStatus').classList.remove('is-error');
    $('cityStatus').textContent = query.length < 2 ? 'Введите хотя бы две буквы названия города.' : 'Ищем город…';
    if (query.length >= 2) cityTimer = setTimeout(() => searchCities(query), 220);
  }, {signal:scope.signal});
  $<HTMLInputElement>('birthPlace').addEventListener('keydown', event => {
    if (formPurpose !== 'natal') return;
    if (event.key === 'Escape' && !$('cityResults').hidden) { event.preventDefault(); event.stopPropagation(); closeCityResults(); return; }
    if (!cityResults.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); $('cityResults').hidden = false; $<HTMLInputElement>('birthPlace').setAttribute('aria-expanded', 'true');
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = activeCityIndex === -1 ? (direction === 1 ? 0 : cityResults.length - 1)
        : (activeCityIndex + direction + cityResults.length) % cityResults.length;
      highlightCity(nextIndex);
    } else if (event.key === 'Enter' && !$('cityResults').hidden) {
      event.preventDefault(); selectCity(cityResults[Math.max(0, activeCityIndex)]);
    }
  }, {signal:scope.signal});
  $<HTMLInputElement>('birthPlace').addEventListener('blur', () => {
    const timer=setTimeout(()=>{cityBlurTimers.delete(timer);if(!scope.stopped)closeCityResults();},140);cityBlurTimers.add(timer);
  }, {signal:scope.signal});
  $('cityResults').addEventListener('pointerdown', event => event.preventDefault(), {signal:scope.signal});
  $('cityResults').addEventListener('click', event => {
    const option = (event.target as Element).closest<HTMLElement>('[data-city-index]');
    if (option && cityResults[Number(option.dataset.cityIndex)]) selectCity(cityResults[Number(option.dataset.cityIndex)]);
  }, {signal:scope.signal});

  randomButton?.addEventListener('click', async () => {
    if (scope.stopped || actionAvailability({connection:getConnectionMode(),requiresConnection:true,pending:formBusy || Boolean(randomController)}).disabled || $<HTMLDialogElement>('chartDialog').open) return;
    const controller = new AbortController(); randomController = controller; setRandomBusy(true);
    try {
      const birth = randomBirth();
      const cities = await findCities('Москва', controller.signal);
      if (controller.signal.aborted || randomController !== controller) return;
      const city = cities.find(item => String(item.id) === '524901' && item.country === 'RU' && item.timezone === 'Europe/Moscow');
      if (!city) throw new Error('Москва не найдена в каталоге. Повторите создание примера.');
      const payload: CalculationRequest = { name: birth.name, date: birth.date, time: birth.time, fold: birth.fold, cityId: String(city.id), cityName: city.name, mode: 'natal' };
      const result = await calculate(payload, controller.signal);
      if (controller.signal.aborted || randomController !== controller) return;
      if (Date.parse(result.utc ?? '') !== Date.parse(birth.utc)) throw new Error('Правила часового пояса не совпали. Пример не сохранён; повторите попытку.');
      const now = new Date().toISOString();
      const chart: SavedChart = { ...result, id: createRandomId(), name: birth.name, birthDate: birth.date, birthTime: birth.time,
        source: 'calculated', cityId: String(city.id), city: { ...city }, note: '', createdAt: now, updatedAt: now };
      const persisted = saveChart(chart);
      onSave(chart.id);
      if (!persisted) toast('Карта открыта, но не сохранена в браузере.');
    } catch (caught) {
      const error = caught as Error;
      if (!controller.signal.aborted && randomController === controller && error.name !== 'AbortError') toast(failureMessage(error, error.message));
    } finally {
      if (randomController === controller) { randomController = null; setRandomBusy(false); }
    }
  }, {signal:scope.signal});

  scope.own(subscribeConnection(mode => {
    if(scope.stopped)return;
    if (mode === 'offline') {
      if (!serverPending) calculationController?.abort(); cityController?.abort(); citySequence += 1;
      clearTimeout(cityTimer); closeCityResults(); cancelRandom();
    }
    setRandomBusy(Boolean(randomController));
    setFormBusy(formBusy && (serverPending || mode !== 'offline'));
    if ($<HTMLDialogElement>('chartDialog').open) {
      if (mode === 'offline') showForm(UI_MESSAGES.offline, false, 'offline');
      else if (formMessageKind === 'offline') showForm();
    }
  }));
  for(const id of [...BIRTH_DRAFT_FIELDS,'foldChoice'])
    for(const event of ['input','change','focus','blur','select','keyup','pointerup'])$(id).addEventListener(event,draftChanged, {signal:scope.signal});
  document.addEventListener('selectionchange',()=>{if($<HTMLDialogElement>('chartDialog').open && snapshot()?.focus)draftChanged();}, {signal:scope.signal});
  return {
    dispose:scope.stop, open:openForm, close:closeForm, clearDraft:closeForm, restore, refresh:refreshForm,
    refreshAvailability(){if(scope.stopped)return;setRandomBusy(Boolean(randomController));setFormBusy(formBusy);},
    get snapshot(){return snapshot();},
    get pending(){return !scope.stopped && (formBusy || serverPending || Boolean(randomController));},
    get opened(){return !scope.stopped && $<HTMLDialogElement>('chartDialog').open;},
    get editedId(){return !scope.stopped && $<HTMLDialogElement>('chartDialog').open ? editingId : null;},
  };
}
