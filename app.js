import { CENTERS, GATES, CHANNELS, DEMO_CHART } from './graph-data.js';
import { renderBodygraph } from './bodygraph.js';
import { attachGestures, validView } from './gestures.js';
import { parseGates, readCharts, writeCharts, encodeChart, decodeChart, VIEW_KEY, readTrash, moveChartToTrash, restoreLastChart } from './storage.js';
import { bindNumericInput, formatDateInput, formatTimeInput, normalizeDate, normalizeTime } from './date-input.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let savedCharts = [], views = {}, storageAvailable = true;
try { savedCharts = readCharts(localStorage); views = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}'); if (!views || Array.isArray(views) || typeof views !== 'object') views = {}; } catch { storageAvailable = false; }
let deletedCharts = [], deletingId = null;
try { deletedCharts = readTrash(localStorage, savedCharts); } catch { /* The normal library remains usable. */ }
let selectedChartId = savedCharts.some(c => c.id === 'current-transit') ? 'current-transit' : 'demo';
let selection = null, filter = 'all', editingId = null, toastTimer, viewTimer;
let calculationMode = 'calculated', selectedCity = null, cityResults = [], activeCityIndex = -1;
let cityTimer, cityController, citySequence = 0, calculationController, formBusy = false;
let liveBusy = false, liveWanted = true, liveError = false, lastLiveSave = 0;
const demo = { ...DEMO_CHART, id: 'demo', source: 'demo' };
const chart = () => selectedChartId === 'demo' ? demo : savedCharts.find(c => c.id === selectedChartId) || demo;
const findGate = id => GATES.find(g => String(g.id) === String(id));
const findCenter = id => CENTERS.find(c => String(c.id) === String(id));
const activeGates = () => new Set([...chart().personality, ...chart().design]);
const connected = id => CHANNELS.filter(c => c.gates.some(n => String(n) === String(id)));
const integrationGates = new Set([10, 20, 34, 57]);
const integrationChannels = CHANNELS.filter(channel => channel.gates.every(gate => integrationGates.has(gate)));
const sourceNames = { demo: 'Учебный пример', calculated: 'Расчёт по данным рождения', manual: 'Ручные активации', transit: 'Текущий момент' };
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
  catch { toast('Не удалось сохранить в браузере. Экспортируйте карту в файл.'); return false; }
}
function saveView() {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(views)); } catch { /* Drawing remains usable if storage is full. */ } }, 180);
}
const initialView = views[selectedChartId];
const gestures = attachGestures($('bodygraph'), $('viewport'), {
  onSelect: choose,
  onChange: view => { $('zoomValue').textContent = `${Math.round(view.k * 100)}%`; views[selectedChartId] = view; saveView(); }
});

