// Research-only codecs. Every predictor operates on the original IEEE-754
// words, modulo 2^64: no rounded float deltas, interpolation or quantization.
import { performance } from 'node:perf_hooks';
import { constants as bufferConstants } from 'node:buffer';
import { gzipSync, gunzipSync, brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';

const HEADER_BYTES = 16;
const MAGIC = 'FDAY';
const VERSION = 1;
const MASK = (1n << 64n) - 1n;
const COEFFICIENTS = [[], [1n], [2n, -1n], [3n, -3n, 1n], [4n, -6n, 4n, -1n]];

function byteLength(columnCount, rowCount) {
  const length = columnCount * rowCount * 8;
  if (!Number.isSafeInteger(length) || length > bufferConstants.MAX_LENGTH) throw new RangeError('Day payload is too large');
  return length;
}

function packColumns(columns) {
  if (!Array.isArray(columns) || !columns.length || columns.length > 0xffffffff) throw new TypeError('Expected nonempty column-major number arrays');
  const rowCount = columns[0]?.length;
  if (!Number.isInteger(rowCount) || rowCount < 0 || rowCount > 0xffffffff) throw new TypeError('Invalid column length');
  const shape = { columnCount: columns.length, rowCount };
  const raw = Buffer.allocUnsafe(byteLength(shape.columnCount, rowCount));
  let offset = 0;
  for (const column of columns) {
    if (!(Array.isArray(column) || column instanceof Float64Array) || column.length !== rowCount) throw new TypeError('Every column must have the same number of doubles');
    for (const value of column) {
      if (typeof value !== 'number') throw new TypeError('Every value must be a number');
      raw.writeDoubleLE(value, offset); offset += 8;
    }
  }
  return { raw, shape };
}

function unpackColumns(raw, { columnCount, rowCount }) {
  return Array.from({ length: columnCount }, (_, column) => Array.from({ length: rowCount }, (_, row) => raw.readDoubleLE((column * rowCount + row) * 8)));
}

// Byte planes are global, but the doubles remain column-major within a plane.
function shuffle(bytes, inverse = false) {
  const count = bytes.length / 8, output = Buffer.allocUnsafe(bytes.length);
  for (let byte = 0; byte < 8; byte++) for (let word = 0; word < count; word++) {
    const flat = word * 8 + byte, plane = byte * count + word;
    output[inverse ? flat : plane] = bytes[inverse ? plane : flat];
  }
  return output;
}

function xorPrevious(raw, { columnCount, rowCount }, inverse = false) {
  const output = Buffer.allocUnsafe(raw.length);
  for (let column = 0; column < columnCount; column++) {
    let previous = 0n;
    for (let row = 0; row < rowCount; row++) {
      const offset = (column * rowCount + row) * 8, value = raw.readBigUInt64LE(offset);
      const result = value ^ previous;
      output.writeBigUInt64LE(result, offset);
      previous = inverse ? result : value;
    }
  }
  return output;
}

// Orders 1..4 are first differences through fourth differences of integer bit
// patterns. The first `order` words in each column are stored literally.
function integerPredict(raw, { columnCount, rowCount }, order, inverse = false) {
  const output = Buffer.allocUnsafe(raw.length), coefficients = COEFFICIENTS[order];
  for (let column = 0; column < columnCount; column++) {
    const history = [];
    for (let row = 0; row < rowCount; row++) {
      const offset = (column * rowCount + row) * 8, value = raw.readBigUInt64LE(offset);
      const predicted = row < order ? 0n : coefficients.reduce((sum, coefficient, index) => sum + coefficient * history[index], 0n);
      const result = BigInt.asUintN(64, inverse ? value + predicted : value - predicted);
      output.writeBigUInt64LE(result, offset);
      history.unshift(inverse ? result : value);
      if (history.length > order) history.pop();
    }
  }
  return output;
}

// Optional small-residual packing, not a custom entropy compressor. Zigzag
// interprets each modular residual as a signed 64-bit integer reversibly.
function varints(raw) {
  const output = Buffer.allocUnsafe(raw.length / 8 * 10);
  let offset = 0;
  for (let word = 0; word < raw.length; word += 8) {
    const signed = raw.readBigInt64LE(word);
    let value = (signed << 1n) ^ (signed >> 63n);
    while (value >= 128n) { output[offset++] = Number(value & 127n) | 128; value >>= 7n; }
    output[offset++] = Number(value);
  }
  return output.subarray(0, offset);
}

function unvarints(bytes, length) {
  const output = Buffer.allocUnsafe(length);
  let offset = 0;
  for (let word = 0; word < length; word += 8) {
    let value = 0n, shift = 0n, complete = false;
    for (let index = 0; index < 10; index++) {
      if (offset >= bytes.length) throw new Error('Truncated integer stream');
      const byte = bytes[offset++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) { complete = true; break; }
      shift += 7n;
    }
    if (!complete || value > MASK) throw new Error('Invalid 64-bit integer stream');
    output.writeBigUInt64LE(BigInt.asUintN(64, (value >> 1n) ^ -(value & 1n)), word);
  }
  if (offset !== bytes.length) throw new Error('Trailing integer stream data');
  return output;
}

function zigzagWords(raw, inverse = false) {
  const output = Buffer.allocUnsafe(raw.length);
  for (let offset = 0; offset < raw.length; offset += 8) {
    const value = inverse ? raw.readBigUInt64LE(offset) : raw.readBigInt64LE(offset);
    const result = inverse ? BigInt.asUintN(64, (value >> 1n) ^ -(value & 1n)) : (value << 1n) ^ (value >> 63n);
    output.writeBigUInt64LE(result, offset);
  }
  return output;
}

// Five small trials per column, never a Cartesian search across all planets.
// The q4 score is only a heuristic; final bytes are measured after one shared
// compression pass. Its order table and search time are included in results.
function adaptivePredict(raw, { columnCount, rowCount }, zigzag = false) {
  const orders = Buffer.alloc(columnCount), predicted = Buffer.allocUnsafe(raw.length);
  const columnBytes = rowCount * 8, columnShape = { columnCount: 1, rowCount };
  for (let column = 0; column < columnCount; column++) {
    const input = raw.subarray(column * columnBytes, (column + 1) * columnBytes);
    let bestWords = null, bestBytes = Infinity;
    for (let order = 0; order <= 4; order++) {
      const residual = order ? integerPredict(input, columnShape, order) : input;
      const words = zigzag ? zigzagWords(residual) : residual;
      const bytes = brotliCompressSync(shuffle(words), { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } }).length;
      if (bytes < bestBytes) { bestBytes = bytes; bestWords = words; orders[column] = order; }
    }
    bestWords.copy(predicted, column * columnBytes);
  }
  return Buffer.concat([orders, shuffle(predicted)]);
}

