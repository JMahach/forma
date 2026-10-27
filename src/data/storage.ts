import { MAX_CALCULATION_RECEIPT_LENGTH } from '../../shared/chart-record-contract.ts';
import { validateChartSide } from '../../shared/chart-activations.ts';
import { normalizeChartName } from '../domain/chart-record.ts';
export { normalizeChartName, createChartId } from '../domain/chart-record.ts';
import type { ChartRecord, SavedChart, ChartActivations } from '../../shared/chart-types.ts';
export type ChartStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
export interface StorageError extends Error { code?: string }

export const STORAGE_KEY = 'liniya.charts.v1';
export const TRASH_KEY = 'liniya.trash.v1';
export const CHART_RECORD_PREFIX = 'liniya.charts.v2:';
export const CHART_DELETED_PREFIX = 'liniya.deleted.v2:';

export function parseGates(value: unknown) {
  if (!String(value).trim()) return [];
  const tokens = String(value).trim().split(/[\s,;]+/);
  if (tokens.some(token => !/^\d{1,2}$/.test(token) || Number(token) < 1 || Number(token) > 64)) {
    throw new Error('Укажите целые номера ворот от 1 до 64, разделяя их запятыми.');
  }
  return [...new Set(tokens.map(Number))].sort((a, b) => a - b);
}

// Validate a library record, including supported legacy records. This is not
// the contract for every live moment or return calculation shown by the studio.
export function validateLibraryChart(input: unknown): ChartRecord {
  const raw = input as ChartRecord;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('В файле нет карты.');
  const name = normalizeChartName(raw.name);
  if (typeof raw.name !== 'string' || !name || raw.name.length > 80 || name.length > 80) throw new Error('У карты должно быть имя длиной до 80 символов.');
  for (const key of ['personality', 'design'] as const) {
    if (!Array.isArray(raw[key]) || raw[key].length > 64 || raw[key].some(n => !Number.isInteger(n) || n < 1 || n > 64)) throw new Error('Некорректный список активаций: нужны номера от 1 до 64.');
  }
  const cleanText = (key: keyof ChartRecord, max: number) => typeof raw[key] === 'string' ? raw[key].slice(0, max) : '';
  const source = ['calculated', 'transit'].includes(raw.source) ? raw.source : 'manual';
  const result: ChartRecord = {
    id: typeof raw.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(raw.id) && raw.id !== 'demo' ? raw.id : null,
    name,
    personality: [...new Set(raw.personality)].sort((a, b) => a - b),
    design: [...new Set(raw.design)].sort((a, b) => a - b),
    birthDate: cleanText('birthDate', 10), birthTime: cleanText('birthTime', 8), birthPlace: cleanText('birthPlace', 120), note: cleanText('note', 2000),
    createdAt: cleanText('createdAt', 40), updatedAt: cleanText('updatedAt', 40),
    source
  };
  if (source !== 'manual') {
    if (!raw.activations || typeof raw.activations !== 'object') throw new Error('Нет подробностей расчёта карты.');
    result.activations = {} as ChartActivations;
    for (const key of ['personality', 'design'] as const) {
      const list = raw.activations[key], length = key === 'design' && source === 'transit' ? 0 : 13;
      const problem = validateChartSide(result[key], list, length);
      if (problem === 'activations') throw new Error('Некорректные подробности активаций.');
      if (problem === 'gates') throw new Error('Список ворот не совпадает с подробностями расчёта.');
      result.activations[key] = list.map(({ planet, longitude, gate, line }) => ({ planet, longitude, gate, line }));
    }
    for (const key of ['timezone', 'utc', 'utcOffset', 'designUtc', 'engine', 'ephemeris', 'timezoneDatabase', 'nodeModel', 'zodiac', 'verification'] as const) result[key] = cleanText(key, key === 'verification' ? 500 : 160);
    if (!result.utc || !Number.isFinite(Date.parse(result.utc))) throw new Error('В расчёте нет корректного момента UTC.');
    result.designUtc = source === 'transit' ? null : result.designUtc;
    result.fold = raw.fold === 1 ? 1 : 0;
    result.designArcResidualDegrees = Number.isFinite(raw.designArcResidualDegrees) ? raw.designArcResidualDegrees : null;
    result.cityId = raw.cityId == null ? null : String(raw.cityId).slice(0, 40);
    result.city = null;
    if (raw.city && typeof raw.city === 'object' && !Array.isArray(raw.city)) {
      result.city = {};
      for (const key of ['id', 'name', 'country', 'region', 'timezone'] as const) if (raw.city[key] != null) result.city[key] = String(raw.city[key]).slice(0, 160);
      for (const key of ['latitude', 'longitude'] as const) if (Number.isFinite(raw.city[key])) result.city[key] = raw.city[key];
    }
  }
  return result;
}

