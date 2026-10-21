import type { ChartRecord, City, CalculationRequest } from '../../shared/chart-types.ts';
import type { ChartStore } from '../data/chart-store.ts';
import type { ChartSession } from '../state/chart-session.ts';
import type { ApiError } from '../data/api-client.ts';
import type { Toast } from '../ui/toast.ts';
type FormCalculation = Omit<ChartRecord, 'id' | 'note' | 'createdAt' | 'updatedAt'> & Partial<Pick<ChartRecord, 'id' | 'note' | 'createdAt' | 'updatedAt'>>;
interface BirthFormOptions {
  document: Document; store: ChartStore; session: ChartSession; onSave: (id: string, options?: { metadataOnly?: boolean }) => void;
  beforeOpen?: () => void; toast: Toast; requestJSON?: typeof defaultRequestJSON; getFormData?: (form: HTMLFormElement) => FormData;
}
export type BirthForm = ReturnType<typeof attachBirthForm>;

import { natalDateAllowed, NATAL_DATE_MESSAGE } from '../../shared/date-limits.ts';
import { createChartId, normalizeChartName } from '../data/storage.ts';
import { bindNumericInput, formatDateInput, formatTimeInput, normalizeDate, normalizeTime } from './date-input.ts';
import { canManageLibraryRecord } from './chart-display.ts';
import { escapeHtml as esc } from '../ui/html.ts';
import { requestJSON as defaultRequestJSON } from '../data/api-client.ts';

