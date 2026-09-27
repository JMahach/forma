import { renderChartThumbnail } from './thumbnail.js';
import { formatDateInput } from './date-input.js';
import { canManageChart } from './chart-display.js';
import { escapeHtml as esc } from '../ui/html.js';

const sourceNames = { calculated: 'Расчёт по данным рождения', manual: 'Ручные активации', transit: 'Транзит' };

function rowContent(chart, selected) {
  const caption = chart.birthDate ? [formatDateInput(chart.birthDate), chart.birthTime].filter(Boolean).join(' · ') : sourceNames[chart.source] || 'Ручные активации';
  return `<button class="chart-card" data-chart-id="${esc(chart.id)}" data-active="${selected}" aria-pressed="${selected}"><img class="chart-avatar chart-thumbnail" alt="" aria-hidden="true" width="44" height="68" decoding="async"><span class="chart-copy"><span class="chart-name">${esc(chart.name)}</span><span class="chart-caption">${esc(caption)}</span></span></button><details class="chart-actions"><summary aria-label="Действия с картой «${esc(chart.name)}»" title="Действия с картой"><span aria-hidden="true">⋯</span></summary><div class="chart-action-menu"><button data-chart-action="edit" data-action-chart-id="${esc(chart.id)}">Редактировать</button><button class="danger-text" data-chart-action="delete" data-action-chart-id="${esc(chart.id)}">Удалить</button></div></details>`;
}

// Saved data never lives here. Rows retain DOM identity across selection and
// minute updates; only visible rows plus a small scroll margin need images.
export function createChartLibraryView({
  chartList, libraryCount, nowButton, document = chartList.ownerDocument,
  thumbnail = renderChartThumbnail,
  createObserver = typeof globalThis.IntersectionObserver === 'function'
    ? (callback, options) => new globalThis.IntersectionObserver(callback, options) : null,
  schedule = callback => setTimeout(callback, 0), cancel = clearTimeout,
}) {
  const rows = new Map(), rowRecords = new WeakMap(), pending = new Set();
  let charts = [], personal = [], renderedCharts = null, selectedId = null, opened = false, job = null;
  function paintBatch() {
    job = null;
    if (!opened) return;
    let count = 0;
    for (const entry of pending) {
      pending.delete(entry);
      if (rows.get(entry.key) !== entry || entry.ready) continue;
      entry.image.src = thumbnail(entry.chart); entry.ready = true;
      observer?.unobserve(entry.row);
      if (++count === 4) break;
    }
    if (pending.size) job = schedule(paintBatch);
  }
  function enqueue(entry) {
    if (!opened || entry.ready) return;
    pending.add(entry);
    if (job === null) job = schedule(paintBatch);
  }
  const observer = createObserver?.(entries => {
    if (!opened) return;
    for (const item of entries) {
      const entry = rowRecords.get(item.target);
      if (!entry) continue;
      if (item.isIntersecting) enqueue(entry); else pending.delete(entry);
    }
  }, { root: chartList, rootMargin: '120px 0px' });
  function measureVisible() {
    if (!opened || observer) return;
    const bounds = chartList.getBoundingClientRect();
    for (const entry of rows.values()) {
      const rect = entry.row.getBoundingClientRect();
      if (rect.bottom >= bounds.top - 120 && rect.top <= bounds.bottom + 120) enqueue(entry);
      else pending.delete(entry);
    }
  }
  chartList.addEventListener('scroll', measureVisible, { passive: true });
  function markEntry(entry, active) {
    entry.row.dataset.active = String(active);
    entry.button.dataset.active = String(active);
    entry.button.setAttribute('aria-pressed', String(active));
  }
  function markSelected(id, active) {
    for (const entry of rows.values()) if (entry.chart.id === id) markEntry(entry, active);
  }
  function reconcile() {
    if (!opened || renderedCharts === charts) return;
    // IDs are navigation targets, not a storage repair policy. If an existing
    // collection contains repeated IDs, preserve every visible row as before.
    const occurrences = new Map();
    const entries = personal.map(chart => {
      const occurrence = occurrences.get(chart.id) || 0;
      occurrences.set(chart.id, occurrence + 1);
      return { chart, key: `${chart.id}:${occurrence}` };
    });
    const retained = new Set(entries.map(entry => entry.key));
    for (const [id, entry] of rows) if (!retained.has(id)) {
      observer?.unobserve(entry.row); pending.delete(entry); entry.row.remove(); rows.delete(id);
    }
    let previous = null;
    for (const { chart, key } of entries) {
      let entry = rows.get(key);
      if (!entry) {
        const row = document.createElement('div');
        row.className = 'chart-row has-actions';
        entry = { key, chart: null, row, ready: false }; rows.set(key, entry); rowRecords.set(row, entry);
      }
      if (entry.chart !== chart) {
        pending.delete(entry); entry.chart = chart; entry.ready = false;
        entry.row.innerHTML = rowContent(chart, chart.id === selectedId);
        entry.button = entry.row.querySelector('.chart-card'); entry.image = entry.row.querySelector('img');
        markEntry(entry, chart.id === selectedId);
      }
      const position = previous ? previous.nextSibling : chartList.firstChild;
      if (position !== entry.row) chartList.insertBefore(entry.row, position);
      previous = entry.row;
      if (!entry.ready) observer?.observe(entry.row);
    }
    renderedCharts = charts;
    measureVisible();
  }
  return {
    update(nextCharts, nextSelectedId) {
      if (charts !== nextCharts) {
        charts = nextCharts; personal = charts.filter(canManageChart);
        libraryCount.textContent = personal.length;
      }
      if (selectedId !== nextSelectedId) {
        markSelected(selectedId, false); selectedId = nextSelectedId; markSelected(selectedId, true);
        nowButton.setAttribute('aria-pressed', String(selectedId === 'current-transit'));
      }
      reconcile();
    },
    show() {
      opened = true; reconcile();
      for (const entry of rows.values()) if (!entry.ready) observer?.observe(entry.row);
      measureVisible();
    },
    hide() {
      opened = false; observer?.disconnect(); pending.clear();
      if (job !== null) cancel(job);
      job = null;
    },
  };
}

