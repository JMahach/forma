import test from 'node:test';
import assert from 'node:assert/strict';
import { attachPhoneSheets } from '../src/ui/phone-sheet.ts';

function element(window) {
  const listeners = new Map(), attributes = new Map(), captured = new Set(), classes = new Set();
  const properties = new Map();
  return {
    ownerDocument: window.document || { defaultView: window }, children: [], dataset: {} as DOMStringMap, disabled: false, inert: false,
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
    append(...nodes) { this.children.push(...nodes); },
    contains(target) { return target === this || this.children.some(child => child.contains(target)); },
    focus() { this.ownerDocument.activeElement = this; },
    getBoundingClientRect: () => ({ bottom: 752, top: 708, height: 44 }),
  };
}
function harness({ open = true, phone = true, onReveal = () => {} } = {}) {
  const window = { innerHeight: 844, getComputedStyle: panel => ({ bottom: `${panel.bottom}px` }) };
  window.document = { defaultView: window, activeElement: null };
  let visible = { top: 0, height: 844 }, mobile = phone, controller;
  const entries = [0, 1].map(() => {
    const panel = element(window), handle = element(window), content = element(window);
    panel.bottom = 92;
    panel.getBoundingClientRect = () => {
      const height = parseFloat(panel.style.getPropertyValue('--phone-sheet-height')) || 438.88;
      return { bottom: 844 - panel.bottom, top: 844 - panel.bottom - height, height };
    };
    let closes = 0;
    return { panel, handle, content, onReveal, get closes() { return closes; }, onClose() { closes++; panel.classList.remove('open'); controller?.refresh(); } };
  });
  if (open) entries[0].panel.classList.add('open');
  controller = attachPhoneSheets({ sheets: entries, isPhone: () => mobile, readViewport: () => visible });
  return { ...entries[0], entries, controller, window, setPhone(value: boolean) { mobile = value; controller.refresh(); },
    viewport(value: { top: number; height: number; }) { visible = value; controller.refresh(); },
    open(index = 0) { for (const [i, entry] of entries.entries()) { if (i === index) entry.panel.classList.add('open'); else entry.panel.classList.remove('open'); } controller.refresh(); } };
}
const height = panel => parseFloat(panel.style.getPropertyValue('--phone-sheet-height'));
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < .1, `${actual} ≈ ${expected}`);
function flickHandle(handle: { send: (type: string, extra?: Record<string, unknown>) => { defaultPrevented: boolean } }, direction: -1 | 1) {
  handle.send('pointerdown', { clientY: 400, timeStamp: 0 });
  handle.send('pointermove', { clientY: 400 + direction * 60, timeStamp: 50 });
  handle.send('pointerup', { clientY: 400 + direction * 60, timeStamp: 60 });
  assert.equal(handle.send('click').defaultPrevented, true, 'the compatibility click cannot add another height change');
}


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

test('handle taps reveal once then cycle between medium and expanded without folding', () => {
  const h = harness();
  h.controller.collapse(h.panel);
  for (const [mode, expectedHeight] of [
    ['medium', 438.88], ['expanded', 688], ['medium', 438.88],
    ['expanded', 688], ['medium', 438.88],
  ] as const) {
    h.handle.send('pointerdown'); h.handle.send('pointerup'); h.handle.send('click');
    assert.equal(h.panel.dataset.sheetSize, mode);
    close(height(h.panel), expectedHeight);
    assert.equal(h.content.inert, false);
    assert.equal(h.panel.inert, false);
    assert.equal(h.panel.classList.contains('open'), true);
    assert.equal(h.handle.getAttribute('aria-expanded'), 'true');
  }
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'touchmove', 'wheel'] as const)
    assert.equal(h.content.send(type, { clientY: 700 }).defaultPrevented, false);
  assert.equal(h.entries[0].closes, 0);
});

