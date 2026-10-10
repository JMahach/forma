import { primaryChart, chartTopology } from '../domain/chart-composition.js';
import { escapeHtml as esc } from '../ui/html.js';
import { buildChartSummary } from './chart-summary-data.js';

const labels = { design: 'Дизайн', personality: 'Личность', all: 'Всего' };
const normalize = value => String(value).toLocaleLowerCase('ru').replace(/ё/g, 'е').trim();
const matches = (query, ...values) => !query || normalize(values.join(' ')).includes(query);

function lineRows(model, query) {
  if (!model.hasLines) return matches(query, 'линии') ? '<p class="summary-note">Для подсчёта линий нужны планетарные активации. В этой карте они пока недоступны.</p>' : '';
  const sources = ['design', 'personality'].filter(source => !model.isTransit || model.lines.some(row => row[source] > 0));
  const singleSource = sources.length === 1;
  if (!singleSource) sources.push('all');
  const sourceLabel = source => model.isTransit && singleSource && source === 'personality' ? 'Транзит' : labels[source];
  const rows = model.lines.filter(row => matches(query, 'линии', row.line));
  if (!rows.length) return '';
  return `${model.rowsLabel ? `<p class="summary-note">Линии: ${esc(model.rowsLabel)}</p>` : ''}<div class="summary-lines ${singleSource ? 'is-transit' : ''}" role="table" aria-label="Количество активаций по линиям">
    <div class="summary-line-head" role="row"><span role="columnheader">Линия</span>${sources.map(source => `<span role="columnheader" class="summary-${source}">${sourceLabel(source)}</span>`).join('')}</div>
    ${rows.map(row => `<div class="summary-line-row" role="row"><span role="rowheader">${row.line}</span>${sources.map(source => {
      const count = source === 'all' ? row.total : row[source];
      return `<span role="cell"><button type="button" class="summary-count summary-${source}" data-summary-line="${row.line}" data-summary-source="${source}" aria-label="Линия ${row.line}, ${sourceLabel(source)}: ${count}" aria-pressed="false" ${count ? '' : 'disabled'}>${count}</button></span>`;
    }).join('')}</div>`).join('')}
    </div><p class="summary-note">Каждая активация считается отдельно, включая лунные узлы. Клик — выделить; Shift — добавить или убрать.</p>`;
}

const entityButton = (type, id, title, detail) => `<button type="button" class="summary-entity" data-summary-type="${type}" data-summary-id="${esc(id)}" aria-pressed="false"><span>${esc(title)}</span><span class="summary-entity-detail">${detail}</span></button>`;

// New sections supply only data presentation. Disclosure, search, scrolling,
// selection and drawer behaviour remain shared panel behaviour.
export const SUMMARY_SECTIONS = [
  { id: 'lines', title: 'Линии', count: m => m.hasLines ? m.totals.activations : null, render: lineRows },
  { id: 'centers', title: 'Центры', count: m => m.totals.centers, render: (m, q) => m.centers.filter(c => matches(q, 'центры', c.name)).map(c => entityButton('center', c.id, c.name, c.defined ? `${c.activeGates.length} ворот` : 'не определён')).join('') },
  { id: 'channels', title: 'Каналы', count: m => m.totals.channels, render: (m, q) => m.channels.filter(c => matches(q, 'каналы', c.id, c.name)).map(c => entityButton('channel', c.id, c.id.replace('-', '–'), esc(c.name))).join('') || (!q ? '<p class="summary-note">Полных каналов нет.</p>' : '') },
  { id: 'gates', title: 'Ворота', count: m => m.totals.gates, render: (m, q) => m.gates.filter(g => matches(q, 'ворота', g.id, g.name)).map(g => entityButton('gate', g.id, `${g.id} · ${g.name}`, `${g.design ? '<i class="summary-source-dot design" title="Дизайн"></i>' : ''}${g.personality ? '<i class="summary-source-dot personality" title="Личность"></i>' : ''}${g.activationCount > 1 ? `<span>×${g.activationCount}</span>` : ''}`)).join('') || (!q ? '<p class="summary-note">Активированных ворот нет.</p>' : '') },
];

export function renderSummarySections(model, query = '', expanded = new Set(['lines'])) {
  const q = normalize(query);
  const sections = SUMMARY_SECTIONS.map(section => {
    const body = section.render(model, q);
    if (!body) return '';
    const count = section.count(model);
    return `<details class="summary-section" data-summary-section="${section.id}" ${q || expanded.has(section.id) ? 'open' : ''}><summary><span>${section.title}</span><span class="summary-section-count">${count ?? '—'}</span><span class="summary-chevron" aria-hidden="true">⌄</span></summary><div class="summary-section-body">${body}</div></details>`;
  }).join('');
  return sections || '<p class="summary-note summary-empty">Ничего не найдено. Попробуйте номер ворот или название раздела.</p>';
}

