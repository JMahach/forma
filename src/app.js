import { renderBodygraph } from './bodygraph/bodygraph.js';
import { alignPersonalityHeading } from './activations/activations.js';
import { createSelectionState } from './selection/selection-state.js';
import { attachKnowledge } from './library/knowledge.js';
import { attachActivationPopover } from './activations/activation-popover.js';
import { attachHoverPreview } from './selection/hover-preview.js';
import { attachGestures } from './bodygraph/gestures.js';
import { parseGates, readCharts, writeCharts, deleteChart } from './charts/storage.js';
import { bindNumericInput, formatDateInput, formatTimeInput, normalizeDate, normalizeTime } from './charts/date-input.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let savedCharts = [], storageAvailable = true;
try { savedCharts = readCharts(localStorage); } catch { storageAvailable = false; }
let deletingId = null;
let selectedChartId = 'current-transit';
const selectionState = createSelectionState();
let hoverPreview = null, editingId = null, toastTimer;
let calculationMode = 'calculated', selectedCity = null, cityResults = [], activeCityIndex = -1;
let cityTimer, cityController, citySequence = 0, calculationController, formBusy = false;
let liveBusy = false, liveWanted = true, liveError = false, lastLiveSave = 0;
const emptyMoment = { id: 'current-transit', name: 'Транзит', source: 'transit', personality: [], design: [], utc: '' };
const chart = () => savedCharts.find(c => c.id === selectedChartId) || emptyMoment;
const canManage = c => c && c.id !== 'current-transit' && c.source !== 'transit';
const sourceNames = { calculated: 'Расчёт по данным рождения', manual: 'Ручные активации', transit: 'Транзит' };
const localMoment = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(date) : '';
};
const countryNames = new Intl.DisplayNames(['ru'], { type: 'region' });
const countryLabel = code => /^[A-Z]{2}$/.test(code || '') ? countryNames.of(code) : code || '';
const cityLabel = city => [...new Set([city.name, city.region, countryLabel(city.country)].filter(Boolean))].join(', ');

bindNumericInput($('birthDate'), formatDateInput);
bindNumericInput($('birthTime'), formatTimeInput);

async function requestJSON(url, options = {}) {
  let response;
  try { response = await fetch(url, options); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Локальный сервер недоступен. Проверьте, что он запущен, и повторите попытку.');
  }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('Сервер расчёта не ответил. Проверьте локальный запуск и повторите попытку.'); }
  if (!response.ok) {
    const error = new Error(data.message || 'Не удалось выполнить расчёт. Попробуйте ещё раз.');
    error.code = data.error; error.choices = data.choices;
    throw error;
  }
  return data;
}

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
  const sequence = ++citySequence; cityController?.abort(); cityController = new AbortController();
  $('cityStatus').textContent = 'Ищем город…'; $('cityStatus').classList.remove('is-error');
  try {
    const data = await requestJSON(`/api/cities?q=${encodeURIComponent(query)}`, { signal: cityController.signal });
    if (sequence !== citySequence || calculationMode !== 'calculated' || selectedCity) return;
    cityResults = Array.isArray(data.cities) ? data.cities : [];
    $('cityResults').innerHTML = cityResults.map((city, i) => `<li role="option" id="city-option-${i}" data-city-index="${i}" aria-selected="false"><span>${esc(city.name)}</span><small>${esc([city.region, countryLabel(city.country)].filter(Boolean).join(' · '))}</small></li>`).join('');
    $('cityResults').hidden = !cityResults.length; $('birthPlace').setAttribute('aria-expanded', String(Boolean(cityResults.length)));
    $('cityStatus').textContent = cityResults.length ? 'Выберите город и страну из списка.' : 'Город не найден. Попробуйте другое написание.';
    activeCityIndex = -1;
  } catch (error) {
    if (error.name === 'AbortError' || sequence !== citySequence) return;
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

function toast(message) { $('toast').textContent = message; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 4500); }
function persistCharts(next) {
  try { if (!storageAvailable) throw new Error(); writeCharts(localStorage, next); savedCharts = next; return true; }
  catch { toast('Не удалось сохранить карту в браузере.'); return false; }
}
const activationPopover = attachActivationPopover($('activationPopover'), $('bodygraph'));
const gestures = attachGestures($('bodygraph'), $('viewport'), {
  onSelect: choose,
  onBackgroundTap: clearSelection,
  onChange: (view, fitted) => {
    const home = view.k <= fitted.k * (1 + 1e-9);
    $('zoomValue').textContent = `${home ? 100 : Math.max(101, Math.round(view.k / fitted.k * 100))}%`;
    $('zoomOut').disabled = home;
    hoverPreview?.clear();
    activationPopover.reposition();
  }
});
hoverPreview = attachHoverPreview($('bodygraph'), { onPreview: () => renderGraph() });
const knowledge = attachKnowledge($('knowledgeDialog'), choose);
$('openKnowledge').addEventListener('click', () => { closeLibrary(); knowledge.show(selectionState.primary); });

