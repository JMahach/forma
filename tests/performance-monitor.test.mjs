import test from 'node:test';
import assert from 'node:assert/strict';
import { attachPerformanceMonitor } from '../src/views/performance-monitor.js';
import { attachTimelineRange } from '../src/views/timeline-range.js';

function eventTarget() {
  const listeners = [], attributes = new Map();
  return {
    listeners, textContent: '', hidden: false, focused: false,
    addEventListener(type, handler, options) { listeners.push({ type, handler, options }); },
    removeEventListener(type, handler, options) {
      const capture = value => typeof value === 'boolean' ? value : Boolean(value?.capture);
      const index = listeners.findIndex(entry => entry.type === type && entry.handler === handler
        && capture(entry.options) === capture(options));
      if (index !== -1) listeners.splice(index, 1);
    },
    emit(type, detail = {}) {
      const event = { type, target: this, ...detail };
      for (const entry of [...listeners]) if (entry.type === type) entry.handler(event);
    },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); },
    focus(options) { this.focused = true; this.focusOptions = options; },
  };
}

function harness({ initiallyEnabled = false, separateSurface = false } = {}) {
  const document = eventTarget(), window = eventTarget(), drawing = eventTarget();
  document.defaultView = window;
  const inputSurface = separateSurface ? eventTarget() : drawing;
  const button = eventTarget(), panel = eventTarget(), close = eventTarget();
  panel.hidden = true;
  const fields = Object.fromEntries(['fps', 'pauses', 'max']
    .map(name => [name, eventTarget()]));
  panel.querySelector = selector => selector === '[data-performance-close]' ? close
    : fields[selector.match(/^\[data-performance="(.+)"\]$/)?.[1]];
  const ranges = [eventTarget(), eventTarget()], motionButtons = [eventTarget(), eventTarget()];
  const scheduled = new Map(), callbacks = new Map(), toggles = [];
  let time = 0, handle = 0;
  const view = attachPerformanceMonitor({
    document, button, panel, drawing, inputSurface, ranges, motionButtons, initiallyEnabled,
    onToggle: enabled => toggles.push(enabled),
    monitorOptions: {
      now: () => time,
      requestFrame(callback) {
        scheduled.set(handle, callback);
        callbacks.set(handle, callback);
        return handle++;
      },
      cancelFrame: id => scheduled.delete(id),
      publishIntervalMs: 0,
    },
  });
  return {
    document, window, drawing, inputSurface, button, panel, close, fields, ranges, motionButtons,
    view, scheduled, toggles,
    observedTargets: [...new Set([drawing, inputSurface]), ...ranges, ...motionButtons, document, window],
    at(value) { time = value; },
    frame(value) {
      time = value;
      for (const [id, callback] of [...scheduled]) {
        scheduled.delete(id);
        callback(time);
      }
    },
    invoke(id, value) { time = value; callbacks.get(id)?.(time); },
    read() { return Object.fromEntries(Object.entries(fields).map(([key, element]) => [key, element.textContent])); },
    pointer(type, detail = {}) {
      inputSurface.emit(type, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 10, clientY: 20, ...detail });
    },
  };
}

function noObservers(h) {
  for (const target of h.observedTargets) assert.equal(target.listeners.length, 0);
  assert.equal(h.scheduled.size, 0);
}

test('disabled view has no input observers and no animation loop', () => {
  const h = harness();
  noObservers(h);
  h.pointer('pointerdown');
  h.pointer('pointermove', { clientX: 20 });
  h.drawing.emit('wheel', { deltaY: 1 });
  h.ranges[0].emit('input');
  noObservers(h);
  assert.equal(h.panel.hidden, true);
  assert.deepEqual(h.read(), { fps: '—', pauses: '—', max: '—' });
  h.view.destroy();
});