test('slow downward drag settles at the visible handle without closing the returns screen', () => {
  const h = harness();
  h.panel.dataset.screen = 'returns';
  h.handle.send('pointerdown', { clientY: 300 });
  h.handle.send('pointermove', { clientY: 530, timeStamp: 500 });
  close(height(h.panel), 208.88);
  h.handle.send('pointerup', { clientY: 530, timeStamp: 700 });
  close(height(h.panel), 32);
  assert.equal(h.panel.dataset.sheetSize, 'collapsed');
  assert.equal(h.panel.classList.contains('open'), true);
  assert.equal(h.panel.dataset.screen, 'returns');
  assert.equal(h.entries[0].closes, 0);
  h.handle.send('lostpointercapture'); h.handle.send('click');
  close(height(h.panel), 32);
  assert.equal(h.handle.getAttribute('aria-expanded'), 'false');
});

test('a fresh flick moves exactly one adjacent step and clamps at the ends', () => {
  for (const [start, direction, expected, expectedHeight] of [
    ['expanded', 1, 'medium', 438.88], ['medium', 1, 'collapsed', 32],
    ['collapsed', -1, 'medium', 438.88], ['medium', -1, 'expanded', 688],
    ['expanded', -1, 'expanded', 688], ['collapsed', 1, 'collapsed', 32],
  ] as const) {
    const h = harness();
    if (start === 'expanded') h.handle.send('keydown', { key: 'ArrowUp' });
    if (start === 'collapsed') h.controller.collapse(h.panel);
    h.handle.send('pointerdown', { clientY: 400, timeStamp: 0 });
    h.handle.send('pointermove', { clientY: 400 + direction * 60, timeStamp: 50 });
    h.handle.send('pointerup', { clientY: 400 + direction * 60, timeStamp: 60 });
    assert.equal(h.panel.dataset.sheetSize, expected, start + ' flick ' + direction);
    close(height(h.panel), expectedHeight);
    assert.equal(h.entries[0].closes, 0);
    assert.equal(h.handle.send('click').defaultPrevented, true);
    close(height(h.panel), expectedHeight);
  }
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
  h.handle.send('keydown', { key: 'ArrowUp' });
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

test('keyboard steps preserve the open sheet and Escape collapses from every size', () => {
  const h = harness();
  assert.equal(h.handle.send('keydown', { key: 'ArrowUp' }).defaultPrevented, true);
  close(height(h.panel), 688);
  h.handle.send('keydown', { key: 'ArrowDown' });
  close(height(h.panel), 438.88);
  h.handle.send('keydown', { key: 'ArrowDown' });
  close(height(h.panel), 32);
  h.handle.send('keydown', { key: 'ArrowUp' });
  close(height(h.panel), 438.88);
  assert.equal(h.handle.send('keydown', { key: 'Tab' }).defaultPrevented, false);
  for (const expanded of [false, true]) {
    h.controller.reveal(h.panel);
    if (expanded) h.handle.send('keydown', { key: 'ArrowUp' });
    h.handle.send('keydown', { key: 'Escape' });
    close(height(h.panel), 32);
    assert.equal(h.panel.classList.contains('open'), true);
  }
  assert.equal(h.entries[0].closes, 0);
});

test('viewport changes preserve the expanded preference and cancel a drag using stale bounds', () => {
  const h = harness();
  h.handle.send('keydown', { key: 'ArrowUp' });
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
  h.controller.refresh(); h.handle.send('keydown', { key: 'ArrowUp' });
  close(height(h.panel), 688);
});

test('switching sheets cancels a drag and retains each sheets own settled size', () => {
  const h = harness();
  h.handle.send('pointerdown'); h.handle.send('pointermove', { clientY: 150, timeStamp: 200 });
  h.open(1);
  assert.equal(h.handle.hasPointerCapture(1), false);
  assert.equal(h.panel.dataset.sheetDragging, undefined);
  close(height(h.entries[1].panel), 438.88);
  h.entries[1].handle.send('keydown', { key: 'ArrowUp' });
  h.open(0);
  close(height(h.panel), 438.88);
  h.controller.collapse(h.panel);
  h.open(1);
  close(height(h.entries[1].panel), 688);
  h.open(0);
  close(height(h.panel), 32);
  h.panel.classList.remove('open'); h.controller.refresh();
  h.open(0); close(height(h.panel), 32);
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
  handle.send('keydown', { key: 'ArrowUp' });
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
  handle.send('keydown', { key: 'ArrowUp' });
  close(height(panel), 648);
  safeTop = '84px'; controller.refresh();
  close(height(panel), 668);
  assert.equal(panel.dataset.sheetSize, 'expanded');
  safeTop = ''; controller.refresh();
  close(height(panel), 688);
  controller.destroy();
});


test('collapse moves focus out of content while reveal keeps the same returns screen', () => {
  const h = harness(), field = element(h.window);
  h.panel.dataset.screen = 'returns';
  h.content.append(field); field.focus();
  h.controller.collapse(h.panel);
  assert.equal(h.window.document.activeElement, h.handle);
  assert.equal(h.content.inert, true);
  assert.equal(h.panel.inert, false);
  assert.equal(h.panel.classList.contains('open'), true);
  assert.equal(h.panel.dataset.screen, 'returns');
  h.controller.refresh();
  close(height(h.panel), 32);
  h.controller.reveal(h.panel);
  close(height(h.panel), 438.88);
  assert.equal(h.content.inert, false);
  assert.equal(h.panel.dataset.screen, 'returns');
  h.handle.send('keydown', { key: 'ArrowUp' });
  h.controller.reveal(h.panel);
  close(height(h.panel), 688);
  assert.equal(h.entries[0].closes, 0);
});

test('collapse and reveal can choose a closed sheets next height without opening it', () => {
  const h = harness({ open: false });
  h.controller.collapse(h.panel);
  h.controller.refresh();
  assert.equal(h.panel.classList.contains('open'), false);
  assert.equal(h.handle.getAttribute('aria-expanded'), 'false');
  h.open();
  close(height(h.panel), 32);
  assert.equal(h.content.inert, true);
  h.panel.classList.remove('open'); h.controller.refresh();
  h.controller.reveal(h.panel);
  assert.equal(h.panel.classList.contains('open'), false);
  h.open(); close(height(h.panel), 438.88);
  assert.equal(h.content.inert, false);
  assert.equal(h.entries[0].closes, 0);
});

test('slow drag selects the nearest collapsed medium or expanded height', () => {
  for (const [delta, expected] of [[-120, 438.88], [-180, 688], [170, 438.88], [220, 32]] as const) {
    const h = harness();
    h.handle.send('pointerdown', { clientY: 400, timeStamp: 0 });
    h.handle.send('pointermove', { clientY: 400 + delta, timeStamp: 500 });
    h.handle.send('pointerup', { clientY: 400 + delta, timeStamp: 800 });
    close(height(h.panel), expected);
    assert.equal(h.panel.classList.contains('open'), true);
  }
});

test('desktop and destroy release collapsed content without allowing later API calls to repaint', () => {
  const h = harness();
  h.controller.collapse(h.panel);
  h.setPhone(false);
  assert.equal(h.content.inert, false);
  assert.equal(h.panel.style.getPropertyValue('--phone-sheet-height'), '');
  h.controller.collapse(h.panel); h.controller.reveal(h.panel);
  assert.equal(h.content.inert, false);
  assert.equal(h.panel.style.getPropertyValue('--phone-sheet-height'), '');
  h.setPhone(true); h.controller.collapse(h.panel);
  assert.equal(h.content.inert, true);
  h.controller.destroy();
  assert.equal(h.content.inert, false);
  h.controller.collapse(h.panel); h.controller.reveal(h.panel); h.controller.refresh();
  assert.equal(h.panel.style.getPropertyValue('--phone-sheet-height'), '');
});


test('reveal callback runs only when the folded sheet opens, including a touch flick', () => {
  for (const action of ['command', 'handle', 'flick'] as const) {
    let reveals = 0;
    const h = harness({ onReveal: () => { reveals++; } });
    flickHandle(h.handle, 1);
    assert.equal(h.panel.dataset.sheetSize, 'collapsed');
    assert.equal(reveals, 0, 'a downward swipe does not reveal content');
    if (action === 'command') h.controller.reveal(h.panel);
    else if (action === 'handle') {
      h.handle.send('pointerdown'); h.handle.send('pointerup'); h.handle.send('click');
    } else flickHandle(h.handle, -1);
    assert.equal(h.panel.dataset.sheetSize, 'medium', action);
    assert.equal(reveals, 1, action);
    h.controller.refresh(); h.controller.reveal(h.panel);
    h.handle.send('keydown', { key: 'ArrowUp' });
    assert.equal(h.panel.dataset.sheetSize, 'expanded');
    assert.equal(reveals, 1, 'refresh, repeated reveal and expansion do not repeat the callback');
    flickHandle(h.handle, 1); flickHandle(h.handle, 1);
    assert.equal(h.panel.dataset.sheetSize, 'collapsed');
    assert.equal(reveals, 1, 'downward swipes cannot trigger the action for revealed content');
    h.controller.reveal(h.panel);
    assert.equal(reveals, 2);
    assert.equal(h.entries[0].closes, 0);
  }
});


test('restored sheet modes paint before interaction and survive desktop presentation', () => {
  for (const mode of ['collapsed', 'medium', 'expanded'] as const) {
    const h = harness();
    h.controller.destroy();
    const panel = h.panel as unknown as HTMLElement, handle = h.handle as unknown as HTMLButtonElement, content = h.content as unknown as HTMLElement;
    let mobile = true;
    const controller = attachPhoneSheets({ sheets: [{ panel, handle, content,
      initialMode: mode, onClose() {} }], isPhone: () => mobile });
    assert.equal(h.panel.dataset.sheetSize, mode);
    mobile = false; controller.refresh();
    assert.equal(h.panel.dataset.sheetSize, undefined, 'desktop removes only mobile presentation');
    assert.equal(controller.getMode(panel), mode);
    mobile = true; controller.refresh();
    assert.equal(h.panel.dataset.sheetSize, mode);
    controller.destroy();
  }
});


test('only settling a new sheet mode publishes a change, never an intermediate drag or cancellation', () => {
  const h = harness(), changes: string[] = [];
  h.controller.destroy();
  const panel = h.panel as unknown as HTMLElement, handle = h.handle as unknown as HTMLButtonElement, content = h.content as unknown as HTMLElement;
  const controller = attachPhoneSheets({ sheets: [{ panel, handle, content,
    initialMode: 'collapsed', onClose() {}, onModeChange: mode => changes.push(mode) }], isPhone: () => true });
  h.handle.send('pointerdown', { clientY: 400, timeStamp: 0 });
  h.handle.send('pointermove', { clientY: 100, timeStamp: 500 });
  assert.deepEqual(changes, []);
  assert.equal(controller.getMode(panel), 'collapsed', 'drag pixels are not a settled state');
  h.handle.send('pointerup', { clientY: 100, timeStamp: 800 });
  assert.deepEqual(changes, ['medium']);
  h.handle.send('pointerdown', { clientY: 400, timeStamp: 900 });
  h.handle.send('pointermove', { clientY: 100, timeStamp: 1000 });
  h.handle.send('pointercancel', { timeStamp: 1100 });
  assert.deepEqual(changes, ['medium']);
  controller.refresh();
  assert.deepEqual(changes, ['medium']);
  controller.destroy();
});
