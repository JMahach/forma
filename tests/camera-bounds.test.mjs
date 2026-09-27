import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attachCameraControls, createCameraChangeHandler } from '../src/bodygraph/camera-controls.js';
import { attachGestures, constrainView, DRAWING_BOUNDS, zoomAt } from '../src/bodygraph/gestures.js';

const closeTo = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} ≈ ${expected}`);
const projected = (view, bounds = DRAWING_BOUNDS) => ({
  left: view.x + bounds.x * view.k,
  right: view.x + (bounds.x + bounds.width) * view.k,
  top: view.y + bounds.y * view.k,
  bottom: view.y + (bounds.y + bounds.height) * view.k,
});

function assertCoversHome(view, fitted, bounds = DRAWING_BOUNDS) {
  const current = projected(view, bounds), home = projected(fitted, bounds);
  assert.ok(view.k >= fitted.k - 1e-10, 'zoom stays at or above the fitted 100% view');
  assert.ok(view.k <= 4.5, 'zoom keeps the supported maximum');
  assert.ok(current.left <= home.left + 1e-8, 'the drawing covers the home frame on the left');
  assert.ok(current.right >= home.right - 1e-8, 'the drawing covers the home frame on the right');
  assert.ok(current.top <= home.top + 1e-8, 'the drawing covers the home frame at the top');
  assert.ok(current.bottom >= home.bottom - 1e-8, 'the drawing covers the home frame at the bottom');
}

test('constrainView makes the fitted view an exact minimum and leaves its inputs unchanged', () => {
  for (const fitted of [{ x: 0, y: 0, k: 1 }, { x: 70, y: 90, k: 0.65 }, { x: -180, y: 12, k: 1.7 }]) {
    for (const k of [0.01, fitted.k / 2, fitted.k, fitted.k * (1 + 5e-10)]) {
      const view = { x: 3900, y: -5500, k };
      const before = JSON.stringify({ fitted, view });
      assert.deepEqual(constrainView(view, fitted), fitted, '100% fixes both position and scale to Home');
      assert.equal(JSON.stringify({ fitted, view }), before);
    }
    assert.equal(constrainView({ x: 100, y: -100, k: 20 }, fitted).k, 4.5);
  }
});

test('constrainView clamps all four pan directions to the projected home frame for fixed or supplied bounds', () => {
  for (const bounds of [DRAWING_BOUNDS, { x: -20, y: 15, width: 500, height: 700 }]) {
    for (const fitted of [{ x: 60, y: 25, k: 0.65 }, { x: -80, y: 105, k: 1.2 }]) {
      for (const k of [fitted.k * 1.25, fitted.k * 2, 4.5]) {
        const home = projected(fitted, bounds);
        for (const [x, y] of [[-5000, -6000], [-5000, 6000], [5000, -6000], [5000, 6000]]) {
          const view = constrainView({ x, y, k }, fitted, bounds), current = projected(view, bounds);
          assertCoversHome(view, fitted, bounds);
          closeTo(x < 0 ? current.right : current.left, x < 0 ? home.right : home.left, 'horizontal movement stops at its edge');
          closeTo(y < 0 ? current.bottom : current.top, y < 0 ? home.bottom : home.top, 'vertical movement stops at its edge');
          assert.deepEqual(constrainView(view, fitted, bounds), view, 'the constraint is stable after reaching an edge');
        }
        const center = { x: (home.left + home.right) / 2, y: (home.top + home.bottom) / 2 };
        const centered = zoomAt(fitted, center, k / fitted.k, { min: fitted.k, max: 4.5 });
        assert.deepEqual(constrainView(centered, fitted, bounds), centered, 'a valid pan position does not jump');
      }
    }
  }
});

test('zoomAt accepts a fitted minimum while preserving its anchor and old default limits', () => {
  const view = { x: -140, y: 90, k: 1.5 }, anchor = { x: 220, y: 410 };
  const point = { x: (anchor.x - view.x) / view.k, y: (anchor.y - view.y) / view.k };
  for (const [factor, k] of [[0.001, 1.1], [1, 1.5], [100, 3]]) {
    const next = zoomAt(view, anchor, factor, { min: 1.1, max: 3 });
    assert.equal(next.k, k);
    closeTo(next.x + point.x * next.k, anchor.x, 'horizontal anchor is retained');
    closeTo(next.y + point.y * next.k, anchor.y, 'vertical anchor is retained');
  }
  assert.equal(zoomAt(view, anchor, 0.001).k, 0.65, 'the optional argument preserves callers that use default limits');
  assert.equal(zoomAt(view, anchor, 100).k, 4.5);
});

function cameraHarness(t, initialRect = { left: 0, top: 0, width: 640, height: 820 }) {
  const originalPoint = Object.getOwnPropertyDescriptor(globalThis, 'DOMPoint');
  globalThis.DOMPoint = class {
    constructor(x, y) { this.x = x; this.y = y; }
    matrixTransform() { return this; }
  };
  t.after(() => { if (originalPoint) Object.defineProperty(globalThis, 'DOMPoint', originalPoint); else delete globalThis.DOMPoint; });
  const listeners = new Map(), captures = new Set(), classes = new Set(), changes = [], selections = [], transforms = [];
  let rect = initialRect, backgroundTaps = 0;
  const svg = {
    addEventListener(type, callback, options) { listeners.set(type, { callback, options }); },
    getScreenCTM: () => ({ inverse: () => ({}) }),
    getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }),
    setPointerCapture: id => captures.add(id),
    hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id),
    closest: () => null,
    classList: {
      add(...values) { values.forEach(value => classes.add(value)); },
      remove(...values) { values.forEach(value => classes.delete(value)); },
      contains(value) { return classes.has(value); },
      toggle(value, force) { const enabled = force ?? !classes.has(value); if (enabled) classes.add(value); else classes.delete(value); return enabled; },
    },
  };
  const controls = attachGestures(svg, { setAttribute(name, value) { assert.equal(name, 'transform'); transforms.push(value); } }, {
    onSelect: value => selections.push(value),
    onChange: (view, fitted) => changes.push({ view, fitted }),
    onBackgroundTap() { backgroundTaps++; },
  });
  const send = (type, extra = {}) => {
    const event = { type, pointerId: 1, pointerType: 'touch', button: 0, clientX: 320, clientY: 410, target: svg, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    listeners.get(type).callback(event);
    return event;
  };
  const drag = (dx, dy, extra = {}) => {
    send('pointerdown', extra);
    send('pointermove', { clientX: 320 + dx, clientY: 410 + dy, ...extra });
    send('pointerup', { clientX: 320 + dx, clientY: 410 + dy, ...extra });
  };
  controls.reset();
  return { controls, svg, listeners, classes, captures, changes, selections, transforms, send, drag,
    get fitted() { return changes.at(-1).fitted; },
    get backgroundTaps() { return backgroundTaps; },
    resize(nextRect) { rect = nextRect; controls.resize(); },
  };
}

test('100% is stationary for wheel, control buttons, keyboard minus, and dragging', t => {
  const harness = cameraHarness(t), home = harness.controls.getView();
  assert.deepEqual(home, harness.fitted);
  for (let i = 0; i < 8; i++) {
    assert.equal(harness.send('wheel', { deltaY: 200, clientX: 60, clientY: 80 }).defaultPrevented, true);
    harness.controls.zoom(0.8);
    assert.equal(harness.send('keydown', { key: '-' }).defaultPrevented, true);
    harness.drag(i % 2 ? -300 : 300, i % 2 ? 250 : -250);
    assert.deepEqual(harness.controls.getView(), home, 'no input route can move or shrink the home view');
  }
  assert.deepEqual(harness.selections, []);
  assert.equal(harness.backgroundTaps, 0, 'attempted drags at the minimum do not turn into background taps');
  assert.equal(harness.captures.size, 0);
});

test('wheel and keyboard zoom in, pan limits cover Home, and every zoom-out path returns exactly Home', t => {
  const harness = cameraHarness(t), home = harness.controls.getView();
  const routes = [
    { zoomIn: () => harness.send('wheel', { deltaY: -200 }), zoomOut: () => harness.send('wheel', { deltaY: 200 }) },
    { zoomIn: () => harness.send('keydown', { key: '+' }), zoomOut: () => harness.send('keydown', { key: '-' }) },
    { zoomIn: () => harness.controls.zoom(1.25), zoomOut: () => harness.controls.zoom(0.8) },
  ];
  for (const { zoomIn, zoomOut } of routes) {
    zoomIn();
    assert.ok(harness.controls.getView().k > home.k);
    for (const [dx, dy] of [[10000, 0], [-10000, 0], [0, 10000], [0, -10000]]) {
      harness.drag(dx, dy);
      assertCoversHome(harness.controls.getView(), home);
    }
    for (let i = 0; i < 20; i++) zoomOut();
    assert.deepEqual(harness.controls.getView(), home);
  }
  for (const { view, fitted } of harness.changes) assertCoversHome(view, fitted);
  assert.equal(harness.backgroundTaps, 0);
});

test('dragging above 100% moves within its available range and stops at each exact limit', t => {
  const harness = cameraHarness(t), home = harness.fitted;
  harness.controls.zoom(2);
  const before = harness.controls.getView();
  harness.drag(40, -30);
  closeTo(harness.controls.getView().x, before.x + 40, 'horizontal movement is available while zoomed');
  closeTo(harness.controls.getView().y, before.y - 30, 'vertical movement is available while zoomed');
  const homeRect = projected(home);
  for (const [dx, dy, edge] of [[10000, 0, 'left'], [-10000, 0, 'right'], [0, 10000, 'top'], [0, -10000, 'bottom']]) {
    harness.drag(dx, dy);
    const view = harness.controls.getView();
    assertCoversHome(view, home);
    closeTo(projected(view)[edge], homeRect[edge], `${edge} boundary is reached exactly`);
    harness.drag(dx, dy);
    assert.deepEqual(harness.controls.getView(), view, 'continuing outward cannot move past the boundary');
  }
  assert.deepEqual(harness.selections, []);
  assert.equal(harness.backgroundTaps, 0);
});

test('pinching respects the fitted floor, allows zoom and pan above it, and never selects or clears a gate', t => {
  const harness = cameraHarness(t), home = harness.controls.getView();
  const target = { closest: () => ({ dataset: { type: 'gate', id: '37' } }) };
  harness.send('pointerdown', { pointerId: 1, clientX: 220, target });
  harness.send('pointerdown', { pointerId: 2, clientX: 420, target });
  harness.send('pointermove', { pointerId: 2, clientX: 250, target });
  assert.deepEqual(harness.controls.getView(), home, 'pinching inward cannot go below 100%');
  harness.send('pointermove', { pointerId: 2, clientX: 620, target });
  assert.ok(harness.controls.getView().k > home.k);
  assertCoversHome(harness.controls.getView(), home);
  harness.send('pointermove', { pointerId: 1, clientX: -800, clientY: 1200, target });
  assertCoversHome(harness.controls.getView(), home);
  harness.send('pointerup', { pointerId: 2, clientX: 620, target });
  harness.send('pointermove', { pointerId: 1, clientX: 1200, clientY: -500, target });
  assertCoversHome(harness.controls.getView(), home);
  harness.send('pointerup', { pointerId: 1, clientX: 1200, clientY: -500, target });
  assert.deepEqual(harness.selections, []);
  assert.equal(harness.backgroundTaps, 0);
  assert.equal(harness.captures.size, 0);
  harness.controls.reset();
  harness.send('pointerdown', { pointerId: 1, clientX: 220 });
  harness.send('pointerdown', { pointerId: 2, clientX: 420 });
  harness.send('pointermove', { pointerId: 2, clientX: 221 });
  harness.send('pointerup', { pointerId: 2, clientX: 221 });
  harness.send('pointerup', { pointerId: 1, clientX: 220 });
  assert.deepEqual(harness.controls.getView(), home);
  assert.equal(harness.backgroundTaps, 0);
});

test('setView and reset enforce the home floor and keep returned camera snapshots independent', t => {
  const harness = cameraHarness(t), home = harness.fitted;
  harness.controls.setView({ x: 5000, y: -6000, k: 0.65 });
  assert.deepEqual(harness.controls.getView(), home, 'a formerly valid smaller saved view is raised to Home');
  for (const value of [{ x: -5000, y: 6000, k: 2 }, { x: 5000, y: -6000, k: 4.5 }]) {
    harness.controls.setView(value);
    assertCoversHome(harness.controls.getView(), home);
  }
  const snapshot = harness.controls.getView();
  snapshot.x = 9000; snapshot.k = 0.1;
  assertCoversHome(harness.controls.getView(), home);
  harness.controls.reset();
  assert.deepEqual(harness.controls.getView(), home);
  harness.controls.zoom(2);
  harness.send('keydown', { key: '0' });
  assert.deepEqual(harness.controls.getView(), home, 'keyboard Home resets scale and position');
  harness.controls.setView({ x: NaN, y: 0, k: 1 });
  assert.deepEqual(harness.controls.getView(), home, 'invalid saved camera state resets safely');
});

test('resizing recomputes the fitted floor, preserves relative zoom when possible, and reclamps all pan edges', t => {
  const harness = cameraHarness(t);
  const originalHome = harness.fitted;
  harness.resize({ left: 25, top: 40, width: 1200, height: 1000 });
  assert.deepEqual(harness.controls.getView(), harness.fitted, 'Home remains Home after resize');
  assert.notEqual(harness.fitted.k, originalHome.k);
  harness.controls.zoom(2);
  harness.drag(-10000, 10000);
  const before = harness.controls.getView(), previousHome = harness.fitted;
  harness.resize({ left: 45, top: 65, width: 900, height: 900 });
  closeTo(harness.controls.getView().k / harness.fitted.k, before.k / previousHome.k, 'resize preserves the relative zoom percentage');
  assertCoversHome(harness.controls.getView(), harness.fitted);
  harness.controls.zoom(100);
  harness.resize({ left: 0, top: 0, width: 1800, height: 1400 });
  assert.equal(harness.controls.getView().k, 4.5, 'resizing a maximally zoomed view respects the absolute ceiling');
  assertCoversHome(harness.controls.getView(), harness.fitted);
  harness.resize({ left: 0, top: 0, width: 390, height: 844 });
  assertCoversHome(harness.controls.getView(), harness.fitted);
  harness.controls.zoom(0.001);
  assert.deepEqual(harness.controls.getView(), harness.fitted, 'the smaller viewport has its own exact 100% floor');
});

test('bounded drags preserve selection semantics and a fresh background tap still clears once', t => {
  const harness = cameraHarness(t);
  const gate = { closest: () => ({ dataset: { type: 'gate', id: '37' } }) };
  harness.send('pointerdown', { target: gate }); harness.send('pointerup', { target: gate });
  assert.deepEqual(harness.selections, [{ type: 'gate', id: '37' }]);
  for (const zoom of [1, 2]) {
    harness.controls.reset(); harness.controls.zoom(zoom);
    harness.drag(9000, -9000, { target: gate });
    harness.send('pointerdown'); harness.send('pointercancel'); harness.send('pointerup');
    harness.send('pointerdown'); harness.send('lostpointercapture'); harness.send('pointerup');
    assert.equal(harness.selections.length, 1, 'dragging or cancellation never selects again');
    assert.equal(harness.backgroundTaps, 0, 'dragging or cancellation never clears selection');
  }
  harness.send('pointerdown'); harness.send('pointerup');
  assert.equal(harness.backgroundTaps, 1);
});

test('the real zoom button bindings use the same bounded controls', t => {
  const harness = cameraHarness(t), home = harness.fitted;
  const handlers = new Map();
  const element = id => ({ addEventListener(type, callback) { assert.equal(type, 'click'); handlers.set(id, callback); } });
  attachCameraControls({ zoomIn: element('zoomIn'), zoomOut: element('zoomOut'), fitButton: element('fitButton') }, harness.controls);
  handlers.get('zoomOut')();
  assert.deepEqual(harness.controls.getView(), home);
  handlers.get('zoomIn')();
  assert.ok(harness.controls.getView().k > home.k);
  harness.drag(10000, 10000);
  assertCoversHome(harness.controls.getView(), home);
  for (let i = 0; i < 20; i++) handlers.get('zoomOut')();
  assert.deepEqual(harness.controls.getView(), home);
  handlers.get('zoomIn')();
  handlers.get('fitButton')();
  assert.deepEqual(harness.controls.getView(), home);
});

test('panning and dragging cursors are enabled only above 100% and are cleared on reset or pointer loss', t => {
  const harness = cameraHarness(t);
  const check = (pannable, dragging) => {
    assert.equal(harness.classes.has('is-pannable'), pannable);
    assert.equal(harness.classes.has('is-dragging'), dragging);
  };
  check(false, false);
  harness.send('pointerdown');
  check(false, false);
  harness.send('pointermove', { clientX: 600 });
  check(false, false);
  harness.send('pointerup', { clientX: 600 });
  harness.controls.zoom(2);
  check(true, false);
  harness.send('pointerdown');
  check(true, true);
  harness.send('pointermove', { clientX: 10000 });
  check(true, true);
  harness.send('pointercancel', { clientX: 10000 });
  check(true, false);
  harness.send('pointerdown', { pointerType: 'mouse', button: 2 });
  check(true, false);
  harness.send('pointerdown');
  harness.send('lostpointercapture');
  check(true, false);
  harness.send('pointerdown');
  harness.controls.reset();
  check(false, false);
  harness.send('pointerup');
  check(false, false);
  const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /#bodygraph\s*\{[^}]*cursor:\s*default\s*;/);
  assert.match(styles, /#bodygraph\.is-pannable\s*\{[^}]*cursor:\s*grab\s*;/);
  assert.match(styles, /#bodygraph\.is-pannable\.is-dragging\s*\{[^}]*cursor:\s*grabbing\s*;/);
});

test('the real camera display disables zoom-out at Home and never labels a pannable view as 100%', () => {
  const elements = new Map([['zoomValue', { textContent: '' }], ['zoomOut', { disabled: false }]]);
  let repositioned = 0;
  const cameraChanged = createCameraChangeHandler({
    zoomValue: elements.get('zoomValue'), zoomOut: elements.get('zoomOut'),
    getHoverPreview: () => ({ clear() {} }),
    activationPopover: { reposition() { repositioned++; } },
  });
  let updates = 0;
  for (const k of [0.65, 0.9, 1.5]) {
    const fitted = { x: 30, y: 70, k };
    for (const [ratio, label, disabled] of [[1, '100%', true], [1 + 5e-10, '100%', true], [1.0001, '101%', false], [1.25, '125%', false], [2, '200%', false]]) {
      cameraChanged({ ...fitted, k: k * ratio }, fitted);
      assert.equal(elements.get('zoomValue').textContent, label);
      assert.equal(elements.get('zoomOut').disabled, disabled);
      updates++;
    }
    cameraChanged(fitted, fitted);
    assert.equal(elements.get('zoomValue').textContent, '100%');
    assert.equal(elements.get('zoomOut').disabled, true, 'reset restores the disabled state after zooming');
    updates++;
  }
  assert.equal(repositioned, updates, 'camera changes still reposition an open activation popup');
});

test('Home availability and zoom-out limit remain independent after retaining a wider camera', () => {
  const heading = { hidden: false }, fitButton = { hidden: true }, zoomValue = { textContent: '' }, zoomOut = { disabled: false };
  const changed = createCameraChangeHandler({ heading, fitButton, zoomValue, zoomOut, activationPopover: { reposition() {} } });
  const fitted = { x: 10, y: 20, k: 1 };
  changed({ x: 170, y: 220, k: .5 }, fitted, { minScale: .5 });
  assert.equal(fitButton.hidden, false, 'Home remains available below its desired fit');
  assert.equal(heading.hidden, true);
  assert.equal(zoomOut.disabled, true, 'the retained navigation floor cannot shrink further');
  assert.equal(zoomValue.textContent, '50%');
  changed({ x: 150, y: 180, k: .6 }, fitted, { minScale: .5 });
  assert.equal(fitButton.hidden, false);
  assert.equal(zoomOut.disabled, false, 'zoom-out is available even while below desired Home');
  changed(fitted, fitted, { minScale: .5 });
  assert.equal(fitButton.hidden, true, 'the desired Home can coexist with a wider navigation range');
  assert.equal(zoomOut.disabled, false);
  changed({ ...fitted, x: fitted.x + 10 }, fitted, { minScale: .5 });
  assert.equal(fitButton.hidden, false, 'a displaced camera at the same scale still offers Home');
  assert.equal(zoomValue.textContent, '100%', 'the scale label remains a scale rather than a position indicator');
});
