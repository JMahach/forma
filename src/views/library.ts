import type { SavedChart } from '../../shared/chart-types.ts';
import type { ChartSession } from '../state/chart-session.ts';
import type { PanelState } from '../state/panels.ts';
import type { WorkspaceScreen } from '../state/workspace.ts';
interface LibraryRow { key: string; chart: SavedChart | null; row: HTMLElement; button?: HTMLButtonElement | null; actions?: HTMLDetailsElement | null }
export type ChartLibraryView = ReturnType<typeof createChartLibraryView>;
export type ChartLibrary = ReturnType<typeof attachChartLibrary>;
export interface LibraryDeletion {
  handles(id: string): boolean;
  checking(id: string): boolean;
  submit(id: string, signal: AbortSignal): Promise<{kind: 'deleted' | 'unknown' | 'inactive' | 'rejected'; error?: unknown}>;
}
interface LibraryOptions {
  serverDeletion?: LibraryDeletion;
  initialSelection?: readonly string[];
  canEdit?: () => boolean;
  getConnectionMode: () => Parameters<typeof actionAvailability>[0]['connection'];
  subscribeConnection: (listener: () => void) => () => void;
  panels?: PanelState; document: Document; view?: ChartLibraryView | null; getCharts: () => readonly SavedChart[]; removeChart: (id: string) => void; session: ChartSession;
  onSelect: (id: string, options?: { keepMenuOpen: boolean }) => void; onEdit: (id: string) => void; onNew: () => void;
  onUpdate?: () => void; beforeOpen?: () => void; getSelectedId?: () => string | null;
}

import { createLibrarySelection } from '../state/library-selection.ts';
import { createPanelState } from '../state/panels.ts';
import { formatDateInput } from './date-input.ts';
import { canManageLibraryRecord } from './chart-display.ts';
import { escapeHtml as esc } from '../ui/html.ts';
import { createFeedback } from '../ui/feedback.ts';
import { UI_MESSAGES } from '../ui/messages.ts';
import { actionAvailability } from '../ui/action-state.ts';

const sourceNames = { calculated: 'Расчёт по данным рождения', manual: 'Ручные активации', transit: 'Транзит' };

export function renderChartLibraryRow(chart: SavedChart, selected: boolean, { preview = false, editDisabled = false } = {}) {
  const caption = chart.birthDate ? [formatDateInput(chart.birthDate), chart.birthTime].filter(Boolean).join(' · ') : sourceNames[chart.source] || 'Ручные активации';
  return `<button class="chart-card" data-chart-id="${esc(chart.id)}" data-active="${selected}" aria-pressed="${selected}">${preview ? '<canvas class="chart-preview" width="0" height="0" aria-hidden="true"></canvas>' : ''}<span class="chart-copy"><span class="chart-name">${esc(chart.name)}</span><span class="chart-caption">${esc(caption)}</span></span></button><details class="chart-actions"><summary title="Действия с картой" aria-label="Действия с картой «${esc(chart.name)}»"><span aria-hidden="true">⋯</span></summary><div class="chart-action-menu"><button data-chart-action="edit" ${editDisabled ? 'disabled' : ''} data-action-chart-id="${esc(chart.id)}">Редактировать</button><button class="danger-text" data-chart-action="delete" data-action-chart-id="${esc(chart.id)}">Удалить</button></div></details>`;
}

