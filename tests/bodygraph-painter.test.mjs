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

const focusMasks = root => root.querySelectorAll('mask').filter(node => node.id.includes('-integration-focus-'));
function assertSameChildren(masks, children) {
  masks.forEach((node, index) => {
    assert.equal(node.childNodes.length, children[index].length);
    node.childNodes.forEach((child, position) => assert.equal(child, children[index][position], 'mask child retains identity'));
  });
}

test('integration hover and selection retain focus-mask children through adopted and fresh painter mounts', () => {
  const chart = { design: [10, 34], personality: [20, 57] };
  const scenarios = [
    { previewSelection: { type: 'gate', id: 20 } },
    { previewSelection: { type: 'gate', id: 10 } },
    { previewSelection: { type: 'center', id: 'sacral' } },
    { selections: [{ type: 'channel', id: '20-34' }] },
    { selections: [{ type: 'integration', id: 'integration' }], dimInactive: true },
    { selections: [{ type: 'gate', id: 20 }], previewSelection: { type: 'gate', id: 57 } },
    {},
  ];
  for (const adopted of [false, true]) for (const idPrefix of ['bodygraph', 'remounted']) {
    const options = { idPrefix }, { root, document } = render(chart, null, options);
    const initialState = createRenderState(chart, null, options);
    const painter = createBodygraphPainter(root, adopted ? initialState : null, options);
    if (!adopted) painter.update(initialState, options);
    const masks = focusMasks(root);
    assert.equal(masks.length, 6);
    const children = masks.map(node => [...node.childNodes]);
    for (const scenario of scenarios) {
      const nextOptions = { ...options, ...scenario };
      document.parses.length = 0;
      painter.update(createRenderState(chart, null, nextOptions), nextOptions);
      assertEquivalent(root, render(chart, null, nextOptions).root);
      assert.equal(document.parses.filter(entry => masks.includes(entry.target)).length, 0,
        'selection changes never parse a fixed focus route');
      assertSameChildren(masks, children);
    }
  }
});

test('focus masks follow every inactive, personality, design and dual-source integration combination', () => {
  const integrationGates = [20, 10, 34, 57];
  const initial = { personality: [], design: [] }, baseOptions = { idPrefix: 'activation-mask' };
  const { root, document } = render(initial, null, baseOptions);
  const painter = createBodygraphPainter(root, createRenderState(initial, null, baseOptions), baseOptions);
  const masks = focusMasks(root);
  let previousActive = '', previousChildren = masks.map(node => [...node.childNodes]);
  for (let combination = 0; combination < 256; combination++) {
    const chart = { personality: [], design: [] };
    integrationGates.forEach((gate, index) => {
      const state = combination >> (index * 2) & 3;
      if (state & 1) chart.personality.push(gate);
      if (state & 2) chart.design.push(gate);
    });
    const active = integrationGates.filter(gate => chart.personality.includes(gate) || chart.design.includes(gate)).join(',');
    const options = { ...baseOptions, dimInactive: Boolean(combination % 2),
      selections: [{ type: 'gate', id: integrationGates[combination % 4] }],
      previewSelection: { type: 'gate', id: integrationGates[(combination + 1) % 4] } };
    document.parses.length = 0;
    painter.update(createRenderState(chart, null, options), options);
    assertEquivalent(root, render(chart, null, options).root);
    if (active === previousActive) {
      assert.equal(document.parses.filter(entry => masks.includes(entry.target)).length, 0,
        'changing personality/design ownership alone cannot change an occlusion mask');
      assertSameChildren(masks, previousChildren);
    }
    previousActive = active;
    previousChildren = masks.map(node => [...node.childNodes]);
  }
});
