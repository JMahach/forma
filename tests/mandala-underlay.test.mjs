import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANNELS, CENTERS, GATES } from '../src/scene/geometry/chart-geometry.js';
import { CHART_SURFACE, CHART_SURFACE_RIM_WIDTH, CHART_MANDALA_SURFACE_OPACITY, renderChartBackdrop } from '../src/scene/backdrop.js';
import { CHART_BACKDROP_BOUNDS, CHART_SILHOUETTE_PATH } from '../src/scene/geometry/chart-backdrop.js';
import { renderBodygraph } from '../src/scene/bodygraph-svg.js';

const sample = (curve, t) => [0, 1].map(axis => (
  (1 - t) ** 3 * curve[0][axis] + 3 * (1 - t) ** 2 * t * curve[1][axis]
  + 3 * (1 - t) * t ** 2 * curve[2][axis] + t ** 3 * curve[3][axis]
));

function outlineCurves() {
  const path = renderChartBackdrop('bodygraph', { mandala: true }).match(/ d="([^"]+)"/)[1];
  let point = path.match(/^M ([\d.]+) ([\d.]+)/).slice(1).map(Number);
  const result = [];
  assert.match(path, /^M [\d.]+ [\d.]+(?: C [\d.]+ [\d.]+ [\d.]+ [\d.]+ [\d.]+ [\d.]+)+ Z$/, 'one closed outline made solely from joined cubics');
  for (const [, values] of path.matchAll(/C ([\d. ]+)/g)) {
    const coordinates = values.trim().split(/\s+/).map(Number);
    assert.equal(coordinates.length, 6);
    const curve = [point, coordinates.slice(0, 2), coordinates.slice(2, 4), coordinates.slice(4, 6)];
    result.push(curve);
    point = curve[3];
  }
  return result;
}

function outline() {
  const curves = outlineCurves();
  return [curves[0][0], ...curves.flatMap(curve => Array.from({ length: 80 }, (_, i) => sample(curve, (i + 1) / 80)))];
}

function distanceToOutline([x, y], polygon) {
  let squared = Infinity;
  for (let i = 1; i < polygon.length; i++) {
    const [ax, ay] = polygon[i - 1], [bx, by] = polygon[i];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    squared = Math.min(squared, (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2);
  }
  return Math.sqrt(squared);
}

function segmentsIntersect(a, b, c, d) {
  const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const on = (p, q, r) => Math.abs(orient(p, q, r)) < 1e-9
    && r[0] >= Math.min(p[0], q[0]) - 1e-9 && r[0] <= Math.max(p[0], q[0]) + 1e-9
    && r[1] >= Math.min(p[1], q[1]) - 1e-9 && r[1] <= Math.max(p[1], q[1]) + 1e-9;
  if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) < Math.min(a[0], b[0])
    || Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) return false;
  return orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0
    || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}

function inside([x, y], polygon) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[i], [bx, by] = polygon[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) result = !result;
  }
  return result;
}

test('mandala backing composites its uniform rim and solid fill as one translucent noninteractive surface', () => {
  const markup = renderChartBackdrop('bodygraph', { mandala: true });
  assert.match(markup, new RegExp(`^<g class="mandala-underlay" pointer-events="none" aria-hidden="true" focusable="false" opacity="${CHART_MANDALA_SURFACE_OPACITY}">`));
  assert.ok(CHART_MANDALA_SURFACE_OPACITY > 0 && CHART_MANDALA_SURFACE_OPACITY < 1);
  assert.equal((markup.match(/<path\b/g) || []).length, 2);
  assert.match(markup, /fill="url\(#bodygraph-mandala-porcelain\)"/);
  assert.match(markup, new RegExp(`<path class="chart-surface-rim"[^>]* fill="none" stroke="${CHART_SURFACE.edge}" stroke-width="${CHART_SURFACE_RIM_WIDTH}"`));
  const paths = [...markup.matchAll(/<path\b[^>]*>/g)].map(match => match[0]);
  assert.match(paths[1], /fill="url\(#bodygraph-mandala-porcelain\)" stroke="none"/);
  assert.doesNotMatch(markup.replace(/^<g\b[^>]*>/, ''), /\s(?:fill-|stop-|stroke-)?opacity=/i, 'only the outer group controls transparency, never paths or stops independently');
  assert.doesNotMatch(markup, /transform=|filter|mask|clip-path|data-type|tabindex|href|<image|<script|<foreignObject|<rect|<ellipse|<circle|\son\w+=/i);
  assert.doesNotMatch(markup, /NaN|undefined|Infinity/);
  assert.equal(renderChartBackdrop('bodygraph', { mandala: true }), markup, 'no chart, hover, or selection state is needed');
  assert.equal(markup.match(/ d="([^"]+)"/)[1], CHART_SILHOUETTE_PATH);
});