test('toggle installs passive capture observers only on relevant surfaces, without starting sampling', () => {
  const h = harness();
  h.button.emit('click');
  assert.equal(h.panel.hidden, false);
  assert.equal(h.button.getAttribute('aria-pressed'), 'true');
  assert.equal(h.button.getAttribute('aria-expanded'), 'true');
  assert.equal(h.close.focused, true);
  assert.deepEqual(h.close.focusOptions, { preventScroll: true });
  assert.deepEqual(h.toggles, [true]);
  assert.deepEqual(h.drawing.listeners.map(entry => entry.type).sort(),
    ['keydown', 'lostpointercapture', 'pointercancel', 'pointerdown', 'pointermove', 'pointerup', 'wheel']);
  assert.deepEqual(h.document.listeners.map(entry => entry.type), ['visibilitychange']);
  assert.deepEqual(h.window.listeners.map(entry => entry.type), ['pagehide']);
  for (const range of h.ranges) assert.deepEqual(range.listeners.map(entry => entry.type).sort(),
    ['input', 'lostpointercapture', 'pointercancel', 'pointerdown', 'pointermove', 'pointerup']);
  for (const control of h.motionButtons) assert.deepEqual(control.listeners.map(entry => entry.type), ['click']);
  for (const target of h.observedTargets) {
    for (const entry of target.listeners) assert.deepEqual(entry.options, { passive: true, capture: true });
  }
  h.document.emit('wheel', { deltaY: 1 });
  h.document.emit('pointermove', { pointerId: 1, clientX: 40 });
  assert.equal(h.scheduled.size, 0, 'unrelated page interaction does not enter the measurement');
  h.button.emit('click');
  noObservers(h);
  assert.deepEqual(h.toggles, [true, false]);
  h.view.destroy();
});

test('hover, a stationary press and the secondary mouse button do not count as movement', () => {
  const h = harness({ initiallyEnabled: true });
  h.pointer('pointermove');
  h.pointer('pointerdown');
  h.pointer('pointermove');
  assert.equal(h.scheduled.size, 0);
  h.pointer('pointerup');
  h.pointer('pointerdown', { button: 2 });
  h.pointer('pointermove', { button: 2, clientX: 30 });
  assert.equal(h.scheduled.size, 0);
  h.pointer('pointerdown');
  h.pointer('pointermove', { clientX: 30 });
  assert.equal(h.scheduled.size, 1);
  h.view.destroy();
});

test('two-finger movement measures one shared frame stream and retains the remaining finger', () => {
  const h = harness({ initiallyEnabled: true });
  h.pointer('pointerdown', { pointerType: 'touch', pointerId: 10 });
  h.pointer('pointerdown', { pointerType: 'touch', pointerId: 11, clientX: 50 });
  h.pointer('pointermove', { pointerType: 'touch', pointerId: 10, clientX: 5 });
  h.pointer('pointermove', { pointerType: 'touch', pointerId: 11, clientX: 55 });
  assert.equal(h.scheduled.size, 1, 'one loop despite two moving fingers');
  h.frame(16);
  h.frame(32);
  h.pointer('pointerup', { pointerType: 'touch', pointerId: 10 });
  h.at(190);
  h.pointer('pointermove', { pointerType: 'touch', pointerId: 11, clientX: 60 });
  h.frame(208);
  assert.equal(h.scheduled.size, 1, 'remaining finger extends activity');
  assert.equal(h.fields.max.textContent, '176.0 мс');
  h.view.destroy();
});

for (const end of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  test(`${end} forgets the pointer, while allowing the final short observation tail`, () => {
    const h = harness({ initiallyEnabled: true });
    h.pointer('pointerdown');
    h.pointer('pointermove', { clientX: 20 });
    h.frame(16);
    h.frame(32);
    h.pointer(end);
    for (let time = 48; time <= 224; time += 16) h.frame(time);
    assert.equal(h.scheduled.size, 0);
    const saved = h.read();
    assert.deepEqual(saved, { fps: '≈63', pauses: '0', max: '16.0 мс' });
    h.at(1000);
    h.pointer('pointermove', { clientX: 40 });
    assert.equal(h.scheduled.size, 0);
    assert.deepEqual(h.read(), saved);
    h.view.destroy();
  });
}

test('nonzero wheel input, either timeline and each configured motion control start sampling', () => {
  const h = harness({ initiallyEnabled: true });
  h.drawing.emit('wheel', { deltaX: 0, deltaY: 0 });
  assert.equal(h.scheduled.size, 0);
  const inputs = [
    () => h.drawing.emit('wheel', { deltaX: 1, deltaY: 0 }),
    () => h.drawing.emit('wheel', { deltaX: 0, deltaY: -1 }),
    ...h.ranges.map(range => () => range.emit('input')),
    ...h.motionButtons.map(control => () => control.emit('click')),
  ];
  for (const input of inputs) {
    input();
    assert.equal(h.scheduled.size, 1);
    h.view.setEnabled(false);
    assert.equal(h.scheduled.size, 0);
    h.view.setEnabled(true);
  }
  h.view.destroy();
});

