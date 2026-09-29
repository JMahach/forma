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
    '.mandala-well', '.mandala-engraving-light', '.mandala-engraving-edge', '.mandala-planet-labels']
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
    [marker, marker.querySelector('.mandala-planet-ray'), marker.querySelector('.mandala-planet-endpoint'), marker.querySelector('.mandala-planet-leader')],
  ]));
}

function symbolNodes(group) {
  return new Map(group.querySelectorAll('.mandala-planet-symbol').map(node => [
    `${node.getAttribute('data-source')}:${node.getAttribute('data-mandala-planet')}`, node,
  ]));
}

function attributeCounts(nodes, callback) {
  let reads = 0, writes = 0;
  const restore = nodes.map(node => {
    const get = node.getAttribute, set = node.setAttribute;
    node.getAttribute = function(...args) { reads++; return get.apply(this, args); };
    node.setAttribute = function(...args) { writes++; return set.apply(this, args); };
    return () => { node.getAttribute = get; node.setAttribute = set; };
  });
  try { callback(); } finally { restore.forEach(reset => reset()); }
  return { reads, writes };
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

test('every delivered longitude updates all 26 persistent rays, leaders and glyphs even when chart id, gates and lines stay unchanged', () => {
  const initial = chartAt(), h = harness(initial), originalStatic = staticNodes(h.group), originalRays = rayNodes(h.group), originalSymbols = symbolNodes(h.group);
  assert.equal(originalRays.size, 26); assert.equal(originalSymbols.size, 26);
  for (const nodes of originalRays.values()) assert.ok(nodes.every(Boolean), 'each marker has a retained leader as well as ray and endpoint');
  const delivered = Array.from({ length: 32 }, (_, index) => index + 1), received = [], receivedLabels = [], labelGeometry = [];
  const gateLines = chart => ['design', 'personality'].flatMap(source => chart.activations[source].map(({ gate, line }) => [gate, line]));
  for (const tick of delivered) {
    const chart = chartAt(tick);
    assert.deepEqual(gateLines(chart), gateLines(initial));
    assert.equal(h.painter.update(chart), true);
    const actualRays = rayNodes(h.group);
    for (const [key, originals] of originalRays) originals.forEach((node, index) => assert.equal(actualRays.get(key)[index], node, `${key} part ${index} is reused`));
    const actualSymbols = symbolNodes(h.group);
    assert.equal(actualSymbols.size, 26);
    for (const [key, node] of originalSymbols) {
      assert.equal(actualSymbols.get(key), node, `${key} text node retains identity`);
      assert.equal(node.getAttribute('data-longitude'), actualRays.get(key)[0].getAttribute('data-longitude'));
      assert.ok(Number.isFinite(Number(node.getAttribute('data-label-longitude'))));
    }
    received.push(Number(actualRays.get('personality:sun')[0].getAttribute('data-longitude')));
    const sun = actualSymbols.get('personality:sun');
    receivedLabels.push(Number(sun.getAttribute('data-longitude')));
    labelGeometry.push([sun.getAttribute('x'), sun.getAttribute('y'), actualRays.get('personality:sun')[3].getAttribute('d')].join('|'));
    assertRendered(h.root, chart);
    assertStaticNodes(h.group, originalStatic);
  }
  const expected = delivered.map(tick => chartAt(tick).activations.personality[0].longitude);
  assert.deepEqual(received, expected, 'no intermediate ray input is dropped');
  assert.deepEqual(receivedLabels, expected, 'no intermediate glyph input is dropped');
  assert.equal(new Set(labelGeometry).size, delivered.length, 'glyph position or leader geometry changes for every delivered minute');
  assertNoSceneParse(h.document);
});

test('longitude-only motion does not revisit sector attributes while every planet decoration still updates', () => {
  // Use the wheel itself so the fixture's selector traversal is not counted as
  // painter work. Capture once before observing the steady-state DOM reads.
  const chart = chartAt(), h = harness(chart, {}, { groupRoot: true });
  h.painter.update(chart);
  const subtree = node => [node, ...node.children.flatMap(subtree)];
  const sectors = [...h.group.querySelectorAll('.mandala-gate').flatMap(subtree),
    ...h.group.querySelectorAll('.mandala-fan, .mandala-focus-sector')];
  const planets = [...h.group.querySelectorAll('.mandala-planet-marker').flatMap(subtree),
    ...h.group.querySelectorAll('.mandala-planet-symbol')];
  const next = chartAt(1);
  let planetCounts;
  const sectorCounts = attributeCounts(sectors, () => {
    planetCounts = attributeCounts(planets, () => h.painter.update(next));
  });
  assert.deepEqual(sectorCounts, { reads: 0, writes: 0 }, 'unchanged sectors need no attribute work');
  assert.ok(planetCounts.reads > 0 && planetCounts.writes > 0, 'planet geometry still consumes the next input');
  assertRendered(h.root, next);
  assert.equal(h.document.parses.length, 0, 'no fragments are reparsed for pure longitude motion');
});

test('each sector input invalidates independently, including mutations of caller-owned sets and gate arrays', () => {
  const chart = chartAt(), options = { selectedGates: new Set(), relatedGates: new Set(), interactive: true };
  const h = harness(chart, options);
  const check = () => { h.painter.update(chart, options); assertRendered(h.root, chart, options); };
  check();
  const gate = chart.personality[0];
  options.selectedGates.add(gate); check();
  options.relatedGates.add(gate); check();
  options.selectedGates.clear(); check();
  options.relatedGates.clear(); check();
  options.interactive = false; check();
  options.interactive = true; check();
  const sun = chart.activations.personality[0];
  chart.activations.personality[0] = { ...sun, ...gatePositionAtLongitude(sun.longitude + GATE_WIDTH) };
  chart.personality.splice(0, chart.personality.length, ...new Set(chart.activations.personality.map(entry => entry.gate)));
  check();
  chart.design.splice(0, chart.design.length); check();
  chart.design.push(gate); check();
});

test('invalid, duplicated, missing and recovered planets match the renderer without stale rays, leaders or symbols', () => {
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
  const variants = [duplicate, invalid, missing, { ...initial, source: 'transit' },
    { ...initial, source: 'manual' }, { ...initial, activations: {} }, initial];
  const counts = [25, 21, 12, 13, 0, 0, 26];
  for (const [index, chart] of variants.entries()) {
    assert.equal(h.painter.update(chart), true);
    assertRendered(h.root, chart);
    assertStaticNodes(h.group, staticBefore);
    assert.equal(rayNodes(h.group).size, counts[index]);
    assert.equal(symbolNodes(h.group).size, counts[index]);
    assert.equal(h.group.querySelectorAll('.mandala-planet-leader').length, counts[index]);
    assert.deepEqual([...symbolNodes(h.group).keys()].sort(), [...rayNodes(h.group).keys()].sort());
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

test('scene replacement and reset rebuild sector ownership even when the requested snapshot is unchanged', () => {
  const chart = chartAt(), options = { selectedGates: new Set([25]), relatedGates: new Set([25, 46]) };
  const h = harness(chart, options);
  h.painter.update(chart, options);
  const detached = h.group, detachedSnapshot = significantDOM(detached);
  h.root.innerHTML = renderMandala({}, { interactive: false });
  h.painter.update(chart, options);
  assertRendered(h.root, chart, options);
  assert.deepEqual(significantDOM(detached), detachedSnapshot, 'new wheel must not reuse the old field nodes');
  const replacement = mandalaGroup(h.root);
  replacement.innerHTML = rendered({}, { interactive: false }).group.innerHTML;
  h.painter.reset();
  h.painter.update(chart, options);
  assertRendered(h.root, chart, options);
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