test('the composited backing retains solid shared palette stops without changing the approved rim', () => {
  const markup = renderChartBackdrop('bodygraph', { mandala: true });
  assert.ok(Object.isFrozen(CHART_SURFACE));
  assert.equal((markup.match(/<linearGradient\b/g) || []).length, 1);
  assert.match(markup, /<linearGradient[^>]* x1="0" y1="0" x2="0" y2="1">/);
  const stops = [...markup.matchAll(/<stop offset="([^"]+)" stop-color="([^"]+)"\/>/g)];
  assert.deepEqual(stops.map(([, offset, color]) => [offset, color]), [
    ['0', CHART_SURFACE.top], ['.5', CHART_SURFACE.middle], ['1', CHART_SURFACE.bottom],
  ]);
  for (const [, , color] of stops) assert.match(color, /^#[0-9a-f]{6}$/i, 'six-digit colors are fully opaque');
  assert.doesNotMatch(markup.replace(/^<g\b[^>]*>/, ''), /transparent|rgba|\s(?:fill-|stop-|stroke-)?opacity=/i, 'ray visibility is applied once to the group instead of accumulating across painted layers');
});

test('backing gradient and fill reference are scoped, sanitized and leave the physical contour unchanged', () => {
  const path = renderChartBackdrop('bodygraph', { mandala: true }).match(/ d="([^"]+)"/)[1];
  const defined = [];
  for (const prefix of ['first-chart', 'second-chart', 'x\"><script>', '!!!']) {
    const markup = renderChartBackdrop(prefix, { mandala: true });
    const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(ids.length, 1);
    assert.match(ids[0], /^[a-zA-Z0-9_-]+$/);
    assert.deepEqual([...markup.matchAll(/url\(#([^)]+)\)/g)].map(match => match[1]), ids);
    assert.equal(markup.match(/ d="([^"]+)"/)[1], path);
    assert.doesNotMatch(markup, /<script>/);
    defined.push(ids[0]);
  }
  assert.equal(new Set(defined).size, defined.length, 'separate chart instances have independent gradients');
  assert.equal(renderChartBackdrop('!!!', { mandala: true }), renderChartBackdrop('bodygraph', { mandala: true }));
});

test('backing has symmetric bounds matching its free-standing silhouette, never a page-wide field', () => {
  const points = outline(), bounds = CHART_BACKDROP_BOUNDS;
  assert.ok(Object.isFrozen(bounds));
  assert.ok(bounds.x > 64 && bounds.x + bounds.width < 584, 'the free-standing form stays away from both calculation columns');
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 820, 'the surface stays inside the existing chart canvas');
  assert.equal(bounds.x + bounds.width / 2, 320);
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9);
  close(Math.min(...points.map(([x]) => x)), bounds.x);
  close(Math.max(...points.map(([x]) => x)), bounds.x + bounds.width);
  close(Math.min(...points.map(([, y]) => y)), bounds.y);
  close(Math.max(...points.map(([, y]) => y)), bounds.y + bounds.height);
  for (const [x, y] of points) {
    assert.ok(distanceToOutline([640 - x, y], points) < 1e-9, 'both sides of the silhouette mirror around the unchanged chart axis');
  }
});

test('the complete surface broadens smoothly into shoulders without the old pinched neck', () => {
  const polygon = outline();
  const widthAt = y => {
    const intersections = [];
    for (let i = 1; i < polygon.length; i++) {
      const [ax, ay] = polygon[i - 1], [bx, by] = polygon[i];
      if ((ay > y) !== (by > y)) intersections.push(ax + (bx - ax) * (y - ay) / (by - ay));
    }
    assert.equal(intersections.length, 2, `the horizontal section at ${y} is a single continuous form`);
    return Math.max(...intersections) - Math.min(...intersections);
  };
  const widths = [146, 180, 220, 256, 302, 352].map(widthAt);
  for (let i = 1; i < widths.length; i++) assert.ok(widths[i] > widths[i - 1], 'the upper body broadens into shoulders instead of following a narrow throat');
});

test('every cubic join including closure has continuous forward tangents without throat steps or upper notches', () => {
  const curves = outlineCurves();
  assert.deepEqual(curves.at(-1)[3], curves[0][0], 'closing the path adds no straight seam');
  for (let i = 0; i < curves.length; i++) {
    const current = curves[i], next = curves[(i + 1) % curves.length];
    const incoming = current[3].map((value, axis) => value - current[2][axis]);
    const outgoing = next[1].map((value, axis) => value - next[0][axis]);
    const lengths = Math.hypot(...incoming) * Math.hypot(...outgoing);
    assert.ok(lengths > 0, `join ${i} has nonzero tangents`);
    const cross = (incoming[0] * outgoing[1] - incoming[1] * outgoing[0]) / lengths;
    const dot = (incoming[0] * outgoing[0] + incoming[1] * outgoing[1]) / lengths;
    assert.ok(Math.abs(cross) < 1e-9 && dot > 1 - 1e-9, `join ${i} is smooth and never reverses into a cusp`);
  }
});

test('the flowing silhouette has no self-crossings or folded overlapping lobes', () => {
  const polygon = outline(), segments = polygon.length - 1;
  for (let i = 0; i < segments; i++) for (let j = i + 2; j < segments; j++) {
    if (i === 0 && j === segments - 1) continue;
    assert.equal(segmentsIntersect(polygon[i], polygon[i + 1], polygon[j], polygon[j + 1]), false, `outline segments ${i} and ${j} do not intersect`);
  }
});

test('backing covers every center, gate and physical channel without borrowing their hit areas', () => {
  const polygon = outline();
  for (const center of CENTERS) {
    for (const point of center.points.split(' ').map(pair => pair.split(',').map(Number))) {
      assert.ok(inside(point, polygon), `center ${center.id} is covered`);
    }
  }
  for (const { id, x, y } of GATES) assert.ok(inside([x, y], polygon), `gate ${id} is covered`);
  for (const { id, curves } of CHANNELS) {
    for (const curve of curves) {
      for (let step = 0; step <= 40; step++) {
        assert.ok(inside(sample(curve, step / 40), polygon), `channel ${id} is covered`);
      }
    }
  }
  assert.equal(inside([180, 180], polygon), false, 'the shared backing leaves room for left variable arrows in normal mode');
  assert.equal(inside([460, 180], polygon), false, 'the shared backing leaves room for right variable arrows in normal mode');
});

test('the complete fill footprint covers discs and center outlines and leaves extra space around every channel halo', () => {
  const polygon = outline();
  const markup = renderBodygraph({ personality: GATES.map(gate => gate.id), design: [] });
  const centerRadius = Number(markup.match(/<path class="bg-center-highlight"[^>]*stroke-width="([^"]+)"/)[1]) / 2;
  const channelRadius = Number(markup.match(/<path class="bg-channel-highlight"[^>]*stroke-width="([^"]+)"/)[1]) / 2;
  const gateTag = markup.match(/<circle class="bg-gate-disc"[^>]*>/)[0];
  const gateRadius = Number(gateTag.match(/\sr="([^"]+)"/)[1]) + Number(gateTag.match(/stroke-width="([^"]+)"/)[1]) / 2;
  const covered = (point, radius, label) => {
    assert.ok(inside(point, polygon), `${label} lies inside the backing`);
    const clearance = distanceToOutline(point, polygon);
    assert.ok(clearance >= radius, `${label} needs ${radius} painted units but only has ${clearance}`);
  };
  for (const center of CENTERS) {
    const points = center.points.split(' ').map(pair => pair.split(',').map(Number));
    for (let edge = 0; edge < points.length; edge++) {
      const a = points[edge], b = points[(edge + 1) % points.length];
      for (let i = 0; i <= 16; i++) covered(a.map((value, axis) => value + (b[axis] - value) * i / 16), centerRadius, `center ${center.id}`);
    }
  }
  for (const gate of GATES) covered([gate.x, gate.y], gateRadius, `gate ${gate.id}`);
  for (const channel of CHANNELS) for (const curve of channel.curves) {
    // The rim must not merely avoid clipping: even the selected outer routes
    // retain light breathing room, including the reported 35–36 shoulder.
    for (let i = 0; i <= 80; i++) covered(sample(curve, i / 80), channelRadius + 3, `channel ${channel.id} halo and breathing room`);
  }
});