function adaptiveRestore(payload, { columnCount, rowCount }, zigzag = false) {
  const length = byteLength(columnCount, rowCount);
  if (payload.length !== columnCount + length) throw new Error('Invalid adaptive payload length');
  const orders = payload.subarray(0, columnCount), predicted = shuffle(payload.subarray(columnCount), true);
  const output = Buffer.allocUnsafe(length), columnBytes = rowCount * 8, columnShape = { columnCount: 1, rowCount };
  for (let column = 0; column < columnCount; column++) {
    const order = orders[column];
    if (order > 4) throw new Error('Invalid adaptive predictor order');
    const words = predicted.subarray(column * columnBytes, (column + 1) * columnBytes);
    const residual = zigzag ? zigzagWords(words, true) : words;
    const original = order ? integerPredict(residual, columnShape, order, true) : residual;
    original.copy(output, column * columnBytes);
  }
  return output;
}

const TRANSFORMS = [
  { name: 'raw-columns', encode: raw => raw, decode: raw => raw },
  { name: 'byte-shuffle', encode: raw => shuffle(raw), decode: raw => shuffle(raw, true) },
  { name: 'xor-previous-shuffle', encode: (raw, shape) => shuffle(xorPrevious(raw, shape)), decode: (raw, shape) => xorPrevious(shuffle(raw, true), shape, true) },
  { name: 'delta-u64', encode: (raw, shape) => integerPredict(raw, shape, 1), decode: (raw, shape) => integerPredict(raw, shape, 1, true) },
  ...[1, 2, 3, 4].map(order => ({ name: `predict-${order}-shuffle`, encode: (raw, shape) => shuffle(integerPredict(raw, shape, order)), decode: (raw, shape) => integerPredict(shuffle(raw, true), shape, order, true) })),
  ...[1, 2, 3, 4].map(order => ({ name: `predict-${order}-varint`, variable: true, encode: (raw, shape) => varints(integerPredict(raw, shape, order)), decode: (raw, shape) => integerPredict(unvarints(raw, byteLength(shape.columnCount, shape.rowCount)), shape, order, true) })),
  ...[false, true].map(zigzag => ({ name: `adaptive-predict-${zigzag ? 'zigzag-' : ''}shuffle`, variable: true, encode: (raw, shape) => adaptivePredict(raw, shape, zigzag), decode: (raw, shape) => adaptiveRestore(raw, shape, zigzag) })),
];

function packet(raw, shape, transformIndex) {
  const transform = TRANSFORMS[transformIndex], payload = transform.encode(raw, shape);
  const header = Buffer.alloc(HEADER_BYTES);
  header.write(MAGIC); header[4] = VERSION; header[5] = transformIndex;
  header.writeUInt32LE(shape.columnCount, 8); header.writeUInt32LE(shape.rowCount, 12);
  return Buffer.concat([header, payload]);
}

