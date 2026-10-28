import test from 'node:test';
import { MAX_ZOOM } from '../src/scene/camera.ts';
import assert from 'node:assert/strict';
import { createCamera } from '../src/scene/camera.ts';
import { createCameraView } from '../src/scene/camera-view.ts';

const near = (actual: number, expected: number, message: string) => assert.ok(Math.abs(actual - expected) < 1e-8,
  `${message}: ${actual} should equal ${expected}`);
const frame = { bounds: { x: 0, y: 0, width: 1000, height: 1000 }, minScale: .1 };

function harness() {
  let rect = { left: 0, top: 0, width: 1000, height: 1000 };
  const surface = { getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }) };
  const svg = { style: {} as unknown as CSSStyleDeclaration, viewBox: { baseVal: { ...frame.bounds } },
    preserveAspectRatio: { baseVal: { align: 6, meetOrSlice: 1 } } };
  const referenceSurface = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: rect.height, width: 1000, height: rect.height }) };
  const view = createCameraView({ svg, surface, referenceSurface });
  const measure = () => view.measureFit(frame, { side: 20, top: 100, bottom: 100 });
  const camera = createCamera({ getFrame: () => frame, getHomeFrame: () => frame,
    measureFit: measure, onChange: value => view.paint(value) });
  camera.reset();
  return { camera,
    setSurface(width: number, left = 0, height = rect.height) { rect = { ...rect, left, width, height }; },
    // Project the actual CSS matrix and known centered 1000 × 1000 viewBox.
    // A missing projection correction must visibly change the result below.
    screenPoint(point) {
      const scale = Math.min(rect.width, rect.height) / 1000;
      const x = (rect.width - 1000 * scale) / 2 + point.x * scale;
      const y = (rect.height - 1000 * scale) / 2 + point.y * scale;
      assert.match(svg.style.transform, /^matrix3d\(/);
      const matrix = svg.style.transform.slice(9, -1).split(',').map(Number);
      return { x: rect.left + matrix[0] * x + matrix[4] * y + matrix[12],
        y: rect.top + matrix[1] * x + matrix[5] * y + matrix[13] };
    },
  };
}

function explore(h) {
  h.camera.zoomAt({ x: 500, y: 500 }, 2);
  h.camera.pan(-80, 40);
  // Hand-derived center after Home (.8,100,100), 2x zoom and the pan:
  // (500 + 380) / 1.6 = 550; (500 + 260) / 1.6 = 475.
}
function assertDetail(h, x, y) {
  const center = h.screenPoint({ x: 550, y: 475 });
  near(center.x, x, 'the inspected point is at the new free-area center');
  near(center.y, y, 'the inspected point keeps its vertical center');
  const adjacent = h.screenPoint({ x: 560, y: 485 });
  near(adjacent.x - center.x, 16, 'horizontal detail size remains 16 CSS pixels');
  near(adjacent.y - center.y, 16, 'vertical detail size remains 16 CSS pixels');
}

test('panel resize keeps the inspected center and physical detail size across SVG projection changes', () => {
  const h = harness(); explore(h); assertDetail(h, 500, 500);
  h.setSurface(600, 300);
  h.camera.resize({ preserveScale: true });
  assertDetail(h, 600, 500);
  const resized = h.camera.getView();
  h.camera.resize();
  assert.deepEqual(h.camera.getView(), resized, 'the following unchanged ResizeObserver notification is inert');
  assertDetail(h, 600, 500);
});

test('opening then closing panels returns the zoomed camera without drift', () => {
  const h = harness(); explore(h);
  const before = h.camera.getView();
  for (let i = 0; i < 4; i++) {
    h.setSurface(600, 300); h.camera.resize({ preserveScale: true });
    assertDetail(h, 600, 500);
    h.setSurface(1000); h.camera.resize({ preserveScale: true });
    assertDetail(h, 500, 500);
    for (const key of ['x', 'y', 'k'] as const) near(h.camera.getView()[key], before[key], `round trip ${key}`);
  }
});

test('a Home camera fits completely inside the new panel-free area', () => {
  const h = harness();
  h.setSurface(600, 300); h.camera.resize({ preserveScale: true });
  assert.deepEqual(h.camera.getView(), h.camera.getFittedView());
  const left = h.screenPoint({ x: 0, y: 500 });
  const right = h.screenPoint({ x: 1000, y: 500 });
  near(left.x, 320, 'left edge clears the panel and 20px inset');
  near(right.x, 880, 'right edge clears the 20px inset');
  near(left.y, 500, 'Home is centered vertically');
});

