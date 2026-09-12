import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { activationDetails } from '../src/activations/activation-details.js';

const values = rows => rows.map(row => row.value);
const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should be close to ${expected}`);
const entryAt = (longitude, gate = 41, line = 1) => ({ planet: 'sun', longitude, gate, line });

test('missing or malformed saved activation data has no invented details', () => {
  for (const entry of [undefined, null, {}, [], { gate: 41, line: 1 },
    ...[undefined, null, '', '302', NaN, Infinity, -Infinity, true].map(longitude => entryAt(longitude)),
    ...[undefined, null, '41', 0, 65, 1.5, NaN].map(gate => ({ ...entryAt(302), gate })),
    ...[undefined, null, '1', 0, 7, 1.5, NaN].map(line => ({ ...entryAt(302), line }))]) {
    assert.equal(activationDetails(entry), null);
  }
  assert.equal(activationDetails(entryAt(302, 41, 2)), null, 'a saved line inconsistent with longitude is unavailable');
});

test('first subdivision has five ordered rows with zero progress', () => {
  const entry = Object.freeze(entryAt(302));
  assert.deepEqual(activationDetails(entry), [
    { key: 'gate', label: 'Ворота', value: 41, percent: 0 },
    { key: 'line', label: 'Линия', value: 1, percent: 0 },
    { key: 'color', label: 'Цвет', value: 1, percent: 0 },
    { key: 'tone', label: 'Тон', value: 1, percent: 0 },
    { key: 'base', label: 'База', value: 1, percent: 0 }
  ]);
});

test('last subdivisions keep their own progress immediately before the next gate', () => {
  const rows = activationDetails(entryAt(307.625 - 1e-8, 41, 6));
  assert.deepEqual(values(rows), [41, 6, 6, 6, 5]);
  for (const row of rows) assert.ok(row.percent > 99.99 && row.percent < 100);
  assert.deepEqual(values(activationDetails(entryAt(307.625, 19, 1))), [19, 1, 1, 1, 1]);
});

test('14.6 with color 2, tone 3 and base 3 keeps independent unrounded progress', () => {
  // Gate 14 begins at longitude 234.5 in the existing calculator wheel.
  // This point is halfway through base 3 of tone 3, color 2, line 6.
  const longitude = 234.5 + 5 * 0.9375 + 0.15625 + 2 * (5 / 192) + 2.5 / 192;
  const rows = activationDetails(entryAt(longitude, 14, 6));
  assert.deepEqual(values(rows), [14, 6, 2, 3, 3]);
  for (const [index, expected] of [
    [0, (5 + 1.4166666666666667 / 6) / 6 * 100],
    [1, 1.4166666666666667 / 6 * 100], [2, 2.5 / 6 * 100], [3, 50], [4, 50]
  ]) close(rows[index].percent, expected);
});

test('all line, color, tone and base boundaries start the next child', () => {
  for (let line = 1; line <= 6; line++) {
    for (let color = 1; color <= 6; color++) {
      for (let tone = 1; tone <= 6; tone++) {
        for (let base = 1; base <= 5; base++) {
          const longitude = 302 + (line - 1) * 0.9375 + (color - 1) * 0.15625 + (tone - 1) * (5 / 192) + (base - 1) / 192;
          const rows = activationDetails(entryAt(longitude, 41, line));
          assert.deepEqual(values(rows), [41, line, color, tone, base], `boundary ${line}.${color}.${tone}.${base}`);
          close(rows[4].percent, 0);
          const after = activationDetails(entryAt(longitude + 1e-8, 41, line));
          assert.deepEqual(values(after), [41, line, color, tone, base]);
          assert.ok(after[4].percent > 0);
          if (base > 1) {
            const before = activationDetails(entryAt(longitude - 1e-8, 41, line));
            assert.deepEqual(values(before), [41, line, color, tone, base - 1]);
            assert.ok(before[4].percent > 99.99);
          }
        }
      }
    }
  }
});

test('a percentage that displays as 100 does not advance a subdivision', () => {
  const rows = activationDetails(entryAt(302 + 0.9375 - 1e-7, 41, 1));
  assert.equal(rows[1].percent.toFixed(2), '100.00');
  assert.deepEqual(values(rows), [41, 1, 6, 6, 5]);
});

test('crossing a boundary resets all children and preserves the preceding subdivision', () => {
  for (const [offset, beforeValues, afterValues] of [
    [0.9375, [41, 1, 6, 6, 5], [41, 2, 1, 1, 1]],
    [0.15625, [41, 1, 1, 6, 5], [41, 1, 2, 1, 1]],
    [5 / 192, [41, 1, 1, 1, 5], [41, 1, 1, 2, 1]],
    [1 / 192, [41, 1, 1, 1, 1], [41, 1, 1, 1, 2]]
  ]) {
    const before = activationDetails(entryAt(302 + offset - 1e-8, 41, beforeValues[1]));
    const after = activationDetails(entryAt(302 + offset + 1e-8, 41, afterValues[1]));
    assert.deepEqual(values(before), beforeValues);
    assert.deepEqual(values(after), afterValues);
    assert.ok(before[4].percent > 99.99);
    assert.ok(after[4].percent < 0.01);
  }
});

test('equivalent wrapped longitudes preserve every subdivision and progress', () => {
  for (const entry of [entryAt(0, 25, 2), entryAt(12.345, 21, 4), entryAt(302), entryAt(359.99999, 25, 2)]) {
    const expected = activationDetails(entry);
    assert.ok(expected);
    for (const turns of [-5, -1, 1, 5]) {
      const actual = activationDetails({ ...entry, longitude: entry.longitude + turns * 360 });
      assert.deepEqual(values(actual), values(expected));
      actual.forEach((row, index) => close(row.percent, expected[index].percent));
    }
  }
  assert.deepEqual(values(activationDetails(entryAt(302 - 1e-8, 60, 6))), [60, 6, 6, 6, 5]);
});

test('saved gates are retained without a second gate wheel', () => {
  const rows = activationDetails(entryAt(302, 14, 1));
  assert.equal(rows[0].value, 14);
});

const python = fileURLToPath(new URL('../.venv/bin/python', import.meta.url));
test('real calculator planetary positions retain gate and line across historical and current dates', {
  skip: !existsSync(python) && 'Prepared calculator environment is not installed'
}, () => {
  const entries = JSON.parse(execFileSync(python, ['-B', '-c', `
import datetime as dt
import json
from server import calculator as calc
entries = []
for date in ['1900-01-01T00:00:00+00:00', '1990-06-15T10:30:00+00:00', '2026-09-12T12:00:00+00:00']:
    jd = calc.julian_tt(dt.datetime.fromisoformat(date))
    entries.extend(calc.activations(jd))
    entries.extend(calc.activations(calc.design_time(jd)[0]))
print(json.dumps(entries))
`], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }));
  assert.equal(entries.length, 78);
  for (const entry of entries) {
    const rows = activationDetails(entry);
    assert.ok(rows, `details should accept calculator activation ${JSON.stringify(entry)}`);
    assert.equal(rows[0].value, entry.gate);
    assert.equal(rows[1].value, entry.line);
    for (const [index, maximum] of [[2, 6], [3, 6], [4, 5]]) {
      assert.ok(Number.isInteger(rows[index].value) && rows[index].value >= 1 && rows[index].value <= maximum);
    }
    for (const row of rows) assert.ok(Number.isFinite(row.percent) && row.percent >= 0 && row.percent <= 100);
  }
});
