import { readModuleSource } from './helpers/module-source.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderLoadingPlaceholder } from '../src/scene/loading-placeholder.ts';
import { renderBodygraph } from '../src/scene/bodygraph-svg.ts';
import { createStudioLayout } from './fixtures/studio-layout.ts';
import { createCameraView } from '../src/scene/camera-view.ts';
import { createCamera } from '../src/scene/camera.ts';
import { DRAWING_TRANSFORM } from '../src/scene/geometry/drawing-presentation.ts';
import { MANDALA_FRAME } from '../src/scene/geometry/frames.ts';
import { CHANNEL_WIDTH } from '../src/scene/bodygraph-paint.ts';
import { CENTERS } from '../src/scene/geometry/chart-geometry.ts';
import { PLANETS } from '../src/domain/planets.ts';
import { SVG_NS, svgDocument } from './helpers/svg-dom.ts';

const parse = (markup: string) => {
  const node = svgDocument().createElementNS(SVG_NS, 'svg');
  node.innerHTML = markup;
  return node;
};
const close = (actual: number, expected: number, message: string) => assert.ok(Math.abs(actual - expected) < 1e-7, `${message}: ${actual} != ${expected}`);
const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const records = PLANETS.map(([planet], index) => ({ planet, gate: index + 1, line: index % 6 + 1 }));
const chart = { source: 'transit' as const, personality: records.map(row => row.gate), design: [],
  activations: { personality: records, design: [] },
  planetFilter: { selectedPlanets: PLANETS.map(([planet]) => planet), selectedDesignPlanets: [], activations: records, designActivations: records },
};

test('loading centers and both columns occupy the exact live SVG anchors, including unchecked Design', () => {
  const loading = parse(renderLoadingPlaceholder()), live = parse(renderBodygraph(chart, null, { profile: 'studio', showActivations: true }));
  assert.equal(loading.querySelector('.bodygraph-drawing')!.getAttribute('transform'), DRAWING_TRANSFORM);
  assert.equal(live.querySelector('.bodygraph-drawing')!.getAttribute('transform'), DRAWING_TRANSFORM);
  assert.deepEqual(loading.querySelectorAll('.loading-centers path').map(node => node.getAttribute('d')),
    live.querySelectorAll('.bg-center-shape').map(node => node.getAttribute('d')));
  const columns = loading.querySelectorAll('.activation-column');
  assert.deepEqual(columns.map(node => node.dataset.columnSide), ['left', 'right']);
  for (const column of columns) {
    const actual = live.querySelector(`.activation-column[data-column-side="${column.dataset.columnSide}"]`);
    assert.equal(column.querySelector('.activation-block-content')!.getAttribute('transform'), actual!.querySelector('.activation-block-content')!.getAttribute('transform'));
    const rows = column.querySelectorAll('.loading-activation-row'), actualRows = actual!.querySelectorAll('.activation-row');
    assert.equal(rows.length, PLANETS.length);
    assert.equal(actualRows.length, rows.length);
    for (const [index, row] of rows.entries()) {
      const actualRow = actualRows[index];
      assert.equal(row.getAttribute('transform'), actualRow.getAttribute('transform'));
      assert.equal(row.querySelector('circle')!.getAttribute('cx'), actualRow.querySelector('.planet-symbol')!.getAttribute('x'));
      const planetRect = actualRow.querySelector('.bg-planet rect');
      assert.equal(Number(row.querySelector('circle')!.getAttribute('cy')), Number(planetRect!.getAttribute('y')) + Number(planetRect!.getAttribute('height')) / 2, 'loading dot stays on the shared row center; the live font has an optical offset');
      assert.equal(row.querySelector('rect')!.getAttribute('x'), actualRow.querySelector('[data-type="gate"] text')!.getAttribute('x'));
    }
  }
  assert.doesNotMatch(renderLoadingPlaceholder(), /data-type=|data-activation=|tabindex=|role=|<script|<text/);
});

