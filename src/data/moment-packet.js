import { MOMENT_COLUMN_COUNT as COLUMNS, validMomentValue } from '../../shared/day-packets/moment-columns.js';

export const DAY_MS = 86400000, MINUTE_MS = 60000, DAY_SAMPLES = 1440;
const iso = value => new Date(value).toISOString().replace('.000Z', 'Z');
const metadataKeys = ['engine', 'ephemeris', 'timezoneDatabase', 'nodeModel', 'zodiac'];
export const packetKey = (date, version) => `${version}:${date}`;
export const packetDate = milliseconds => iso(milliseconds).slice(0, 10);
export const packetBytes = packet => (packet.day?.byteLength || 0) + packet.offsets.byteLength + packet.values.byteLength + 256;
const metadata = source => Object.fromEntries(metadataKeys.map(key => [key, source[key]]));
const empty = (date, source) => ({ key: packetKey(date, source.calculationVersion), date, version: source.calculationVersion,
  meta: metadata(source), day: null, offsets: new Uint32Array(), values: new Float64Array() });
const validVersion = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = () => { throw new Error('Некорректные числовые данные момента.'); };

export function dayPacket(day) {
  if (!validVersion(day.calculationVersion) || day.samples !== DAY_SAMPLES || day.stepSeconds !== 60
      || day.startUtc !== `${day.date}T00:00:00Z` || day.columns?.length !== COLUMNS) return fail();
  const packet = empty(day.date, day); packet.day = new Float64Array(COLUMNS * DAY_SAMPLES);
  for (let c = 0; c < COLUMNS; c++) {
    if (day.columns[c].length !== DAY_SAMPLES || !day.columns[c].every(value => validMomentValue(value, c))) return fail();
    packet.day.set(day.columns[c], c * DAY_SAMPLES);
  }
  return packet;
}
export function momentPacket(moment, source) {
  const milliseconds = Date.parse(moment?.utc), date = packetDate(milliseconds);
  if (!validVersion(source.calculationVersion) || !Number.isSafeInteger(milliseconds)) return fail();
  const packet = empty(date, source), design = moment.design;
  packet.offsets = Uint32Array.of(milliseconds - Date.parse(`${date}T00:00:00Z`));
  packet.values = Float64Array.from([...(moment.longitudes || []), ...(design?.longitudes || []),
    Date.parse(design?.designUtc) / 1000, design?.designArcResidualDegrees]);
  if (packet.values.length !== COLUMNS || !packet.values.every(validMomentValue)) return fail();
  return packet;
}
export function validPacket(packet, key) {
  if (!packet || packet.key !== key || !validVersion(packet.version) || packet.key !== packetKey(packet.date, packet.version)
      || !/^\d{4}-\d{2}-\d{2}$/.test(packet.date) || !Number.isFinite(Date.parse(`${packet.date}T00:00:00Z`))
      || !(packet.offsets instanceof Uint32Array) || !(packet.values instanceof Float64Array)
      || packet.values.length !== packet.offsets.length * COLUMNS || packet.offsets.length > 86400
      || packet.day !== null && (!(packet.day instanceof Float64Array) || packet.day.length !== DAY_SAMPLES * COLUMNS)) return false;
  for (let i = 0; i < packet.offsets.length; i++) if (packet.offsets[i] >= DAY_MS || i && packet.offsets[i] <= packet.offsets[i - 1]) return false;
  for (let c = 0; c < COLUMNS; c++) {
    for (let i = 0; i < packet.offsets.length; i++) if (!validMomentValue(packet.values[c * packet.offsets.length + i], c)) return false;
    if (packet.day) for (let i = 0; i < DAY_SAMPLES; i++) if (!validMomentValue(packet.day[c * DAY_SAMPLES + i], c)) return false;
  }
  return true;
}
// Full days own whole minutes. Sparse rows only retain visited instants and
// sub-minute exceptions; two tabs merge within the storage transaction.
export function mergePackets(previous, incoming) {
  if (!previous) return incoming;
  if (!incoming) return previous;
  const day = incoming.day || previous.day;
  const rows = new Map();
  for (const packet of [previous, incoming]) for (let i = 0; i < packet.offsets.length; i++) {
    const offset = packet.offsets[i];
    if (!day || offset % MINUTE_MS) rows.set(offset, { packet, i });
  }
  const offsets = Uint32Array.from([...rows.keys()].sort((a, b) => a - b));
  const values = new Float64Array(offsets.length * COLUMNS);
  for (let i = 0; i < offsets.length; i++) {
    const row = rows.get(offsets[i]);
    for (let c = 0; c < COLUMNS; c++) values[c * offsets.length + i] = row.packet.values[c * row.packet.offsets.length + row.i];
  }
  return { ...incoming, meta: incoming.day ? incoming.meta : previous.day ? previous.meta : { ...previous.meta, ...Object.fromEntries(Object.entries(incoming.meta).filter(([, value]) => value !== undefined)) }, day, offsets, values };
}
export function packetCatalogue(packet, accessedAt) {
  const minutes = new Uint8Array(DAY_SAMPLES / 8);
  if (packet.day) minutes.fill(255);
  else for (const offset of packet.offsets) if (offset % MINUTE_MS === 0) {
    const index = offset / MINUTE_MS; minutes[index >> 3] |= 1 << (index & 7);
  }
  return { key: packet.key, date: packet.date, version: packet.version, size: packetBytes(packet), full: packet.day ? 1 : 0, minutes, accessedAt };
}
export function catalogueHasMinute(entry, milliseconds) {
  if (!entry || milliseconds % MINUTE_MS) return false;
  const index = (milliseconds - Date.parse(`${entry.date}T00:00:00Z`)) / MINUTE_MS;
  return index >= 0 && index < DAY_SAMPLES && Boolean(entry.minutes[index >> 3] & (1 << (index & 7)));
}
export function packetMoment(packet, milliseconds) {
  const offset = milliseconds - Date.parse(`${packet.date}T00:00:00Z`);
  if (offset < 0 || offset >= DAY_MS) return null;
  let index, count, values;
  if (packet.day && offset % MINUTE_MS === 0) { index = offset / MINUTE_MS; count = DAY_SAMPLES; values = packet.day; }
  else {
    let low = 0, high = packet.offsets.length;
    while (low < high) { const mid = (low + high) >>> 1; if (packet.offsets[mid] < offset) low = mid + 1; else high = mid; }
    if (packet.offsets[low] !== offset) return null;
    index = low; count = packet.offsets.length; values = packet.values;
  }
  const column = c => values[c * count + index], utc = iso(milliseconds);
  return Object.freeze({ utc, longitudes: Object.freeze(Array.from({ length: 11 }, (_, c) => column(c))),
    design: Object.freeze({ utc, longitudes: Object.freeze(Array.from({ length: 11 }, (_, c) => column(c + 11))),
      designUtc: iso(column(22) * 1000), designArcResidualDegrees: column(23) }) });
}
// Callers receive their own numeric snapshot. Retained display data cannot
// mutate the shared cache or another tool's picture.
export function packetDay(packet) {
  if (!packet.day) return null;
  return { ...packet.meta, calculationVersion: packet.version, version: '2', date: packet.date,
    startUtc: `${packet.date}T00:00:00Z`, samples: DAY_SAMPLES, stepSeconds: 60,
    columns: Array.from({ length: COLUMNS }, (_, c) => packet.day.slice(c * DAY_SAMPLES, (c + 1) * DAY_SAMPLES)) };
}