export function attachChartSummary({ panel, summaryScreen, returnsPanel, content, overview, search, switcher, backdrop, onSelect, onLines, onOpen = () => {}, onClose = () => {} }) {
  const document = panel.ownerDocument;
  const window = document.defaultView;
  const summaryLabel = panel.getAttribute('aria-labelledby');
  let summaryOpened = false, returnsVisible = false, model = null, fingerprint = '', expanded = new Set(['lines']);
  let currentItems = [], currentFilter = null, selectionFingerprint = '', lastId = null, appliedScreen = null, currentChart = null;
  const screen = () => returnsVisible ? 'returns' : summaryOpened ? 'summary' : 'closed';
  function layout() {
    // Camera callbacks read only this cheap projection, never cycle results.
    const next = screen();
    if (appliedScreen === next) return;
    const previous = appliedScreen;
    if (next === 'closed' && panel.contains(document.activeElement)) switcher.focus({ preventScroll: true });
    appliedScreen = next;
    const opened = next !== 'closed';
    // Retain the last screen and its placement throughout the closing slide.
    // The shell becomes inaccessible immediately, without erasing its contents.
    if (opened || previous === null) {
      const shown = opened ? next : 'summary';
      panel.dataset.screen = shown;
      if (summaryScreen) summaryScreen.hidden = shown !== 'summary';
      if (returnsPanel) returnsPanel.hidden = shown !== 'returns';
      const label = shown === 'returns' ? returnsPanel?.getAttribute('aria-labelledby') : summaryLabel;
      if (label) panel.setAttribute('aria-labelledby', label);
    }
    panel.hidden = false;
    panel.inert = !opened;
    panel.classList.toggle('open', opened);
    panel.setAttribute('aria-hidden', String(!opened));
    switcher.setAttribute('aria-expanded', String(opened));
    if (backdrop) backdrop.hidden = !opened;
    if (next === 'summary') {
      updateVisible();
      if (returnsPanel?.contains(document.activeElement)) search.focus({ preventScroll: true });
    }
  }
  function open() {
    if (screen() === 'summary') return;
    summaryOpened = true;
    onOpen(); // The application closes returns through its existing controller.
    layout();
    if (screen() === 'summary') search.focus({ preventScroll: true });
  }
  function close({ focus = false } = {}) {
    const active = screen();
    if (active === 'closed') return;
    if (focus || panel.contains(document.activeElement)) switcher.focus({ preventScroll: true });
    summaryOpened = false;
    onClose(); // Closes the returns owner too, even when only that screen is open.
    layout();
  }
  const toggle = () => screen() === 'closed' ? open() : close();
  function setReturnsVisible(value) {
    const visible = Boolean(value);
    if (returnsVisible === visible) return;
    // A view projection supplied by app.js, not another return-opening command.
    returnsVisible = visible;
    layout();
  }
  function syncSelection(force = false) {
    const key = JSON.stringify([currentItems, currentFilter]);
    if (!force && key === selectionFingerprint) return;
    selectionFingerprint = key;
    const groups = currentFilter?.groups || (currentFilter ? [currentFilter] : []);
    content.querySelectorAll('[data-summary-line]').forEach(button => {
      const line = Number(button.dataset.summaryLine), source = button.dataset.summarySource;
      const gates = model?.lines.find(row => row.line === line)?.gates[source] || [];
      const pressed = groups.some(group => group.line === line && group.source === source
        && (!group.gates || gates.length === group.gates.length && gates.every(gate => group.gates.includes(gate))));
      if (button.getAttribute('aria-pressed') !== String(pressed)) button.setAttribute('aria-pressed', String(pressed));
    });
    content.querySelectorAll('[data-summary-type]').forEach(button => {
      const pressed = String(currentItems.some(item => item.type === button.dataset.summaryType && String(item.id) === button.dataset.summaryId));
      if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
    });
  }
  function render() {
    if (!model) return;
    content.innerHTML = renderSummarySections(model, search.value, expanded);
    syncSelection(true);
  }
  function update(chart, { items = [], filter = null } = {}) {
    currentChart = chart; currentItems = items; currentFilter = filter;
    // Keep only the latest inputs while closed. The existing markup can finish
    // its exit animation; chart facts and controls are prepared on opening.
    if (screen() === 'summary') updateVisible();
  }
  function updateVisible() {
    const chart = currentChart;
    if (!chart) return;
    const rowsChart = primaryChart(chart), topology = chartTopology(chart);
    const key = JSON.stringify([chart.id, chart.kind, rowsChart.source, rowsChart.name, topology.personality, topology.design, ['design', 'personality'].map(source => rowsChart.activations?.[source]?.map(a => [a.planet, a.gate, a.line]))]);
    if (lastId !== chart.id) { search.value = ''; content.scrollTop = 0; lastId = chart.id; }
    if (key !== fingerprint) {
      fingerprint = key; model = buildChartSummary(chart);
      overview.innerHTML = `<span>${model.scope === 'overlay' ? 'Топология наложения' : model.isTransit ? 'Транзит' : model.profile ? `Профиль <strong>${esc(model.profile)}</strong>` : 'Обзор карты'}</span><span><strong>${model.totals.centers}</strong> / 9 центров · <strong>${model.totals.channels}</strong> каналов</span>`;
      render();
    } else syncSelection();
  }
  switcher.addEventListener('click', toggle);
  backdrop?.addEventListener('click', () => close());
  search.addEventListener('input', render);
  content.addEventListener('toggle', event => {
    const id = event.target.dataset?.summarySection;
    if (!id || search.value) return;
    if (event.target.open) expanded.add(id); else expanded.delete(id);
  }, true);
  content.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.summaryLine) {
      const line = Number(button.dataset.summaryLine), source = button.dataset.summarySource;
      const row = model.lines.find(item => item.line === line);
      if (row) onLines(row.gates[source], { line, source }, { additive: event.shiftKey });
    } else if (button.dataset.summaryType) {
      onSelect({ type: button.dataset.summaryType, id: button.dataset.summaryId, additive: event.shiftKey });
    } else return;
    // A narrow drawer covers most of the chart. Reveal an ordinary selection,
    // while keeping Shift selections open so several items can be combined.
    if (window.innerWidth <= 850 && !event.shiftKey) close();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && screen() !== 'closed' && !event.defaultPrevented && !document.querySelector('dialog[open]') && !document.querySelector('.library.open')) {
      event.preventDefault(); close({ focus: true });
    }
  });
  layout();
  return { update, layout, open, close, toggle, setReturnsVisible,
    get opened() { return screen() !== 'closed'; }, get screen() { return screen(); } };
}
