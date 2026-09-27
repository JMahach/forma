import test from 'node:test';
import assert from 'node:assert/strict';
import { attachHoverPreview } from '../src/selection/hover-preview.js';
import { crossAtLongitude } from '../src/domain/mandala-cross.js';
import { mandalaPreviewFromFocus, mandalaSelectionFromTarget } from '../src/scene/mandala-preview.js';
import { GATE_WIDTH } from '../src/domain/gate-wheel.js';

const cross = longitude => {
  const value = crossAtLongitude(longitude);
  return { type: 'mandala-cross', id: value.longitude, cross: value, focusGate: 41 };
};

function harness(t, { coalesceMandala = true, omitCoalescingOption = false, browserFrames = false, resolveKeyboard = mandalaPreviewFromFocus } = {}) {
  const listeners = new Map(), previews = [], clears = [], classes = new Set();
  const scheduled = new Map(), allFrames = new Map(), requested = [], canceled = [];
  let nextFrame = 0;
  const requestFrame = callback => {
    const handle = nextFrame++;
    scheduled.set(handle, callback); allFrames.set(handle, callback); requested.push(handle);
    return handle;
  };
  const cancelFrame = handle => { canceled.push(handle); scheduled.delete(handle); };
  const listen = surface => (type, callback) => listeners.set(`${surface}:${type}`, callback);
  const document = { hidden: false, addEventListener: listen('document') };
  const window = { addEventListener: listen('window'), requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame };
  for (const [key, value] of Object.entries({ document, window })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : delete globalThis[key]);
  }
  const svg = {
    addEventListener: listen('svg'), classList: { contains: name => classes.has(name) },
    contains: node => node?.inside === true,
  };
  const target = (type = 'gate', id = 41, ring = false) => ({
    dataset: { type, id: String(id) }, inside: true,
    classList: { contains: name => ring && name === 'mandala-gate' },
    closest(selector) { return selector === '[data-type]' ? this : null; },
  });
  const ring = target('gate', 41, true);
  const controller = attachHoverPreview(svg, {
    ...(omitCoalescingOption ? {} : { coalesceMandala }),
    ...(browserFrames ? {} : { requestFrame, cancelFrame }),
    resolvePreview: event => event.selection || null, resolveKeyboard,
    onPreview: value => previews.push(value), onClear: () => clears.push(true),
  });
  function send(type, options = {}, surface = 'svg') {
    const event = { target: ring, pointerType: 'mouse', buttons: 0, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, ...options };
    listeners.get(`${surface}:${type}`)?.(event);
    return event;
  }
  const move = longitude => send('pointermove', { selection: cross(longitude) });
  const flush = () => {
    const frames = [...scheduled];
    for (const [handle, callback] of frames) { scheduled.delete(handle); callback(16); }
  };
  t.after(() => controller.clear({ notify: false }));
  return { controller, previews, clears, classes, document, target, ring, send, move, flush,
    scheduled, requested, canceled, invoke: handle => allFrames.get(handle)?.(16) };
}

test('a burst of mandala movement keeps the latest exact selection immediately and paints once per frame', t => {
  const h = harness(t);
  for (const longitude of [305.6, 305.64, 305.78]) {
    h.move(longitude);
    assert.deepEqual(h.controller.currentSelection, cross(longitude));
  }
  assert.deepEqual(h.requested, [0], 'a valid zero frame handle does not queue duplicate work');
  assert.deepEqual(h.previews, []);
  h.flush();
  assert.deepEqual(h.previews, [cross(305.78)]);
  assert.equal(h.scheduled.size, 0);
  h.move(305.8); h.move(306);
  assert.deepEqual(h.requested, [0, 1]);
  h.flush();
  assert.deepEqual(h.previews, [cross(305.78), cross(306)]);
});

test('unchanged type and id do not request or paint redundant previews before or after a frame', t => {
  const h = harness(t);
  h.move(305.64); h.move(305.64); h.move(305.64);
  assert.equal(h.requested.length, 1);
  h.flush();
  h.move(305.64); h.move(305.64); h.flush();
  assert.deepEqual(h.previews, [cross(305.64)]);
  assert.equal(h.requested.length, 1);
});

