import { renderChartLibraryRow } from './library.js';
import { canManageLibraryRecord } from './chart-display.js';
import { createChartPreview } from './chart-preview-canvas.js';

// This workspace page reads the same library; the existing document-level commands own
// selection, editing and deletion. Only nearby, temporary pixels belong here.
export function attachAllCharts({ button, dialog, list, store,
  onOpen = null, document = dialog.ownerDocument,
  preview = createChartPreview, schedule = callback => setTimeout(callback, 0), cancel = clearTimeout,
  createObserver = typeof globalThis.IntersectionObserver === 'function'
    ? (callback, options) => new globalThis.IntersectionObserver(callback, options) : null,
}) {
  const rows = new Map(), pending = new Set(), readiness = new Set();
  let charts = null, job = null;
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
  function releaseEntry(entry) {
    entry.paint = null; entry.painted = false; entry.failed = false;
    entry.release?.(); entry.release = null;
  }
  function visible(entry, value) {
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
    if (charts !== store.charts) {
      release(); charts = store.charts;
      for (const chart of charts.filter(canManageLibraryRecord)) {
        const row = document.createElement('div');
        row.className = 'chart-row has-actions';
        row.innerHTML = renderChartLibraryRow(chart, false, { preview: true });
        const entry = { row, chart, canvas: row.querySelector('canvas'), visible: false, release: null, paint: null, painted: false, failed: false };
        rows.set(row, entry); list.insertBefore(row, null); observer?.observe(row);
      }
      measure();
    }
  }
  function setVisible(value) {
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
    return new Promise(resolve => { readiness.add({ entries, resolve }); settleReadiness(); });
  }
  function show() {
    if (!dialog.hidden) return;
    if (onOpen) onOpen();
    else setVisible(true);
  }
  function close() { setVisible(false); }
  button.addEventListener('click', show);
  list.addEventListener('scroll', measure, { passive: true });
  document.defaultView?.addEventListener('resize', () => { cancelReadiness(); measure(); });
  return { setVisible, show, close, update, whenReady };
}
