import test from 'node:test';
import assert from 'node:assert/strict';
import { renderChartThumbnail } from '../src/charts/chart-thumbnail.js';
import { CHART_SILHOUETTE_PATH, CHART_BACKDROP_BOUNDS, CHART_SURFACE_RIM_WIDTH } from '../src/bodygraph/chart-backdrop.js';

const decode = source => decodeURIComponent(source.slice('data:image/svg+xml,'.length));

test('thumbnail uses actual chart activations without interactive targets or columns', () => {
  const svg = decode(renderChartThumbnail({ personality: [7, 31], design: [37, 40] }));
  assert.match(svg, /data-type="center" data-id="throat"[^>]*data-defined="true"/);
  assert.match(svg, /data-type="center" data-id="heart"[^>]*data-defined="true"/);
  assert.match(svg, /\.bodygraph-gates \{ display: none; \}/);
  assert.doesNotMatch(svg, /tabindex=|data-activation=|<script\b|<image\b/);
});

test('thumbnail changes with activations, not names, dates or selection', () => {
  const chart = { personality: [7, 31], design: [], name: 'Test', birthDate: '1990-01-01' };
  const original = structuredClone(chart);
  const source = renderChartThumbnail(chart);
  assert.equal(source, renderChartThumbnail({ ...chart, name: 'Another', birthDate: '2000-01-01' }));
  assert.notEqual(source, renderChartThumbnail({ ...chart, personality: [] }));
  assert.deepEqual(chart, original);
});

test('saved-chart thumbnails reuse the complete silhouette behind the geometry', () => {
  const svg = decode(renderChartThumbnail({ personality: [7, 31], design: [37, 40] }));
  assert.match(svg, /class="chart-backdrop" pointer-events="none"/);
  assert.ok(svg.includes(`d="${CHART_SILHOUETTE_PATH}"`));
  assert.ok(svg.indexOf('class="chart-backdrop"') < svg.indexOf('data-type="center"'));
  assert.match(svg, /id="thumbnail-chart-backdrop"/);
  assert.doesNotMatch(svg, /class="mandala-underlay"/);
  assert.match(svg, /\.bodygraph-gates \{ display: none; \}/);
  const [x, y, width, height] = svg.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
  const bounds = CHART_BACKDROP_BOUNDS, rim = CHART_SURFACE_RIM_WIDTH / 2;
  assert.ok(x < bounds.x - rim && y < bounds.y - rim);
  assert.ok(x + width > bounds.x + bounds.width + rim);
  assert.ok(y + height > bounds.y + bounds.height + rim);
});
