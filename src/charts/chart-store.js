import { readCharts, writeCharts, deleteChart } from './storage.js';

const emptyMoment = { id: 'current-transit', name: 'Транзит', source: 'transit', personality: [], design: [], utc: '' };

// Own the saved collection and current chart; UI controllers never own copies.
// A denied storage access still permits a calculated chart to remain in memory.
export function createChartStore({ getStorage = () => globalThis.localStorage, onStorageError = () => {} } = {}) {
  let charts = [], storageAvailable = true, selectedId = 'current-transit';
  try { charts = readCharts(getStorage()); } catch { storageAvailable = false; }

  return {
    get charts() { return charts; },
    get selectedId() { return selectedId; },
    get current() { return charts.find(chart => chart.id === selectedId) || emptyMoment; },
    get storageAvailable() { return storageAvailable; },
    has(id) { return charts.some(chart => chart.id === id); },
    select(id) { selectedId = id; },
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
