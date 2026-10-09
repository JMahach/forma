import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderLoadingPlaceholder } from '../src/scene/loading-placeholder.js';
import { renderBodygraph } from '../src/scene/bodygraph-svg.js';
import { createStudioLayout } from '../src/scene/studio-controller.js';
import { computeCameraFit } from '../src/scene/layout.js';
import { fitView } from '../src/scene/camera.js';
import { DRAWING_TRANSFORM } from '../src/scene/geometry/drawing-presentation.js';
import { STUDIO_FRAME } from '../src/scene/geometry/frames.js';
import { CENTERS } from '../src/scene/geometry/chart-geometry.js';
import { PLANETS } from '../src/domain/planets.js';
import { SVG_NS, svgDocument } from './helpers/svg-dom.mjs';

const parse = markup => {
  const node = svgDocument().createElementNS(SVG_NS, 'svg');
  node.innerHTML = markup;
  return node;
};
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-7, `${message}: ${actual} != ${expected}`);
const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const records = PLANETS.map(([planet], index) => ({ planet, gate: index + 1, line: index % 6 + 1 }));
const chart = { source: 'transit', personality: records.map(row => row.gate), design: [],
  activations: { personality: records, design: [] },
  planetFilter: { selectedPlanets: PLANETS.map(([planet]) => planet), selectedDesignPlanets: [], activations: records, designActivations: records },
};

test('loading centers and both columns occupy the exact live SVG anchors, including unchecked Design', () => {
  const loading = parse(renderLoadingPlaceholder()), live = parse(renderBodygraph(chart, null, { profile: 'studio', showActivations: true }));
  assert.equal(loading.querySelector('.bodygraph-drawing').getAttribute('transform'), DRAWING_TRANSFORM);
  assert.equal(live.querySelector('.bodygraph-drawing').getAttribute('transform'), DRAWING_TRANSFORM);
  assert.deepEqual(loading.querySelectorAll('.loading-centers path').map(node => node.getAttribute('d')),
    live.querySelectorAll('.bg-center-shape').map(node => node.getAttribute('d')));
  const columns = loading.querySelectorAll('.activation-column');
  assert.deepEqual(columns.map(node => node.dataset.source), ['design', 'personality']);
  for (const column of columns) {
    const actual = live.querySelector(`.activation-column[data-source="${column.dataset.source}"]`);
    assert.equal(column.querySelector('.activation-block-content').getAttribute('transform'), actual.querySelector('.activation-block-content').getAttribute('transform'));
    const rows = column.querySelectorAll('.loading-activation-row'), actualRows = actual.querySelectorAll('.activation-row');
    assert.equal(rows.length, PLANETS.length);
    assert.equal(actualRows.length, rows.length);
    for (const [index, row] of rows.entries()) {
      const actualRow = actualRows[index];
      assert.equal(row.getAttribute('transform'), actualRow.getAttribute('transform'));
      assert.equal(row.querySelector('circle').getAttribute('cx'), actualRow.querySelector('.planet-symbol').getAttribute('x'));
      const planetRect = actualRow.querySelector('.bg-planet rect');
      assert.equal(Number(row.querySelector('circle').getAttribute('cy')), Number(planetRect.getAttribute('y')) + Number(planetRect.getAttribute('height')) / 2, 'loading dot stays on the shared row center; the live font has an optical offset');
      assert.equal(row.querySelector('rect').getAttribute('x'), actualRow.querySelector('[data-type="gate"] text').getAttribute('x'));
    }
  }
  assert.doesNotMatch(renderLoadingPlaceholder(), /data-type=|data-activation=|tabindex=|role=|<script|<text/);
});

