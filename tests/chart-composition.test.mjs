import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransitPlanetFilter } from '../src/state/transit-planets.js';
import { overlayFixture } from './helpers/chart-composition.mjs';
import { createChartComposition, primaryChart, chartTopology, isChartOverlay } from '../src/domain/chart-composition.js';

const primary = { id: 'saved', source: 'manual', personality: [34, 20], design: [10], utc: '2000-01-01T00:00:00.123456Z' };
test('single compositions preserve their sole real source and exact time without inventing calculation data', () => {
  const frame = createChartComposition(primary);
  assert.equal(frame.primary, primary);
  assert.equal(frame.secondary, null);
  assert.equal(frame.kind, 'single');
  assert.equal(frame.event, null);
  assert.equal(frame.utc, primary.utc);
  assert.equal(frame.id, primary.id);
  assert.equal(frame.activations, undefined);
  assert.equal(primaryChart(frame), primary);
  assert.equal(chartTopology(frame), frame.topology);
  assert.deepEqual(frame.topology, { personality: [20, 34], design: [10] });
  assert.equal(isChartOverlay(frame), false);
  assert.equal(Object.isFrozen(frame), true);
  assert.equal(Object.isFrozen(primary), false, 'constructing a view must not freeze the caller-owned record');
});

test('raw charts retain direct reads for standalone renderers that mutate their inputs', () => {
  assert.equal(primaryChart(primary), primary);
  assert.equal(chartTopology(primary), primary);
  const raw = { personality: [20], design: [] };
  raw.personality.push(34);
  assert.deepEqual(chartTopology(raw).personality, [20, 34]);
});

test('a composition cannot silently drop a source or accept an event without its return', () => {
  assert.throws(() => createChartComposition(null), /primary/);
  assert.throws(() => createChartComposition(primary, { secondary: primary }), /single/);
  assert.throws(() => createChartComposition(primary, { kind: 'transit' }), /secondary/);
  assert.throws(() => createChartComposition(primary, { kind: 'single', event: { id: 'x' } }), /event/);
});


test('personal overlays union the full natal gates with only participating transit gates', () => {
  const natal = { id: 'natal', source: 'calculated', personality: [20], design: [34], activations: {
    personality: [{ planet: 'sun', gate: 20, line: 1, longitude: 300 }],
    design: [{ planet: 'sun', gate: 34, line: 2, longitude: 301 }],
  } };
  const moment = { id: 'moment', source: 'transit', personality: [63, 4], design: [49], activations: {
    personality: [{ planet: 'sun', gate: 63, line: 6, longitude: 12.3456789 }, { planet: 'earth', gate: 4, line: 2, longitude: 192.3456789 }],
    design: [{ planet: 'sun', gate: 49, line: 3, longitude: 280 }],
  } };
  const before = JSON.stringify({ natal, moment });
  const filter = createTransitPlanetFilter();
  filter.setExpanded(true); filter.setAllPlanets(false); filter.setPlanet('sun', true);
  const filtered = filter.filter(moment), frame = overlayFixture(natal, filtered, { kind: 'transit' });
  assert.equal(frame.primary, natal);
  assert.equal(frame.secondary, filtered);
  assert.deepEqual(frame.topology, { personality: [20, 63], design: [34] });
  assert.equal(frame.secondary.activations.personality[0].longitude, 12.3456789);
  assert.equal(frame.primary.activations.personality[0].gate, 20, 'legacy rows are not reprojected from longitude');
  assert.equal(JSON.stringify({ natal, moment }), before);
});
