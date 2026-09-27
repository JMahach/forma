import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GATE_ORDER, GATE_LONGITUDE_START, GATE_WIDTH, LINE_WIDTH,
  normalizeLongitude, gatePositionAtLongitude,
} from '../src/domain/gate-wheel.js';

const calculator = readFileSync(new URL('../server/python/astronomy.py', import.meta.url), 'utf8');
const serverOrder = JSON.parse(calculator.match(/^GATE_WHEEL = (\[[^\n]+\])/m)[1]);
const serverStart = Number(calculator.match(/position = \(lon - ([\d.]+)\) % 360/)[1]);
const serverGateWidth = Number(calculator.match(/index = int\(position \/ ([\d.]+)\)/)[1]);
const serverLineWidth = Number(calculator.match(/line = min\(6, int\(\(position - index \* [\d.]+\) \/ ([\d.]+)\)/)[1]);
const finiteCanonical = value => {
  const remainder = value % 360;
  return remainder < 0 ? remainder + 360 : remainder === 0 ? 0 : remainder;
};

test('the domain wheel has exactly the immutable calculator order and equal gate and line widths', () => {
  assert.deepEqual(GATE_ORDER, serverOrder);
  assert.deepEqual([...GATE_ORDER].sort((a, b) => a - b), Array.from({ length: 64 }, (_, i) => i + 1));
  assert.ok(Object.isFrozen(GATE_ORDER));
  assert.throws(() => { GATE_ORDER[0] = 1; }, TypeError);
  assert.throws(() => GATE_ORDER.push(65), TypeError);
  assert.equal(GATE_LONGITUDE_START, serverStart);
  assert.equal(GATE_LONGITUDE_START, 302);
  assert.equal(GATE_WIDTH, serverGateWidth);
  assert.equal(GATE_WIDTH, 360 / 64);
  assert.equal(LINE_WIDTH, serverLineWidth);
  assert.equal(LINE_WIDTH, GATE_WIDTH / 6);
});

test('known positions produce only normalized longitude, gate and line without presentation data', () => {
  for (const [longitude, gate, line] of [[0, 25, 2], [180, 46, 2], [302, 41, 1], [307.625, 19, 1], [301.5, 60, 6]]) {
    assert.deepEqual(gatePositionAtLongitude(longitude), { longitude, gate, line });
  }
});

test('all 64 gates contain six complete line intervals with stable interior values', () => {
  for (let index = 0; index < serverOrder.length; index++) {
    for (let line = 0; line < 6; line++) {
      for (const fraction of [.125, .5, .875]) {
        const raw = serverStart + index * serverGateWidth + (line + fraction) * serverLineWidth;
        assert.deepEqual(gatePositionAtLongitude(raw), {
          longitude: finiteCanonical(raw), gate: serverOrder[index], line: line + 1,
        });
      }
    }
  }
});

test('every exact gate and line boundary is half-open, with no epsilon snapping on either side', () => {
  // Exact binary fractions keep the distinction after subtraction and wrapping.
  // This is deliberately much smaller than a visible subdivision or 1e-8.
  const epsilon = 2 ** -35;
  for (let index = 0; index < serverOrder.length; index++) {
    for (let line = 0; line < 6; line++) {
      const boundary = serverStart + index * serverGateWidth + line * serverLineWidth;
      for (const turns of [-2, 0, 3]) {
        const value = boundary + turns * 360;
        const current = gatePositionAtLongitude(value);
        const before = gatePositionAtLongitude(value - epsilon);
        const after = gatePositionAtLongitude(value + epsilon);
        assert.deepEqual(current, { longitude: finiteCanonical(value), gate: serverOrder[index], line: line + 1 });
        assert.deepEqual(after, { longitude: finiteCanonical(value + epsilon), gate: serverOrder[index], line: line + 1 });
        assert.deepEqual(before, {
          longitude: finiteCanonical(value - epsilon),
          gate: serverOrder[(index + (line === 0 ? 63 : 0)) % 64],
          line: line === 0 ? 6 : line,
        });
        assert.notEqual(before.longitude, current.longitude, 'the exact cursor position is never rounded onto the boundary');
        assert.notEqual(after.longitude, current.longitude);
      }
    }
  }
});

test('longitude normalization and positions are periodic across positive and negative full turns', () => {
  for (const longitude of [0, .125, 88, 180, 301.99998474121094, 302, 359.99998474121094]) {
    const expected = gatePositionAtLongitude(longitude);
    for (const turns of [-100, -3, -1, 0, 1, 3, 100]) {
      const raw = longitude + turns * 360;
      assert.equal(normalizeLongitude(raw), longitude);
      assert.deepEqual(gatePositionAtLongitude(raw), expected);
    }
  }
  assert.deepEqual(gatePositionAtLongitude(360), gatePositionAtLongitude(0));
  assert.deepEqual(gatePositionAtLongitude(-360), gatePositionAtLongitude(0));
});

test('negative zero and negative subnormal inputs never escape as -0, 360 or an undefined gate', () => {
  const zero = gatePositionAtLongitude(0);
  for (const value of [-0, -360, -720, -Number.MIN_VALUE, -Number.MIN_VALUE * 8, -Number.EPSILON]) {
    const normalized = normalizeLongitude(value);
    assert.equal(normalized, 0);
    assert.equal(Object.is(normalized, -0), false);
    assert.deepEqual(gatePositionAtLongitude(value), zero);
  }
  for (const value of [Number.MIN_VALUE, Number.MIN_VALUE * 8, Number.EPSILON]) {
    assert.equal(normalizeLongitude(value), value, 'small positive longitudes retain their actual value');
    assert.deepEqual(gatePositionAtLongitude(value), { ...zero, longitude: value });
  }
});

test('extreme finite inputs normalize into a valid, idempotent finite position without presentation rounding', () => {
  for (const value of [Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 1e100, -1e100, -0.1, 360 - 2 ** -35]) {
    const longitude = normalizeLongitude(value);
    assert.ok(Number.isFinite(longitude) && longitude >= 0 && longitude < 360);
    assert.equal(normalizeLongitude(longitude), longitude);
    assert.equal(Object.is(longitude, -0), false);
    const position = gatePositionAtLongitude(value);
    assert.equal(position.longitude, longitude);
    assert.ok(Number.isInteger(position.gate) && position.gate >= 1 && position.gate <= 64);
    assert.ok(Number.isInteger(position.line) && position.line >= 1 && position.line <= 6);
    assert.deepEqual(gatePositionAtLongitude(longitude), position);
  }
});

test('the position function rejects nonnumeric and nonfinite input rather than coercing chart data', () => {
  for (const value of [undefined, null, NaN, Infinity, -Infinity, '180', '', true, false, {}, [], [180], new Number(180), 180n, Symbol('longitude')]) {
    assert.throws(() => gatePositionAtLongitude(value), TypeError);
  }
  const coercible = { valueOf() { assert.fail('invalid chart data must not be coerced'); } };
  assert.throws(() => gatePositionAtLongitude(coercible), TypeError);
});

test('position results are independent values and cannot retain a callers altered gate or line', () => {
  const first = gatePositionAtLongitude(180);
  const second = gatePositionAtLongitude(180);
  assert.notEqual(first, second);
  if (!Object.isFrozen(first)) {
    first.gate = 1;
    first.line = 6;
    first.longitude = 0;
  }
  assert.deepEqual(gatePositionAtLongitude(180), { longitude: 180, gate: 46, line: 2 });
  assert.deepEqual(second, { longitude: 180, gate: 46, line: 2 });
});
