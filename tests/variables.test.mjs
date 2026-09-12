import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { calculateVariables } from '../src/activations/variables.js';

// Synthetic records use real opposite gate starts: 41/31 and 19/33. Place
// each longitude in the middle of a requested Tone so expected directions
// do not depend on the implementation's subdivision or rounding helpers.
const TONE_WIDTH = 5 / 192;
function pair(first, second, tone, { line = 1, color = 1, nodes = false, offset } = {}) {
  const longitude = (nodes ? 307.625 : 302) + (line - 1) * 0.9375
    + (color - 1) * 0.15625 + (offset ?? (tone - 0.5) * TONE_WIDTH);
  return [
    { planet: first, gate: nodes ? 19 : 41, line, longitude },
    { planet: second, gate: nodes ? 33 : 31, line, longitude: (longitude + 180) % 360 },
  ];
}
function chartFor(tones = [1, 4, 5, 2], options = {}) {
  return {
    source: 'calculated', personality: [19, 31, 33, 41], design: [19, 31, 33, 41],
    activations: {
      design: [...pair('sun', 'earth', tones[0], options),
        ...pair('north_node', 'south_node', tones[1], { ...options, nodes: true })],
      personality: [...pair('sun', 'earth', tones[2], options),
        ...pair('north_node', 'south_node', tones[3], { ...options, nodes: true })],
    },
  };
}

const positions = [
  { id: 'determination', source: 'design', position: 'top', label: 'Детерминация' },
  { id: 'environment', source: 'design', position: 'bottom', label: 'Среда' },
  { id: 'awareness', source: 'personality', position: 'top', label: 'Осознанность' },
  { id: 'perspective', source: 'personality', position: 'bottom', label: 'Перспектива' },
];
const planets = ['sun', 'earth', 'north_node', 'south_node'];

test('four Variables retain their specific source pair, position, Color and Tone', () => {
  assert.deepEqual(calculateVariables(chartFor()), positions.map((position, index) => ({
    color: 1, colorDirection: 'down',
    ...position, tone: [1, 4, 5, 2][index], direction: ['left', 'right', 'right', 'left'][index],
  })));
});

test('Tone 1, 2 and 3 point left; Tone 4, 5 and 6 point right for every Variable', () => {
  for (const [tone, direction] of [[1, 'left'], [2, 'left'], [3, 'left'], [4, 'right'], [5, 'right'], [6, 'right']]) {
    assert.deepEqual(calculateVariables(chartFor([tone, tone, tone, tone])),
      positions.map(position => ({ ...position, color: 1, colorDirection: 'down', tone, direction })));
  }
});

test('Color 1–3 points down and Color 4–6 up, independently of all six Tones', () => {
  for (const [color, colorDirection] of [[1, 'down'], [2, 'down'], [3, 'down'], [4, 'up'], [5, 'up'], [6, 'up']]) {
    for (const [tone, direction] of [[1, 'left'], [2, 'left'], [3, 'left'], [4, 'right'], [5, 'right'], [6, 'right']]) {
      assert.deepEqual(calculateVariables(chartFor([tone, tone, tone, tone], { color })),
        positions.map(position => ({ ...position, color, colorDirection, tone, direction })));
    }
  }
});

test('each of the four pairs has its own Color independently of its Tone', () => {
  // The four Color/Tone pairs from the supplied HumanDesign.red example;
  // longitudes here are synthetic and do not reproduce that personal chart.
  const chart = chartFor();
  chart.activations.design = [...pair('sun', 'earth', 5, { color: 1 }),
    ...pair('north_node', 'south_node', 2, { color: 1, nodes: true })];
  chart.activations.personality = [...pair('sun', 'earth', 6, { color: 6 }),
    ...pair('north_node', 'south_node', 4, { color: 3, nodes: true })];
  assert.deepEqual(calculateVariables(chart).map(({ color, colorDirection, tone, direction }) =>
    [color, colorDirection, tone, direction]),
  [[1, 'down', 5, 'right'], [1, 'down', 2, 'left'], [6, 'up', 6, 'right'], [3, 'down', 4, 'right']]);
});

