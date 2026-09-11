export const STORAGE_KEY = 'liniya.charts.v1';
export const VIEW_KEY = 'liniya.views.v1';
export const TRASH_KEY = 'liniya.trash.v1';

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
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 80) throw new Error('У карты должно быть имя длиной до 80 символов.');
  for (const key of ['personality', 'design']) {
    if (!Array.isArray(raw[key]) || raw[key].length > 64 || raw[key].some(n => !Number.isInteger(n) || n < 1 || n > 64)) throw new Error('Некорректный список активаций: нужны номера от 1 до 64.');
  }
  const cleanText = (key, max) => typeof raw[key] === 'string' ? raw[key].slice(0, max) : '';
  const source = ['calculated', 'transit'].includes(raw.source) ? raw.source : 'manual';
  const result = {
    id: typeof raw.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(raw.id) && raw.id !== 'demo' ? raw.id : null,
    name: raw.name.trim(),
    personality: [...new Set(raw.personality)].sort((a, b) => a - b),
    design: [...new Set(raw.design)].sort((a, b) => a - b),
    birthDate: cleanText('birthDate', 10), birthTime: cleanText('birthTime', 5), birthPlace: cleanText('birthPlace', 120), note: cleanText('note', 2000),
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

export function encodeChart(chart) {
  return JSON.stringify({ format: 'liniya-chart', version: 1, chart: validateChart(chart) }, null, 2);
}

export function decodeChart(text) {
  if (text.length > 100000) throw new Error('Файл слишком большой. Выберите экспорт одной карты.');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Не удалось прочитать JSON-файл.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.format !== 'liniya-chart' || data.version !== 1) throw new Error('Нужен файл карты, экспортированный из этого приложения.');
  return validateChart(data.chart);
}

export function readCharts(storage, key = STORAGE_KEY) {
  const value = storage.getItem(key);
  if (!value) return [];
  const data = JSON.parse(value);
  if (!Array.isArray(data) || data.length > 500) throw new Error('Не удалось прочитать сохранённую библиотеку.');
  return data.map(validateChart).filter(chart => chart.id);
}

export function writeCharts(storage, charts, key = STORAGE_KEY) {
  storage.setItem(key, JSON.stringify(charts));
}

export function deleteChart(storage, charts, id) {
  const target = charts.find(c => c.id === id);
  if (!target || id === 'demo' || id === 'current-transit' || target.source === 'transit') throw new Error('Эта карта не удаляется.');
  // Older releases may have retained a copy of this same record. Remove only
  // the confirmed target; never purge unrelated historical records on load.
  const legacy = readCharts(storage, TRASH_KEY);
  if (legacy.some(c => c.id === id)) writeCharts(storage, legacy.filter(c => c.id !== id), TRASH_KEY);
  const next = charts.filter(c => c.id !== id);
  writeCharts(storage, next);
  return next;
}