test('loading and live columns share one resting-gap CSS rule on the same source wrappers', () => {
  assert.match(styles, /#bodygraph \.bodygraph-drawing, #chartLoadingArt\s*\{\s*--activation-rest-gap:\s*calc\(14px \* \(1 - var\(--mandala-reveal, 0\)\)\)/);
  for (const source of ['design', 'personality']) {
    const selector = `:is(#bodygraph, #chartLoadingArt) :is(.activation-column, .variable-block)[data-source='${source}']`;
    const rule = styles.slice(styles.indexOf(selector)).split('}')[0];
    assert.ok(styles.includes(selector), `${source} applies its translation to loading and live columns together`);
    assert.ok(rule.includes(source === 'design' ? 'translate: calc(-1 * var(--activation-rest-gap)) 0' : 'translate: var(--activation-rest-gap) 0'));
  }
});

test('loading art becomes visible only at the exact camera placement, including initialization, resize and safe areas', () => {
  const firstRule = styles.match(/#chartLoadingArt\s*\{([^}]+)\}/)?.[1];
  assert.match(firstRule, /visibility:\s*hidden/, 'the CSS-only placeholder cannot expose an unplaced frame');
  let visible = false, revealed = 0;
  const art = { style: {
    get visibility() { return visible ? 'visible' : 'hidden'; },
    set visibility(value) {
      assert.ok(['left', 'top', 'width', 'height'].every(key => Number.isFinite(parseFloat(this[key]))),
        'all measured placement fields are written before the first visible frame');
      visible = value === 'visible'; revealed++;
    },
  } }, canvas = { dataset: {} };
  let rect, style;
  canvas.getBoundingClientRect = () => rect;
  const resize = ([width, height, side, top, bottom]) => {
    rect = { left: 20, top: 50, right: 20 + width, bottom: 50 + height, width, height };
    style = { scrollPaddingLeft: `${side}px`, scrollPaddingTop: `${top}px`, scrollPaddingBottom: `${bottom}px` };
  };
  resize([390, 844, 12, 112, 64]);
  assert.equal(art.style.visibility, 'hidden');
  const controller = createStudioLayout({ canvas, panels: [], art, media: { matches: true }, readStyle: () => style });
  assert.equal(art.style.visibility, 'visible', 'layout reveals the art immediately without waiting for app or data');
  assert.equal(revealed, 1);
  const bounds = parse(renderLoadingPlaceholder()).firstElementChild.getAttribute('viewBox').split(' ').map(Number);
  assert.deepEqual(bounds, [STUDIO_FRAME.bounds.x, STUDIO_FRAME.bounds.y, STUDIO_FRAME.bounds.width, STUDIO_FRAME.bounds.height]);
  const [a, b, c, d, tx, ty] = DRAWING_TRANSFORM.slice(7, -1).split(',').map(Number);
  const points = CENTERS.flatMap(center => center.points.split(' ').map(point => {
    const [x, y] = point.split(',').map(Number);
    return [a * x + c * y + tx, b * x + d * y + ty];
  }));
  // Exercise a nonidentity outer SVG screen matrix as well as both aspect ratios.
  const screenScale = .7, screenOffset = { x: 38, y: -23 };
  for (const dimensions of [[390, 844, 12, 112, 64], [1440, 900, 20, 74, 52], [844, 390, 28, 74, 98], [320, 180, 4, 112, 64]]) {
    resize(dimensions);
    const layout = controller.refresh();
    const { area, min } = computeCameraFit(controller.frame(), rect, controller.insets(), (x, y) => ({
      x: (x - rect.left - screenOffset.x) / screenScale, y: (y - rect.top - screenOffset.y) / screenScale,
    }));
    const view = fitView(controller.frame().bounds, area, { min });
    const left = parseFloat(art.style.left), top = parseFloat(art.style.top), width = parseFloat(art.style.width), height = parseFloat(art.style.height);
    assert.deepEqual({ x: left, y: top, width, height }, layout.area, 'controller positions the placeholder from the shared computed area');
    assert.equal(art.style.visibility, 'visible');
    const scale = Math.min(width / bounds[2], height / bounds[3]);
    for (const [x, y] of points) {
      const loadingX = left + (width - bounds[2] * scale) / 2 + (x - bounds[0]) * scale;
      const loadingY = top + (height - bounds[3] * scale) / 2 + (y - bounds[1]) * scale;
      close(loadingX, screenOffset.x + (view.x + x * view.k) * screenScale, `${dimensions[0]}×${dimensions[1]} center x`);
      close(loadingY, screenOffset.y + (view.y + y * view.k) * screenScale, `${dimensions[0]}×${dimensions[1]} center y`);
    }
  }
});

test('startup positions the loading SVG before importing the app and passes the same layout to its camera', () => {
  const startup = readFileSync(new URL('../src/startup.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(startup, /createStudioLayout\(\{[^}]*art: element\('chartLoadingArt'\)/);
  assert.ok(startup.indexOf('const layout = createStudioLayout(') < startup.indexOf("await import('./app.js')"));
  assert.ok(startup.indexOf('loadingLayoutObserver.disconnect()') < startup.indexOf('app.startApp('));
  assert.match(startup, /app\.startApp\(\{ dayClient, layout, toast, viewStore, savedView \}\)/);
  assert.match(app, /startApp\(\{ dayClient, layout, toast, viewStore, savedView \}\)/);
  assert.doesNotMatch(app, /createStudioLayout/);
});
