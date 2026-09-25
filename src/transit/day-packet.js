import { gatePositionAtLongitude } from '../domain/gate-wheel.js';

// Version the calculation AND binary contract together. Bump when ephemerides,
// calculation flags or reconstruction rules change: HTTP/disk caches use it.
export const TRANSIT_DAY_VERSION = '1';
export const TRANSIT_PLANETS = Object.freeze(['sun', 'moon', 'north_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto']);
const DISPLAY_PLANETS = ['sun', 'earth', 'moon', 'north_node', 'south_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];
const COEFFICIENTS = [[], [1n], [2n, -1n], [3n, -3n, 1n], [4n, -6n, 4n, -1n]];
const MINUTES = 1440;
const WORDS = MINUTES * TRANSIT_PLANETS.length;
const PAYLOAD_BYTES = WORDS * 8;
const MAX_HEADER_BYTES = 4096;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const fail = () => { throw new Error('Некорректный пакет дневного транзита.'); };

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return fail();
}
function view(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function validOrder(order) { return Number.isInteger(order) && order >= 0 && order <= 4; }
function predicted(history, row, order) {
  return row < order ? 0n : COEFFICIENTS[order].reduce((sum, coefficient, i) => sum + coefficient * history[i], 0n);
}
function remember(history, bits, order) { history.unshift(bits); if (history.length > order) history.pop(); }
function shuffle(bytes, inverse = false) {
  const count = bytes.byteLength / 8, out = new Uint8Array(bytes.byteLength);
  for (let byte = 0; byte < 8; byte++) for (let word = 0; word < count; word++) {
    const flat = word * 8 + byte, plane = byte * count + word;
    out[inverse ? flat : plane] = bytes[inverse ? plane : flat];
  }
  return out;
}
function numericWords(values, order) {
  if (!validOrder(order) || !values || values.length !== MINUTES) return fail();
  const bytes = new Uint8Array(MINUTES * 8), data = view(bytes), scratch = new DataView(new ArrayBuffer(8)), history = [];
  for (let row = 0; row < MINUTES; row++) {
    const value = values[row];
    if (!Number.isFinite(value) || value < 0 || value >= 360) return fail();
    scratch.setFloat64(0, value, true);
    const bits = scratch.getBigUint64(0, true);
    const delta = BigInt.asIntN(64, bits - predicted(history, row, order));
    data.setBigUint64(row * 8, (delta << 1n) ^ (delta >> 63n), true);
    remember(history, bits, order);
  }
  return bytes;
}

// The server scores five small predictors per planet using a cheap compression
// pass. This helper has no Node imports and performs no lossy float arithmetic.
export function encodeNumericColumn(values, order) { return shuffle(numericWords(values, order)); }

function validateMetadata(header) {
  if (!header || header.version !== TRANSIT_DAY_VERSION || header.samples !== MINUTES || header.stepSeconds !== 60
    || !Array.isArray(header.orders) || header.orders.length !== TRANSIT_PLANETS.length || !header.orders.every(validOrder)
    || typeof header.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(header.date)
    || header.startUtc !== `${header.date}T00:00:00Z`) return fail();
  const parsed = new Date(header.startUtc);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== header.date) return fail();
  if (header.nodeModel !== 'true' || header.zodiac !== 'tropical-geocentric-apparent') return fail();
  for (const key of ['engine', 'ephemeris', 'timezoneDatabase']) {
    if (typeof header[key] !== 'string' || !header[key] || header[key].length > 256) return fail();
  }
  return header;
}

