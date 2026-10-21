import type { SavedChart } from '../../shared/chart-types.ts';
import type { ChartStore } from '../data/chart-store.ts';
import type { ChartSession } from '../state/chart-session.ts';
import type { PanelState } from '../state/panels.ts';
import type { WorkspaceScreen } from '../state/workspace.ts';
interface LibraryRow { key: string; chart: SavedChart | null; row: HTMLElement; button?: HTMLButtonElement | null }
export type ChartLibraryView = ReturnType<typeof createChartLibraryView>;
export type ChartLibrary = ReturnType<typeof attachChartLibrary>;
interface LibraryOptions {
  panels?: PanelState; document: Document; view?: ChartLibraryView | null; store: ChartStore; session: ChartSession;
  onSelect: (id: string) => void; onEdit: (id: string) => void; onNew: () => void;
  onUpdate?: () => void; beforeOpen?: () => void; getSelectedId?: () => string | null;
}

import { createPanelState } from '../state/panels.ts';
import { formatDateInput } from './date-input.ts';
import { canManageLibraryRecord } from './chart-display.ts';
import { escapeHtml as esc } from '../ui/html.ts';

const sourceNames = { calculated: 'Расчёт по данным рождения', manual: 'Ручные активации', transit: 'Транзит' };

export function renderChartLibraryRow(chart: SavedChart, selected: boolean, { preview = false } = {}) {
  const caption = chart.birthDate ? [formatDateInput(chart.birthDate), chart.birthTime].filter(Boolean).join(' · ') : sourceNames[chart.source] || 'Ручные активации';
  return `<button class="chart-card" data-chart-id="${esc(chart.id)}" data-active="${selected}" aria-pressed="${selected}">${preview ? '<canvas class="chart-preview" width="0" height="0" aria-hidden="true"></canvas>' : ''}<span class="chart-copy"><span class="chart-name">${esc(chart.name)}</span><span class="chart-caption">${esc(caption)}</span></span></button><details class="chart-actions"><summary aria-label="Действия с картой «${esc(chart.name)}»" title="Действия с картой"><span aria-hidden="true">⋯</span></summary><div class="chart-action-menu"><button data-chart-action="edit" data-action-chart-id="${esc(chart.id)}">Редактировать</button><button class="danger-text" data-chart-action="delete" data-action-chart-id="${esc(chart.id)}">Удалить</button></div></details>`;
}

// Saved data never lives here. Compact navigation rows keep their identity
// across selection and minute updates; a closed list defers reconciliation.
export function createChartLibraryView({ chartList, libraryCount, nowButton, document = chartList.ownerDocument }: { chartList: HTMLElement; libraryCount: HTMLElement; nowButton: HTMLElement; document?: Document }) {
  const rows = new Map<string, LibraryRow>();
  let charts: SavedChart[] = [], personal: SavedChart[] = [], renderedCharts: SavedChart[] | null = null, selectedId: string | null | undefined, opened = false;
  function markEntry(entry: LibraryRow, active: boolean) {
    entry.row.dataset.active = String(active);
    entry.button!.dataset.active = String(active);
    entry.button!.setAttribute('aria-pressed', String(active));
  }
  function markSelected(id: string | null | undefined, active: boolean) {
    for (const entry of rows.values()) if (entry.chart!.id === id) markEntry(entry, active);
  }
  function reconcile() {
    if (!opened || renderedCharts === charts) return;
    // IDs are navigation targets, not a storage repair policy. If an existing
    // collection contains repeated IDs, preserve every visible row as before.
    const occurrences = new Map<string, number>();
    const entries = personal.map(chart => {
      const occurrence = occurrences.get(chart.id) || 0;
      occurrences.set(chart.id, occurrence + 1);
      return { chart, key: `${chart.id}:${occurrence}` };
    });
    const retained = new Set(entries.map(entry => entry.key));
    for (const [id, entry] of rows) if (!retained.has(id)) {
      entry.row.remove(); rows.delete(id);
    }
    let previous: HTMLElement | null = null;
    for (const { chart, key } of entries) {
      let entry = rows.get(key);
      if (!entry) {
        const row = document.createElement('div');
        row.className = 'chart-row has-actions';
        entry = { key, chart: null, row }; rows.set(key, entry);
      }
      if (entry.chart !== chart) {
        entry.chart = chart;
        entry.row.innerHTML = renderChartLibraryRow(chart, chart.id === selectedId);
        entry.button = entry.row.querySelector('.chart-card');
        markEntry(entry, chart.id === selectedId);
      }
      const position: ChildNode | null = previous ? previous.nextSibling : chartList.firstChild;
      if (position !== entry.row) chartList.insertBefore(entry.row, position);
      previous = entry.row;
    }
    renderedCharts = charts;
  }
  return {
    update(nextCharts: SavedChart[], nextSelectedId: string | null) {
      if (charts !== nextCharts) {
        charts = nextCharts; personal = charts.filter(canManageLibraryRecord);
        libraryCount.textContent = String(personal.length);
      }
      if (selectedId !== nextSelectedId) {
        markSelected(selectedId, false); selectedId = nextSelectedId; markSelected(selectedId, true);
        nowButton.setAttribute('aria-pressed', String(selectedId === 'current-transit'));
      }
      reconcile();
    },
    setScreen(screen: WorkspaceScreen) {
      for (const [id, section] of [['openKnowledge', 'library'], ['openAllCharts', 'charts'], ['openAccount', 'account']]) {
        const selected = screen === section, button = document.getElementById(id)!;
        button.setAttribute('aria-pressed', String(selected));
        if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
      }
    },
    show() {
      if (opened) return;
      opened = true;
      reconcile();
    },
    hide() { opened = false; },
  };
}

