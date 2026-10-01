import test from 'node:test';
import assert from 'node:assert/strict';
import { attachDayRange } from '../src/views/day-range.js';

function element() {
  const listeners = new Map(), attributes = new Map(), captured = new Set();
  return {
    min: '0', max: '1000', step: '1', value: '200', disabled: false, hidden: false, style: {},
    getBoundingClientRect: () => ({ left: 10, top: 30, width: 244, height: 44 }),
    addEventListener(type, callback) { listeners.set(type, callback); },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); },
    focus() {}, setPointerCapture(id) { captured.add(id); },
    hasPointerCapture(id) { return captured.has(id); }, releasePointerCapture(id) { captured.delete(id); },
    send(type, extra = {}) {
      const event = { type, pointerId: 1, isPrimary: true, button: 0, clientX: 132, clientY: 52,
        detail: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
      listeners.get(type)?.(event);
      return event;
    },
  };
}

function harness({ value = 200, reference = 500, withMarker = true } = {}) {
  const range = element(), marker = withMarker ? element() : null, scrubs = [], returns = [];
  range.value = String(value);
  let time = 0;
  const control = attachDayRange({ range, marker, now: () => time,
    onScrub: value => scrubs.push(value), onReference: () => returns.push(true) });
  const update = (extra = {}) => control.updateReference({ value: reference, visible: true,
    label: 'К исходному моменту', active: false, ...extra });
  update();
  return { range, marker, scrubs, returns, update, advance(ms) { time += ms; } };
}

test('reference tap waits for release and does not publish an intermediate selected minute', () => {
  const h = harness();
  assert.equal(h.range.send('pointerdown').defaultPrevented, true);
  assert.equal(h.range.hasPointerCapture(1), true);
  assert.deepEqual(h.scrubs, []);
  assert.deepEqual(h.returns, []);
  // A browser-originated range event cannot get ahead of the pending tap.
  h.range.value = '500'; h.range.send('input');
  assert.equal(h.range.value, '200');
  h.advance(70);
  h.range.send('pointerup', { clientX: 134, clientY: 53 });
  assert.deepEqual(h.returns, [true]);
  assert.deepEqual(h.scrubs, []);
  assert.equal(h.range.hasPointerCapture(1), false);
  assert.equal(h.range.send('click', { detail: 1 }).defaultPrevented, true);
  assert.deepEqual(h.returns, [true], 'the compatibility click cannot return twice');
});

test('a drag beginning on a distant reference selects the dragged minute without visiting the reference', () => {
  const h = harness({ value: 0 });
  h.range.send('pointerdown');
  h.range.send('pointermove', { clientX: 156 });
  assert.deepEqual(h.scrubs, [620]);
  assert.equal(h.range.value, '620');
  h.range.send('pointerup', { clientX: 156 });
  assert.deepEqual(h.scrubs, [620], 'release does not duplicate the last scrub');
  assert.deepEqual(h.returns, []);
});

test('overlapping thumb and reference preserve the finger grip offset during drag', () => {
  const h = harness({ value: 520 });
  h.range.send('pointerdown');
  h.range.send('pointermove', { clientX: 148 });
  assert.deepEqual(h.scrubs, [600], 'movement starts at thumb value 520, not reference 500');
  h.range.send('pointermove', { clientX: 128 });
  assert.deepEqual(h.scrubs, [600, 500]);
  h.range.send('pointermove', { clientX: 127 });
  assert.deepEqual(h.scrubs, [600, 500, 495], 'crossing the reference has no magnetic snap');
  h.range.send('pointerup', { clientX: 127 });
  assert.deepEqual(h.returns, [], 'a drag ending near the reference is still a drag');
});

test('a still tap returns even when the selected thumb exactly covers the reference', () => {
  const h = harness({ value: 500 });
  h.range.send('pointerdown'); h.range.send('pointerup');
  assert.deepEqual(h.returns, [true]);
  assert.deepEqual(h.scrubs, []);
});

