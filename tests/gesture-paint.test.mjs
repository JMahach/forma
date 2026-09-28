import test from 'node:test';
import assert from 'node:assert/strict';
import { attachGestures } from '../src/scene/gestures.js';
import { COMPACT_TEST_FRAME, EXPANDED_TEST_FRAME } from './fixtures/camera-frames.js';

let originalDOMPoint;
test.beforeEach(() => {
  originalDOMPoint = Object.getOwnPropertyDescriptor(globalThis, 'DOMPoint');
  globalThis.DOMPoint = class {
    constructor(x, y) { this.x = x; this.y = y; }
    matrixTransform(matrix) {
      return { x: this.x * matrix.a + matrix.e, y: this.y * matrix.d + matrix.f };
    }
  };
});
test.afterEach(() => {
  if (originalDOMPoint) Object.defineProperty(globalThis, 'DOMPoint', originalDOMPoint);
  else delete globalThis.DOMPoint;
});

function harness({ deferred = true, animated = false } = {}) {
  const listeners = new Map(), captures = new Set(), queued = new Map(), motionFrames = new Map();
  const changes = [], transforms = [], selections = [];
  let nextId = 0, time = 0, width = 640, height = 820, mandala = false;
  const frame = () => mandala ? EXPANDED_TEST_FRAME : COMPACT_TEST_FRAME;
  const svg = {
    addEventListener: (name, handler) => listeners.set(name, handler),
    getScreenCTM: () => ({ inverse() {
      const scale = Math.min(width / 640, height / 820);
      return { a: 1 / scale, d: 1 / scale, e: -(width - 640 * scale) / (2 * scale), f: -(height - 820 * scale) / (2 * scale) };
    } }),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: width, bottom: height, width, height }),
    classList: { toggle() {} }, closest: () => null,
    setPointerCapture: id => captures.add(id),
    hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id),
  };
  const controls = attachGestures(svg, { setAttribute: (name, value) => transforms.push(value) }, {
    getFrame: frame, getHomeFrame: frame,
    onSelect: value => selections.push(value), onChange: view => changes.push(view),
    requestPaint: deferred ? callback => { queued.set(++nextId, callback); return nextId; } : null,
    cancelPaint: id => queued.delete(id),
    cameraMotion: {
      now: () => time, reducedMotion: () => false,
      requestFrame: animated ? callback => { motionFrames.set(++nextId, callback); return nextId; } : null,
      cancelFrame: id => motionFrames.delete(id),
    },
  });
  controls.reset();
  transforms.length = changes.length = 0;
  return {
    controls, queued, motionFrames, changes, transforms, selections,
    send(type, extra = {}) {
      listeners.get(type)({ type, pointerId: 1, pointerType: 'touch', button: 0,
        clientX: width / 2, clientY: height / 2, target: svg, preventDefault() {}, ...extra });
    },
    tick(ms = 16, motionFirst = true) {
      time += ms;
      const paints = [...queued.values()], motions = [...motionFrames.values()];
      queued.clear(); motionFrames.clear();
      // Exercise either ordering, including callbacks already copied by a browser
      // before another callback cancels them during the same animation frame.
      for (const callback of motionFirst ? [...motions, ...paints] : [...paints, ...motions]) callback(time);
    },
    resize(w, h) { width = w; height = h; controls.resize(); },
    toggle() { mandala = !mandala; controls.transitionHome(); },
  };
}

