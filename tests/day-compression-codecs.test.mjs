import test from 'node:test';
import assert from 'node:assert/strict';
import { compareColumns, decodeColumns } from './benchmarks/day-compression-codecs.mjs';

const bits = value => { const buffer = Buffer.alloc(8); buffer.writeDoubleLE(value); return buffer.readBigUInt64LE(); };
const fromBits = word => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64LE(word); return buffer.readDoubleLE(); };
const snapshot = columns => columns.map(column => Array.from(column, bits));

test('all lossless day candidates preserve IEEE words, including signs, subnormals and special values', () => {
  const values = [0, -0, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE,
    Infinity, -Infinity, NaN, fromBits(0x7ff8000000000042n), fromBits(0xfff8000000000012n),
    359.99999999999994, 0.000000000001, 90, 180, 270, 360, -88, 1 / 3];
  const columns = [values, new Float64Array([...values].reverse())], before = snapshot(columns);
  const result = compareColumns(columns, { iterations: 1, gzipLevels: [0, 6], brotliQualities: [4, 9, 11], includeBuffer: true });
  assert.equal(result.candidates.length, 84);
  assert.equal(result.columnCount, 2);
  assert.equal(result.rowCount, values.length);
  assert.equal(result.rawBytes, values.length * 2 * 8);
  assert.equal(result.rawPacketBytes, result.rawBytes + 16);
  for (const candidate of result.candidates) {
    assert.equal(candidate.roundtripCount, values.length * 2);
    assert.ok(candidate.bytes > 0);
    assert.ok(candidate.encodeMs >= 0);
    assert.ok(candidate.decodeMs >= 0);
  }
  assert.deepEqual(snapshot(columns), before, 'input is not mutated');
  assert.deepEqual(snapshot(decodeColumns(result.best.buffer, result.best.compression)), before);
});

test('integer predictors reconstruct bit-pattern trends and a discontinuous wrap exactly', () => {
  const columns = [
    Array.from({ length: 1440 }, (_, index) => fromBits(0x4060000000000000n + BigInt(index) * 70001n + BigInt(index * index) * 101n)),
    Array.from({ length: 1440 }, (_, index) => index < 720 ? 359 + index / 720 : (index - 720) / 720),
  ];
  const result = compareColumns(columns, { iterations: 1, brotliQualities: [4], includeBuffer: true });
  assert.deepEqual(snapshot(decodeColumns(result.best.buffer, result.best.compression)), snapshot(columns));
  assert.ok(result.best.bytes < result.rawBytes / 4, 'lossless predictors exploit this deliberately smooth synthetic corpus');
  assert.ok(result.candidates.some(candidate => candidate.transform === 'predict-2-shuffle'));
  assert.ok(result.candidates.some(candidate => candidate.transform === 'predict-4-varint'));
});

test('each predictor resets at a column boundary and supports columns shorter than its order', () => {
  for (const length of [0, 1, 2, 3, 4]) {
    const columns = [Array.from({ length }, (_, i) => 200 + i), Array.from({ length }, (_, i) => -10 - i)];
    const result = compareColumns(columns, { iterations: 1, gzipLevels: [], brotliQualities: [], includeBuffer: true });
    assert.equal(result.candidates.length, 14);
    assert.deepEqual(snapshot(decodeColumns(result.best.buffer, result.best.compression)), snapshot(columns));
  }
});

test('packet and size accounting include the transform shape header and compressor framing', () => {
  const columns = [[1, -0], [2, 3]];
  const result = compareColumns(columns, { iterations: 2, gzipLevels: [], brotliQualities: [], transforms: ['raw-columns'], includeBuffer: true });
  assert.equal(result.best.bytes, 16 + 4 * 8);
  assert.equal(result.best.ratio, 1);
  assert.equal(result.best.roundtripCount, 8);
  assert.equal(result.best.buffer.toString('ascii', 0, 4), 'FDAY');
  assert.deepEqual(snapshot(decodeColumns(result.best.buffer)), snapshot(columns));
  const withoutBuffer = compareColumns(columns, { iterations: 1, gzipLevels: [], brotliQualities: [], transforms: ['raw-columns'] });
  assert.ok(!Object.hasOwn(withoutBuffer.best, 'buffer'));
});

test('invalid inputs and malformed packets fail explicitly', () => {
  for (const columns of [[], [[1], [1, 2]], [[1, '2']], [[null]], ['bad']]) {
    assert.throws(() => compareColumns(columns, { iterations: 1 }));
  }
  for (const options of [{ iterations: 0 }, { iterations: 1.5 }, { gzipLevels: [10] }, { brotliQualities: [12] }, { transforms: ['unknown'] }, { transforms: [] }]) {
    assert.throws(() => compareColumns([[1]], options));
  }
  assert.throws(() => decodeColumns(Buffer.from('bad')), /header/);
  assert.throws(() => decodeColumns(Buffer.alloc(16), 'invalid'), /compression/);
  const { best } = compareColumns([[1, 2]], { iterations: 1, transforms: ['raw-columns'], gzipLevels: [], brotliQualities: [], includeBuffer: true });
  assert.throws(() => decodeColumns(best.buffer.subarray(0, -1)), /length/);
  const unknown = Buffer.from(best.buffer); unknown[5] = 99;
  assert.throws(() => decodeColumns(unknown), /transform/);
  const variable = compareColumns([[1, 2]], { iterations: 1, transforms: ['predict-1-varint'], gzipLevels: [], brotliQualities: [], includeBuffer: true }).best.buffer;
  assert.throws(() => decodeColumns(variable.subarray(0, -1)), /Truncated/);
  assert.throws(() => decodeColumns(Buffer.concat([variable, Buffer.from([0])])), /Trailing/);
});