test('a panel cannot shrink details at the previous maximum zoom', () => {
  const h = harness();
  h.camera.zoomAt({ x: 500, y: 500 }, 100);
  h.setSurface(600, 300); h.camera.resize({ preserveScale: true });
  const center = h.screenPoint({ x: 500, y: 500 });
  const adjacent = h.screenPoint({ x: 510, y: 510 });
  near(center.x, 600, 'the inspected center is retained at maximum zoom');
  near(adjacent.x - center.x, 10 * MAX_ZOOM, 'the previous maximum detail size is retained');
  h.camera.zoomAt({ x: 500, y: 500 }, 1);
  h.camera.resize();
  const stable = h.screenPoint({ x: 510, y: 510 });
  near(stable.x - center.x, 10 * MAX_ZOOM, 'the next no-op gesture and observer cannot shrink the picture');
  h.setSurface(1000); h.camera.resize({ preserveScale: true });
  near(h.camera.getView().k, MAX_ZOOM, 'closing the panel returns to the original maximum');
});

test('restoring a panel-sized camera retains its elevated physical zoom ceiling', () => {
  const original = harness();
  original.camera.zoomAt({ x: 500, y: 500 }, 100);
  original.setSurface(600, 300); original.camera.resize({ preserveScale: true });
  near(original.camera.maximumScale?.() ?? 0, MAX_ZOOM / .6, 'the current projection supplies the panel-adjusted ceiling');
  const position = original.camera.getView(), saved = original.camera.getSavedView();
  const restored = harness();
  restored.setSurface(600, 300); restored.camera.reset();
  restored.camera.restoreView(saved);
  for (const key of ['x', 'y', 'k'] as const) near(restored.camera.getView()[key], position[key], 'reload does not reject a valid camera above the old SVG ceiling');
  restored.camera.zoomAt({ x: 500, y: 500 }, 100);
  for (const key of ['x', 'y', 'k'] as const) near(restored.camera.getView()[key], position[key], 'the restored ceiling limits later zoom without shrinking details');
  restored.camera.resize();
  for (const key of ['x', 'y', 'k'] as const) near(restored.camera.getView()[key], position[key], 'an unchanged observer keeps the restored pose');
});

test('legacy scale limits cannot poison the next camera gesture', () => {
  const h = harness(); explore(h);
  for (const maxScale of [Infinity, NaN, 0, -1, 101] as const) {
    h.camera.restoreView({ x: -300, y: -300, k: 1.6, maxK: maxScale });
    h.camera.zoomAt({ x: 500, y: 500 }, 100);
    near(h.camera.getView().k, MAX_ZOOM, 'an invalid limit cannot replace the working ceiling');
  }
});

test('valid high-zoom restoration accepts the translated coordinates required by its scale', () => {
  const h = harness();
  h.setSurface(100); h.camera.reset();
  const k = MAX_ZOOM / .1;
  h.camera.setView({ x: 500 - 500 * k, y: 500 - 500 * k, k });
  const center = h.screenPoint({ x: 500, y: 500 });
  const adjacent = h.screenPoint({ x: 510, y: 510 });
  near(center.x, 50, 'the same detail stays centered on the narrow surface');
  near(adjacent.x - center.x, 10 * MAX_ZOOM, 'the high SVG-unit scale remains a reasonable on-screen size');
});


test('legacy saved maximum is reduced once without losing the inspected point', () => {
  const h = harness();
  // Old Home (.8,100,100), centered 4.5x view and its old relative ceiling.
  const legacy = { x: -2312.5, y: -2312.5, k: 5.625, maxK: 5.625 };
  h.camera.restoreView(legacy);
  near(h.camera.getView().k, MAX_ZOOM, 'the old maximum cannot return after reload');
  near(h.screenPoint({ x: 500, y: 500 }).x, 500, 'the inspected point stays centered');
  const saved = h.camera.getSavedView(), before = h.camera.getView();
  for (let i = 0; i < 3; i++) {
    h.camera.restoreView(saved);
    assert.deepEqual(h.camera.getView(), before, 'new snapshots do not shrink again on reload');
  }
  h.camera.zoomAt({ x: 500, y: 500 }, 100);
  near(h.camera.getView().k, MAX_ZOOM, 'further gestures retain the reduced ceiling');
});


test('reloading into a taller viewport cannot raise the authored zoom ceiling', () => {
  const original = harness();
  original.setSurface(1000, 0, 800); original.camera.reset();
  original.camera.zoomAt({ x: 500, y: 500 }, 100);
  const restored = harness();
  restored.camera.restoreView(original.camera.getSavedView());
  near(restored.camera.maximumScale(), MAX_ZOOM, 'a taller Home is not permission for stronger zoom');
  restored.camera.zoomAt({ x: 500, y: 500 }, 100);
  near(restored.camera.getView().k, MAX_ZOOM, 'gestures still stop at the current limit');
});

test('old saved ceiling metadata cannot override the current no-panel maximum', () => {
  const h = harness();
  h.camera.restoreView({ x: -2312.5, y: -2312.5, k: 5.625, maxK: 8, zoomLimit: 3.6 });
  near(h.camera.getView().k, MAX_ZOOM, 'an old enlarged maximum is clamped around the inspected point');
  near(h.screenPoint({ x: 500, y: 500 }).x, 500, 'clamping keeps the inspected point centered');
});
