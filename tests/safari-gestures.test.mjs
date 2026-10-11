import test from 'node:test';
import assert from 'node:assert/strict';
import { attachGestures } from '../src/scene/gestures.js';
import { createCameraView } from '../src/scene/camera-view.js';

function harness() {
  const listeners = new Map(), captures = new Set(), queued = new Map(), changes = [];
  let nextPaint = 0, backgroundTaps = 0;
  const surface = {
    addEventListener: (type, callback) => listeners.set(type, callback),
    getBoundingClientRect: () => ({ left: 100, top: 40, right: 420, bottom: 450, width: 320, height: 410 }),
    setPointerCapture: id => captures.add(id),
    hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id),
    closest: () => null,
  };
  const frame = { bounds: { x: 0, y: 0, width: 640, height: 820 }, minScale: .1 };
  const svg = {
    viewBox: { baseVal: frame.bounds }, preserveAspectRatio: { baseVal: { align: 6, meetOrSlice: 1 } },
    style: {}, classList: { toggle() {} }, closest: () => null, addEventListener() {},
  };
  const camera = attachGestures(svg, {
    cameraView: createCameraView({ svg, surface }), getFrame: () => frame, getHomeFrame: () => frame,
    fitInsets: { side: 0, top: 0, bottom: 0 }, onSelect() {}, onChange: view => changes.push(view),
    onBackgroundTap: () => backgroundTaps++,
    requestPaint: callback => { queued.set(++nextPaint, callback); return nextPaint; },
    cancelPaint: id => queued.delete(id),
  });
  camera.reset(); changes.length = 0;
  return {
    camera, changes, queued, get backgroundTaps() { return backgroundTaps; },
    send(type, extra = {}) {
      const event = { type, pointerId: 1, pointerType: 'touch', button: 0, target: surface,
        clientX: 180, clientY: 160, cancelable: true, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, ...extra };
      listeners.get(type)?.(event);
      return event;
    },
  };
}

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

test('Safari cumulative scales zoom the real camera once about the projected pointer and flush on end', () => {
  const h = harness();
  const start = h.send('gesturestart', { scale: 1 });
  h.send('gesturechange', { scale: 1.5 });
  assert.deepEqual(h.camera.getView(), { x: -80, y: -120, k: 1.5 });
  assert.equal(start.defaultPrevented, true);
  h.send('gesturechange', { scale: 2 });
  assert.deepEqual(h.camera.getView(), { x: -160, y: -240, k: 2 });
  assert.equal(h.changes.length, 0, 'camera changes immediately; its paint waits for the frame');
  assert.equal(h.queued.size, 1);
  h.send('gestureend', { scale: 2 });
  assert.equal(h.queued.size, 0);
  assert.deepEqual(h.changes, [{ x: -160, y: -240, k: 2 }]);
  h.send('gesturechange', { scale: 3 });
  assert.equal(h.camera.getView().k, 2, 'late updates cannot extend an ended gesture');
  h.send('gesturestart', { scale: 2 });
  h.send('gesturechange', { scale: 3 });
  close(h.camera.getView().k, 3);
});

test('Safari missing or invalid coordinates use the fixed surface center and invalid scales cannot poison the camera', () => {
  const h = harness();
  h.send('gesturestart', { scale: 1 });
  for (const scale of [0, -1, NaN, Infinity, undefined]) h.send('gesturechange', { scale });
  assert.deepEqual(h.camera.getView(), { x: 0, y: 0, k: 1 });
  h.send('gesturechange', { scale: 2, clientX: undefined, clientY: undefined });
  assert.deepEqual(h.camera.getView(), { x: -320, y: -410, k: 2 });
  h.send('gesturechange', { scale: 2.5, clientX: NaN, clientY: 160 });
  assert.deepEqual(h.camera.getView(), { x: -480, y: -615, k: 2.5 });
});

test('PointerEvent pinch owns the whole Safari lifecycle including the last finger release', () => {
  const h = harness();
  h.send('pointerdown');
  h.send('pointerdown', { pointerId: 2, clientX: 280 });
  h.send('gesturestart', { scale: 1 });
  h.send('pointermove', { pointerId: 2, clientX: 330 });
  const afterPointer = h.camera.getView();
  close(afterPointer.k, 1.5);
  h.send('gesturechange', { scale: 1.5 });
  assert.deepEqual(h.camera.getView(), afterPointer, 'Safari must not replay the touch pinch');
  h.send('pointerup', { pointerId: 2, clientX: 330 });
  h.send('gesturechange', { scale: 1.6 });
  h.send('pointerup');
  h.send('gestureend', { scale: 1.6 });
  assert.deepEqual(h.camera.getView(), afterPointer);
  assert.equal(h.backgroundTaps, 0);
});

test('a second pointer arriving after gesturestart prevents later Safari replay', () => {
  const h = harness();
  h.send('pointerdown');
  h.send('gesturestart', { scale: 1 });
  h.send('pointerdown', { pointerId: 2, clientX: 280 });
  h.send('pointermove', { pointerId: 2, clientX: 330 });
  const afterPointer = h.camera.getView();
  h.send('pointerup', { pointerId: 2, clientX: 330 });
  h.send('gesturechange', { scale: 1.5 });
  assert.deepEqual(h.camera.getView(), afterPointer);
});

test('co-emitted Ctrl-wheel cannot double Safari zoom and standalone Ctrl-wheel resumes after end', () => {
  const h = harness();
  h.send('gesturestart', { scale: 1 });
  h.send('wheel', { ctrlKey: true, deltaY: -100 });
  assert.equal(h.camera.getView().k, 1, 'gesture lifecycle already owns this zoom');
  h.send('gesturechange', { scale: 1.5 });
  h.send('wheel', { ctrlKey: true, deltaY: -100 });
  assert.equal(h.camera.getView().k, 1.5);
  h.send('gestureend', { scale: 1.5 });
  h.send('wheel', { ctrlKey: true, deltaY: -100 });
  close(h.camera.getView().k, 2.0247882113640046);
});

test('ordinary wheel retains camera behavior even during a Safari lifecycle', () => {
  const h = harness();
  h.send('gesturestart', { scale: 1 });
  h.send('wheel', { ctrlKey: false, deltaY: -100 });
  close(h.camera.getView().k, 1.3498588075760032);
});
