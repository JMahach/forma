import test from 'node:test';
import assert from 'node:assert/strict';
import { SVG_NS, svgDocument, significantDOM } from './helpers/svg-dom.mjs';
import { createMandalaPainter } from '../src/scene/mandala-painter.js';
import { createMandalaPreviewPainter } from '../src/scene/mandala-preview-painter.js';
import { renderMandala } from '../src/scene/mandala.js';
import { crossAtLongitude } from '../src/domain/mandala-cross.js';
import { PLANETS } from '../src/domain/planets.js';
import { GATE_WIDTH, GATE_LONGITUDE_START, gatePositionAtLongitude } from '../src/domain/gate-wheel.js';

const mandalaGroup = root => root.matches('.bodygraph-mandala') ? root : root.querySelector('.bodygraph-mandala');
function rendered(chart, options = {}) {
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
  root.innerHTML = renderMandala(chart, options);
  return { root, document, group: mandalaGroup(root) };
}
function assertRendered(root, chart, options = {}) {
  assert.deepEqual(significantDOM(mandalaGroup(root)), significantDOM(rendered(chart, options).group));
}
function harness(chart = {}, options = {}, { groupRoot = false } = {}) {
  const fixture = rendered(chart, options);
  const root = groupRoot ? fixture.group : fixture.root;
  fixture.document.parses.length = 0;
  return { ...fixture, root, painter: createMandalaPainter(root) };
}
function staticNodes(group) {
  return ['.mandala-gate', '.mandala-gate-highlight', '.mandala-separator', '.mandala-number',
    '.mandala-well', '.mandala-engraving-light', '.mandala-engraving-edge']
    .flatMap(selector => group.querySelectorAll(selector));
}
function assertStaticNodes(group, expected) {
  const actual = staticNodes(group);
  assert.equal(actual.length, expected.length);
  actual.forEach((node, index) => assert.equal(node, expected[index], `static SVG node ${index} retains identity`));
}
function assertNoSceneParse(document) {
  for (const { markup } of document.parses) assert.doesNotMatch(markup,
    /class="[^"]*\b(?:bodygraph-mandala|mandala-gate|mandala-engraving-light)\b/,
    'normal update may parse a small cross overlay but never the wheel or its 64 gate cells');
}
function chartAt(tick = 0) {
  const activations = Object.fromEntries(['design', 'personality'].map((source, side) => [source,
    PLANETS.map(([planet], index) => ({ planet, ...gatePositionAtLongitude(
      (GATE_LONGITUDE_START + (index + side * 13) * GATE_WIDTH + 0.25 + tick / 1000) % 360) }))]));
  return { id: 'same-chart-id', source: 'calculated', activations,
    design: [...new Set(activations.design.map(entry => entry.gate))],
    personality: [...new Set(activations.personality.map(entry => entry.gate))] };
}
function rayNodes(group) {
  return new Map(group.querySelectorAll('.mandala-planet-marker').map(marker => [
    `${marker.getAttribute('data-source')}:${marker.getAttribute('data-mandala-planet')}`,
    [marker, marker.querySelector('.mandala-planet-ray'), marker.querySelector('.mandala-planet-endpoint')],
  ]));
}

test('persistent mandala matches every gate state, selection and interactive transition without replacing static nodes', () => {
  const h = harness(), original = staticNodes(h.group);
  assert.equal(h.group.querySelectorAll('.mandala-gate').length, 64);
  for (let step = 0; step < 8; step++) {
    const ids = Array.from({ length: 64 }, (_, index) => index + 1);
    const chart = { source: 'manual', design: ids.filter(id => [1, 3].includes((id + step) % 4)),
      personality: ids.filter(id => [2, 3].includes((id + step) % 4)) };
    const selectedGates = new Set(ids.filter(id => (id + step) % 7 === 0));
    const options = { interactive: step % 3 === 0, selectedGates,
      relatedGates: new Set([...selectedGates, ...ids.filter(id => (id + step) % 11 === 0)]) };
    assert.equal(h.painter.update(chart, options), true);
    assertRendered(h.root, chart, options);
    assertStaticNodes(h.group, original);
    assertNoSceneParse(h.document);
  }
  const selectedGates = new Set([1, 20, 64]);
  assert.equal(h.painter.update({}, { selectedGates }), true);
  assertRendered(h.root, {}, { selectedGates });
  assert.equal(h.group.querySelectorAll('[tabindex="0"]').length, 64, 'default interactive mode restores all gate targets');
});

