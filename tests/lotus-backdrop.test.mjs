import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBodygraph } from '../src/scene/bodygraph-svg.js';
import { renderChartBackdrop, CHART_SURFACE_RIM_WIDTH } from '../src/scene/backdrop.js';
import { LOTUS_BACKDROP_BOUNDS, LOTUS_SILHOUETTE_PATH, LOTUS_DETAIL_PATHS } from '../src/scene/geometry/lotus-backdrop.js';

const chart = Object.freeze({ personality: Object.freeze([61, 24, 20, 34]), design: Object.freeze([57, 10]) });

test('the seated figure leaves chart geometry, selections and activation data unchanged', () => {
  for (const selection of [null, { type: 'center', id: 'head' }, { type: 'channel', id: '24-61' }, { type: 'integration', id: 'integration' }]) {
    const options = { showActivations: true, previewSelection: { type: 'gate', id: 57 }, idPrefix: 'backdrop-comparison' };
    const plain = renderBodygraph(chart, selection, options);
    const decorated = renderBodygraph(chart, selection, { ...options, showBackdrop: true });
    const layer = renderChartBackdrop(options.idPrefix);
    assert.ok(decorated.includes(layer));
    assert.equal(decorated.replace(layer, ''), plain, 'the figure changes only the decorative layer');
  }
});

test('lotus stays inside the existing scene and between the calculation columns', () => {
  const { x, y, width, height } = LOTUS_BACKDROP_BOUNDS;
  for (const path of [LOTUS_SILHOUETTE_PATH, ...LOTUS_DETAIL_PATHS]) {
    // Cubic curves stay within their control-point hulls, so bounding every
    // control point also bounds the entire silhouette and its interior lines.
    assert.doesNotMatch(path, /[AaHhVvQqSsTtLl]/);
    const values = path.match(/-?\d+(?:\.\d+)?/g).map(Number);
    assert.equal(values.length % 2, 0);
    for (let index = 0; index < values.length; index += 2) {
      assert.ok(values[index] >= x && values[index] <= x + width);
      assert.ok(values[index + 1] >= y && values[index + 1] <= y + height);
    }
  }
  assert.ok(x - CHART_SURFACE_RIM_WIDTH / 2 > 64);
  assert.ok(x + width + CHART_SURFACE_RIM_WIDTH / 2 < 584);
});

test('lotus is a noninteractive underlay shared by normal and mandala modes', () => {
  for (const mandala of [false, true]) {
    const layer = renderChartBackdrop('lotus-check', { mandala });
    assert.match(layer, /pointer-events="none" aria-hidden="true" focusable="false"/);
    assert.match(layer, /fill-rule="evenodd"/);
    assert.doesNotMatch(layer, /data-type|tabindex|role=|<image|<script|<foreignObject|\son\w+=/);
    assert.doesNotMatch(layer, /NaN|undefined|Infinity/);
    const svg = renderBodygraph(chart, null, { showBackdrop: true, showMandala: mandala, idPrefix: 'lotus-check' });
    assert.ok(svg.indexOf(layer) < svg.indexOf('<g class="bodygraph-channels">'));
    assert.equal(svg.split(layer).length - 1, 1);
  }
  assert.doesNotMatch(renderBodygraph(chart), /lotus-contours|chart-backdrop|mandala-underlay/, 'unrelated diagrams remain undecorated');
});