// Birth data, city search, DST ambiguity and calculation live within one dialog.
export function attachBirthForm({ document, store, session, onSave, beforeOpen = () => {}, toast, requestJSON = defaultRequestJSON, getFormData = form => new FormData(form) }: BirthFormOptions) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  let editingId: string | null = null;
  let calculationMode: 'calculated' | 'manual' = 'calculated', selectedCity: Partial<City> | null = null, cityResults: City[] = [], activeCityIndex = -1;
  let cityTimer: ReturnType<typeof setTimeout> | undefined, cityController: AbortController | undefined, citySequence = 0, calculationController: AbortController | undefined, formBusy = false;

  const countryNames = new Intl.DisplayNames(['ru'], { type: 'region' });
  const countryLabel = (code: string | undefined) => /^[A-Z]{2}$/.test(code || '') ? countryNames.of(code!) : code || '';
  const cityLabel = (city: Partial<City>) => [...new Set([city.name, city.region, countryLabel(city.country)].filter(Boolean))].join(', ');

  bindNumericInput($<HTMLInputElement>('birthDate'), formatDateInput);
  bindNumericInput($<HTMLInputElement>('birthTime'), formatTimeInput);

  const fieldIds = ['chartName', 'birthDate', 'birthTime', 'birthPlace', 'foldChoice'] as const;
  type FieldId = typeof fieldIds[number];
  function fieldError(id: FieldId, message = '') {
    $(id + 'Error').textContent = message;
    if (message) $(id).setAttribute('aria-invalid', 'true');
    else $(id).removeAttribute('aria-invalid');
  }
  function clearErrors() {
    fieldIds.forEach(id => fieldError(id));
    $('formError').textContent = '';
  }
  for (const id of fieldIds) $(id).addEventListener(id === 'foldChoice' ? 'change' : 'input', () => fieldError(id));

  function resetFold() {
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
    $('cityStatus').classList.remove('is-error'); closeCityResults(); resetFold();
  }
  async function searchCities(query: string) {
    const sequence = ++citySequence;
    cityController?.abort();
    const controller = new AbortController();
    cityController = controller;
    $('cityStatus').textContent = 'Ищем город…'; $('cityStatus').classList.remove('is-error');
    try {
      const data = await requestJSON<{ cities?: City[] }>(`/api/cities?q=${encodeURIComponent(query)}`, { signal: controller.signal });
      if (controller.signal.aborted || sequence !== citySequence || calculationMode !== 'calculated' || selectedCity) return;
      cityResults = Array.isArray(data.cities) ? data.cities : [];
      $('cityResults').innerHTML = cityResults.map((city, i) => `<li role="option" id="city-option-${i}" data-city-index="${i}" aria-selected="false"><span>${esc(city.name)}</span><small>${esc([city.region, countryLabel(city.country)].filter(Boolean).join(' · '))}</small></li>`).join('');
      $('cityResults').hidden = !cityResults.length; $<HTMLInputElement>('birthPlace').setAttribute('aria-expanded', String(Boolean(cityResults.length)));
      $('cityStatus').textContent = cityResults.length ? 'Выберите город и страну из списка.' : 'Город не найден. Попробуйте другое написание.';
      activeCityIndex = -1;
    } catch (caught) {
      const error = caught as ApiError;
      if (controller.signal.aborted || error.name === 'AbortError' || sequence !== citySequence) return;
      closeCityResults();
      $('cityStatus').textContent = error.code === 'connection_failed' ? 'Нет соединения. Не можем найти город' : error.message;
      $('cityStatus').classList.add('is-error');
    }
  }
  function setCalculationMode(mode: 'calculated' | 'manual') {
    calculationMode = mode; resetFold(); closeCityResults();
    if (mode === 'calculated') {
      $<HTMLInputElement>('birthPlace').setAttribute('role', 'combobox'); $<HTMLInputElement>('birthPlace').setAttribute('aria-autocomplete', 'list'); $<HTMLInputElement>('birthPlace').setAttribute('aria-expanded', 'false');
    } else {
      $<HTMLInputElement>('birthPlace').removeAttribute('role'); $<HTMLInputElement>('birthPlace').removeAttribute('aria-autocomplete'); $<HTMLInputElement>('birthPlace').removeAttribute('aria-expanded');
    }
    $('cityStatus').textContent = mode === 'manual' ? 'Необязательно. В ручном режиме часовой пояс не рассчитывается.' : selectedCity ? `Часовой пояс: ${selectedCity.timezone}` : 'Выберите город из списка — часовой пояс определится автоматически.';
    document.querySelectorAll<HTMLElement>('[data-calculation-mode]').forEach(button => {
      const active = button.dataset.calculationMode === mode; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    });
    $('saveChartButton').textContent = mode === 'calculated' ? 'Рассчитать и сохранить' : 'Сохранить карту';
    clearErrors();
  }
  function setFormBusy(busy: boolean) {
    formBusy = busy; $<HTMLFormElement>('chartForm').setAttribute('aria-busy', String(busy));
    $<HTMLFormElement>('chartForm').querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('input, textarea, select, button').forEach(control => { if (control.id !== 'cancelDialog') control.disabled = busy; });
    $('saveChartButton').textContent = busy ? 'Рассчитываем…' : calculationMode === 'calculated' ? 'Рассчитать и сохранить' : 'Сохранить карту';
  }
  function closeForm() { calculationController?.abort(); cityController?.abort(); clearTimeout(cityTimer); closeCityResults(); $<HTMLDialogElement>('chartDialog').close(); }

  function openForm(edit = false, id = session.selectedId) {
    const c = store.charts.find(item => item.id === id) || session.record;
    if (edit && !canManageLibraryRecord(c)) return;
    calculationController?.abort(); clearTimeout(cityTimer); cityController?.abort(); citySequence += 1;
    $<HTMLFormElement>('chartForm').reset(); $('formError').textContent = ''; setFormBusy(false); selectedCity = null; cityResults = []; closeCityResults();
    $('cityStatus').classList.remove('is-error');
    editingId = edit ? c!.id : null;
    $('dialogTitle').textContent = edit ? 'Редактировать карту' : 'Новая карта';
    if (edit) {
      for (const name of ['name', 'birthPlace', 'note'] as const) ($<HTMLFormElement>('chartForm').elements as HTMLFormControlsCollection & Record<'name' | 'birthPlace' | 'note', HTMLInputElement | HTMLTextAreaElement>)[name].value = c![name] || '';
      $<HTMLInputElement>('birthDate').value = formatDateInput(c!.birthDate || ''); $<HTMLInputElement>('birthTime').value = formatTimeInput(c!.birthTime || '');
      if (c!.city?.id != null || c!.cityId != null) {
        selectedCity = c!.city || { id: c!.cityId!, name: c!.birthPlace, timezone: c!.timezone };
        $<HTMLInputElement>('birthPlace').value = cityLabel(selectedCity!);
      }
    }
    setCalculationMode(edit && c!.source !== 'calculated' ? 'manual' : 'calculated');
    beforeOpen();
    $<HTMLDialogElement>('chartDialog').showModal();
  }

  for (const id of ['closeDialog', 'cancelDialog']) $(id).addEventListener('click', closeForm);
  $<HTMLDialogElement>('chartDialog').addEventListener('cancel', () => { calculationController?.abort(); cityController?.abort(); clearTimeout(cityTimer); });
  $<HTMLFormElement>('chartForm').addEventListener('submit', async e => {
    e.preventDefault(); if (formBusy) return; clearErrors();
    const controller = new AbortController(); calculationController = controller;
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
      const dateValue = String(form.get('birthDate') || '').trim(), timeValue = String(form.get('birthTime') || '').trim();
      const birthDate = dateValue || calculationMode === 'calculated' ? readField('birthDate', dateValue, normalizeDate) : '';
      const birthTime = timeValue || calculationMode === 'calculated' ? readField('birthTime', timeValue, normalizeTime) : '';
      const previous = store.charts.find(item => item.id === editingId);
      if (calculationMode === 'calculated') {
        if (!selectedCity) invalid('birthPlace', 'Выберите город рождения из найденного списка.');
        if (!$('foldField').hidden && $<HTMLSelectElement>('foldChoice').value === '') invalid('foldChoice', 'Выберите один из двух вариантов местного времени.');
      }
      if (firstInvalid) { $(firstInvalid).focus(); return; }
      let result: FormCalculation, metadataOnly = false;
      if (calculationMode === 'calculated') {
        // Names and notes describe the saved calculation. Compare the fields
        // this form actually edits; an untouched minute display must retain
        // stored seconds, the DST fold and every calculation metadata field.
        const unchanged = previous?.source === 'calculated' && Number.isFinite(Date.parse(previous.utc!))
          && birthDate === previous.birthDate && birthTime === formatTimeInput(previous.birthTime)
          && String(selectedCity!.id) === String(previous.cityId ?? previous.city?.id)
          && $('foldField').hidden;
        if (unchanged) { result = previous; metadataOnly = true; }
        else {
          if (!natalDateAllowed(birthDate)) { fieldError('birthDate', NATAL_DATE_MESSAGE); $('birthDate').focus(); return; }
          const payload: CalculationRequest = { name, date: birthDate, time: birthTime, cityId: String(selectedCity!.id), cityName: selectedCity!.name, mode: 'natal' };
          if (!$('foldField').hidden) payload.fold = Number($<HTMLSelectElement>('foldChoice').value);
          setFormBusy(true);
          const data = await requestJSON<{ chart?: FormCalculation }>('/api/calculate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
          // A cancelled or replaced dialog no longer owns this response, even if
          // the request happened to finish before transport cancellation arrived.
          if (controller.signal.aborted || calculationController !== controller) return;
          if (!data.chart || !Array.isArray(data.chart.personality) || !Array.isArray(data.chart.design)) throw new Error('Сервер вернул неполный расчёт. Карта не сохранена.');
          result = { ...data.chart, source: 'calculated', cityId: String(selectedCity!.id), city: { ...selectedCity } };
        }
      } else result = { ...previous, name, birthDate, birthTime, birthPlace: String(form.get('birthPlace') || '').trim(), personality: previous?.personality || [], design: previous?.design || [], source: 'manual' };
      const c = { ...result, id: editingId || createChartId(), name, note: String(form.get('note') || '').trim(), createdAt: previous?.createdAt || now, updatedAt: metadataOnly || calculationMode === 'manual' ? now : result.updatedAt || now };
      const next = editingId ? store.charts.map(item => item.id === editingId ? c : item) : [...store.charts, c];
      if (next.length > 500) throw new Error('В библиотеке уже 500 карт.');
      const persisted = store.persist(next);
      if (!persisted && store.saveError?.canKeepInMemory === false) throw new Error(store.saveError.message);
      if (!persisted) store.replace(next);
      $<HTMLDialogElement>('chartDialog').close(); onSave(c.id, { metadataOnly });
      if (!persisted) toast('Карта открыта, но не сохранена в браузере.');
    } catch (caught) {
      const error = caught as ApiError;
      if (controller.signal.aborted || calculationController !== controller || error.name === 'AbortError') return;
      if (error.code === 'ambiguous_time' && Array.isArray(error.choices)) {
        $('foldField').hidden = false; $('foldMessage').textContent = error.message;
        $<HTMLSelectElement>('foldChoice').innerHTML = '<option value="">Выберите вариант</option>' + error.choices.filter(choice => choice.fold === 0 || choice.fold === 1).map(choice => `<option value="${choice.fold}">${esc(choice.label)}</option>`).join('');
        fieldError('foldChoice', 'Из-за перевода часов это время встречается дважды. Уточните вариант и повторите расчёт.');
        $('foldMessage').textContent = '';
        setFormBusy(false); $<HTMLSelectElement>('foldChoice').focus();
      } else {
        const field = ({ name_required: 'chartName', invalid_date: 'birthDate', unsupported_date: 'birthDate', nonexistent_time: 'birthTime' } as Partial<Record<string, FieldId>>)[error.code!];
        if (field) { setFormBusy(false); fieldError(field, error.message); $(field).focus(); }
        else $('formError').textContent = error.message;
      }
    } finally { if (calculationController === controller) setFormBusy(false); }
  });
  document.querySelectorAll<HTMLElement>('[data-calculation-mode]').forEach(button => button.addEventListener('click', () => {
    clearTimeout(cityTimer); cityController?.abort(); citySequence += 1; setCalculationMode(button.dataset.calculationMode as 'calculated' | 'manual');
  }));
  for (const id of ['birthDate', 'birthTime']) $(id).addEventListener('input', resetFold);
  $<HTMLInputElement>('birthPlace').addEventListener('input', () => {
    selectedCity = null; cityResults = []; citySequence += 1; cityController?.abort(); clearTimeout(cityTimer); closeCityResults(); resetFold();
    if (calculationMode !== 'calculated') return;
    const query = $<HTMLInputElement>('birthPlace').value.trim(); $('cityStatus').classList.remove('is-error');
    $('cityStatus').textContent = query.length < 2 ? 'Введите хотя бы две буквы названия города.' : 'Ищем город…';
    if (query.length >= 2) cityTimer = setTimeout(() => searchCities(query), 220);
  });
  $<HTMLInputElement>('birthPlace').addEventListener('keydown', event => {
    if (calculationMode !== 'calculated') return;
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
  });
  $<HTMLInputElement>('birthPlace').addEventListener('blur', () => setTimeout(closeCityResults, 140));
  $('cityResults').addEventListener('pointerdown', event => event.preventDefault());
  $('cityResults').addEventListener('click', event => {
    const option = (event.target as Element).closest<HTMLElement>('[data-city-index]');
    if (option && cityResults[Number(option.dataset.cityIndex)]) selectCity(cityResults[Number(option.dataset.cityIndex)]);
  });

  return { open: openForm, close: closeForm, get opened() { return $<HTMLDialogElement>('chartDialog').open; } };
}
