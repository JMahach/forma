import { byteView as view, validOrder, encodeFloat64Words, shuffle } from '../../shared/day-packets/float64-codec.js';
import { TRANSIT_DAY_VERSION, TRANSIT_PLANETS, TRANSIT_SAMPLES as MINUTES, TRANSIT_PAYLOAD_BYTES as PAYLOAD_BYTES,
  TRANSIT_MAX_HEADER_BYTES as MAX_HEADER_BYTES, validateTransitMetadata, validTransitValue, failTransitPacket } from '../../shared/day-packets/transit-format.js';
import { CHART_DAY_VERSION, CHART_DAY_COLUMNS as COLUMNS, CHART_DAY_MAX_SAMPLES as MAX_SAMPLES,
  CHART_DAY_MAX_HEADER_BYTES as MAX_HEADER, validateChartDayMetadata, validChartDayValue, failChartDayPacket } from '../../shared/day-packets/natal-format.js';

const encoder = new TextEncoder();
function transitWords(values, order) {
  if (!validOrder(order) || !values || values.length !== MINUTES) return failTransitPacket();
  for (let row = 0; row < values.length; row++) if (!validTransitValue(values[row])) return failTransitPacket();
  return encodeFloat64Words(values, order);
}
function chartWords(values, order) {
  if (!validOrder(order) || !values || !Number.isInteger(values.length) || values.length < 1 || values.length > MAX_SAMPLES) return failChartDayPacket();
  for (let row = 0; row < values.length; row++) if (!Number.isFinite(values[row])) return failChartDayPacket();
  return encodeFloat64Words(values, order);
}
export const encodeNumericColumn = (values, order) => shuffle(transitWords(values, order));
export const encodeChartDayColumn = (values, order) => shuffle(chartWords(values, order));

export function encodeTransitDay(day, { orders = TRANSIT_PLANETS.map(() => 3) } = {}) {
  const header = validateTransitMetadata({ version: TRANSIT_DAY_VERSION, date: day.date, startUtc: day.startUtc,
    samples: day.samples, stepSeconds: day.stepSeconds, orders: [...orders], engine: day.engine,
    ephemeris: day.ephemeris, timezoneDatabase: day.timezoneDatabase, nodeModel: day.nodeModel, zodiac: day.zodiac });
  if (!Array.isArray(day.columns) || day.columns.length !== TRANSIT_PLANETS.length) return failTransitPacket();
  const metadata = encoder.encode(JSON.stringify(header));
  if (metadata.length > MAX_HEADER_BYTES) return failTransitPacket();
  const numeric = new Uint8Array(PAYLOAD_BYTES);
  day.columns.forEach((column, i) => numeric.set(transitWords(column, orders[i]), i * MINUTES * 8));
  const packet = new Uint8Array(8 + metadata.length + PAYLOAD_BYTES);
  packet.set([70, 84, 68, 49]); // FTD1
  view(packet).setUint32(4, metadata.length, true);
  packet.set(metadata, 8);
  packet.set(shuffle(numeric), 8 + metadata.length);
  return packet;
}

export function encodeChartDay(day, { orders = Array(COLUMNS).fill(3) } = {}) {
  const header = validateChartDayMetadata({ version: CHART_DAY_VERSION, date: day.date, timezone: day.timezone, startUtc: day.startUtc,
    samples: day.samples, stepSeconds: day.stepSeconds, segments: day.segments, orders: [...orders],
    engine: day.engine, ephemeris: day.ephemeris, timezoneDatabase: day.timezoneDatabase, nodeModel: day.nodeModel, zodiac: day.zodiac });
  if (!Array.isArray(day.columns) || day.columns.length !== COLUMNS) return failChartDayPacket();
  const metadata = encoder.encode(JSON.stringify(header));
  if (metadata.length > MAX_HEADER) return failChartDayPacket();
  const numeric = new Uint8Array(COLUMNS * day.samples * 8);
  day.columns.forEach((column, i) => {
    if (column.length !== day.samples || !column.every(value => validChartDayValue(value, i))) return failChartDayPacket();
    numeric.set(chartWords(column, orders[i]), i * day.samples * 8);
  });
  const packet = new Uint8Array(8 + metadata.length + numeric.length);
  packet.set([70, 67, 68, 49]); // FCD1
  view(packet).setUint32(4, metadata.length, true);
  packet.set(metadata, 8); packet.set(shuffle(numeric), 8 + metadata.length);
  return packet;
}