// Saved data never lives here. Compact navigation rows keep their identity
// across selection and minute updates; a closed list defers reconciliation.
export function createChartLibraryView({ chartList, libraryCount, nowButton, document = chartList.ownerDocument, canEdit = () => true }: { chartList: HTMLElement; libraryCount: HTMLElement; nowButton: HTMLElement; document?: Document; canEdit?: () => boolean }) {
  const rows = new Map<string, LibraryRow>();
  let charts: readonly SavedChart[] = [], personal: SavedChart[] = [], renderedCharts: readonly SavedChart[] | null = null, selectedId: string | null | undefined, opened = false;
  let selectedIds = new Set<string>();
  function markEntry(entry: LibraryRow, active: boolean, current: boolean) {
    entry.row.dataset.current = String(current);
    entry.actions!.hidden = !current;
    if (!current) entry.actions!.open = false;
    entry.button!.setAttribute('aria-current', String(current));
    entry.row.dataset.active = String(active);
    entry.button!.dataset.active = String(active);
    entry.button!.setAttribute('aria-pressed', String(active));
  }
  function markSelection() {
    let currentMarked = false;
    for (const entry of rows.values()) {
      const active = selectedIds.has(entry.chart!.id);
      const current: boolean = entry.chart!.id === selectedId && !currentMarked;
      markEntry(entry, active, current);
      currentMarked ||= current;
    }
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
        entry.row.innerHTML = renderChartLibraryRow(chart, selectedIds.has(chart.id), { editDisabled: !canEdit() });
        entry.button = entry.row.querySelector('.chart-card');
        entry.actions = entry.row.querySelector('.chart-actions');
      }
      const position: ChildNode | null = previous ? previous.nextSibling : chartList.firstChild;
      if (position !== entry.row) chartList.insertBefore(entry.row, position);
      previous = entry.row;
    }
    renderedCharts = charts;
    markSelection();
  }
  return {
    update(nextCharts: readonly SavedChart[], nextSelectedId: string | null, selection: readonly string[] = nextSelectedId ? [nextSelectedId] : []) {
      if (charts !== nextCharts) {
        charts = nextCharts; personal = charts.filter(canManageLibraryRecord);
        libraryCount.textContent = String(personal.length);
      }
      if (selectedId !== nextSelectedId || selectedIds.size !== selection.length || selection.some(id => !selectedIds.has(id))) {
        selectedId = nextSelectedId; selectedIds = new Set(selection); markSelection();
        nowButton.setAttribute('aria-pressed', String(selectedId === 'current-transit'));
      }
      reconcile();
    },
    setScreen(screen: WorkspaceScreen) {
      for (const [id, section] of [['openKnowledge', 'knowledge'], ['openAllCharts', 'charts'], ['openAccount', 'account']]) {
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

export function attachChartLibrary({ serverDeletion, canEdit = () => true, initialSelection, panels = createPanelState(), document, view = null, getCharts, removeChart, getConnectionMode, subscribeConnection, session, onSelect, onEdit, onNew, onUpdate = () => {}, beforeOpen = () => {}, getSelectedId = () => session.selectedId }: LibraryOptions) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  let deletingId: string | null = null, appliedOpen: boolean | null = null;
  let deleteController: AbortController | null = null, deleteRevision = 0, deleteBusy = false;
  const deleteLabel = $('confirmDeleteChart').textContent || 'Удалить';
  let deleteFeedback: ReturnType<typeof createFeedback> | null = null, deletionError: unknown;
  function showDeletionWaiting() {
    const code = (deletionError as {code?: unknown} | undefined)?.code;
    const lost = getConnectionMode() === 'offline' || code === 'offline' || code === 'connection_failed';
    deleteFeedback ??= createFeedback($('deleteChartError'), {kind:'action'});
    deleteFeedback.show({message:lost ? UI_MESSAGES.offline : UI_MESSAGES.chartDeleting, busy:!lost});
  }
  view ??= createChartLibraryView({ chartList: $('chartList'), libraryCount: $('libraryCount'), nowButton: $('nowButton'), document,
    canEdit: () => !actionAvailability({connection:getConnectionMode(),requiresConnection:true}).disabled });
  let appliedDisabled: boolean | null = null;
  function updateAvailability(force = false) {
    const disabled = !canEdit() || actionAvailability({connection:getConnectionMode(),requiresConnection:true}).disabled;
    if (force || appliedDisabled !== disabled) {
      appliedDisabled = disabled;
      $<HTMLButtonElement>('newChartButton').disabled = disabled;
      document.querySelectorAll<HTMLButtonElement>('[data-chart-action="edit"]').forEach(button => {button.disabled = disabled;});
      if (serverDeletion) document.querySelectorAll<HTMLButtonElement>('[data-chart-action="delete"]').forEach(button => {
        if (serverDeletion.handles(button.dataset.actionChartId!)) button.disabled = disabled;
      });
    }
    if (serverDeletion) {
      if (deletingId && serverDeletion.handles(deletingId)) {
        if (!canEdit()) { closeDeleteChart(); return; }
        const checking = serverDeletion.checking(deletingId);
        $<HTMLButtonElement>('confirmDeleteChart').disabled = disabled || deleteBusy || checking;
        if (deleteBusy || checking) showDeletionWaiting();
      }
    }
  }
  const selection = createLibrarySelection(initialSelection);
  const chartList = $('chartList');
  let selectionCharts: readonly SavedChart[] | null = null, selectionCurrent: string | undefined;
  function render() {
    const charts = getCharts(), changed = charts !== selectionCharts;
    if (changed && deletingId && !charts.some(chart => chart.id === deletingId)) closeDeleteChart();
    if (changed || selectionCurrent !== session.selectedId) {
      selectionCharts = charts; selectionCurrent = session.selectedId;
      selection.sync(charts.filter(canManageLibraryRecord).map(chart => chart.id), session.selectedId);
    }
    view!.update(charts, getSelectedId(), selection.snapshot); updateAvailability(changed);
  }
  function revealRow(element: HTMLElement) {
    const row = element.closest<HTMLElement>('.chart-row');
    if (!row || !chartList.contains(row) || !chartList.clientHeight) return;
    const viewport = chartList.getBoundingClientRect();
    if (!viewport.height) return;
    // Convert viewport pixels back to this scroller's units (the shell can
    // scale). The 7px gutter also contains the existing keyboard focus ring.
    const scale = viewport.height / chartList.clientHeight, gutter = 7 * scale;
    const top = viewport.top + gutter, bottom = viewport.bottom - gutter;
    let target = row.getBoundingClientRect();
    if (target.height > bottom - top) {
      // In a very short menu the whole expanded row cannot fit; keep its
      // actions reachable instead of repeatedly chasing opposite edges.
      target = row.querySelector<HTMLElement>('.chart-actions[open] .chart-action-menu')?.getBoundingClientRect() ?? target;
    }
    const delta = target.top < top || target.height > bottom - top ? target.top - top
      : target.bottom > bottom ? target.bottom - bottom : 0;
    if (delta) chartList.scrollTop += delta / scale;
  }
  function activate(id: string | null, keepMenuOpen: boolean) {
    if (id && (!keepMenuOpen || id !== session.selectedId || getSelectedId() === null)) onSelect(id, { keepMenuOpen });
    else onUpdate();
    render();
  }

  function syncOpen() {
    const opened = panels.left;
    if (appliedOpen === opened) return;
    appliedOpen = opened;
    $('library').inert = !opened;
    $('library').classList.toggle('open', opened);
    $('library').setAttribute('aria-hidden', String(!opened));
    $('libraryBackdrop').hidden = !opened;
    $('openLibrary').setAttribute('aria-expanded', String(opened));
    if (opened) { render(); view!.show(); updateAvailability(true); } else view!.hide();
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
    // Wait for the completed click: collapsing details on pointerdown moves
    // neighbouring rows before pointerup and can swallow their first click.
    document.querySelectorAll<HTMLDetailsElement>('.chart-actions[open]').forEach(item => {
      if (!item.contains(e.target as Node | null)) item.open = false;
    });
    const action = (e.target as Element).closest<HTMLElement>('[data-chart-action]');
    if (action) {
      const c = getCharts().find(item => item.id === action.dataset.actionChartId);
      if (!canManageLibraryRecord(c)) return;
      if ((action.dataset.chartAction === 'edit' || serverDeletion?.handles(c!.id))
        && (!canEdit() || actionAvailability({connection:getConnectionMode(),requiresConnection:true}).disabled)) return;
      action.closest('details')!.open = false;
      if (action.dataset.chartAction === 'edit') onEdit(c!.id);
      else openDeleteChart(c!);
      return;
    }
    const button = (e.target as Element).closest<HTMLElement>('[data-chart-id]');
    if (!button) return;
    const id = button.dataset.chartId!;
    if (chartList.contains(button)) {
      activate(selection.choose(id, e.shiftKey, session.selectedId), e.shiftKey);
      if (panels.left) button.focus({ preventScroll: true });
      revealRow(button);
    } else {
      // The full catalogue still selects one card, including with Shift held.
      selection.choose(id, false, session.selectedId);
      onSelect(id);
    }
  });
  chartList.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || !panels.left
      || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || document.querySelector('dialog[open]')) return;
    const button = (e.target as Element).closest<HTMLElement>('.chart-card[data-chart-id]');
    if (!button || !chartList.contains(button)) return;
    const id = selection.adjacent(session.selectedId, e.key === 'ArrowUp' ? -1 : 1);
    if (!id) return;
    e.preventDefault(); e.stopPropagation();
    activate(id, true);
    if (!panels.left) return;
    const next = [...chartList.querySelectorAll<HTMLElement>('.chart-card')].find(item => item.dataset.chartId === id);
    next?.focus({ preventScroll: true });
    if (next) revealRow(next);
  });
  document.addEventListener('toggle', e => {
    if (!(e.target as Element).matches?.('.chart-actions[open]')) return;
    document.querySelectorAll<HTMLDetailsElement>('.chart-actions[open]').forEach(item => { if (item !== e.target) item.open = false; });
    revealRow(e.target as HTMLElement);
  }, true);
  $('newChartButton').addEventListener('click', () => {
    if (canEdit() && !actionAvailability({connection:getConnectionMode(),requiresConnection:true}).disabled) onNew();
  });
  function closeDeleteChart() {
    deleteRevision++; deleteController?.abort(); deleteController = null;
    deleteBusy = false; deletingId = null; deletionError = undefined;
    $<HTMLDialogElement>('deleteChartDialog').close();
    if (deleteFeedback) deleteFeedback.clear();
    $('deleteChartName').textContent = '';
    $('confirmDeleteChart').textContent = deleteLabel;
    $<HTMLButtonElement>('confirmDeleteChart').disabled = false;
  }
  function openDeleteChart(c: SavedChart) {
    if (!canManageLibraryRecord(c)) return;
    deleteRevision++; deleteController?.abort(); deleteController = null; deleteBusy = false;
    deletingId = c.id; deletionError = undefined;
    $('deleteChartName').textContent = `«${c.name}»`;
    if (deleteFeedback) deleteFeedback.clear(); else $('deleteChartError').textContent = '';
    $('confirmDeleteChart').textContent = deleteLabel;
    $<HTMLDialogElement>('deleteChartDialog').showModal(); updateAvailability();
    $('cancelDeleteChart').focus();
  }
  $('cancelDeleteChart').addEventListener('click', closeDeleteChart);
  $('deleteChartDialog').addEventListener('cancel', closeDeleteChart);
  $('confirmDeleteChart').addEventListener('click', async () => {
    if (!deletingId || deleteBusy) return;
    const id = deletingId, revision = deleteRevision;
    const server = serverDeletion?.handles(id) ? serverDeletion : null;
    if (server && (server.checking(id) || !canEdit() || actionAvailability({connection:getConnectionMode(),requiresConnection:true}).disabled)) return;
    const ownsDialog = () => deletingId === id && deleteRevision === revision;
    const finish = () => {
      if (!ownsDialog()) return;
      closeDeleteChart();
      if (session.selectedId === id) onSelect('current-transit');
      else onUpdate();
    };
    if (!server) {
      try { removeChart(id); finish(); }
      catch {
        deleteFeedback ??= createFeedback($('deleteChartError'), {kind:'action'});
        deleteFeedback.show({message:UI_MESSAGES.chartDeleteFailed,tone:'error'});
      }
      return;
    }
    const controller = new AbortController(); deleteController = controller; deleteBusy = true;
    deleteFeedback ??= createFeedback($('deleteChartError'), {kind:'action'});
    deletionError = undefined; showDeletionWaiting();
    updateAvailability();
    try {
      const result = await server.submit(id, controller.signal);
      if (!ownsDialog() || controller.signal.aborted) return;
      if (result.kind === 'deleted') finish();
      else if (result.kind === 'inactive') closeDeleteChart();
      else if (result.kind === 'unknown') {
        deletionError = result.error; showDeletionWaiting();
      } else deleteFeedback.show({message:UI_MESSAGES.accountActionFailed,tone:'error'});
    } catch (error) {
      if (ownsDialog() && !controller.signal.aborted && (error as Error)?.name !== 'AbortError') {
        deleteFeedback.show({message:UI_MESSAGES.accountActionFailed,tone:'error'});
      }
    } finally {
      if (ownsDialog()) { deleteController = null; deleteBusy = false; updateAvailability(); }
    }
  });

  $('openLibrary').addEventListener('click', toggle);
  $('libraryBackdrop').addEventListener('click', closeLibrary);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
    const menu = document.querySelector<HTMLDetailsElement>('.chart-actions[open]');
    if (menu) { menu.open = false; menu.querySelector('summary')!.focus(); e.preventDefault(); return; }
  });

  subscribeConnection(() => {deletionError = undefined; updateAvailability();});
  panels.subscribe(syncOpen);
  syncOpen();
  return { open: openLibrary, close: closeLibrary, closeDelete: closeDeleteChart, toggle, render, syncOpen, refreshAvailability: () => updateAvailability(true), get selection() { return selection.snapshot; }, get opened() { return panels.left; } };
}
