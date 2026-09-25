import { buildChartSummary } from './chart-summary-data.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const labels = { design: 'Дизайн', personality: 'Личность', all: 'Всего' };
const normalize = value => String(value).toLocaleLowerCase('ru').replace(/ё/g, 'е').trim();
const matches = (query, ...values) => !query || normalize(values.join(' ')).includes(query);

function lineRows(model, query) {
  if (!model.hasLines) return matches(query, 'линии') ? '<p class="summary-note">Для подсчёта линий нужны планетарные активации. В этой карте они пока недоступны.</p>' : '';
  const sources = model.isTransit ? ['personality'] : ['design', 'personality', 'all'];
  const rows = model.lines.filter(row => matches(query, 'линии', row.line));
  if (!rows.length) return '';
  return `<div class="summary-lines ${model.isTransit ? 'is-transit' : ''}" role="table" aria-label="Количество активаций по линиям">
    <div class="summary-line-head" role="row"><span role="columnheader">Линия</span>${sources.map(source => `<span role="columnheader" class="summary-${source}">${model.isTransit ? 'Транзит' : labels[source]}</span>`).join('')}</div>
    ${rows.map(row => `<div class="summary-line-row" role="row"><span role="rowheader">${row.line}</span>${sources.map(source => {
      const count = source === 'all' ? row.total : row[source];
      return `<span role="cell"><button type="button" class="summary-count summary-${source}" data-summary-line="${row.line}" data-summary-source="${source}" aria-label="Линия ${row.line}, ${model.isTransit ? 'Транзит' : labels[source]}: ${count}" aria-pressed="false" ${count ? '' : 'disabled'}>${count}</button></span>`;
    }).join('')}</div>`).join('')}
    </div><p class="summary-note">Каждая активация считается отдельно, включая лунные узлы. Клик — выделить; Shift — добавить или убрать.</p>`;
}

const entityButton = (type, id, title, detail, extra = '') => `<button type="button" class="summary-entity" data-summary-type="${type}" data-summary-id="${esc(id)}" aria-pressed="false"><span>${esc(title)}</span><span class="summary-entity-detail">${detail}</span>${extra}</button>`;

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

export function attachChartSummary({ panel, content, overview, search, switcher, backdrop, onSelect, onLines, onOpen = () => {}, onClose = () => {} }) {
  const document = panel.ownerDocument;
  const window = document.defaultView;
  let opened = false, model = null, fingerprint = '', expanded = new Set(['lines']);
  let currentItems = [], currentFilter = null, lastId = null;
  function layout() {
    // CSS slides the overlay without changing the chart's layout or camera.
    // Keep it rendered for its closing transition, but inaccessible when shut.
    panel.hidden = false;
    panel.inert = !opened;
    panel.classList.toggle('open', opened);
    panel.setAttribute('aria-hidden', String(!opened));
    switcher.setAttribute('aria-expanded', String(opened));
    if (backdrop) backdrop.hidden = !opened;
  }
  function setOpen(value, focus = false) {
    if (opened === value) return;
    if (!value && (focus || panel.contains(document.activeElement))) switcher.focus({ preventScroll: true });
    opened = value;
    if (opened) onOpen();
    layout();
    if (opened) search.focus({ preventScroll: true });
    else onClose();
  }
  const open = () => setOpen(true);
  const close = ({ focus = false } = {}) => setOpen(false, focus);
  const toggle = () => setOpen(!opened);
  function syncSelection() {
    const groups = currentFilter?.groups || (currentFilter ? [currentFilter] : []);
    content.querySelectorAll('[data-summary-line]').forEach(button => {
      const line = Number(button.dataset.summaryLine), source = button.dataset.summarySource;
      const gates = model?.lines.find(row => row.line === line)?.gates[source] || [];
      const pressed = groups.some(group => group.line === line && group.source === source
        && (!group.gates || gates.length === group.gates.length && gates.every(gate => group.gates.includes(gate))));
      button.setAttribute('aria-pressed', String(pressed));
    });
    content.querySelectorAll('[data-summary-type]').forEach(button => button.setAttribute('aria-pressed', String(currentItems.some(item => item.type === button.dataset.summaryType && String(item.id) === button.dataset.summaryId))));
  }
  function render() {
    if (!model) return;
    content.innerHTML = renderSummarySections(model, search.value, expanded);
    syncSelection();
  }
  function update(chart, { items = [], filter = null } = {}) {
    currentItems = items; currentFilter = filter;
    const key = JSON.stringify([chart.id, chart.source, chart.personality, chart.design, ['design', 'personality'].map(source => chart.activations?.[source]?.map(a => [a.planet, a.gate, a.line]))]);
    if (lastId !== chart.id) { search.value = ''; content.scrollTop = 0; lastId = chart.id; }
    if (key !== fingerprint) {
      fingerprint = key; model = buildChartSummary(chart);
      overview.innerHTML = `<span>${model.isTransit ? 'Транзит' : model.profile ? `Профиль <strong>${esc(model.profile)}</strong>` : 'Обзор карты'}</span><span><strong>${model.totals.centers}</strong> / 9 центров · <strong>${model.totals.channels}</strong> каналов</span>`;
      render();
    } else syncSelection();
    if (opened) layout();
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
    if (event.key === 'Escape' && opened && !event.defaultPrevented && !document.querySelector('dialog[open]') && !document.querySelector('.library.open')) {
      event.preventDefault(); close({ focus: true });
    }
  });
  layout();
  return { update, layout, open, close, toggle, get opened() { return opened; } };
}
