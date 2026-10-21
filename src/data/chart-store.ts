import type { SavedChart } from '../../shared/chart-types.ts';
import type { StorageError, ChartStorage } from './storage.ts';
export type ChartStore = ReturnType<typeof createChartStore>;

import { readCharts, writeChartChanges, changedChartRecords, deleteChart, STORAGE_KEY } from './storage.ts';

// Own the working library, including drafts kept after a failed save.
// The private saved snapshot tracks confirmed storage; the chart session owns navigation.
// A denied storage access still permits a calculated chart to remain in memory.
export function createChartStore({ getStorage = () => globalThis.localStorage, onStorageError = () => {} }: { getStorage?: () => ChartStorage; onStorageError?: (message: string) => void } = {}) {
  let charts: SavedChart[] = [], storageAvailable = true;
  let saveError: { code: string; message: string; canKeepInMemory: boolean } | null = null;
  const reported = new Set<string>();
  const reportInvalid = (key: string) => {
    if (reported.has(key)) return;
    reported.add(key);
    onStorageError('Не удалось прочитать часть карт. Повреждённые исходные данные сохранены в браузере.');
  };
  const read = (storage: ChartStorage) => readCharts(storage, STORAGE_KEY, reportInvalid);
  try { charts = read(getStorage()); } catch { storageAvailable = false; }
  // Keep an owned JSON snapshot, including opaque metadata that the UI does
  // not interpret. Projecting through validation here would hide its edits.
  let saved: SavedChart[] = JSON.parse(JSON.stringify(charts));
  function persist(next: SavedChart[]) {
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
    has(id: string) { return charts.some(chart => chart.id === id); },
    get(id: string) { return charts.find(chart => chart.id === id); },
    replace(next: SavedChart[]) { charts = next; },
    persist(next = charts) {
      try {
        persist(next);
        saveError = null;
        return true;
      } catch (caught) {
        const error = caught as StorageError;
        const code = ['deleted', 'corrupt', 'invalid', 'limit', 'ambiguous'].includes(error?.code!) ? error.code : 'storage';
        saveError = { code: code!, message: code === 'storage' ? 'Не удалось сохранить карту в браузере.' : error.message, canKeepInMemory: code === 'storage' };
        onStorageError(saveError.message);
        return false;
      }
    },
    remove(id: string) {
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
