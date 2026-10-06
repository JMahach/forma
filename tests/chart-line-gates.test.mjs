import test from 'node:test';
import assert from 'node:assert/strict';
import { chartLineGates, buildChartFacts } from '../src/domain/chart-facts.js';
import { createChartComposition } from '../src/domain/chart-composition.js';

const chart = { source: 'calculated', personality: [8, 29], design: [8, 29, 46], activations: {
  personality: [{ planet: 'sun', gate: 8, line: 2 }, { planet: 'earth', gate: 29, line: 3 }],
  design: [{ planet: 'sun', gate: 8, line: 2 }, { planet: 'earth', gate: 29, line: 2 }, { planet: 'moon', gate: 46, line: 5 }],
} };
const malformed = { ...chart, design: [8, 29, 0, 65, '8'], activations: { design: [null, {},
  { gate: 8, line: 2 }, { gate: 8, line: 2 }, { gate: 29, line: 3 }, { gate: '8', line: 2 },
  { gate: 0, line: 2 }, { gate: 65, line: 2 }, { gate: 8, line: '2' }], personality: false } };

const variants = [undefined, null, {}, chart, { ...chart, source: 'manual' }, { ...chart, source: 'transit' },
  { ...chart, design: [] }, { ...chart, activations: {} }, malformed,
  createChartComposition(chart), createChartComposition(chart, { secondary: malformed, kind: 'transit' })];

test('requested line gates match all 198 saved summary source/line combinations', () => {
  let cases = 0;
  for (const input of variants) {
    const summary = buildChartFacts(input);
    for (let line = 1; line <= 6; line++) for (const source of ['design', 'personality', 'all']) {
      assert.deepEqual(chartLineGates(input, line, source), summary.lines[line - 1].gates[source]);
      cases++;
    }
  }
  assert.equal(cases, 198);
  assert.deepEqual(chartLineGates(malformed, 2, 'all'), [8]);
  assert.deepEqual(chartLineGates({ ...chart, source: 'manual' }, 2, 'all'), []);
  assert.deepEqual(chartLineGates({ ...chart, design: [29] }, 2, 'design'), [29]);
});

test('line gates validate their query and observe in-place row and active-source changes', () => {
  for (const line of [0, 7, 2.5, '2', null, undefined]) assert.deepEqual(chartLineGates(chart, line, 'all'), []);
  for (const source of ['natal', '', null, undefined]) assert.deepEqual(chartLineGates(chart, 2, source), []);
  const mutable = structuredClone(chart);
  assert.deepEqual(chartLineGates(mutable, 2, 'all'), [8, 29]);
  mutable.activations.design[0].line = 1; mutable.personality = [29];
  assert.deepEqual(chartLineGates(mutable, 2, 'all'), [29]);
  const extracted = chartLineGates(mutable, 2, 'design'); extracted.push(64);
  assert.deepEqual(chartLineGates(mutable, 2, 'design'), [29]);
  const secondary = { source: 'calculated', design: [63], activations: { design: [{ gate: 63, line: 2 }] } };
  const overlay = createChartComposition(mutable, { secondary, kind: 'return', event: { id: 'exact-event' } });
  assert.deepEqual(chartLineGates(overlay, 2, 'all'), [29], 'secondary rows never enter primary summary groups');
  mutable.activations.design[1].line = 6;
  assert.deepEqual(chartLineGates(overlay, 2, 'all'), [], 'composition keeps its caller-owned primary rows observable');
});