export function attachChartLibrary({ document, store, session, onSelect, onEdit, onNew, onUpdate = () => {}, beforeOpen = () => {}, toast }) {
  const $ = id => document.getElementById(id);
  let deletingId = null;
  const view = createChartLibraryView({ chartList: $('chartList'), libraryCount: $('libraryCount'), nowButton: $('nowButton'), document });
  function render() { view.update(store.charts, session.selectedId); }

  function openLibrary() {
    beforeOpen();
    $('library').inert = false;
    $('library').classList.add('open');
    $('libraryBackdrop').hidden = false;
    $('openLibrary').setAttribute('aria-expanded', 'true');
    render(); view.show();
    $('nowButton').focus({ preventScroll: true });
  }
  function closeLibrary() {
    const restoreFocus = $('library').contains(document.activeElement);
    view.hide();
    $('library').classList.remove('open');
    $('library').inert = true;
    $('libraryBackdrop').hidden = true;
    $('openLibrary').setAttribute('aria-expanded', 'false');
    if (restoreFocus) $('openLibrary').focus({ preventScroll: true });
  }

  document.addEventListener('click', e => {
    const action = e.target.closest('[data-chart-action]');
    if (action) {
      const c = store.charts.find(item => item.id === action.dataset.actionChartId);
      if (!canManageChart(c)) return;
      action.closest('details').open = false;
      if (action.dataset.chartAction === 'edit') onEdit(c.id);
      else openDeleteChart(c);
      return;
    }
    const button = e.target.closest('[data-chart-id]'); if (button) onSelect(button.dataset.chartId);
  });
  document.addEventListener('toggle', e => {
    if (!e.target.matches?.('.chart-actions[open]')) return;
    document.querySelectorAll('.chart-actions[open]').forEach(item => { if (item !== e.target) item.open = false; });
  }, true);
  document.addEventListener('pointerdown', e => document.querySelectorAll('.chart-actions[open]').forEach(item => { if (!item.contains(e.target)) item.open = false; }));
  $('newChartButton').addEventListener('click', () => onNew());
  function openDeleteChart(c) {
    if (!canManageChart(c)) return;
    deletingId = c.id;
    $('deleteChartName').textContent = `«${c.name}»`;
    $('deleteChartError').textContent = '';
    $('deleteChartDialog').showModal();
    $('cancelDeleteChart').focus();
  }
  $('cancelDeleteChart').addEventListener('click', () => $('deleteChartDialog').close());
  $('confirmDeleteChart').addEventListener('click', () => {
    try {
      store.remove(deletingId);
      $('deleteChartDialog').close();
      if (session.selectedId === deletingId) onSelect(store.charts.find(c => c.id !== 'current-transit')?.id || 'current-transit');
      else onUpdate();
      deletingId = null;
      toast('Карта удалена');
    } catch { $('deleteChartError').textContent = 'Не удалось удалить карту. Она осталась в библиотеке.'; }
  });

  $('openLibrary').addEventListener('click', openLibrary);
  $('libraryBackdrop').addEventListener('click', closeLibrary);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const menu = document.querySelector('.chart-actions[open]');
    if (menu) { menu.open = false; menu.querySelector('summary').focus(); e.preventDefault(); return; }
    closeLibrary();
  });

  return { open: openLibrary, close: closeLibrary, render };
}
