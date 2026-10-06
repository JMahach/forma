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

function validEvent(event, input) {
  const time = cycleUtcMilliseconds(event?.utc), birth = cycleUtcMilliseconds(input.birthUtc), age = (time - birth) / YEAR_MS;
  return event?.body === input.body && Number.isFinite(time) && Number.isFinite(age) && age > 0 && age <= 300
    && event.utc >= '1801-01-01' && event.utc < '2400-01-01'
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

// Python may resolve a rounded request to an event within one second. Subtract
// the integer milliseconds before adding the tails, preserving the microsecond
// boundary without rounding either UTC string or its cache identity.
function resolvedEventMatches(actual, requested) {
  const difference = cycleUtcMilliseconds(actual) - cycleUtcMilliseconds(requested);
  if (!Number.isFinite(difference)) return false;
  const tail = utc => Number((utc.split('.')[1]?.slice(0, -1) || '').padEnd(6, '0').slice(3)) / 1000;
  return Math.abs(difference + tail(actual) - tail(requested)) <= 1000;
}

export function validCycleResult(action, data, input) {
  if (!data || typeof data !== 'object') return false;
  if (action === 'events') {
    const low = input.fromAge ?? 0, high = input.toAge ?? 100;
    if (!Array.isArray(data.events) || data.range?.fromAge !== low || data.range?.toAge !== high) return false;
    let previous = -Infinity;
    return data.events.every(event => {
      const valid = validEvent(event, input) && event.age >= low - 1e-8 && event.age <= high + 1e-8 && event.age > previous;
      previous = event?.age; return valid;
    });
  }
  const chart = data.chart;
  return action === 'chart' && validEvent(data.event, input) && resolvedEventMatches(data.event.utc, input.eventUtc)
    && chart?.source === 'calculated' && chart.utc === data.event.utc && chart.timezone === (input.timezone ?? 'UTC')
    && Number.isFinite(chart.designArcResidualDegrees) && Math.abs(chart.designArcResidualDegrees) <= 1e-7
    && validActivations(chart.activations?.personality) && validActivations(chart.activations?.design);
}
