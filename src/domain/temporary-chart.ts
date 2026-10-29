import { MAX_CALCULATION_RECEIPT_LENGTH } from '../../shared/chart-record-contract.ts';
import { validateChartSide } from '../../shared/chart-activations.ts';
import { normalizeChartName } from './chart-record.ts';
import type { ChartRecord, SavedChart, ChartActivations } from '../../shared/chart-types.ts';
// Validate the ready calculated/transit record kept in the tab snapshot.
function validateTemporaryChartRecord(raw: ChartRecord & {source: 'calculated' | 'transit'}): ChartRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('В файле нет карты.');
  const name = normalizeChartName(raw.name);
  if (typeof raw.name !== 'string' || !name || raw.name.length > 80 || name.length > 80) throw new Error('У карты должно быть имя длиной до 80 символов.');
  for (const key of ['personality', 'design'] as const) {
    if (!Array.isArray(raw[key]) || raw[key].length > 64 || raw[key].some(n => !Number.isInteger(n) || n < 1 || n > 64)) throw new Error('Некорректный список активаций: нужны номера от 1 до 64.');
  }
  const cleanText = (key: keyof ChartRecord, max: number) => typeof raw[key] === 'string' ? raw[key].slice(0, max) : '';
  const source = raw.source;
  const result: ChartRecord = {
    id: typeof raw.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(raw.id) && raw.id !== 'demo' ? raw.id : null,
    name,
    personality: [...new Set(raw.personality)].sort((a, b) => a - b),
    design: [...new Set(raw.design)].sort((a, b) => a - b),
    birthDate: cleanText('birthDate', 10), birthTime: cleanText('birthTime', 8), birthPlace: cleanText('birthPlace', 120), note: cleanText('note', 2000),
    createdAt: cleanText('createdAt', 40), updatedAt: cleanText('updatedAt', 40),
    source
  };
  if (!raw.activations || typeof raw.activations !== 'object') throw new Error('Нет подробностей расчёта карты.');
  result.activations = {} as ChartActivations;
  for (const key of ['personality', 'design'] as const) {
    const list = raw.activations[key];
    const problem = validateChartSide(result[key], list);
    if (problem === 'activations') throw new Error('Некорректные подробности активаций.');
    if (problem === 'gates') throw new Error('Список ворот не совпадает с подробностями расчёта.');
    result.activations[key] = list.map(({ planet, longitude, gate, line }) => ({ planet, longitude, gate, line }));
  }
  for (const key of ['timezone', 'utc', 'utcOffset', 'designUtc', 'engine', 'ephemeris', 'timezoneDatabase', 'nodeModel', 'zodiac', 'verification'] as const) result[key] = cleanText(key, key === 'verification' ? 500 : 160);
  if (!result.utc || !Number.isFinite(Date.parse(result.utc))) throw new Error('В расчёте нет корректного момента UTC.');
  if (!result.designUtc || !Number.isFinite(Date.parse(result.designUtc))) throw new Error('В расчёте нет корректного момента Дизайна.');
  result.fold = raw.fold === 1 ? 1 : 0;
  result.designArcResidualDegrees = Number.isFinite(raw.designArcResidualDegrees) ? raw.designArcResidualDegrees : null;
  result.cityId = raw.cityId == null ? null : String(raw.cityId).slice(0, 40);
  result.city = null;
  if (raw.city && typeof raw.city === 'object' && !Array.isArray(raw.city)) {
    result.city = {};
    for (const key of ['id', 'name', 'country', 'region', 'timezone'] as const) if (raw.city[key] != null) result.city[key] = String(raw.city[key]).slice(0, 160);
    for (const key of ['latitude', 'longitude'] as const) if (Number.isFinite(raw.city[key])) result.city[key] = raw.city[key];
  }
  return result;
}

// One ready result belongs to the tab, independently of the persistent library.
// Account ownership never belongs to this slot.
export function normalizeTemporaryChart(input: unknown): SavedChart | null {
  try {
    const raw = input as SavedChart & {source: 'calculated' | 'transit'};
    if (!raw || raw.source !== 'calculated' && raw.source !== 'transit') return null;
    const chart = validateTemporaryChartRecord(raw);
    if (!chart.id || chart.id === 'current-transit') return null;
    if (typeof raw.calculationReceipt === 'string' && raw.calculationReceipt.length <= MAX_CALCULATION_RECEIPT_LENGTH)
      chart.calculationReceipt = raw.calculationReceipt;
    return chart as SavedChart;
  } catch { return null; }
}
