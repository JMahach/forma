import { readModuleSource } from './helpers/module-source.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartHighlight } from '../src/state/chart-highlight.ts';
import { PALETTE } from '../src/ui/chart-palette.ts';
const code = readModuleSource(new URL('../src/preview/control-colors.ts', import.meta.url)).replace(/^import[^\n]*\n/gm, '');
const KEY = 'forma.control-colors.v1', HIGHLIGHT = 'forma.chart-highlight.v1';
function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
}
class TestElement {
  children: TestElement[] = [];
  parentElement: TestElement | null = null;
  dataset: DOMStringMap = {};
  hidden = false;
  className = ''; id = ''; type = ''; textContent = '';
  attributes = new Map<string, string>();
  listeners = new Map<string, (event: { target: TestElement }) => void>();
  style = { values: new Map<string, string>(), setProperty(name: string, value: string) { this.values.set(name, value); } };
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  append(...children: TestElement[]) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  prepend(child: TestElement) { child.parentElement = this; this.children.unshift(child); }
  insertBefore(child: TestElement, before: TestElement | null) { if (!before) this.append(child); else { child.parentElement = this; this.children.splice(this.children.indexOf(before), 0, child); } }
  querySelector(selector: string): TestElement | null { return this.children.find(child => `#${child.id}` === selector || `.${child.className}` === selector) ?? null; }
  addEventListener(type: string, handler: (event: { target: TestElement }) => void) { this.listeners.set(type, handler); }
  click() { for (let node: TestElement | null = this; node; node = node.parentElement) node.listeners.get('click')?.({ target: this }); }
  closest(selector: string): TestElement | null {
    assert.equal(selector, 'button[data-connection]');
    return this.dataset.connection ? this : this.parentElement?.closest(selector) ?? null;
  }
  set innerHTML(value: string) {
    const thumb = new TestElement(); thumb.className = 'chart-highlight-thumb'; this.children = [thumb];
  }
  querySelectorAll(selector: string) {
    assert.equal(selector, 'button');
    return this.children.filter(child => child.dataset.connection);
  }
}
function harness(href = 'http://localhost:3636/', storage = memory()) {
  const footer = new TestElement(), head = new TestElement(), highlight = createChartHighlight();
  const document = {head, createElement: () => new TestElement(),
    querySelector(selector: string) { assert.equal(selector, '.sidebar-footer'); return footer; }};
  new Function('document', 'sessionStorage', 'chartHighlight', 'PALETTE', 'location', code)(document, storage, highlight, PALETTE, {href});
  const group = footer.children[0], toggle = footer.children[1], button = group.children[0].children[0];
  return {footer, head, highlight, storage, group, toggle, button};
}
for (const href of ['http://localhost:3636/', 'http://forma-7b2.localhost:3638/', 'http://192.168.1.116:36/', 'https://forma.example/']) {
  test(`one palette control defaults to variant 1 and preserves explicit selection on ${href}`, () => {
    const h = harness(href);
    assert.equal(h.toggle.textContent, 'Палитры');
    assert.equal(h.group.hidden, true);
    assert.equal(h.group.children.length, 1); assert.equal(h.group.children[0].children.length, 1);
    assert.equal(h.highlight.current, 'glow'); assert.equal(h.button.getAttribute('aria-checked'), 'false');
    assert.equal(h.button.children[0].textContent, '1');
    assert.equal(h.storage.getItem(HIGHLIGHT), null, 'default is not an explicit selection');
    h.toggle.click(); h.button.click();
    assert.equal(h.highlight.current, 'outline'); assert.equal(h.button.children[0].textContent, '2');
    const restored = harness(href, h.storage);
    assert.equal(restored.group.hidden, false); assert.equal(restored.highlight.current, 'outline');
    restored.button.click(); restored.toggle.click();
    const closed = harness(href, restored.storage);
    assert.equal(closed.group.hidden, true); assert.equal(closed.highlight.current, 'glow');
  });
}
test('old simulation values and query flags cannot enter the application through Palettes', () => {
  const storage = memory();
  storage.setItem(KEY, JSON.stringify({expanded: true, connection: 'offline', calculation: 'waiting'}));
  storage.setItem('forma.account-preview.v1', JSON.stringify({enabled: true, screen: 'linked'}));
  const h = harness('https://forma.example/?connection=server&preview=loading', storage);
  assert.equal(h.group.hidden, false); assert.equal(h.highlight.current, 'glow');
  assert.deepEqual(JSON.parse(storage.getItem(KEY)!), {expanded: true});
  assert.equal(h.group.children.length, 1);
});
test('missing, invalid and blocked storage retain usable controls and variant 1', () => {
  for (const value of ['not json', '{"connection":"server"}', 'null']) {
    const storage = memory(); storage.setItem(KEY, value); storage.setItem(HIGHLIGHT, 'invalid');
    assert.equal(harness(undefined, storage).highlight.current, 'glow');
  }
  const h = harness(undefined, {getItem() {throw Error('denied');}, setItem() {throw Error('denied');}});
  assert.doesNotThrow(() => { h.toggle.click(); h.button.click(); });
  assert.equal(h.group.hidden, false); assert.equal(h.highlight.current, 'outline');
});