test('keyboard monitoring is limited to drawing zoom and home shortcuts', () => {
  const h = harness({ initiallyEnabled: true });
  for (const key of ['ArrowLeft', 'Enter', 'Escape', '=', 'a']) h.drawing.emit('keydown', { key });
  h.drawing.emit('keydown', { key: '+', target: eventTarget() });
  h.ranges[0].emit('keydown', { key: '-' });
  assert.equal(h.scheduled.size, 0);
  for (const key of ['+', '-', '0']) {
    h.drawing.emit('keydown', { key });
    assert.equal(h.scheduled.size, 1);
    h.view.setEnabled(false);
    h.view.setEnabled(true);
  }
  h.view.destroy();
});

test('reference dragging on either day range measures motion even when no native input event occurs', () => {
  for (const rangeIndex of [0, 1]) {
    for (const pointerType of ['mouse', 'touch', 'pen']) {
      const h = harness({ initiallyEnabled: true }), range = h.ranges[rangeIndex];
      const marker = { ...eventTarget(), style: {} }, scrubbed = [];
      let nativeInputCount = 0;
      Object.assign(range, { min: '0', max: '100', value: '50', step: '1',
        getBoundingClientRect: () => ({ left: 0, width: 244 }),
      });
      const day = attachTimelineRange({ range, marker, onScrub: value => scrubbed.push(value), onReference() {} });
      day.updateReference({ value: 50, visible: true, label: 'Reference' });
      range.addEventListener('input', () => { nativeInputCount += 1; });
      const pointer = (type, clientX) => range.emit(type, {
        pointerId: 7, pointerType, button: 0, isPrimary: true, clientX, clientY: 10, preventDefault() {},
      });
      pointer('pointermove', 122);
      assert.equal(h.scheduled.size, 0, 'hover is not a drag');
      pointer('pointerdown', 122);
      pointer('pointermove', 122);
      assert.equal(h.scheduled.size, 0, 'stationary reference press is not movement');
      pointer('pointermove', 142);
      assert.deepEqual(scrubbed, [60]);
      assert.equal(nativeInputCount, 0, 'reference drag calls onScrub directly');
      assert.equal(h.scheduled.size, 1, `${pointerType} movement starts the monitor`);
      for (const time of [16, 32, 48, 64]) h.frame(time);
      assert.deepEqual(h.read(), { fps: '≈63', pauses: '0', max: '16.0 мс' });
      pointer('pointerup', 142);
      for (let time = 80; time <= 224; time += 16) h.frame(time);
      const saved = h.read();
      h.at(1000);
      pointer('pointermove', 162);
      assert.equal(h.scheduled.size, 0, 'released pointer cannot restart measurement');
      assert.deepEqual(h.read(), saved);
      h.view.setEnabled(false);
      pointer('pointerdown', 122);
      pointer('pointermove', 162);
      assert.equal(h.scheduled.size, 0, 'disabled monitor ignores a real custom drag');
      assert.deepEqual(h.read(), saved);
      h.view.destroy();
    }
  }
});

test('pointer ownership prevents another surface from continuing or cancelling a range gesture', () => {
  const h = harness({ initiallyEnabled: true }), [range, other] = h.ranges;
  const event = { pointerId: 9, pointerType: 'touch', button: 0, clientX: 10, clientY: 10 };
  range.emit('pointerdown', event);
  other.emit('pointermove', { ...event, clientX: 20 });
  h.drawing.emit('pointermove', { ...event, clientX: 20 });
  assert.equal(h.scheduled.size, 0);
  other.emit('pointerup', event);
  h.drawing.emit('lostpointercapture', event);
  range.emit('pointermove', { ...event, clientX: 20 });
  assert.equal(h.scheduled.size, 1, 'only the owner can end its tracked pointer');
  h.view.destroy();
});

