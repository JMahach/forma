import test from 'node:test';
import assert from 'node:assert/strict';
import { attachGestures, DRAWING_BOUNDS, isHomeView } from '../src/bodygraph/gestures.js';
import { MANDALA_FRAME } from '../src/bodygraph/mandala-mode.js';
import { PHONE_CHART_FRAME, PHONE_MANDALA_FRAME } from '../src/bodygraph/studio-layout.js';

const CHART_FRAME = { bounds: DRAWING_BOUNDS, minScale: .65 };
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≈ ${expected}`);

function harness(t, { animated = false, reduced = false, shared = false } = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'DOMPoint');
  globalThis.DOMPoint = class {
    constructor(x, y) { this.x = x; this.y = y; }
    matrixTransform(matrix) { return { x: this.x * matrix.a + matrix.e, y: this.y * matrix.d + matrix.f }; }
  };
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'DOMPoint', previous); else delete globalThis.DOMPoint; });
  let width = 390, height = 844, enabled = false, phone = !shared, time = 0, nextId = 0;
  const frames = new Map(), listeners = new Map(), changes = [], captures = new Set();
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
    getFrame: () => phone ? enabled ? PHONE_MANDALA_FRAME : PHONE_CHART_FRAME : enabled ? MANDALA_FRAME : CHART_FRAME,
    getHomeFrame: () => phone ? enabled ? PHONE_MANDALA_FRAME : PHONE_CHART_FRAME : CHART_FRAME,
    fitInsets: { side: 20, top: 100, bottom: 100 },
    onSelect() {}, onChange: (view, fitted, limits) => changes.push({ view, fitted, limits }),
    cameraMotion: {
      now: () => time, reducedMotion: () => reduced,
      requestFrame: animated ? callback => { frames.set(++nextId, callback); return nextId; } : null,
      cancelFrame: id => frames.delete(id),
    },
  });
  controls.reset();
  return {
    controls, changes, frames,
    toggle() { enabled = !enabled; controls.transitionHome(); },
    refresh() { enabled = !enabled; controls.refreshFrame(); },
    advance(ms) { time += ms; const queue = [...frames.values()]; frames.clear(); queue.forEach(callback => callback(time)); },
    resize(w, h, nextPhone = phone) { width = w; height = h; phone = nextPhone; controls.resize(); },
    reduced(value) { reduced = value; },
    send(type, extra = {}) { listeners.get(type)({ type, pointerId: 1, pointerType: 'touch', button: 0, clientX: width / 2, clientY: height / 2, target: svg, preventDefault() {}, ...extra }); },
  };
}

test('studio minimum is exact Home in both mobile modes despite wider navigation', t => {
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
    assert.deepEqual(h.controls.getView(), h.controls.getFittedView(), 'changing mode at 100% reaches its own exact Home');
  }
});

test('desktop shared Home and all pan positions remain exact across refreshFrame', t => {
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

test('mobile mode and resize map zoom and pan relative to Home without accumulating drift', t => {
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

test('animated mobile Home remains 100% on every frame and rapid reversal starts from the visible camera', t => {
  const h = harness(t, { animated: true }), normal = h.controls.getView();
  h.toggle();
  assert.deepEqual(h.controls.getView(), normal, 'a toggle starts without a camera jump');
  assert.equal(h.frames.size, 1);
  h.advance(75);
  const midway = h.controls.getView();
  assert.notDeepEqual(midway, normal);
  assert.ok(isHomeView(midway, h.controls.getFittedView()));
  h.toggle();
  assert.deepEqual(h.controls.getView(), midway, 'reversal starts at the currently painted camera');
  assert.equal(h.frames.size, 1, 'only one animation owns the camera');
  h.advance(200);
  assert.deepEqual(h.controls.getView(), normal);
  assert.equal(h.frames.size, 0);
  for (const { view, fitted } of h.changes) assert.ok(isHomeView(view, fitted), 'no transient Home button or non-100% label');
});

test('reduced motion applies the new mode Home immediately and stops an in-flight transition', t => {
  const h = harness(t, { animated: true, reduced: true }), normal = h.controls.getView();
  h.toggle();
  assert.notDeepEqual(h.controls.getView(), normal);
  assert.deepEqual(h.controls.getView(), h.controls.getFittedView());
  assert.equal(h.frames.size, 0);
  h.reduced(false); h.toggle(); h.advance(50);
  h.reduced(true); h.advance(16);
  assert.deepEqual(h.controls.getView(), normal);
  assert.equal(h.frames.size, 0);
});

test('wheel, drag and pinch remain interactive during the Home transition and retain their resulting relative zoom', t => {
  const h = harness(t, { animated: true });
  h.toggle(); h.advance(40);
  h.send('wheel', { deltaY: -140 });
  const zoomed = h.controls.getView();
  assert.ok(zoomed.k > h.controls.getFittedView().k);
  h.send('pointerdown');
  h.send('pointermove', { clientX: 207, clientY: 414 });
  h.send('pointerup', { clientX: 207, clientY: 414 });
  assert.notDeepEqual(h.controls.getView(), zoomed, 'a drag moves the live camera rather than waiting for animation');
  h.send('pointerdown', { pointerId: 1, clientX: 145 });
  h.send('pointerdown', { pointerId: 2, clientX: 245 });
  h.send('pointermove', { pointerId: 2, clientX: 265 });
  h.send('pointerup', { pointerId: 2, clientX: 265 });
  h.send('pointerup', { pointerId: 1, clientX: 145 });
  const live = h.controls.getView(), home = h.controls.getFittedView();
  assert.equal(h.frames.size, 1, 'direct input does not leave a transient baseline or block the transition');
  h.advance(200);
  const final = h.controls.getView(), finalHome = h.controls.getFittedView(), ratio = finalHome.k / home.k;
  closeTo(final.k / finalHome.k, live.k / home.k);
  closeTo(final.x, finalHome.x + (live.x - home.x) * ratio);
  closeTo(final.y, finalHome.y + (live.y - home.y) * ratio);
  assert.equal(h.frames.size, 0);
  h.controls.zoom(.0001);
  assert.deepEqual(h.controls.getView(), finalHome, 'the completed mode has its true exact Home floor');
});

test('reversing an interactively zoomed transition preserves relative zoom and never revives a cancelled callback', t => {
  const h = harness(t, { animated: true });
  h.controls.zoom(1.5);
  h.toggle(); h.advance(60);
  h.controls.zoom(1.2);
  const live = h.controls.getView(), relative = live.k / h.controls.getFittedView().k;
  const staleCallback = [...h.frames.values()][0];
  h.toggle();
  assert.deepEqual(h.controls.getView(), live);
  staleCallback();
  assert.deepEqual(h.controls.getView(), live, 'an already queued obsolete callback cannot repaint the camera');
  assert.equal(h.frames.size, 1);
  h.advance(200);
  closeTo(h.controls.getView().k / h.controls.getFittedView().k, relative);
  assert.equal(h.frames.size, 0);
});

test('unchanged resize keeps animation running while a real resize or Home ends at the true target', t => {
  const h = harness(t, { animated: true });
  h.toggle(); h.advance(75);
  const midway = h.controls.getView();
  h.resize(390, 844);
  assert.deepEqual(h.controls.getView(), midway, 'a delayed identical observer notification has no effect');
  assert.equal(h.frames.size, 1);
  h.controls.zoom(1.4);
  const relative = h.controls.getView().k / h.controls.getFittedView().k;
  h.resize(844, 390);
  closeTo(h.controls.getView().k / h.controls.getFittedView().k, relative);
  assert.equal(h.frames.size, 0);
  h.toggle(); h.advance(50);
  h.controls.reset();
  assert.deepEqual(h.controls.getView(), h.controls.getFittedView());
  assert.equal(h.frames.size, 0, 'explicit Home cancels every remaining camera frame');
  const reset = h.controls.getView();
  h.advance(500);
  assert.deepEqual(h.controls.getView(), reset);
});

test('crossing the phone breakpoint in mandala preserves relative zoom across different Home frames', t => {
  const h = harness(t, { shared: true });
  h.resize(1200, 800, false); h.refresh();
  for (const factor of [1, 1.7]) {
    h.controls.reset(); h.controls.zoom(factor);
    const original = h.controls.getView(), previousHome = h.controls.getFittedView();
    h.resize(390, 844, true);
    const phoneHome = h.controls.getFittedView();
    closeTo(h.controls.getView().k / phoneHome.k, original.k / previousHome.k);
    if (factor === 1) assert.deepEqual(h.controls.getView(), phoneHome);
    h.resize(1200, 800, false);
    for (const key of ['x', 'y', 'k']) closeTo(h.controls.getView()[key], original[key]);
  }
});

test('mobile pan edges remain valid through transitions and absolute maximum zoom stays bounded', t => {
  const h = harness(t, { animated: true });
  for (const [dx, dy] of [[9000, 0], [-9000, 0], [0, 9000], [0, -9000]]) {
    h.controls.reset(); h.controls.zoom(1.6);
    h.send('pointerdown');
    h.send('pointermove', { clientX: 195 + dx, clientY: 422 + dy });
    h.send('pointerup', { clientX: 195 + dx, clientY: 422 + dy });
    const relative = h.controls.getView().k / h.controls.getFittedView().k;
    h.toggle(); h.advance(80);
    const midway = h.controls.getView();
    h.send('wheel', { deltaY: 0 });
    assert.deepEqual(h.controls.getView(), midway, 'a no-op gesture cannot snap an animated pan edge');
    h.advance(120);
    closeTo(h.controls.getView().k / h.controls.getFittedView().k, relative);
    h.toggle(); h.advance(200);
  }
  h.controls.zoom(100);
  assert.equal(h.controls.getView().k, 4.5);
  h.toggle(); h.advance(200); h.toggle(); h.advance(200);
  assert.ok(h.controls.getView().k <= 4.5);
  h.resize(1600, 1200, false);
  assert.ok(h.controls.getView().k <= 4.5);
  assert.ok(h.controls.getView().k >= h.controls.getFittedView().k);
});