test('loading and live columns share one resting-gap CSS rule on the same side wrappers', () => {
  assert.match(styles, /#bodygraph \.bodygraph-drawing, #chartLoadingArt\s*\{\s*--activation-rest-gap:\s*calc\(14px \* \(1 - var\(--mandala-reveal, 0\)\)\)/);
  for (const columnSide of ['left', 'right'] as const) {
    const selector = `:is(#bodygraph, #chartLoadingArt) :is(.activation-column, .variable-block)[data-column-side='${columnSide}']`;
    const rule = styles.slice(styles.indexOf(selector)).split('}')[0];
    assert.ok(styles.includes(selector), `${columnSide} applies its translation to loading and live columns together`);
    assert.ok(rule.includes(columnSide === 'left' ? 'translate: calc(-1 * var(--activation-rest-gap)) 0' : 'translate: var(--activation-rest-gap) 0'));
  }
});

test('loading and live use one full-surface projection across panel space, safe areas, saved zoom and resize', () => {
  const firstRule = styles.match(/#chartLoadingArt\s*\{([^}]+)\}/)?.[1];
  assert.match(firstRule, /visibility:\s*hidden/, 'no frame is visible before camera painting');
  const box = parse(renderLoadingPlaceholder()).firstElementChild.getAttribute('viewBox')!.split(' ').map(Number);
  const liveBox = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').match(/id="bodygraph" viewBox="([^"]+)"/)![1].split(' ').map(Number);
  assert.deepEqual(box, liveBox, 'the silhouette and live drawing have the same SVG viewport');
  let full = { left: 20, top: 50, width: 1440, height: 900 }, left = false, right = false, phone = false;
  const values = new Map();
  const studio = { dataset: {} as DOMStringMap, style: { setProperty: (key, value) => values.set(key, value) },
    getBoundingClientRect: () => ({ ...full, right: full.left + full.width, bottom: full.top + full.height }) };
  const canvas = { dataset: {} as DOMStringMap, parentElement: studio, getBoundingClientRect() {
    const x = parseFloat(values.get('--studio-left-space')) || 0, end = parseFloat(values.get('--studio-right-space')) || 0;
    return { left: full.left + x, top: full.top, width: full.width - x - end, height: full.height,
      right: full.left + full.width - end, bottom: full.top + full.height };
  } };
  const art = { style: {} as unknown as CSSStyleDeclaration }, drawing = { style: {} as unknown as CSSStyleDeclaration, viewBox: { baseVal: { x: box[0], y: box[1], width: box[2], height: box[3] } },
    preserveAspectRatio: { baseVal: { align: 6, meetOrSlice: 1 } } };
  const layout = createStudioLayout({ canvas, panels: [], art, media: { get matches() { return phone; } }, viewport: null,
    readStyle: () => ({ scrollPaddingLeft: '20px', scrollPaddingTop: '74px', getPropertyValue: () => '8px' }),
    sidePanels: () => ({ left, right, leftWidth: 236, rightWidth: 320 }) });
  assert.deepEqual(art.style, {}, 'layout never publishes a competing placeholder rectangle or visibility');
  const view = createCameraView({ svg: drawing, surface: canvas, mirrors: [art] });
  const camera = createCamera({ getFrame: () => MANDALA_FRAME, getHomeFrame: layout.frame,
    measureFit: frame => view.measureFit(frame, layout.insets), onChange: pose => view.paint(pose) });
  const [a, b, c, d, tx, ty] = DRAWING_TRANSFORM.slice(7, -1).split(',').map(Number);
  const points = CENTERS.flatMap(center => center.points.split(' ').map(point => {
    const [x, y] = point.split(',').map(Number); return [a * x + c * y + tx, b * x + d * y + ty];
  }));
  for (const size of [[1440, 900], [1021, 727], [390, 844], [844, 390]] as const) {
    [full.width, full.height] = size; phone = full.width < 700;
    for (const state of [[false, false], [true, false], [false, true], [true, true]] as const) {
      [left, right] = state; layout.refresh();
      for (const saved of [null, { x: -170, y: -240, k: 2.4, maxK: 7 }] as const) {
        camera.restoreView(saved);
        const rect = canvas.getBoundingClientRect(), pose = camera.getView();
        const scale = Math.min(rect.width / box[2], rect.height / box[3]);
        const ox = (rect.width - box[2] * scale) / 2 - box[0] * scale;
        const oy = (rect.height - box[3] * scale) / 2 - box[1] * scale;
        assert.equal(art.style.transform, drawing.style.transform);
        assert.equal(art.style.visibility, 'visible');
        const matrix = art.style.transform.slice(7, -1).split(',').map(Number);
        for (const [x, y] of points) {
          const px = scale * x + ox, py = scale * y + oy;
          close(matrix[0] * px + matrix[4], scale * (pose.x + pose.k * x) + ox, 'loading center x');
          close(matrix[3] * py + matrix[5], scale * (pose.y + pose.k * y) + oy, 'loading center y');
        }
      }
      const transform = art.style.transform;
      layout.refresh();
      assert.equal(art.style.transform, transform, 'layout refresh cannot replace camera presentation');
      assert.ok(!['left', 'top', 'width', 'height'].some(key => key in art.style));
    }
  }
});

test('loading mandala and channel outlines reuse the live geometry without inventing data', () => {
  const loading = parse(renderLoadingPlaceholder());
  const live = parse(renderBodygraph(chart, null, { profile: 'studio', showActivations: true, showMandala: true }));
  assert.equal(loading.querySelector('.mandala-scene')?.getAttribute('transform'), live.querySelector('.mandala-scene')!.getAttribute('transform'));
  assert.deepEqual(loading.querySelectorAll('.loading-mandala circle').map(node => ['cx', 'cy', 'r'].map(key => node.getAttribute(key))),
    live.querySelectorAll('.mandala-engraving-edge circle').map(node => ['cx', 'cy', 'r'].map(key => node.getAttribute(key))));
  assert.deepEqual(loading.querySelectorAll('.loading-mandala path').map(node => node.getAttribute('d')),
    live.querySelectorAll('.mandala-separator').map(node => node.getAttribute('d')));
  assert.equal(Number(loading.querySelector('.loading-channels')!.getAttribute('stroke-width')), CHANNEL_WIDTH.outline);
  assert.doesNotMatch(renderLoadingPlaceholder(), /data-type=|data-activation=|tabindex=|role=|<script|<text/);
});

test('startup positions the loading SVG before importing the app and passes the same layout to its camera', () => {
  const startup = readModuleSource(new URL('../src/startup.ts', import.meta.url));
  const app = readModuleSource(new URL('../src/app.ts', import.meta.url));
  assert.match(startup, /createCameraView\(\{[^}]*mirrors: \[element\('chartLoadingArt'\)\]/);
  assert.ok(startup.indexOf('const layout = createStudioLayout(') < startup.indexOf("await import('./app.ts')"));
  assert.ok(startup.indexOf('loadingLayoutObserver.disconnect()') < startup.indexOf('app.startApp('));
  const passed = startup.match(/app\.startApp\(\{ ([^}]+) \}\s*\)/)?.[1].split(', ');
  const accepted = app.match(/startApp\(\{ ([^}]+) \}\s*\)/)?.[1].split(', ');
  for (const owner of ['layout', 'viewStore', 'panels', 'workspace', 'store', 'libraryView', 'camera', 'cameraView'] as const) {
    assert.ok(passed?.includes(owner), `startup passes its ${owner} owner`);
    assert.ok(accepted?.includes(owner), `app accepts the same ${owner} owner`);
  }
  assert.doesNotMatch(app, /createStudioLayout|createCameraView|createCamera\(/);
});
