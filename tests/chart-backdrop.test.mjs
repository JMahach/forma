import test from 'node:test';
import assert from 'node:assert/strict';
import { CHART_SURFACE, CHART_SURFACE_RIM_WIDTH, CHART_MANDALA_SURFACE_OPACITY, renderChartBackdrop } from '../src/scene/backdrop.js';
import { LOTUS_BACKDROP_BOUNDS, LOTUS_SILHOUETTE_PATH, LOTUS_DETAIL_PATHS } from '../src/scene/geometry/lotus-backdrop.js';
import { renderBodygraph } from '../src/scene/bodygraph-svg.js';
import { crossAtLongitude } from '../src/domain/mandala-cross.js';
import { renderChartThumbnail } from '../src/views/thumbnail.js';
import { renderLoveDiagram } from '../src/stories/vessel-of-love.js';

const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const chart = freeze({ id: 'backdrop-test', source: 'manual', personality: [20, 34, 10, 26], design: [57, 20, 44] });
const attributes = markup => Object.fromEntries([...markup.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
const ids = markup => [...markup.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
const references = markup => [...markup.matchAll(/url\(#([^)]+)\)/g)].map(match => match[1]);
const paths = markup => [...markup.matchAll(/<path\b([^>]*)\/>/g)].map(([, attrs]) => attributes(attrs));

test('chart surface is a deterministic decorative seated figure, never a page-wide field or interactive target', () => {
  for (const mandala of [false, true]) {
    const markup = renderChartBackdrop('bodygraph', { mandala });
    assert.match(markup, new RegExp(`^<g class="${mandala ? 'mandala-underlay' : 'chart-backdrop'}" pointer-events="none" aria-hidden="true" focusable="false"${mandala ? ` opacity="${CHART_MANDALA_SURFACE_OPACITY}"` : ''}>`));
    assert.doesNotMatch(markup, /data-type|tabindex|role=|bg-interactive|href|<image|<script|<foreignObject|\son\w+=|<filter|<fe\w+|<animate/i);
    assert.doesNotMatch(markup, /NaN|undefined|Infinity/);
    assert.equal((markup.match(/<path\b/g) || []).length, 2 + LOTUS_DETAIL_PATHS.length, 'one perimeter, one opaque surface and the crossed-leg contours');
    assert.equal((markup.match(/<linearGradient\b/g) || []).length, 1);
    assert.doesNotMatch(markup, /<rect|<ellipse|<circle|<mask|<radialGradient|filter=/, 'only the bodygraph silhouette receives a surface');
    assert.equal(renderChartBackdrop('bodygraph', { mandala }), markup);
  }
});

test('both modes compose solid paths so the fill covers the inner half of one uniform perimeter stroke', () => {
  assert.ok(Object.isFrozen(CHART_SURFACE));
  assert.ok(Object.isFrozen(LOTUS_BACKDROP_BOUNDS));
  assert.ok(Number.isFinite(CHART_SURFACE_RIM_WIDTH) && CHART_SURFACE_RIM_WIDTH > 0 && CHART_SURFACE_RIM_WIDTH <= 6);
  const rimRadius = CHART_SURFACE_RIM_WIDTH / 2;
  assert.ok(LOTUS_BACKDROP_BOUNDS.x - rimRadius > 64 && LOTUS_BACKDROP_BOUNDS.x + LOTUS_BACKDROP_BOUNDS.width + rimRadius < 584, 'even the outer rim remains between the calculation columns');
  assert.ok(LOTUS_BACKDROP_BOUNDS.y - rimRadius >= 0 && LOTUS_BACKDROP_BOUNDS.y + LOTUS_BACKDROP_BOUNDS.height + rimRadius <= 820);
  assert.equal(LOTUS_BACKDROP_BOUNDS.x + LOTUS_BACKDROP_BOUNDS.width / 2, 320);
  for (const color of Object.values(CHART_SURFACE)) assert.match(color, /^#[0-9a-f]{6}$/i);
  for (const mandala of [false, true]) {
    const markup = renderChartBackdrop('surface', { mandala });
    const [rim, surface] = paths(markup);
    assert.equal(rim.class, 'chart-surface-rim');
    for (const path of [rim, surface]) {
      assert.equal(path.d, LOTUS_SILHOUETTE_PATH);
      assert.ok(!('opacity' in path) || Number(path.opacity) === 1);
      assert.ok(!('fill-opacity' in path) || Number(path['fill-opacity']) === 1);
      assert.equal(path.transform, undefined, 'anisotropic inset scaling cannot create an uneven border');
    }
    assert.equal(rim.fill, 'none');
    assert.equal(rim.stroke, CHART_SURFACE.edge);
    assert.equal(Number(rim['stroke-width']), CHART_SURFACE_RIM_WIDTH);
    assert.equal(rim['stroke-linejoin'], 'round');
    assert.equal(rim['stroke-dasharray'], undefined);
    assert.equal(rim['vector-effect'], undefined, 'the rim scales together with the chart');
    assert.equal(surface.stroke, 'none');
    assert.equal(surface.fill, `url(#surface-${mandala ? 'mandala-porcelain' : 'chart-backdrop'})`, 'opaque same-path fill is painted second, leaving exactly the outer half of the stroke visible');
    const stops = [...markup.matchAll(/<stop\b([^>]*)\/>/g)].map(([, attrs]) => attributes(attrs));
    assert.deepEqual(stops.map(stop => stop['stop-color']), [CHART_SURFACE.top, CHART_SURFACE.middle, CHART_SURFACE.bottom]);
    assert.ok(stops.every(stop => !('stop-opacity' in stop) || Number(stop['stop-opacity']) === 1), 'transparency belongs to the complete mandala surface, never individual stops');
  }
});

test('only the complete mandala surface is translucent; normal mode and physical chart paint stay unchanged', () => {
  assert.ok(CHART_MANDALA_SURFACE_OPACITY > 0 && CHART_MANDALA_SURFACE_OPACITY < 1, 'the user can see rays through the mandala backing');
  const normal = renderChartBackdrop('transparency');
  const mandala = renderChartBackdrop('transparency', { mandala: true });
  assert.doesNotMatch(normal, /\s(?:fill-|stop-|stroke-)?opacity=/);
  assert.equal(attributes(mandala.match(/^<g\b([^>]*)>/)[1]).opacity, String(CHART_MANDALA_SURFACE_OPACITY));
  assert.equal((mandala.match(/\sopacity=/g) || []).length, 1, 'one group composite prevents overlap seams between rim and fill');
  assert.equal(mandala.replace('class="mandala-underlay"', 'class="chart-backdrop"')
    .replace(` opacity="${CHART_MANDALA_SURFACE_OPACITY}"`, '')
    .replaceAll('transparency-mandala-porcelain', 'transparency-chart-backdrop'), normal, 'path geometry, colors and uniform rim are otherwise identical');
  const selection = { type: 'gate', id: 20 };
  const plain = renderBodygraph(chart, selection, { showBackdrop: true });
  const wheel = renderBodygraph(chart, selection, { showMandala: true });
  const physicalPaint = svg => svg.slice(svg.indexOf('<g class="bodygraph-channels">')).match(/<(?:path|circle|text)\b[^>]*>/g);
  assert.deepEqual(physicalPaint(wheel), physicalPaint(plain), 'centers, channels and gate paint do not inherit the backdrop opacity');
  for (const [, tag] of wheel.matchAll(/<g\b([^>]*)>/g)) {
    const attrs = attributes(tag);
    if (/^(?:bodygraph-drawing|mandala-core|bodygraph-channels|bodygraph-centers|bodygraph-gates)(?:\s|$)/.test(attrs.class || '')) {
      assert.equal(attrs.opacity, undefined, `${attrs.class} remains outside the translucent surface composite`);
    }
  }
});

test('normal and mandala resources have separate sanitized IDs with no dangling references', () => {
  const all = [];
  for (const mandala of [false, true]) for (const prefix of ['first-chart', 'second-chart', 'x\"><script>', '!!!']) {
    const markup = renderChartBackdrop(prefix, { mandala }), defined = ids(markup);
    const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '') || 'bodygraph';
    assert.deepEqual(defined, [`${safePrefix}-${mandala ? 'mandala-porcelain' : 'chart-backdrop'}`]);
    assert.deepEqual(references(markup), defined);
    assert.doesNotMatch(markup, /<script>/);
    all.push(...defined);
  }
  assert.equal(new Set(all).size, all.length, 'both modes and separate charts have independent gradients');
  assert.equal(renderChartBackdrop('!!!'), renderChartBackdrop());
});

test('outline stays opt-in: saved thumbnails enable it, love diagrams remain undecorated', () => {
  for (const options of [{}, { showBackdrop: false }, { interactive: false, idPrefix: 'thumbnail' }]) {
    assert.doesNotMatch(renderBodygraph(chart, null, options), /chart-backdrop|mandala-underlay/);
  }
  assert.match(decodeURIComponent(renderChartThumbnail(chart)), /class="chart-backdrop"/);
  assert.doesNotMatch(renderLoveDiagram(), /chart-backdrop|mandala-underlay/);
  assert.equal(renderBodygraph(chart), renderBodygraph(chart, null, { showBackdrop: false }));
});

test('normal outline sits inside the drawing directly behind channels, never underneath the activation columns', () => {
  const markup = renderBodygraph(chart, null, { showBackdrop: true, showActivations: true });
  const backdrop = renderChartBackdrop(), index = markup.indexOf(backdrop);
  assert.ok(index > markup.indexOf('class="bodygraph-drawing"'));
  assert.ok(index >= 0);
  assert.equal((markup.match(/class="chart-backdrop"/g) || []).length, 1);
  assert.ok(markup.includes(`${backdrop}<g class="bodygraph-channels">`), 'the silhouette belongs to the physical schematic, not a page-level field');
  assert.doesNotMatch(markup.slice(0, markup.indexOf('class="bodygraph-drawing"')), /chart-backdrop/);
  for (const layer of ['bodygraph-channels', 'bodygraph-centers', 'bodygraph-gates']) {
    assert.ok(index < markup.indexOf(`class="${layer}`));
  }
});

test('calculated columns stay outside the surface in both modes while Color and Tone are normal-mode only', () => {
  const activationPairs = [
    { planet: 'sun', gate: 41, line: 1, longitude: 302.02 },
    { planet: 'earth', gate: 31, line: 1, longitude: 122.02 },
    { planet: 'north_node', gate: 19, line: 1, longitude: 307.65 },
    { planet: 'south_node', gate: 33, line: 1, longitude: 127.65 },
  ];
  const calculated = freeze({ id: 'calculated-backdrop', source: 'calculated', personality: [19, 31, 33, 41], design: [19, 31, 33, 41], activations: { design: activationPairs, personality: activationPairs.map(entry => ({ ...entry })) } });
  for (const showMandala of [false, true]) {
    const options = { showActivations: true, showMandala };
    const plain = renderBodygraph(calculated, { type: 'gate', id: 41 }, options);
    const decorated = renderBodygraph(calculated, { type: 'gate', id: 41 }, { ...options, showBackdrop: true });
    const layer = renderChartBackdrop('bodygraph', { mandala: showMandala });
    const layerIndex = decorated.indexOf(layer);
    assert.match(decorated, /class="activation-columns"/);
    assert.ok(layerIndex > decorated.indexOf('class="activation-columns"'));
    if (showMandala) {
      assert.doesNotMatch(decorated, /bodygraph-variable|variable-color|variable-tone/, 'the entire Color/Tone block is absent in mandala mode');
      assert.doesNotMatch(plain, /bodygraph-variable|variable-color|variable-tone/);
    } else {
      assert.match(decorated, /class="bodygraph-variables"/);
      assert.ok(layerIndex > decorated.indexOf('class="bodygraph-variables"'));
      assert.equal((decorated.match(/class="variable-color"/g) || []).length, 4, 'all four Color arrows are retained in normal mode');
      assert.equal((decorated.match(/class="variable-tone"/g) || []).length, 4, 'all four Tone arrows are retained in normal mode');
    }
    assert.ok(layerIndex > 0);
    assert.equal(decorated.slice(0, layerIndex), plain.slice(0, showMandala ? plain.indexOf(layer) : plain.indexOf('<g class="bodygraph-channels">')), 'the surface does not change headings, numeric activations or mode-appropriate variable arrows');
    assert.ok(LOTUS_BACKDROP_BOUNDS.x >= 80, 'the silhouette never reaches the design column or its fixing marks');
    assert.ok(LOTUS_BACKDROP_BOUNDS.x + LOTUS_BACKDROP_BOUNDS.width < 584, 'the silhouette never reaches the personality column');
  }
});

test('removing only the normal outline leaves every channel, activation, selection and interaction byte-for-byte unchanged', () => {
  const cases = freeze([
    { selection: null, options: {} },
    { selection: { type: 'gate', id: 20 }, options: { showActivations: true } },
    { selection: { type: 'center', id: 'sacral' }, options: { showActivations: true, previewSelection: { type: 'gate', id: 57 } } },
    { selection: { type: 'channel', id: '26-44' }, options: { interactive: false, idPrefix: 'static-preview' } },
    { selection: null, options: { idPrefix: 'shift-chart', selections: [{ type: 'gate', id: 20 }, { type: 'gate', id: 34 }], previewSelection: { type: 'gate', id: 10 } } },
    { selection: null, options: { idPrefix: '!!!', showActivations: true } },
  ]);
  for (const { selection, options } of cases) {
    const plain = renderBodygraph(chart, selection, options);
    const decorated = renderBodygraph(chart, selection, { ...options, showBackdrop: true });
    assert.equal(decorated.replace(renderChartBackdrop(options.idPrefix), ''), plain);
  }
});

test('mandala always uses one shared silhouette inside its scaled core, never an additional field around the wheel', () => {
  const options = freeze({ idPrefix: 'shared-surface', showMandala: true, showActivations: true, selections: [{ type: 'gate', id: 20 }], pinnedCrosses: [crossAtLongitude(355)], previewSelection: { type: 'mandala-cross', cross: crossAtLongitude(305.7) } });
  const plain = renderBodygraph(chart, null, options);
  const enabled = renderBodygraph(chart, null, { ...options, showBackdrop: true });
  const underlay = renderChartBackdrop(options.idPrefix, { mandala: true });
  assert.equal(enabled, plain, 'normal backdrop flag cannot add another layer or alter the mandala');
  assert.equal(renderBodygraph(chart, null, { ...options, showBackdrop: false }), plain);
  assert.equal((enabled.match(/class="mandala-underlay"/g) || []).length, 1);
  assert.doesNotMatch(enabled, /class="chart-backdrop"/);
  const coreIndex = enabled.indexOf('class="mandala-core"'), underlayIndex = enabled.indexOf(underlay);
  assert.ok(coreIndex > enabled.indexOf('class="bodygraph-mandala"'));
  assert.ok(coreIndex < underlayIndex);
  assert.ok(enabled.includes(`${underlay}<g class="bodygraph-channels">`));
  assert.equal(new Set(ids(enabled)).size, ids(enabled).length, 'the full rendered SVG has no duplicate IDs');
  for (const ref of references(enabled)) assert.ok(ids(enabled).includes(ref), `missing resource ${ref}`);
});

test('chart and selection inputs remain immutable when rendering and removing the outline', () => {
  const selection = freeze({ type: 'gate', id: 34 });
  const options = freeze({ showBackdrop: true, selections: [selection], previewSelection: { type: 'center', id: 'sacral' }, showActivations: true });
  const before = JSON.stringify({ chart, selection, options });
  for (const showMandala of [false, true]) {
    renderBodygraph(chart, selection, { ...options, showMandala });
    renderBodygraph(chart, selection, { ...options, showMandala, showBackdrop: false });
  }
  assert.equal(JSON.stringify({ chart, selection, options }), before);
});
