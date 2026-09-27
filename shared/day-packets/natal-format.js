import { validOrder } from './float64-codec.js';

// Separate from the public UTC transit contract: local minute grids may contain
// gaps, repeated hours, or historical UTC offsets measured in seconds.
export const CHART_DAY_VERSION = '1';
export const CHART_DAY_PLANETS = Object.freeze(['sun', 'moon', 'north_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto']);
// Personality's eleven columns, Design's eleven, Design UTC seconds, residual.
export const CHART_DAY_COLUMNS = 24, CHART_DAY_MAX_SAMPLES = 2880, CHART_DAY_MAX_HEADER_BYTES = 16384;
export const failChartDayPacket = () => { throw new Error('Некорректный пакет дня рождения.'); };
const iso = value => new Date(value).toISOString().replace('.000Z', 'Z');
function offsetLabel(seconds) {
  const value = Math.abs(seconds), hours = Math.floor(value / 3600), minutes = Math.floor(value % 3600 / 60), rest = value % 60;
  const pad = value => String(value).padStart(2, '0');
  return `UTC${seconds < 0 ? '−' : '+'}${pad(hours)}:${pad(minutes)}${rest ? `:${pad(rest)}` : ''}`;
}
export function validateChartDayMetadata(header) {
  if (!header || header.version !== CHART_DAY_VERSION || !Number.isInteger(header.samples) || header.samples < 1 || header.samples > CHART_DAY_MAX_SAMPLES
    || header.stepSeconds !== 60 || !Array.isArray(header.orders) || header.orders.length !== CHART_DAY_COLUMNS || !header.orders.every(validOrder)
    || typeof header.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(header.date) || header.date < '1801-01-01' || header.date > '2399-12-31'
    || typeof header.timezone !== 'string' || !header.timezone || header.timezone.length > 160
    || !Array.isArray(header.segments) || !header.segments.length || header.segments.length > 128
    || header.nodeModel !== 'true' || header.zodiac !== 'tropical-geocentric-apparent') return failChartDayPacket();
  for (const key of ['engine', 'ephemeris', 'timezoneDatabase']) if (typeof header[key] !== 'string' || !header[key] || header[key].length > 256) return failChartDayPacket();
  let previousEnd = -Infinity;
  for (let i = 0; i < header.segments.length; i++) {
    const segment = header.segments[i], nextIndex = header.segments[i + 1]?.index ?? header.samples;
    if (!segment || !Number.isInteger(segment.index) || segment.index < 0 || segment.index >= header.samples || (i === 0 && segment.index !== 0)
      || !Number.isInteger(nextIndex) || nextIndex <= segment.index || nextIndex > header.samples
      || !Number.isInteger(segment.offsetSeconds) || Math.abs(segment.offsetSeconds) > 86400 || ![0, 1].includes(segment.fold)
      || segment.utcOffset !== offsetLabel(segment.offsetSeconds) || typeof segment.startUtc !== 'string') return failChartDayPacket();
    const start = Date.parse(segment.startUtc), end = start + (nextIndex - segment.index - 1) * 60000;
    if (!Number.isFinite(start) || iso(start) !== segment.startUtc || start <= previousEnd) return failChartDayPacket();
    for (const moment of [start, end]) {
      const local = iso(moment + segment.offsetSeconds * 1000);
      if (local.slice(0, 10) !== header.date || local.slice(17, 19) !== '00') return failChartDayPacket();
    }
    previousEnd = end;
  }
  if (header.startUtc !== header.segments[0].startUtc) return failChartDayPacket();
  return header;
}
export function validChartDayValue(value, column) {
  return Number.isFinite(value) && (column < 22 ? value >= 0 && value < 360
    : column === 22 ? Number.isInteger(value) && value > -10_000_000_000 && value < 20_000_000_000 : value >= 0 && value <= 1e-7);
}