test('disabled ranges and secondary mouse presses cannot start measurement', () => {
  const h = harness({ initiallyEnabled: true }), range = h.ranges[0];
  const event = { pointerId: 4, pointerType: 'mouse', button: 0, clientX: 10, clientY: 10 };
  range.disabled = true;
  range.emit('pointerdown', event);
  range.emit('pointermove', { ...event, clientX: 20 });
  range.emit('input');
  assert.equal(h.scheduled.size, 0);
  range.disabled = false;
  range.emit('pointermove', { ...event, clientX: 30 });
  assert.equal(h.scheduled.size, 0, 'enabling a range does not revive an ignored pointer');
  range.emit('pointerdown', { ...event, button: 2 });
  range.emit('pointermove', { ...event, button: 2, clientX: 20 });
  assert.equal(h.scheduled.size, 0);
  range.emit('pointerdown', event);
  range.disabled = true;
  range.emit('pointermove', { ...event, clientX: 20 });
  assert.equal(h.scheduled.size, 0);
  range.disabled = false;
  range.emit('pointermove', { ...event, clientX: 30 });
  assert.equal(h.scheduled.size, 0, 'disabling during a press clears the tracked pointer');
  range.emit('input');
  assert.equal(h.scheduled.size, 1, 'native or keyboard input still works when enabled');
  h.view.destroy();
});

test('range cancellation, lost capture, suspension and disabling clear tracked pointers', () => {
  const h = harness({ initiallyEnabled: true }), range = h.ranges[0];
  const event = { pointerId: 8, pointerType: 'touch', button: 0, clientX: 10, clientY: 10 };
  const endings = [
    () => range.emit('pointercancel', event),
    () => range.emit('lostpointercapture', event),
    () => h.window.emit('pagehide'),
    () => { h.document.hidden = true; h.document.emit('visibilitychange'); h.document.hidden = false; },
    () => { h.view.setEnabled(false); noObservers(h); h.view.setEnabled(true); },
  ];
  for (const end of endings) {
    range.emit('pointerdown', event);
    end();
    range.emit('pointermove', { ...event, clientX: 20 });
    assert.equal(h.scheduled.size, 0);
  }
  h.view.destroy();
});

test('hidden tabs cancel sampling and pointers; resuming excludes the hidden interval', () => {
  const h = harness({ initiallyEnabled: true });
  h.pointer('pointerdown');
  h.pointer('pointermove', { clientX: 20 });
  h.frame(16);
  h.frame(32);
  const stale = [...h.scheduled.keys()][0];
  h.document.hidden = true;
  h.document.emit('visibilitychange');
  assert.equal(h.scheduled.size, 0);
  const hidden = h.read();
  h.invoke(stale, 10_000);
  h.ranges[0].emit('input');
  h.drawing.emit('wheel', { deltaY: 1 });
  h.pointer('pointerdown', { pointerId: 2 });
  assert.equal(h.scheduled.size, 0);
  assert.deepEqual(h.read(), hidden);
  h.document.hidden = false;
  h.document.emit('visibilitychange');
  h.pointer('pointermove', { clientX: 30 });
  h.pointer('pointermove', { pointerId: 2, clientX: 30 });
  assert.equal(h.scheduled.size, 0, 'pre-hide and hidden pointers cannot restart a gesture');
  h.drawing.emit('wheel', { deltaY: 1 });
  h.frame(10_016);
  h.frame(10_032);
  assert.equal(h.fields.max.textContent, '16.0 мс');
  assert.equal(h.fields.pauses.textContent, '0');
  h.view.destroy();
});

test('pagehide suspends work even when the document has not yet become hidden', () => {
  const h = harness({ initiallyEnabled: true });
  h.pointer('pointerdown');
  h.pointer('pointermove', { clientX: 20 });
  h.frame(16);
  h.frame(32);
  h.window.emit('pagehide');
  assert.equal(h.scheduled.size, 0);
  const saved = h.read();
  h.at(10_000);
  h.pointer('pointermove', { clientX: 40 });
  h.frame(10_016);
  assert.deepEqual(h.read(), saved);
  h.ranges[1].emit('input');
  h.frame(10_032);
  h.frame(10_048);
  assert.equal(h.fields.max.textContent, '16.0 мс');
  assert.equal(h.fields.pauses.textContent, '0');
  h.view.destroy();
});

