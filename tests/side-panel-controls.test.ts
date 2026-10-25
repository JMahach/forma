import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelState } from '../src/state/panels.ts';
import { attachPanelKeyboard } from '../src/views/side-panel-controls.ts';

function harness() {
  const target = new EventTarget(), panels = createPanelState();
  const hidden = new Set<string>();
  let focused = '', dialog = false;
  const document = {
    defaultView: target,
    querySelector: () => dialog ? {} : null,
    getElementById: (id: string) => ({
      classList: { contains: () => !hidden.has(id) && (id === 'library' ? panels.left : panels.right) },
      focus: () => { focused = id; },
    }),
  };
  attachPanelKeyboard(document as unknown as Document, panels);
  function escape({ handled = false, composing = false } = {}) {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape', isComposing: composing });
    if (handled) event.preventDefault();
    target.dispatchEvent(event); return event;
  }
  return { panels, escape, hidden, focused: () => focused, setDialog: (value: boolean) => { dialog = value; } };
}

test('one Escape closes only the left visible panel; the next closes the right and restores each trigger', () => {
  const h = harness(); h.panels.restore({ left: true, right: true });
  assert.equal(h.escape().defaultPrevented, true);
  assert.deepEqual(h.panels.snapshot, { left: false, right: true });
  assert.equal(h.focused(), 'openLibrary');
  assert.equal(h.escape().defaultPrevented, true);
  assert.deepEqual(h.panels.snapshot, { left: false, right: false });
  assert.equal(h.focused(), 'summarySwitch');
  assert.equal(h.escape().defaultPrevented, false);
});

test('nested menus, an open dialog and text composition keep Escape away from side panels', () => {
  const h = harness(); h.panels.setLeft(true);
  h.escape({ handled: true }); assert.equal(h.panels.left, true);
  h.escape({ composing: true }); assert.equal(h.panels.left, true);
  h.setDialog(true); h.escape(); assert.equal(h.panels.left, true);
  assert.equal(h.focused(), '');
  h.setDialog(false); h.escape(); assert.equal(h.panels.left, false);
});

test('Escape outside the chart does not erase the retained right-panel state', () => {
  const h = harness(); h.panels.setRight(true); h.hidden.add('chartSummary');
  assert.equal(h.escape().defaultPrevented, false);
  assert.equal(h.panels.right, true);
  h.hidden.delete('chartSummary'); h.escape(); assert.equal(h.panels.right, false);
});