export function encodeTransitDay(day, { orders = TRANSIT_PLANETS.map(() => 3) } = {}) {
  const header = validateMetadata({ version: TRANSIT_DAY_VERSION, date: day.date, startUtc: day.startUtc,
    samples: day.samples, stepSeconds: day.stepSeconds, orders: [...orders], engine: day.engine,
    ephemeris: day.ephemeris, timezoneDatabase: day.timezoneDatabase, nodeModel: day.nodeModel, zodiac: day.zodiac });
  if (!Array.isArray(day.columns) || day.columns.length !== TRANSIT_PLANETS.length) return fail();
  const metadata = encoder.encode(JSON.stringify(header));
  if (metadata.length > MAX_HEADER_BYTES) return fail();
  const numeric = new Uint8Array(PAYLOAD_BYTES);
  day.columns.forEach((column, i) => numeric.set(numericWords(column, orders[i]), i * MINUTES * 8));
  const packet = new Uint8Array(8 + metadata.length + PAYLOAD_BYTES);
  packet.set([70, 84, 68, 49]); // FTD1
  view(packet).setUint32(4, metadata.length, true);
  packet.set(metadata, 8);
  packet.set(shuffle(numeric), 8 + metadata.length);
  return packet;
}

// HTTP decompresses before this function. Length checks happen before JSON
// parsing or allocation of numeric arrays; dimensions are fixed by this version.
export function decodeTransitDay(input) {
  const packet = asBytes(input);
  if (packet.length < 8 + PAYLOAD_BYTES || packet.length > 8 + MAX_HEADER_BYTES + PAYLOAD_BYTES
    || packet[0] !== 70 || packet[1] !== 84 || packet[2] !== 68 || packet[3] !== 49) return fail();
  const length = view(packet).getUint32(4, true);
  if (!length || length > MAX_HEADER_BYTES || packet.length !== 8 + length + PAYLOAD_BYTES) return fail();
  let metadata;
  try { metadata = validateMetadata(JSON.parse(decoder.decode(packet.subarray(8, 8 + length)))); }
  catch { return fail(); }
  const words = view(shuffle(packet.subarray(8 + length), true)), scratch = new DataView(new ArrayBuffer(8));
  const columns = metadata.orders.map((order, column) => {
    const result = new Float64Array(MINUTES), history = [];
    for (let row = 0; row < MINUTES; row++) {
      const coded = words.getBigUint64((column * MINUTES + row) * 8, true);
      const delta = (coded >> 1n) ^ -(coded & 1n);
      const bits = BigInt.asUintN(64, delta + predicted(history, row, order));
      scratch.setBigUint64(0, bits, true);
      const value = scratch.getFloat64(0, true);
      if (!Number.isFinite(value) || value < 0 || value >= 360) return fail();
      result[row] = value;
      remember(history, bits, order);
    }
    return result;
  });
  return { ...metadata, columns };
}

export function transitChartAt(day, index) {
  if (!Number.isInteger(index) || index < 0 || index >= day.samples) return fail();
  const values = Object.fromEntries(TRANSIT_PLANETS.map((planet, column) => [planet, day.columns[column][index]]));
  values.earth = (values.sun + 180) % 360;
  values.south_node = (values.north_node + 180) % 360;
  const personality = DISPLAY_PLANETS.map(planet => ({ planet, ...gatePositionAtLongitude(values[planet]) }));
  const utc = new Date(Date.parse(day.startUtc) + index * 60000).toISOString().replace('.000Z', 'Z');
  return { id: 'current-transit', name: 'Транзит', source: 'transit',
    personality: [...new Set(personality.map(a => a.gate))].sort((a, b) => a - b), design: [],
    activations: { personality, design: [] }, utc, birthDate: utc.slice(0, 10), birthTime: utc.slice(11, 16),
    birthPlace: '', timezone: 'UTC', utcOffset: 'UTC+00:00', fold: 0, designUtc: null, cityId: null, city: null,
    engine: day.engine, ephemeris: day.ephemeris, timezoneDatabase: day.timezoneDatabase,
    nodeModel: day.nodeModel, zodiac: day.zodiac, designArcResidualDegrees: null,
    updatedAt: utc, createdAt: day.startUtc, note: '',
    verification: 'Lossless minute-grid Swiss Ephemeris transit; official Human Design reference-chart validation pending.' };
}
