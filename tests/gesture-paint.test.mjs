import test from 'node:test';
import assert from 'node:assert/strict';
import { attachGestures } from './fixtures/gesture-harness.js';
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
  const changes = [], transforms = [], selections = [], cursorChanges = [];
  let nextId = 0, time = 0, width = 640, height = 820, mandala = false;
  const frame = () => mandala ? EXPANDED_TEST_FRAME : COMPACT_TEST_FRAME;
  const svg = {
    addEventListener: (name, handler) => listeners.set(name, handler),
    getScreenCTM: () => ({ inverse() {
      const scale = Math.min(width / 640, height / 820);
      return { a: 1 / scale, d: 1 / scale, e: -(width - 640 * scale) / (2 * scale), f: -(height - 820 * scale) / (2 * scale) };
    } }),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: width, bottom: height, width, height }),
    classList: { toggle: (name, enabled) => cursorChanges.push([name, enabled]) }, closest: () => null,
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
  transforms.length = changes.length = cursorChanges.length = 0;
  return {
    controls, queued, motionFrames, changes, transforms, selections, cursorChanges,
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

test('fine and coarse drag starts retain the same full travel and return to the starting position', () => {
  for (const [width, height] of [[640, 820], [390, 844]]) {
    const scale = Math.min(width / 640, height / 820);
    const fine = harness(), coarse = harness();
    for (const h of [fine, coarse]) {
      h.resize(width, height);
      h.controls.zoom(2);
      h.send('pointerdown');
    }
    const start = fine.controls.getView();
    for (const dx of [2, 4, 6]) {
      fine.send('pointermove', { clientX: width / 2 + dx });
      assert.deepEqual(fine.controls.getView(), start, 'tap tolerance is still 6 screen pixels');
      assert.equal(fine.queued.size, 0);
    }
    for (const dx of [8, 24, 0, -8, 0]) {
      for (const h of [fine, coarse]) {
        h.send('pointermove', { clientX: width / 2 + dx });
        closeTo(h.controls.getView().x, start.x + dx / scale);
        closeTo(h.controls.getView().y, start.y);
        h.tick();
      }
      assert.deepEqual(fine.controls.getView(), coarse.controls.getView());
    }
    for (const h of [fine, coarse]) {
      h.send('pointerup');
      assert.equal(h.queued.size, 0);
      assert.equal(h.selections.length, 0, 'returning to the press does not turn a drag into a tap');
      closeTo(h.changes.at(-1).x, start.x);
    }
  }
});

test('a diagonal drag includes both components of the initial travel on a phone-sized surface', () => {
  const h = harness(), scale = 390 / 640;
  h.resize(390, 844);
  h.controls.zoom(2);
  const start = h.controls.getView();
  h.send('pointerdown');
  h.send('pointermove', { clientX: 198, clientY: 418 }); // 3, -4: within tolerance.
  assert.deepEqual(h.controls.getView(), start);
  h.send('pointermove', { clientX: 201, clientY: 414 }); // 6, -8: drag begins.
  closeTo(h.controls.getView().x, start.x + 6 / scale);
  closeTo(h.controls.getView().y, start.y - 8 / scale);
  h.send('pointerup', { clientX: 201, clientY: 414 });
  assert.deepEqual(h.changes.at(-1), h.controls.getView(), 'release flushes the full initial displacement');
});

test('movement within tap tolerance still selects the pressed object without moving the camera', () => {
  for (const pointerType of ['touch', 'mouse']) {
    const h = harness();
    h.controls.zoom(2);
    const start = h.controls.getView();
    const target = { dataset: { type: 'gate', id: '41' }, closest() { return this; } };
    h.send('pointerdown', { pointerType, target });
    h.send('pointermove', { pointerType, target, clientX: 324 });
    h.send('pointermove', { pointerType, target, clientX: 326 });
    h.send('pointerup', { pointerType, clientX: 326 });
    assert.deepEqual(h.controls.getView(), start);
    assert.deepEqual(h.selections, [{ type: 'gate', id: '41' }]);
    assert.equal(h.queued.size, 0);
  }
});

test('starting a pinch after tiny movements uses current fingers and does not replay travel on return to pan', () => {
  const h = harness(), reference = harness();
  for (const current of [h, reference]) current.controls.zoom(2);
  h.send('pointerdown', { clientX: 320 });
  h.send('pointermove', { clientX: 324 });
  reference.send('pointerdown', { clientX: 324 });
  for (const current of [h, reference]) {
    current.send('pointerdown', { pointerId: 2, clientX: 420 });
    current.send('pointermove', { clientX: 325 });
  }
  assert.deepEqual(h.controls.getView(), reference.controls.getView(), 'pinch starts from the latest finger positions');
  const beforePan = h.controls.getView();
  h.send('pointerup', { pointerId: 2, clientX: 420 });
  for (const x of [326, 327]) {
    h.send('pointermove', { clientX: x });
    closeTo(h.controls.getView().x, beforePan.x + x - 325);
    closeTo(h.controls.getView().y, beforePan.y);
    closeTo(h.controls.getView().k, beforePan.k);
  }
  h.send('pointerup', { clientX: 327 });
  assert.equal(h.selections.length, 0);
});

test('a fresh drag cannot inherit its starting point from a cancelled gesture', () => {
  for (const release of ['pointercancel', 'lostpointercapture']) {
    const h = harness();
    h.controls.zoom(2);
    const start = h.controls.getView();
    h.send('pointerdown', { clientX: 250 });
    h.send('pointermove', { clientX: 254 });
    h.send(release, { clientX: 254 });
    h.send('pointerdown', { clientX: 350 });
    h.send('pointermove', { clientX: 352 });
    h.send('pointermove', { clientX: 358 });
    h.send('pointerup', { clientX: 358 });
    closeTo(h.controls.getView().x, start.x + 8);
    closeTo(h.controls.getView().y, start.y);
    assert.equal(h.selections.length, 0);
  }
});

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

test('fixed canvas owns pointer capture and blank presses preserve keyboard focus on the SVG', async () => {
  const { attachGestures: attachToSurface } = await import('../src/scene/gestures.js');
  const input = new Map(), keyboard = new Map(), captures = new Set(), selections = [];
  let focused = 0, prevented = 0, cleared = 0;
  const svg = {
    addEventListener: (type, callback) => keyboard.set(type, callback),
    classList: { toggle() {} },
    focus(options) { assert.deepEqual(options, { preventScroll: true }); focused++; },
    setPointerCapture() { assert.fail('the moving SVG must not own pointer capture'); },
  };
  const surface = {
    closest: () => null,
    addEventListener: (type, callback) => input.set(type, callback),
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id),
  };
  attachToSurface(svg, {
    cameraView: { surface, point: event => ({ x: event.clientX, y: event.clientY }), paint() {},
      measureFit: () => ({ area: { x: 0, y: 0, width: 640, height: 820 }, min: .1 }) },
    onChange() {}, onSelect: value => selections.push(value), onBackgroundTap: () => cleared++, requestPaint: null,
  });
  assert.deepEqual([...keyboard.keys()], ['keydown']);
  const event = { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 200, clientY: 300,
    target: surface, preventDefault() { prevented++; } };
  input.get('pointerdown')({ ...event, type: 'pointerdown' });
  assert.equal(focused, 1);
  assert.equal(prevented, 1, 'default mouse focus cannot blur the just-focused SVG');
  assert.equal(captures.has(1), true);
  input.get('pointerup')({ ...event, type: 'pointerup' });
  assert.equal(cleared, 1);
  assert.equal(captures.size, 0);
  const gate = { dataset: { type: 'gate', id: '29' }, closest() { return this; } };
  input.get('pointerdown')({ ...event, type: 'pointerdown', target: gate });
  input.get('pointerup')({ ...event, type: 'pointerup', target: surface });
  assert.deepEqual(selections, [{ type: 'gate', id: '29' }], 'capture retargeting retains the originally pressed element');
  assert.equal(focused, 1, 'pressing a real SVG element keeps its native focus behavior');
  assert.equal(prevented, 1);
});


test('a continuous drag only updates the cursor at its start and end', () => {
  const h = harness();
  h.controls.zoom(2);
  assert.deepEqual(h.cursorChanges, [['is-pannable', true]]);
  h.cursorChanges.length = 0;
  h.send('pointerdown', { clientX: 320, clientY: 410 });
  for (let step = 1; step <= 120; step++) {
    h.send('pointermove', { clientX: 320 + step, clientY: 410 });
    h.tick();
  }
  h.send('pointerup', { clientX: 440, clientY: 410 });
  assert.deepEqual(h.cursorChanges, [['is-dragging', true], ['is-dragging', false]]);
  h.controls.reset();
  assert.deepEqual(h.cursorChanges.at(-1), ['is-pannable', false]);
});
