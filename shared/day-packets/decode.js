import { byteView as view, shuffle, decodeFloat64Column } from './float64-codec.js';
import { TRANSIT_SAMPLES as MINUTES, TRANSIT_PAYLOAD_BYTES as PAYLOAD_BYTES, TRANSIT_MAX_HEADER_BYTES as MAX_HEADER_BYTES,
  validateTransitMetadata, validTransitValue, failTransitPacket } from './transit-format.js';
import { NATAL_DAY_COLUMNS as COLUMNS, NATAL_DAY_MAX_SAMPLES as MAX_SAMPLES, NATAL_DAY_MAX_HEADER_BYTES as MAX_HEADER,
  validateNatalDayMetadata, validNatalDayValue, failNatalDayPacket } from './natal-format.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
// HTTP decompresses before decoding. Bound lengths before reading metadata or
// allocating Float64 arrays; the two formats retain their own validation rules.
export function decodeTransitDay(input) {
  const packet = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : failTransitPacket();
  if (packet.length < 8 + PAYLOAD_BYTES || packet.length > 8 + MAX_HEADER_BYTES + PAYLOAD_BYTES
    || packet[0] !== 70 || packet[1] !== 84 || packet[2] !== 68 || packet[3] !== 49) return failTransitPacket();
  const length = view(packet).getUint32(4, true);
  if (!length || length > MAX_HEADER_BYTES || packet.length !== 8 + length + PAYLOAD_BYTES) return failTransitPacket();
  let metadata;
  try { metadata = validateTransitMetadata(JSON.parse(decoder.decode(packet.subarray(8, 8 + length)))); }
  catch { return failTransitPacket(); }
  const words = view(shuffle(packet.subarray(8 + length), true));
  const columns = metadata.orders.map((order, column) => {
    const values = decodeFloat64Column(words, column, MINUTES, order);
    if (!values.every(value => validTransitValue(value, column))) return failTransitPacket();
    return values;
  });
  return { ...metadata, columns };
}

export function decodeNatalDay(input) {
  const packet = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : failNatalDayPacket();
  if (packet.length < 8 + COLUMNS * 8 || packet.length > 8 + MAX_HEADER + MAX_SAMPLES * COLUMNS * 8
    || packet[0] !== 70 || packet[1] !== 67 || packet[2] !== 68 || packet[3] !== 49) return failNatalDayPacket();
  const length = view(packet).getUint32(4, true);
  if (!length || length > MAX_HEADER || length + 8 > packet.length) return failNatalDayPacket();
  let metadata;
  try { metadata = validateNatalDayMetadata(JSON.parse(decoder.decode(packet.subarray(8, 8 + length)))); }
  catch { return failNatalDayPacket(); }
  if (packet.length !== 8 + length + COLUMNS * metadata.samples * 8) return failNatalDayPacket();
  const words = view(shuffle(packet.subarray(8 + length), true));
  const columns = metadata.orders.map((order, column) => {
    const values = decodeFloat64Column(words, column, metadata.samples, order);
    if (!values.every(value => validNatalDayValue(value, column))) return failNatalDayPacket();
    return values;
  });
  return { ...metadata, columns };
}
