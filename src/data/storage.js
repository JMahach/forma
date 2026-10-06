export const STORAGE_KEY = 'liniya.charts.v1';
export const TRASH_KEY = 'liniya.trash.v1';
export const CHART_RECORD_PREFIX = 'liniya.charts.v2:';
export const CHART_DELETED_PREFIX = 'liniya.deleted.v2:';

export function normalizeChartName(value) {
  return String(value ?? '').trim().replace(/\p{L}/u, letter => letter.toUpperCase());
}

export function createChartId(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('Браузер не поддерживает создание идентификатора карты. Обновите браузер.');
  }
  // randomUUID requires HTTPS; random bytes also work on ordinary HTTP.
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function parseGates(value) {
  if (!String(value).trim()) return [];
  const tokens = String(value).trim().split(/[\s,;]+/);
  if (tokens.some(token => !/^\d{1,2}$/.test(token) || Number(token) < 1 || Number(token) > 64)) {
    throw new Error('Укажите целые номера ворот от 1 до 64, разделяя их запятыми.');
  }
  return [...new Set(tokens.map(Number))].sort((a, b) => a - b);
}

export function validateChart(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('В файле нет карты.');
  const name = normalizeChartName(raw.name);
  if (typeof raw.name !== 'string' || !name || raw.name.length > 80 || name.length > 80) throw new Error('У карты должно быть имя длиной до 80 символов.');
  for (const key of ['personality', 'design']) {
    if (!Array.isArray(raw[key]) || raw[key].length > 64 || raw[key].some(n => !Number.isInteger(n) || n < 1 || n > 64)) throw new Error('Некорректный список активаций: нужны номера от 1 до 64.');
  }
  const cleanText = (key, max) => typeof raw[key] === 'string' ? raw[key].slice(0, max) : '';
  const source = ['calculated', 'transit'].includes(raw.source) ? raw.source : 'manual';
  const result = {
    id: typeof raw.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(raw.id) && raw.id !== 'demo' ? raw.id : null,
    name,
    personality: [...new Set(raw.personality)].sort((a, b) => a - b),
    design: [...new Set(raw.design)].sort((a, b) => a - b),
    birthDate: cleanText('birthDate', 10), birthTime: cleanText('birthTime', 8), birthPlace: cleanText('birthPlace', 120), note: cleanText('note', 2000),
    createdAt: cleanText('createdAt', 40), updatedAt: cleanText('updatedAt', 40),
    source
  };
  if (source !== 'manual') {
    const planets = new Set(['sun', 'earth', 'moon', 'north_node', 'south_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto']);
    if (!raw.activations || typeof raw.activations !== 'object') throw new Error('Нет подробностей расчёта карты.');
    result.activations = {};
    for (const key of ['personality', 'design']) {
      const list = raw.activations[key], length = key === 'design' && source === 'transit' ? 0 : 13;
      if (!Array.isArray(list) || list.length !== length || new Set(list.map(a => a?.planet)).size !== length || list.some(a => !a || !planets.has(a.planet) || !Number.isFinite(a.longitude) || a.longitude < 0 || a.longitude >= 360 || !Number.isInteger(a.gate) || a.gate < 1 || a.gate > 64 || !Number.isInteger(a.line) || a.line < 1 || a.line > 6)) throw new Error('Некорректные подробности активаций.');
      result.activations[key] = list.map(({ planet, longitude, gate, line }) => ({ planet, longitude, gate, line }));
      if (JSON.stringify([...new Set(list.map(a => a.gate))].sort((a, b) => a - b)) !== JSON.stringify(result[key])) throw new Error('Список ворот не совпадает с подробностями расчёта.');
    }
    for (const key of ['timezone', 'utc', 'utcOffset', 'designUtc', 'engine', 'ephemeris', 'timezoneDatabase', 'nodeModel', 'zodiac', 'verification']) result[key] = cleanText(key, key === 'verification' ? 500 : 160);
    if (!result.utc || !Number.isFinite(Date.parse(result.utc))) throw new Error('В расчёте нет корректного момента UTC.');
    result.designUtc = source === 'transit' ? null : result.designUtc;
    result.fold = raw.fold === 1 ? 1 : 0;
    result.designArcResidualDegrees = Number.isFinite(raw.designArcResidualDegrees) ? raw.designArcResidualDegrees : null;
    result.cityId = raw.cityId == null ? null : String(raw.cityId).slice(0, 40);
    result.city = null;
    if (raw.city && typeof raw.city === 'object' && !Array.isArray(raw.city)) {
      result.city = {};
      for (const key of ['id', 'name', 'country', 'region', 'timezone']) if (raw.city[key] != null) result.city[key] = String(raw.city[key]).slice(0, 160);
      for (const key of ['latitude', 'longitude']) if (Number.isFinite(raw.city[key])) result.city[key] = raw.city[key];
    }
  }
  return result;
}

