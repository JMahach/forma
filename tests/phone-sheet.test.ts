import test from 'node:test';
import assert from 'node:assert/strict';
import { attachPhoneSheets } from '../src/ui/phone-sheet.ts';

function element(window) {
  const listeners = new Map(), attributes = new Map(), captured = new Set(), classes = new Set();
  const properties = new Map();
  return {
    ownerDocument: { defaultView: window }, dataset: {} as DOMStringMap, disabled: false, inert: false,
    style: { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key), getPropertyValue: key => properties.get(key) || '' },
    classList: { contains: (key: unknown) => classes.has(key), add: (key: unknown) => classes.add(key), remove: (key: unknown) => classes.delete(key) },
    setAttribute: (key, value) => attributes.set(key, String(value)), getAttribute: key => attributes.get(key) ?? null, removeAttribute: key => attributes.delete(key),
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    setPointerCapture: (id: unknown) => captured.add(id), hasPointerCapture: (id: unknown) => captured.has(id),
    releasePointerCapture(id: unknown) { captured.delete(id); this.send('lostpointercapture', { pointerId: id }); },
    send(type: string, extra = {}) {
      const event = { type, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientY: 400,
        timeStamp: 0, detail: type === 'click' ? 1 : 0, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
      for (const callback of listeners.get(type) || []) callback(event);
      return event;
    },
    getBoundingClientRect: () => ({ bottom: 752, top: 708, height: 44 }),
  };
}
function harness({ open = true, phone = true } = {}) {
  const window = { innerHeight: 844, getComputedStyle: panel => ({ bottom: `${panel.bottom}px` }) };
  let visible = { top: 0, height: 844 }, mobile = phone, controller;
  const entries = [0, 1].map(() => {
    const panel = element(window), handle = element(window), content = element(window);
    panel.bottom = 92;
    panel.getBoundingClientRect = () => {
      const height = parseFloat(panel.style.getPropertyValue('--phone-sheet-height')) || 438.88;
      return { bottom: 844 - panel.bottom, top: 844 - panel.bottom - height, height };
    };
    let closes = 0;
    return { panel, handle, content, get closes() { return closes; }, onClose() { closes++; panel.classList.remove('open'); controller?.refresh(); } };
  });
  if (open) entries[0].panel.classList.add('open');
  controller = attachPhoneSheets({ sheets: entries, isPhone: () => mobile, readViewport: () => visible });
  return { ...entries[0], entries, controller, window, setPhone(value: boolean) { mobile = value; controller.refresh(); },
    viewport(value: { top: number; height: number; }) { visible = value; controller.refresh(); },
    open(index = 0) { for (const [i, entry] of entries.entries()) { if (i === index) entry.panel.classList.add('open'); else entry.panel.classList.remove('open'); } controller.refresh(); } };
}
const height = panel => parseFloat(panel.style.getPropertyValue('--phone-sheet-height'));
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < .1, `${actual} ≈ ${expected}`);

// Dropping pointer movement, settling, or capture cleanup breaks these user-visible paths.
test('a dragged handle follows the finger, settles expanded and suppresses only its compatibility click', () => {
  const h = harness();
  close(height(h.panel), 438.88);
  h.handle.send('pointerdown', { clientY: 400, timeStamp: 0 });
  assert.equal(h.handle.hasPointerCapture(1), true);
  h.handle.send('pointermove', { clientY: 200, timeStamp: 400 });
  close(height(h.panel), 638.88);
  assert.equal(h.panel.dataset.sheetDragging, 'true');
  h.handle.send('pointerup', { clientY: 200, timeStamp: 600 });
  close(height(h.panel), 688);
  assert.equal(h.panel.dataset.sheetSize, 'expanded');
  assert.equal(h.handle.getAttribute('aria-expanded'), 'true');
  assert.equal(h.panel.dataset.sheetDragging, undefined);
  assert.equal(h.handle.hasPointerCapture(1), false);
  assert.equal(h.handle.send('click').defaultPrevented, true);
  close(height(h.panel), 688);
  h.handle.send('pointerdown'); h.handle.send('pointerup'); h.handle.send('click');
  close(height(h.panel), 438.88);
});

test('a short pointer tap toggles once while content scrolling is untouched', () => {
  const h = harness();
  h.handle.send('pointerdown'); h.handle.send('pointerup'); h.handle.send('click');
  assert.equal(h.panel.dataset.sheetSize, 'expanded');
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'touchmove', 'wheel'] as const)
    assert.equal(h.content.send(type, { clientY: 700 }).defaultPrevented, false);
  assert.equal(h.panel.dataset.sheetSize, 'expanded');
});

