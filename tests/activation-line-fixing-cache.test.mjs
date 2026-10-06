import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector';
import { promisify } from 'node:util';
import { createSceneRenderer } from '../src/scene/renderer.js';
import { describeActivationColumns } from '../src/scene/activation-columns.js';
import { createTransitPlanetFilter } from '../src/state/transit-planets.js';
import { PLANETS } from '../src/domain/planets.js';
import { gatePositionAtLongitude } from '../src/domain/gate-wheel.js';
import { SVG_NS, SvgElement, svgDocument } from './helpers/svg-dom.mjs';

SvgElement.prototype.getCTM = () => null;
const activation = (planet, gate, line) => ({ planet, gate, line });
const fixing = (chart, planet = 'pluto') => describeActivationColumns(chart)
  .find(column => column.source === 'personality')?.rows.find(row => row.planet === planet)?.fixing;

test('selection-only scene updates reuse line fixings while exact chart values remain unchanged', async () => {
  const session = new Session(); session.connect();
  const post = promisify(session.post.bind(session));
  try {
    await post('Profiler.enable');
    await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
    const activations = Object.fromEntries(['design', 'personality'].map((source, side) => [source,
      PLANETS.map(([planet], index) => ({ planet, ...gatePositionAtLongitude((index * 23 + side * 143) % 360) }))]));
    const chart = { source: 'calculated', activations,
      personality: [...new Set(activations.personality.map(row => row.gate))],
      design: [...new Set(activations.design.map(row => row.gate))] };
    const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
    const renderer = createSceneRenderer(root), options = { showActivations: true, selections: [] };
    renderer.update(chart, null, options);
    const numericTarget = root.querySelector('[data-activation="personality-sun"]');
    await post('Profiler.takePreciseCoverage');
    for (let index = 0; index < 100; index++) {
      renderer.update(index % 2 ? structuredClone(chart) : chart, null,
        { ...options, previewSelection: { type: 'gate', id: index % 2 ? 19 : 41 } });
    }
    const { result } = await post('Profiler.takePreciseCoverage');
    const script = result.find(script => script.url.endsWith('/src/domain/line-fixing.js'));
    const calls = script?.functions.find(fn => fn.functionName === 'calculateLineFixings')?.ranges[0].count || 0;
    assert.equal(calls, 0, 'hover must not recalculate chart-only line fixings');
    assert.equal(root.querySelector('[data-activation="personality-sun"]'), numericTarget);
  } finally {
    await post('Profiler.stopPreciseCoverage');
    session.disconnect();
  }
});

test('same-object changes to rulers, lines and duplicate planets invalidate fixing values', () => {
  const chart = { activations: { personality: [activation('pluto', 43, 2), activation('moon', 23, 1)], design: [] } };
  assert.equal(fixing(chart), 'juxtaposed');
  chart.activations.personality[1].gate = 1;
  assert.equal(fixing(chart), 'exalted');
  chart.activations.personality[0].planet = 'sun';
  assert.equal(fixing(chart, 'sun'), 'none');
  chart.activations.personality[0] = activation('pluto', 43, 2);
  assert.equal(fixing(chart), 'exalted');
  chart.activations.personality.push(activation('pluto', 43, 2));
  assert.equal(fixing(chart), undefined, 'duplicate planet cannot supply a fixing');
  chart.activations.personality.pop();
  chart.activations.personality[0].line = 0;
  assert.equal(fixing(chart), undefined, 'invalid line removes its row');
  chart.activations.personality[0].line = 2;
  assert.equal(fixing(chart), 'exalted');
});

test('a transit filter change removes the hidden ruler from cached fixing contributors', () => {
  const chart = { source: 'transit', activations: {
    personality: [activation('venus', 39, 6)], design: [activation('sun', 55, 2)] } };
  const filter = createTransitPlanetFilter();
  filter.setExpanded(true); filter.setPlanet('sun', true, 'design');
  const sun = () => describeActivationColumns(filter.filter(chart))
    .find(column => column.source === 'design').rows.find(row => row.planet === 'sun');
  assert.equal(sun().fixing, 'exalted');
  filter.setPlanet('venus', false);
  assert.equal(sun().fixing, 'none');
  filter.setPlanet('venus', true);
  assert.equal(sun().fixing, 'exalted');
});
