import test from 'node:test';
import assert from 'node:assert/strict';
import { attachKnowledgeEntry } from '../src/views/knowledge-entry.ts';

function element() {
  const listeners = new Map(), attributes = new Map();
  return {
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatch(type: string, event = {}) { return listeners.get(type)?.(event); },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    hasAttribute(name: string) { return attributes.has(name); },
  };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function harness({ navigate = true, initialView = undefined } = {}) {
  const button = element(), dialog = { hidden: true }, requests: { promise: Promise<unknown>; resolve: undefined; reject: undefined; }[] = [], shown = [], errors: string[] = [];
  let attached = 0, opened = 0, current = !navigate, selection = { type: 'gate' as const, id: 37 };
  const module = { attachKnowledge(received: unknown, _onSelect: unknown, options: { initialView?: unknown } = {}) {
    assert.equal(received, dialog); attached++;
    return {
      snapshot: options.initialView,
      show(value) { dialog.hidden = false; shown.push(value); },
      hide() { dialog.hidden = true; },
    };
  } };
  const controller = attachKnowledgeEntry({ button, dialog, initialView, onSelect() {},
    getSelection: () => selection, onOpen: navigate ? () => { current = true; opened++; return controller.show(); } : undefined, isCurrent: () => current,
    onError: message => errors.push(message),
    load() { assert.equal(current, true, 'navigation happens before loading'); const request = deferred(); requests.push(request); return request.promise; } });
  return { button, dialog, requests, shown, errors, module, controller,
    setSelection(value: { type: string; id: string|number; }) { selection = value; }, setCurrent(value: boolean) { current = value; },
    get attached() { return attached; }, get opened() { return opened; } };
}

test('the library entry navigates before loading, shares the import and reuses the attached page', async () => {
  const h = harness();
  assert.equal(h.requests.length, 0);
  const first = h.button.dispatch('click'); await drain();
  assert.equal(h.opened, 1);
  assert.equal(h.button.hasAttribute('aria-busy'), true);
  h.setSelection({ type: 'gate' as const, id: 10 });
  const repeated = h.button.dispatch('click'); await drain();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve!(h.module);
  assert.deepEqual(await Promise.all([first, repeated]), [false, true]);
  assert.equal(h.attached, 1);
  assert.equal(h.dialog.hidden, false);
  assert.deepEqual(h.shown, [{ type: 'gate' as const, id: 10 }]);
  assert.equal(h.button.hasAttribute('aria-busy'), false);
  h.controller.hide();
  assert.equal(h.dialog.hidden, true);
  h.setSelection({ type: 'center' as const, id: 'root' }); await h.button.dispatch('click');
  assert.equal(h.requests.length, 1); assert.equal(h.attached, 1);
  assert.deepEqual(h.shown.at(-1), { type: 'center' as const, id: 'root' });
  assert.equal(h.shown.length, 2, 'one view update per navigation, including after the module is loaded');
});

test('hiding a pending library prevents late completion from reopening it and keeps the module reusable', async () => {
  const h = harness(); const first = h.button.dispatch('click'); await drain();
  h.controller.hide();
  assert.equal(h.dialog.hidden, true);
  assert.equal(h.button.hasAttribute('aria-busy'), false);
  h.requests[0].resolve!(h.module); assert.equal(await first, false);
  assert.deepEqual(h.shown, []); assert.equal(h.attached, 1);
  assert.equal(await h.button.dispatch('click'), true);
  assert.equal(h.requests.length, 1); assert.equal(h.shown.length, 1);
});

test('a changed workspace also prevents a pending import from opening the library', async () => {
  const h = harness(); const first = h.button.dispatch('click'); await drain();
  h.setCurrent(false);
  h.requests[0].resolve!(h.module); assert.equal(await first, false);
  assert.deepEqual(h.shown, []);
  assert.equal(h.dialog.hidden, true);
  assert.equal(await h.controller.show(), false, 'show does not navigate back from another screen');
  assert.equal(h.opened, 1);
});

test('reopening before an abandoned import finishes opens exactly once with the latest topic', async () => {
  const h = harness(); const first = h.button.dispatch('click'); await drain();
  h.controller.hide();
  h.setSelection({ type: 'channel' as const, id: '37-40' });
  const reopened = h.button.dispatch('click'); await drain();
  h.requests[0].resolve!(h.module);
  assert.deepEqual(await Promise.all([first, reopened]), [false, true]);
  assert.equal(h.requests.length, 1); assert.equal(h.attached, 1);
  assert.deepEqual(h.shown, [{ type: 'channel' as const, id: '37-40' }]);
});

test('restoring the library can show it without requesting navigation again', async () => {
  const h = harness();
  assert.equal(await h.controller.show(), false);
  assert.equal(h.requests.length, 0);
  h.setCurrent(true);
  const restored = h.controller.show(); await drain();
  h.requests[0].resolve!(h.module); assert.equal(await restored, true);
  assert.equal(h.opened, 0);
  assert.equal(h.dialog.hidden, false);
});

test('a failed import can retry and failures after leaving the library stay silent', async () => {
  for (const abandoned of ['none', 'hide', 'navigation'] as const) {
    const h = harness(); const first = h.button.dispatch('click'); await drain();
    if (abandoned === 'hide') h.controller.hide();
    if (abandoned === 'navigation') h.setCurrent(false);
    h.requests[0].reject!(new Error('Offline')); assert.equal(await first, false);
    assert.equal(h.button.hasAttribute('aria-busy'), false);
    assert.equal(h.errors.length, abandoned === 'none' ? 1 : 0); assert.equal(h.attached, 0);
    const retry = h.button.dispatch('click'); await drain();
    assert.equal(h.requests.length, 2); h.requests[1].resolve!(h.module);
    assert.equal(await retry, true); assert.equal(h.shown.length, 1); assert.equal(h.attached, 1);
  }
});


test('without a navigation callback, the entry button opens the library directly', async () => {
  const h = harness({ navigate: false });
  const opened = h.button.dispatch('click'); await drain();
  h.requests[0].resolve!(h.module);
  assert.equal(await opened, true);
  assert.equal(h.shown.length, 1);
  assert.equal(h.dialog.hidden, false);
});

test('an explicit navigation callback alone decides when the library is shown', async () => {
  const button = element(), dialog = { hidden: true };
  let opened = 0, loaded = 0;
  attachKnowledgeEntry({ button, dialog, onSelect() {}, getSelection() {},
    onOpen() { opened++; }, isCurrent: () => true,
    load() { loaded++; throw new Error('Navigation has not shown the page'); } });
  button.dispatch('click'); await drain();
  assert.equal(opened, 1);
  assert.equal(loaded, 0);
  assert.equal(dialog.hidden, true);
});


test('a lazy library retains the saved snapshot before loading and through a late hidden import', async () => {
  const initialView = { query: 'красное', searchOpen: true, collection: 'gates', entryId: 'concept.personality-design', view: 'article' };
  const h = harness({ initialView });
  assert.deepEqual(h.controller.snapshot, initialView);
  const opening = h.button.dispatch('click'); await drain();
  h.controller.hide();
  h.requests[0].resolve!(h.module); assert.equal(await opening, false);
  assert.deepEqual(h.controller.snapshot, initialView, 'loaded view receives exactly the saved reading intent');
  assert.equal(h.dialog.hidden, true);
});