function renderLibrary() {
  $('libraryCount').textContent = savedCharts.length + 1;
  $('restoreChartButton').hidden = !deletedCharts.length;
  $('chartList').innerHTML = [demo, ...savedCharts].map(c => `<button class="chart-card" data-chart-id="${esc(c.id)}" data-active="${c.id === selectedChartId}" aria-pressed="${c.id === selectedChartId}"><span class="chart-avatar ${c.id === 'demo' ? 'is-demo' : ''}">${c.id === 'demo' ? 'Д' : c.source === 'transit' ? '◷' : esc(c.name.slice(0, 1).toUpperCase())}</span><span class="chart-copy"><span class="chart-name">${c.id === 'demo' ? 'Демонстрационная карта' : esc(c.name)}</span><span class="chart-caption">${esc(c.source === 'transit' ? localMoment(c.utc) : c.birthDate ? [formatDateInput(c.birthDate), c.birthTime].filter(Boolean).join(' · ') : sourceNames[c.source] || 'Ручные активации')}</span></span>${c.id === selectedChartId ? '<span class="chart-selected-dot"></span>' : ''}</button>`).join('');
}
function renderGraph() {
  const focused = document.activeElement?.closest?.('#viewport [data-type]');
  const focusTarget = focused ? { type: focused.dataset.type, id: focused.dataset.id } : null;
  $('viewport').innerHTML = renderBodygraph(chart(), selection, { dimInactive: filter === 'active', activeOnly: filter === 'active' });
  $('bodygraph').dataset.filter = filter;
  if (focusTarget) $('viewport').querySelector(`[data-type="${focusTarget.type}"][data-id="${focusTarget.id}"]`)?.focus({ preventScroll: true });
}
function activationLabel(id) {
  const p = chart().personality.includes(Number(id)), d = chart().design.includes(Number(id));
  if (chart().source === 'transit') return p ? 'Активны в текущем моменте' : 'Не активны в текущем моменте';
  return p && d ? 'Личность + дизайн' : p ? 'Личность · чёрная активация' : d ? 'Дизайн · красная активация' : 'Не активированы в этой карте';
}
function connectionCard(channel, currentGate) {
  const [a, b] = channel.gates;
  return `<button class="connection-card" data-detail-type="channel" data-detail-id="${esc(channel.id)}"><span class="connection-route"><span class="connection-node ${Number(currentGate) === a ? 'current' : ''}">${a}</span><span class="connection-line"><i></i><i></i><i></i></span><span class="connection-node ${Number(currentGate) === b ? 'current' : ''}">${b}</span><span class="connection-arrow">↗</span></span><span class="connection-title">${esc(channel.name || `Канал ${a}—${b}`)}</span><span class="connection-caption">${activeGates().has(a) && activeGates().has(b) ? 'Канал определён' : 'Исследовать связь'}</span></button>`;
}
function detailButton(type, id, text) { return `<button class="center-chip" data-detail-type="${type}" data-detail-id="${esc(id)}">${esc(text)} <span>↗</span></button>`; }
function renderDetails() {
  const scrollPosition = $('detailContent').scrollTop;
  let content;
  if (!selection) {
    content = '';
  } else if (selection.type === 'gate') {
    const g = findGate(selection.id);
    if (!g) { selection = null; return renderDetails(); }
    const center = findCenter(g.center);
    const descriptions = {
      37: 'В Human Design эти ворота связывают с дружбой, близостью и поддержкой внутри сообщества. В паре с воротами 40 внимание обращается к договорённостям и взаимному обмену.',
      40: 'В Human Design эти ворота связывают с самостоятельностью, трудом и потребностью в отдыхе. Связь с воротами 37 предлагает исследовать баланс личных границ и поддержки сообщества.'
    };
    content = `<div class="detail-kicker"><span class="eyebrow">ВОРОТА</span><span class="detail-label">${esc(activationLabel(g.id))}</span></div><div class="detail-number">${g.id}<span>↗</span></div><h2 class="detail-title">${esc(g.name || `Ворота ${g.id}`)}</h2>${detailButton('center', g.center, center?.name || g.center)}<p class="detail-description">${esc(descriptions[g.id] || g.summary || 'Выберите связанную пару, чтобы исследовать структуру карты. Подробное описание появится после подключения вашей базы знаний.')}</p><div class="detail-section"><span class="eyebrow">${connected(g.id).length > 1 ? 'СВЯЗИ В КАРТЕ' : 'СВЯЗЬ В КАРТЕ'}</span>${connected(g.id).map(c => connectionCard(c, g.id)).join('')}</div><div class="detail-note"><span>НАБЛЮДЕНИЕ</span><p>${g.id === 37 || g.id === 40 ? 'Что каждый участник получает и что готов давать в этих отношениях?' : 'Что вы замечаете в этой теме на собственном опыте?'}</p></div>`;
  } else if (selection.type === 'integration') {
    const active = activeGates();
    content = `<div class="detail-kicker"><span class="eyebrow">СВЯЗИ МЕЖДУ ЦЕНТРАМИ</span></div><h2 class="detail-title">Интеграция</h2><p class="detail-description">Четыре ворота, шесть связей. Выберите пару, чтобы рассмотреть её на схеме.</p><div class="integration-gates">${[20, 10, 57, 34].map(id => `<button class="gate-chip ${active.has(id) ? 'is-active' : ''}" data-detail-type="gate" data-detail-id="${id}">${id}</button>`).join('')}</div><div class="integration-channel-list">${integrationChannels.map(channel => `<button class="integration-channel" data-detail-type="channel" data-detail-id="${channel.id}"><span class="integration-pair">${channel.gates.join('—')}</span><span>${esc(channel.name)}</span><i class="integration-state ${channel.gates.every(id => active.has(id)) ? 'is-defined' : ''}" aria-label="${channel.gates.every(id => active.has(id)) ? 'Определён' : 'Не определён'}"></i></button>`).join('')}</div>`;
  } else if (selection.type === 'center') {
    const c = findCenter(selection.id);
    if (!c) { selection = null; return renderDetails(); }
    const active = activeGates();
    const isDefined = CHANNELS.some(channel => channel.gates.every(g => active.has(g)) && channel.gates.some(g => findGate(g)?.center === c.id));
    const gates = GATES.filter(g => g.center === c.id);
    content = `<div class="detail-kicker"><span class="eyebrow">ЦЕНТР</span><span class="detail-label">${isDefined ? 'Определён' : 'Не определён'}</span></div><div class="center-detail-art">◇</div><h2 class="detail-title">${esc(c.name)}</h2><p class="detail-description">${isDefined ? 'В этой карте центр соединён с другим центром полностью активированным каналом.' : 'В этой карте у центра нет полностью активированного канала. Отдельные ворота могут быть активны.'}</p><div class="detail-section"><span class="eyebrow">ВОРОТА ЦЕНТРА</span><div class="gate-grid">${gates.map(g => `<button class="gate-chip ${active.has(g.id) ? 'is-active' : ''}" data-detail-type="gate" data-detail-id="${g.id}" aria-label="Ворота ${g.id}">${g.id}</button>`).join('')}</div></div><div class="detail-note"><span>ПРОСТРАНСТВО ЗНАНИЙ</span><p>Подробные материалы по центру можно будет добавить из вашей библиотеки.</p></div>`;
  } else {
    const c = CHANNELS.find(c => c.id === selection.id);
    if (!c) { selection = null; return renderDetails(); }
    const active = activeGates(), [a, b] = c.gates;
    content = `<div class="detail-kicker"><span class="eyebrow">КАНАЛ</span><span class="detail-label">${c.gates.every(g => active.has(g)) ? 'Определён' : 'Не определён'}</span></div><div class="detail-number channel-number">${a}<span>—</span>${b}</div><h2 class="detail-title">${esc(c.name || 'Связь двух центров')}</h2><p class="detail-description">${a === 37 && b === 40 || a === 40 && b === 37 ? 'В системе Human Design эту связь называют каналом Сообщества. Она объединяет темы близости, договорённостей и взаимной поддержки.' : 'Канал соединяет два центра. Для полного определения в карте должны быть активны оба его конца.'}</p><div class="detail-section"><span class="eyebrow">РАССМОТРЕТЬ ВОРОТА</span>${c.gates.map(id => { const g = findGate(id); return `<button class="linked-gate" data-detail-type="gate" data-detail-id="${id}"><span class="linked-gate-number">${id}</span><span>${esc(g?.name || `Ворота ${id}`)}<small>${esc(findCenter(g?.center)?.name || '')}</small></span><span>↗</span></button>`; }).join('')}</div><div class="detail-note"><span>КАК ЧИТАТЬ СХЕМУ</span><p>Чёрным отмечена личность, красным — дизайн. Разные цвета могут вместе образовать полный канал.</p></div>`;
  }
  $('detailContent').innerHTML = content;
  $('detailContent').scrollTop = scrollPosition;
}
function choose(value) {
  selection = { type: value.type, id: value.type === 'gate' ? Number(value.id) : value.id };
  renderGraph(); renderDetails(); $('details').classList.add('is-open'); $('detailContent').scrollTop = 0;
}
function updatePage() {
  const c = chart(), active = activeGates();
  $('chartTitle').textContent = c.id === 'demo' ? 'Бодиграф' : c.name;
  $('chartSubtitle').textContent = c.id === 'demo' ? '' : c.source === 'transit' ? localMoment(c.utc) : [c.birthDate ? formatDateInput(c.birthDate) : '', c.birthTime, c.birthPlace].filter(Boolean).join(' · ');
  $('chartBadge').textContent = sourceNames[c.source] || 'Ручные активации';
  $('chartBadge').title = [c.engine, c.ephemeris].filter(Boolean).join(' · ');
  $('modeLabel').textContent = sourceNames[c.source] || 'Ручной';
  $('editButton').hidden = c.source === 'transit';
  $('deleteChartButton').hidden = c.id === 'demo' || c.id === 'current-transit';
  $('activeCount').textContent = active.size;
  $('channelCount').textContent = CHANNELS.filter(channel => channel.gates.every(id => active.has(id))).length;
  renderLibrary(); renderGraph(); renderDetails();
}
function changeChart(id) {
  views[selectedChartId] = gestures.getView();
  selectedChartId = id;
  liveWanted = id === 'current-transit';
  const restored = views[id];
  selection = null;
  updatePage(); gestures.setView(restored);
  try { localStorage.setItem('liniya.last', id); } catch { /* No persistence required for selection. */ }
  closeLibrary(); $('details').classList.remove('is-open');
}
function closeLibrary() { $('library').classList.remove('open'); $('libraryBackdrop').hidden = true; }
function openForm(edit = false) {
  calculationController?.abort(); clearTimeout(cityTimer); cityController?.abort(); citySequence += 1;
  $('chartForm').reset(); $('formError').textContent = ''; setFormBusy(false); selectedCity = null; cityResults = []; closeCityResults();
  $('cityStatus').classList.remove('is-error');
  const c = chart(); editingId = edit && c.id !== 'demo' && c.source !== 'transit' ? c.id : null;
  $('dialogTitle').textContent = edit ? c.id === 'demo' ? 'Сохранить свою копию' : 'Редактировать карту' : 'Новая карта';
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
$('chartList').addEventListener('click', e => { const button = e.target.closest('[data-chart-id]'); if (button) changeChart(button.dataset.chartId); });
$('detailContent').addEventListener('click', e => { const button = e.target.closest('[data-detail-type]'); if (button) choose({ type: button.dataset.detailType, id: button.dataset.detailId }); });
$('newChartButton').addEventListener('click', () => openForm());
$('quickNewChart').addEventListener('click', () => openForm());
$('editButton').addEventListener('click', () => openForm(true));
$('deleteChartButton').addEventListener('click', () => {
  deletingId = chart().id;
  $('deleteChartName').textContent = `«${chart().name}»`;
  $('deleteChartError').textContent = '';
  $('deleteChartDialog').showModal();
  $('cancelDeleteChart').focus();
});
$('cancelDeleteChart').addEventListener('click', () => $('deleteChartDialog').close());
$('confirmDeleteChart').addEventListener('click', () => {
  try {
    const result = moveChartToTrash(localStorage, savedCharts, deletingId);
    savedCharts = result.charts; deletedCharts = result.trash;
    $('deleteChartDialog').close();
    if (selectedChartId === deletingId) changeChart(savedCharts.find(c => c.id !== 'current-transit')?.id || savedCharts[0]?.id || 'demo');
    else updatePage();
    toast('Карта удалена. В меню можно восстановить её.');
  } catch { $('deleteChartError').textContent = 'Не удалось удалить карту. Она осталась в библиотеке.'; }
});
$('restoreChartButton').addEventListener('click', () => {
  try {
    const result = restoreLastChart(localStorage, savedCharts);
    savedCharts = result.charts; deletedCharts = result.trash;
    changeChart(result.restored.id); toast('Карта восстановлена');
  } catch (error) { toast(error.message || 'Не удалось восстановить карту.'); }
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
    $('chartDialog').close(); changeChart(c.id); toast(persisted ? calculationMode === 'calculated' ? 'Карта рассчитана и сохранена' : 'Карта сохранена на этом устройстве' : 'Карта открыта, но не сохранена. Сделайте экспорт.');
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
    if (!data.chart || !Array.isArray(data.chart.personality) || !Array.isArray(data.chart.design) || !data.chart.utc) throw new Error('Сервер вернул неполный расчёт текущего момента.');
    const previous = savedCharts.find(item => item.id === 'current-transit');
    const c = { ...data.chart, id: 'current-transit', name: 'Текущий момент', source: 'transit', createdAt: previous?.createdAt || new Date().toISOString() };
    const next = previous ? savedCharts.map(item => item.id === c.id ? c : item) : [...savedCharts, c];
    if (next.length > 500) throw new Error('В библиотеке уже 500 карт.');
    // Keep each live second in memory; persist at most twice a minute.
    savedCharts = next;
    if (open || storageAvailable && Date.now() - lastLiveSave > 30000) { persistCharts(next); lastLiveSave = Date.now(); }
    if (liveWanted && selectedChartId !== c.id) changeChart(c.id);
    else if (selectedChartId === c.id) {
      $('chartSubtitle').textContent = localMoment(c.utc);
      $('chartBadge').textContent = 'Прямой эфир';
      if (!previous || JSON.stringify(previous.personality) !== JSON.stringify(c.personality)) {
        const active = new Set([...c.personality, ...c.design]);
        $('activeCount').textContent = active.size;
        $('channelCount').textContent = CHANNELS.filter(channel => channel.gates.every(id => active.has(id))).length;
        renderGraph(); renderDetails();
      }
    }
    if (liveError) toast('Живой расчёт восстановлен');
    liveError = false;
  } catch (error) {
    if (!liveError || open) toast(error.name === 'AbortError' ? 'Живой расчёт не ответил. Повторная попытка выполняется автоматически.' : error.message);
    liveError = true;
    if (selectedChartId === 'current-transit' || liveWanted && selectedChartId === 'demo') $('chartBadge').textContent = 'Обновление недоступно';
  } finally { clearTimeout(deadline); liveBusy = false; button.removeAttribute('aria-busy'); }
}
$('nowButton').addEventListener('click', () => refreshCurrentMoment(true));
setInterval(() => refreshCurrentMoment(), 1000);
$('exportButton').addEventListener('click', () => {
  const blob = new Blob([encodeChart(chart())], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = `bodygraph-${chart().name.replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 60)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Файл карты подготовлен');
});
$('importButton').addEventListener('click', () => $('importInput').click());
$('importInput').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    if (file.size > 100000) throw new Error('Выберите экспорт одной карты размером до 100 КБ.');
    const c = { ...decodeChart(await file.text()), id: crypto.randomUUID(), updatedAt: new Date().toISOString() };
    if (savedCharts.length >= 500) throw new Error('В библиотеке уже 500 карт.');
    const next = [...savedCharts, c], persisted = persistCharts(next); if (!persisted) savedCharts = next;
    changeChart(c.id); toast(persisted ? 'Карта импортирована' : 'Карта открыта только на время этой сессии');
  } catch (error) { toast(error.message); }
  e.target.value = '';
});
$('zoomIn').addEventListener('click', () => gestures.zoom(1.25));
$('zoomOut').addEventListener('click', () => gestures.zoom(0.8));
$('fitButton').addEventListener('click', () => gestures.reset());
$('exampleButton').addEventListener('click', () => choose({ type: 'gate', id: 37 }));
$('closeDetails').addEventListener('click', () => { selection = null; renderGraph(); renderDetails(); $('details').classList.remove('is-open'); });
$('openLibrary').addEventListener('click', () => { renderLibrary(); $('library').classList.add('open'); $('libraryBackdrop').hidden = false; });
$('closeLibrary').addEventListener('click', closeLibrary);
$('libraryBackdrop').addEventListener('click', closeLibrary);
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  filter = button.dataset.view; document.querySelectorAll('[data-view]').forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', item === button ? 'true' : 'false'); }); renderGraph();
}));
$('helpButton').addEventListener('click', () => $('helpDialog').showModal());
for (const id of ['closeHelp', 'helpDone']) $(id).addEventListener('click', () => $('helpDialog').close());
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeLibrary(); $('details').classList.remove('is-open'); } });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { try { localStorage.setItem(VIEW_KEY, JSON.stringify(views)); if (storageAvailable) writeCharts(localStorage, savedCharts); } catch { /* Best effort persistence. */ } }
  else refreshCurrentMoment();
});
updatePage();
if (validView(initialView)) gestures.setView(initialView);
if (!storageAvailable) toast('Хранилище браузера недоступно. Сохраняйте карты через экспорт.');
if (selectedChartId !== 'current-transit') {
  $('viewport').innerHTML = ''; $('chartTitle').textContent = 'Текущий момент'; $('chartSubtitle').textContent = ''; $('chartBadge').textContent = 'Расчёт…';
}
refreshCurrentMoment(true);
