// Bit-preserving Float64 prediction, zigzag and byte planes shared by FTD1/FCD1.
// Format owners validate shapes, predictor orders and numeric ranges before use.
const COEFFICIENTS = [[], [1n], [2n, -1n], [3n, -3n, 1n], [4n, -6n, 4n, -1n]];
export const validOrder = order => Number.isInteger(order) && order >= 0 && order <= 4;
export const byteView = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const predicted = (history, row, order) => row < order ? 0n : COEFFICIENTS[order].reduce((sum, coefficient, i) => sum + coefficient * history[i], 0n);
function remember(history, bits, order) { history.unshift(bits); if (history.length > order) history.pop(); }

export function shuffle(bytes, inverse = false) {
  const count = bytes.byteLength / 8, out = new Uint8Array(bytes.byteLength);
  for (let byte = 0; byte < 8; byte++) for (let word = 0; word < count; word++) {
    const flat = word * 8 + byte, plane = byte * count + word;
    out[inverse ? flat : plane] = bytes[inverse ? plane : flat];
  }
  return out;
}

export function encodeFloat64Words(values, order) {
  const bytes = new Uint8Array(values.length * 8), data = byteView(bytes), scratch = new DataView(new ArrayBuffer(8)), history = [];
  for (let row = 0; row < values.length; row++) {
    scratch.setFloat64(0, values[row], true);
    const bits = scratch.getBigUint64(0, true);
    const delta = BigInt.asIntN(64, bits - predicted(history, row, order));
    data.setBigUint64(row * 8, (delta << 1n) ^ (delta >> 63n), true);
    remember(history, bits, order);
  }
  return bytes;
}

export function decodeFloat64Column(words, column, samples, order) {
  const values = new Float64Array(samples), scratch = new DataView(new ArrayBuffer(8)), history = [];
  for (let row = 0; row < samples; row++) {
    const coded = words.getBigUint64((column * samples + row) * 8, true);
    const bits = BigInt.asUintN(64, ((coded >> 1n) ^ -(coded & 1n)) + predicted(history, row, order));
    scratch.setBigUint64(0, bits, true);
    values[row] = scratch.getFloat64(0, true);
    remember(history, bits, order);
  }
  return values;
}
