import type { CalculatedChart } from './chart-types.ts';
import { validateChartSide } from './chart-activations.ts';

export interface CycleEvent {
  id: string;
  body: string;
  utc: string;
  age: number;
  cycle: number;
  cycleId: string;
  pass: number;
  direction: 'direct' | 'retrograde' | 'stationary';
}
export interface CycleInput {
  birthUtc: string;
  body: string;
  fromAge?: number;
  toAge?: number;
  eventUtc?: string;
  timezone?: string;
}
export interface CycleEventsResult { events: CycleEvent[]; range: { fromAge: number; toAge: number } }
export interface CycleChartResult { chart: CalculatedChart }
export type CycleResult = CycleEventsResult | CycleChartResult;

import { SUPPORTED_START, SUPPORTED_END_EXCLUSIVE, LIFE_SPAN_YEARS } from './date-limits.ts';
import { utcMilliseconds as cycleUtcMilliseconds } from './utc-format.ts';

// Successful calculation results have the same contract at the worker boundary
// and in device storage. Request admission and error mapping belong to transport.
const YEAR_MS = 365.2425 * 86400000;

export { utcMilliseconds as cycleUtcMilliseconds } from './utc-format.ts';

export function validCycleEvent(event: CycleEvent | null | undefined, input: CycleInput) {
  const time = cycleUtcMilliseconds(event?.utc), age = cycleAge(event?.utc, input.birthUtc);
  return event?.body === input.body && Number.isFinite(time) && Number.isFinite(age) && age > 0 && age <= 300
    && time >= SUPPORTED_START && time < SUPPORTED_END_EXCLUSIVE
    && Number.isFinite(event!.age) && Math.abs(event!.age - age) < 1e-6
    && event.id === `${event.body}:${event.utc}` && event.cycleId === `${event.body}:${event.cycle}`
    && Number.isInteger(event.cycle) && event.cycle > 0 && Number.isInteger(event.pass) && event.pass > 0
    && ['direct', 'retrograde', 'stationary'].includes(event.direction);
}

// Subtract integer milliseconds before adding the fractional tails. Absolute
// UTC strings and cache identities retain all six decimal places unchanged.
export function cycleUtcDifference(actual: string | undefined, requested: string | undefined) {
  const difference = cycleUtcMilliseconds(actual) - cycleUtcMilliseconds(requested);
  if (!Number.isFinite(difference)) return NaN;
  const tail = (utc: string | undefined) => Number((utc!.split('.')[1]?.slice(0, -1) || '').padEnd(6, '0').slice(3)) / 1000;
  return difference + tail(actual) - tail(requested);
}

export const cycleAge = (utc: string | undefined, birthUtc: string | undefined) => cycleUtcDifference(utc, birthUtc) / YEAR_MS;
// Rounded requests may be refined by Python within one second.
const resolvedEventMatches = (actual: string | undefined, requested: string | undefined) => Math.abs(cycleUtcDifference(actual, requested)) <= 1000;

export function validCycleResult(action: string, value: unknown, input: CycleInput): value is CycleResult {
  const data = value as Partial<CycleEventsResult & CycleChartResult> | null;
  if (!data || typeof data !== 'object') return false;
  if (action === 'events') {
    const low = input.fromAge ?? 0, high = input.toAge ?? LIFE_SPAN_YEARS;
    if (!Array.isArray(data.events) || data.range?.fromAge !== low || data.range?.toAge !== high) return false;
    let previous = -Infinity;
    return data.events.every(event => {
      const valid = validCycleEvent(event, input) && event.age >= low - 1e-8 && event.age <= high + 1e-8 && event.age > previous;
      previous = event?.age; return valid;
    });
  }
  const chart = data.chart;
  const age = cycleAge(chart?.utc, input.birthUtc);
  return action === 'chart' && chart?.source === 'calculated' && Number.isFinite(age) && age > 0 && age <= 300
    && cycleUtcMilliseconds(chart.utc) >= SUPPORTED_START && cycleUtcMilliseconds(chart.utc) < SUPPORTED_END_EXCLUSIVE && resolvedEventMatches(chart.utc, input.eventUtc)
    && chart.timezone === (input.timezone ?? 'UTC')
    && Number.isFinite(chart.designArcResidualDegrees) && Math.abs(chart.designArcResidualDegrees) <= 1e-7
    && validateChartSide(chart.personality, chart.activations?.personality) === null
    && validateChartSide(chart.design, chart.activations?.design) === null;
}
