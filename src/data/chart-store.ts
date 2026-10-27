import { validatePublicAccountChart } from '../domain/account-chart.ts';
import type { AccountChart, PublicAccountChart } from '../../shared/chart-record-contract.ts';
import type { SavedChart } from '../../shared/chart-types.ts';
import type { StorageError, ChartStorage } from './storage.ts';
export type ChartStore = ReturnType<typeof createChartStore>;

import { readCharts, writeChartChanges, changedChartRecords, deleteChart, STORAGE_KEY, normalizeTemporaryChart } from './storage.ts';

// Own the working library and the separate ready temporary result of this tab.
// The private saved snapshot tracks confirmed storage; the chart session owns navigation.
// A denied storage access still permits a calculated chart to remain in memory.
export function createChartStore({ getStorage = () => globalThis.localStorage, onStorageError = () => {}, initialTemporaryChart = null, initialPublicChart = null, calculationVersion = '' }: { initialPublicChart?: unknown; calculationVersion?: string; initialTemporaryChart?: unknown; getStorage?: () => ChartStorage; onStorageError?: (message: string) => void } = {}) {
  let charts: SavedChart[] = [], storageAvailable = true;
  const readPublic=(value:unknown):PublicAccountChart|null=>{try{return validatePublicAccountChart(value);}catch{return null;}};
  const displayPublic=(value:PublicAccountChart):SavedChart=>({...value,note:'',createdAt:'',updatedAt:''});
  // One public source belongs to this tab. The working projection may separately
  // pin an accepted save source; that transient pin is never persisted here.
  let lastPublicChart=readPublic(initialPublicChart);
  let publicChart: SavedChart | null = lastPublicChart?.calculationVersion===calculationVersion ? displayPublic(lastPublicChart) : null;
  let temporaryChart = normalizeTemporaryChart(initialTemporaryChart);
  let projection: {sources: readonly (SavedChart | AccountChart)[]; charts: SavedChart[]; storageAvailable: boolean; ready: Set<string>} | null = null;
  const working = () => projection?.charts ?? charts;
  const names = new Intl.Collator('ru', {sensitivity: 'base', numeric: true});
  let navigationSource: readonly SavedChart[] | null = null, navigationCharts: readonly SavedChart[] = [];

  const readOnly = () => Object.assign(new Error('Не удалось сохранить карту'), {code: 'auth_required'});
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
    get charts() { return working(); },
    // The tab's unsaved result remains addressable through /chart, never a library row.
    get displayCharts() {
      const source = working();
      if (navigationSource !== source) {
        navigationSource = source;
        navigationCharts = [...source].sort((a, b) => names.compare(a.name, b.name)
          || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      }
      return navigationCharts;
    },
    get temporaryChart() { return temporaryChart; },
    setTemporary(chart: SavedChart) {
      const next = normalizeTemporaryChart(chart);
      if (!next) throw Object.assign(new Error('Не удалось сохранить карту'), {code:'invalid'});
      temporaryChart = next;
      return temporaryChart;
    },
    clearTemporary(expectedId: string) {
      if (temporaryChart?.id !== expectedId) return false;
      temporaryChart = null;
      return true;
    },
    get storageAvailable() { return projection?.storageAvailable ?? storageAvailable; },
    get saveError() { return saveError; },
    get publicChart() { return lastPublicChart; },
    acceptPublic(chart: PublicAccountChart) {
      lastPublicChart=validatePublicAccountChart(chart);
      publicChart=displayPublic(lastPublicChart);
      return publicChart;
    },
    clearPublic(expectedId:string) {
      if(lastPublicChart?.id!==expectedId)return false;
      lastPublicChart=null;
      if(publicChart?.id===expectedId)publicChart=null;
      return true;
    },
    showPublic(chart: SavedChart | null) { publicChart = chart; },
    has(id: string) { if (temporaryChart?.id === id) return true; return working().some(chart => chart.id === id) ? !projection || projection.ready.has(id) : publicChart?.id === id; },
    get(id: string) { if (temporaryChart?.id === id) return temporaryChart; return working().find(chart => chart.id === id) ?? (publicChart?.id === id ? publicChart : undefined); },
    // Account-library owns these values. Local persistence must never write them.
    projectLibrary(records: readonly (SavedChart | AccountChart)[], available: boolean, readyIds: readonly string[] = records.map(chart => chart.id)) {
      const previous = projection;
      const unchanged = previous && records.length === previous.sources.length
        && records.every((record, index) => record === previous.sources[index]);
      // Keep only the current display projection; unchanged source records
      // keep their rows and miniatures across storage/status notifications.
      const retained = unchanged ? null : new Map(previous?.sources.map((source, index) => [source, previous.charts[index]!]));
      projection = {
        sources: unchanged ? previous.sources : [...records],
        charts: unchanged ? previous.charts : records.map(record => retained?.get(record)
          ?? ('accountId' in record ? {...record, createdAt: '', updatedAt: ''} : record)),
        storageAvailable: available, ready: new Set(readyIds),
      };
    },
    replace(next: SavedChart[]) { if (projection) throw readOnly(); charts = next; },
    persist(next = charts) {
      if (projection) {
        saveError = {code: 'auth_required', message: readOnly().message, canKeepInMemory: false};
        return false;
      }
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
      if (projection) throw readOnly();
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

// Saving from either the form or the stand uses the same accepted storage outcome.
// Navigation and the warning about an in-memory result belong to the caller.
export function saveChartRecord(store: Pick<ChartStore, 'charts' | 'persist' | 'replace' | 'saveError'>,
  chart: SavedChart, replacingId: string | null = null) {
  const next = replacingId ? store.charts.map(item => item.id === replacingId ? chart : item) : [...store.charts, chart];
  if (next.length > 500) throw new Error('В библиотеке уже 500 карт.');
  const persisted = store.persist(next);
  if (!persisted && store.saveError?.canKeepInMemory === false) throw new Error(store.saveError.message);
  if (!persisted) store.replace(next);
  return persisted;
}
