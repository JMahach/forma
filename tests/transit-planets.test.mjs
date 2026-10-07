import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransitPlanetFilter } from '../src/state/transit-planets.js';
import { PLANET_IDS } from '../src/domain/planets.js';
import { gatePositionAtLongitude } from '../src/domain/gate-wheel.js';

function chartAt(offset = 0) {
  const personality = PLANET_IDS.map((planet, i) => ({ planet, ...gatePositionAtLongitude((i * 23 + offset) % 360) }));
  const design = PLANET_IDS.map((planet, i) => ({ planet, ...gatePositionAtLongitude((i * 17 + offset + 88) % 360) }));
  return { source: 'transit', utc: '2026-09-30T12:34:00Z', designUtc: '2026-07-04T02:18:19Z',
    personality: [...new Set(personality.map(entry => entry.gate))], design: [...new Set(design.map(entry => entry.gate))],
    activations: { personality, design }, designArcResidualDegrees: 1e-10 };
}

test('transit defaults retain all black planets and hide all red, with full records for both columns', () => {
  const owner = createTransitPlanetFilter(), chart = chartAt(), before = structuredClone(chart);
  const filtered = owner.filter(chart);
  assert.deepEqual(owner.state, { selectedPlanets: PLANET_IDS, selectedDesignPlanets: [] });
  assert.equal(filtered.planetFilter.perPlanetControls, false);
  assert.deepEqual(filtered.activations.personality, chart.activations.personality);
  assert.deepEqual(filtered.activations.design, []); assert.deepEqual(filtered.design, []);
  assert.equal(filtered.planetFilter.activations, chart.activations.personality);
  assert.equal(filtered.planetFilter.designActivations, chart.activations.design);
  assert.equal(filtered.utc, chart.utc); assert.equal(filtered.designUtc, chart.designUtc);
  assert.deepEqual(chart, before);
  assert.equal(owner.filter(chart), filtered, 'repeated renders reuse the projection');
});

test('black and red individual/all toggles are independent, preserve exact records and unique sorted gates', () => {
  const owner = createTransitPlanetFilter(), chart = chartAt(), original = structuredClone(chart);
  owner.setExpanded(true);
  owner.setAllPlanets(false); owner.setPlanet('earth', true);
  owner.togglePlanet('south_node', 'design'); owner.setPlanet('moon', true, 'design');
  const filtered = owner.filter(chart);
  assert.deepEqual(filtered.activations.personality, chart.activations.personality.filter(e => e.planet === 'earth'));
  const red = chart.activations.design.filter(e => ['south_node', 'moon'].includes(e.planet));
  assert.deepEqual(filtered.activations.design, red);
  assert.deepEqual(filtered.design, [...new Set(red.map(e => e.gate))].sort((a, b) => a - b));
  owner.toggleAllPlanets('design');
  assert.deepEqual(owner.filter(chart).activations.design, chart.activations.design);
  assert.deepEqual(owner.state.selectedPlanets, ['earth']);
  owner.toggleAllPlanets('design'); owner.togglePlanet('earth');
  assert.deepEqual(owner.filter(chart).activations, { personality: [], design: [] });
  assert.equal(owner.filter(chart).utc, chart.utc, 'zero selections retain the chosen moment');
  assert.deepEqual(chart, original);
});

test('unchanged/invalid selections reuse memoized projection; a new full chart has its own projection', () => {
  const owner = createTransitPlanetFilter(), chart = chartAt(); owner.setExpanded(true);
  const first = owner.filter(chart);
  assert.equal(owner.setPlanet('sun', true), true); assert.equal(owner.setAllPlanets(false, 'design'), true);
  for (const action of [() => owner.setPlanet('not-a-planet', true), () => owner.setPlanet('sun', 1),
    () => owner.setAllPlanets('yes'), () => owner.setPlanet('sun', true, '__proto__'),
    () => owner.togglePlanet('sun', 'invalid'), () => owner.toggleAllPlanets('constructor')]) assert.equal(action(), false);
  owner.state.selectedPlanets.length = 0;
  assert.equal(owner.filter(chart), first); assert.equal(owner.state.selectedPlanets.length, 13);
  const next = chartAt(0.125), filtered = owner.filter(next);
  assert.notEqual(filtered, first); assert.deepEqual(filtered.activations.personality, next.activations.personality);
  const detachedFilter = owner.filter;
  assert.equal(detachedFilter(next), filtered, 'session can use filter as a callback');
});