// One ready result belongs to the tab, independently of the persistent library.
// Reuse the record validator, but never restore account ownership from this slot.
export function normalizeTemporaryChart(input: unknown): SavedChart | null {
  try {
    const raw = input as SavedChart;
    if (!raw || raw.source !== 'calculated' && raw.source !== 'transit') return null;
    const chart = validateLibraryChart(raw);
    if (!chart.id || chart.id === 'current-transit') return null;
    if (typeof raw.calculationReceipt === 'string' && raw.calculationReceipt.length <= MAX_CALCULATION_RECEIPT_LENGTH)
      chart.calculationReceipt = raw.calculationReceipt;
    return chart as SavedChart;
  } catch { return null; }
}

function legacyCharts(storage: ChartStorage, key: string, onInvalid: (key: string) => void): SavedChart[] {
  const value = storage.getItem(key);
  if (!value) return [];
  let data;
  try {
    data = JSON.parse(value);
    if (!Array.isArray(data) || data.length > 500) throw new Error();
  } catch { onInvalid(key); return []; }
  return data.flatMap((raw, index) => {
    try {
      const chart: ChartRecord = { ...raw, ...validateLibraryChart(raw) };
      if (!chart.id) throw new Error();
      return [chart as SavedChart];
    } catch { onInvalid(`${key}:${index}`); return []; }
  });
}

// The v1 array is a read-only fallback during ordinary saves. Each v2 key owns
// one chart; a separate tombstone wins even over an interleaved stale save.
// Never repair or rewrite corrupt data while reading another healthy record.
export function readCharts(storage: ChartStorage, key = STORAGE_KEY, onInvalid: (key: string) => void = () => {}): SavedChart[] {
  let charts = legacyCharts(storage, key, onInvalid);
  if (key !== STORAGE_KEY) return charts;
  const records = new Map<string, SavedChart>(), deleted = new Set<string>();
  for (let index = 0; index < storage.length; index++) {
    const recordKey = storage.key(index);
    if (recordKey?.startsWith(CHART_DELETED_PREFIX)) {
      const id = recordKey.slice(CHART_DELETED_PREFIX.length);
      if (storage.getItem(recordKey) !== '1') onInvalid(recordKey);
      deleted.add(id);
    } else if (recordKey?.startsWith(CHART_RECORD_PREFIX)) {
      const id = recordKey.slice(CHART_RECORD_PREFIX.length), value = storage.getItem(recordKey);
      if (value === null) continue;
      try {
        const record = JSON.parse(value), chart = { ...record.chart, ...validateLibraryChart(record.chart) };
        if (record.version !== 2 || chart.id !== id) throw new Error();
        records.set(id, chart);
      } catch { onInvalid(recordKey); deleted.add(id); }
    }
  }
  const seen = new Set(charts.map(chart => chart.id));
  charts = charts.filter(chart => !deleted.has(chart.id)).map(chart => records.get(chart.id) || chart);
  for (const [id, chart] of records) if (!seen.has(id) && !deleted.has(id)) charts.push(chart);
  return charts;
}

// Compare with the calling store's saved snapshot, never with another tab's
// current value. Unchanged local cards do not participate in this save at all.
function saveFailure(code: string, message: string) { return Object.assign(new Error(message), { code }); }
const ambiguousMessage = 'В библиотеке есть карты с одинаковым идентификатором. Не удалось однозначно сохранить изменения.';

function chartsById(charts: readonly SavedChart[]) {
  const groups = new Map<string, SavedChart[]>();
  for (const chart of charts) {
    if (!groups.has(chart.id)) groups.set(chart.id, []);
    groups.get(chart.id)!.push(chart);
  }
  return groups;
}

