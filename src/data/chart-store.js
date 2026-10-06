import { readCharts, writeChartChanges, changedChartRecords, deleteChart, STORAGE_KEY } from './storage.js';

// Own only the saved collection; the chart session owns navigation.
// A denied storage access still permits a calculated chart to remain in memory.
export function createChartStore({ getStorage = () => globalThis.localStorage, onStorageError = () => {} } = {}) {
  let charts = [], storageAvailable = true, saveError = null;
  const reported = new Set();
  const reportInvalid = key => {
    if (reported.has(key)) return;
    reported.add(key);
    onStorageError('Не удалось прочитать часть карт. Повреждённые исходные данные сохранены в браузере.');
  };
  const read = storage => readCharts(storage, STORAGE_KEY, reportInvalid);
  try { charts = read(getStorage()); } catch { storageAvailable = false; }
  // Keep an owned JSON snapshot, including opaque metadata that the UI does
  // not interpret. Projecting through validation here would hide its edits.
  let saved = JSON.parse(JSON.stringify(charts));
  function persist(next) {
    if (!storageAvailable) throw new Error('Не удалось сохранить карту в браузере.');
    const storage = getStorage();
    writeChartChanges(storage, next, saved);
    const candidates = new Map(next.map(chart => [chart.id, chart]));
    charts = read(storage).map(chart => {
      const candidate = candidates.get(chart.id);
      return candidate && JSON.stringify(candidate) === JSON.stringify(chart) ? candidate : chart;
    });
    saved = JSON.parse(JSON.stringify(charts));
  }

  return {
    get charts() { return charts; },
    get storageAvailable() { return storageAvailable; },
    get saveError() { return saveError; },
    has(id) { return charts.some(chart => chart.id === id); },
    get(id) { return charts.find(chart => chart.id === id); },
    replace(next) { charts = next; },
    persist(next = charts) {
      try {
        persist(next);
        saveError = null;
        return true;
      } catch (error) {
        const code = ['deleted', 'corrupt', 'invalid', 'limit', 'ambiguous'].includes(error?.code) ? error.code : 'storage';
        saveError = { code, message: code === 'storage' ? 'Не удалось сохранить карту в браузере.' : error.message, canKeepInMemory: code === 'storage' };
        onStorageError(saveError.message);
        return false;
      }
    },
    remove(id) {
      const before = new Set(saved.map(chart => chart.id));
      const pending = new Map(changedChartRecords(charts.filter(chart => chart.id !== id), saved).map(chart => [chart.id, chart]));
      const storage = getStorage();
      // A stale draft cannot choose one of several newly observed records.
      if (pending.size) changedChartRecords([...pending.values()], read(storage));
      const latest = deleteChart(storage, charts, id, onStorageError, reportInvalid);
      saved = JSON.parse(JSON.stringify(latest));
      // Only an older v1 writer can introduce duplicates after that check.
      // Keep its actual records visible rather than applying one draft twice.
      const ambiguous = [...pending.keys()].filter(key => latest.filter(chart => chart.id === key).length > 1);
      for (const key of ambiguous) pending.delete(key);
      if (ambiguous.length) onStorageError('Библиотека изменилась во время удаления. Несохранённые изменения карт с одинаковым идентификатором не применены.');
      charts = latest.map(chart => pending.get(chart.id) || chart);
      // A failed save may have been explicitly kept in memory by the form.
      // Deleting another card neither discards nor silently saves that draft.
      const present = new Set(charts.map(chart => chart.id));
      for (const [key, chart] of pending) if (!before.has(key) && !present.has(key)) charts.push(chart);
    },
  };
}