test('all 16 left/right combinations can occur independently in the four positions', () => {
  const combinations = new Set();
  for (let bits = 0; bits < 16; bits++) {
    const directions = positions.map((_, index) => bits & (1 << index) ? 'right' : 'left');
    const tones = directions.map(direction => direction === 'left' ? 2 : 5);
    const actual = calculateVariables(chartFor(tones));
    assert.deepEqual(actual.map(item => item.direction), directions);
    assert.deepEqual(actual.map(item => item.id), positions.map(item => item.id));
    combinations.add(actual.map(item => item.direction).join(','));
  }
  assert.equal(combinations.size, 16);
});

test('the Tone 3/4 boundary switches direction without rounding the subdivision', () => {
  for (let line = 1; line <= 6; line++) {
    for (let color = 1; color <= 6; color++) {
      for (const [delta, expectedTone, direction] of [[-1e-8, 3, 'left'], [0, 4, 'right'], [1e-8, 4, 'right']]) {
        const chart = chartFor([4, 4, 4, 4], { line, color, offset: 3 * TONE_WIDTH + delta });
        assert.deepEqual(calculateVariables(chart).map(item => [item.tone, item.direction]),
          positions.map(() => [expectedTone, direction]), `line ${line}, color ${color}, delta ${delta}`);
      }
    }
  }
});

test('the Color 3/4 boundary switches vertical direction while Tone restarts', () => {
  for (let line = 1; line <= 6; line++) {
    for (const [delta, color, colorDirection, tone, direction] of [
      [-1e-8, 3, 'down', 6, 'right'], [0, 4, 'up', 1, 'left'], [1e-8, 4, 'up', 1, 'left'],
    ]) {
      const chart = chartFor([1, 1, 1, 1], { line, offset: 3 * 0.15625 + delta });
      assert.deepEqual(calculateVariables(chart).map(item =>
        [item.color, item.colorDirection, item.tone, item.direction]),
      positions.map(() => [color, colorDirection, tone, direction]), `line ${line}, delta ${delta}`);
    }
  }
});

test('line and color numbers do not substitute for Tone when choosing direction', () => {
  for (let line = 1; line <= 6; line++) {
    for (let color = 1; color <= 6; color++) {
      assert.deepEqual(calculateVariables(chartFor([6, 1, 4, 3], { line, color })).map(item => item.direction),
        ['right', 'left', 'right', 'left']);
    }
  }
});

test('manual, transit and missing source charts never acquire natal Variables', () => {
  for (const chart of [undefined, null, [], {}, ...[undefined, null, '', 'manual', 'transit', 'CALCULATED', 'unknown']
    .map(source => ({ ...chartFor(), source }))]) {
    assert.deepEqual(calculateVariables(chart), []);
  }
});

test('all eight relevant records are required and ambiguous duplicates are rejected', () => {
  for (const activations of [undefined, null, [], {}, { design: [], personality: [] }]) {
    assert.deepEqual(calculateVariables({ ...chartFor(), activations }), []);
  }
  for (const source of ['design', 'personality']) {
    for (const invalid of [undefined, null, {}, 'invalid', []]) {
      const chart = chartFor(); chart.activations[source] = invalid;
      assert.deepEqual(calculateVariables(chart), []);
    }
    for (const planet of planets) {
      const missing = chartFor();
      missing.activations[source] = missing.activations[source].filter(entry => entry.planet !== planet);
      assert.deepEqual(calculateVariables(missing), [], `${source} ${planet} missing`);
      const duplicate = chartFor();
      duplicate.activations[source].push({ ...duplicate.activations[source].find(entry => entry.planet === planet) });
      assert.deepEqual(calculateVariables(duplicate), [], `${source} ${planet} duplicated`);
    }
  }
});

test('invalid longitude, gate, line or record suppresses the entire four-arrow set', () => {
  const invalidFields = [
    ...[undefined, null, '', '302', NaN, Infinity, -Infinity, -1, 360, true].map(longitude => ({ longitude })),
    ...[undefined, null, '41', 0, 65, 1.5, NaN].map(gate => ({ gate })),
    ...[undefined, null, '1', 0, 7, 1.5, NaN, 2].map(line => ({ line })),
  ];
  for (const source of ['design', 'personality']) {
    for (const planet of planets) {
      for (const fields of invalidFields) {
        const chart = chartFor(), entry = chart.activations[source].find(entry => entry.planet === planet);
        Object.assign(entry, fields);
        assert.deepEqual(calculateVariables(chart), [], `${source} ${planet}: ${JSON.stringify(fields)}`);
      }
      for (const record of [undefined, null, {}, [], { planet }]) {
        const chart = chartFor(), index = chart.activations[source].findIndex(entry => entry.planet === planet);
        chart.activations[source][index] = record;
        assert.deepEqual(calculateVariables(chart), []);
      }
    }
  }
});

