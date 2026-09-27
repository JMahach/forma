import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivationPainter } from '../src/scene/activation-painter.js';
import { renderActivationColumns } from '../src/scene/activation-columns.js';
import { createRenderState } from '../src/scene/render-state.js';
import { PLANETS } from '../src/domain/planets.js';
import { gatePositionAtLongitude } from '../src/domain/gate-wheel.js';
import { SVG_NS, SvgElement, svgDocument, significantDOM } from './helpers/svg-dom.mjs';

// These node tests compare SVG values and identity. Pixel bounds are covered by
// the browser parity harness, so unavailable SVG matrices simply skip alignment.
SvgElement.prototype.getCTM = () => null;
const options = { showActivations: true };
function chartAt(tick = 0, overrides = {}) {
  const activations = Object.fromEntries(['design', 'personality'].map((source, side) => [source,
    PLANETS.map(([planet], index) => ({ planet, ...gatePositionAtLongitude((index * 23 + side * 143 + tick * 0.31) % 360) }))]));
  return { source: 'calculated', activations,
    personality: [...new Set(activations.personality.map(entry => entry.gate))],
    design: [...new Set(activations.design.map(entry => entry.gate))], ...overrides };
}
function markup(chart, state, opt) {
  return opt.showActivations ? renderActivationColumns(chart, state.relatedGates, state.committedSelection, {
    pressedGates: state.committedGates, pressedSelection: state.committedSelection,
    selections: state.visualSelections, pressedSelections: state.committedSelections,
    activationFilter: opt.activationFilter, previewGates: state.previewGates,
  }) : '';
}
function fixture(chart = chartAt(), selection = null, opt = options) {
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
  const state = createRenderState(chart, selection, opt);
  root.innerHTML = `<g class="bodygraph-drawing">${markup(chart, state, opt)}</g>`;
  return { document, root };
}
function assertEquivalent(root, chart, selection = null, opt = options) {
  assert.deepEqual(significantDOM(root.querySelector('.bodygraph-drawing')), significantDOM(fixture(chart, selection, opt).root.querySelector('.bodygraph-drawing')));
}
function update(painter, chart, selection = null, opt = options) { painter.update(chart, createRenderState(chart, selection, opt), opt); }
const targets = root => new Map(root.querySelectorAll('[data-activation]').map(node => [node.dataset.activation, node]));

test('all planetary and numeric targets survive a hundred exact minute changes with the same SVG as full rendering', () => {
  const h = fixture(), painter = createActivationPainter(h.root), initial = targets(h.root);
  update(painter, chartAt()); h.document.parses.length = 0;
  for (let tick = 1; tick <= 100; tick++) {
    const chart = chartAt(tick); update(painter, chart); assertEquivalent(h.root, chart);
    for (const [id, node] of initial) assert.equal(targets(h.root).get(id), node, id);
  }
  for (const parse of h.document.parses) assert.doesNotMatch(parse.markup, /activation-row|activation-column|bg-activation/, 'only a newly appearing decorative fixing may be parsed');
});

test('gate, planet, preview and filtered line selections update paint and ARIA without replacing targets', () => {
  const chart = chartAt(), h = fixture(chart), painter = createActivationPainter(h.root), initial = targets(h.root);
  const gate = chart.activations.design[0].gate, line = chart.activations.design[0].line;
  const cases = [
    [{ type: 'gate', id: gate }, {}],
    [{ type: 'planet', id: 'personality-sun' }, {}],
    [{ type: 'gate', id: gate }, { activationFilter: { groups: [{ source: 'design', line, gates: [gate] }], unfilteredGates: [] } }],
    [{ type: 'gate', id: gate }, { previewSelection: { type: 'center', id: 'root' } }],
    [null, {}],
  ];
  for (const [selection, extra] of cases) {
    const opt = { ...options, ...extra }; update(painter, chart, selection, opt); assertEquivalent(h.root, chart, selection, opt);
    for (const [id, node] of initial) assert.equal(targets(h.root).get(id), node);
  }
});

test('a missing or invalid planet removes only its row; source transitions preserve all surviving targets', () => {
  const base = chartAt(), h = fixture(base), painter = createActivationPainter(h.root), initial = targets(h.root);
  const changed = { ...base, activations: { ...base.activations, design: base.activations.design.map(row => row.planet === 'moon' ? { ...row, gate: -1 } : row) } };
  update(painter, changed); assertEquivalent(h.root, changed);
  assert.equal(targets(h.root).has('design-moon'), false);
  for (const [id, node] of initial) if (!id.startsWith('design-moon')) assert.equal(targets(h.root).get(id), node);
  update(painter, base); assertEquivalent(h.root, base);
  assert.notEqual(targets(h.root).get('design-moon'), initial.get('design-moon'));
  const transit = { ...base, source: 'transit', design: [], activations: { design: [], personality: base.activations.personality } };
  update(painter, transit); assertEquivalent(h.root, transit);
  for (const [id, node] of initial) if (id.startsWith('personality-')) assert.equal(targets(h.root).get(id), node);
  update(painter, base); assertEquivalent(h.root, base);
  for (const [id, node] of initial) if (id.startsWith('personality-')) assert.equal(targets(h.root).get(id), node);
  update(painter, { personality: [], design: [] }); assert.equal(targets(h.root).size, 0);
  update(painter, base); assertEquivalent(h.root, base);
});

test('column visibility creates or removes only column DOM without needing a scene remount', () => {
  const base = chartAt(), h = fixture(base, null, { showActivations: false }), painter = createActivationPainter(h.root), drawing = h.root.firstElementChild;
  update(painter, base); assertEquivalent(h.root, base);
  update(painter, base, null, { showActivations: false }); assertEquivalent(h.root, base, null, { showActivations: false });
  assert.equal(h.root.firstElementChild, drawing);
  update(painter, base); assertEquivalent(h.root, base); assert.equal(h.root.firstElementChild, drawing);
});

test('selection and other planets do not remeasure the Personality heading; a new Sun value does', () => {
  const base = chartAt(), h = fixture(base), painter = createActivationPainter(h.root);
  const heading = h.root.querySelector('.activation-column[data-source="personality"]').querySelector('.activation-heading');
  let reads = 0; heading.getCTM = () => { reads++; return null; };
  update(painter, base); assert.equal(reads, 1);
  update(painter, base, { type: 'center', id: 'root' }); assert.equal(reads, 1);
  const moon = { ...base, activations: { ...base.activations, personality: base.activations.personality.map(row => row.planet === 'moon' ? { ...row, line: row.line % 6 + 1 } : row) } };
  update(painter, moon); assert.equal(reads, 1);
  const sun = { ...base, activations: { ...base.activations, personality: base.activations.personality.map(row => row.planet === 'sun' ? { ...row, line: row.line % 6 + 1 } : row) } };
  update(painter, sun); assert.equal(reads, 2);
});
