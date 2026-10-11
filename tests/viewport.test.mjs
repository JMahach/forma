import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewport } from '../src/ui/layout/viewport.js';

function surfaceEvents() {
  const target = new EventTarget(), listeners = new Map();
  const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target);
  target.addEventListener = (type, callback, options) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(callback); add(type, callback, options);
  };
  target.removeEventListener = (type, callback, options) => { listeners.get(type)?.delete(callback); remove(type, callback, options); };
  target.listenerCount = () => [...listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0);
  return target;
}
function dispatch(target, type, properties = {}) {
  const event = new Event(type);
  for (const [name, value] of Object.entries(properties)) Object.defineProperty(event, name, { value });
  target.dispatchEvent(event);
}
function harness({ visual = { offsetLeft: 0, offsetTop: 0, width: 390, height: 844, scale: 1 }, top = 0 } = {}) {
  const window = surfaceEvents(), document = surfaceEvents(), frames = new Map(), notifications = [];
  let frameId = 0;
  window.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
  window.cancelAnimationFrame = id => frames.delete(id);
  document.defaultView = window; document.activeElement = null;
  window.visualViewport = visual === null ? null : Object.assign(surfaceEvents(), visual);
  const rect = { left: 0, top, width: 390, height: 844 };
  const surface = { ownerDocument: document, getBoundingClientRect: () => rect };
  const viewport = createViewport({ surface, onChange: bounds => notifications.push(bounds) });
  const first = { tagName: 'INPUT', type: 'text' }, second = { tagName: 'INPUT', type: 'text' }, range = { tagName: 'INPUT', type: 'range' };
  function focus(next, related = next) {
    const previous = document.activeElement;
    document.activeElement = null;
    if (previous) dispatch(document, 'focusout', { target: previous, relatedTarget: related });
    document.activeElement = next;
    if (next) dispatch(document, 'focusin', { target: next, relatedTarget: previous });
  }
  function frame() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); }
  return { window, document, visual: window.visualViewport, rect, viewport, notifications, first, second, range, focus, frame, frames };
}

test('viewport reads fresh bounds and reports browser changes without publishing during construction', () => {
  const h = harness();
  assert.deepEqual(h.notifications, []);
  assert.deepEqual(h.viewport.read(), { left: 0, top: 0, width: 390, height: 844 });
  h.visual.offsetLeft = 20; h.visual.offsetTop = 40; h.visual.width = 300; h.visual.height = 500;
  for (const [target, type] of [[h.visual, 'resize'], [h.visual, 'scroll'], [h.window, 'resize'], [h.window, 'scroll']]) {
    const before = h.notifications.length;
    dispatch(target, type);
    assert.equal(h.notifications.length, before + 1, `${type} produces one completed viewport notification`);
    assert.deepEqual(h.notifications.at(-1), { left: 20, top: 40, width: 300, height: 500 });
  }
  h.viewport.refresh();
  assert.equal(h.notifications.length, 5, 'layout may move an anchor even with unchanged viewport bounds');
  h.viewport.destroy();
});

test('missing or invalid visual viewport uses surface geometry', () => {
  for (const visual of [null, { height: NaN, offsetTop: 0 }, { height: 0, offsetTop: 0 }, { height: 500, offsetTop: NaN }]) {
    const h = harness({ visual, top: -20 });
    assert.deepEqual(h.viewport.read(), { left: 0, top: -20, width: 390, height: 844 });
    h.rect.height = 700; h.viewport.refresh();
    assert.equal(h.notifications.at(-1).height, 700);
    h.viewport.destroy();
  }
});

test('Done restores full height and suppresses stale Safari events until native geometry catches up', () => {
  const h = harness(); h.focus(h.first);
  h.visual.height = 500; h.visual.offsetTop = 60; dispatch(h.visual, 'resize');
  assert.equal(h.notifications.at(-1).height, 500);
  h.focus(h.range); h.frame();
  assert.deepEqual(h.notifications.at(-1), { left: 0, top: 0, width: 390, height: 844 });
  h.visual.offsetTop = 344; dispatch(h.visual, 'scroll');
  h.visual.height = 600; h.visual.offsetTop = 40; dispatch(h.visual, 'resize');
  assert.deepEqual(h.notifications.at(-1), { left: 0, top: 0, width: 390, height: 844 });
  h.visual.height = 844; h.visual.offsetTop = 0; dispatch(h.visual, 'resize');
  h.visual.height = 700; dispatch(h.visual, 'resize');
  assert.equal(h.notifications.at(-1).height, 700, 'later browser chrome changes use native geometry again');
  h.viewport.destroy();
});

test('switching editors cancels pending dismissal and reopening uses the current keyboard height', () => {
  const h = harness(); h.focus(h.first); h.visual.height = 500; dispatch(h.visual, 'resize');
  h.focus(h.second); h.frame();
  assert.equal(h.notifications.at(-1).height, 500);
  h.focus(null); assert.equal(h.frames.size, 1);
  h.focus(h.first); assert.equal(h.frames.size, 0); h.frame();
  assert.equal(h.notifications.at(-1).height, 500);
  h.focus(h.range); h.frame(); assert.equal(h.notifications.at(-1).height, 844);
  h.focus(h.first); assert.equal(h.notifications.at(-1).height, 500);
  h.viewport.destroy();
});

test('page zoom retains horizontal geometry through dismissal and restores native panning after catch-up', () => {
  const h = harness({ visual: { offsetLeft: 40, offsetTop: 60, width: 260, height: 844 / 1.5, scale: 1.5 } });
  h.focus(h.first); h.visual.height = 300; dispatch(h.visual, 'resize');
  h.focus(h.range); h.frame();
  assert.deepEqual(h.notifications.at(-1), { left: 40, top: 0, width: 260, height: 844 });
  h.visual.height = (844 - .25) / 1.5; dispatch(h.visual, 'resize');
  h.visual.offsetTop = 100; h.visual.offsetLeft = 70; dispatch(h.visual, 'scroll');
  assert.deepEqual(h.notifications.at(-1), { left: 70, top: 100, width: 260, height: (844 - .25) / 1.5 });
  h.viewport.destroy();
});

test('destroy releases native listeners and cancels a pending focus frame', () => {
  const h = harness(); h.focus(h.first); h.focus(null);
  assert.equal(h.frames.size, 1);
  h.viewport.destroy();
  assert.equal(h.frames.size, 0);
  for (const target of [h.window, h.document, h.visual]) assert.equal(target.listenerCount(), 0);
  const count = h.notifications.length;
  h.frame(); h.viewport.refresh();
  dispatch(h.window, 'resize'); dispatch(h.visual, 'resize'); h.focus(h.first);
  assert.equal(h.notifications.length, count);
  h.viewport.destroy();
});
