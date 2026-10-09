import { SUPPORTED_START, SUPPORTED_END_EXCLUSIVE, LIFE_SPAN_YEARS } from './date-limits.js';

// Successful calculation results have the same contract at the worker boundary
// and in device storage. Request admission and error mapping belong to transport.
const YEAR_MS = 365.2425 * 86400000;
// This is the chart protocol's complete set, independent of UI labels/order.
const PLANETS = new Set(['sun', 'earth', 'moon', 'north_node', 'south_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto']);

export function cycleUtcMilliseconds(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19) ? time : NaN;
}

export function validCycleEvent(event, input) {
  const time = cycleUtcMilliseconds(event?.utc), age = cycleAge(event?.utc, input.birthUtc);
  return event?.body === input.body && Number.isFinite(time) && Number.isFinite(age) && age > 0 && age <= 300
    && time >= SUPPORTED_START && time < SUPPORTED_END_EXCLUSIVE
    && Number.isFinite(event.age) && Math.abs(event.age - age) < 1e-6
    && event.id === `${event.body}:${event.utc}` && event.cycleId === `${event.body}:${event.cycle}`
    && Number.isInteger(event.cycle) && event.cycle > 0 && Number.isInteger(event.pass) && event.pass > 0
    && ['direct', 'retrograde', 'stationary'].includes(event.direction);
}

function validActivations(entries) {
  return Array.isArray(entries) && entries.length === PLANETS.size && new Set(entries.map(entry => entry?.planet)).size === PLANETS.size
    && entries.every(entry => entry && PLANETS.has(entry.planet) && Number.isFinite(entry.longitude) && entry.longitude >= 0 && entry.longitude < 360
      && Number.isInteger(entry.gate) && entry.gate >= 1 && entry.gate <= 64 && Number.isInteger(entry.line) && entry.line >= 1 && entry.line <= 6);
}

// Subtract integer milliseconds before adding the fractional tails. Absolute
// UTC strings and cache identities retain all six decimal places unchanged.
export function cycleUtcDifference(actual, requested) {
  const difference = cycleUtcMilliseconds(actual) - cycleUtcMilliseconds(requested);
  if (!Number.isFinite(difference)) return NaN;
  const tail = utc => Number((utc.split('.')[1]?.slice(0, -1) || '').padEnd(6, '0').slice(3)) / 1000;
  return difference + tail(actual) - tail(requested);
}

export const cycleAge = (utc, birthUtc) => cycleUtcDifference(utc, birthUtc) / YEAR_MS;
// Rounded requests may be refined by Python within one second.
const resolvedEventMatches = (actual, requested) => Math.abs(cycleUtcDifference(actual, requested)) <= 1000;

export function validCycleResult(action, data, input) {
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
    && validActivations(chart.activations?.personality) && validActivations(chart.activations?.design);
}
