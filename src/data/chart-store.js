import { readCharts, writeCharts, deleteChart } from './storage.js';

// Own only the saved collection; the chart session owns navigation.
// A denied storage access still permits a calculated chart to remain in memory.
export function createChartStore({ getStorage = () => globalThis.localStorage, onStorageError = () => {} } = {}) {
  let charts = [], storageAvailable = true;
  try { charts = readCharts(getStorage()); } catch { storageAvailable = false; }

  return {
    get charts() { return charts; },
    get storageAvailable() { return storageAvailable; },
    has(id) { return charts.some(chart => chart.id === id); },
    get(id) { return charts.find(chart => chart.id === id); },
    replace(next) { charts = next; },
    persist(next = charts) {
      try {
        if (!storageAvailable) throw new Error();
        writeCharts(getStorage(), next);
        charts = next;
        return true;
      } catch { onStorageError('Не удалось сохранить карту в браузере.'); return false; }
    },
    flush() {
      try { if (storageAvailable) writeCharts(getStorage(), charts); }
      catch { /* Best effort persistence when the document becomes hidden. */ }
    },
    remove(id) { charts = deleteChart(getStorage(), charts, id); },
  };
}