export function attachChartLibrary({ panels = createPanelState(), document, view = null, store, session, onSelect, onEdit, onNew, onUpdate = () => {}, beforeOpen = () => {}, getSelectedId = () => session.selectedId }: LibraryOptions) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  let deletingId: string | null = null, appliedOpen: boolean | null = null;
  view ??= createChartLibraryView({ chartList: $('chartList'), libraryCount: $('libraryCount'), nowButton: $('nowButton'), document });
  function render() { view!.update(store.charts, getSelectedId()); }

  function syncOpen() {
    const opened = panels.left;
    if (appliedOpen === opened) return;
    appliedOpen = opened;
    $('library').inert = !opened;
    $('library').classList.toggle('open', opened);
    $('library').setAttribute('aria-hidden', String(!opened));
    $('libraryBackdrop').hidden = !opened;
    $('openLibrary').setAttribute('aria-expanded', String(opened));
    if (opened) { render(); view!.show(); } else view!.hide();
  }
  function openLibrary() {
    if (panels.left) return;
    beforeOpen();
    panels.setLeft(true);
    syncOpen();
    $('nowButton').focus({ preventScroll: true });
  }
  function closeLibrary() {
    if (!panels.left) return;
    const restoreFocus = $('library').contains(document.activeElement);
    panels.setLeft(false);
    syncOpen();
    if (restoreFocus) $('openLibrary').focus({ preventScroll: true });
  }
  const toggle = () => panels.left ? closeLibrary() : openLibrary();

  document.addEventListener('click', e => {
    const action = (e.target as Element).closest<HTMLElement>('[data-chart-action]');
    if (action) {
      const c = store.charts.find(item => item.id === action.dataset.actionChartId);
      if (!canManageLibraryRecord(c)) return;
      action.closest('details')!.open = false;
      if (action.dataset.chartAction === 'edit') onEdit(c!.id);
      else openDeleteChart(c!);
      return;
    }
    const button = (e.target as Element).closest<HTMLElement>('[data-chart-id]'); if (button) onSelect(button.dataset.chartId!);
  });
  document.addEventListener('toggle', e => {
    if (!(e.target as Element).matches?.('.chart-actions[open]')) return;
    document.querySelectorAll<HTMLDetailsElement>('.chart-actions[open]').forEach(item => { if (item !== e.target) item.open = false; });
  }, true);
  document.addEventListener('pointerdown', e => document.querySelectorAll<HTMLDetailsElement>('.chart-actions[open]').forEach(item => { if (!item.contains(e.target as Node | null)) item.open = false; }));
  $('newChartButton').addEventListener('click', () => onNew());
  function openDeleteChart(c: SavedChart) {
    if (!canManageLibraryRecord(c)) return;
    deletingId = c.id;
    $('deleteChartName').textContent = `«${c.name}»`;
    $('deleteChartError').textContent = '';
    $<HTMLDialogElement>('deleteChartDialog').showModal();
    $('cancelDeleteChart').focus();
  }
  $('cancelDeleteChart').addEventListener('click', () => $<HTMLDialogElement>('deleteChartDialog').close());
  $('confirmDeleteChart').addEventListener('click', () => {
    try {
      store.remove(deletingId!);
      $<HTMLDialogElement>('deleteChartDialog').close();
      if (session.selectedId === deletingId) onSelect(store.charts.find(c => c.id !== 'current-transit')?.id || 'current-transit');
      else onUpdate();
      deletingId = null;
    } catch { $('deleteChartError').textContent = 'Не удалось удалить карту. Она осталась в библиотеке.'; }
  });

  $('openLibrary').addEventListener('click', toggle);
  $('libraryBackdrop').addEventListener('click', closeLibrary);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
    const menu = document.querySelector<HTMLDetailsElement>('.chart-actions[open]');
    if (menu) { menu.open = false; menu.querySelector('summary')!.focus(); e.preventDefault(); return; }
    if (panels.left) { closeLibrary(); e.preventDefault(); }
  });

  panels.subscribe(syncOpen);
  syncOpen();
  return { open: openLibrary, close: closeLibrary, toggle, render, syncOpen, get opened() { return panels.left; } };
}
