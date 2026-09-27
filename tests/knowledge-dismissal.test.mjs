import test from 'node:test';
import assert from 'node:assert/strict';
import { attachKnowledge } from '../src/views/knowledge.js';

// Minimal DOM surface for the real knowledge module. Fixtures never bootstrap
// the app or access browser storage, saved charts, timers, or the network.
function knowledgeHarness(rect = { left: 100, top: 80, right: 700, bottom: 680 }) {
  const handlers = new Map();
  const node = (attributes = {}, dataset = {}, isButton = false) => ({
    dataset, innerHTML: '', scrollTop: 0,
    setAttribute(name, value) { attributes[name] = String(value); },
    hasAttribute(name) { return Object.hasOwn(attributes, name); },
    closest(selector) { return selector === 'button' && isButton ? this : null; },
    querySelector() { return null; },
  });
  const index = node(), article = node();
  const categories = ['gate', 'center', 'channel'].map(value => node({}, { knowledgeCategory: value }, true));
  const selected = [];
  let closes = 0;
  const dialog = {
    ...node(), open: false,
    querySelector(selector) { return selector === '#knowledgeIndex' ? index : selector === '#knowledgeArticle' ? article : null; },
    querySelectorAll(selector) { return selector === '[data-knowledge-category]' ? categories : []; },
    getBoundingClientRect() { return { ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top }; },
    addEventListener(type, callback) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(callback);
    },
    showModal() { this.open = true; },
    close() {
      if (!this.open) return;
      this.open = false; closes++;
      dispatch('close');
    },
  };
  function dispatch(type, options = {}) {
    const event = {
      target: dialog, clientX: 0, clientY: 0, button: 0, pointerId: 1,
      defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...options,
    };
    for (const callback of handlers.get(type) || []) callback(event);
    return event;
  }
  const controller = attachKnowledge(dialog, value => selected.push(value));
  controller.show();
  return { dialog, controller, dispatch, selected, node, index, article, get closes() { return closes; } };
}

test('a tap that starts and ends on the knowledge backdrop dismisses the dialog on every side', () => {
  for (const rect of [
    { left: 100, top: 80, right: 700, bottom: 680 },
    { left: 12, top: 60, right: 378, bottom: 800 },
  ]) {
    const middleX = (rect.left + rect.right) / 2, middleY = (rect.top + rect.bottom) / 2;
    for (const [clientX, clientY] of [
      [rect.left - 1, middleY], [rect.right + 1, middleY],
      [middleX, rect.top - 1], [middleX, rect.bottom + 1],
    ]) {
      const harness = knowledgeHarness(rect);
      harness.dispatch('pointerdown', { clientX, clientY });
      const click = harness.dispatch('click', { clientX, clientY });
      assert.equal(harness.dialog.open, false, `outside tap at ${clientX},${clientY} closes the dialog`);
      assert.equal(harness.closes, 1);
      assert.deepEqual(harness.selected, [], 'dismissal does not select or change a chart element');
      assert.equal(click.defaultPrevented, true);
      assert.equal(click.propagationStopped, true, 'backdrop clicks do not reach the graph behind the dialog');
    }
  }
});

test('blank space and edges inside the knowledge dialog are not a backdrop click', () => {
  const harness = knowledgeHarness();
  for (const [clientX, clientY] of [[300, 200], [100, 300], [700, 300], [300, 80], [300, 680]]) {
    harness.dispatch('pointerdown', { clientX, clientY });
    harness.dispatch('click', { clientX, clientY });
    assert.equal(harness.dialog.open, true, `inside point ${clientX},${clientY} does not dismiss`);
  }
  const content = harness.node();
  harness.dispatch('pointerdown', { target: content, clientX: 300, clientY: 200 });
  harness.dispatch('click', { target: content, clientX: 300, clientY: 200 });
  assert.equal(harness.closes, 0, 'article whitespace stays open too');
});

test('dragging into or out of the dialog, or cancelling a pointer, never dismisses the library', () => {
  const harness = knowledgeHarness();
  const inside = { clientX: 300, clientY: 200 }, outside = { clientX: 40, clientY: 200 };
  harness.dispatch('pointerdown', inside);
  harness.dispatch('click', outside);
  assert.equal(harness.dialog.open, true, 'inside-to-backdrop drag preserves the dialog');
  harness.dispatch('pointerdown', outside);
  harness.dispatch('click', inside);
  assert.equal(harness.dialog.open, true, 'backdrop-to-inside drag preserves the dialog');
  harness.dispatch('pointerdown', outside);
  harness.dispatch('pointercancel', outside);
  harness.dispatch('click', outside);
  assert.equal(harness.dialog.open, true, 'a cancelled touch cannot dismiss on a later click');
  assert.equal(harness.closes, 0);
});

test('outside pointer state cannot leak through a close/reopen cycle or a click without pointerdown', () => {
  const harness = knowledgeHarness(), outside = { clientX: 40, clientY: 200 };
  harness.dispatch('click', outside);
  assert.equal(harness.dialog.open, true, 'click alone does not reuse an uninitialised outside press');
  harness.dispatch('pointerdown', outside);
  harness.dialog.close();
  harness.controller.show();
  harness.dispatch('click', outside);
  assert.equal(harness.dialog.open, true, 'reopened dialog does not inherit a prior outside press');
  assert.equal(harness.closes, 1, 'only the explicit close happened');
});

test('secondary-button presses outside the dialog do not dismiss it', () => {
  const harness = knowledgeHarness();
  harness.dispatch('pointerdown', { clientX: 40, clientY: 200, button: 2 });
  harness.dispatch('click', { clientX: 40, clientY: 200, button: 2 });
  assert.equal(harness.dialog.open, true);
});

test('explicit close and show-on-chart buttons still work after backdrop dismissal is added', () => {
  const harness = knowledgeHarness();
  const close = harness.node({ 'data-close-knowledge': '' }, {}, true);
  harness.dispatch('click', { target: close, clientX: 600, clientY: 100 });
  assert.equal(harness.dialog.open, false);
  harness.controller.show({ type: 'gate', id: 10 });
  const show = harness.node({ 'data-show-topic': '' }, {}, true);
  harness.dispatch('click', { target: show, clientX: 500, clientY: 200 });
  assert.equal(harness.dialog.open, false);
  assert.deepEqual(harness.selected, [{ type: 'gate', id: 10 }]);
});
