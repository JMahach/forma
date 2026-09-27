import test from 'node:test';
import assert from 'node:assert/strict';
import { SVG_NS, svgDocument, significantDOM } from './helpers/svg-dom.mjs';
import { renderBodygraph } from '../src/scene/bodygraph-svg.js';
import { createRenderState } from '../src/scene/render-state.js';
import { createBodygraphPainter } from '../src/scene/bodygraph-painter.js';
import { GATES } from '../src/domain/topology.js';
import { crossAtLongitude } from '../src/domain/mandala-cross.js';

function render(chart, selection, options) {
  const document = svgDocument();
  const root = document.createElementNS(SVG_NS, 'svg');
  root.innerHTML = renderBodygraph(chart, selection, options);
  return { root, document };
}

function assertEquivalent(actual, expected) {
  for (const selector of ['.bodygraph-drawing', 'defs']) {
    assert.deepEqual(significantDOM(actual.querySelector(selector)), significantDOM(expected.querySelector(selector)), selector);
  }
}

test('persistent body paint matches the static renderer across activations, previews and integration masks', () => {
  const initial = { design: [], personality: [] };
  const { root } = render(initial, null, {});
  const painter = createBodygraphPainter(root);
  const targets = [...root.querySelectorAll('[data-type]')];
  const scenarios = [
    { selection: null, options: {} },
    { selection: { type: 'gate', id: 20 }, options: {} },
    { selection: { type: 'channel', id: '57-20' }, options: { dimInactive: true } },
    { selection: { type: 'center', id: 'g' }, options: {} },
    { selection: { type: 'integration', id: 'integration' }, options: { dimInactive: true } },
    { selection: null, options: { selections: [{ type: 'gate', id: 10 }, { type: 'gate', id: 20 }, { type: 'gate', id: 34 }] } },
    { selection: { type: 'gate', id: 10 }, options: { previewSelection: { type: 'gate', id: 57 } } },
    { selection: null, options: { selections: [], previewSelection: { type: 'mandala-cross', cross: crossAtLongitude(302.1) } } },
    { selection: null, options: { selections: GATES.filter(gate => gate.center === 'root').map(gate => ({ type: 'gate', id: gate.id })) } },
    { selection: null, options: { selections: [], dimInactive: true } },
  ];
  for (let step = 0; step < 30; step++) {
    const chart = { source: 'manual',
      design: GATES.filter(({ id }) => [0, 1].includes((id + step) % 4)).map(gate => gate.id),
      personality: GATES.filter(({ id }) => [1, 2].includes((id + step) % 4)).map(gate => gate.id) };
    const { selection, options } = scenarios[step % scenarios.length];
    assert.equal(painter.update(createRenderState(chart, selection, options), options), true);
    assertEquivalent(root, render(chart, selection, options).root);
    const current = [...root.querySelectorAll('[data-type]')];
    assert.equal(current.length, targets.length);
    current.forEach((node, index) => assert.equal(node, targets[index], 'gate, center and channel targets retain focus identity'));
  }
  painter.update(createRenderState(initial, null, {}));
  assertEquivalent(root, render(initial, null, {}).root);
});

test('repeated body facts do not parse any paths or masks and do not replace targets', () => {
  const chart = { design: [10, 34], personality: [20, 57] }, options = { dimInactive: true };
  const { root, document } = render(chart, null, options);
  const painter = createBodygraphPainter(root);
  painter.update(createRenderState(chart, null, options), options);
  document.parses.length = 0;
  const snapshot = significantDOM(root);
  for (let i = 0; i < 10; i++) assert.equal(painter.update(createRenderState(chart, null, options), options), false);
  assert.deepEqual(document.parses, []);
  assert.deepEqual(significantDOM(root), snapshot);
});
