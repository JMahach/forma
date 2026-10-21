import test from 'node:test';
import assert from 'node:assert/strict';
import { attachGestures } from '../src/scene/gestures.js';
import { createCamera } from '../src/scene/camera.js';

function harness({ drawing = null, ...options } = {}) {
  const listeners = new Map(), captures = new Set(), queued = new Map(), paints = [], changes = [], selections = [];
  let nextPaint = 0;
  const surface = {
    closest: () => null,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id),
    classList: { toggle() {} },
  };
  const measureFit = () => ({ area: { x: 0, y: 0, width: 640, height: 820 }, min: .1 });
  const camera = createCamera({ measureFit, onChange() {} });
  camera.reset(); camera.zoom(1.5);
  const controls = attachGestures(drawing || surface, {
    camera, cameraView: { surface, point: event => ({ x: event.clientX, y: event.clientY }), measureFit, paint: view => paints.push(view) },
    onChange: view => changes.push(view), onSelect: selection => selections.push(selection),
    requestPaint: callback => { queued.set(++nextPaint, callback); return nextPaint; }, cancelPaint: id => queued.delete(id),
    ...options,
  });
  return {
    camera, controls, surface, listeners, captures, queued, paints, changes, selections,
    send(type, extra = {}) {
      for (const handler of listeners.get(type) || []) handler({ type, pointerId: 1, pointerType: 'touch', button: 0,
        target: surface, clientX: 320, clientY: 410, preventDefault() {}, ...extra });
    },
    tick() { const pending = [...queued.values()]; queued.clear(); for (const callback of pending) callback(); },
  };
}

const gate = id => ({ dataset: { type: 'gate', id }, closest() { return this; } });

test('gesture handoff retains the live camera and applies each wheel event once', () => {
  const h = harness(), nextChanges = [], before = h.camera.getView(), home = h.camera.getFittedView();
  const maximum = h.camera.maximumScale(), previousChanges = h.changes.length;
  h.controls.setHandlers({ onChange: view => nextChanges.push(view) });
  assert.deepEqual(h.controls.getView(), before);
  assert.deepEqual(h.controls.getFittedView(), home);
  assert.equal(h.controls.maximumScale(), maximum);
  assert.deepEqual(nextChanges, [before], 'the incoming view receives the unchanged pose');
  assert.equal('setHandlers' in h.camera, false, 'the camera retains only camera responsibilities');
  h.send('wheel', { deltaY: -20 }); h.tick();
  assert.ok(Math.abs(h.camera.getView().k - before.k * Math.exp(.06)) < 1e-9);
  assert.equal(nextChanges.length, 2);
  assert.equal(h.changes.length, previousChanges);
  assert.equal(h.listeners.get('wheel').length, 1);
  h.controls.reset();
  assert.deepEqual(h.camera.getView(), home, 'the facade still controls the original camera');
});

test('handoff cancels a press from the outgoing screen and uses the new selection handlers', () => {
  const h = harness(), oldGate = gate('41'), newGate = gate('29'), selected = [];
  let background = 0;
  h.send('pointerdown', { target: oldGate });
  assert.equal(h.captures.size, 1);
  h.controls.setHandlers({
    onSelect: value => selected.push(value), onBackgroundTap: () => background++,
    resolvePointerTarget: event => event.newTarget || null,
    resolveSelection: target => ({ type: 'new-gate', id: target.dataset.id }),
  });
  assert.equal(h.captures.size, 0);
  h.send('pointerup', { target: oldGate });
  assert.deepEqual(h.selections, []); assert.deepEqual(selected, []); assert.equal(background, 0);
  h.send('pointerdown', { target: oldGate, newTarget: newGate });
  h.send('pointerup');
  assert.deepEqual(selected, [{ type: 'new-gate', id: '29', pointerType: 'touch' }]);
  h.send('pointerdown', { target: oldGate }); h.send('pointerup');
  assert.equal(background, 1);
  h.controls.setHandlers({ resolveSelection: () => ({ type: 'keyboard-gate', id: '63' }) });
  h.send('keydown', { target: newGate, key: 'Enter' });
  assert.deepEqual(selected.at(-1), { type: 'keyboard-gate', id: '63' });
});

test('handoff flushes the final outgoing gesture and discards stale paints and Safari updates', () => {
  const h = harness(), incoming = [];
  h.send('gesturestart', { scale: 1 }); h.send('gesturechange', { scale: 1.2 });
  const before = h.camera.getView(), stalePaint = [...h.queued.values()][0];
  h.controls.setHandlers({ onChange: view => incoming.push(view) });
  assert.equal(h.queued.size, 0);
  assert.deepEqual(h.changes.at(-1), before, 'the outgoing owner can persist its last gesture');
  assert.deepEqual(incoming, [before]);
  h.send('gesturechange', { scale: 2 });
  assert.deepEqual(h.camera.getView(), before, 'an old Safari lifecycle cannot change the new screen');
  h.send('wheel', { deltaY: -20 });
  const paints = h.paints.length;
  stalePaint();
  assert.equal(h.paints.length, paints);
  assert.equal(h.queued.size, 1);
  h.tick();
  assert.deepEqual(incoming.at(-1), h.camera.getView());
});

test('loading can attach camera gestures before selection and change handlers exist', () => {
  const h = harness({ onSelect: undefined, onChange: undefined });
  h.send('wheel', { deltaY: -20 }); h.tick();
  h.send('pointerdown', { target: gate('41') }); h.send('pointerup');
  const selected = [];
  h.controls.setHandlers({ onSelect: value => selected.push(value) });
  h.send('pointerdown', { target: gate('29') }); h.send('pointerup');
  assert.equal(selected[0].id, '29');
});


test('loading surface owns keyboard zoom and focus until the actual drawing is interactive', () => {
  const keyboard = new Map(); let drawingFocus = 0, surfaceFocus = 0;
  const drawing = { inert: true, closest: () => null, classList: { toggle() {} },
    addEventListener: (type, handler) => keyboard.set(type, handler), focus: () => drawingFocus++ };
  const h = harness({ drawing }); h.surface.focus = () => surfaceFocus++;
  const before = h.controls.getView();
  h.send('keydown', { key: '+' });
  assert.ok(Math.abs(h.controls.getView().k - before.k * 1.25) < 1e-9);
  h.send('keydown', { key: '-' });
  assert.ok(Math.abs(h.controls.getView().k - before.k) < 1e-9);
  h.send('pointerdown'); h.send('pointerup');
  assert.equal(surfaceFocus, 1); assert.equal(drawingFocus, 0);
  drawing.inert = false;
  h.send('pointerdown'); h.send('pointerup');
  assert.equal(surfaceFocus, 1); assert.equal(drawingFocus, 1);
  const event = { type: 'keydown', target: drawing, key: '+', preventDefault() {} };
  keyboard.get('keydown')(event);
  h.send('keydown', event); // The SVG event bubbles through the stationary surface.
  assert.ok(Math.abs(h.controls.getView().k - before.k * 1.25) < 1e-9, 'bubbling cannot apply zoom twice');
  h.send('keydown', { key: '0' });
  assert.deepEqual(h.controls.getView(), h.controls.getFittedView());
});
