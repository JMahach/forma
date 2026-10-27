import { captureTextSelection, restoreTextSelection, watchTextSelection } from './input-selection.ts';
import type { SavedView } from '../data/view-store.ts';
import type { SavedChart } from '../../shared/chart-types.ts';
import { attachWorkspaceHeader } from './workspace-header.ts';
interface PreviewEntry { key: string; row: HTMLElement; chart: SavedChart; canvas: HTMLCanvasElement; visible: boolean; release: (() => void) | null; paint: object | null; painted: boolean; failed: boolean }
interface AllChartsOptions {
  initialView?: SavedView['charts']; onChange?: () => void; onRowsChange?: () => void; canEdit?: () => boolean;
  button: HTMLButtonElement; dialog: HTMLElement; list: HTMLElement; getCharts: () => readonly SavedChart[]; onOpen?: (() => void) | null; document?: Document;
  preview?: typeof createChartPreview; schedule?: (callback: () => void) => ReturnType<typeof setTimeout>; cancel?: typeof clearTimeout;
  createObserver?: ((callback: IntersectionObserverCallback, options: IntersectionObserverInit) => IntersectionObserver) | null;
}
export type AllCharts = ReturnType<typeof attachAllCharts>;

import { renderChartLibraryRow } from './library.ts';
import { canManageLibraryRecord } from './chart-display.ts';
import { createChartPreview, sameSavedChartPreview } from './chart-preview-canvas.ts';

const normalizeSearch = (value: string) => value.toLowerCase().replace(/ё/g, 'е').trim().replace(/\s+/g, ' ');
function chartSearchText(chart: SavedChart) {
  const date = chart.birthDate ?? '';
  const formattedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.split('-').reverse().join('.') : '';
  return normalizeSearch([chart.name, date, formattedDate, chart.birthPlace,
    chart.city?.name, chart.city?.region, chart.city?.country].filter(Boolean).join(' '));
}