test('slow downward drag dismisses below the compact threshold and cannot double-dismiss', () => {
  const h = harness();
  h.handle.send('pointerdown', { clientY: 300 });
  h.handle.send('pointermove', { clientY: 530, timeStamp: 500 });
  close(height(h.panel), 208.88);
  h.handle.send('pointerup', { clientY: 530, timeStamp: 700 });
  assert.equal(h.entries[0].closes, 1);
  h.handle.send('lostpointercapture'); h.handle.send('click');
  assert.equal(h.entries[0].closes, 1);
  assert.equal(h.handle.getAttribute('aria-expanded'), 'false');
});

test('a quick downward swipe dismisses without requiring the full distance', () => {
  const h = harness();
  h.handle.send('pointerdown', { clientY: 400, timeStamp: 0 });
  h.handle.send('pointermove', { clientY: 460, timeStamp: 50 });
  h.handle.send('pointerup', { clientY: 460, timeStamp: 60 });
  assert.equal(h.entries[0].closes, 1);
});

test('a paused downward drag settles instead of using stale swipe velocity', () => {
  const h = harness();
  h.handle.send('pointerdown', { clientY: 400, timeStamp: 0 });
  h.handle.send('pointermove', { clientY: 460, timeStamp: 50 });
  h.handle.send('pointerup', { clientY: 460, timeStamp: 500 });
  assert.equal(h.entries[0].closes, 0);
  assert.equal(h.panel.dataset.sheetSize, 'medium');
});

test('an upward flick expands even before reaching the nearest-height boundary', () => {
  const h = harness();
  h.handle.send('pointerdown', { clientY: 400, timeStamp: 0 });
  h.handle.send('pointermove', { clientY: 350, timeStamp: 50 });
  h.handle.send('pointerup', { clientY: 350, timeStamp: 65 });
  assert.equal(h.panel.dataset.sheetSize, 'expanded');
  close(height(h.panel), 688);
});

for (const ending of ['pointercancel', 'lostpointercapture'] as const) test(`${ending} restores the prior size without dismissing`, () => {
  const h = harness();
  h.handle.send('click', { detail: 0 });
  h.handle.send('pointerdown', { clientY: 300 });
  h.handle.send('pointermove', { clientY: 700, timeStamp: 100 });
  h.handle.send(ending, { clientY: 700, timeStamp: 120 });
  close(height(h.panel), 688);
  assert.equal(h.entries[0].closes, 0);
  assert.equal(h.panel.dataset.sheetDragging, undefined);
});

test('another pointer, secondary contact and right mouse button cannot take over a gesture', () => {
  const h = harness();
  for (const extra of [{ isPrimary: false }, { pointerType: 'mouse', button: 2 }] as const) {
    h.handle.send('pointerdown', extra); h.handle.send('pointermove', { clientY: 50 }); h.handle.send('pointerup', { clientY: 50 });
    assert.equal(h.panel.dataset.sheetSize, 'medium');
  }
  h.handle.send('pointerdown');
  h.handle.send('pointermove', { pointerId: 2, clientY: 50 });
  h.handle.send('pointerup', { pointerId: 2, clientY: 50 });
  close(height(h.panel), 438.88);
  assert.equal(h.handle.hasPointerCapture(1), true);
  h.handle.send('pointercancel');
});

test('keyboard expansion, collapse and Escape act only on the handle', () => {
  const h = harness();
  assert.equal(h.handle.send('keydown', { key: 'ArrowUp' }).defaultPrevented, true);
  close(height(h.panel), 688);
  h.handle.send('keydown', { key: 'ArrowDown' });
  assert.equal(h.panel.dataset.sheetSize, 'medium');
  assert.equal(h.handle.send('keydown', { key: 'Tab' }).defaultPrevented, false);
  h.handle.send('keydown', { key: 'Escape' });
  assert.equal(h.entries[0].closes, 1);
  h.open(); h.handle.send('keydown', { key: 'ArrowDown' });
  assert.equal(h.entries[0].closes, 2);
});

test('viewport changes preserve the expanded preference and cancel a drag using stale bounds', () => {
  const h = harness();
  h.handle.send('click', { detail: 0 });
  h.panel.bottom = 392;
  h.viewport({ top: 0, height: 544 });
  close(height(h.panel), 388);
  assert.equal(h.panel.dataset.sheetSize, 'expanded');
  h.handle.send('pointerdown'); h.handle.send('pointermove', { clientY: 420, timeStamp: 200 });
  h.panel.bottom = 92; h.viewport({ top: 0, height: 844 });
  assert.equal(h.panel.dataset.sheetDragging, undefined);
  close(height(h.panel), 688);
  h.handle.send('pointerup', { clientY: 700, timeStamp: 250 });
  assert.equal(h.entries[0].closes, 0);
});

