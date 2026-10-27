import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePredictedDay } from '../server/packets/compression.ts';
import { encodeTransitDay, encodeNumericColumn, encodeNatalDay, encodeNatalDayColumn } from '../server/packets/encode.ts';
import { decodeTransitDay, decodeNatalDay } from '../shared/day-packets/decode.ts';
import { natalDayFixture } from './fixtures/natal-day.ts';

const bits = (values: ArrayLike<number>) => Buffer.from(new Float64Array(values).buffer).toString('hex');
const examples = [
  { name: 'transit', day: natalDayFixture(), encode: encodeTransitDay, column: encodeNumericColumn, decode: decodeTransitDay },
  { name: 'short natal', day: natalDayFixture({ samples: 3 }), encode: encodeNatalDay, column: encodeNatalDayColumn, decode: decodeNatalDay },
  { name: 'historical natal', day: natalDayFixture({ date: '1900-01-01', timezone: 'Europe/Paris', segments: [
    { index: 0, startUtc: '1899-12-31T23:50:39Z', utcOffset: 'UTC+00:09:21', offsetSeconds: 561, fold: 0 },
  ] }), encode: encodeNatalDay, column: encodeNatalDayColumn, decode: decodeNatalDay },
  { name: 'fold natal', day: natalDayFixture({ date: '2024-11-03', timezone: 'America/New_York', samples: 1500, segments: [
    { index: 0, startUtc: '2024-11-03T04:00:00Z', utcOffset: 'UTC−04:00', offsetSeconds: -14400, fold: 0 },
    { index: 120, startUtc: '2024-11-03T06:00:00Z', utcOffset: 'UTC−05:00', offsetSeconds: -18000, fold: 1 },
    { index: 180, startUtc: '2024-11-03T07:00:00Z', utcOffset: 'UTC−05:00', offsetSeconds: -18000, fold: 0 },
  ] }), encode: encodeNatalDay, column: encodeNatalDayColumn, decode: decodeNatalDay },
];

for (const example of examples) test(`${example.name}: chosen columns are assembled without encoding them a sixth time`, async () => {
  const original = example.day;
  original.columns[0]!.set([-0, Number.MIN_VALUE, 359.99999999999994]);
  const before = original.columns.map(bits);
  let assembling = false, finalReads = 0, encodings = 0;
  const day = { ...original, columns: original.columns.map(values => new Proxy(values, {
    get(target, key) {
      if (assembling && typeof key === 'string' && /^\d+$/.test(key)) finalReads++;
      return Reflect.get(target, key, target);
    },
  })) };
  const packet = await encodePredictedDay(day, (column, order) => {
    encodings++; return example.column(column, order);
  }, (value, options) => {
    assembling = true;
    try { return example.encode(value, options); } finally { assembling = false; }
  });
  assert.equal(encodings, 24 * 5, 'all five candidates are still evaluated for every column');
  assert.equal(finalReads, 24 * day.samples, 'final assembly reads each value for validation, without another numeric encoding pass');
  const decoded = example.decode(packet);
  assert.deepEqual(packet, Buffer.from(example.encode(original, { orders: decoded.orders })), 'prepared and standalone paths produce identical packet bytes');
  assert.deepEqual(decoded.columns.map(bits), before, 'all IEEE bits survive, including negative zero and subnormal values');
  assert.deepEqual(original.columns.map(bits), before, 'input columns remain untouched');
});

for (const example of examples.slice(0, 2)) {
  test(`${example.name}: prepared byte planes match every predictor and mixed orders`, () => {
    const day = example.day;
    for (const order of [0, 1, 2, 3, 4, 'mixed']) {
      const orders = day.columns.map((_, i) => order === 'mixed' ? i % 5 : order as number);
      const shuffledColumns = day.columns.map((column, i) => {
        const encoded = example.column(column, orders[i]!);
        const backing = new Uint8Array(encoded.length + 13).fill(173);
        backing.set(encoded, 5);
        return backing.subarray(5, 5 + encoded.length);
      });
      const before = shuffledColumns.map(column => Buffer.from(column));
      const packet = example.encode(day, { orders, shuffledColumns: Object.freeze(shuffledColumns) });
      assert.deepEqual(packet, example.encode(day, { orders }), `order ${order}`);
      assert.deepEqual(shuffledColumns.map(column => Buffer.from(column)), before, 'prepared buffers remain untouched');
      for (const column of shuffledColumns) {
        const backing = new Uint8Array(column.buffer);
        assert.ok(backing.subarray(0, 5).every(byte => byte === 173));
        assert.ok(backing.subarray(column.byteOffset + column.byteLength).every(byte => byte === 173));
      }
    }
  });

  test(`${example.name}: prepared columns retain metadata and numeric validation`, () => {
    const day = example.day, orders = day.columns.map((_, i) => i % 5);
    const shuffledColumns = day.columns.map((column, i) => example.column(column, orders[i]!));
    const options = { orders, shuffledColumns };
    const invalidColumns = day.columns.map(column => column.slice());
    invalidColumns[0]![0] = 360;
    assert.throws(() => example.encode({ ...day, columns: invalidColumns }, options));
    assert.throws(() => example.encode({ ...day, stepSeconds: 30 }, options));
    assert.throws(() => example.encode(day, { ...options, orders: [5, ...orders.slice(1)] }));
    assert.throws(() => example.encode({ ...day, columns: day.columns.slice(1) }, options));
    assert.throws(() => example.encode({ ...day, columns: [new Float64Array(1), ...day.columns.slice(1)] }, options));
    assert.throws(() => example.encode(day, { ...options, shuffledColumns: shuffledColumns.slice(1) }));
    assert.throws(() => example.encode(day, { ...options, shuffledColumns: [new Uint8Array(1), ...shuffledColumns.slice(1)] }));
  });
}
