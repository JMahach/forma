import test from 'node:test';
import assert from 'node:assert/strict';
import { attachMandalaMode } from '../src/scene/modes/mandala.js';
import { MANDALA_FRAME } from '../src/scene/geometry/frames.js';
import { DRAWING_BOUNDS } from '../src/scene/geometry/frames.js';

test('navigation includes enlarged column hit areas and fixing marks without changing its vertical range', () => {
  const { bounds } = MANDALA_FRAME;
  // Painted source envelopes after the 1.09 scale and existing mandala journeys.
  assert.ok(bounds.x <= -290.68);
  assert.ok(bounds.x + bounds.width >= 943.324);
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - 320) < 1e-8, 'horizontal expansion stays symmetric about the chart');
  assert.equal(bounds.y, -64);
  assert.equal(bounds.height, 924);
  assert.equal(MANDALA_FRAME.minScale, .1);
  assert.ok(Object.isFrozen(MANDALA_FRAME) && Object.isFrozen(bounds));
});

function harness({ animate = false, immediate = false } = {}) {
  const callbacks = {}, attributes = {}, classes = new Set(), calls = [];
  let view = { x: -150, y: -100, k: 2 }, mode;
  mode = attachMandalaMode({
    button: { setAttribute: (key, value) => { attributes[key] = value; }, addEventListener: (event, fn) => { callbacks[event] = fn; } },
    canvas: { classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
    } },
    gestures: {
      refreshFrame() { calls.push('refresh frame'); },
      reset() { assert.fail('a toggle must never fit the camera'); },
      setView() { assert.fail('a toggle must never restore another camera'); },
    },
    motion: animate ? { setExpanded(value) { calls.push(`motion ${value}`); if (immediate) mode.finishTransition(value); } } : null,
    beforeChange: () => calls.push('close preview'), render: () => calls.push('render'),
  });
  return { mode, callbacks, attributes, classes, calls, getView: () => view, move: next => { view = next; } };
}

test('both toggle directions preserve the current camera and update mode immediately', () => {
  const h = harness(), original = { ...h.getView() };
  assert.equal(h.mode.enabled, false);
  assert.equal(h.mode.visible, false);
  assert.equal(h.mode.frame.bounds, DRAWING_BOUNDS);
  assert.deepEqual(h.calls, []);
  h.callbacks.click();
  assert.equal(h.mode.enabled, true);
  assert.equal(h.mode.visible, true);
  assert.equal(h.mode.frame, MANDALA_FRAME);
  assert.equal(h.attributes['aria-checked'], 'true');
  assert.ok(h.classes.has('has-mandala'));
  assert.deepEqual(h.calls, ['close preview', 'render', 'refresh frame']);
  assert.deepEqual(h.getView(), original);
  const latest = { x: -50, y: 70, k: .4 };
  h.move(latest);
  h.callbacks.click();
  assert.equal(h.mode.enabled, false);
  assert.equal(h.mode.visible, false);
  assert.equal(h.attributes['aria-checked'], 'false');
  assert.ok(!h.classes.has('has-mandala'));
  assert.deepEqual(h.getView(), latest, 'keeps movement made in mandala, not the old chart view');
});

test('outgoing layer is decorative immediately, removed only once on the current endpoint', () => {
  const h = harness({ animate: true });
  h.callbacks.click(); h.callbacks.click();
  assert.equal(h.mode.enabled, false, 'interaction mode does not wait for motion');
  assert.equal(h.mode.visible, true);
  assert.deepEqual(h.calls.slice(-4), ['close preview', 'render', 'refresh frame', 'motion false']);
  h.mode.finishTransition(true);
  assert.equal(h.mode.visible, true, 'stale completion does nothing');
  h.mode.finishTransition(false);
  assert.equal(h.mode.visible, false);
  const count = h.calls.length;
  h.mode.finishTransition(false);
  assert.equal(h.calls.length, count, 'no redundant render');
});

test('rapid reversal never removes an enabled ring and reduced motion completes synchronously', () => {
  const h = harness({ animate: true });
  h.callbacks.click(); h.callbacks.click(); h.callbacks.click();
  h.mode.finishTransition(false);
  assert.equal(h.mode.enabled, true);
  assert.equal(h.mode.visible, true);
  const reduced = harness({ animate: true, immediate: true });
  reduced.callbacks.click(); reduced.callbacks.click();
  assert.equal(reduced.mode.visible, false);
  assert.deepEqual(reduced.calls.slice(-5), ['close preview', 'render', 'refresh frame', 'motion false', 'render']);
});
