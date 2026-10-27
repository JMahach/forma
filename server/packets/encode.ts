import type { MomentMetadata } from '../../shared/day-packets/transit-format.ts';
import type { NatalDayMetadata } from '../../shared/day-packets/natal-format.ts';
export type TransitDay = Omit<MomentMetadata, 'orders' | 'version'> & { columns: ArrayLike<number>[] };
export type NatalDay = Omit<NatalDayMetadata, 'orders' | 'version'> & { columns: ArrayLike<number>[] };

import { byteView as view, validOrder, encodeFloat64Words, shuffle } from '../../shared/day-packets/float64-codec.ts';
import { TRANSIT_DAY_VERSION, TRANSIT_DAY_COLUMNS, TRANSIT_SAMPLES as MINUTES, TRANSIT_PAYLOAD_BYTES as PAYLOAD_BYTES,
  TRANSIT_MAX_HEADER_BYTES as MAX_HEADER_BYTES, validateTransitMetadata, validTransitValue, failTransitPacket } from '../../shared/day-packets/transit-format.ts';
import { NATAL_DAY_VERSION, NATAL_DAY_COLUMNS as COLUMNS, NATAL_DAY_MAX_SAMPLES as MAX_SAMPLES,
  NATAL_DAY_MAX_HEADER_BYTES as MAX_HEADER, validateNatalDayMetadata, validNatalDayValue, failNatalDayPacket } from '../../shared/day-packets/natal-format.ts';

const encoder = new TextEncoder();
function transitWords(values: ArrayLike<number>, order: number) {
  if (!validOrder(order) || !values || values.length !== MINUTES) return failTransitPacket();
  for (let row = 0; row < values.length; row++) if (!Number.isFinite(values[row])) return failTransitPacket();
  return encodeFloat64Words(values, order);
}
function natalWords(values: ArrayLike<number>, order: number) {
  if (!validOrder(order) || !values || !Number.isInteger(values.length) || values.length < 1 || values.length > MAX_SAMPLES) return failNatalDayPacket();
  for (let row = 0; row < values.length; row++) if (!Number.isFinite(values[row])) return failNatalDayPacket();
  return encodeFloat64Words(values, order);
}
export const encodeNumericColumn = (values: ArrayLike<number>, order: number) => shuffle(transitWords(values, order));
export const encodeNatalDayColumn = (values: ArrayLike<number>, order: number) => shuffle(natalWords(values, order));

type EncodingOptions = { orders?: number[]; shuffledColumns?: readonly Uint8Array[] };

// Prepared columns belong to this day and these orders, within one packing call.
// Their byte planes must be joined plane by plane to match shuffle(all columns).
function copyShuffledColumn(target: Uint8Array, column: Uint8Array, index: number, samples: number) {
  const totalSamples = target.length / 8;
  for (let byte = 0; byte < 8; byte++) {
    target.set(column.subarray(byte * samples, (byte + 1) * samples), byte * totalSamples + index * samples);
  }
}

export function encodeTransitDay(day: TransitDay, { orders = Array(TRANSIT_DAY_COLUMNS).fill(3), shuffledColumns }: EncodingOptions = {}) {
  const header = validateTransitMetadata({ version: TRANSIT_DAY_VERSION, date: day.date, startUtc: day.startUtc,
    ...(day.calculationVersion ? { calculationVersion: day.calculationVersion } : {}),
    samples: day.samples, stepSeconds: day.stepSeconds, orders: [...orders], engine: day.engine,
    ephemeris: day.ephemeris, timezoneDatabase: day.timezoneDatabase, nodeModel: day.nodeModel, zodiac: day.zodiac });
  if (!Array.isArray(day.columns) || day.columns.length !== TRANSIT_DAY_COLUMNS) return failTransitPacket();
  if (shuffledColumns !== undefined && (!Array.isArray(shuffledColumns) || shuffledColumns.length !== TRANSIT_DAY_COLUMNS)) return failTransitPacket();
  const metadata = encoder.encode(JSON.stringify(header));
  if (metadata.length > MAX_HEADER_BYTES) return failTransitPacket();
  const numeric = new Uint8Array(PAYLOAD_BYTES);
  for (let i = 0; i < TRANSIT_DAY_COLUMNS; i++) {
    const column = day.columns[i];
    if (!column || column.length !== MINUTES) return failTransitPacket();
    for (let row = 0; row < MINUTES; row++) if (!validTransitValue(column[row], i)) return failTransitPacket();
    if (shuffledColumns) {
      const prepared = shuffledColumns[i];
      if (!(prepared instanceof Uint8Array) || prepared.byteLength !== MINUTES * 8) return failTransitPacket();
      copyShuffledColumn(numeric, prepared, i, MINUTES);
    } else numeric.set(encodeFloat64Words(column, orders[i]), i * MINUTES * 8);
  }
  const packet = new Uint8Array(8 + metadata.length + PAYLOAD_BYTES);
  packet.set([70, 84, 68, 49]); // FTD1
  view(packet).setUint32(4, metadata.length, true);
  packet.set(metadata, 8);
  packet.set(shuffledColumns ? numeric : shuffle(numeric), 8 + metadata.length);
  return packet;
}

export function encodeNatalDay(day: NatalDay, { orders = Array(COLUMNS).fill(3), shuffledColumns }: EncodingOptions = {}) {
  const header = validateNatalDayMetadata({ version: NATAL_DAY_VERSION, date: day.date, timezone: day.timezone, startUtc: day.startUtc,
    ...(day.calculationVersion !== undefined ? { calculationVersion: day.calculationVersion } : {}),
    samples: day.samples, stepSeconds: day.stepSeconds, segments: day.segments, orders: [...orders],
    engine: day.engine, ephemeris: day.ephemeris, timezoneDatabase: day.timezoneDatabase, nodeModel: day.nodeModel, zodiac: day.zodiac });
  if (!Array.isArray(day.columns) || day.columns.length !== COLUMNS) return failNatalDayPacket();
  if (shuffledColumns !== undefined && (!Array.isArray(shuffledColumns) || shuffledColumns.length !== COLUMNS)) return failNatalDayPacket();
  const metadata = encoder.encode(JSON.stringify(header));
  if (metadata.length > MAX_HEADER) return failNatalDayPacket();
  const numeric = new Uint8Array(COLUMNS * day.samples * 8);
  for (let i = 0; i < COLUMNS; i++) {
    const column = day.columns[i];
    if (!column || column.length !== day.samples) return failNatalDayPacket();
    for (let row = 0; row < day.samples; row++) if (!validNatalDayValue(column[row], i)) return failNatalDayPacket();
    if (shuffledColumns) {
      const prepared = shuffledColumns[i];
      if (!(prepared instanceof Uint8Array) || prepared.byteLength !== day.samples * 8) return failNatalDayPacket();
      copyShuffledColumn(numeric, prepared, i, day.samples);
    } else numeric.set(encodeFloat64Words(column, orders[i]), i * day.samples * 8);
  }
  const packet = new Uint8Array(8 + metadata.length + numeric.length);
  packet.set([70, 67, 68, 49]); // FCD1
  view(packet).setUint32(4, metadata.length, true);
  packet.set(metadata, 8); packet.set(shuffledColumns ? numeric : shuffle(numeric), 8 + metadata.length);
  return packet;
}
