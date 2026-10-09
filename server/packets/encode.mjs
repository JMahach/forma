import { byteView as view, validOrder, encodeFloat64Words, shuffle } from '../../shared/day-packets/float64-codec.js';
import { TRANSIT_DAY_VERSION, TRANSIT_DAY_COLUMNS, TRANSIT_SAMPLES as MINUTES, TRANSIT_PAYLOAD_BYTES as PAYLOAD_BYTES,
  TRANSIT_MAX_HEADER_BYTES as MAX_HEADER_BYTES, validateTransitMetadata, validTransitValue, failTransitPacket } from '../../shared/day-packets/transit-format.js';
import { NATAL_DAY_VERSION, NATAL_DAY_COLUMNS as COLUMNS, NATAL_DAY_MAX_SAMPLES as MAX_SAMPLES,
  NATAL_DAY_MAX_HEADER_BYTES as MAX_HEADER, validateNatalDayMetadata, validNatalDayValue, failNatalDayPacket } from '../../shared/day-packets/natal-format.js';

const encoder = new TextEncoder();
function transitWords(values, order) {
  if (!validOrder(order) || !values || values.length !== MINUTES) return failTransitPacket();
  for (let row = 0; row < values.length; row++) if (!Number.isFinite(values[row])) return failTransitPacket();
  return encodeFloat64Words(values, order);
}
function natalWords(values, order) {
  if (!validOrder(order) || !values || !Number.isInteger(values.length) || values.length < 1 || values.length > MAX_SAMPLES) return failNatalDayPacket();
  for (let row = 0; row < values.length; row++) if (!Number.isFinite(values[row])) return failNatalDayPacket();
  return encodeFloat64Words(values, order);
}
export const encodeNumericColumn = (values, order) => shuffle(transitWords(values, order));
export const encodeNatalDayColumn = (values, order) => shuffle(natalWords(values, order));

export function encodeTransitDay(day, { orders = Array(TRANSIT_DAY_COLUMNS).fill(3) } = {}) {
  const header = validateTransitMetadata({ version: TRANSIT_DAY_VERSION, date: day.date, startUtc: day.startUtc,
    ...(day.calculationVersion ? { calculationVersion: day.calculationVersion } : {}),
    samples: day.samples, stepSeconds: day.stepSeconds, orders: [...orders], engine: day.engine,
    ephemeris: day.ephemeris, timezoneDatabase: day.timezoneDatabase, nodeModel: day.nodeModel, zodiac: day.zodiac });
  if (!Array.isArray(day.columns) || day.columns.length !== TRANSIT_DAY_COLUMNS) return failTransitPacket();
  const metadata = encoder.encode(JSON.stringify(header));
  if (metadata.length > MAX_HEADER_BYTES) return failTransitPacket();
  const numeric = new Uint8Array(PAYLOAD_BYTES);
  for (let i = 0; i < TRANSIT_DAY_COLUMNS; i++) {
    const column = day.columns[i];
    if (!column || column.length !== MINUTES) return failTransitPacket();
    for (let row = 0; row < MINUTES; row++) if (!validTransitValue(column[row], i)) return failTransitPacket();
    numeric.set(encodeFloat64Words(column, orders[i]), i * MINUTES * 8);
  }
  const packet = new Uint8Array(8 + metadata.length + PAYLOAD_BYTES);
  packet.set([70, 84, 68, 49]); // FTD1
  view(packet).setUint32(4, metadata.length, true);
  packet.set(metadata, 8);
  packet.set(shuffle(numeric), 8 + metadata.length);
  return packet;
}

export function encodeNatalDay(day, { orders = Array(COLUMNS).fill(3) } = {}) {
  const header = validateNatalDayMetadata({ version: NATAL_DAY_VERSION, date: day.date, timezone: day.timezone, startUtc: day.startUtc,
    ...(day.calculationVersion !== undefined ? { calculationVersion: day.calculationVersion } : {}),
    samples: day.samples, stepSeconds: day.stepSeconds, segments: day.segments, orders: [...orders],
    engine: day.engine, ephemeris: day.ephemeris, timezoneDatabase: day.timezoneDatabase, nodeModel: day.nodeModel, zodiac: day.zodiac });
  if (!Array.isArray(day.columns) || day.columns.length !== COLUMNS) return failNatalDayPacket();
  const metadata = encoder.encode(JSON.stringify(header));
  if (metadata.length > MAX_HEADER) return failNatalDayPacket();
  const numeric = new Uint8Array(COLUMNS * day.samples * 8);
  for (let i = 0; i < COLUMNS; i++) {
    const column = day.columns[i];
    if (!column || column.length !== day.samples) return failNatalDayPacket();
    for (let row = 0; row < day.samples; row++) if (!validNatalDayValue(column[row], i)) return failNatalDayPacket();
    numeric.set(encodeFloat64Words(column, orders[i]), i * day.samples * 8);
  }
  const packet = new Uint8Array(8 + metadata.length + numeric.length);
  packet.set([70, 67, 68, 49]); // FCD1
  view(packet).setUint32(4, metadata.length, true);
  packet.set(metadata, 8); packet.set(shuffle(numeric), 8 + metadata.length);
  return packet;
}
