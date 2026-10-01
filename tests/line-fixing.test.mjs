import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLineFixings } from '../src/domain/line-fixing.js';
import { LINE_FIXING_DATA } from '../src/domain/line-fixing-data.js';
import { PLANETS } from '../src/domain/planets.js';
import { CHANNELS } from '../src/scene/geometry/chart-geometry.js';
import { createTransitPlanetFilter } from '../src/state/transit-planets.js';

const activation = (planet, gate, line) => ({ planet, gate, line });
const contributor = (source, planet, gate, line) => ({ source, planet, gate, line });
const chart = (personality = [], design = [], extra = {}) => ({ personality: [], design: [], activations: { personality, design }, ...extra });
const sorted = values => [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

function expectFixing(result, key, state, exalted = [], detriment = []) {
  assert.ok(result instanceof Map, 'fixings are keyed by exact source and planet');
  assert.ok(result.has(key), `${key} is a valid unique target`);
  const value = result.get(key);
  assert.deepEqual({ ...value, exalted: sorted(value.exalted), detriment: sorted(value.detriment) }, {
    state, exalted: sorted(exalted), detriment: sorted(detriment),
  }, key);
}

test('known ruling-table entries support the requested fixing examples', () => {
  assert.deepEqual(LINE_FIXING_DATA['43.2'], { exalted: ['pluto'], detriment: ['moon'] });
  assert.deepEqual(LINE_FIXING_DATA['55.2'], { exalted: ['venus'], detriment: ['earth'] });
  assert.deepEqual(LINE_FIXING_DATA['16.3'].detriment, ['mars']);
  assert.deepEqual(LINE_FIXING_DATA['16.4'].detriment, ['mars']);
  assert.deepEqual(LINE_FIXING_DATA['54.4'], { exalted: [], detriment: [] });
  assert.deepEqual(new Set(LINE_FIXING_DATA['25.4'].exalted), new Set(['venus', 'jupiter']));
});

test('missing or malformed activation collections produce an empty map without inventing targets', () => {
  for (const input of [undefined, null, {}, { activations: null }, { activations: [] }, { activations: {} },
    { activations: { design: null, personality: 'invalid' } }, { personality: [43], design: [23] }]) {
    const result = calculateLineFixings(input);
    assert.ok(result instanceof Map);
    assert.equal(result.size, 0);
  }
});

test('all 13 known planets in each source receive a result even when no rulers apply', () => {
  const entries = PLANETS.map(([planet]) => activation(planet, 54, 4));
  const result = calculateLineFixings(chart(entries, entries.map(entry => ({ ...entry }))));
  assert.equal(result.size, 26);
  for (const source of ['design', 'personality']) {
    for (const [planet] of PLANETS) expectFixing(result, `${source}-${planet}`, 'none');
  }
});

test('personality Pluto at 43.2 can exalt its own activation', () => {
  const result = calculateLineFixings(chart([activation('pluto', 43, 2)]));
  expectFixing(result, 'personality-pluto', 'exalted', [contributor('personality', 'pluto', 43, 2)]);
});

test('design Sun at 55.2 is exalted by personality Venus at harmonic gate 39', () => {
  const result = calculateLineFixings(chart([activation('venus', 39, 6)], [activation('sun', 55, 2)]));
  expectFixing(result, 'design-sun', 'exalted', [contributor('personality', 'venus', 39, 6)]);
});

test('Mars at 16.1 fixes both 16.3 and 16.4 in detriment across lines and sources', () => {
  const result = calculateLineFixings(chart([
    activation('sun', 16, 3), activation('mars', 16, 1),
  ], [activation('earth', 16, 4)]));
  const mars = contributor('personality', 'mars', 16, 1);
  expectFixing(result, 'personality-sun', 'detriment', [], [mars]);
  expectFixing(result, 'design-earth', 'detriment', [], [mars]);
});

test('same-gate rulers apply on every contributor line within either or both streams', () => {
  for (const targetSource of ['design', 'personality']) {
    for (const rulerSource of ['design', 'personality']) {
      for (let line = 1; line <= 6; line++) {
        const input = chart();
        input.activations[targetSource].push(activation('sun', 43, 2));
        input.activations[rulerSource].push(activation('pluto', 43, line));
        expectFixing(calculateLineFixings(input), `${targetSource}-sun`, 'exalted', [contributor(rulerSource, 'pluto', 43, line)]);
      }
    }
  }
});

test('simultaneous exaltation and detriment yield juxtaposed with both contributor lists', () => {
  const result = calculateLineFixings(chart([
    activation('sun', 43, 2), activation('moon', 43, 6),
  ], [activation('pluto', 23, 5)]));
  expectFixing(result, 'personality-sun', 'juxtaposed',
    [contributor('design', 'pluto', 23, 5)], [contributor('personality', 'moon', 43, 6)]);
});

test('a ruler outside the same or directly harmonic gate contributes no fixing', () => {
  const result = calculateLineFixings(chart([
    activation('sun', 43, 2), activation('pluto', 1, 2), activation('moon', 11, 1),
    activation('mercury', 43, 3),
  ], [], { personality: [43, 23, 1, 11], design: [23] }));
  expectFixing(result, 'personality-sun', 'none');
});

test('fixing does not propagate through another gate in the same center or another defined channel', () => {
  // 43–23 and 17–62 both link Ajna to Throat. Neither 17 nor 62 is a
  // harmonic gate of 43, even when both channels appear in the chart.
  const result = calculateLineFixings(chart([
    activation('sun', 43, 2), activation('mercury', 23, 1),
    activation('pluto', 17, 2), activation('moon', 62, 3),
  ], [], { personality: [43, 23, 17, 62] }));
  expectFixing(result, 'personality-sun', 'none');
});

test('54.4 stays unfixed even with every planet in its same and harmonic gates', () => {
  const input = chart(
    PLANETS.map(([planet]) => activation(planet, 54, 4)),
    PLANETS.map(([planet], index) => activation(planet, 32, index % 6 + 1)),
  );
  const result = calculateLineFixings(input);
  for (const [planet] of PLANETS) expectFixing(result, `personality-${planet}`, 'none');
});

test('25.4 retains both Venus and Jupiter contributors from each source', () => {
  const result = calculateLineFixings(chart([
    activation('sun', 25, 4), activation('venus', 25, 1), activation('jupiter', 51, 2),
  ], [activation('venus', 51, 5), activation('jupiter', 25, 6)]));
  expectFixing(result, 'personality-sun', 'exalted', [
    contributor('personality', 'venus', 25, 1), contributor('personality', 'jupiter', 51, 2),
    contributor('design', 'venus', 51, 5), contributor('design', 'jupiter', 25, 6),
  ]);
});

test('all six integration channels provide direct harmonic fixing in both directions', () => {
  const integration = new Set([10, 20, 34, 57]);
  const links = CHANNELS.filter(item => item.gates.every(gate => integration.has(gate)));
  assert.equal(links.length, 6);
  for (const { gates: [left, right] } of links) {
    for (const [targetGate, rulerGate] of [[left, right], [right, left]]) {
      for (const state of ['exalted', 'detriment']) {
        const ruler = LINE_FIXING_DATA[`${targetGate}.1`][state][0];
        assert.ok(ruler, `${targetGate}.1 has a ${state} ruler for this fixture`);
        const result = calculateLineFixings(chart([activation(ruler, rulerGate, 6)], [activation('north_node', targetGate, 1)]));
        const expected = [contributor('personality', ruler, rulerGate, 6)];
        expectFixing(result, 'design-north_node', state, state === 'exalted' ? expected : [], state === 'detriment' ? expected : []);
      }
    }
  }
});

test('nodes are valid fixing targets but never contribute as planetary rulers', () => {
  const fixed = calculateLineFixings(chart([
    activation('north_node', 43, 2), activation('south_node', 43, 2), activation('pluto', 23, 4),
  ]));
  const pluto = contributor('personality', 'pluto', 23, 4);
  for (const node of ['north_node', 'south_node']) expectFixing(fixed, `personality-${node}`, 'exalted', [pluto]);
  const nodesOnly = calculateLineFixings(chart([
    activation('sun', 43, 2), activation('north_node', 43, 1), activation('south_node', 23, 6),
  ]));
  expectFixing(nodesOnly, 'personality-sun', 'none');
  for (const value of nodesOnly.values()) {
    assert.ok([...value.exalted, ...value.detriment].every(item => !['north_node', 'south_node'].includes(item.planet)));
  }
});

test('invalid rows are excluded as both targets and contributors', () => {
  const invalid = [null, undefined, [], {}, 'pluto',
    activation('unknown', 43, 2), activation('Pluto', 43, 2), activation('__proto__', 43, 2),
    ...[undefined, null, '43', 0, 65, 43.5, NaN, Infinity].map(gate => activation('pluto', gate, 2)),
    ...[undefined, null, '2', 0, 7, 2.5, NaN, Infinity].map(line => activation('pluto', 43, line)),
  ];
  for (const row of invalid) {
    assert.equal(calculateLineFixings(chart([row])).size, 0, `invalid target: ${JSON.stringify(row)}`);
    const result = calculateLineFixings(chart([activation('sun', 43, 2), row]));
    assert.equal(result.size, 1, `invalid contributor: ${JSON.stringify(row)}`);
    expectFixing(result, 'personality-sun', 'none');
  }
});

test('duplicate targets in the same source are omitted even when their entries are identical', () => {
  for (const duplicate of [activation('sun', 43, 2), activation('sun', 55, 2), activation('sun', 43, '2')]) {
    const result = calculateLineFixings(chart([
      activation('sun', 43, 2), duplicate, activation('pluto', 23, 4),
    ]));
    assert.equal(result.has('personality-sun'), false);
    assert.equal(result.size, 1);
    assert.ok(result.has('personality-pluto'));
  }
});

test('duplicate ruler entries are omitted conservatively without suppressing another valid polarity', () => {
  for (const duplicate of [activation('pluto', 43, 1), activation('pluto', 23, 2), activation('pluto', 43, 0)]) {
    const result = calculateLineFixings(chart([
      activation('sun', 43, 2), activation('pluto', 43, 1), duplicate, activation('moon', 23, 6),
    ]));
    assert.equal(result.has('personality-pluto'), false);
    expectFixing(result, 'personality-sun', 'detriment', [], [contributor('personality', 'moon', 23, 6)]);
  }
});

test('same planet across sources remains distinct and duplication affects only its own source', () => {
  const input = chart([activation('sun', 43, 2), activation('pluto', 43, 1)], [activation('pluto', 23, 5)]);
  expectFixing(calculateLineFixings(input), 'personality-sun', 'exalted', [
    contributor('personality', 'pluto', 43, 1), contributor('design', 'pluto', 23, 5),
  ]);
  input.activations.personality.push(activation('pluto', 43, 1));
  const result = calculateLineFixings(input);
  assert.equal(result.has('personality-pluto'), false);
  assert.ok(result.has('design-pluto'));
  expectFixing(result, 'personality-sun', 'exalted', [contributor('design', 'pluto', 23, 5)]);
});

test('transit fixings use selected black and red targets and contributors without hidden-planet influence', () => {
  const input = chart([activation('sun', 43, 2), activation('venus', 39, 6)],
    [activation('sun', 55, 2), activation('pluto', 23, 4), activation('moon', 43, 5)], { source: 'transit' });
  const filter = createTransitPlanetFilter();
  filter.setExpanded(true);
  const blackOnly = calculateLineFixings(filter.filter(input));
  assert.deepEqual([...blackOnly.keys()], ['personality-sun', 'personality-venus']);
  expectFixing(blackOnly, 'personality-sun', 'none');
  filter.setPlanet('sun', true, 'design');
  expectFixing(calculateLineFixings(filter.filter(input)), 'design-sun', 'exalted', [contributor('personality', 'venus', 39, 6)]);
  filter.setAllPlanets(true, 'design');
  expectFixing(calculateLineFixings(filter.filter(input)), 'personality-sun', 'juxtaposed',
    [contributor('design', 'pluto', 23, 4)], [contributor('design', 'moon', 43, 5)]);
  filter.setPlanet('venus', false);
  expectFixing(calculateLineFixings(filter.filter(input)), 'design-sun', 'none');
});

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

test('fixing calculation preserves frozen chart data and returns repeatable contributor evidence', () => {
  const input = freezeDeep(chart([
    { ...activation('sun', 43, 2), longitude: 230.5, custom: { label: 'preserve me' } },
    activation('pluto', 23, 1),
  ], [activation('moon', 43, 5)], { personality: [43, 23], design: [43] }));
  const before = JSON.stringify(input);
  const first = calculateLineFixings(input), second = calculateLineFixings(input);
  assert.deepEqual(first, second);
  expectFixing(first, 'personality-sun', 'juxtaposed',
    [contributor('personality', 'pluto', 23, 1)], [contributor('design', 'moon', 43, 5)]);
  assert.equal(JSON.stringify(input), before);
});