test('ordinary gates, centers, channels and integration remain immediate and cancel pending mandala paint', t => {
  const h = harness(t);
  for (const [type, id] of [['gate', 20], ['center', 'throat'], ['channel', '35-36'], ['integration', 'integration']]) {
    h.move(305.64);
    const queued = h.requested.at(-1);
    h.send('pointermove', { target: h.target(type, id) });
    assert.deepEqual(h.controller.currentSelection, { type, id });
    assert.deepEqual(h.previews.at(-1), { type, id });
    assert.equal(h.scheduled.size, 0);
    assert.equal(h.canceled.at(-1), queued);
    const count = h.previews.length;
    h.invoke(queued); h.flush();
    h.send('pointermove', { target: h.target(type, id) });
    assert.equal(h.previews.length, count, 'neither a stale frame nor same-target movement paints again');
  }
});

test('resolved non-mandala previews remain immediate with coalescing enabled', t => {
  const h = harness(t), selection = { type: 'gate', id: 46 };
  h.send('pointermove', { selection });
  assert.deepEqual(h.previews, [selection]);
  assert.deepEqual(h.controller.currentSelection, selection);
  assert.deepEqual(h.requested, []);
});

test('all clear paths cancel a pending frame and prevent even a late canceled callback from repainting', t => {
  const h = harness(t);
  const dismissals = [
    ['clear', () => h.controller.clear()],
    ['silent clear', () => h.controller.clear({ notify: false }), false],
    ['pointer leave', () => h.send('pointerleave')],
    ['window blur', () => h.send('blur', {}, 'window')],
    ['hidden document', () => { h.document.hidden = true; h.send('visibilitychange', {}, 'document'); }],
    ['wheel', () => h.send('wheel')],
    ['touch down', () => h.send('pointerdown', { pointerType: 'touch' })],
    ['touch move', () => h.send('pointermove', { pointerType: 'touch' })],
    ['pressed move', () => h.send('pointermove', { buttons: 1 })],
    ['drag', () => { h.classes.add('is-dragging'); h.send('pointermove'); }],
    ['background', () => h.send('pointermove', { target: {} })],
    ['detached target', () => h.send('pointermove', { target: { ...h.ring, inside: false } })],
    ['invalid gate', () => h.send('pointermove', { target: h.target('gate', 65) })],
    ['Escape', () => h.send('keydown', { key: 'Escape' })],
  ];
  for (const [name, dismiss, notify = true] of dismissals) {
    h.document.hidden = false; h.classes.clear();
    h.move(305.64);
    const handle = h.requested.at(-1), paints = h.previews.length, clears = h.clears.length;
    dismiss();
    assert.equal(h.controller.currentSelection, null, name);
    assert.equal(h.canceled.at(-1), handle, name);
    assert.equal(h.scheduled.size, 0, name);
    assert.equal(h.clears.length, clears + 1, name);
    assert.equal(h.previews.length, paints + Number(notify), name);
    if (notify) assert.equal(h.previews.at(-1), null, name);
    h.invoke(handle); h.flush(); h.controller.clear();
    assert.equal(h.previews.length, paints + Number(notify), `${name}: no stale redraw`);
    assert.equal(h.clears.length, clears + 1, `${name}: cleanup is idempotent`);
  }
});

test('a canceled callback cannot consume or repaint a newer pending frame', t => {
  const h = harness(t);
  h.move(305.6); const stale = h.requested.at(-1);
  h.controller.clear({ notify: false });
  h.move(305.78); const latest = h.requested.at(-1);
  h.invoke(stale);
  assert.deepEqual(h.previews, []);
  assert.deepEqual([...h.scheduled.keys()], [latest]);
  assert.deepEqual(h.controller.currentSelection, cross(305.78));
  h.flush();
  assert.deepEqual(h.previews, [cross(305.78)]);
});

