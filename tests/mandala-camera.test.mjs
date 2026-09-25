import test from 'node:test';
import assert from 'node:assert/strict';
import { attachGestures, DRAWING_BOUNDS, fitView, validView } from '../src/bodygraph/gestures.js';
import { MANDALA_FRAME } from '../src/bodygraph/mandala-mode.js';

const MANDALA_BOUNDS = MANDALA_FRAME.bounds;
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≈ ${expected}`);

function harness(t, width = 390, height = 844, enabled = true) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'DOMPoint');
  globalThis.DOMPoint = class {
    constructor(x, y) { this.x = x; this.y = y; }
    matrixTransform(matrix) { return { x: matrix.a * this.x + matrix.e, y: matrix.d * this.y + matrix.f }; }
  };
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'DOMPoint', previous); else delete globalThis.DOMPoint; });
  let rect = { left: 0, top: 0, width, height }, mode = enabled, backgroundTaps = 0;
  const listeners = new Map(), selections = [], captures = new Set();
  const screenMatrix = () => {
    const scale = Math.min(rect.width / 640, rect.height / 820);
    return { scale, x: rect.left + (rect.width - 640 * scale) / 2, y: rect.top + (rect.height - 820 * scale) / 2 };
  };
  const svg = {
    addEventListener: (type, callback) => listeners.set(type, callback),
    getScreenCTM: () => ({ inverse() { const { scale, x, y } = screenMatrix(); return { a: 1 / scale, d: 1 / scale, e: -x / scale, f: -y / scale }; } }),
    getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }),
    setPointerCapture: id => captures.add(id),
    hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id),
    classList: { toggle() {} }, closest: () => null,
  };
  const controls = attachGestures(svg, { setAttribute() {} }, {
    onSelect: value => selections.push(value), onChange() {}, onBackgroundTap() { backgroundTaps++; },
    getFrame: () => mode === 'pending' ? undefined : mode ? { bounds: MANDALA_BOUNDS, minScale: 0.1 } : { bounds: DRAWING_BOUNDS, minScale: 0.65 },
  });
  const send = (type, extra = {}) => listeners.get(type)({
    type, pointerId: 1, pointerType: 'touch', button: 0, clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2, target: svg, preventDefault() {}, ...extra,
  });
  const projected = (view = controls.getView(), bounds = mode ? MANDALA_BOUNDS : DRAWING_BOUNDS) => {
    const { scale, x, y } = screenMatrix();
    return { left: x + (view.x + bounds.x * view.k) * scale,
      right: x + (view.x + (bounds.x + bounds.width) * view.k) * scale,
      top: y + (view.y + bounds.y * view.k) * scale,
      bottom: y + (view.y + (bounds.y + bounds.height) * view.k) * scale };
  };
  controls.reset();
  return { controls, send, selections, projected, captures, svg,
    get rect() { return { ...rect }; }, get backgroundTaps() { return backgroundTaps; },
    mode(value) { mode = value; controls.reset(); },
    resize(nextWidth, nextHeight) { rect = { ...rect, width: nextWidth, height: nextHeight }; controls.resize(); },
  };
}

function assertFullyVisible(h) {
  const frame = h.projected(), rect = h.rect;
  assert.ok(frame.left >= rect.left - 1e-8, 'the full frame stays within the left screen edge');
  assert.ok(frame.right <= rect.left + rect.width + 1e-8, 'the full frame stays within the right screen edge');
  assert.ok(frame.top >= rect.top - 1e-8, 'the full frame stays below the screen top');
  assert.ok(frame.bottom <= rect.top + rect.height + 1e-8, 'the full frame stays above the screen bottom');
  closeTo((frame.left + frame.right) / 2, rect.left + rect.width / 2);
}

test('optional fitting and validation limits leave the normal camera defaults unchanged', () => {
  const area = { x: 0, y: 0, width: 200, height: 250 };
  assert.equal(fitView(MANDALA_BOUNDS, area).k, 0.65);
  const wide = fitView(MANDALA_BOUNDS, area, { min: 0.1 });
  assert.equal(wide.k, 200 / 1024);
  assert.equal(validView(wide), false);
  assert.equal(validView(wide, { min: 0.1 }), true);
  assert.equal(validView({ ...wide, k: NaN }, { min: 0.1 }), false);
  assert.equal(validView({ ...wide, k: 5 }, { min: 0.1 }), false);
  assert.equal(fitView(DRAWING_BOUNDS, { x: 0, y: 0, width: 9000, height: 9000 }).k, 4.5);
});

test('an unattached mode controller returning undefined falls back to the unchanged normal frame', t => {
  const h = harness(t, 640, 820, 'pending');
  assert.deepEqual(h.controls.getView(), fitView(DRAWING_BOUNDS, { x: 22, y: 128, width: 596, height: 620 }));
  h.mode(true);
  assertFullyVisible(h);
});

for (const [width, height] of [[320, 568], [390, 844], [844, 390], [568, 320], [1440, 900], [160, 120]]) {
  test(`mandala home fits the entire ${width}×${height} screen immediately and after a resize`, t => {
    const h = harness(t, width, height);
    assertFullyVisible(h);
    assert.deepEqual(h.controls.getView(), h.controls.getFittedView());
    h.controls.zoom(0.0001);
    assertFullyVisible(h);
    assert.deepEqual(h.controls.getView(), h.controls.getFittedView(), 'zoom out keeps the exact fitted home');
    h.resize(height, width);
    assertFullyVisible(h);
    assert.deepEqual(h.controls.getView(), h.controls.getFittedView(), 'rotation keeps an unzoomed frame fully visible');
  });
}

test('normal camera can be restored exactly after a mandala visit with unchanged screen size', t => {
  const h = harness(t, 1280, 960, false);
  h.controls.zoom(1.5);
  const saved = h.controls.getView(), savedFit = h.controls.getFittedView();
  h.mode(true);
  assertFullyVisible(h);
  h.controls.zoom(2);
  h.mode(false);
  assert.deepEqual(h.controls.getFittedView(), savedFit);
  h.controls.setView(saved);
  assert.deepEqual(h.controls.getView(), saved);
  const copy = h.controls.getFittedView();
  copy.k = 99; copy.x = 99;
  assert.deepEqual(h.controls.getFittedView(), savedFit, 'the snapshot does not expose mutable camera state');
});

test('saved normal zoom can be restored relative to its new fitted frame after rotation in mandala mode', t => {
  const h = harness(t, 1280, 960, false);
  h.controls.zoom(1.5);
  const saved = h.controls.getView(), savedFit = h.controls.getFittedView();
  h.mode(true);
  h.resize(390, 844);
  assertFullyVisible(h);
  h.mode(false);
  const next = h.controls.getFittedView(), ratio = next.k / savedFit.k;
  h.controls.setView({ x: next.x + (saved.x - savedFit.x) * ratio,
    y: next.y + (saved.y - savedFit.y) * ratio, k: saved.k * ratio });
  closeTo(h.controls.getView().k / next.k, saved.k / savedFit.k);
});

test('expanded camera validates and restores sub-normal-scale views without resetting zoom', t => {
  const h = harness(t, 320, 568);
  const fitted = h.controls.getFittedView();
  assert.ok(fitted.k < 0.65);
  h.controls.zoom(1.1);
  const saved = h.controls.getView();
  assert.ok(saved.k < 0.65);
  h.controls.reset();
  h.controls.setView(saved);
  assert.deepEqual(h.controls.getView(), saved);
  h.controls.setView({ ...saved, k: -1 });
  assert.deepEqual(h.controls.getView(), fitted, 'invalid views still reset safely');
});

test('mandala wheel, bounded pan and pinch keep home covered while Shift keeps its exact selection semantics', t => {
  const h = harness(t, 1280, 960);
  const home = h.projected(), target = { closest: () => ({ dataset: { type: 'gate', id: '20' } }) };
  h.send('pointerdown', { target, shiftKey: true });
  h.send('pointerup', { target, shiftKey: false });
  assert.deepEqual(h.selections, [{ type: 'gate', id: '20', additive: true }]);
  h.send('keydown', { key: 'Enter', target, shiftKey: true });
  assert.deepEqual(h.selections.at(-1), { type: 'gate', id: '20', additive: true });
  h.send('wheel', { deltaY: -200 });
  const beforeDrag = h.controls.getView();
  h.send('pointerdown', { target, shiftKey: true });
  h.send('pointermove', { target, shiftKey: true, clientX: 5000, clientY: -5000 });
  h.send('pointerup', { target, clientX: 5000, clientY: -5000 });
  assert.notDeepEqual(h.controls.getView(), beforeDrag);
  const moved = h.projected();
  assert.ok(moved.left <= home.left + 1e-8 && moved.right >= home.right - 1e-8);
  assert.ok(moved.top <= home.top + 1e-8 && moved.bottom >= home.bottom - 1e-8);
  h.controls.reset();
  h.send('pointerdown', { pointerId: 1, clientX: 540, target, shiftKey: true });
  h.send('pointerdown', { pointerId: 2, clientX: 740, target, shiftKey: true });
  h.send('pointermove', { pointerId: 2, clientX: 840, target, shiftKey: true });
  assert.ok(h.controls.getView().k > h.controls.getFittedView().k);
  h.send('pointerup', { pointerId: 2, clientX: 840, target });
  h.send('pointerup', { pointerId: 1, clientX: 540, target });
  assert.equal(h.selections.length, 2, 'drag and pinch never select or remove a gate');
  assert.equal(h.backgroundTaps, 0);
  assert.equal(h.captures.size, 0);
  h.controls.zoom(0.0001);
  assertFullyVisible(h);
  h.send('pointerdown'); h.send('pointerup');
  assert.equal(h.backgroundTaps, 1, 'a fresh background tap still uses the existing callback');
});
