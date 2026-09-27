import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBodygraph } from '../src/bodygraph/bodygraph.js';
import { renderChartBackdrop, CHART_BACKDROP_BOUNDS, CHART_SURFACE_RIM_WIDTH } from '../src/bodygraph/chart-backdrop.js';
import { renderMandalaUnderlay } from '../src/bodygraph/mandala-underlay.js';
import { LOTUS_BACKDROP_BOUNDS, LOTUS_SILHOUETTE_PATH, LOTUS_DETAIL_PATHS } from '../src/bodygraph/lotus-backdrop.js';

const chart = Object.freeze({ personality: Object.freeze([61, 24, 20, 34]), design: Object.freeze([57, 10]) });

test('changing the pose preserves all chart layers, selections and activation data in both views', () => {
  for (const showMandala of [false, true]) {
    for (const selection of [null, { type: 'center', id: 'head' }, { type: 'channel', id: '24-61' }, { type: 'integration', id: 'integration' }]) {
      const options = { showBackdrop: true, showMandala, showActivations: true,
        previewSelection: { type: 'gate', id: 57 }, idPrefix: 'pose-comparison' };
      const before = renderBodygraph(chart, selection, options);
      const after = renderBodygraph(chart, selection, { ...options, showLotus: true });
      const normal = renderChartBackdrop(options.idPrefix, { mandala: showMandala });
      const lotus = renderChartBackdrop(options.idPrefix, { mandala: showMandala, lotus: true });
      assert.ok(before.includes(normal));
      assert.ok(after.includes(lotus));
      assert.equal(after.replace(lotus, ''), before.replace(normal, ''), 'only the decorative background may change');
      assert.equal(renderBodygraph(chart, selection, { ...options, showLotus: false }), before);
    }
  }
});

test('lotus stays inside the existing scene and between the calculation columns', () => {
  assert.deepEqual(LOTUS_BACKDROP_BOUNDS, CHART_BACKDROP_BOUNDS);
  const { x, y, width, height } = CHART_BACKDROP_BOUNDS;
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
    const layer = renderChartBackdrop('lotus-check', { mandala, lotus: true });
    assert.match(layer, /data-pose="lotus" pointer-events="none" aria-hidden="true" focusable="false"/);
    assert.match(layer, /fill-rule="evenodd"/);
    assert.doesNotMatch(layer, /data-type|tabindex|role=|<image|<script|<foreignObject|\son\w+=/);
    assert.doesNotMatch(layer, /NaN|undefined|Infinity/);
    const svg = renderBodygraph(chart, null, { showBackdrop: true, showMandala: mandala, showLotus: true, idPrefix: 'lotus-check' });
    assert.ok(svg.indexOf(layer) < svg.indexOf('<g class="bodygraph-channels">'));
    assert.equal(svg.split('data-pose="lotus"').length - 1, 1);
  }
  assert.equal(renderMandalaUnderlay('lotus-check', { lotus: true }), renderChartBackdrop('lotus-check', { mandala: true, lotus: true }));
  assert.doesNotMatch(renderBodygraph(chart, null, { showLotus: true }), /data-pose="lotus"/, 'pose alone does not enable a backdrop on unrelated diagrams');
});
