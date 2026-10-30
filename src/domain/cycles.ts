import {MAIN_RETURN_BODIES,mainReturnRange} from '../../shared/chart-return-contract.ts';
import type { ChartRecord } from '../../shared/chart-types.ts';
import type { CycleEvent } from '../../shared/cycles-format.ts';
import type { ChartInput } from './chart-composition.ts';
import { LIFE_SPAN_YEARS, EPHEMERIS_LAST_YEAR, SUPPORTED_START, SUPPORTED_END_EXCLUSIVE, calendarAnniversaryUtc } from '../../shared/date-limits.ts';

const DAY_MS = 86400000;
const SUPPORTED_END = SUPPORTED_END_EXCLUSIVE - 1;
const cycleSearchEnd = (chart: ChartInput | null | undefined) => Math.min(SUPPORTED_END, calendarAnniversaryUtc(Date.parse(chart?.utc!)));

// Labels describe the event; astronomical searching belongs to the server.
export const CYCLE_BODIES = Object.freeze([
  ['sun', 'Соляр', 'Солнце', '☉'], ['moon', 'Лунар', 'Луна', '☽'], ['north_node', 'Возврат лунных узлов', 'Лунные узлы', '☊'],
  ['mercury', 'Возврат Меркурия', 'Меркурий', '☿'], ['venus', 'Возврат Венеры', 'Венера', '♀'], ['mars', 'Возврат Марса', 'Марс', '♂'],
  ['jupiter', 'Возврат Юпитера', 'Юпитер', '♃'], ['saturn', 'Возврат Сатурна', 'Сатурн', '♄'],
  ['uranus_opposition', 'Оппозиция Урана', 'Оппозиция Урана', '♅½'], ['chiron', 'Возврат Хирона', 'Хирон', '⚷'],
  ['uranus', 'Возврат Урана', 'Уран', '♅'], ['neptune', 'Возврат Нептуна', 'Нептун', '♆'], ['pluto', 'Возврат Плутона', 'Плутон', '♇'],
].map(([id, label, name, symbol]) => Object.freeze({ id, label, name, symbol })));
export const DEFAULT_CYCLE_BODIES: readonly string[] = MAIN_RETURN_BODIES;
export const cycleLabel = (body: string | undefined) => CYCLE_BODIES.find(item => item.id === body)?.label || 'Возврат';
export const cycleEventLabel = (event: Partial<CycleEvent> | null | undefined) => `${cycleLabel(event?.body)}${Number.isInteger(event?.cycle) && event!.cycle! > 0 ? ` ${event!.cycle}` : ''}`;
export const eligibleCycleChart = (chart: Partial<ChartRecord> | null | undefined) => Boolean(chart?.source === 'calculated' && chart.id
  && Date.parse(chart.utc!) >= SUPPORTED_START && Date.parse(chart.utc!) < SUPPORTED_END
  && chart.activations?.personality?.length === 13 && chart.activations?.design?.length === 13);

export function cycleRangeForChart(chart: ChartInput | null | undefined) {
  return chart?.utc ? mainReturnRange(chart.utc) : null;
}

const calendars = new Map<string, Intl.DateTimeFormat>();
function cycleCalendar(timezone: string | undefined) {
  const key = typeof timezone === 'string' && timezone ? timezone : 'UTC';
  if (!calendars.has(key)) {
    let calendar;
    try { calendar = new Intl.DateTimeFormat('en', { timeZone: key, year: 'numeric' }); }
    catch { calendar = new Intl.DateTimeFormat('en', { timeZone: 'UTC', year: 'numeric' }); }
    if (calendars.size >= 8) calendars.delete(calendars.keys().next().value!);
    calendars.set(key, calendar);
  }
  return calendars.get(key)!;
}
// Saved zones may outlive a browser's timezone database. All return calendars
// use this same UTC fallback while preserving the original event instant.
export const cycleTimeZone = (timezone: string | undefined) => cycleCalendar(timezone).resolvedOptions().timeZone;
export function cycleCalendarYear(utc: string | number, timezone = 'UTC') {
  return Number(cycleCalendar(timezone).format(new Date(utc)));
}
export function cycleYearBoundsForChart(chart: ChartInput) {
  const minYear = cycleCalendarYear(chart.utc!, chart.timezone || 'UTC');
  return { minYear, maxYear: Math.min(EPHEMERIS_LAST_YEAR, minYear + LIFE_SPAN_YEARS) };
}
export function cycleEventWithinRange(chart: ChartInput | null | undefined, utc: string) {
  const moment = Date.parse(utc), birth = Date.parse(chart?.utc!);
  return Number.isFinite(moment) && moment > birth && moment <= cycleSearchEnd(chart);
}


// The personal rail has one fixed calendar span; search ages remain fractional.
export function lifeTimelineForChart(chart: ChartInput | null | undefined) {
  const utc = chart?.utc;
  if (typeof utc !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(utc)) return null;
  const milliseconds = Date.parse(utc);
  if (!Number.isFinite(milliseconds)) return null;
  const birth = new Date(milliseconds), fromDate = birth.toISOString().slice(0, 10);
  if (birth.toISOString().slice(0, 19) !== utc.slice(0, 19) || milliseconds < SUPPORTED_START || milliseconds >= SUPPORTED_END_EXCLUSIVE) return null;
  const maximumUtc = new Date(cycleSearchEnd(chart)).toISOString();
  return { fromDate, toDate: maximumUtc.slice(0, 10), maximumUtc };
}

/** The same personal bounds apply to early intent, restored input and live commands. */
export function personalTimelineTarget(chart:ChartInput|null|undefined,requestedUtc?:number) {
  const span=lifeTimelineForChart(chart);
  return span?{opened:true as const,mode:'range' as const,...span,minimumUtc:chart!.utc!,openEnded:false,
    ...(requestedUtc===undefined?{}:{requestedUtc})}:null;
}