test('refresh uses the fixed bottom rather than an in-flight translated rectangle', () => {
  const h = harness();
  h.panel.getBoundingClientRect = () => ({ bottom: 1100, height: 438.88 });
  h.controller.refresh(); h.handle.send('click', { detail: 0 });
  close(height(h.panel), 688);
});

test('switching sheets cancels a drag, preserves the shared settled size and resets only after closing both', () => {
  const h = harness();
  h.handle.send('pointerdown'); h.handle.send('pointermove', { clientY: 150, timeStamp: 200 });
  h.open(1);
  assert.equal(h.handle.hasPointerCapture(1), false);
  assert.equal(h.panel.dataset.sheetDragging, undefined);
  close(height(h.entries[1].panel), 438.88);
  h.entries[1].handle.send('click', { detail: 0 });
  h.open(0);
  close(height(h.panel), 688);
  h.panel.classList.remove('open'); h.controller.refresh();
  h.open(0); close(height(h.panel), 438.88);
});

test('desktop mode cleans mobile presentation and ignores all gestures until returning to phone', () => {
  const h = harness();
  h.handle.send('pointerdown'); h.handle.send('pointermove', { clientY: 150, timeStamp: 200 });
  h.setPhone(false);
  assert.equal(h.panel.style.getPropertyValue('--phone-sheet-height'), '');
  assert.equal(h.panel.dataset.sheetSize, undefined);
  assert.equal(h.panel.dataset.sheetDragging, undefined);
  assert.equal(h.handle.getAttribute('aria-expanded'), null);
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'keydown'] as const)
    assert.equal(h.handle.send(type, { clientY: 700, key: 'Escape' }).defaultPrevented, false);
  assert.equal(h.entries[0].closes, 0);
  h.setPhone(true); close(height(h.panel), 438.88);
});

test('destroy releases capture, removes presentation and leaves no active callbacks', () => {
  const h = harness();
  h.handle.send('pointerdown');
  h.controller.destroy(); h.controller.destroy();
  assert.equal(h.handle.hasPointerCapture(1), false);
  assert.equal(h.panel.style.getPropertyValue('--phone-sheet-height'), '');
  assert.equal(h.panel.dataset.sheetSize, undefined);
  assert.equal(h.handle.getAttribute('aria-expanded'), null);
  h.handle.send('keydown', { key: 'Escape' }); h.handle.send('click'); h.controller.refresh();
  assert.equal(h.entries[0].closes, 0);
  assert.equal(h.panel.style.getPropertyValue('--phone-sheet-height'), '');
});


test('a layout refresh with unchanged bounds does not interrupt the finger', () => {
  const h = harness();
  h.handle.send('pointerdown', { clientY: 400 });
  h.handle.send('pointermove', { clientY: 330, timeStamp: 200 });
  h.controller.refresh();
  assert.equal(h.handle.hasPointerCapture(1), true);
  close(height(h.panel), 508.88);
  h.handle.send('pointermove', { clientY: 250, timeStamp: 400 });
  close(height(h.panel), 588.88);
  h.handle.send('pointerup', { clientY: 250, timeStamp: 600 });
  assert.equal(h.panel.dataset.sheetSize, 'expanded');
});

test('bounds use the visible viewport even without a raised timeline or a global style reader', () => {
  const window = { innerHeight: 844 }, panel = element(window), handle = element(window);
  panel.classList.add('open');
  panel.getBoundingClientRect = () => ({ bottom: 1100, height: 438.88 });
  let visible = { top: 0, height: 844 };
  const controller = attachPhoneSheets({ sheets: [{ panel, handle, onClose() {} }], isPhone: () => true,
    readStyle: () => ({ bottom: '92px' }), readViewport: () => visible });
  handle.send('click', { detail: 0 });
  close(height(panel), 688);
  visible = { top: 100, height: 400 }; controller.refresh();
  close(height(panel), 336);
  controller.destroy();
});


test('expanded height follows the CSS safe top inset and updates when that inset changes', () => {
  const window = { innerHeight: 844 }, panel = element(window), handle = element(window);
  let safeTop = '104px';
  panel.classList.add('open');
  const controller = attachPhoneSheets({ sheets: [{ panel, handle, onClose() {} }], isPhone: () => true,
    readStyle: () => ({ bottom: '92px', scrollPaddingTop: safeTop }), readViewport: () => ({ top: 0, height: 844 }) });
  handle.send('click', { detail: 0 });
  close(height(panel), 648);
  safeTop = '84px'; controller.refresh();
  close(height(panel), 668);
  assert.equal(panel.dataset.sheetSize, 'expanded');
  safeTop = ''; controller.refresh();
  close(height(panel), 688);
  controller.destroy();
});