test('last FPS, pause count and maximum stay visible through idle time, disabling and reopening', () => {
  const h = harness({ initiallyEnabled: true });
  h.pointer('pointerdown');
  h.pointer('pointermove', { clientX: 20 });
  for (const time of [16, 32, 48, 112, 128, 144, 160, 176, 192, 208]) h.frame(time);
  assert.equal(h.scheduled.size, 0);
  const saved = { fps: '≈47', pauses: '1', max: '64.0 мс' };
  assert.deepEqual(h.read(), saved);
  h.frame(50_000);
  assert.deepEqual(h.read(), saved, 'idle time cannot dilute FPS or erase the last reading');
  h.view.setEnabled(false);
  noObservers(h);
  assert.deepEqual(h.read(), saved);
  h.drawing.emit('wheel', { deltaY: 1 });
  h.ranges[0].emit('input');
  h.frame(100_000);
  assert.deepEqual(h.read(), saved, 'disabled interactions do not change the reading');
  h.view.setEnabled(true);
  assert.deepEqual(h.read(), saved);
  h.pointer('pointermove', { clientX: 30 });
  assert.equal(h.scheduled.size, 0, 'reopening does not revive a pointer from the previous session');
  h.view.destroy();
});

test('visible FPS follows recent motion instead of averaging away a sustained slowdown', () => {
  const h = harness({ initiallyEnabled: true });
  h.drawing.emit('wheel', { deltaY: 1 });
  h.frame(0);
  let time = 0;
  for (const interval of [...Array(75).fill(16), ...Array(30).fill(40)]) {
    h.at(time += interval);
    h.drawing.emit('wheel', { deltaY: 1 });
    h.frame(time);
  }
  assert.deepEqual(h.read(), { fps: '≈25', pauses: '0', max: '40.0 мс' });
  h.view.destroy();
});

test('close removes observers, cancels work and restores drawing focus; reopening preserves results', () => {
  const h = harness({ initiallyEnabled: true });
  h.drawing.emit('wheel', { deltaY: 1 });
  for (const time of [16, 32, 48, 112]) h.frame(time);
  h.close.emit('click');
  noObservers(h);
  assert.equal(h.panel.hidden, true);
  assert.equal(h.button.getAttribute('aria-pressed'), 'false');
  assert.equal(h.button.getAttribute('aria-expanded'), 'false');
  assert.equal(h.drawing.focused, true);
  assert.deepEqual(h.drawing.focusOptions, { preventScroll: true });
  const saved = h.read();
  assert.deepEqual(saved, { fps: '≈31', pauses: '1', max: '64.0 мс' });
  h.view.setEnabled(true);
  assert.deepEqual(h.read(), saved);
  assert.equal(h.panel.hidden, false);
  assert.equal(h.scheduled.size, 0);
  h.view.setEnabled(false);
  noObservers(h);
  h.view.destroy();
});

test('repeated enable is idempotent and destroy removes every listener and rejects later work', () => {
  const h = harness({ initiallyEnabled: true });
  const counts = h.observedTargets.map(target => target.listeners.length);
  h.view.setEnabled(true);
  h.view.setEnabled(true);
  assert.deepEqual(h.observedTargets.map(target => target.listeners.length), counts);
  h.drawing.emit('wheel', { deltaY: 1 });
  h.frame(16);
  h.frame(32);
  const stale = [...h.scheduled.keys()][0];
  h.view.destroy();
  h.view.destroy();
  noObservers(h);
  for (const target of [h.button, h.close]) assert.equal(target.listeners.length, 0);
  const destroyed = h.read();
  h.view.setEnabled(true);
  h.button.emit('click');
  h.close.emit('click');
  h.drawing.emit('wheel', { deltaY: 1 });
  h.invoke(stale, 1000);
  noObservers(h);
  assert.equal(h.panel.hidden, true);
  assert.deepEqual(h.read(), destroyed);
});


test('fixed input surface records captured drags while keyboard and close focus stay on the drawing', () => {
  const h = harness({ initiallyEnabled: true, separateSurface: true });
  assert.deepEqual(h.drawing.listeners.map(entry => entry.type), ['keydown']);
  h.pointer('pointerdown');
  h.pointer('pointermove', { clientX: 35 });
  h.frame(16); h.frame(32); h.frame(48); h.frame(64);
  assert.notEqual(h.fields.fps.textContent, '—');
  h.close.emit('click');
  assert.equal(h.drawing.focused, true);
  noObservers(h);
  h.view.setEnabled(true);
  h.inputSurface.emit('wheel', { deltaY: -30 });
  assert.equal(h.scheduled.size, 1);
  h.view.destroy();
  noObservers(h);
});
