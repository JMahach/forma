import { readModuleSource } from './helpers/module-source.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStandConnection } from '../src/dev/control-colors.ts';
import type { StandConnection } from '../src/dev/control-colors.ts';
import { isDevelopmentPort } from '../shared/development.ts';

const code = readModuleSource(new URL('../src/dev/control-colors.ts', import.meta.url)).replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '');
const KEY = 'forma.control-colors.v1';
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
  querySelector(selector: string): TestElement | null { return this.children.find(child => `#${child.id}` === selector) ?? null; }
  addEventListener(type: string, handler: (event: { target: TestElement }) => void) { this.listeners.set(type, handler); }
  click() { for (let node: TestElement | null = this; node; node = node.parentElement) node.listeners.get('click')?.({ target: this }); }
  closest(selector: string): TestElement | null {
    assert.equal(selector, 'button[data-connection]');
    return this.dataset.connection ? this : this.parentElement?.closest(selector) ?? null;
  }
  set innerHTML(value: string) {
    this.children = [];
    for (const match of value.matchAll(/<button\b[^>]*data-connection="([^"]+)"[^>]*>([^<]+)<\/button>/g)) {
      const button = new TestElement();
      button.dataset.connection = match[1]; button.textContent = match[2]; this.append(button);
    }
  }
  querySelectorAll(selector: string) {
    assert.equal(selector, 'button');
    return this.children.filter(child => child.dataset.connection);
  }
}
function harness(href = 'http://localhost:3636/', storage = memory()) {
  const root = new TestElement(), footer = new TestElement(), head = new TestElement();
  const location = { href, port: new URL(href).port };
  const document = { documentElement: root, head, createElement: () => new TestElement(),
    querySelector(selector: string) { assert.equal(selector, '.sidebar-footer'); return footer; } };
  const connection = new Function('location', 'document', 'sessionStorage', 'isDevelopmentPort', `${code}\nreturn standConnection;`)(location, document, storage, isDevelopmentPort) as ReturnType<typeof createStandConnection>;
  const group = footer.children[0], toggle = footer.children[1], options = group?.children[0];
  return { root, footer, head, location, storage, connection, group, toggle, options, buttons: options?.children };
}

function assertSelected(h: ReturnType<typeof harness>, mode: StandConnection) {
  assert.equal(h.connection.current, mode);
  assert.equal(h.root.dataset.standConnection, mode);
  for (const button of h.buttons) assert.equal(button.getAttribute('aria-pressed'), String(button.dataset.connection === mode));
}

test('connection owner sends its current state immediately, ignores repeats and releases subscribers', () => {
  const connection = createStandConnection(), first: StandConnection[] = [], second: StandConnection[] = [];
  const unsubscribe = connection.subscribe(mode => first.push(mode));
  connection.set('offline'); connection.set('offline');
  connection.subscribe(mode => second.push(mode));
  connection.set('server'); unsubscribe(); connection.set('online');
  assert.deepEqual(first, ['online', 'offline', 'server']);
  assert.deepEqual(second, ['offline', 'server', 'online']);
  assert.equal(connection.current, 'online');
});

