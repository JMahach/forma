import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector';
import { promisify } from 'node:util';
import { createSceneRenderer } from '../src/scene/renderer.js';
import { renderBodygraph } from '../src/scene/bodygraph-svg.js';
import { createMandalaPreviewPainter } from '../src/scene/mandala-preview-painter.js';
import { crossAtLongitude } from '../src/domain/mandala-cross.js';
import { PLANETS } from '../src/domain/planets.js';
import { gatePositionAtLongitude } from '../src/domain/gate-wheel.js';
import { overlayFixture } from './helpers/chart-composition.mjs';
import { createChartComposition } from '../src/domain/chart-composition.js';
import { SVG_NS, SvgElement, svgDocument, significantDOM } from './helpers/svg-dom.mjs';
const RETURN_OVERLAY = { kind: 'return', event: { id: 'fixture-return', body: 'saturn', cycle: 1 } };

// Matrix-based heading positioning is measured by the browser parity harness.
SvgElement.prototype.getCTM = () => null;
function chartAt(tick = 0) {
  const activations = Object.fromEntries(['design', 'personality'].map((source, side) => [source,
    PLANETS.map(([planet], index) => ({ planet, ...gatePositionAtLongitude((index * 23 + side * 143 + tick * .01) % 360) }))]));
  return { source: 'calculated', activations,
    personality: [...new Set(activations.personality.map(entry => entry.gate))],
    design: [...new Set(activations.design.map(entry => entry.gate))] };
}
function variableChart() {
  const chart = chartAt();
  for (const source of ['design', 'personality']) {
    for (const entry of chart.activations[source]) {
      const longitude = { sun: 302.0130208333333, earth: 122.0130208333333,
        north_node: 307.6380208333333, south_node: 127.6380208333333 }[entry.planet];
      if (longitude !== undefined) Object.assign(entry, gatePositionAtLongitude(longitude));
    }
    chart[source] = [...new Set(chart.activations[source].map(entry => entry.gate))];
  }
  return chart;
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

test('single composition renders its primary chart facts and preserves scene targets on raw-to-composition updates', () => {
  const primary = variableChart(), composition = createChartComposition(primary);
  for (const showMandala of [false, true]) {
    const h = fixture(), options = { showActivations: true, showBackdrop: true, showMandala };
    h.renderer.update(primary, null, options);
    const initial = h.root.querySelectorAll('[data-type]');
    const state = h.renderer.update(composition, null, options);
    assert.ok(state.personality.has(41));
    assert.ok(state.design.has(41));
    assert.equal(h.root.querySelectorAll('.activation-row').length, 26);
    assert.equal(h.root.querySelectorAll('.bodygraph-variable').length, showMandala ? 0 : 4);
    assert.equal(h.root.querySelectorAll('.mandala-planet-marker').length, showMandala ? 26 : 0);
    assertSameNodes(h.root.querySelectorAll('[data-type]'), initial);
    assertRendered(h.root, primary, null, options);
    assertRendered(h.root, composition, null, options);
  }
});

test('manual chart topology never promotes stale planetary metadata into scene rows or mandala marks', () => {
  const manual = { ...variableChart(), source: 'manual', personality: [63], design: [4] };
  const calculated = chartAt();
  for (const composition of [createChartComposition(manual), overlayFixture(manual, calculated, RETURN_OVERLAY)]) {
    const h = fixture(), options = { showActivations: true, showMandala: true };
    const state = h.renderer.update(composition, null, options);
    assert.ok(state.definedChannels.has('4-63'), 'manually entered gates still own the definition');
    assert.equal(h.root.querySelectorAll('.activation-row').length, 0);
    assert.equal(h.root.querySelectorAll('[data-cycle-origin="natal"] .cycle-activation-value').length, 0);
    assert.equal(h.root.querySelectorAll('.mandala-planet-marker[data-source="natal-personality"]').length, 0);
    assert.equal(h.root.querySelectorAll('.mandala-planet-marker[data-source="natal-design"]').length, 0);
    assert.equal(h.root.querySelectorAll('.mandala-planet-marker').length, composition.secondary ? 26 : 0);
    assert.equal(h.root.querySelectorAll('.cycle-activation-value').length, composition.secondary ? 26 : 0);
    assertRendered(h.root, composition, null, options);
  }
});

test('first mount parses one complete SVG, adopts its caches and retains every initial node on an identical update', () => {
  for (const mode of [{}, { showMandala: true }, { showMandalaLayer: true }]) {
    const h = fixture(), chart = chartAt();
    const options = { showBackdrop: true, showActivations: true, ...mode };
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
  const modes = [{}, { showBackdrop: true },
    { showMandalaLayer: true }, { showMandala: true, showActivations: true },
    { showMandala: true }, { showActivations: true }, {}];
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

test('variable decoration snapshots retain nodes for equal values and follow mutable input, modes and renderer ownership', () => {
  const h = fixture(), chart = variableChart(), options = { showActivations: true, showBackdrop: true };
  h.renderer.update(chart, null, options);
  let variables = h.root.querySelector('.bodygraph-variables');
  assert.ok(variables, 'the fixture contains four valid paired Variables');
  assertRendered(h.root, chart, null, options);
  for (const current of [chart, structuredClone(chart)]) {
    h.renderer.update(current, { type: 'gate', id: 41 }, options);
    assert.equal(h.root.querySelector('.bodygraph-variables'), variables);
    assertRendered(h.root, current, { type: 'gate', id: 41 }, options);
  }
  // Both required records move inside the same Tone; their saved longitudes change.
  const pair = chart.activations.design.filter(entry => ['sun', 'earth'].includes(entry.planet));
  pair.forEach(entry => { entry.longitude += 1e-6; });
  chart.name = 'Unrelated chart edit';
  h.renderer.update(chart, null, options);
  assert.equal(h.root.querySelector('.bodygraph-variables'), variables);
  assertRendered(h.root, chart, null, options);
  for (const delta of [5 / 192, 0.15625, 10 / 192, 0.3125]) {
    const old = variables, before = significantDOM(old);
    pair.forEach(entry => { entry.longitude += delta; });
    h.renderer.update(chart, null, options);
    variables = h.root.querySelector('.bodygraph-variables');
    assert.ok(variables);
    assert.notEqual(variables, old, 'number changes and direction changes both repaint');
    assert.deepEqual(significantDOM(old), before, 'replaced nodes remain untouched');
    assertRendered(h.root, chart, null, options);
  }
  const valid = structuredClone(chart);
  for (const corrupt of [entry => { entry.longitude = NaN; }, entry => { entry.longitude += 5 / 192; },
    entry => { entry.line = 6; }]) {
    const entry = chart.activations.design.find(entry => entry.planet === 'earth'), before = { ...entry };
    corrupt(entry);
    h.renderer.update(chart, null, options);
    assert.equal(h.root.querySelector('.bodygraph-variables'), null, 'same-object invalid or inconsistent pair clears the layer');
    assertRendered(h.root, chart, null, options);
    Object.assign(entry, before);
    h.renderer.update(chart, null, options);
    assert.ok(h.root.querySelector('.bodygraph-variables'), 'repairing the same input restores the layer');
  }
  const invalidCharts = [
    { ...valid, source: 'manual' }, { ...valid, source: 'transit' }, { ...valid, source: undefined },
    overlayFixture(valid, valid, RETURN_OVERLAY),
    { ...valid, activations: undefined },
    { ...valid, activations: { ...valid.activations, design: valid.activations.design.slice(1) } },
    { ...valid, activations: { ...valid.activations, design: [...valid.activations.design, valid.activations.design[0]] } },
  ];
  for (const invalid of invalidCharts) {
    h.renderer.update(invalid, null, options);
    assert.equal(h.root.querySelector('.bodygraph-variables'), null);
    assertRendered(h.root, invalid, null, options);
    h.renderer.update(valid, null, options);
    assert.ok(h.root.querySelector('.bodygraph-variables'));
    assertRendered(h.root, valid, null, options);
  }
  for (const mode of [{ showActivations: false }, { showMandala: true }, {}, { showMandalaLayer: true }, {}]) {
    const currentOptions = { ...options, ...mode }, before = h.root.querySelector('.bodygraph-variables');
    h.renderer.update(valid, null, currentOptions);
    const visible = !currentOptions.showMandala && currentOptions.showActivations;
    assert.equal(Boolean(h.root.querySelector('.bodygraph-variables')), visible);
    if (visible && before) assert.equal(h.root.querySelector('.bodygraph-variables'), before);
    assertRendered(h.root, valid, null, currentOptions);
  }
  const other = fixture();
  other.renderer.update(valid, null, options);
  const otherVariables = other.root.querySelector('.bodygraph-variables');
  for (const reset of [() => h.renderer.clear(), () => {}]) {
    const detached = h.root.querySelector('.bodygraph-variables'), before = significantDOM(detached);
    reset();
    const nextOptions = { ...options, idPrefix: `remount-${h.document.parses.length}` };
    h.renderer.update(valid, null, nextOptions);
    assert.notEqual(h.root.querySelector('.bodygraph-variables'), detached);
    assert.deepEqual(significantDOM(detached), before);
    assertRendered(h.root, valid, null, nextOptions);
    assert.equal(other.root.querySelector('.bodygraph-variables'), otherVariables, 'other scene owns its own snapshot');
  }
});

test('equal variable state skips SVG generation before string formatting', async () => {
  // V8 counts the actual formatter entry; DOM-parse counts alone would also pass
  // when unchanged strings were needlessly generated and only then compared.
  const session = new Session(); session.connect();
  const post = promisify(session.post.bind(session));
  try {
    await post('Profiler.enable');
    await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
    const count = async work => {
      await post('Profiler.takePreciseCoverage');
      work();
      const { result } = await post('Profiler.takePreciseCoverage');
      const script = result.find(script => script.url.endsWith('/src/scene/variable-arrows.js'));
      return script?.functions.find(fn => fn.functionName === 'renderVariableArrows')?.ranges[0].count || 0;
    };
    const h = fixture(), chart = variableChart(), options = { showActivations: true };
    assert.equal(await count(() => h.renderer.update(chart, null, options)), 1);
    assert.equal(await count(() => {
      for (let index = 0; index < 20; index++) {
        const current = index % 2 ? structuredClone(chart) : chart;
        h.renderer.update(current, { type: 'gate', id: index % 2 ? 41 : 19 }, options);
      }
    }), 0, 'selection changes and new equal chart objects never enter the formatter');
    chart.activations.design.filter(entry => ['sun', 'earth'].includes(entry.planet))
      .forEach(entry => { entry.longitude += 5 / 192; });
    assert.equal(await count(() => h.renderer.update(chart, null, options)), 1, 'same-object Tone edit formats once');
    assert.equal(await count(() => h.renderer.update(chart, null, options)), 0);
    assert.equal(await count(() => { h.renderer.clear(); h.renderer.update(chart, null, options); }), 1);
    assert.equal(await count(() => h.renderer.update(chart, null, { ...options, idPrefix: 'fresh' })), 1);
  } finally {
    await post('Profiler.stopPreciseCoverage');
    session.disconnect();
  }
});

test('overlay mount prepares columns once and adopts the rendered input for unchanged updates', async () => {
  const session = new Session(); session.connect();
  const post = promisify(session.post.bind(session));
  try {
    await post('Profiler.enable');
    await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
    const count = async work => {
      await post('Profiler.takePreciseCoverage');
      work();
      const { result } = await post('Profiler.takePreciseCoverage');
      const script = result.find(script => script.url.endsWith('/src/scene/overlay-activation-columns.js'));
      return script?.functions.find(fn => fn.functionName === 'describeOverlayActivationColumns')?.ranges[0].count || 0;
    };
    for (const showMandala of [false, true]) {
      const h = fixture(), chart = overlayFixture(chartAt(), chartAt(10), RETURN_OVERLAY);
      const options = { showActivations: true, showMandala };
      assert.equal(await count(() => h.renderer.update(chart, null, options)), 1, 'the initial SVG already contains its exact columns');
      assertRendered(h.root, chart, null, options);
      const initial = h.root.querySelectorAll('.cycle-activation-value');
      assert.equal(await count(() => h.renderer.update(chart, null, options)), 0);
      assertSameNodes(h.root.querySelectorAll('.cycle-activation-value'), initial);
      const selection = { type: 'gate', id: chart.primary.activations.personality[0].gate };
      assert.equal(await count(() => h.renderer.update(chart, selection, options)), 1);
      assertRendered(h.root, chart, selection, options);
      assert.equal(await count(() => h.renderer.update(chart, selection, { ...options, idPrefix: 'remount' })), 1);
      assertRendered(h.root, chart, selection, { ...options, idPrefix: 'remount' });
    }
  } finally {
    await post('Profiler.stopPreciseCoverage');
    session.disconnect();
  }
});


test('single mount builds column models once and still performs its initial heading alignment', async () => {
  const session = new Session(); session.connect();
  const post = promisify(session.post.bind(session));
  try {
    await post('Profiler.enable');
    await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
    const count = async work => {
      await post('Profiler.takePreciseCoverage'); work();
      const { result } = await post('Profiler.takePreciseCoverage');
      const script = result.find(script => script.url.endsWith('/src/scene/activation-columns.js'));
      const calls = name => script?.functions.find(fn => fn.functionName === name)?.ranges[0].count || 0;
      return [calls('describeActivationColumns'), calls('alignPersonalityHeading')];
    };
    const h = fixture(), chart = chartAt(), options = { profile: 'studio', showActivations: true };
    assert.deepEqual(await count(() => h.renderer.update(chart, null, options)), [1, 1]);
    assertRendered(h.root, chart, null, options);
    const initial = h.root.querySelectorAll('.activation-row');
    assert.deepEqual(await count(() => h.renderer.update(chart, null, options)), [0, 0]);
    assertSameNodes(h.root.querySelectorAll('.activation-row'), initial);
    const selection = { type: 'gate', id: chart.activations.personality[0].gate };
    assert.deepEqual(await count(() => h.renderer.update(chart, selection, options)), [1, 0]);
    assertRendered(h.root, chart, selection, options);
    chart.activations.personality[0].line = chart.activations.personality[0].line % 6 + 1;
    assert.deepEqual(await count(() => h.renderer.update(chart, selection, options)), [1, 1]);
    assertRendered(h.root, chart, selection, options);
  } finally { await post('Profiler.stopPreciseCoverage'); session.disconnect(); }
});
