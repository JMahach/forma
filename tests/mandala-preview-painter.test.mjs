import test from 'node:test';
import assert from 'node:assert/strict';
import { createMandalaPreviewPainter } from '../src/bodygraph/mandala-preview-painter.js';
import { createGraphController } from '../src/bodygraph/graph-controller.js';
import { crossAtLongitude } from '../src/bodygraph/mandala-cross.js';
import { renderMandala } from '../src/bodygraph/mandala.js';
import { renderBodygraph } from '../src/bodygraph/bodygraph.js';

// Minimal SVG DOM: preserve attributes, descendants and node identity. Actual
// renderer markup supplies the fixtures rather than a second drawing template.
class SvgNode {
  constructor(tag = 'svg', attributes = {}) { this.tag = tag; this.attributes = { ...attributes }; this.children = []; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  querySelectorAll(selector) {
    const matches = node => selector.startsWith('.') ? (node.attributes.class || '').split(' ').includes(selector.slice(1)) : node.tag === selector;
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  set innerHTML(markup) {
    this.children = [];
    this.markup = markup;
    const stack = [this];
    for (const [, closing, tag, raw] of markup.matchAll(/<(\/)?([a-zA-Z][\w-]*)([^>]*)>/g)) {
      if (closing) { stack.pop(); continue; }
      const attributes = Object.fromEntries([...raw.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
      const node = new SvgNode(tag, attributes);
      stack.at(-1).children.push(node);
      if (!raw.trimEnd().endsWith('/')) stack.push(node);
    }
  }
  get innerHTML() { return this.markup; }
  snapshot() { return [this.tag, this.attributes, this.children.map(child => child.snapshot())]; }
}

const preview = (longitude, source = 'personality') => ({ type: 'mandala-cross', id: longitude, cross: crossAtLongitude(longitude, { source }) });
function wheel(cross, pinnedCrosses = []) {
  const viewport = new SvgNode();
  viewport.innerHTML = renderMandala({}, { previewCross: cross, pinnedCrosses });
  return viewport;
}

test('moving within one quartet exactly matches the full SVG while preserving every node', () => {
  const initial = preview(305.65).cross, viewport = wheel(initial);
  const painter = createMandalaPreviewPainter(viewport);
  painter.capture(initial);
  const original = viewport.querySelector('.mandala-cross-preview');
  const staticRing = viewport.querySelector('.mandala-gate');
  for (const longitude of [305.7, 305.75, 306, 307]) {
    const cross = preview(longitude).cross;
    assert.equal(painter.update(cross), true);
    assert.equal(viewport.querySelector('.mandala-cross-preview'), original);
    assert.equal(viewport.querySelector('.mandala-gate'), staticRing);
    assert.deepEqual(viewport.snapshot(), wheel(cross).snapshot());
  }
});

test('wraparound and either cursor source retain full-render geometry and attributes', () => {
  for (const [source, start, end] of [['personality', 359.99, 0], ['design', 271.99, 272]]) {
    const viewport = wheel(preview(start, source).cross), painter = createMandalaPreviewPainter(viewport);
    painter.capture(preview(start, source).cross);
    assert.equal(painter.update(preview(end, source).cross), true);
    assert.deepEqual(viewport.snapshot(), wheel(preview(end, source).cross).snapshot());
  }
});

test('a changed gate tuple or cursor source refuses the fast path without painting', () => {
  const start = preview(305.7).cross, viewport = wheel(start), painter = createMandalaPreviewPainter(viewport);
  painter.capture(start);
  const before = viewport.snapshot();
  for (const cross of [preview(305.55).cross, preview(217.7, 'design').cross]) {
    assert.equal(painter.update(cross), false);
    assert.deepEqual(viewport.snapshot(), before);
  }
});

test('invalid or incomplete input never partially patches the overlay', () => {
  const start = preview(305.7).cross, viewport = wheel(start), painter = createMandalaPreviewPainter(viewport);
  painter.capture(start);
  const before = viewport.snapshot();
  for (const cross of [null, {}, { ...start, type: 'unknown' }, { ...start, gates: [] },
    { ...start, source: '' }, { ...start, positions: { length: 4 } },
    { ...start, positions: start.positions.map(p => ({ ...p, longitude: NaN })) },
    { ...start, positions: start.positions.map(p => ({ ...p, planet: 'moon' })) },
  ]) {
    assert.equal(painter.update(cross), false);
    assert.deepEqual(viewport.snapshot(), before);
  }
});

test('detached overlay descendants invalidate cached references', () => {
  for (const selector of ['.mandala-cross-preview', '.mandala-cross-preview-ray', 'circle', '.mandala-cross-cursor']) {
    const start = preview(305.7).cross, viewport = wheel(start), painter = createMandalaPreviewPainter(viewport);
    painter.capture(start);
    const group = viewport.querySelector('.mandala-cross-preview');
    const target = selector === '.mandala-cross-preview' ? group : group.querySelector(selector);
    function remove(parent) {
      parent.children = parent.children.filter(child => child !== target);
      parent.children.forEach(remove);
    }
    remove(viewport);
    assert.equal(painter.update(preview(305.75).cross), false, selector);
  }
});

test('pinned overlap and absent or explicitly cleared caches require a full render', () => {
  const initial = preview(305.7).cross, pinned = preview(305.75).cross;
  const viewport = wheel(initial, [pinned]), painter = createMandalaPreviewPainter(viewport);
  assert.equal(painter.update(initial), false);
  painter.capture(initial, [pinned]);
  assert.equal(painter.update(pinned, [pinned]), false, 'entering exact pinned overlap must remove the preview');
  viewport.innerHTML = renderMandala({}, { previewCross: pinned, pinnedCrosses: [pinned] });
  painter.capture(pinned, [pinned]);
  assert.equal(painter.update(initial, [pinned]), false, 'leaving a suppressed preview must create its nodes');
  viewport.innerHTML = renderMandala({}, { previewCross: initial });
  painter.capture(initial);
  painter.clear();
  assert.equal(painter.update(initial), false);
});

function graphHarness() {
  const viewport = new SvgNode();
  const state = { chart: { id: 'test', personality: [20, 34], design: [10, 57] }, current: preview(305.65), enabled: true, hasChart: true };
  const calls = { render: 0, align: 0, summary: 0, layout: 0, popover: 0 };
  const controller = createGraphController({
    viewport, getChart: () => state.chart, hasChart: () => state.hasChart,
    getHoverPreview: () => ({ currentSelection: state.current, clear() { state.current = null; } }),
    getMandala: () => ({ enabled: state.enabled }),
    getSummary: () => ({ update() { calls.summary++; }, layout() { calls.layout++; } }),
    activationPopover: { close() {}, refresh() { calls.popover++; }, show() {} },
    alignHeading() { calls.align++; },
    renderChart(...args) { calls.render++; return renderBodygraph(...args); },
  });
  controller.render();
  return { controller, viewport, state, calls };
}

test('controller fast preview updates only cross marks without redrawing the chart or changing committed selection', () => {
  const { controller, viewport, state, calls } = graphHarness();
  const snapshot = controller.selectionState.items;
  const ring = viewport.querySelector('.mandala-gate');
  state.current = preview(305.75);
  controller.preview();
  assert.deepEqual(calls, { render: 1, align: 1, summary: 1, layout: 1, popover: 1 });
  assert.equal(controller.selectionState.items, snapshot);
  assert.equal(viewport.querySelector('.mandala-gate'), ring);
  const expected = new SvgNode();
  expected.innerHTML = renderBodygraph(state.chart, null, { showMandala: true, showActivations: true, showBackdrop: true, selections: [], pinnedCrosses: [], previewSelection: state.current });
  assert.deepEqual(viewport.snapshot(), expected.snapshot());
});

test('controller falls back after gate change, chart replacement, selection change and mode change', () => {
  for (const mutate of [
    ({ state }) => { state.current = preview(308); },
    ({ state }) => { state.chart = { ...state.chart }; },
    ({ controller }) => controller.selectionState.choose({ type: 'gate', id: 20 }),
    ({ state }) => { state.enabled = false; },
    ({ state }) => { state.current = null; },
    ({ state }) => { state.current = { type: 'gate', id: 41 }; },
    ({ state }) => { state.hasChart = false; },
  ]) {
    const harness = graphHarness();
    mutate(harness);
    harness.controller.preview();
    assert.equal(harness.calls.summary, 2, 'fallback ran the original controller path');
    assert.equal(harness.calls.render, harness.state.hasChart ? 2 : 1);
  }
});

test('controller pinned overlap transitions neither duplicate nor lose the moving preview', () => {
  const { controller, viewport, state, calls } = graphHarness();
  controller.choose(state.current);
  assert.equal(viewport.querySelectorAll('.mandala-cross-pinned').length, 1);
  assert.equal(viewport.querySelector('.mandala-cross-preview'), null);
  const afterPin = calls.render;
  state.current = preview(305.7);
  controller.preview();
  assert.equal(calls.render, afterPin + 1);
  assert.equal(viewport.querySelectorAll('.mandala-cross-preview').length, 1);
  state.current = preview(305.75);
  controller.preview();
  assert.equal(calls.render, afterPin + 1);
  state.current = preview(305.65);
  controller.preview();
  assert.equal(calls.render, afterPin + 2);
  assert.equal(viewport.querySelector('.mandala-cross-preview'), null);
  assert.equal(viewport.querySelectorAll('.mandala-cross-pinned').length, 1);
});

test('ordinary render remains a full redraw and reset invalidates the hover cache', () => {
  const { controller, viewport, state, calls } = graphHarness();
  const ring = viewport.querySelector('.mandala-gate');
  controller.render();
  assert.equal(calls.render, 2);
  assert.notEqual(viewport.querySelector('.mandala-gate'), ring);
  controller.reset();
  state.current = preview(305.7);
  controller.preview();
  assert.equal(calls.render, 3);
});