test('alternating displayed and borrowed charts retain each projection for the current selection', () => {
  const owner = createTransitPlanetFilter(), first = chartAt(), next = chartAt(0.125);
  const filteredFirst = owner.filter(first), filteredNext = owner.filter(next);
  assert.equal(owner.filter(first), filteredFirst, 'reading the borrowed chart cannot evict the displayed projection');
  assert.equal(owner.filter(next), filteredNext);
  assert.equal(owner.filter(filteredFirst), filteredFirst, 'an already filtered result is reused');
  assert.equal(owner.filter(filteredNext), filteredNext);
});

test('selection and controls revisions reproject both charts without losing full or previously filtered records', () => {
  const owner = createTransitPlanetFilter(), charts = [chartAt(), chartAt(0.125)];
  const originals = structuredClone(charts);
  owner.setExpanded(true);
  const previous = charts.map(owner.filter), previousValues = structuredClone(previous);
  owner.setPlanet('moon', false); owner.setPlanet('venus', true, 'design');
  const partial = charts.map(owner.filter);
  for (let i = 0; i < charts.length; i++) {
    assert.notEqual(partial[i], previous[i]);
    assert.deepEqual(partial[i].activations.personality, charts[i].activations.personality.filter(e => e.planet !== 'moon'));
    assert.deepEqual(partial[i].activations.design, charts[i].activations.design.filter(e => e.planet === 'venus'));
    assert.equal(owner.filter(charts[i]), partial[i]);
  }
  owner.setExpanded(false);
  const compact = partial.map(owner.filter);
  for (let i = 0; i < charts.length; i++) {
    assert.equal(compact[i].planetFilter.perPlanetControls, false);
    assert.deepEqual(compact[i].activations, charts[i].activations, 'compact mode restores both complete columns');
  }
  owner.setExpanded(true);
  owner.restore({ selectedPlanets: [], selectedDesignPlanets: [] });
  const hidden = compact.map(owner.filter);
  for (const chart of hidden) assert.deepEqual(chart.activations, { personality: [], design: [] });
  owner.setAllPlanets(true); owner.setAllPlanets(true, 'design');
  for (let i = 0; i < charts.length; i++) {
    const restored = owner.filter(hidden[i]);
    assert.deepEqual(restored.activations, charts[i].activations);
    assert.equal(restored.planetFilter.activations, charts[i].activations.personality);
    assert.equal(restored.planetFilter.designActivations, charts[i].activations.design);
  }
  assert.deepEqual(charts, originals);
  assert.deepEqual(previous, previousValues);
  for (const chart of hidden) assert.deepEqual(chart.activations, { personality: [], design: [] });
});

test('filter leaves natal, returns and missing charts untouched', () => {
  const owner = createTransitPlanetFilter();
  for (const source of ['natal', 'return', 'life', undefined]) {
    const chart = { ...chartAt(), source }; assert.equal(owner.filter(chart), chart);
  }
  assert.equal(owner.filter(null), null);
});

test('reprojecting a filtered chart retains both full columns and can restore every hidden record', () => {
  const owner = createTransitPlanetFilter(), chart = chartAt();
  owner.setExpanded(true);
  owner.setAllPlanets(false);
  const hidden = owner.filter(chart), repeated = owner.filter(hidden);
  assert.equal(repeated, hidden);
  owner.setAllPlanets(true); owner.setAllPlanets(true, 'design');
  const restored = owner.filter(repeated);
  assert.deepEqual(restored.activations, chart.activations);
  assert.equal(restored.planetFilter.activations, chart.activations.personality);
  assert.equal(restored.planetFilter.designActivations, chart.activations.design);
});

