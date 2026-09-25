import test from 'node:test';
import assert from 'node:assert/strict';
import { attachMandalaMode, MANDALA_FRAME } from '../src/bodygraph/mandala-mode.js';
import { DRAWING_BOUNDS } from '../src/bodygraph/gestures.js';

function harness(t) {
  const callbacks = {}, attributes = {}, classes = new Set(), calls = [];
  let view = { x: -150, y: -100, k: 2 }, fitted = { x: 10, y: 30, k: 1 }, mode, chartFit = { ...fitted };
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', fn => { timers.push(fn); return timers.length; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  mode = attachMandalaMode({
    button: { setAttribute: (key, value) => { attributes[key] = value; }, addEventListener: (event, fn) => { callbacks[event] = fn; } },
    canvas: { classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      add: name => classes.add(name), remove: name => classes.delete(name),
    } },
    gestures: {
      getView: () => ({ ...view }), getFittedView: () => ({ ...fitted }),
      reset() { fitted = mode.enabled ? { x: 100, y: 80, k: 0.4 } : { ...chartFit }; view = { ...fitted }; calls.push('fit'); },
      setView(next) { view = next; calls.push('restore'); },
    },
    beforeChange: () => calls.push('close preview'), render: () => calls.push('render'),
  });
  return { mode, callbacks, attributes, classes, calls, timers, getView: () => view, resize: fit => { chartFit = fit; } };
}

test('mandala toggle starts with unchanged chart frame and fits only when explicitly enabled', t => {
  const h = harness(t), original = { ...h.getView() };
  assert.equal(h.mode.enabled, false);
  assert.equal(h.mode.frame.bounds, DRAWING_BOUNDS);
  assert.deepEqual(h.calls, []);
  h.callbacks.click();
  assert.equal(h.mode.enabled, true);
  assert.equal(h.mode.frame, MANDALA_FRAME);
  assert.equal(h.attributes['aria-checked'], 'true');
  assert.ok(h.classes.has('has-mandala'));
  assert.deepEqual(h.calls, ['close preview', 'render', 'fit']);
  assert.equal(h.getView().k, 0.4);
  h.callbacks.click();
  assert.equal(h.mode.enabled, false);
  assert.equal(h.attributes['aria-checked'], 'false');
  assert.deepEqual(h.getView(), original);
  h.timers.at(-1)();
  assert.ok(!h.classes.has('mandala-transition'));
});

test('returning to the chart restores its relative zoom and position after device resize', t => {
  const h = harness(t);
  h.callbacks.click();
  h.resize({ x: 25, y: 40, k: 0.75 });
  h.callbacks.click();
  assert.deepEqual(h.getView(), { x: -95, y: -57.5, k: 1.5 });
});