function legacyCharts(storage, key, onInvalid) {
  const value = storage.getItem(key);
  if (!value) return [];
  let data;
  try {
    data = JSON.parse(value);
    if (!Array.isArray(data) || data.length > 500) throw new Error();
  } catch { onInvalid(key); return []; }
  return data.flatMap((raw, index) => {
    try {
      const chart = { ...raw, ...validateChart(raw) };
      if (!chart.id) throw new Error();
      return [chart];
    } catch { onInvalid(`${key}:${index}`); return []; }
  });
}

// The v1 array is a read-only fallback during ordinary saves. Each v2 key owns
// one chart; a separate tombstone wins even over an interleaved stale save.
// Never repair or rewrite corrupt data while reading another healthy record.
export function readCharts(storage, key = STORAGE_KEY, onInvalid = () => {}) {
  let charts = legacyCharts(storage, key, onInvalid);
  if (key !== STORAGE_KEY) return charts;
  const records = new Map(), deleted = new Set();
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
        const record = JSON.parse(value), chart = { ...record.chart, ...validateChart(record.chart) };
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
function saveFailure(code, message) { return Object.assign(new Error(message), { code }); }
const ambiguousMessage = 'В библиотеке есть карты с одинаковым идентификатором. Не удалось однозначно сохранить изменения.';

function chartsById(charts) {
  const groups = new Map();
  for (const chart of charts) {
    if (!groups.has(chart.id)) groups.set(chart.id, []);
    groups.get(chart.id).push(chart);
  }
  return groups;
}

// Existing repeated IDs are separate saved records. Compare whole groups,
// including multiplicity, so an unrelated action never chooses a winner.
export function changedChartRecords(charts, previous) {
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

export function writeChartChanges(storage, charts, previous) {
  let changed;
  try {
    const checked = charts.map(chart => {
      const validated = validateChart(chart);
      if (!validated.id) throw new Error('Некорректный идентификатор карты.');
      return { ...chart, name: validated.name };
    });
    changed = changedChartRecords(checked, previous);
  }
  catch (error) { throw error?.code === 'ambiguous' ? error : saveFailure('invalid', error.message); }
  if (!changed.length) return 0;
  const latest = chartsById(readCharts(storage)), ids = new Set(latest.keys());
  for (const chart of changed) {
    if (latest.get(chart.id)?.length > 1) throw saveFailure('ambiguous', ambiguousMessage);
    if (storage.getItem(`${CHART_DELETED_PREFIX}${chart.id}`) !== null) {
      throw saveFailure('deleted', 'Карта удалена в другой вкладке. Изменения не сохранены.');
    }
    const key = `${CHART_RECORD_PREFIX}${chart.id}`, stored = storage.getItem(key);
    if (stored !== null) {
      try {
        const record = JSON.parse(stored);
        if (record.version !== 2 || validateChart(record.chart).id !== chart.id) throw new Error();
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

export function deleteChart(storage, charts, id, onCleanupError = () => {}, onInvalid = () => {}) {
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