test('day permits only the red master and restores all black planets regardless of Lifetime choices', () => {
  const owner = createTransitPlanetFilter(), chart = chartAt();
  const originalDay = owner.filter(chart);
  for (const action of [() => owner.setPlanet('moon', false), () => owner.setPlanet('sun', true, 'design'),
    () => owner.togglePlanet('moon'), () => owner.togglePlanet('sun', 'design'),
    () => owner.setAllPlanets(false), () => owner.toggleAllPlanets()]) assert.equal(action(), false);
  assert.equal(owner.filter(chart), originalDay, 'forbidden day toggles cannot invalidate or alter its projection');
  owner.toggleAllPlanets('design');
  assert.deepEqual(owner.filter(chart).activations, chart.activations);
  owner.setExpanded(true);
  assert.deepEqual(owner.state.selectedDesignPlanets, PLANET_IDS, 'Lifetime remembers the day Design master');
  owner.setAllPlanets(false, 'design');
  owner.setPlanet('moon', false); owner.setPlanet('earth', true, 'design');
  const expanded = owner.filter(chart), chosen = owner.state;
  assert.equal(expanded.planetFilter.perPlanetControls, true);
  owner.setExpanded(true); assert.equal(owner.filter(chart), expanded, 'unchanged controls mode retains the projection');
  assert.equal(owner.setExpanded('true'), false); assert.equal(owner.filter(chart), expanded);
  owner.setExpanded(false);
  const restored = owner.filter(expanded);
  assert.notEqual(restored, expanded); assert.equal(restored.planetFilter.perPlanetControls, false);
  assert.deepEqual(restored.activations, chart.activations, 'day restores all black and shows all red for a nonempty Lifetime selection');
  owner.setExpanded(true); assert.deepEqual(owner.state, chosen, 'Lifetime retains the exact partial selection across a day visit');
  owner.setExpanded(false); owner.toggleAllPlanets('design');
  assert.deepEqual(owner.state.selectedDesignPlanets, []);
  owner.setExpanded(true);
  assert.deepEqual(owner.state.selectedDesignPlanets, [], 'the explicit day master OFF clears the shared Design selection');
  assert.deepEqual(owner.state.selectedPlanets, chosen.selectedPlanets, 'the Design master cannot change Lifetime black choices');
  owner.setAllPlanets(false); owner.setPlanet('sun', true, 'design'); owner.setExpanded(false);
  assert.deepEqual(owner.filter(chart).activations.personality, chart.activations.personality);
  assert.deepEqual(owner.filter(chart).activations.design, chart.activations.design);
  owner.setAllPlanets(true, 'design'); owner.setExpanded(true);
  assert.deepEqual(owner.state.selectedDesignPlanets, PLANET_IDS, 'the explicit day master ON selects every red planet for Lifetime');
  assert.deepEqual(owner.state.selectedPlanets, []);
});

test('raw planet snapshot restores partial choices while compact day projection stays all-or-none', () => {
  const first = createTransitPlanetFilter(); first.setExpanded(true);
  first.setAllPlanets(false); first.setPlanet('moon', true); first.setPlanet('venus', true, 'design');
  first.setExpanded(false);
  assert.deepEqual(first.snapshot, { selectedPlanets: ['moon'], selectedDesignPlanets: ['venus'] });
  const restored = createTransitPlanetFilter();
  assert.equal(restored.restore(first.snapshot), true);
  assert.deepEqual(restored.state, { selectedPlanets: PLANET_IDS, selectedDesignPlanets: PLANET_IDS });
  restored.setExpanded(true);
  assert.deepEqual(restored.filter(chartAt()).activations.personality.map(e => e.planet), ['moon']);
  assert.deepEqual(restored.filter(chartAt()).activations.design.map(e => e.planet), ['venus']);
  first.snapshot.selectedPlanets.push('sun');
  assert.deepEqual(first.snapshot.selectedPlanets, ['moon']);
});

test('malformed planet restoration is atomic and valid empty choices invalidate cached projection', () => {
  const owner = createTransitPlanetFilter(); owner.setExpanded(true);
  const chart = chartAt(), original = owner.filter(chart);
  for (const invalid of [null, {}, { selectedPlanets: ['moon'], selectedDesignPlanets: ['unknown'] },
    { selectedPlanets: ['moon', 'moon'], selectedDesignPlanets: [] },
    { selectedPlanets: 'moon', selectedDesignPlanets: [] },
    { selectedPlanets: Array(1), selectedDesignPlanets: [] }]) {
    assert.equal(owner.restore(invalid), false);
    assert.equal(owner.filter(chart), original);
  }
  assert.equal(owner.restore({ selectedPlanets: [], selectedDesignPlanets: [] }), true);
  assert.deepEqual(owner.filter(chart).activations, { personality: [], design: [] });
});