test('legacy palette URLs leave the row closed without restoring retired colour trials', () => {
  const href = 'http://localhost:3636/?controls=5&control=5&palette=graphite&preview=loading&fps=1&perf=1';
  const h = harness(href);
  assert.equal(h.group.hidden, true);
  assert.equal(h.toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(h.root.dataset.controlColors, undefined);
  assert.equal(h.root.style.values.size, 0);
  assert.deepEqual(h.buttons.map(button => [button.dataset.connection, button.textContent]), [
    ['online', 'Всё ок'], ['offline', 'Нет сети'], ['server', 'Сервер не отвечает'],
  ]);
  assert.equal(h.options.getAttribute('role'), 'group');
  assert.equal(h.options.getAttribute('aria-label'), 'Соединение');
  assertSelected(h, 'online');
  assert.equal(h.location.href, href);
});

test('buttons select all three connection modes without changing the address or retaining the mode', () => {
  const h = harness('http://localhost:3636/#map');
  h.toggle.click(); assert.equal(h.group.hidden, false);
  for (const mode of ['offline', 'server', 'online'] as const) {
    h.buttons.find(button => button.dataset.connection === mode)!.click();
    assertSelected(h, mode);
    assert.deepEqual(JSON.parse(h.storage.getItem(KEY)!), { expanded: true });
  }
  assert.equal(h.location.href, 'http://localhost:3636/#map');
  h.connection.set('server'); h.toggle.click();
  assert.equal(h.group.hidden, true);
  assertSelected(h, 'server');
});

test('the same connection owner updates the visible buttons for commands from another preview', () => {
  const h = harness(), received: StandConnection[] = [];
  h.connection.subscribe(mode => received.push(mode));
  h.connection.set('offline'); assertSelected(h, 'offline');
  h.buttons.find(button => button.dataset.connection === 'server')!.click();
  assert.deepEqual(received, ['online', 'offline', 'server']);
  assertSelected(h, 'server');
});

test('reload keeps only legacy expansion and resets connection to online', () => {
  const storage = memory();
  storage.setItem(KEY, JSON.stringify({ family: 'gold', index: 2, expanded: true, screen: 'library' }));
  const h = harness(undefined, storage);
  assert.equal(h.group.hidden, false);
  assert.equal(h.root.dataset.controlColors, undefined);
  assert.deepEqual(JSON.parse(storage.getItem(KEY)!), { expanded: true });
  h.connection.set('offline');
  const restored = harness(undefined, storage);
  assert.equal(restored.group.hidden, false);
  assertSelected(restored, 'online');
  assertSelected(h, 'offline');
});

test('unavailable tab storage still permits opening and changing the connection mode', () => {
  const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const h = harness(undefined, storage);
  assert.doesNotThrow(() => { h.toggle.click(); h.buttons[1].click(); });
  assert.equal(h.group.hidden, false);
  assertSelected(h, 'offline');
});

test('damaged remembered selections leave a closed row with the regular online state', () => {
  for (const value of ['not json', '{"family":"gold","index":10}', '{"family":"unknown","index":0}']) {
    const storage = memory(); storage.setItem(KEY, value);
    const h = harness(undefined, storage);
    assert.equal(h.root.dataset.controlColors, undefined);
    assert.equal(h.group.hidden, true);
    assertSelected(h, 'online');
    assert.deepEqual(JSON.parse(storage.getItem(KEY)!), { expanded: false });
  }
});

test('connection controls and styles are absent outside the stand', () => {
  for (const href of ['https://forma.example/?controls=5&palette=graphite', 'http://localhost:3637/']) {
    const h = harness(href);
    assert.equal(h.footer.children.length, 0);
    assert.equal(h.head.children.length, 0);
    assert.equal(h.root.dataset.standConnection, undefined);
    assert.equal(h.storage.getItem(KEY), null);
  }
});

test('port 36 mounts Palettes and its working connection controls over the LAN', () => {
  const h = harness('http://192.168.1.116:36/');
  assert.equal(h.toggle?.textContent, 'Палитры');
  h.toggle.click();
  assert.equal(h.group.hidden, false);
  h.buttons[1].click();
  assertSelected(h, 'offline');
});

test('row expansion survives reloads independently of the connection mode', () => {
  for (const mode of ['online', 'offline', 'server'] as const) {
    const h = harness(); h.toggle.click(); h.connection.set(mode);
    const opened = harness(undefined, h.storage);
    assert.equal(opened.group.hidden, false);
    assert.equal(opened.toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(opened.toggle.getAttribute('aria-pressed'), 'true');
    assertSelected(opened, 'online');
    opened.toggle.click();
    const closed = harness(undefined, h.storage);
    assert.equal(closed.group.hidden, true);
    assert.equal(closed.toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(closed.toggle.getAttribute('aria-pressed'), 'false');
  }
});