test('first and last reference positions are reachable and drags clamp to the actual day', () => {
  for (const reference of [0, 1000]) {
    const h = harness({ value: 500, reference });
    const clientX = reference === 0 ? 32 : 232;
    assert.equal(h.marker.style.left, reference === 0 ? '0%' : '100%');
    h.range.send('pointerdown', { clientX }); h.range.send('pointerup', { clientX });
    assert.deepEqual(h.returns, [true]);
    h.range.send('pointerdown', { clientX });
    const beyond = clientX + (reference === 0 ? -100 : 100);
    h.range.send('pointermove', { clientX: beyond }); h.range.send('pointerup', { clientX: beyond });
    assert.deepEqual(h.scrubs, [reference]);
    assert.deepEqual(h.returns, [true]);
  }
});

test('ordinary range input remains native, forwards once, and never auto-returns near the reference', () => {
  for (const withMarker of [true, false]) {
    const h = harness({ withMarker });
    assert.equal(h.range.send('pointerdown', { clientX: 40 }).defaultPrevented, false);
    for (const value of [499, 500, 501]) { h.range.value = String(value); h.range.send('input'); }
    h.range.send('pointerup', { clientX: 132 });
    assert.deepEqual(h.scrubs, [499, 500, 501]);
    assert.deepEqual(h.returns, []);
    h.range.disabled = true; h.range.send('input');
    assert.deepEqual(h.scrubs, [499, 500, 501]);
  }
});

test('touch and pen capture the enlarged transparent area around the thumb without jumping, then track the first movement', () => {
  for (const pointerType of ['touch', 'pen']) for (const withMarker of [true, false]) {
    const h = harness({ withMarker });
    h.range.getBoundingClientRect = () => ({ left: 10, top: 24, width: 244, height: 56 });
    // The visible dot is (72,52); this finger is 26px to the right and 27px above.
    const down = h.range.send('pointerdown', { pointerType, clientX: 98, clientY: 25 });
    assert.equal(down.defaultPrevented, true); assert.equal(h.range.hasPointerCapture(1), true);
    assert.deepEqual(h.scrubs, [], 'a generous thumb grip starts at its selected value');
    h.range.send('pointermove', { pointerType, clientX: 99, clientY: 25 });
    assert.deepEqual(h.scrubs, [205], 'ordinary thumb dragging has no eight-pixel dead zone');
    // Pointer capture continues even when a finger drifts outside the control.
    h.range.send('pointermove', { pointerType, clientX: 120, clientY: -10 });
    h.range.send('pointerup', { pointerType, clientX: 120, clientY: -10 });
    assert.deepEqual(h.scrubs, [205, 310]); assert.deepEqual(h.returns, []);
    assert.equal(h.range.hasPointerCapture(1), false);
  }
});

test('touching anywhere on the track scrubs immediately and dragging reaches both exact endpoints without a marker', () => {
  const h = harness({ withMarker: false });
  h.range.getBoundingClientRect = () => ({ left: 10, top: 24, width: 244, height: 56 });
  h.range.send('pointerdown', { pointerType: 'touch', clientX: 192, clientY: 79 });
  assert.deepEqual(h.scrubs, [800], 'a tap far below the two-pixel rail still chooses that point');
  h.range.send('pointermove', { pointerType: 'touch', clientX: 194, clientY: 79 });
  h.range.send('pointerup', { pointerType: 'touch', clientX: 194, clientY: 79 });
  assert.deepEqual(h.scrubs, [800, 810], 'release does not duplicate the last point');
  for (const [clientX, expected] of [[10, 0], [254, 1000]]) {
    h.range.send('pointerdown', { pointerType: 'touch', clientX });
    h.range.send('pointerup', { pointerType: 'touch', clientX });
    assert.equal(h.scrubs.at(-1), expected);
  }
  assert.deepEqual(h.returns, []);
});

test('touch reference taps retain release arbitration while no-reference archive drags remain available', () => {
  const h = harness();
  h.range.send('pointerdown', { pointerType: 'touch' });
  assert.deepEqual(h.scrubs, []); assert.deepEqual(h.returns, []);
  h.range.send('pointerup', { pointerType: 'touch' }); assert.deepEqual(h.returns, [true]);
  h.update({ visible: false });
  h.range.send('pointerdown', { pointerType: 'touch', clientX: 72 });
  h.update({ visible: false });
  assert.equal(h.range.hasPointerCapture(1), true, 'a range without an in-range reference still supports touch dragging');
  h.range.send('pointermove', { pointerType: 'touch', clientX: 74 });
  assert.deepEqual(h.scrubs, [210]);
  h.range.send('pointerup', { pointerType: 'touch', clientX: 74 });
  assert.deepEqual(h.returns, [true]);
});

