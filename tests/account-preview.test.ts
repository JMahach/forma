import test from 'node:test';
import assert from 'node:assert/strict';
import { readModuleSource } from './helpers/module-source.ts';
import { createStandConnection } from '../src/dev/control-colors.ts';
import type { StandConnection } from '../src/dev/control-colors.ts';
import { isDevelopmentPort } from '../shared/development.ts';

const source = readModuleSource(new URL('../src/dev/account-preview.ts', import.meta.url)).replace(/^import[^\n]*\n/gm, '');
class Element {
  dataset: Record<string, string> = {};
  children: Element[] = [];
  className = ''; textContent = ''; value = ''; disabled = false;
  private markup = '';
  private actions: Element[] = [];
  focused = false;
  focusOptions: FocusOptions | undefined;
  listeners = new Map<string, (event: { target: Element }) => void>();
  select: Element | null = null;
  get innerHTML() { return this.markup; }
  set innerHTML(markup: string) {
    this.markup = markup;
    // Model the actual action controls, not their position or styling. Each render
    // replaces these nodes just as assigning browser innerHTML does.
    this.actions = [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].flatMap(match => {
      const action = /data-account-action=["']([^"']+)["']/.exec(match[1])?.[1];
      if (!action) return [];
      const button = new Element();
      button.dataset.accountAction = action;
      button.textContent = match[2].replace(/<[^>]+>/g, '').trim();
      button.disabled = /\bdisabled(?:\s|=|$)/.test(match[1]);
      return [button];
    });
  }
  append(child: Element) { this.children.push(child); }
  prepend(child: Element) { this.children.unshift(child); }
  querySelector(selector: string) {
    return selector === 'select' ? this.select ||= new Element()
      : selector === '[data-account-action]' ? this.actions[0] ?? null : null;
  }
  querySelectorAll(selector: string) { return selector === '[data-account-action]' ? this.actions : []; }
  closest(selector: string) { return selector === '[data-account-action]' && this.dataset.accountAction ? this : null; }
  addEventListener(name: string, handler: (event: { target: Element }) => void) { this.listeners.set(name, handler); }
  focus(options?: FocusOptions) { this.focused = true; this.focusOptions = options; }
}
const storageKey = 'forma.account-preview.v1';
type Screen = 'linked' | 'unlinked' | 'guest' | 'expired' | 'error';
function harness(port: string, options: {
  values?: Map<string, string>;
  connection?: StandConnection;
  storageUnavailable?: boolean;
} = {}) {
  const page = new Element(), palettes = new Element(), head = new Element();
  const values = options.values ?? new Map<string, string>();
  const connection = createStandConnection();
  connection.set(options.connection ?? 'online');
  const document = { head, createElement: () => new Element(),
    getElementById: (id: string) => id === 'accountPage' ? page : id === 'controlColorPreviews' ? palettes : null };
  new Function('location', 'document', 'sessionStorage', 'standConnection', 'isDevelopmentPort', source)(
    { port }, document, {
      getItem: (key: string) => {
        if (options.storageUnavailable) throw new Error('Storage unavailable');
        return values.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (options.storageUnavailable) throw new Error('Storage unavailable');
        values.set(key, value);
      },
    }, connection, isDevelopmentPort);
  const content = () => page.children[0];
  const select = () => palettes.children[0].select!;
  const choose = (screen: Screen) => { select().value = screen; select().listeners.get('change')!({ target: select() }); };
  const action = (name: string) => content().querySelectorAll('[data-account-action]')
    .find(button => button.dataset.accountAction === name);
  const click = (name: string, force = false) => {
    const button = action(name);
    assert.ok(button, `Action ${name} is available on ${select().value}`);
    if (!button.disabled || force) content().listeners.get('click')!({ target: button });
  };
  return { page, palettes, head, values, connection, content, select, choose, action, click };
}
for (const port of ['3636', '36']) {
  test(`all five account states retain their content and actions on stand port ${port}`, () => {
    const h = harness(port);
    assert.equal(h.page.dataset.accountStudy, '');
    const expectations: { screen: Screen; text: RegExp[]; absent?: RegExp[]; actions: string[] }[] = [
      { screen: 'linked', text: [/anna@example\.com/, /Подтверждена/, /Telegram/, /@username/, /Привязан/, /Карты в аккаунте сохранятся/], actions: ['logout'] },
      { screen: 'unlinked', text: [/anna@example\.com/, /Подтверждена/, /Telegram/, /Не привязан/], absent: [/@username/], actions: ['logout'] },
      { screen: 'guest', text: [/Войдите, чтобы сохранять карты/, /других устройствах/], absent: [/anna@example\.com/, /@username/], actions: ['login'] },
      { screen: 'expired', text: [/Войдите снова/, /anna@example\.com/, /@username/], actions: ['login', 'logout'] },
      { screen: 'error', text: [/Не удалось загрузить аккаунт/, /role="status"/, /Повторить/], absent: [/anna@example\.com/], actions: ['retry'] },
    ];
    for (const expected of expectations) {
      h.choose(expected.screen);
      const html = h.content().innerHTML;
      for (const pattern of expected.text) assert.match(html, pattern, expected.screen);
      for (const pattern of expected.absent ?? []) assert.doesNotMatch(html, pattern, expected.screen);
      assert.deepEqual(h.content().querySelectorAll('[data-account-action]').map(button => button.dataset.accountAction), expected.actions);
      assert.ok(h.content().querySelectorAll('[data-account-action]').every(button => !button.disabled));
    }
  });
}

