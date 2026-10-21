import test from 'node:test';
import assert from 'node:assert/strict';
import { attachLoadingPreview } from '../src/views/loading-preview.js';

const KEY = 'forma.loading-preview.v1';
function memory() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function harness(href = 'http://localhost:3636/', storage = memory()) {
  const attributes = new Map(), listeners = new Map(), events = [];
  const button = {
    hidden: true,
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); },
    addEventListener(name, callback) { listeners.set(name, callback); },
    click() { listeners.get('click')?.(); },
  };
  const location = { href, reload() { events.push(['reload', this.href]); } };
  const active = attachLoadingPreview({ button, location, getStorage: () => storage,
    beforeNavigate: () => events.push(['save']) });
  return { button, location, active, events, listeners, storage };
}

test('legacy preview URLs cannot enable the mode', () => {
  const href = 'http://localhost:3636/?preview=loading&fps=1&perf=1&controls=5&palette=graphite#map';
  const h = harness(href);
  assert.equal(h.active, false);
  assert.equal(h.button.hidden, false);
  assert.equal(h.button.getAttribute('aria-pressed'), 'false');
  assert.equal(h.storage.getItem(KEY), null);
  assert.equal(h.location.href, href);
});

test('the preview button saves the scene and reloads the unchanged address with tab-local mode enabled', () => {
  const h = harness('http://localhost:3636/?reference=one#map');
  h.button.click();
  assert.equal(h.storage.getItem(KEY), '1');
  assert.deepEqual(h.events, [['save'], ['reload', 'http://localhost:3636/?reference=one#map']]);
  const reloaded = harness(h.location.href, h.storage);
  assert.equal(reloaded.active, true);
  assert.equal(reloaded.button.getAttribute('aria-pressed'), 'true');
});

test('the same button exits preview over Wi-Fi without URL navigation flags', () => {
  const storage = memory(); storage.setItem(KEY, '1');
  const h = harness('http://192.168.1.124:3636/#map', storage);
  assert.equal(h.active, true);
  h.button.click();
  assert.equal(storage.getItem(KEY), null);
  assert.deepEqual(h.events, [['save'], ['reload', 'http://192.168.1.124:3636/#map']]);
  assert.equal(harness(h.location.href, storage).active, false);
});

test('an independently opened tab does not inherit preview mode from a URL', () => {
  const first = harness(); first.button.click();
  assert.equal(harness(first.location.href, first.storage).active, true);
  assert.equal(harness(first.location.href).active, false);
});

for (const href of ['https://forma.example/?preview=loading', 'http://localhost:8080/?preview=loading']) {
  test(`outside the stand the mode and button remain disabled even with remembered preview: ${href}`, () => {
    const storage = memory(); storage.setItem(KEY, '1');
    const h = harness(href, storage);
    assert.equal(h.active, false);
    assert.equal(h.button.hidden, true);
    h.button.click();
    assert.deepEqual(h.events, []);
    assert.equal(h.listeners.size, 0);
  });
}

test('unavailable tab storage does not reload into a mode that cannot be retained', () => {
  const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const h = harness(undefined, storage);
  assert.equal(h.active, false);
  assert.doesNotThrow(() => h.button.click());
  assert.equal(h.events.filter(([event]) => event === 'reload').length, 0);
  assert.equal(h.button.getAttribute('aria-pressed'), 'false');
});
