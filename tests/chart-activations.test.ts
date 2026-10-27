import test from 'node:test';
import assert from 'node:assert/strict';
import type { Activation } from '../shared/chart-types.ts';
import { validateChartSide } from '../shared/chart-activations.ts';
import { validCycleResult } from '../shared/cycles-format.ts';

function entries(): Activation[] {
  return ['sun', 'earth', 'moon', 'north_node', 'south_node', 'mercury', 'venus',
    'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'].map((planet, index) => ({
      planet, longitude: index * 20, gate: index % 2 ? 64 : 1, line: index % 2 ? 6 : 1,
    }));
}

test('a side accepts reordered complete details and repeated activated gates without changing input', () => {
  const activations = Object.freeze(entries().reverse().map(value => Object.freeze(value)));
  const gates = Object.freeze([64, 1]);
  assert.equal(validateChartSide(gates, activations), null);
  assert.equal(validateChartSide([1, 64], [...activations].reverse(), 13), null);
  assert.equal(activations[0].planet, 'pluto');
  assert.deepEqual(gates, [64, 1]);
});

test('the empty legacy side is valid only when the caller selects zero entries', () => {
  assert.equal(validateChartSide([], [], 0), null);
  assert.equal(validateChartSide([], [], 13), 'activations');
  assert.equal(validateChartSide([1, 64], entries(), 0), 'activations');
  assert.equal(validateChartSide([1], [], 0), 'gates');
});

test('missing, duplicate and unknown planets cannot make up a complete side', () => {
  const complete = entries();
  for (const value of [null, {}, [], complete.slice(1), [...complete, complete[0]],
    complete.map((entry, index) => index ? entry : {...entry, planet: 'pluto'}),
    complete.map((entry, index) => index ? entry : {...entry, planet: 'chiron'}),
    complete.map((entry, index) => index ? entry : null), new Array(13)]) {
    assert.equal(validateChartSide([1, 64], value), 'activations');
  }
});

test('activation numbers must be finite and within their existing integer and angle ranges', () => {
  const invalid = [
    {longitude: -0.001}, {longitude: 360}, {longitude: NaN}, {longitude: Infinity}, {longitude: '0'},
    {gate: 0}, {gate: 65}, {gate: 1.5}, {gate: NaN}, {gate: Infinity}, {gate: '1'},
    {line: 0}, {line: 7}, {line: 1.5}, {line: NaN}, {line: Infinity}, {line: '1'},
  ];
  for (const change of invalid) {
    const complete = entries();
    assert.equal(validateChartSide([1, 64], [{...complete[0], ...change}, ...complete.slice(1)]), 'activations');
  }
  const complete = entries();
  complete[0].longitude = 359.999999;
  assert.equal(validateChartSide([1, 64], complete), null);
});

test('gate lists must equal the activation set without duplicates, omissions or extra values', () => {
  for (const gates of [null, {}, [], [1], [64], [1, 1], [1, 64, 64], [1, 64, 2], [1, '64'], [1, NaN], [1, Infinity], new Array(2)]) {
    assert.equal(validateChartSide(gates, entries()), 'gates');
  }
  assert.equal(validateChartSide(null, null), 'activations', 'invalid details have a separate, first error');
});

test('return chart admission uses the full side contract for both personality and design', () => {
  const input = {birthUtc: '2000-01-01T00:00:00Z', body: 'saturn', eventUtc: '2028-01-01T00:00:00Z'};
  const chart = {source: 'calculated', utc: input.eventUtc, timezone: 'UTC', designArcResidualDegrees: 0,
    personality: [64, 1], design: [1, 64], activations: {personality: entries(), design: entries().reverse()}};
  assert.equal(validCycleResult('chart', {chart}, input), true);
  for (const side of ['personality', 'design'] as const) {
    assert.equal(validCycleResult('chart', {chart: {...chart, [side]: [1]}}, input), false);
    assert.equal(validCycleResult('chart', {chart: {...chart, activations: {...chart.activations, [side]: []}}}, input), false);
  }
});
