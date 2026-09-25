import { gatePositionAtLongitude } from '../domain/gate-wheel.js';

// Separate from the public UTC transit contract: local minute grids may contain
// gaps, repeated hours, or historical UTC offsets measured in seconds.
export const CHART_DAY_VERSION = '1';
export const CHART_DAY_PLANETS = Object.freeze(['sun', 'moon', 'north_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto']);
const DISPLAY_PLANETS = ['sun', 'earth', 'moon', 'north_node', 'south_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];
const COLUMNS = 24, MAX_SAMPLES = 2880, MAX_HEADER = 16384;
const COEFFICIENTS = [[], [1n], [2n, -1n], [3n, -3n, 1n], [4n, -6n, 4n, -1n]];
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const fail = () => { throw new Error('Некорректный пакет дня рождения.'); };
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const iso = value => new Date(value).toISOString().replace('.000Z', 'Z');
const validOrder = order => Number.isInteger(order) && order >= 0 && order <= 4;
const predicted = (history, row, order) => row < order ? 0n : COEFFICIENTS[order].reduce((sum, coefficient, i) => sum + coefficient * history[i], 0n);
function remember(history, value, order) { history.unshift(value); if (history.length > order) history.pop(); }
function shuffle(bytes, inverse = false) {
  const count = bytes.length / 8, output = new Uint8Array(bytes.length);
  for (let byte = 0; byte < 8; byte++) for (let word = 0; word < count; word++) {
    const flat = word * 8 + byte, plane = byte * count + word;
    output[inverse ? flat : plane] = bytes[inverse ? plane : flat];
  }
  return output;
}
function numericWords(values, order) {
  if (!validOrder(order) || !values || !Number.isInteger(values.length) || values.length < 1 || values.length > MAX_SAMPLES) return fail();
  const bytes = new Uint8Array(values.length * 8), data = view(bytes), scratch = new DataView(new ArrayBuffer(8)), history = [];
  for (let row = 0; row < values.length; row++) {
    if (!Number.isFinite(values[row])) return fail();
    scratch.setFloat64(0, values[row], true);
    const bits = scratch.getBigUint64(0, true), delta = BigInt.asIntN(64, bits - predicted(history, row, order));
    data.setBigUint64(row * 8, (delta << 1n) ^ (delta >> 63n), true);
    remember(history, bits, order);
  }
  return bytes;
}
export const encodeChartDayColumn = (values, order) => shuffle(numericWords(values, order));
function offsetLabel(seconds) {
  const value = Math.abs(seconds), hours = Math.floor(value / 3600), minutes = Math.floor(value % 3600 / 60), rest = value % 60;
  const pad = value => String(value).padStart(2, '0');
  return `UTC${seconds < 0 ? '−' : '+'}${pad(hours)}:${pad(minutes)}${rest ? `:${pad(rest)}` : ''}`;
}
function validateMetadata(header) {
  if (!header || header.version !== CHART_DAY_VERSION || !Number.isInteger(header.samples) || header.samples < 1 || header.samples > MAX_SAMPLES
    || header.stepSeconds !== 60 || !Array.isArray(header.orders) || header.orders.length !== COLUMNS || !header.orders.every(validOrder)
    || typeof header.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(header.date) || header.date < '1801-01-01' || header.date > '2399-12-31'
    || typeof header.timezone !== 'string' || !header.timezone || header.timezone.length > 160
    || !Array.isArray(header.segments) || !header.segments.length || header.segments.length > 128
    || header.nodeModel !== 'true' || header.zodiac !== 'tropical-geocentric-apparent') return fail();
  for (const key of ['engine', 'ephemeris', 'timezoneDatabase']) if (typeof header[key] !== 'string' || !header[key] || header[key].length > 256) return fail();
  let previousEnd = -Infinity;
  for (let i = 0; i < header.segments.length; i++) {
    const segment = header.segments[i], nextIndex = header.segments[i + 1]?.index ?? header.samples;
    if (!segment || !Number.isInteger(segment.index) || segment.index < 0 || segment.index >= header.samples || (i === 0 && segment.index !== 0)
      || !Number.isInteger(nextIndex) || nextIndex <= segment.index || nextIndex > header.samples
      || !Number.isInteger(segment.offsetSeconds) || Math.abs(segment.offsetSeconds) > 86400 || ![0, 1].includes(segment.fold)
      || segment.utcOffset !== offsetLabel(segment.offsetSeconds) || typeof segment.startUtc !== 'string') return fail();
    const start = Date.parse(segment.startUtc), end = start + (nextIndex - segment.index - 1) * 60000;
    if (!Number.isFinite(start) || iso(start) !== segment.startUtc || start <= previousEnd) return fail();
    for (const moment of [start, end]) {
      const local = iso(moment + segment.offsetSeconds * 1000);
      if (local.slice(0, 10) !== header.date || local.slice(17, 19) !== '00') return fail();
    }
    previousEnd = end;
  }
  if (header.startUtc !== header.segments[0].startUtc) return fail();
  return header;
}
function validValue(value, column) {
  return Number.isFinite(value) && (column < 22 ? value >= 0 && value < 360
    : column === 22 ? Number.isInteger(value) && value > -10_000_000_000 && value < 20_000_000_000 : value >= 0 && value <= 1e-7);
}
export function encodeChartDay(day, { orders = Array(COLUMNS).fill(3) } = {}) {
  const header = validateMetadata({ version: CHART_DAY_VERSION, date: day.date, timezone: day.timezone, startUtc: day.startUtc,
    samples: day.samples, stepSeconds: day.stepSeconds, segments: day.segments, orders: [...orders],
    engine: day.engine, ephemeris: day.ephemeris, timezoneDatabase: day.timezoneDatabase, nodeModel: day.nodeModel, zodiac: day.zodiac });
  if (!Array.isArray(day.columns) || day.columns.length !== COLUMNS) return fail();
  const metadata = encoder.encode(JSON.stringify(header));
  if (metadata.length > MAX_HEADER) return fail();
  const numeric = new Uint8Array(COLUMNS * day.samples * 8);
  day.columns.forEach((column, i) => {
    if (column.length !== day.samples || !column.every(value => validValue(value, i))) return fail();
    numeric.set(numericWords(column, orders[i]), i * day.samples * 8);
  });
  const packet = new Uint8Array(8 + metadata.length + numeric.length);
  packet.set([70, 67, 68, 49]); // FCD1
  view(packet).setUint32(4, metadata.length, true);
  packet.set(metadata, 8); packet.set(shuffle(numeric), 8 + metadata.length);
  return packet;
}
export function decodeChartDay(input) {
  const packet = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : fail();
  if (packet.length < 8 + COLUMNS * 8 || packet.length > 8 + MAX_HEADER + MAX_SAMPLES * COLUMNS * 8
    || packet[0] !== 70 || packet[1] !== 67 || packet[2] !== 68 || packet[3] !== 49) return fail();
  const length = view(packet).getUint32(4, true);
  if (!length || length > MAX_HEADER || length + 8 > packet.length) return fail();
  let metadata;
  try { metadata = validateMetadata(JSON.parse(decoder.decode(packet.subarray(8, 8 + length)))); }
  catch { return fail(); }
  if (packet.length !== 8 + length + COLUMNS * metadata.samples * 8) return fail();
  const words = view(shuffle(packet.subarray(8 + length), true)), scratch = new DataView(new ArrayBuffer(8));
  const columns = metadata.orders.map((order, column) => {
    const values = new Float64Array(metadata.samples), history = [];
    for (let row = 0; row < metadata.samples; row++) {
      const coded = words.getBigUint64((column * metadata.samples + row) * 8, true);
      const bits = BigInt.asUintN(64, ((coded >> 1n) ^ -(coded & 1n)) + predicted(history, row, order));
      scratch.setBigUint64(0, bits, true);
      const value = scratch.getFloat64(0, true);
      if (!validValue(value, column)) return fail();
      values[row] = value; remember(history, bits, order);
    }
    return values;
  });
  return { ...metadata, columns };
}
export function chartDayMinute(day, index) {
  if (!Number.isInteger(index) || index < 0 || index >= day.samples) return fail();
  const segment = day.segments.findLast(segment => segment.index <= index);
  const moment = Date.parse(segment.startUtc) + (index - segment.index) * 60000;
  return { index, utc: iso(moment), birthTime: iso(moment + segment.offsetSeconds * 1000).slice(11, 16), utcOffset: segment.utcOffset, fold: segment.fold };
}
export function chartDayIndexAt(day, utc) {
  const moment = typeof utc === 'number' ? utc : Date.parse(utc);
  if (!Number.isFinite(moment)) return 0;
  let low = 0, high = day.samples - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (Date.parse(chartDayMinute(day, mid).utc) <= moment) low = mid + 1; else high = mid;
  }
  return Date.parse(chartDayMinute(day, low).utc) > moment ? Math.max(0, low - 1) : low;
}
export function chartAtMinute(day, index, originalChart) {
  const minute = chartDayMinute(day, index);
  const activations = Object.fromEntries(['personality', 'design'].map((side, sideIndex) => {
    const values = Object.fromEntries(CHART_DAY_PLANETS.map((planet, column) => [planet, day.columns[sideIndex * 11 + column][index]]));
    values.earth = (values.sun + 180) % 360; values.south_node = (values.north_node + 180) % 360;
    return [side, DISPLAY_PLANETS.map(planet => ({ planet, ...gatePositionAtLongitude(values[planet]) }))];
  }));
  return { ...originalChart, source: 'calculated', birthDate: day.date, timezone: day.timezone,
    utc: minute.utc, birthTime: minute.birthTime, utcOffset: minute.utcOffset, fold: minute.fold,
    activations, personality: [...new Set(activations.personality.map(a => a.gate))].sort((a, b) => a - b),
    design: [...new Set(activations.design.map(a => a.gate))].sort((a, b) => a - b),
    designUtc: iso(day.columns[22][index] * 1000), designArcResidualDegrees: day.columns[23][index],
    engine: day.engine, ephemeris: day.ephemeris, timezoneDatabase: day.timezoneDatabase, nodeModel: day.nodeModel, zodiac: day.zodiac };
}