test('online login, relogin and retry return to linked state; every signed-in state can log out locally', () => {
  const h = harness('3636');
  for (const [screen, action] of [['guest', 'login'], ['expired', 'login'], ['error', 'retry']] as const) {
    h.choose(screen); h.click(action);
    assert.equal(h.select().value, 'linked');
    assert.match(h.content().innerHTML, /anna@example\.com/);
    assert.match(h.content().innerHTML, /@username/);
    assert.equal(JSON.parse(h.values.get(storageKey)!).screen, 'linked');
    assert.equal(h.action('logout')?.focused, true, 'the next real action receives focus after rerender');
    assert.deepEqual(h.action('logout')?.focusOptions, { preventScroll: true });
  }
  for (const screen of ['linked', 'unlinked', 'expired'] as const) {
    h.choose(screen); h.click('logout');
    assert.equal(h.select().value, 'guest');
    assert.equal(JSON.parse(h.values.get(storageKey)!).screen, 'guest');
    assert.ok(h.action('login')?.focused);
    assert.doesNotMatch(h.content().innerHTML, /anna@example\.com|@username/);
  }
});

test('chosen states and action results survive a new preview instance', () => {
  const values = new Map<string, string>();
  for (const screen of ['linked', 'unlinked', 'guest', 'expired', 'error'] as const) {
    const h = harness('3636', { values }); h.choose(screen);
    assert.equal(JSON.parse(values.get(storageKey)!).screen, screen);
    const restored = harness('36', { values });
    assert.equal(restored.select().value, screen);
    assert.equal(restored.content().innerHTML, h.content().innerHTML);
  }
  const h = harness('3636', { values }); h.choose('guest'); h.click('login');
  assert.equal(harness('36', { values }).select().value, 'linked');
  h.click('logout');
  assert.equal(harness('3636', { values }).select().value, 'guest');
});

test('invalid or unavailable session storage falls back safely without breaking actions', () => {
  for (const saved of ['not-json', 'null', '{}', '{"screen":"unknown"}']) {
    const h = harness('3636', { values: new Map([[storageKey, saved]]) });
    assert.equal(h.select().value, 'linked');
    h.choose('guest'); h.click('login');
    assert.equal(h.select().value, 'linked');
  }
  const h = harness('36', { storageUnavailable: true });
  assert.equal(h.select().value, 'linked');
  assert.doesNotThrow(() => { h.click('logout'); h.click('login'); });
  assert.equal(h.select().value, 'linked');
});

for (const mode of ['offline', 'server'] as const) {
  test(`${mode} cannot manufacture a login/retry success, but logout remains available`, () => {
    const h = harness('3636', { connection: mode });
    for (const [screen, action] of [['guest', 'login'], ['expired', 'login'], ['error', 'retry']] as const) {
      h.choose(screen);
      const html = h.content().innerHTML, button = h.action(action);
      assert.equal(button?.disabled, mode === 'offline');
      const saved = h.values.get(storageKey);
      // Force a delegated event too: the handler must guard state independently
      // of a disabled button's native suppression of clicks.
      h.click(action, true);
      assert.equal(h.select().value, screen);
      assert.equal(h.content().innerHTML, html);
      assert.equal(h.action(action), button, 'failed actions leave the displayed account state intact');
      assert.equal(h.values.get(storageKey), saved);
    }
    for (const screen of ['linked', 'unlinked', 'expired'] as const) {
      h.choose(screen);
      assert.equal(h.action('logout')?.disabled, false);
      h.click('logout');
      assert.equal(h.select().value, 'guest');
      assert.doesNotMatch(h.content().innerHTML, /anna@example\.com|@username/);
    }
  });
}

test('connection changes update existing controls without replacing account data, then online permits retry', () => {
  const h = harness('3636'); h.choose('expired');
  const html = h.content().innerHTML, login = h.action('login'), logout = h.action('logout');
  for (const mode of ['offline', 'server', 'online'] as const) {
    h.connection.set(mode);
    assert.equal(h.content().innerHTML, html);
    assert.equal(h.action('login'), login);
    assert.equal(h.action('logout'), logout);
    assert.equal(login?.disabled, mode === 'offline');
    assert.equal(logout?.disabled, false);
    assert.equal(h.select().value, 'expired');
  }
  h.click('login'); assert.equal(h.select().value, 'linked');
  h.choose('error'); h.connection.set('offline');
  assert.equal(h.action('retry')?.disabled, true);
  h.connection.set('online'); h.click('retry');
  assert.equal(h.select().value, 'linked');
});
for (const port of ['', '80', '443', '8080', '3637']) test(`account study stays absent on ordinary port ${port || 'default'}`, () => {
  const h = harness(port);
  assert.equal(h.page.dataset.accountStudy, undefined);
  assert.equal(h.page.children.length, 0);
  assert.equal(h.head.children.length, 0);
  assert.equal(h.palettes.children.length, 0);
  assert.equal(h.values.size, 0, 'ordinary-port loading does not write preview state');
});