test('every delivered longitude updates all 26 existing ray nodes even when chart id, gates and lines stay unchanged', () => {
  const initial = chartAt(), h = harness(initial), originalStatic = staticNodes(h.group), originalRays = rayNodes(h.group);
  assert.equal(originalRays.size, 26);
  const delivered = Array.from({ length: 32 }, (_, index) => index + 1), received = [];
  const gateLines = chart => ['design', 'personality'].flatMap(source => chart.activations[source].map(({ gate, line }) => [gate, line]));
  for (const tick of delivered) {
    const chart = chartAt(tick);
    assert.deepEqual(gateLines(chart), gateLines(initial));
    assert.equal(h.painter.update(chart), true);
    const actualRays = rayNodes(h.group);
    for (const [key, originals] of originalRays) originals.forEach((node, index) => assert.equal(actualRays.get(key)[index], node, `${key} part ${index} is reused`));
    received.push(Number(actualRays.get('personality:sun')[0].getAttribute('data-longitude')));
    assertRendered(h.root, chart);
    assertStaticNodes(h.group, originalStatic);
  }
  assert.deepEqual(received, delivered.map(tick => chartAt(tick).activations.personality[0].longitude), 'no intermediate input is dropped');
  assertNoSceneParse(h.document);
});

test('invalid, duplicated, missing and recovered planets match the renderer without leaving stale rays', () => {
  const initial = chartAt(), h = harness(initial), staticBefore = staticNodes(h.group);
  const duplicate = structuredClone(initial);
  duplicate.activations.personality.push({ ...duplicate.activations.personality[0] });
  const invalid = structuredClone(initial);
  invalid.activations.design[0].longitude = NaN;
  invalid.activations.design[1].longitude = 360;
  invalid.activations.design[2].longitude = -1;
  invalid.activations.design[3].gate = invalid.activations.design[3].gate === 64 ? 1 : 64;
  invalid.activations.design[4].line = invalid.activations.design[4].line === 6 ? 1 : 6;
  const missing = structuredClone(initial);
  missing.activations.design = [];
  missing.activations.personality = missing.activations.personality.filter(entry => entry.planet !== 'moon');
  for (const chart of [duplicate, invalid, missing, { ...initial, source: 'transit' },
    { ...initial, source: 'manual' }, { ...initial, activations: {} }, initial]) {
    assert.equal(h.painter.update(chart), true);
    assertRendered(h.root, chart);
    assertStaticNodes(h.group, staticBefore);
  }
  assert.equal(rayNodes(h.group).size, 26, 'recovery restores every valid source and planet');
  assertNoSceneParse(h.document);
});

test('pinned and moving crosses preserve renderer order, source, category and exact-overlap suppression', () => {
  const chart = chartAt(), h = harness(chart), original = staticNodes(h.group);
  const first = crossAtLongitude(305.65), second = crossAtLongitude(30), design = crossAtLongitude(217.7, { source: 'design' });
  const variants = [
    { previewCross: first },
    { pinnedCrosses: [first], previewCross: first },
    { pinnedCrosses: [first], previewCross: crossAtLongitude(305.75) },
    { pinnedCrosses: [second, first], previewCross: design },
    { pinnedCrosses: [first, second], previewCross: crossAtLongitude(0) },
    { pinnedCrosses: [design], previewCross: design },
    { pinnedCrosses: [first], previewCross: { ...first, type: 'invalid' } },
    { pinnedCrosses: [], previewCross: null },
  ];
  for (const options of variants) {
    assert.equal(h.painter.update(chart, options), true);
    assertRendered(h.root, chart, options);
    assertStaticNodes(h.group, original);
  }
  assertNoSceneParse(h.document);
});

test('a normal update restores an overlay changed by the external fast preview painter despite identical requested signature', () => {
  const chart = chartAt(), first = crossAtLongitude(305.65), moved = crossAtLongitude(305.75);
  const options = { previewCross: first }, h = harness(chart, options);
  assert.equal(h.painter.update(chart, options), true);
  const fast = createMandalaPreviewPainter(h.root);
  fast.capture(first);
  assert.equal(fast.update(moved), true);
  assertRendered(h.root, chart, { previewCross: moved });
  assert.equal(h.painter.update(chart, options), true, 'requested snapshot wins over a stale memo of its prior application');
  assertRendered(h.root, chart, options);
  assertNoSceneParse(h.document);
});