const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≈ ${expected}`);

test('burst camera inputs retain every zoom step but paint once per animation frame', () => {
  const deferred = harness(), immediate = harness({ deferred: false });
  for (const deltaY of [-40, -25, 12, -15]) {
    deferred.send('wheel', { deltaY }); immediate.send('wheel', { deltaY });
    assert.deepEqual(deferred.controls.getView(), immediate.controls.getView());
    assert.deepEqual(immediate.changes.at(-1), immediate.controls.getView(), 'no scheduler keeps every paint synchronous');
  }
  assert.equal(deferred.transforms.length, 0);
  assert.equal(deferred.queued.size, 1);
  deferred.tick();
  assert.equal(deferred.transforms.length, 1);
  assert.equal(deferred.transforms.at(-1), immediate.transforms.at(-1));
  assert.deepEqual(deferred.changes.at(-1), immediate.changes.at(-1));
});

test('pinch and pan settle before release without inventing a tap or losing the final pose', () => {
  const deferred = harness(), immediate = harness({ deferred: false });
  for (const h of [deferred, immediate]) {
    h.send('pointerdown', { pointerId: 1, clientX: 270 });
    h.send('pointerdown', { pointerId: 2, clientX: 370 });
    h.send('pointermove', { pointerId: 1, clientX: 240 });
    h.send('pointermove', { pointerId: 2, clientX: 400 });
    h.send('pointerup', { pointerId: 2, clientX: 400 });
    h.send('pointermove', { pointerId: 1, clientX: 220, clientY: 430 });
    h.send('pointerup', { pointerId: 1, clientX: 220, clientY: 430 });
  }
  assert.equal(deferred.queued.size, 0);
  assert.equal(deferred.selections.length, 0);
  assert.deepEqual(deferred.controls.getView(), immediate.controls.getView());
  assert.equal(deferred.transforms.at(-1), immediate.transforms.at(-1));
});

test('Home cancels a pending gesture paint and an obsolete callback cannot steal a newer paint', () => {
  const h = harness();
  h.send('wheel', { deltaY: -50 });
  const stale = [...h.queued.values()][0];
  h.controls.reset();
  assert.equal(h.queued.size, 0);
  assert.deepEqual(h.changes.at(-1), h.controls.getFittedView());
  h.send('wheel', { deltaY: -20 });
  const count = h.transforms.length;
  stale();
  assert.equal(h.transforms.length, count);
  assert.equal(h.queued.size, 1);
  h.tick();
  assert.equal(h.transforms.length, count + 1);
  assert.deepEqual(h.changes.at(-1), h.controls.getView());
});

test('cancel and lost pointer capture flush the final camera state', () => {
  for (const release of ['pointercancel', 'lostpointercapture']) {
    const h = harness();
    h.controls.zoom(2);
    h.send('pointerdown');
    h.send('pointermove', { clientX: 350 });
    const view = h.controls.getView();
    h.send(release, { clientX: 350 });
    assert.equal(h.queued.size, 0);
    assert.deepEqual(h.changes.at(-1), view);
    assert.equal(h.selections.length, 0);
  }
});

test('resize publishes the rebased live camera immediately and cancels the pre-resize paint', () => {
  const deferred = harness(), immediate = harness({ deferred: false });
  for (const h of [deferred, immediate]) h.send('wheel', { deltaY: -80 });
  const stale = [...deferred.queued.values()][0];
  const relativeZoom = deferred.controls.getView().k / deferred.controls.getFittedView().k;
  for (const h of [deferred, immediate]) h.resize(390, 844);
  assert.equal(deferred.queued.size, 0);
  assert.deepEqual(deferred.controls.getView(), immediate.controls.getView());
  assert.deepEqual(deferred.changes.at(-1), deferred.controls.getView());
  closeTo(deferred.controls.getView().k / deferred.controls.getFittedView().k, relativeZoom);
  const count = deferred.transforms.length;
  stale();
  assert.equal(deferred.transforms.length, count, 'the old viewport cannot reappear after resize');
});

test('gesture paints and animated Home reversal share the live camera in either frame order', () => {
  for (const motionFirst of [true, false]) {
    const deferred = harness({ animated: true }), immediate = harness({ animated: true, deferred: false });
    for (const h of [deferred, immediate]) {
      h.toggle(); h.tick(40, motionFirst);
      h.send('wheel', { deltaY: -80 });
    }
    assert.equal(deferred.queued.size, 1);
    assert.equal(deferred.motionFrames.size, 1, 'the gesture does not stop the Home transition');
    for (const h of [deferred, immediate]) h.tick(40, motionFirst);
    assert.deepEqual(deferred.controls.getView(), immediate.controls.getView());
    assert.deepEqual(deferred.changes.at(-1), deferred.controls.getView());

    for (const h of [deferred, immediate]) h.send('wheel', { deltaY: -20 });
    const stalePaint = [...deferred.queued.values()][0];
    const staleMotion = [...deferred.motionFrames.values()][0];
    const beforeReversal = deferred.controls.getView();
    for (const h of [deferred, immediate]) h.toggle();
    assert.deepEqual(deferred.controls.getView(), beforeReversal, 'reversal starts at the latest input, without jumping');
    assert.deepEqual(deferred.changes.at(-1), beforeReversal, 'reversal flushes pending input immediately');
    assert.equal(deferred.queued.size, 0);

    for (const h of [deferred, immediate]) h.send('wheel', { deltaY: -10 });
    const count = deferred.transforms.length;
    stalePaint(); staleMotion();
    assert.equal(deferred.transforms.length, count, 'neither obsolete queue can repaint');
    assert.equal(deferred.queued.size, 1, 'the newer gesture paint stays queued');
    assert.equal(deferred.motionFrames.size, 1, 'the reversed transition stays queued');
    for (const h of [deferred, immediate]) h.tick(200, motionFirst);
    assert.deepEqual(deferred.controls.getView(), immediate.controls.getView());
    assert.deepEqual(deferred.changes.at(-1), deferred.controls.getView());
    assert.equal(deferred.queued.size, 0);
    assert.equal(deferred.motionFrames.size, 0);
  }
});

test('a tap keeps its pressed object when pointerup flushes a pending camera paint', () => {
  const h = harness();
  const target = { dataset: { type: 'gate', id: '41' }, closest() { return this; } };
  h.send('wheel', { deltaY: -20 });
  h.send('pointerdown', { target });
  target.dataset.id = '58';
  h.send('pointerup', { target });
  assert.equal(h.queued.size, 0);
  assert.deepEqual(h.changes.at(-1), h.controls.getView());
  assert.deepEqual(h.selections, [{ type: 'gate', id: '41' }]);
});