// This workspace page reads the same library; the existing document-level commands own
// selection, editing and deletion. Only nearby, temporary pixels belong here.
export function attachAllCharts({ button, dialog, list, getCharts,
  onOpen = null, document = dialog.ownerDocument, initialView, onChange = () => {}, onRowsChange = () => {}, canEdit = () => true,
  preview = createChartPreview, schedule = callback => setTimeout(callback, 0), cancel = clearTimeout,
  createObserver = typeof globalThis.IntersectionObserver === 'function'
    ? (callback, options) => new globalThis.IntersectionObserver(callback, options) : null,
}: AllChartsOptions) {
  const header = attachWorkspaceHeader(dialog, { initialExpanded: initialView?.searchOpen, onChange });
  let rows = new Map<Element, PreviewEntry>();
  const pending = new Set<PreviewEntry>(), readiness = new Set<{ entries: PreviewEntry[]; resolve: (value: boolean | null) => void }>();
  const search = dialog.querySelector?.<HTMLInputElement>('#allChartsSearch');
  const resultCount = dialog.querySelector?.<HTMLElement>('#allChartsCount');
  const empty = dialog.querySelector?.<HTMLElement>('#allChartsEmpty');
  if (search && initialView) search.value = initialView.query;
  if (search) watchTextSelection([search], onChange);
  const inputFocus = () => dialog.hidden ? null : captureTextSelection(search);
  const restoreInputFocus = () => !dialog.hidden && restoreTextSelection(search, initialView?.focus);
  let query = normalizeSearch(search?.value ?? ''), renderedQuery = '';
  let charts: readonly SavedChart[] | null = null, job: ReturnType<typeof setTimeout> | null = null;
  let renderedEditDisabled = false;
  function paint() {
    job = null;
    if (dialog.hidden) return;
    let count = 0;
    for (const entry of pending) {
      pending.delete(entry);
      if (!entry.visible || !rows.has(entry.row)) continue;
      const request = entry.paint = {};
      try {
        entry.release = preview(entry.canvas, entry.chart, { onReady(success) {
          if (entry.paint !== request || !entry.visible || rows.get(entry.row) !== entry || dialog.hidden) return;
          entry.painted = success === true; entry.failed = !entry.painted;
          settleReadiness();
        } });
      } catch { entry.failed = true; }
      if (++count === 2) break;
    }
    if (pending.size) job = schedule(paint);
    settleReadiness();
  }
  function releaseEntry(entry: PreviewEntry) {
    entry.paint = null; entry.painted = false; entry.failed = false;
    entry.release?.(); entry.release = null;
  }
  function visible(entry: PreviewEntry, value: boolean) {
    if (entry.visible === value) return;
    entry.visible = value;
    if (value) {
      entry.failed = false;
      pending.add(entry);
      if (job === null) job = schedule(paint);
    } else {
      pending.delete(entry); releaseEntry(entry);
      settleReadiness();
    }
  }
  const observer = createObserver?.(entries => {
    if (dialog.hidden) return;
    for (const item of entries) {
      const entry = rows.get(item.target);
      if (entry) visible(entry, item.isIntersecting);
    }
  }, { root: list, rootMargin: '120px 0px' });
  function measure() {
    if (observer || dialog.hidden) return;
    const bounds = list.getBoundingClientRect();
    for (const entry of rows.values()) {
      const rect = entry.row.getBoundingClientRect();
      visible(entry, rect.bottom >= bounds.top - 120 && rect.top <= bounds.bottom + 120);
    }
  }
  function cancelReadiness() {
    for (const wait of readiness) wait.resolve(null);
    readiness.clear();
  }
  function release() {
    cancelReadiness();
    observer?.disconnect();
    if (job !== null) cancel(job);
    job = null; pending.clear();
    for (const entry of rows.values()) releaseEntry(entry);
    rows.clear(); list.replaceChildren(); charts = null;
  }
  function update() {
    if (dialog.hidden) return;
    const currentCharts = getCharts();
    const editDisabled = !canEdit();
    if (renderedEditDisabled !== editDisabled) for (const entry of rows.values()) {
      const edit = entry.row.querySelector<HTMLButtonElement>('[data-chart-action="edit"]');
      if (edit) edit.disabled = editDisabled;
    }
    renderedEditDisabled = editDisabled;
    if (charts !== currentCharts || renderedQuery !== query) {
      charts = currentCharts;
      renderedQuery = query;
      const available = charts.filter(canManageLibraryRecord);
      const terms = query.split(' ').filter(Boolean);
      const filtered = terms.length ? available.filter(chart => {
        const text = chartSearchText(chart);
        return terms.every(term => text.includes(term));
      }) : available;
      if (resultCount) resultCount.textContent = query ? `Найдено: ${filtered.length} из ${available.length}` : `Карт: ${available.length}`;
      if (empty) {
        empty.hidden = filtered.length > 0;
        empty.textContent = query ? 'Ничего не найдено. Попробуйте другое имя, дату или город.' : 'Сохранённых карт пока нет.';
      }
      let buttonsChanged = false;
      const previous = new Map([...rows.values()].map(entry => [entry.key, entry]));
      const next = new Map<Element, PreviewEntry>(), occurrences = new Map<string, number>();
      for (const chart of filtered) {
        const occurrence = occurrences.get(chart.id) ?? 0;
        occurrences.set(chart.id, occurrence + 1);
        const key = `${chart.id}:${occurrence}`;
        let entry = previous.get(key);
        if (!entry) {
          const row = document.createElement('div');
          row.className = 'chart-row has-actions';
          row.innerHTML = renderChartLibraryRow(chart, false, { preview: true, editDisabled });
          buttonsChanged = true;
          entry = { key, row, chart, canvas: row.querySelector('canvas')!, visible: false, release: null, paint: null, painted: false, failed: false };
        } else {
          if (!sameSavedChartPreview(entry.chart, chart)) {
            releaseEntry(entry);
            if (entry.visible) {
              pending.add(entry);
              if (job === null) job = schedule(paint);
            }
          }
          if (entry.chart.name !== chart.name || entry.chart.source !== chart.source
            || entry.chart.birthDate !== chart.birthDate || entry.chart.birthTime !== chart.birthTime) {
            const actionsOpen = entry.row.querySelector<HTMLDetailsElement>('.chart-actions')?.open;
            const deleteDisabled = entry.row.querySelector<HTMLButtonElement>('[data-chart-action="delete"]')?.disabled;
            entry.row.innerHTML = renderChartLibraryRow(chart, false, { preview: true, editDisabled });
            buttonsChanged = true;
            entry.row.querySelector('canvas')!.replaceWith(entry.canvas);
            const actions = entry.row.querySelector<HTMLDetailsElement>('.chart-actions');
            if (actions) actions.open = Boolean(actionsOpen);
            const remove = entry.row.querySelector<HTMLButtonElement>('[data-chart-action="delete"]');
            if (remove) remove.disabled = Boolean(deleteDisabled);
          }
          entry.chart = chart;
        }
        next.set(entry.row, entry);
      }
      const oldOrder = [...rows.keys()], nextOrder = [...next.keys()];
      if (oldOrder.length !== nextOrder.length || oldOrder.some((row, index) => row !== nextOrder[index])) cancelReadiness();
      for (const entry of rows.values()) if (!next.has(entry.row)) {
        pending.delete(entry); observer?.unobserve(entry.row); releaseEntry(entry); entry.row.remove();
      }
      let cursor = list.firstChild;
      for (const entry of next.values()) {
        if (entry.row !== cursor) list.insertBefore(entry.row, cursor);
        cursor = entry.row.nextSibling;
        if (!rows.has(entry.row)) observer?.observe(entry.row);
      }
      rows = next;
      if (buttonsChanged) onRowsChange();
      measure();
      settleReadiness();
    }
  }
  function setVisible(value: boolean) {
    const shown = Boolean(value);
    if (dialog.hidden === !shown) {
      if (shown) update();
      return;
    }
    dialog.hidden = !shown;
    if (shown) update();
    else release();
  }
  function settleReadiness() {
    for (const wait of readiness) {
      if (wait.entries.some(entry => !entry.visible || rows.get(entry.row) !== entry)) { readiness.delete(wait); wait.resolve(null); }
      else if (wait.entries.some(entry => entry.failed)) { readiness.delete(wait); wait.resolve(false); }
      else if (wait.entries.every(entry => entry.painted)) { readiness.delete(wait); wait.resolve(true); }
    }
  }
  // Initial page reveal needs only drawings inside the current viewport. Do
  // not wait for observer delivery or paint the rest of a large collection.
  // True means drawn, false means failed, null means this viewport is obsolete.
  function whenReady() {
    if (dialog.hidden) return Promise.resolve(null);
    const bounds = list.getBoundingClientRect();
    const entries = [...rows.values()].filter(entry => {
      const rect = entry.row.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    });
    for (const entry of entries) visible(entry, true);
    return new Promise<boolean | null>(resolve => { readiness.add({ entries, resolve }); settleReadiness(); });
  }
  function show() {
    if (onOpen) onOpen();
    else if (dialog.hidden) setVisible(true);
  }
  function close() { setVisible(false); }
  button.addEventListener('click', show);
  search?.addEventListener('input', () => {
    const next = normalizeSearch(search.value);
    onChange();
    if (next === query) return;
    query = next;
    list.scrollTop = 0;
    update();
  });
  list.addEventListener('scroll', measure, { passive: true });
  document.defaultView?.addEventListener('resize', () => { cancelReadiness(); measure(); });
  return { setVisible, show, close, update, whenReady, restoreInputFocus,
    get snapshot(): NonNullable<SavedView['charts']> { const focus=inputFocus(); return { query: search?.value ?? '', searchOpen: header?.expanded ?? false, ...(focus ? {focus} : {}) }; } };
}
