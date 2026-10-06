export const LIFE_SPAN_YEARS = 100;
const DAY_MS = 86400000, ELAPSED_YEAR_MS = 365.2425 * DAY_MS;
const ARCHIVE_START = Date.UTC(1801, 0, 1), ARCHIVE_END = Date.UTC(2400, 0, 1) - 1;

// Labels describe the event; astronomical searching belongs to the server.
export const CYCLE_BODIES = Object.freeze([
  ['sun', 'Соляр', 'Солнце'], ['moon', 'Лунар', 'Луна'], ['north_node', 'Возврат лунных узлов', 'Лунные узлы'],
  ['mercury', 'Возврат Меркурия', 'Меркурий'], ['venus', 'Возврат Венеры', 'Венера'], ['mars', 'Возврат Марса', 'Марс'],
  ['jupiter', 'Возврат Юпитера', 'Юпитер'], ['saturn', 'Возврат Сатурна', 'Сатурн'],
  ['uranus_opposition', 'Оппозиция Урана', 'Оппозиция Урана'], ['chiron', 'Возврат Хирона', 'Хирон'],
  ['uranus', 'Возврат Урана', 'Уран'], ['neptune', 'Возврат Нептуна', 'Нептун'], ['pluto', 'Возврат Плутона', 'Плутон'],
].map(([id, label, name]) => Object.freeze({ id, label, name })));
export const cycleLabel = body => CYCLE_BODIES.find(item => item.id === body)?.label || 'Возврат';
export const cycleEventLabel = event => `${cycleLabel(event?.body)}${Number.isInteger(event?.cycle) && event.cycle > 0 ? ` ${event.cycle}` : ''}`;
export const eligibleCycleChart = chart => Boolean(chart?.source === 'calculated' && chart.id
  && Date.parse(chart.utc) >= ARCHIVE_START && Date.parse(chart.utc) < ARCHIVE_END
  && chart.activations?.personality?.length === 13 && chart.activations?.design?.length === 13);

export function cycleRangeForChart(chart) {
  if (!chart) return null;
  const available = (ARCHIVE_END - Date.parse(chart.utc)) / ELAPSED_YEAR_MS;
  return { fromAge: 0, toAge: Math.max(0, Math.min(LIFE_SPAN_YEARS, available)) };
}
const cycleSearchEnd = chart => Math.min(ARCHIVE_END, Date.parse(chart.utc) + cycleRangeForChart(chart).toAge * ELAPSED_YEAR_MS);

// Search ages are elapsed UTC time; the chosen year is a local calendar year.
// A day's UTC padding covers its timezone edges, including the date line.
export function cycleRangeForYear(chart, year) {
  if (!chart) return null;
  const birth = Date.parse(chart.utc), end = cycleSearchEnd(chart);
  const low = Math.max(birth, Date.UTC(year, 0, 1) - DAY_MS), high = Math.min(end, Date.UTC(year + 1, 0, 1) + DAY_MS);
  return { fromAge: Math.max(0, (low - birth) / ELAPSED_YEAR_MS), toAge: Math.min(300, (high - birth) / ELAPSED_YEAR_MS) };
}
export function cycleCalendarYear(utc, timezone = 'UTC') {
  return Number(new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric' }).format(new Date(utc)));
}
export function cycleYearBoundsForChart(chart) {
  const end = cycleSearchEnd(chart);
  try { return { minYear: cycleCalendarYear(chart.utc, chart.timezone || 'UTC'), maxYear: Math.min(2399, cycleCalendarYear(end, chart.timezone || 'UTC')) }; }
  catch { return { minYear: new Date(chart.utc).getUTCFullYear(), maxYear: Math.min(2399, new Date(end).getUTCFullYear()) }; }
}
export function cycleEventWithinRange(chart, utc) {
  const range = cycleRangeForChart(chart), age = (Date.parse(utc) - Date.parse(chart?.utc)) / ELAPSED_YEAR_MS;
  return Boolean(range && Number.isFinite(age) && age > 0 && age <= range.toAge + 1e-8);
}


// The personal rail has one fixed calendar span; search ages remain fractional.
export function lifeTimelineForChart(chart) {
  const utc = chart?.utc;
  if (typeof utc !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(utc)) return null;
  const milliseconds = Date.parse(utc);
  if (!Number.isFinite(milliseconds)) return null;
  const birth = new Date(milliseconds), fromDate = birth.toISOString().slice(0, 10);
  if (birth.toISOString().slice(0, 19) !== utc.slice(0, 19) || fromDate < '1801-01-01' || fromDate > '2399-12-31') return null;
  const year = birth.getUTCFullYear() + LIFE_SPAN_YEARS, month = birth.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const anniversary = new Date(Date.UTC(year, month, Math.min(birth.getUTCDate(), lastDay))).toISOString().slice(0, 10);
  return { fromDate, toDate: anniversary > '2399-12-31' ? '2399-12-31' : anniversary };
}
