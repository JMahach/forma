import test from 'node:test';
import assert from 'node:assert/strict';
import { attachGestures } from './fixtures/gesture-harness.js';

function harness(t) {
  const originalPoint = Object.getOwnPropertyDescriptor(globalThis, 'DOMPoint');
  globalThis.DOMPoint = class {
    constructor(x, y) { this.x = x; this.y = y; }
    matrixTransform() { return this; }
  };
  t.after(() => {
    if (originalPoint) Object.defineProperty(globalThis, 'DOMPoint', originalPoint);
    else delete globalThis.DOMPoint;
  });
  const listeners = new Map(), captures = new Set(), selections = [], changes = [];
  let backgroundTaps = 0;
  const svg = {
    addEventListener: (type, callback) => listeners.set(type, callback),
    getScreenCTM: () => ({ inverse: () => ({}) }),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 640, bottom: 820, width: 640, height: 820 }),
    setPointerCapture: id => captures.add(id),
    hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id),
    closest: () => null,
    classList: { toggle() {} },
  };
  const controls = attachGestures(svg, { setAttribute() {} }, {
    onSelect: value => selections.push(value),
    onChange: value => changes.push(value),
    onBackgroundTap: () => backgroundTaps++,
  });
  const send = (type, extra = {}) => {
    const event = { type, pointerId: 1, pointerType: 'mouse', button: 0, clientX: 320, clientY: 410,
      shiftKey: false, target: svg, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    listeners.get(type)(event);
    return event;
  };
  const target = dataset => ({ closest: () => ({ dataset }) });
  controls.reset();
  return { send, target, controls, selections, changes, captures, get backgroundTaps() { return backgroundTaps; } };
}

const datasets = [
  { type: 'gate', id: '37' },
  { type: 'center', id: 'solar' },
  { type: 'channel', id: '37-40' },
  { type: 'integration', id: 'integration' },
  { type: 'gate', id: '37', activation: 'personality-mercury' },
  { type: 'gate', id: '37', activation: 'design-mars' },
  { type: 'planet', id: 'personality-mercury', activation: 'personality-mercury-planet' },
];

test('Shift pointer taps add only additive:true and preserve every target and activation identity', t => {
  const h = harness(t), initialView = h.controls.getView();
  for (const dataset of datasets) for (const shiftKey of [false, true]) {
    const target = h.target(dataset);
    const down = h.send('pointerdown', { target, shiftKey });
    const up = h.send('pointerup', { target, shiftKey });
    assert.deepEqual(h.selections.at(-1), { ...dataset, ...(shiftKey ? { additive: true } : {}) });
    assert.equal(down.defaultPrevented, false, 'pointer selection retains native focus behavior');
    assert.equal(up.defaultPrevented, false);
    assert.equal(h.captures.size, 0);
  }
  assert.equal(h.selections.length, datasets.length * 2);
  assert.equal(h.backgroundTaps, 0);
  assert.deepEqual(h.controls.getView(), initialView, 'selection modifiers cannot change the camera');
});

test('pointer selection snapshots Shift and the target at the initial press rather than release', t => {
  const h = harness(t);
  const first = h.target({ type: 'gate', id: '20' }), second = h.target({ type: 'gate', id: '10' });
  h.send('pointerdown', { target: first, shiftKey: true });
  h.send('pointerup', { target: second, shiftKey: false });
  assert.deepEqual(h.selections.at(-1), { type: 'gate', id: '20', additive: true }, 'releasing Shift before the pointer does not change this tap');
  h.send('pointerdown', { target: first, shiftKey: false });
  h.send('pointerup', { target: second, shiftKey: true });
  assert.deepEqual(h.selections.at(-1), { type: 'gate', id: '20' }, 'pressing Shift after pointerdown applies only to the next gesture');
  h.send('pointerdown', { target: second });
  h.send('pointerup', { target: second });
  assert.deepEqual(h.selections.at(-1), { type: 'gate', id: '10' }, 'no modifier state leaks into an ordinary tap');
});

test('Shift+Enter and Shift+Space emit additive selection while ordinary keyboard payloads remain unchanged', t => {
  const h = harness(t), initialView = h.controls.getView();
  for (const dataset of datasets) for (const key of ['Enter', ' ']) for (const shiftKey of [false, true]) {
    const event = h.send('keydown', { key, shiftKey, target: h.target(dataset) });
    assert.equal(event.defaultPrevented, true, 'handled activation keys do not scroll the page');
    assert.deepEqual(h.selections.at(-1), { ...dataset, ...(shiftKey ? { additive: true } : {}) });
  }
  const count = h.selections.length;
  for (const key of ['Shift', 'Escape', 'Tab']) {
    assert.equal(h.send('keydown', { key, shiftKey: true, target: h.target(datasets[0]) }).defaultPrevented, false);
  }
  assert.equal(h.selections.length, count);
  assert.deepEqual(h.controls.getView(), initialView);
});

test('Shift drags, pinches, cancellations and background taps retain existing gesture behavior', t => {
  const h = harness(t), target = h.target(datasets[0]);
  h.controls.zoom(2);
  const beforeDrag = h.controls.getView();
  h.send('pointerdown', { target, shiftKey: true });
  h.send('pointermove', { target, shiftKey: true, clientX: 350 });
  h.send('pointerup', { target, shiftKey: true, clientX: 350 });
  assert.equal(h.controls.getView().x, beforeDrag.x + 30, 'Shift drag still pans a zoomed camera');
  assert.equal(h.selections.length, 0);
  h.send('pointerdown', { target, shiftKey: true, clientX: 220 });
  h.send('pointerdown', { target, shiftKey: true, pointerId: 2, clientX: 420 });
  const beforePinch = h.controls.getView().k;
  h.send('pointermove', { target, shiftKey: true, pointerId: 2, clientX: 460 });
  h.send('pointerup', { target, shiftKey: true, pointerId: 2, clientX: 460 });
  h.send('pointerup', { target, shiftKey: true, clientX: 220 });
  assert.ok(h.controls.getView().k > beforePinch, 'Shift does not intercept the pinch');
  assert.equal(h.selections.length, 0);
  for (const end of ['pointercancel', 'lostpointercapture']) {
    h.send('pointerdown', { target, shiftKey: true });
    h.send(end, { target, shiftKey: true });
    h.send('pointerup', { target, shiftKey: true });
  }
  h.send('pointerdown', { target, shiftKey: true, button: 2 });
  h.send('pointerup', { target, shiftKey: true, button: 2 });
  assert.equal(h.selections.length, 0, 'cancelled and secondary-button gestures cannot add a selection');
  for (const shiftKey of [false, true]) {
    h.send('pointerdown', { shiftKey });
    h.send('pointerup', { shiftKey });
  }
  assert.equal(h.backgroundTaps, 2, 'Shift background taps use the same existing callback');
  h.send('pointerdown', { target });
  h.send('pointerup', { target });
  assert.deepEqual(h.selections, [datasets[0]], 'a fresh ordinary tap works after all rejected gestures');
});
