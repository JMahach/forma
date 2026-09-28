import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneRenderer } from '../src/scene/renderer.js';
import { renderBodygraph } from '../src/scene/bodygraph-svg.js';
import { createMandalaPreviewPainter } from '../src/scene/mandala-preview-painter.js';
import { crossAtLongitude } from '../src/domain/mandala-cross.js';
import { PLANETS } from '../src/domain/planets.js';
import { gatePositionAtLongitude } from '../src/domain/gate-wheel.js';
import { SVG_NS, SvgElement, svgDocument, significantDOM } from './helpers/svg-dom.mjs';

// Matrix-based heading positioning is measured by the browser parity harness.
SvgElement.prototype.getCTM = () => null;
function chartAt(tick = 0) {
  const activations = Object.fromEntries(['design', 'personality'].map((source, side) => [source,
    PLANETS.map(([planet], index) => ({ planet, ...gatePositionAtLongitude((index * 23 + side * 143 + tick * .01) % 360) }))]));
  return { source: 'calculated', activations,
    personality: [...new Set(activations.personality.map(entry => entry.gate))],
    design: [...new Set(activations.design.map(entry => entry.gate))] };
}
function fixture() {
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
  return { document, root, renderer: createSceneRenderer(root) };
}
function assertRendered(root, chart, selection, options) {
  const expected = fixture().root;
  expected.innerHTML = renderBodygraph(chart, selection, options);
  assert.deepEqual(significantDOM(root), significantDOM(expected));
}
function assertSameNodes(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((node, index) => assert.equal(node, expected[index], `node ${index} retains identity`));
}

test('first mount parses one complete SVG, adopts its caches and retains every initial node on an identical update', () => {
  for (const mode of [{}, { showMandala: true }, { showMandalaLayer: true }]) {
    const h = fixture(), chart = chartAt();
    const options = { showBackdrop: true, showLotus: true, showActivations: true, ...mode };
    h.renderer.update(chart, null, options);
    assert.equal(h.document.parses.length, 1, 'only the complete SVG is parsed');
    assert.equal(h.document.parses[0].target, h.root);
    assertRendered(h.root, chart, null, options);
    const initial = h.root.querySelectorAll('g, path, circle, text, mask');
    h.document.parses.length = 0;
    h.renderer.update(chart, null, options);
    assert.equal(h.document.parses.length, 0, 'the first follow-up does not reparse mounted lanes or masks');
    assertSameNodes(h.root.querySelectorAll('g, path, circle, text, mask'), initial);
    assertRendered(h.root, chart, null, options);
  }
});

test('adopted integration masks and lanes survive unrelated selections and repaint all actual activation changes', () => {
  const h = fixture(), options = { showBackdrop: true };
  let chart = { source: 'manual', personality: [20, 34], design: [10, 57] };
  h.renderer.update(chart, null, options);
  const targets = h.root.querySelectorAll('[data-type]');
  const maskParts = h.root.querySelectorAll('mask path');
  h.document.parses.length = 0;
  const selection = { type: 'gate', id: 41 };
  h.renderer.update(chart, selection, options);
  assert.equal(h.document.parses.length, 1, 'only the newly selected ordinary half-channel is parsed');
  assert.match(h.document.parses[0].markup, /^<g data-highlight-gate="41">/);
  assertSameNodes(h.root.querySelectorAll('mask path'), maskParts);
  assertRendered(h.root, chart, selection, options);
  for (const gates of [[], [10], [10, 20], [10, 20, 34, 57]]) {
    chart = { ...chart, personality: gates, design: gates.toReversed() };
    h.renderer.update(chart, selection, options);
    assertRendered(h.root, chart, selection, options);
    assertSameNodes(h.root.querySelectorAll('[data-type]'), targets);
  }
});

test('decorative mode transitions reuse the body and keep the same complete scene as static SVG', () => {
  const h = fixture(), chart = chartAt();
  const modes = [{}, { showBackdrop: true }, { showLotus: true, showBackdrop: true },
    { showMandalaLayer: true }, { showMandala: true, showActivations: true },
    { showMandala: true, showLotus: true }, { showActivations: true }, {}];
  let targets;
  for (const options of modes) {
    h.renderer.update(chart, null, options);
    const current = h.root.querySelectorAll('.bodygraph-drawing [data-type="gate"]')
      .filter(node => !node.hasAttribute('data-activation'));
    if (targets) assertSameNodes(current, targets);
    else targets = current;
    assertRendered(h.root, chart, null, options);
  }
});

test('full scene restores fast hover after initial mount and after structural remount without touching detached nodes', () => {
  const h = fixture(), chart = chartAt(), start = crossAtLongitude(305.65), moved = crossAtLongitude(305.75);
  const options = { showMandala: true, previewSelection: { type: 'mandala-cross', cross: start } };
  h.renderer.update(chart, null, options);
  const fast = createMandalaPreviewPainter(h.root);
  fast.capture(start);
  assert.equal(fast.update(moved), true);
  h.renderer.update(chart, null, options);
  assertRendered(h.root, chart, null, options);
  const detached = h.root.querySelector('.bodygraph-mandala'), before = significantDOM(detached);
  const changed = { ...options, idPrefix: 'replacement', interactive: false };
  h.document.parses.length = 0;
  h.renderer.update(chart, null, changed);
  assert.equal(h.document.parses.length, 1, 'a structural remount also parses only one complete SVG');
  h.renderer.update(chartAt(1), null, changed);
  assertRendered(h.root, chartAt(1), null, changed);
  assert.deepEqual(significantDOM(detached), before, 'old painter caches do not mutate detached scene nodes');
});

test('clear discards mounted scene caches before a later first render', () => {
  const h = fixture(), chart = chartAt(), options = { showMandala: true, showActivations: true };
  h.renderer.update(chart, null, options);
  const detached = h.root.querySelector('.bodygraph-drawing'), before = significantDOM(detached);
  h.renderer.clear();
  assert.equal(h.root.children.length, 0);
  h.document.parses.length = 0;
  h.renderer.update(chartAt(2), null, options);
  assert.equal(h.document.parses.length, 1);
  assertRendered(h.root, chartAt(2), null, options);
  assert.deepEqual(significantDOM(detached), before);
});