function compressionMethod(name) {
  if (name === 'none') return { encode: bytes => bytes, decode: bytes => bytes };
  const [, method, rawLevel] = /^(gzip|brotli)-(\d+)$/.exec(name) || [];
  const level = Number(rawLevel);
  if (method === 'gzip' && level >= 0 && level <= 9) return { encode: bytes => gzipSync(bytes, { level }), decode: bytes => gunzipSync(bytes) };
  if (method === 'brotli' && level >= 0 && level <= 11) return {
    encode: bytes => brotliCompressSync(bytes, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: level, [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_GENERIC } }),
    decode: bytes => brotliDecompressSync(bytes),
  };
  throw new TypeError(`Unsupported compression: ${name}`);
}

function decodePacket(encoded, compression) {
  const bytes = compressionMethod(compression).decode(encoded);
  if (bytes.length < HEADER_BYTES || bytes.toString('ascii', 0, 4) !== MAGIC || bytes[4] !== VERSION) throw new Error('Invalid day packet header');
  const transform = TRANSFORMS[bytes[5]];
  if (!transform) throw new Error('Unknown day transform');
  const shape = { columnCount: bytes.readUInt32LE(8), rowCount: bytes.readUInt32LE(12) };
  const length = byteLength(shape.columnCount, shape.rowCount), payload = bytes.subarray(HEADER_BYTES);
  if (!shape.columnCount || !transform.variable && payload.length !== length) throw new Error('Invalid day payload length');
  const raw = transform.decode(payload, shape);
  if (raw.length !== length) throw new Error('Invalid decoded day length');
  return { raw, shape };
}

/** Decode a retained benchmark packet. `compression` is the candidate field. */
export function decodeColumns(encoded, compression = 'none') {
  const { raw, shape } = decodePacket(encoded, compression);
  return unpackColumns(raw, shape);
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Reproducible corpus comparison. All byte counts include the 16-byte shape/
 * transform header and compressor framing. Timings are median synchronous wall
 * times, NOT CPU or peak RAM. Packing input and bitwise verification are timed
 * separately/excluded; decode includes materializing the returned number[][] .
 * Only best.buffer is retained when includeBuffer=true; other packets are freed.
 */
export function compareColumns(columns, {
  iterations = 3, gzipLevels = [6], brotliQualities = [4, 9],
  includeBuffer = false, transforms = TRANSFORMS.map(transform => transform.name),
} = {}) {
  if (!Number.isInteger(iterations) || iterations < 1) throw new TypeError('iterations must be a positive integer');
  const packingStart = performance.now(), { raw, shape } = packColumns(columns), packingMs = performance.now() - packingStart;
  const compressions = ['none', ...gzipLevels.map(level => `gzip-${level}`), ...brotliQualities.map(quality => `brotli-${quality}`)];
  const candidates = [];
  let bestBuffer = null, best = null;
  for (const name of transforms) {
    const transformIndex = TRANSFORMS.findIndex(transform => transform.name === name);
    if (transformIndex === -1) throw new TypeError(`Unknown transform: ${name}`);
    for (const compression of compressions) {
      const compressor = compressionMethod(compression), encodeTimes = [], decodeTimes = [];
      let encoded;
      for (let iteration = 0; iteration < iterations; iteration++) {
        let start = performance.now();
        encoded = compressor.encode(packet(raw, shape, transformIndex));
        encodeTimes.push(performance.now() - start);
        start = performance.now();
        const decoded = decodePacket(encoded, compression);
        const reconstructed = unpackColumns(decoded.raw, decoded.shape);
        decodeTimes.push(performance.now() - start);
        // Check raw words AND the actual public numeric result, including -0,
        // subnormals and NaNs. Ordinary JS equality cannot establish this.
        if (decoded.shape.columnCount !== shape.columnCount || decoded.shape.rowCount !== shape.rowCount
          || !decoded.raw.equals(raw) || !packColumns(reconstructed).raw.equals(raw)) throw new Error(`Lossless verification failed: ${name}/${compression}`);
      }
      const candidate = {
        codec: `${name}/${compression}`, transform: name, compression, bytes: encoded.length,
        ratio: encoded.length / (raw.length + HEADER_BYTES),
        encodeMs: median(encodeTimes), decodeMs: median(decodeTimes),
        roundtripCount: shape.columnCount * shape.rowCount * iterations,
      };
      candidates.push(candidate);
      if (!best || candidate.bytes < best.bytes || candidate.bytes === best.bytes && candidate.encodeMs < best.encodeMs) {
        best = candidate;
        if (includeBuffer) bestBuffer = Buffer.from(encoded);
      }
    }
  }
  if (!best) throw new TypeError('At least one transform is required');
  return {
    ...shape, valueCount: shape.columnCount * shape.rowCount, rawBytes: raw.length,
    rawPacketBytes: raw.length + HEADER_BYTES, iterations, packingMs,
    timingScope: 'Median transform + compression; decode includes inverse transform + numeric arrays. Input packing and roundtrip verification excluded.',
    candidates: candidates.sort((a, b) => a.bytes - b.bytes || a.encodeMs - b.encodeMs),
    best: { ...best, ...(includeBuffer ? { buffer: bestBuffer } : {}) },
  };
}
