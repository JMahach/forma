import test from 'node:test';
import assert from 'node:assert/strict';
import { attachGestures } from './fixtures/gesture-harness.js';
import { CHART_FRAME, MANDALA_FRAME } from '../src/scene/geometry/frames.js';
import { COMPACT_TEST_FRAME, EXPANDED_TEST_FRAME } from './fixtures/camera-frames.js';

const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≈ ${expected}`);

function harness(t, { shared = false } = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'DOMPoint');
  globalThis.DOMPoint = class {
    constructor(x, y) { this.x = x; this.y = y; }
    matrixTransform(matrix) { return { x: this.x * matrix.a + matrix.e, y: this.y * matrix.d + matrix.f }; }
  };
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'DOMPoint', previous); else delete globalThis.DOMPoint; });
  let width = 390, height = 844, enabled = false, separateHome = !shared;
  const listeners = new Map(), changes = [], captures = new Set();
  const svg = {
    getBoundingClientRect: () => ({ left: 0, top: 0, right: width, bottom: height, width, height }),
    getScreenCTM: () => ({ inverse() {
      const scale = Math.min(width / 640, height / 820);
      return { a: 1 / scale, d: 1 / scale, e: -(width - 640 * scale) / (2 * scale), f: -(height - 820 * scale) / (2 * scale) };
    } }),
    addEventListener: (name, handler) => listeners.set(name, handler),
    classList: { toggle() {} }, closest: () => null,
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id),
  };
  const controls = attachGestures(svg, { setAttribute() {} }, {
    getFrame: () => separateHome ? enabled ? EXPANDED_TEST_FRAME : COMPACT_TEST_FRAME : enabled ? MANDALA_FRAME : CHART_FRAME,
    getHomeFrame: () => separateHome ? enabled ? EXPANDED_TEST_FRAME : COMPACT_TEST_FRAME : CHART_FRAME,
    fitInsets: { side: 20, top: 100, bottom: 100 },
    onSelect() {}, onChange: (view, fitted, limits) => changes.push({ view, fitted, limits }),
  });
  controls.reset();
  return {
    controls, changes,
    toggle() { enabled = !enabled; controls.resize(); },
    refresh() { enabled = !enabled; controls.refreshFrame(); },
    resize(w, h, nextSeparateHome = separateHome) { width = w; height = h; separateHome = nextSeparateHome; controls.resize(); },
    send(type, extra = {}) { listeners.get(type)({ type, pointerId: 1, pointerType: 'touch', button: 0, clientX: width / 2, clientY: height / 2, target: svg, preventDefault() {}, ...extra }); },
  };
}

test('camera minimum is exact Home for both test frames despite wider navigation', t => {
  const h = harness(t);
  for (let i = 0; i < 4; i++) {
    const home = h.controls.getFittedView();
    h.controls.zoom(.00001);
    h.send('wheel', { deltaY: 200, clientX: 30 });
    h.send('keydown', { key: '-' });
    h.send('pointerdown'); h.send('pointermove', { clientX: 800 }); h.send('pointerup', { clientX: 800 });
    h.send('pointerdown', { pointerId: 1, clientX: 145 });
    h.send('pointerdown', { pointerId: 2, clientX: 245 });
    h.send('pointermove', { pointerId: 2, clientX: 146 });
    h.send('pointerup', { pointerId: 2, clientX: 146 });
    h.send('pointerup', { pointerId: 1, clientX: 145 });
    assert.deepEqual(h.controls.getView(), home);
    assert.equal(h.changes.at(-1).limits.minScale, home.k);
    h.toggle();
    assert.deepEqual(h.controls.getView(), h.controls.getFittedView(), 'resizing its frame at 100% reaches its own exact Home');
  }
});

test('shared Home and all pan positions remain exact across refreshFrame', t => {
  const h = harness(t, { shared: true });
  for (const factor of [1, 2]) {
    h.controls.reset(); h.controls.zoom(factor);
    h.send('pointerdown'); h.send('pointermove', { clientX: 900 }); h.send('pointerup', { clientX: 900 });
    const before = h.controls.getView();
    for (let i = 0; i < 6; i++) { h.refresh(); h.controls.zoom(1); h.send('wheel', { deltaY: 0 }); }
    assert.deepEqual(h.controls.getView(), before);
  }
  h.controls.zoom(.00001);
  assert.deepEqual(h.controls.getView(), h.controls.getFittedView());
});

test('changing frames and resize map zoom and pan relative to Home without accumulating drift', t => {
  const h = harness(t);
  h.controls.zoom(1.6);
  const start = h.controls.getView();
  h.controls.setView({ ...start, x: start.x + 8, y: start.y - 6 });
  const before = h.controls.getView(), home = h.controls.getFittedView();
  h.toggle();
  const next = h.controls.getView(), nextHome = h.controls.getFittedView(), ratio = nextHome.k / home.k;
  closeTo(next.k / nextHome.k, before.k / home.k);
  closeTo(next.x, nextHome.x + (before.x - home.x) * ratio);
  closeTo(next.y, nextHome.y + (before.y - home.y) * ratio);
  h.toggle();
  for (const key of ['x', 'y', 'k']) closeTo(h.controls.getView()[key], before[key]);
  h.resize(844, 390);
  closeTo(h.controls.getView().k / h.controls.getFittedView().k, before.k / home.k);
  const resized = h.controls.getView();
  h.resize(844, 390);
  assert.deepEqual(h.controls.getView(), resized, 'the subsequent unchanged observer resize cannot move the camera');
});

test('changing frame policy preserves relative zoom across different Home frames', t => {
  const h = harness(t, { shared: true });
  h.resize(1200, 800, false); h.refresh();
  for (const factor of [1, 1.7]) {
    h.controls.reset(); h.controls.zoom(factor);
    const original = h.controls.getView(), previousHome = h.controls.getFittedView();
    h.resize(390, 844, true);
    const alternateHome = h.controls.getFittedView();
    closeTo(h.controls.getView().k / alternateHome.k, original.k / previousHome.k);
    if (factor === 1) assert.deepEqual(h.controls.getView(), alternateHome);
    h.resize(1200, 800, false);
    for (const key of ['x', 'y', 'k']) closeTo(h.controls.getView()[key], original[key]);
  }
});

test('pan edges remain valid through responsive Home rebases and absolute maximum zoom stays bounded', t => {
  const h = harness(t);
  for (const [dx, dy] of [[9000, 0], [-9000, 0], [0, 9000], [0, -9000]]) {
    h.controls.reset(); h.controls.zoom(1.6);
    h.send('pointerdown');
    h.send('pointermove', { clientX: 195 + dx, clientY: 422 + dy });
    h.send('pointerup', { clientX: 195 + dx, clientY: 422 + dy });
    const relative = h.controls.getView().k / h.controls.getFittedView().k;
    h.toggle();
    const midway = h.controls.getView();
    h.send('wheel', { deltaY: 0 });
    assert.deepEqual(h.controls.getView(), midway, 'a no-op gesture cannot snap a rebased pan edge');

    closeTo(h.controls.getView().k / h.controls.getFittedView().k, relative);
    h.toggle();
  }
  h.controls.zoom(100);
  assert.equal(h.controls.getView().k, 4.5);
  h.toggle(); h.toggle();
  assert.ok(h.controls.getView().k <= 4.5);
  h.resize(1600, 1200, false);
  assert.ok(h.controls.getView().k <= 4.5);
  assert.ok(h.controls.getView().k >= h.controls.getFittedView().k);
});