test('cross motion within a quartet updates its existing marks and preserves raw source overlap semantics', () => {
  const chart = chartAt(), start = crossAtLongitude(305.65), h = harness(chart, { previewCross: start });
  const group = h.group.querySelector('.mandala-cross-preview');
  const marks = [group, ...group.querySelectorAll('g'), ...group.querySelectorAll('path'), ...group.querySelectorAll('circle')];
  for (const longitude of [305.7, 305.75, 306, 307]) {
    const options = { previewCross: crossAtLongitude(longitude) };
    assert.equal(h.painter.update(chart, options), true);
    assert.equal(h.group.querySelector('.mandala-cross-preview'), group);
    for (const mark of marks) assert.equal(group.contains(mark), true);
    assertRendered(h.root, chart, options);
  }
  const sourceOmitted = { ...start };
  delete sourceOmitted.source;
  for (const options of [
    { pinnedCrosses: [start], previewCross: sourceOmitted },
    { pinnedCrosses: [sourceOmitted], previewCross: start },
    { pinnedCrosses: [sourceOmitted], previewCross: sourceOmitted },
  ]) {
    assert.equal(h.painter.update(chart, options), true);
    assertRendered(h.root, chart, options);
  }
  assertNoSceneParse(h.document);
});

test('painter recaptures a replaced mandala group and returns false while no wheel exists', () => {
  const emptyDocument = svgDocument(), root = emptyDocument.createElementNS(SVG_NS, 'svg');
  const painter = createMandalaPainter(root);
  assert.equal(painter.update(chartAt()), false);
  root.innerHTML = renderMandala(chartAt());
  const first = mandalaGroup(root);
  assert.equal(painter.update(chartAt(1)), true);
  assertRendered(root, chartAt(1));
  root.innerHTML = renderMandala({}, { interactive: false });
  const second = mandalaGroup(root), secondStatic = staticNodes(second), staleSnapshot = significantDOM(first);
  assert.notEqual(second, first);
  emptyDocument.parses.length = 0;
  const options = { selectedGates: new Set([1, 64]), previewCross: crossAtLongitude(30) };
  assert.equal(painter.update(chartAt(2), options), true);
  assertRendered(root, chartAt(2), options);
  assertStaticNodes(second, secondStatic);
  assert.deepEqual(significantDOM(first), staleSnapshot, 'detached cached nodes are not mutated');
  assertNoSceneParse(emptyDocument);
  second.remove();
  assert.equal(painter.update(chartAt(3)), false);
});

test('reset recaptures replaced descendants inside the same group, including when that group itself is the root', () => {
  for (const groupRoot of [false, true]) {
    const h = harness(chartAt(), {}, { groupRoot });
    assert.equal(h.painter.update(chartAt(1)), true);
    const oldGate = h.group.querySelector('.mandala-gate');
    h.group.innerHTML = rendered({}, { interactive: false }).group.innerHTML;
    // Copy the outer group's current flags as a structural renderer rebuild would.
    h.group.setAttribute('aria-hidden', 'true');
    h.group.setAttribute('pointer-events', 'none');
    h.group.setAttribute('focusable', 'false');
    const rebuilt = staticNodes(h.group);
    assert.notEqual(rebuilt[0], oldGate);
    h.document.parses.length = 0;
    h.painter.reset();
    const options = { relatedGates: new Set([25, 46]), previewCross: crossAtLongitude(359.99) };
    assert.equal(h.painter.update(chartAt(2), options), true);
    assertRendered(h.root, chartAt(2), options);
    assertStaticNodes(h.group, rebuilt);
    assertNoSceneParse(h.document);
  }
});

test('display changes and input snapshots stay caller-owned, including reused mutable option sets', () => {
  const chart = chartAt(), options = { selectedGates: new Set([1]), relatedGates: new Set([1, 2]), pinnedCrosses: [] };
  const before = structuredClone(chart), h = harness();
  assert.equal(h.painter.update(chart, options), true);
  options.selectedGates.clear(); options.selectedGates.add(64);
  options.relatedGates.clear(); options.relatedGates.add(64);
  options.pinnedCrosses.push(crossAtLongitude(0));
  assert.equal(h.painter.update(chart, options), true);
  assertRendered(h.root, chart, options);
  assert.deepEqual(chart, before, 'painting cannot change chart activations or gate arrays');
  assert.deepEqual([...options.selectedGates], [64]);
  assert.deepEqual([...options.relatedGates], [64]);
  assert.equal(options.pinnedCrosses.length, 1);
});
