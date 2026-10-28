import test from 'node:test';
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
  const view = createCameraView({ svg, surface });
  const measure = () => view.measureFit(frame, { side: 20, top: 100, bottom: 100 });
  const camera = createCamera({ getFrame: () => frame, getHomeFrame: () => frame,
    measureFit: measure, onChange: value => view.paint(value) });
  camera.reset();
  return { camera,
    setSurface(width: number, left = 0) { rect = { ...rect, left, width }; },
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
  near(adjacent.x - center.x, 45, 'the previous maximum detail size is retained');
  h.camera.zoomAt({ x: 500, y: 500 }, 1);
  h.camera.resize();
  const stable = h.screenPoint({ x: 510, y: 510 });
  near(stable.x - center.x, 45, 'the next no-op gesture and observer cannot shrink the picture');
  h.setSurface(1000); h.camera.resize({ preserveScale: true });
  near(h.camera.getView().k, 4.5, 'closing the panel returns to the original maximum');
});

test('restoring a panel-sized camera retains its elevated physical zoom ceiling', () => {
  const original = harness();
  original.camera.zoomAt({ x: 500, y: 500 }, 100);
  original.setSurface(600, 300); original.camera.resize({ preserveScale: true });
  near(original.camera.maximumScale?.() ?? 0, 7.5, 'the transferred ceiling is exposed for the view snapshot');
  const saved = original.camera.getView(), maxScale = original.camera.maximumScale();
  const restored = harness();
  restored.setSurface(600, 300); restored.camera.reset();
  restored.camera.setView(saved, { maxScale });
  assert.deepEqual(restored.camera.getView(), saved, 'reload does not reject a valid camera above the old SVG ceiling');
  restored.camera.zoomAt({ x: 500, y: 500 }, 100);
  assert.deepEqual(restored.camera.getView(), saved, 'the restored ceiling limits later zoom without shrinking details');
  restored.camera.resize();
  assert.deepEqual(restored.camera.getView(), saved, 'an unchanged observer keeps the restored pose');
});

test('restored scale limits reject malformed values without poisoning the next camera gesture', () => {
  const h = harness(); explore(h);
  for (const maxScale of [Infinity, NaN, 0, -1, 101] as const) {
    h.camera.setView({ x: -300, y: -300, k: 1.6 }, { maxScale });
    assert.deepEqual(h.camera.getView(), h.camera.getFittedView(), 'invalid saved limits fall back to Home');
    h.camera.zoomAt({ x: 500, y: 500 }, 100);
    near(h.camera.getView().k, 4.5, 'an invalid limit cannot replace the working ceiling');
  }
});

test('valid high-zoom restoration accepts the translated coordinates required by its scale', () => {
  const h = harness();
  h.setSurface(100); h.camera.reset();
  h.camera.setView({ x: -22000, y: -22000, k: 45 }, { maxScale: 45 });
  const center = h.screenPoint({ x: 500, y: 500 });
  const adjacent = h.screenPoint({ x: 510, y: 510 });
  near(center.x, 50, 'the same detail stays centered on the narrow surface');
  near(adjacent.x - center.x, 45, 'the high SVG-unit scale remains a reasonable on-screen size');
});
