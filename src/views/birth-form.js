import { createChartId, normalizeChartName, parseGates } from '../data/storage.js';
import { bindNumericInput, formatDateInput, formatTimeInput, normalizeDate, normalizeTime } from './date-input.js';
import { canManageChart } from './chart-display.js';
import { escapeHtml as esc } from '../ui/html.js';
import { requestJSON as defaultRequestJSON } from '../data/api-client.js';

// Birth data, city search, DST ambiguity and calculation live within one dialog.
export function attachBirthForm({ document, store, session, onSave, beforeOpen = () => {}, toast, requestJSON = defaultRequestJSON, getFormData = form => new FormData(form) }) {
  const $ = id => document.getElementById(id);
  let editingId = null;
  let calculationMode = 'calculated', selectedCity = null, cityResults = [], activeCityIndex = -1;
  let cityTimer, cityController, citySequence = 0, calculationController, formBusy = false;

  const countryNames = new Intl.DisplayNames(['ru'], { type: 'region' });
  const countryLabel = code => /^[A-Z]{2}$/.test(code || '') ? countryNames.of(code) : code || '';
  const cityLabel = city => [...new Set([city.name, city.region, countryLabel(city.country)].filter(Boolean))].join(', ');

  bindNumericInput($('birthDate'), formatDateInput);
  bindNumericInput($('birthTime'), formatTimeInput);

  function resetFold() {
    $('foldField').hidden = true; $('foldMessage').textContent = '';
    $('foldChoice').innerHTML = '<option value="">Выберите вариант</option>';
  }
  function closeCityResults() {
    $('cityResults').hidden = true; $('birthPlace').setAttribute('aria-expanded', 'false');
    $('birthPlace').removeAttribute('aria-activedescendant'); activeCityIndex = -1;
  }
  function highlightCity(index) {
    activeCityIndex = index;
    $('cityResults').querySelectorAll('[role="option"]').forEach((option, i) => {
      option.setAttribute('aria-selected', String(i === index));
      if (i === index) { $('birthPlace').setAttribute('aria-activedescendant', option.id); option.scrollIntoView({ block: 'nearest' }); }
    });
  }
  function selectCity(city) {
    selectedCity = city; $('birthPlace').value = cityLabel(city);
    $('cityStatus').textContent = `Часовой пояс: ${city.timezone}`;
    $('cityStatus').classList.remove('is-error'); closeCityResults(); resetFold();
  }
  async function searchCities(query) {
    const sequence = ++citySequence;
    cityController?.abort();
    const controller = new AbortController();
    cityController = controller;
    $('cityStatus').textContent = 'Ищем город…'; $('cityStatus').classList.remove('is-error');
    try {
      const data = await requestJSON(`/api/cities?q=${encodeURIComponent(query)}`, { signal: controller.signal });
      if (controller.signal.aborted || sequence !== citySequence || calculationMode !== 'calculated' || selectedCity) return;
      cityResults = Array.isArray(data.cities) ? data.cities : [];
      $('cityResults').innerHTML = cityResults.map((city, i) => `<li role="option" id="city-option-${i}" data-city-index="${i}" aria-selected="false"><span>${esc(city.name)}</span><small>${esc([city.region, countryLabel(city.country)].filter(Boolean).join(' · '))}</small></li>`).join('');
      $('cityResults').hidden = !cityResults.length; $('birthPlace').setAttribute('aria-expanded', String(Boolean(cityResults.length)));
      $('cityStatus').textContent = cityResults.length ? 'Выберите город и страну из списка.' : 'Город не найден. Попробуйте другое написание.';
      activeCityIndex = -1;
    } catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError' || sequence !== citySequence) return;
      closeCityResults(); $('cityStatus').textContent = error.message; $('cityStatus').classList.add('is-error');
    }
  }
  function setCalculationMode(mode) {
    calculationMode = mode; resetFold(); closeCityResults();
    $('manualFields').hidden = mode !== 'manual';
    if (mode === 'calculated') {
      $('birthPlace').setAttribute('role', 'combobox'); $('birthPlace').setAttribute('aria-autocomplete', 'list'); $('birthPlace').setAttribute('aria-expanded', 'false');
    } else {
      $('birthPlace').removeAttribute('role'); $('birthPlace').removeAttribute('aria-autocomplete'); $('birthPlace').removeAttribute('aria-expanded');
    }
    $('cityStatus').textContent = mode === 'manual' ? 'Необязательно. В ручном режиме часовой пояс не рассчитывается.' : selectedCity ? `Часовой пояс: ${selectedCity.timezone}` : 'Выберите город из списка — часовой пояс определится автоматически.';
    document.querySelectorAll('[data-calculation-mode]').forEach(button => {
      const active = button.dataset.calculationMode === mode; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    });
    $('saveChartButton').textContent = mode === 'calculated' ? 'Рассчитать и сохранить' : 'Сохранить карту';
    $('formError').textContent = '';
  }
  function setFormBusy(busy) {
    formBusy = busy; $('chartForm').setAttribute('aria-busy', String(busy));
    $('chartForm').querySelectorAll('input, textarea, select, button').forEach(control => { if (control.id !== 'cancelDialog') control.disabled = busy; });
    $('saveChartButton').textContent = busy ? 'Рассчитываем…' : calculationMode === 'calculated' ? 'Рассчитать и сохранить' : 'Сохранить карту';
  }
  function closeForm() { calculationController?.abort(); cityController?.abort(); clearTimeout(cityTimer); closeCityResults(); $('chartDialog').close(); }

  function openForm(edit = false, id = session.selectedId) {
    const c = store.charts.find(item => item.id === id) || session.original;
    if (edit && !canManageChart(c)) return;
    calculationController?.abort(); clearTimeout(cityTimer); cityController?.abort(); citySequence += 1;
    $('chartForm').reset(); $('formError').textContent = ''; setFormBusy(false); selectedCity = null; cityResults = []; closeCityResults();
    $('cityStatus').classList.remove('is-error');
    editingId = edit ? c.id : null;
    $('dialogTitle').textContent = edit ? 'Редактировать карту' : 'Новая карта';
    if (edit) {
      for (const name of ['name', 'birthPlace', 'note']) $('chartForm').elements[name].value = c[name] || '';
      $('birthDate').value = formatDateInput(c.birthDate || ''); $('birthTime').value = formatTimeInput(c.birthTime || '');
      $('personalityGates').value = c.personality.join(', '); $('designGates').value = c.design.join(', ');
      if (c.city?.id != null || c.cityId != null) {
        selectedCity = c.city || { id: c.cityId, name: c.birthPlace, timezone: c.timezone };
        $('birthPlace').value = cityLabel(selectedCity);
      }
    }
    $('chartForm').querySelector('.form-extras').open = Boolean(edit && c.note);
    setCalculationMode(edit && c.source !== 'calculated' ? 'manual' : 'calculated');
    beforeOpen();
    $('chartDialog').showModal();
  }

  for (const id of ['closeDialog', 'cancelDialog']) $(id).addEventListener('click', closeForm);
  $('chartDialog').addEventListener('cancel', () => { calculationController?.abort(); cityController?.abort(); clearTimeout(cityTimer); });
  $('chartForm').addEventListener('submit', async e => {
    e.preventDefault(); if (formBusy) return; $('formError').textContent = '';
    const controller = new AbortController(); calculationController = controller;
    try {
      const form = getFormData(e.target), now = new Date().toISOString();
      const name = normalizeChartName(form.get('name'));
      if (!name) { $('chartName').focus(); throw new Error('Добавьте имя карты.'); }
      if (name.length > 80) throw new Error('Имя карты должно быть не длиннее 80 символов.');
      const dateValue = String(form.get('birthDate') || '').trim(), timeValue = String(form.get('birthTime') || '').trim();
      const birthDate = dateValue || calculationMode === 'calculated' ? normalizeDate(dateValue) : '';
      const birthTime = timeValue || calculationMode === 'calculated' ? normalizeTime(timeValue) : '';
      const previous = store.charts.find(item => item.id === editingId);
      let result, metadataOnly = false;
      if (calculationMode === 'calculated') {
        if (!selectedCity) { $('birthPlace').focus(); throw new Error('Выберите город рождения из найденного списка.'); }
        if (!$('foldField').hidden && $('foldChoice').value === '') { $('foldChoice').focus(); throw new Error('Выберите один из двух вариантов местного времени.'); }
        // Names and notes describe the saved calculation. Compare the fields
        // this form actually edits; an untouched minute display must retain
        // stored seconds, the DST fold and every calculation metadata field.
        const unchanged = previous?.source === 'calculated' && Number.isFinite(Date.parse(previous.utc))
          && birthDate === previous.birthDate && birthTime === formatTimeInput(previous.birthTime)
          && String(selectedCity.id) === String(previous.cityId ?? previous.city?.id)
          && $('foldField').hidden;
        if (unchanged) { result = previous; metadataOnly = true; }
        else {
          const payload = { name, date: birthDate, time: birthTime, cityId: String(selectedCity.id), cityName: selectedCity.name, mode: 'natal' };
          if (!$('foldField').hidden) payload.fold = Number($('foldChoice').value);
          setFormBusy(true);
          const data = await requestJSON('/api/calculate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
          // A cancelled or replaced dialog no longer owns this response, even if
          // the request happened to finish before transport cancellation arrived.
          if (controller.signal.aborted || calculationController !== controller) return;
          if (!data.chart || !Array.isArray(data.chart.personality) || !Array.isArray(data.chart.design)) throw new Error('Сервер вернул неполный расчёт. Карта не сохранена.');
          result = { ...data.chart, source: 'calculated', cityId: String(selectedCity.id), city: { ...selectedCity } };
        }
      } else result = { name, birthDate, birthTime, birthPlace: String(form.get('birthPlace') || '').trim(), personality: parseGates(form.get('personality')), design: parseGates(form.get('design')), source: 'manual' };
      const c = { ...result, id: editingId || createChartId(), name, note: String(form.get('note') || '').trim(), createdAt: previous?.createdAt || now, updatedAt: metadataOnly ? now : result.updatedAt || now };
      const next = editingId ? store.charts.map(item => item.id === editingId ? c : item) : [...store.charts, c];
      if (next.length > 500) throw new Error('В библиотеке уже 500 карт.');
      const persisted = store.persist(next);
      if (!persisted && store.saveError?.canKeepInMemory === false) throw new Error(store.saveError.message);
      if (!persisted) store.replace(next);
      $('chartDialog').close(); onSave(c.id, { metadataOnly });
      if (!persisted) toast('Карта открыта, но не сохранена в браузере.');
    } catch (error) {
      if (controller.signal.aborted || calculationController !== controller || error.name === 'AbortError') return;
      if (error.code === 'ambiguous_time' && Array.isArray(error.choices)) {
        $('foldField').hidden = false; $('foldMessage').textContent = error.message;
        $('foldChoice').innerHTML = '<option value="">Выберите вариант</option>' + error.choices.filter(choice => choice.fold === 0 || choice.fold === 1).map(choice => `<option value="${choice.fold}">${esc(choice.label)}</option>`).join('');
        $('formError').textContent = 'Из-за перевода часов это время встречается дважды. Уточните вариант и повторите расчёт.';
        setFormBusy(false); $('foldChoice').focus();
      } else $('formError').textContent = error.message;
    } finally { if (calculationController === controller) setFormBusy(false); }
  });
  document.querySelectorAll('[data-calculation-mode]').forEach(button => button.addEventListener('click', () => {
    clearTimeout(cityTimer); cityController?.abort(); citySequence += 1; setCalculationMode(button.dataset.calculationMode);
  }));
  for (const id of ['birthDate', 'birthTime']) $(id).addEventListener('input', resetFold);
  $('birthPlace').addEventListener('input', () => {
    selectedCity = null; cityResults = []; citySequence += 1; cityController?.abort(); clearTimeout(cityTimer); closeCityResults(); resetFold();
    if (calculationMode !== 'calculated') return;
    const query = $('birthPlace').value.trim(); $('cityStatus').classList.remove('is-error');
    $('cityStatus').textContent = query.length < 2 ? 'Введите хотя бы две буквы названия города.' : 'Ищем город…';
    if (query.length >= 2) cityTimer = setTimeout(() => searchCities(query), 220);
  });
  $('birthPlace').addEventListener('keydown', event => {
    if (calculationMode !== 'calculated') return;
    if (event.key === 'Escape' && !$('cityResults').hidden) { event.preventDefault(); event.stopPropagation(); closeCityResults(); return; }
    if (!cityResults.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); $('cityResults').hidden = false; $('birthPlace').setAttribute('aria-expanded', 'true');
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      highlightCity((activeCityIndex + direction + cityResults.length) % cityResults.length);
    } else if (event.key === 'Enter' && !$('cityResults').hidden) {
      event.preventDefault(); selectCity(cityResults[Math.max(0, activeCityIndex)]);
    }
  });
  $('birthPlace').addEventListener('blur', () => setTimeout(closeCityResults, 140));
  $('cityResults').addEventListener('pointerdown', event => event.preventDefault());
  $('cityResults').addEventListener('click', event => {
    const option = event.target.closest('[data-city-index]');
    if (option && cityResults[Number(option.dataset.cityIndex)]) selectCity(cityResults[Number(option.dataset.cityIndex)]);
  });

  return { open: openForm, close: closeForm, get opened() { return $('chartDialog').open; } };
}
