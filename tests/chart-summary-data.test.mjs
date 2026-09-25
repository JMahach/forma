import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChartSummary } from '../src/charts/chart-summary-data.js';
import { CENTERS, CHANNELS, GATES, getDefinition } from '../src/bodygraph/graph-data.js';

const row = (planet, gate, line) => ({ planet, gate, line });
const chartFromRows = (design, personality, source = 'calculated') => ({
  source,
  design: [...new Set(design.map(entry => entry.gate))],
  personality: [...new Set(personality.map(entry => entry.gate))],
  activations: { design, personality },
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

test('line counts include each saved planetary activation but selection gates are unique', () => {
  const summary = buildChartSummary(chartFromRows(
    [row('sun', 29, 2), row('earth', 29, 2), row('north_node', 8, 2), row('south_node', 8, 2)],
    [row('sun', 29, 2), row('earth', 46, 2)],
  ));
  assert.equal(summary.hasLines, true);
  assert.deepEqual(summary.lines[1], {
    line: 2, design: 4, personality: 2, total: 6,
    gates: { design: [8, 29], personality: [29, 46], all: [8, 29, 46] },
  });
  assert.equal(summary.totals.activations, 6);
  assert.equal(summary.totals.gates, 3);
  assert.deepEqual(summary.gates.find(gate => gate.id === 29), {
    id: 29, name: 'Обязательство', design: true, personality: true, activationCount: 3,
  });
});

test('six second lines in design and three in personality total nine, including both nodes', () => {
  const planets = ['sun', 'earth', 'moon', 'north_node', 'south_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];
  const designSeconds = new Set(['north_node', 'south_node', 'venus', 'mars', 'saturn', 'pluto']);
  const personalitySeconds = new Set(['moon', 'mercury', 'jupiter']);
  const summary = buildChartSummary(chartFromRows(
    planets.map((planet, index) => row(planet, index + 1, designSeconds.has(planet) ? 2 : 4)),
    planets.map((planet, index) => row(planet, index + 20, personalitySeconds.has(planet) ? 2 : 1)),
  ));
  assert.equal(summary.lines[1].design, 6);
  assert.equal(summary.lines[1].personality, 3);
  assert.equal(summary.lines[1].total, 9);
  assert.equal(summary.totals.activations, 26);
  assert.equal(summary.profile, '1/4');
  assert.deepEqual(summary.lines.map(entry => entry.line), [1, 2, 3, 4, 5, 6]);
  assert.equal(summary.lines.reduce((sum, entry) => sum + entry.total, 0), 26);
});

test('transit has one source of activations and no natal profile', () => {
  const summary = buildChartSummary(chartFromRows([], [row('sun', 20, 1), row('earth', 34, 2)], 'transit'));
  assert.equal(summary.isTransit, true);
  assert.equal(summary.hasLines, true);
  assert.equal(summary.profile, null);
  assert.equal(summary.totals.activations, 2);
  assert(summary.lines.every(entry => entry.design === 0 && entry.gates.design.length === 0));
  assert.deepEqual(summary.lines[1].gates, { design: [], personality: [34], all: [34] });
});

test('manual gates retain factual topology without invented line or activation counts', () => {
  const summary = buildChartSummary({ source: 'manual', design: [34], personality: [20] });
  assert.equal(summary.isTransit, false);
  assert.equal(summary.hasLines, false);
  assert.equal(summary.profile, null);
  assert.deepEqual(summary.totals, { gates: 2, channels: 1, centers: 2, activations: null });
  assert(summary.lines.every(entry => entry.total === 0 && entry.gates.all.length === 0));
  assert(summary.gates.every(entry => entry.activationCount === null));
  // Manual input cannot acquire a profile from stray stale calculation details.
  assert.equal(buildChartSummary({
    source: 'manual', design: [34], personality: [20],
    activations: { design: [row('sun', 34, 2)], personality: [row('sun', 20, 1)] },
  }).hasLines, false);
});

test('empty or missing calculation data does not claim measured line totals', () => {
  for (const input of [undefined, null, {}, { activations: {} }, { activations: { design: [], personality: [] } }]) {
    const summary = buildChartSummary(input);
    assert.equal(summary.hasLines, false);
    assert.equal(summary.profile, null);
    assert.deepEqual(summary.totals, { gates: 0, channels: 0, centers: 0, activations: null });
    assert.equal(summary.centers.length, 9);
    assert(summary.centers.every(center => !center.defined && !center.activeGates.length));
    assert.deepEqual(summary.channels, []);
    assert.deepEqual(summary.gates, []);
  }
});

test('profile requires calculated natal data and one valid Sun line on both sides', () => {
  const chart = chartFromRows([row('sun', 34, 4)], [row('sun', 20, 1)]);
  assert.equal(buildChartSummary(chart).profile, '1/4');
  for (const source of ['manual', 'transit', undefined]) {
    assert.equal(buildChartSummary({ ...chart, source }).profile, null);
  }
  for (const design of [[], [row('earth', 34, 4)], [row('sun', 34, 7)], [row('sun', 34, 4), row('sun', 34, 4)]]) {
    assert.equal(buildChartSummary({ ...chart, activations: { ...chart.activations, design } }).profile, null);
  }
});

test('channels and defined centers derive from the canonical combined gate sets', () => {
  const chart = { design: [34, 44], personality: [20, 26, 64] };
  const summary = buildChartSummary(chart);
  const expected = getDefinition(chart);
  assert.deepEqual(summary.channels, expected.channels.map(({ id, name, gates }) => ({ id, name, gates })));
  assert.deepEqual(summary.centers.filter(center => center.defined).map(center => center.id), CENTERS.filter(center => expected.centers.has(center.id)).map(center => center.id));
  assert.deepEqual(summary.centers.find(center => center.id === 'head'), {
    id: 'head', name: 'Теменной', defined: false, activeGates: [64],
  });
  assert.equal(summary.totals.gates, 5);
  assert.equal(summary.totals.channels, 2);
  assert.equal(summary.totals.centers, 4);
});

test('all gates produce the same full topology as the renderer', () => {
  const summary = buildChartSummary({ design: GATES.map(gate => gate.id), personality: [] });
  assert.equal(summary.totals.gates, 64);
  assert.equal(summary.totals.channels, CHANNELS.length);
  assert.equal(summary.totals.centers, CENTERS.length);
  assert(summary.centers.every(center => center.defined));
});

test('invalid or inconsistent detail rows never introduce gates outside the diagram', () => {
  const summary = buildChartSummary({
    source: 'calculated', design: [34, 34, 65, '20', null], personality: [20],
    activations: {
      design: [null, row('sun', 34, 2), row('earth', 34, 0), row('moon', 34, 7), row('mars', 34, '2'), row('venus', 10, 2)],
      personality: 'invalid',
    },
  });
  assert.equal(summary.totals.gates, 2);
  assert.equal(summary.totals.activations, 1);
  assert.equal(summary.lines[1].total, 1);
  assert.deepEqual(summary.lines[1].gates.all, [34]);
  assert.equal(summary.profile, null);
});

test('summary building and returned lists do not mutate inputs or canonical geometry', () => {
  const chart = deepFreeze(chartFromRows([row('sun', 34, 2)], [row('sun', 20, 1)]));
  const before = structuredClone(chart);
  const channelGates = CHANNELS.find(channel => channel.id === '20-34').gates.slice();
  const summary = buildChartSummary(chart);
  summary.channels[0].gates.push(64);
  summary.lines[1].gates.design.push(64);
  summary.centers[0].activeGates.push(64);
  assert.deepEqual(chart, before);
  assert.deepEqual(CHANNELS.find(channel => channel.id === '20-34').gates, channelGates);
  assert.deepEqual(buildChartSummary(chart).lines[1].gates.design, [34]);
});
