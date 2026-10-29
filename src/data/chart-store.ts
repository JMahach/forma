import {immutableSnapshot} from '../domain/immutable-snapshot.ts';
import { validatePublicAccountChart } from '../domain/account-chart.ts';
import type { AccountChart, PublicAccountChart } from '../../shared/chart-record-contract.ts';
import type { SavedChart } from '../../shared/chart-types.ts';
export type ChartStore = ReturnType<typeof createChartStore>;

import { normalizeTemporaryChart } from '../domain/temporary-chart.ts';

// Account-library owns saved records; this store projects only its current
// library and the separate ready temporary/public results of this tab.
export function createChartStore({ initialTemporaryChart = null, initialPublicChart = null }: { initialPublicChart?: unknown; initialTemporaryChart?: unknown } = {}) {
  const readPublic=(value:unknown):PublicAccountChart|null=>{try{return immutableSnapshot(validatePublicAccountChart(value));}catch{return null;}};
  const displayPublic=(value:PublicAccountChart):SavedChart=>({...value,note:'',createdAt:'',updatedAt:''});
  // One public source belongs to this tab. The working projection may separately
  // pin an accepted save source; that transient pin is never persisted here.
  let lastPublicChart=readPublic(initialPublicChart);
  let publicChart: SavedChart | null = lastPublicChart ? displayPublic(lastPublicChart) : null;
  let temporaryChart = normalizeTemporaryChart(initialTemporaryChart);
  if(temporaryChart)temporaryChart=immutableSnapshot(temporaryChart);
  let projection: {sources: readonly (SavedChart | AccountChart)[]; charts: SavedChart[]; storageAvailable: boolean; ready: Set<string>} = {sources: [], charts: [], storageAvailable: false, ready: new Set()};
  const working = () => projection.charts;
  const names = new Intl.Collator('ru', {sensitivity: 'base', numeric: true});
  let navigationSource: readonly SavedChart[] | null = null, navigationCharts: readonly SavedChart[] = [];

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
      temporaryChart = immutableSnapshot(next);
      return temporaryChart;
    },
    clearTemporary(expectedId: string) {
      if (temporaryChart?.id !== expectedId) return false;
      temporaryChart = null;
      return true;
    },
    get storageAvailable() { return projection.storageAvailable; },
    get publicChart() { return lastPublicChart; },
    acceptPublic(chart: PublicAccountChart) {
      lastPublicChart=immutableSnapshot(validatePublicAccountChart(chart));
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
    has(id: string) { if (temporaryChart?.id === id) return true; return working().some(chart => chart.id === id) ? projection.ready.has(id) : publicChart?.id === id; },
    get(id: string) { if (temporaryChart?.id === id) return temporaryChart; return working().find(chart => chart.id === id) ?? (publicChart?.id === id ? publicChart : undefined); },
    // Account-library owns these values. Local persistence must never write them.
    projectLibrary(records: readonly (SavedChart | AccountChart)[], available: boolean, readyIds: readonly string[] = records.map(chart => chart.id)) {
      const previous = projection;
      const unchanged = records.length === previous.sources.length
        && records.every((record, index) => record === previous.sources[index]);
      // Keep only the current display projection; unchanged source records
      // keep their rows and miniatures across storage/status notifications.
      const retained = unchanged ? null : new Map(previous.sources.map((source, index) => [source, previous.charts[index]!]));
      projection = {
        sources: unchanged ? previous.sources : [...records],
        charts: unchanged ? previous.charts : records.map(record => retained?.get(record)
          ?? ('accountId' in record ? {...record, createdAt: '', updatedAt: ''} : record)),
        storageAvailable: available, ready: new Set(readyIds),
      };
    },
  };
}
