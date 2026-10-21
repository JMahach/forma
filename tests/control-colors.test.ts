import { readModuleSource } from './helpers/module-source.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PALETTE } from '../src/ui/chart-palette.ts';

const code = readModuleSource(new URL('../src/dev/control-colors.ts', import.meta.url)).replace(/^import .*;\n/gm, '');
const KEY = 'forma.control-colors.v1';
function memory() {
  const values = new Map();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
}
function element() {
  const attrs = new Map(), listeners = new Map();
  return {
    children: [], dataset: {} as DOMStringMap, hidden: false,
    style: { setProperty(this: Record<string, unknown>, name: string, value: string) { this[name] = value; } } as unknown as CSSStyleDeclaration,
    setAttribute: (name, value) => attrs.set(name, String(value)), getAttribute: name => attrs.get(name),
    append(...children) { this.children.push(...children); }, prepend(child) { this.children.unshift(child); },
    addEventListener: (type, handler) => listeners.set(type, handler), click() { listeners.get('click')?.(); },
  };
}
function harness(href = 'http://localhost:3636/', storage = memory()) {
  const root = element(), footer = element(), head = element();
  const location = { href, port: new URL(href).port };
  const document = { documentElement: root, head, createElement: element,
    querySelector(selector: unknown) { assert.equal(selector, '.sidebar-footer'); return footer; } };
  new Function('PALETTE', 'location', 'document', 'sessionStorage', 'history', code)(PALETTE, location, document, storage,
    { replaceState() { assert.fail('palette buttons must never change the URL'); } });
  return { root, footer, head, location, storage, group: footer.children[0], toggle: footer.children[1] };
}

test('legacy palette URLs leave the row closed and the original button colours unchanged', () => {
  const href = 'http://localhost:3636/?controls=5&control=5&palette=graphite&preview=loading&fps=1&perf=1';
  const h = harness(href);
  assert.equal(h.group.hidden, true);
  assert.equal(h.toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(h.root.dataset.controlColors, undefined);
  assert.equal(h.storage.getItem(KEY), null);
  assert.equal(h.group.children.length, 4);
  for (const button of h.group.children) assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(h.location.href, href);
});

test('buttons open the row and select all twenty shades without changing the address', () => {
  const h = harness('http://localhost:3636/#map'), fills = new Set();
  h.toggle.click(); assert.equal(h.group.hidden, false);
  assert.equal(h.root.dataset.controlColors, undefined, 'opening the row does not choose a shade');
  for (const button of h.group.children) {
    for (let index = 1; index <= 5; index++) {
      button.click();
      assert.equal(button.children[0].textContent, `${index}/5`);
      assert.equal(button.getAttribute('aria-pressed'), 'true');
      fills.add(h.root.style['--preview-fill']);
    }
    button.click(); assert.equal(button.children[0].textContent, '1/5');
  }
  assert.equal(fills.size, 20);
  assert.equal(h.location.href, 'http://localhost:3636/#map');
  const selected = h.root.style['--preview-fill'];
  h.toggle.click();
  assert.equal(h.group.hidden, true);
  assert.equal(h.root.style['--preview-fill'], selected, 'collapsing the row preserves its selection');
});

test('a button-selected shade survives preview reloads through tab storage and ignores legacy URL preferences', () => {
  const h = harness();
  h.toggle.click(); const gold = h.group.children[2];
  gold.click(); gold.click(); gold.click();
  assert.deepEqual(JSON.parse(h.storage.getItem(KEY)), { family: 'gold', index: 2 });
  const restored = harness('http://localhost:3636/?controls=5&palette=graphite', h.storage);
  assert.equal(restored.group.hidden, false);
  assert.equal(restored.group.children[2].getAttribute('aria-pressed'), 'true');
  assert.equal(restored.group.children[2].children[0].textContent, '3/5');
  assert.equal(restored.root.style['--preview-fill'], h.root.style['--preview-fill']);
  assert.equal(harness().root.dataset.controlColors, undefined, 'an independent tab starts with the regular style');
});

test('unavailable tab storage still permits palette choices within the current page', () => {
  const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const h = harness(undefined, storage);
  h.toggle.click();
  assert.doesNotThrow(() => h.group.children[0].click());
  assert.equal(h.root.dataset.controlColors, '1');
});

test('damaged remembered selections do not replace the default style', () => {
  for (const value of ['not json', '{"family":"gold","index":10}', '{"family":"unknown","index":0}'] as const) {
    const storage = memory(); storage.setItem(KEY, value);
    const h = harness(undefined, storage);
    assert.equal(h.root.dataset.controlColors, undefined);
    assert.equal(h.group.hidden, true);
  }
});

test('palettes are absent outside the stand', () => {
  const h = harness('https://forma.example/?controls=5&palette=graphite');
  assert.equal(h.footer.children.length, 0);
  assert.equal(h.head.children.length, 0);
});