test('hidden, disabled, cancelled and multipointer touch gestures cannot scrub a covered control', () => {
  for (const unavailable of ['disabled', 'hidden', 'ancestor']) {
    const h = harness({ withMarker: false });
    if (unavailable === 'ancestor') h.range.closest = () => ({});
    else h.range[unavailable] = true;
    assert.equal(h.range.send('pointerdown', { pointerType: 'touch', clientX: 192 }).defaultPrevented, false);
    h.range.send('input'); assert.deepEqual(h.scrubs, []);
  }
  for (const end of ['pointercancel', 'lostpointercapture', 'second', 'covered']) {
    const h = harness({ withMarker: false });
    h.range.send('pointerdown', { pointerType: 'touch', clientX: 72 });
    if (end === 'second') h.range.send('pointerdown', { pointerType: 'touch', pointerId: 2, isPrimary: false });
    else if (end === 'covered') { h.range.closest = () => ({}); h.update({ visible: false }); }
    else h.range.send(end);
    h.range.send('pointerup', { pointerType: 'touch', clientX: 90 });
    assert.deepEqual(h.scrubs, [], end); assert.deepEqual(h.returns, [], end);
  }
});

test('keyboard range input and the semantic reference button have independent single actions', () => {
  const h = harness();
  h.range.send('keydown', { key: 'ArrowRight' }); h.range.value = '201'; h.range.send('input');
  assert.deepEqual(h.scrubs, [201]);
  h.marker.send('click', { detail: 0 });
  assert.deepEqual(h.returns, [true]);
  h.marker.send('click', { detail: 1 });
  assert.deepEqual(h.returns, [true], 'pointer input is resolved on the range, not a button overlay');
  assert.equal(h.marker.getAttribute('aria-label'), 'К исходному моменту');
  h.update({ active: true });
  assert.equal(h.marker.getAttribute('aria-pressed'), 'true');
  h.update({ visible: false }); h.marker.send('click');
  assert.equal(h.marker.disabled, true);
  assert.equal(h.marker.hidden, true);
  assert.deepEqual(h.returns, [true]);
});

test('cancel, capture loss, long press and a second pointer never become a reference tap', () => {
  for (const end of ['pointercancel', 'lostpointercapture', 'long', 'second']) {
    const h = harness();
    h.range.send('pointerdown');
    if (end === 'long') h.advance(501);
    else if (end === 'second') h.range.send('pointerdown', { pointerId: 2, isPrimary: false });
    else h.range.send(end);
    h.range.send('pointerup');
    assert.deepEqual(h.returns, [], end);
    assert.deepEqual(h.scrubs, [], end);
  }
});

test('movement seen only on release and an out-and-back drag cannot masquerade as a tap', () => {
  const h = harness({ value: 500 });
  h.range.send('pointerdown'); h.range.send('pointerup', { clientX: 152 });
  assert.deepEqual(h.scrubs, [600]);
  assert.deepEqual(h.returns, []);
  h.range.send('pointerdown');
  h.range.send('pointermove', { clientX: 152 }); h.range.send('pointermove'); h.range.send('pointerup');
  assert.deepEqual(h.returns, []);
});

test('unavailable state cancels an in-flight pointer without leaking a return into another day', () => {
  for (const disabled of [true, false]) {
    const h = harness();
    h.range.send('pointerdown');
    h.range.disabled = disabled;
    h.update({ visible: !disabled ? false : true });
    assert.equal(h.range.hasPointerCapture(1), false);
    h.range.send('pointerup'); h.marker.send('click');
    assert.deepEqual(h.returns, []);
    assert.deepEqual(h.scrubs, []);
  }
});

test('marker updates change no selected value and zero-length days remain finite', () => {
  const h = harness();
  h.update({ value: 510 });
  assert.equal(h.range.value, '200');
  assert.equal(h.marker.style.left, '51%');
  h.range.max = '0'; h.range.value = '0'; h.update({ value: 0 });
  assert.equal(h.marker.style.left, '0%');
  h.range.send('pointerdown', { clientX: 32 }); h.range.send('pointermove', { clientX: 100 }); h.range.send('pointerup', { clientX: 100 });
  assert.equal(h.range.value, '0');
  assert.deepEqual(h.scrubs, []);
  assert.deepEqual(h.returns, []);
});
