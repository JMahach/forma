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

test('unchanged/invalid selections reuse memoized projection; a new full chart invalidates it', () => {
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
  assert.deepEqual(repeated, hidden);
  owner.setAllPlanets(true); owner.setAllPlanets(true, 'design');
  const restored = owner.filter(repeated);
  assert.deepEqual(restored.activations, chart.activations);
  assert.equal(restored.planetFilter.activations, chart.activations.personality);
  assert.equal(restored.planetFilter.designActivations, chart.activations.design);
});

test('day permits only the red master and restores all black planets regardless of Years choices', () => {
  const owner = createTransitPlanetFilter(), chart = chartAt();
  const originalDay = owner.filter(chart);
  for (const action of [() => owner.setPlanet('moon', false), () => owner.setPlanet('sun', true, 'design'),
    () => owner.togglePlanet('moon'), () => owner.togglePlanet('sun', 'design'),
    () => owner.setAllPlanets(false), () => owner.toggleAllPlanets()]) assert.equal(action(), false);
  assert.equal(owner.filter(chart), originalDay, 'forbidden day toggles cannot invalidate or alter its projection');
  owner.toggleAllPlanets('design');
  assert.deepEqual(owner.filter(chart).activations, chart.activations);
  owner.setExpanded(true);
  assert.deepEqual(owner.state.selectedDesignPlanets, PLANET_IDS, 'Years remembers the day Design master');
  owner.setAllPlanets(false, 'design');
  owner.setPlanet('moon', false); owner.setPlanet('earth', true, 'design');
  const expanded = owner.filter(chart), chosen = owner.state;
  assert.equal(expanded.planetFilter.perPlanetControls, true);
  owner.setExpanded(true); assert.equal(owner.filter(chart), expanded, 'unchanged controls mode retains the projection');
  assert.equal(owner.setExpanded('true'), false); assert.equal(owner.filter(chart), expanded);
  owner.setExpanded(false);
  const restored = owner.filter(expanded);
  assert.notEqual(restored, expanded); assert.equal(restored.planetFilter.perPlanetControls, false);
  assert.deepEqual(restored.activations, chart.activations, 'day restores all black and shows all red for a nonempty Years selection');
  owner.setExpanded(true); assert.deepEqual(owner.state, chosen, 'Years retains the exact partial selection across a day visit');
  owner.setExpanded(false); owner.toggleAllPlanets('design');
  assert.deepEqual(owner.state.selectedDesignPlanets, []);
  owner.setExpanded(true);
  assert.deepEqual(owner.state.selectedDesignPlanets, [], 'the explicit day master OFF clears the shared Design selection');
  assert.deepEqual(owner.state.selectedPlanets, chosen.selectedPlanets, 'the Design master cannot change Years black choices');
  owner.setAllPlanets(false); owner.setPlanet('sun', true, 'design'); owner.setExpanded(false);
  assert.deepEqual(owner.filter(chart).activations.personality, chart.activations.personality);
  assert.deepEqual(owner.filter(chart).activations.design, chart.activations.design);
  owner.setAllPlanets(true, 'design'); owner.setExpanded(true);
  assert.deepEqual(owner.state.selectedDesignPlanets, PLANET_IDS, 'the explicit day master ON selects every red planet for Years');
  assert.deepEqual(owner.state.selectedPlanets, []);
});