test('keyboard traversal uses the latest pending angle, paints immediately and cancels its pointer frame', t => {
  const h = harness(t);
  h.move(305.6); h.move(305.64);
  const queued = h.requested.at(-1);
  const event = h.send('keydown', { key: 'ArrowRight' });
  assert.equal(event.defaultPrevented, true);
  const expected = cross(305.64 + GATE_WIDTH / 48);
  assert.deepEqual(h.controller.currentSelection, expected);
  assert.deepEqual(h.previews, [expected]);
  assert.equal(h.canceled.at(-1), queued);
  assert.equal(h.scheduled.size, 0);
  h.invoke(queued); h.flush();
  assert.deepEqual(h.previews, [expected]);
  h.send('keydown', { key: 'ArrowLeft' });
  assert.deepEqual(h.previews.at(-1), cross(305.64));
  assert.equal(h.requested.length, 1, 'keyboard traversal never schedules a frame');
});

test('a keyboard result equal to a queued angle flushes once immediately, then same-id remains a no-op', t => {
  const h = harness(t, { resolveKeyboard: (target, current) => current });
  h.move(305.64);
  const queued = h.requested.at(-1);
  h.send('keydown', { key: 'ArrowRight' });
  assert.deepEqual(h.previews, [cross(305.64)]);
  assert.equal(h.scheduled.size, 0);
  h.send('keydown', { key: 'ArrowRight' }); h.invoke(queued); h.flush();
  assert.deepEqual(h.previews, [cross(305.64)]);
});

test('click resolution can commit the exact latest cross before deferred paint without consuming Shift or Enter', t => {
  const h = harness(t);
  h.move(305.6); h.move(305.78);
  const latest = h.controller.currentSelection;
  latest.id = 1;
  assert.equal(h.controller.currentSelection.id, 305.78, 'the public selection snapshot cannot replace internal identity');
  for (const [type, options] of [['pointerdown', {}], ['pointerup', {}], ['click', { shiftKey: true }], ['keydown', { key: 'Enter', shiftKey: true }]]) {
    assert.equal(h.send(type, options).defaultPrevented, false);
  }
  const selected = mandalaSelectionFromTarget({ shiftKey: true }, h.ring, h.controller.currentSelection);
  assert.equal(selected.id, 305.78);
  assert.equal(selected.cross.type, 'left-angle');
  assert.deepEqual(selected.cross, cross(305.78).cross);
  assert.deepEqual(h.previews, [], 'selection is available without waiting for rendering');
  h.flush();
  assert.deepEqual(h.previews, [cross(305.78)]);
});

test('visible-document notifications and modified keyboard shortcuts preserve pending pointer work', t => {
  const h = harness(t);
  h.move(305.64);
  h.send('visibilitychange', {}, 'document');
  for (const key of ['ctrlKey', 'metaKey', 'altKey']) {
    assert.equal(h.send('keydown', { key: 'ArrowRight', [key]: true }).defaultPrevented, false);
  }
  assert.equal(h.scheduled.size, 1);
  assert.deepEqual(h.canceled, []);
  h.flush();
  assert.deepEqual(h.previews, [cross(305.64)]);
});

test('opting out keeps the original immediate mandala behavior', t => {
  const h = harness(t, { coalesceMandala: false });
  h.move(305.6); h.move(305.64); h.move(305.64); h.move(305.78);
  assert.deepEqual(h.previews, [cross(305.6), cross(305.64), cross(305.78)]);
  assert.deepEqual(h.requested, []);
});

test('callers that omit the new option retain immediate mandala previews by default', t => {
  const h = harness(t, { omitCoalescingOption: true });
  h.move(305.6); h.move(305.64);
  assert.deepEqual(h.previews, [cross(305.6), cross(305.64)]);
  assert.deepEqual(h.requested, []);
});

test('browser animation-frame defaults schedule and cancel when custom functions are not injected', t => {
  const h = harness(t, { browserFrames: true });
  h.move(305.64);
  assert.deepEqual(h.requested, [0]);
  h.controller.clear({ notify: false });
  assert.deepEqual(h.canceled, [0]);
  h.flush();
  assert.deepEqual(h.previews, []);
});
