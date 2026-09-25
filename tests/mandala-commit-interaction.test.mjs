import test from 'node:test';
import assert from 'node:assert/strict';
import { attachGestures } from '../src/bodygraph/gestures.js';
import { attachHoverPreview } from '../src/selection/hover-preview.js';
import { mandalaPreviewFromPointer, mandalaPreviewFromFocus, mandalaSelectionFromTarget } from '../src/bodygraph/mandala-preview.js';
import { MANDALA_GEOMETRY } from '../src/bodygraph/mandala.js';

class Point {
  constructor(x, y) { this.x = x; this.y = y; }
  matrixTransform(matrix) {
    return new Point(this.x * matrix.a + this.y * matrix.c + matrix.e,
      this.x * matrix.b + this.y * matrix.d + matrix.f);
  }
}

function matrix(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) {
  return { a, b, c, d, e, f, inverse() {
    const determinant = a * d - b * c;
    return matrix(d / determinant, -b / determinant, -c / determinant, a / determinant,
      (c * f - d * e) / determinant, (b * e - a * f) / determinant);
  } };
}

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} equals ${expected}`);

function harness(t, transform = matrix()) {
  const handlers = new Map(), captures = new Set(), selections = [], resolutions = [];
  const listen = surface => (type, handler) => {
    const key = `${surface}:${type}`;
    handlers.set(key, [...(handlers.get(key) || []), handler]);
  };
  for (const [key, value] of Object.entries({ DOMPoint: Point, window: { addEventListener: listen('window') },
    document: { hidden: false, addEventListener: listen('document') } })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => old ? Object.defineProperty(globalThis, key, old) : delete globalThis[key]);
  }
  const classes = new Set();
  const svg = {
    addEventListener: listen('svg'), getScreenCTM: () => matrix(),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 640, bottom: 820, width: 640, height: 820 }),
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id), closest: () => null,
    contains: target => target?.connected === true,
    classList: { contains: name => classes.has(name), toggle(name, active) { active ? classes.add(name) : classes.delete(name); } },
  };
  let hover, onPreview = () => {};
  // Match app.js: gestures register first, then transient hover. Touch clears
  // hover (and can trigger a redraw) only after the tap has resolved its angle.
  const controls = attachGestures(svg, { setAttribute() {} }, {
    onSelect: item => selections.push(item), onChange() {},
    resolveSelection(target, event) {
      resolutions.push(event.type);
      return mandalaSelectionFromTarget(event, target, hover?.currentSelection);
    },
  });
  hover = attachHoverPreview(svg, {
    resolvePreview: mandalaPreviewFromPointer, resolveKeyboard: mandalaPreviewFromFocus,
    onPreview: value => onPreview(value),
  });
  const target = (gate = 41, ring = true) => {
    const element = {
      connected: true, dataset: { type: 'gate', id: String(gate) },
      classList: { contains: name => ring && name === 'mandala-gate' },
      closest(selector) {
        if (!this.connected) return null;
        return selector === '[data-type]' ? this : selector === '.bodygraph-mandala' ? { getScreenCTM: () => transform } : null;
      },
    };
    return element;
  };
  const point = longitude => {
    const angle = longitude * Math.PI / 180, radius = MANDALA_GEOMETRY.labelRadius;
    const result = new Point(MANDALA_GEOMETRY.centerX - radius * Math.cos(angle),
      MANDALA_GEOMETRY.centerY + radius * Math.sin(angle)).matrixTransform(transform);
    return { clientX: result.x, clientY: result.y };
  };
  function send(type, options = {}) {
    // A real KeyboardEvent has no client coordinates: do not accidentally
    // exercise pointer resolution when testing Enter/Space and Shift variants.
    const event = { type, target: svg, shiftKey: false, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...(type.startsWith('pointer') || type === 'lostpointercapture'
        ? { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0, clientX: 320, clientY: 410 } : {}), ...options };
    for (const handler of handlers.get(`svg:${type}`) || []) handler(event);
    return event;
  }
  controls.reset();
  return { controls, hover, target, point, send, selections, resolutions, captures,
    onPreview(callback) { onPreview = callback; } };
}

test('a ring tap commits the exact pointerdown angle after redraw detaches the pressed target', t => {
  const h = harness(t, matrix(.7, .05, -.02, .7, 100, 30)), target = h.target();
  h.send('pointermove', { target, ...h.point(305.6) });
  assert.equal(h.hover.currentSelection.cross.type, 'right-angle');
  h.send('pointerdown', { target, shiftKey: true, ...h.point(305.64) });
  target.connected = false;
  target.dataset = {}; // the detached DOM is no longer a source of truth
  h.send('pointermove', { target: h.target(), buttons: 1, ...h.point(305.78) });
  assert.equal(h.hover.currentSelection, null, 'the redraw may clear the temporary cross');
  h.send('pointerup', { target: h.target(36), shiftKey: false, ...h.point(305.78) });
  assert.equal(h.selections.length, 1);
  close(h.selections[0].id, 305.64);
  assert.equal(h.selections[0].type, 'mandala-cross');
  assert.equal(h.selections[0].cross.type, 'juxtaposition', 'release inside the left-angle region cannot replace the pressed cross');
  assert.equal(h.selections[0].additive, true);
  assert.equal(h.selections[0].cross.positions.length, 4);
  assert.deepEqual(h.resolutions, ['pointerdown'], 'pointerup does not query disconnected SVG geometry');
  assert.equal(h.captures.size, 0);
});

test('touch snapshots a full cross before dismissing and redrawing a stale mouse preview', t => {
  const h = harness(t), oldTarget = h.target(), pressed = h.target(36);
  h.send('pointermove', { target: oldTarget, ...h.point(305.64) });
  h.onPreview(value => { if (!value) pressed.connected = false; });
  h.send('pointerdown', { target: pressed, pointerType: 'touch', ...h.point(359.5) });
  assert.equal(h.hover.currentSelection, null);
  assert.equal(pressed.connected, false, 'touch hover dismissal can replace SVG children synchronously');
  h.send('pointerup', { target: h.target(36), pointerType: 'touch', ...h.point(359.5) });
  assert.equal(h.selections.length, 1);
  close(h.selections[0].id, 359.5);
  assert.equal(h.selections[0].cross.positions.length, 4);
  assert.equal(h.selections[0].additive, undefined);
  assert.deepEqual(h.resolutions, ['pointerdown']);
});

test('Enter, Space and their Shift variants commit the precise keyboard preview without reducing it to one gate', t => {
  const h = harness(t), target = h.target();
  h.send('keydown', { key: 'ArrowRight', target });
  h.send('keydown', { key: 'ArrowRight', target });
  const expected = h.hover.currentSelection;
  assert.notEqual(expected.id, mandalaPreviewFromFocus(target).id, 'preview has moved away from the gate midpoint');
  for (const key of ['Enter', ' ']) for (const shiftKey of [false, true]) {
    const event = h.send('keydown', { key, target, shiftKey });
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(h.selections.at(-1), { type: 'mandala-cross', id: expected.id, cross: expected.cross,
      ...(shiftKey ? { additive: true } : {}) });
  }
  assert.equal(h.selections.length, 4);
});

test('fresh keyboard activation uses the gate midpoint and never borrows another gate preview', t => {
  const h = harness(t), first = h.target(), second = h.target(36);
  h.send('keydown', { key: 'Enter', target: first });
  assert.equal(h.selections[0].id, mandalaPreviewFromFocus(first).id);
  h.send('pointermove', { target: first, ...h.point(305.64) });
  h.send('keydown', { key: 'Enter', shiftKey: true, target: second });
  assert.equal(h.selections[1].id, mandalaPreviewFromFocus(second).id);
  assert.equal(h.selections[1].additive, true);
});

test('drag, pinch, cancellation and lost capture cannot pin a cross', t => {
  const h = harness(t), target = h.target(), start = h.point(305.64);
  h.controls.zoom(2);
  h.send('pointerdown', { target, shiftKey: true, ...start });
  h.send('pointermove', { target, buttons: 1, ...start, clientX: start.clientX + 20 });
  h.send('pointerup', { target, ...start });
  assert.equal(h.selections.length, 0, 'a drag that returns to its origin is still not a tap');
  h.send('pointerdown', { target, pointerType: 'touch', ...start });
  h.send('pointerdown', { target, pointerType: 'touch', pointerId: 2, ...start, clientX: start.clientX + 70 });
  h.send('pointerup', { target, pointerType: 'touch', pointerId: 2, ...start, clientX: start.clientX + 70 });
  h.send('pointerup', { target, pointerType: 'touch', ...start });
  for (const type of ['pointercancel', 'lostpointercapture']) {
    h.send('pointerdown', { target, ...start });
    h.send(type, { target, ...start });
    h.send('pointerup', { target, ...start });
  }
  assert.equal(h.selections.length, 0);
  h.send('pointerdown', { target, ...start });
  h.send('pointerup', { target, ...start });
  assert.equal(h.selections.length, 1, 'the next genuine tap is not poisoned by a rejected gesture');
});

test('the mandala resolver preserves ordinary bodygraph gate and Shift semantics', t => {
  const h = harness(t), target = h.target(36, false);
  h.send('pointerdown', { target, shiftKey: true });
  h.send('pointerup', { target });
  assert.deepEqual(h.selections[0], { type: 'gate', id: '36', additive: true });
  h.send('keydown', { target, key: 'Enter' });
  assert.deepEqual(h.selections[1], { type: 'gate', id: '36' });
});