function renderLibrary() {
  const personalCharts = savedCharts.filter(canManage);
  $('libraryCount').textContent = personalCharts.length;
  $('nowButton').setAttribute('aria-pressed', String(selectedChartId === 'current-transit'));
  $('chartList').innerHTML = personalCharts.map(c => `<div class="chart-row has-actions" data-active="${c.id === selectedChartId}"><button class="chart-card" data-chart-id="${esc(c.id)}" data-active="${c.id === selectedChartId}" aria-pressed="${c.id === selectedChartId}"><span class="chart-avatar">${esc(c.name.slice(0, 1).toUpperCase())}</span><span class="chart-copy"><span class="chart-name">${esc(c.name)}</span><span class="chart-caption">${esc(c.birthDate ? [formatDateInput(c.birthDate), c.birthTime].filter(Boolean).join(' · ') : sourceNames[c.source] || 'Ручные активации')}</span></span></button><details class="chart-actions"><summary aria-label="Действия с картой «${esc(c.name)}»" title="Действия с картой"><span aria-hidden="true">⋯</span></summary><div class="chart-action-menu"><button data-chart-action="edit" data-action-chart-id="${esc(c.id)}">Редактировать</button><button class="danger-text" data-chart-action="delete" data-action-chart-id="${esc(c.id)}">Удалить</button></div></details></div>`).join('');
}
function renderGraph() {
  if (!savedCharts.some(c => c.id === selectedChartId)) { $('viewport').innerHTML = ''; activationPopover.close(); return; }
  const focused = document.activeElement?.closest?.('#viewport [data-type]');
  const focusTarget = focused ? { type: focused.dataset.type, id: focused.dataset.id, activation: focused.dataset.activation } : null;
  $('viewport').innerHTML = renderBodygraph(chart(), selectionState.primary, { showActivations: true, selections: selectionState.items, previewSelection: hoverPreview?.currentSelection });
  alignPersonalityHeading($('viewport'));
  if (focusTarget) $('viewport').querySelector(focusTarget.activation ? `[data-activation="${focusTarget.activation}"]` : `.bg-interactive[data-type="${focusTarget.type}"][data-id="${focusTarget.id}"]`)?.focus({ preventScroll: true });
  activationPopover.refresh(chart());
}
function choose(value) {
  activationPopover.close();
  const { popoverActivation } = selectionState.choose(value);
  renderGraph();
  if (popoverActivation) activationPopover.show(chart(), popoverActivation);
}
function updatePage() {
  const c = chart();
  $('chartTitle').textContent = c.id === 'current-transit' || c.source === 'transit' ? 'Транзит' : c.name;
  $('currentChartActions').hidden = !canManage(c);
  $('currentChartActions').open = false;
  $('currentChartActions').querySelectorAll('[data-chart-action]').forEach(button => { button.dataset.actionChartId = c.id; });
  $('chartSubtitle').textContent = c.source === 'transit' ? localMoment(c.utc) : [c.birthDate ? formatDateInput(c.birthDate) : '', c.birthTime, c.birthPlace].filter(Boolean).join(' · ');
  renderLibrary(); renderGraph();
}
function changeChart(id) {
  activationPopover.close();
  hoverPreview?.clear({ notify: false });
  selectedChartId = id;
  liveWanted = id === 'current-transit';
  selectionState.clear();
  // Chart content changes; the shared camera does not.
  updatePage();
  closeLibrary();
}
function openLibrary() {
  activationPopover.close();
  hoverPreview?.clear();
  renderLibrary();
  $('library').inert = false;
  $('library').classList.add('open');
  $('libraryBackdrop').hidden = false;
  $('openLibrary').setAttribute('aria-expanded', 'true');
  $('nowButton').focus({ preventScroll: true });
}
function closeLibrary() {
  const restoreFocus = $('library').contains(document.activeElement);
  $('library').classList.remove('open');
  $('library').inert = true;
  $('libraryBackdrop').hidden = true;
  $('openLibrary').setAttribute('aria-expanded', 'false');
  if (restoreFocus) $('openLibrary').focus({ preventScroll: true });
}
function openForm(edit = false, id = selectedChartId) {
  const c = savedCharts.find(item => item.id === id) || chart();
  if (edit && !canManage(c)) return;
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
  closeLibrary();
  $('chartDialog').showModal();
}
document.addEventListener('click', e => {
  const action = e.target.closest('[data-chart-action]');
  if (action) {
    const c = savedCharts.find(item => item.id === action.dataset.actionChartId);
    if (!canManage(c)) return;
    action.closest('details').open = false;
    if (action.dataset.chartAction === 'edit') openForm(true, c.id);
    else openDeleteChart(c);
    return;
  }
  const button = e.target.closest('[data-chart-id]'); if (button) changeChart(button.dataset.chartId);
});
document.addEventListener('toggle', e => {
  if (!e.target.matches?.('.chart-actions[open]')) return;
  document.querySelectorAll('.chart-actions[open]').forEach(item => { if (item !== e.target) item.open = false; });
  if (e.target.id === 'currentChartActions') {
    const rect = e.target.querySelector('summary').getBoundingClientRect();
    const menu = e.target.querySelector('.chart-action-menu');
    menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 202))}px`;
    menu.style.top = `${rect.bottom + 5}px`;
  }
}, true);
document.addEventListener('pointerdown', e => document.querySelectorAll('.chart-actions[open]').forEach(item => { if (!item.contains(e.target)) item.open = false; }));
$('newChartButton').addEventListener('click', () => openForm());
function openDeleteChart(c) {
  if (!canManage(c)) return;
  deletingId = c.id;
  $('deleteChartName').textContent = `«${c.name}»`;
  $('deleteChartError').textContent = '';
  $('deleteChartDialog').showModal();
  $('cancelDeleteChart').focus();
}
$('cancelDeleteChart').addEventListener('click', () => $('deleteChartDialog').close());
$('confirmDeleteChart').addEventListener('click', () => {
  try {
    savedCharts = deleteChart(localStorage, savedCharts, deletingId);
    $('deleteChartDialog').close();
    if (selectedChartId === deletingId) changeChart(savedCharts.find(c => c.id !== 'current-transit')?.id || 'current-transit');
    else updatePage();
    deletingId = null;
    toast('Карта удалена');
  } catch { $('deleteChartError').textContent = 'Не удалось удалить карту. Она осталась в библиотеке.'; }
});
for (const id of ['closeDialog', 'cancelDialog']) $(id).addEventListener('click', closeForm);
$('chartDialog').addEventListener('cancel', () => { calculationController?.abort(); cityController?.abort(); clearTimeout(cityTimer); });
$('chartForm').addEventListener('submit', async e => {
  e.preventDefault(); if (formBusy) return; $('formError').textContent = '';
  const controller = new AbortController(); calculationController = controller;
  try {
    const form = new FormData(e.target), now = new Date().toISOString();
    const name = String(form.get('name') || '').trim();
    if (!name) { $('chartName').focus(); throw new Error('Добавьте имя карты.'); }
    if (name.length > 80) throw new Error('Имя карты должно быть не длиннее 80 символов.');
    const dateValue = String(form.get('birthDate') || '').trim(), timeValue = String(form.get('birthTime') || '').trim();
    const birthDate = dateValue || calculationMode === 'calculated' ? normalizeDate(dateValue) : '';
    const birthTime = timeValue || calculationMode === 'calculated' ? normalizeTime(timeValue) : '';
    let result;
    if (calculationMode === 'calculated') {
      if (!selectedCity) { $('birthPlace').focus(); throw new Error('Выберите город рождения из найденного списка.'); }
      if (!$('foldField').hidden && $('foldChoice').value === '') { $('foldChoice').focus(); throw new Error('Выберите один из двух вариантов местного времени.'); }
      const payload = { name, date: birthDate, time: birthTime, cityId: String(selectedCity.id), cityName: selectedCity.name, mode: 'natal' };
      if (!$('foldField').hidden) payload.fold = Number($('foldChoice').value);
      setFormBusy(true);
      const data = await requestJSON('/api/calculate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
      if (!data.chart || !Array.isArray(data.chart.personality) || !Array.isArray(data.chart.design)) throw new Error('Сервер вернул неполный расчёт. Карта не сохранена.');
      result = { ...data.chart, source: 'calculated', cityId: String(selectedCity.id), city: { ...selectedCity } };
    } else result = { name, birthDate, birthTime, birthPlace: String(form.get('birthPlace') || '').trim(), personality: parseGates(form.get('personality')), design: parseGates(form.get('design')), source: 'manual' };
    const previous = savedCharts.find(item => item.id === editingId);
    const c = { ...result, id: editingId || crypto.randomUUID(), name, note: String(form.get('note') || '').trim(), createdAt: previous?.createdAt || now, updatedAt: result.updatedAt || now };
    const next = editingId ? savedCharts.map(item => item.id === editingId ? c : item) : [...savedCharts, c];
    if (next.length > 500) throw new Error('В библиотеке уже 500 карт.');
    const persisted = persistCharts(next);
    if (!persisted) savedCharts = next;
    $('chartDialog').close(); changeChart(c.id); toast(persisted ? calculationMode === 'calculated' ? 'Карта рассчитана и сохранена' : 'Карта сохранена на этом устройстве' : 'Карта открыта, но не сохранена в браузере.');
  } catch (error) {
    if (error.name === 'AbortError') return;
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
async function refreshCurrentMoment(open = false) {
  if (open) liveWanted = true;
  if (liveBusy) return;
  if (!open && (!liveWanted || document.hidden || $('chartDialog').open)) return;
  liveBusy = true;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 10000);
  const button = $('nowButton');
  if (open) { liveWanted = true; button.setAttribute('aria-busy', 'true'); }
  try {
    const data = await requestJSON('/api/calculate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'transit' }), signal: controller.signal });
    if (!data.chart || !Array.isArray(data.chart.personality) || !Array.isArray(data.chart.design) || !data.chart.utc) throw new Error('Сервер вернул неполный расчёт транзита.');
    const previous = savedCharts.find(item => item.id === 'current-transit');
    const c = { ...data.chart, id: 'current-transit', name: 'Транзит', source: 'transit', createdAt: previous?.createdAt || new Date().toISOString() };
    const next = previous ? savedCharts.map(item => item.id === c.id ? c : item) : [...savedCharts, c];
    if (next.length > 500) throw new Error('В библиотеке уже 500 карт.');
    // Keep each live second in memory; persist at most twice a minute.
    savedCharts = next;
    if (open || storageAvailable && Date.now() - lastLiveSave > 30000) { persistCharts(next); lastLiveSave = Date.now(); }
    if (liveWanted && selectedChartId !== c.id) changeChart(c.id);
    else if (selectedChartId === c.id) {
      $('chartSubtitle').textContent = localMoment(c.utc);
      if (!previous) renderLibrary();
      if (!previous || JSON.stringify(previous.activations?.personality.map(a => [a.gate, a.line])) !== JSON.stringify(c.activations?.personality.map(a => [a.gate, a.line])) || JSON.stringify(previous.personality) !== JSON.stringify(c.personality)) {
        renderGraph();
      }
      activationPopover.refresh(c);
    }
    if (liveError) toast('Живой расчёт восстановлен');
    button.title = 'Транзит';
    liveError = false;
  } catch (error) {
    if (!liveError || open) toast(error.name === 'AbortError' ? 'Живой расчёт не ответил. Повторная попытка выполняется автоматически.' : error.message);
    liveError = true;
    if (selectedChartId === 'current-transit') $('nowButton').title = 'Обновление недоступно. Нажмите, чтобы повторить.';
  } finally { clearTimeout(deadline); liveBusy = false; button.removeAttribute('aria-busy'); }
}
$('nowButton').addEventListener('click', () => {
  closeLibrary();
  if (savedCharts.some(c => c.id === 'current-transit')) changeChart('current-transit');
  refreshCurrentMoment(true);
});
setInterval(() => refreshCurrentMoment(), 1000);
$('zoomIn').addEventListener('click', () => gestures.zoom(1.25));
$('zoomOut').addEventListener('click', () => gestures.zoom(0.8));
$('fitButton').addEventListener('click', () => gestures.reset());
function clearSelection() {
  activationPopover.close();
  hoverPreview?.clear({ notify: false });
  selectionState.clear();
  renderGraph();
}
$('openLibrary').addEventListener('click', openLibrary);
$('libraryBackdrop').addEventListener('click', closeLibrary);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const menu = document.querySelector('.chart-actions[open]');
  if (menu) { menu.open = false; menu.querySelector('summary').focus(); e.preventDefault(); return; }
  closeLibrary();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { try { if (storageAvailable) writeCharts(localStorage, savedCharts); } catch { /* Best effort persistence. */ } }
  else refreshCurrentMoment();
});
updatePage();
gestures.reset();
new ResizeObserver(() => gestures.resize()).observe($('bodygraph'));
if (!storageAvailable) toast('Хранилище браузера недоступно. Изменения не будут сохранены.');
refreshCurrentMoment(true);