test('Sun/Earth and node pairs must agree on their exact Tone, even within one direction', () => {
  for (const source of ['design', 'personality']) {
    for (const planet of ['earth', 'south_node']) {
      for (const mismatchedTone of [3, 4]) {
        const chart = chartFor([1, 1, 1, 1]);
        const nodes = planet === 'south_node';
        const replacement = pair(nodes ? 'north_node' : 'sun', planet, mismatchedTone, { nodes })[1];
        chart.activations[source] = chart.activations[source].map(entry => entry.planet === planet ? replacement : entry);
        assert.deepEqual(calculateVariables(chart), [], `${source} ${planet} disagrees`);
      }
    }
  }
});

test('paired records must agree on exact Color even when Tone and both directions match', () => {
  for (const source of ['design', 'personality']) {
    for (const planet of ['earth', 'south_node']) {
      for (const color of [2, 4]) {
        const chart = chartFor([1, 1, 1, 1]);
        const nodes = planet === 'south_node';
        const replacement = pair(nodes ? 'north_node' : 'sun', planet, 1, { color, nodes })[1];
        chart.activations[source] = chart.activations[source].map(entry => entry.planet === planet ? replacement : entry);
        assert.deepEqual(calculateVariables(chart), [], `${source} ${planet} Color ${color} disagrees`);
      }
    }
  }
});

test('record order and unrelated planets do not affect the four required pairs', () => {
  const chart = chartFor(), expected = calculateVariables(chart);
  for (const source of ['design', 'personality']) {
    chart.activations[source].reverse();
    chart.activations[source].push({ planet: 'moon', longitude: 302, gate: 41, line: 1 });
  }
  assert.deepEqual(calculateVariables(chart), expected);
});

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
test('calculation reads frozen chart data and does not retain mutable result objects', () => {
  const chart = chartFor(), before = structuredClone(chart);
  freeze(chart);
  const first = calculateVariables(chart), expected = structuredClone(first);
  first[0].direction = 'right'; first[0].color = 6; first[0].colorDirection = 'up';
  first[0].label = 'changed'; first.pop();
  assert.deepEqual(calculateVariables(chart), expected);
  assert.deepEqual(chart, before);
});

const python = fileURLToPath(new URL('../.venv/bin/python', import.meta.url));
test('real natal calculator records yield the expected Variables across three dates', {
  skip: !existsSync(python) && 'Prepared calculator environment is not installed',
}, () => {
  const charts = JSON.parse(execFileSync(python, ['-B', '-c', `
import json
from server import calculator as calc
charts = []
for date in ['1900-01-01', '1990-06-15', '2026-09-12']:
    request = dict(mode='natal', name='Variable regression', date=date, time='12:00',
                   city=dict(id='test-utc', name='UTC test', timezone='UTC'))
    charts.append(calc.calculate(request)['chart'])
print(json.dumps(charts))
`], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }));
  // Expected Colors/Tones were checked independently from saved longitudes using
  // six Tone subdivisions per Color; these are engine regression examples,
  // not a claim of independent certification of an entire Human Design chart.
  const expectedTones = [[2, 6, 3, 6], [3, 1, 4, 2], [3, 2, 4, 5]];
  const expectedColors = [[3, 1, 2, 3], [5, 4, 4, 4], [1, 5, 6, 4]];
  assert.equal(charts.length, 3);
  charts.forEach((chart, index) => {
    const actual = calculateVariables(chart);
    assert.deepEqual(actual.map(item => item.tone), expectedTones[index]);
    assert.deepEqual(actual.map(item => item.direction), expectedTones[index].map(tone => tone <= 3 ? 'left' : 'right'));
    assert.deepEqual(actual.map(item => item.color), expectedColors[index]);
    assert.deepEqual(actual.map(item => item.colorDirection), expectedColors[index].map(color => color <= 3 ? 'down' : 'up'));
  });
});