// Existing repeated IDs are separate saved records. Compare whole groups,
// including multiplicity, so an unrelated action never chooses a winner.
export function changedChartRecords(charts: readonly SavedChart[], previous: readonly SavedChart[]) {
  const before = chartsById(previous), changed = [];
  for (const [id, group] of chartsById(charts)) {
    const original = before.get(id) || [];
    const saved = original.map(chart => JSON.stringify(chart)).sort();
    const next = group.map(chart => JSON.stringify(chart)).sort();
    if (saved.length === next.length && saved.every((value, index) => value === next[index])) continue;
    if (original.length > 1 || group.length > 1) throw saveFailure('ambiguous', ambiguousMessage);
    changed.push(group[0]);
  }
  return changed;
}

export function writeChartChanges(storage: ChartStorage, charts: readonly SavedChart[], previous: readonly SavedChart[]) {
  let changed;
  try {
    const checked = charts.map(chart => {
      const validated = validateLibraryChart(chart);
      if (!validated.id) throw new Error('Некорректный идентификатор карты.');
      return { ...chart, name: validated.name };
    });
    changed = changedChartRecords(checked, previous);
  }
  catch (error) { throw (error as StorageError)?.code === 'ambiguous' ? error : saveFailure('invalid', (error as Error).message); }
  if (!changed.length) return 0;
  const latest = chartsById(readCharts(storage)), ids = new Set(latest.keys());
  for (const chart of changed) {
    if ((latest.get(chart.id)?.length ?? 0) > 1) throw saveFailure('ambiguous', ambiguousMessage);
    if (storage.getItem(`${CHART_DELETED_PREFIX}${chart.id}`) !== null) {
      throw saveFailure('deleted', 'Карта удалена в другой вкладке. Изменения не сохранены.');
    }
    const key = `${CHART_RECORD_PREFIX}${chart.id}`, stored = storage.getItem(key);
    if (stored !== null) {
      try {
        const record = JSON.parse(stored);
        if (record.version !== 2 || validateLibraryChart(record.chart).id !== chart.id) throw new Error();
      } catch { throw saveFailure('corrupt', 'Сохранённая карта повреждена. Исходные данные оставлены без изменений.'); }
    }
    ids.add(chart.id);
  }
  if (ids.size > 500) throw saveFailure('limit', 'В библиотеке уже 500 карт.');
  for (const chart of changed) {
    const key = `${CHART_RECORD_PREFIX}${chart.id}`;
    storage.setItem(key, JSON.stringify({ version: 2, chart }));
    // A delete between the preflight and setItem remains authoritative. The
    // separate marker cannot be overwritten by this stale record write.
    if (storage.getItem(`${CHART_DELETED_PREFIX}${chart.id}`) !== null) {
      try { storage.removeItem(key); } catch { /* The tombstone still hides it. */ }
      throw saveFailure('deleted', 'Карта удалена в другой вкладке. Изменения не сохранены.');
    }
  }
  return changed.length;
}

export function deleteChart(storage: ChartStorage, charts: SavedChart[], id: string, onCleanupError: (message: string) => void = () => {}, onInvalid: (key: string) => void = () => {}) {
  const target = charts.find(c => c.id === id);
  if (!target || id === 'demo' || id === 'current-transit' || target.source === 'transit') throw new Error('Эта карта не удаляется.');
  storage.setItem(`${CHART_DELETED_PREFIX}${id}`, '1');
  // Deletion is committed by the marker. Cleanup uses fresh raw arrays and
  // removes only the explicitly confirmed ID, including its historical copy.
  // A cleanup failure must not falsely report that the visible card survived.
  // Cross-tab array cleanup is best effort, not transactional secure erasure;
  // the per-ID tombstone is the authoritative deletion state.
  let incomplete = false;
  try { if (storage.getItem(`${CHART_RECORD_PREFIX}${id}`) !== null) storage.removeItem(`${CHART_RECORD_PREFIX}${id}`); }
  catch { incomplete = true; }
  for (const key of [STORAGE_KEY, TRASH_KEY]) {
    try {
      const raw = storage.getItem(key);
      if (!raw) continue;
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) throw new Error();
      const next = data.filter(record => record?.id !== id);
      if (next.length !== data.length) storage.setItem(key, JSON.stringify(next));
    } catch { incomplete = true; }
  }
  if (incomplete) onCleanupError('Карта удалена из библиотеки, но не удалось очистить все прежние данные в браузере.');
  try { return readCharts(storage, STORAGE_KEY, onInvalid); }
  catch { return charts.filter(chart => chart.id !== id); }
}
