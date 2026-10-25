import test from 'node:test';
import assert from 'node:assert/strict';
import { attachWorkspaceHeader } from '../src/views/workspace-header.ts';
import { SVG_NS, svgDocument } from './helpers/svg-dom.ts';

function fixture(inputId = 'knowledgeSearch') {
  const document = svgDocument();
  const create = document.createElementNS.bind(document);
  type Node = ReturnType<typeof create>;
  const listeners = new Map<Node, Map<string, EventListener[]>>();
  let active: Node | null = null;
  let focusOptions: FocusOptions | undefined;
  document.createElementNS = (namespace, name) => {
    const node = create(namespace, name);
    listeners.set(node, new Map());
    node.addEventListener = (type: string, listener: unknown) => {
      const events = listeners.get(node)!;
      events.set(type, [...(events.get(type) ?? []), listener as EventListener]);
    };
    node.focus = (options?: FocusOptions) => { active = node; focusOptions = options; };
    return node;
  };
  const element = (name: string) => document.createElementNS(SVG_NS, name);
  const page = element('section');
  const header = element('header'); header.classList.add('workspace-header');
  const button = element('button');
  button.setAttribute('data-workspace-search-toggle', '');
  button.setAttribute('aria-controls', inputId);
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', 'Открыть поиск');
  const label = element('label'); label.classList.add('workspace-search');
  const input = Object.assign(element('input'), { value: '' });
  input.id = inputId; input.setAttribute('type', 'search');
  label.append(input); header.append(button, label); page.append(header);
  const emit = (node: Node, event: Event) => {
    for (const listener of listeners.get(node)?.get(event.type) ?? []) listener.call(node, event);
    return event;
  };
  const click = () => emit(button, new Event('click', { cancelable: true }));
  const escape = (isComposing = false) => emit(page,
    Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape', isComposing }));
  return { page, header, button, input, label, click, escape,
    active: () => active, focusOptions: () => focusOptions };
}

test('search toggle synchronizes accessible state and focuses without moving the viewport', () => {
  const h = fixture(); attachWorkspaceHeader(h.page as unknown as HTMLElement);
  assert.equal(h.page.dataset.searchOpen, 'false');
  h.click();
  assert.equal(h.page.dataset.searchOpen, 'true');
  assert.equal(h.button.getAttribute('aria-expanded'), 'true');
  assert.equal(h.button.getAttribute('aria-label'), 'Закрыть поиск');
  assert.equal(h.button.getAttribute('aria-controls'), h.input.id);
  assert.ok(h.active() === h.input);
  assert.deepEqual(h.focusOptions(), { preventScroll: true });
  h.input.value = '37';
  h.click();
  assert.equal(h.page.dataset.searchOpen, 'false');
  assert.equal(h.button.getAttribute('aria-expanded'), 'false');
  assert.equal(h.button.getAttribute('aria-label'), 'Открыть поиск');
  assert.equal(h.input.value, '37', 'collapsing search does not clear its filter');
  assert.ok(h.active() === h.button);
  assert.deepEqual(h.focusOptions(), { preventScroll: true });
});

test('Escape closes an expanded search, prevents native clearing and preserves the query on reopening', () => {
  const h = fixture(); attachWorkspaceHeader(h.page as unknown as HTMLElement);
  h.click(); h.input.value = 'красное чёрное';
  const event = h.escape();
  assert.equal(event.defaultPrevented, true, 'Escape must not trigger native search-input clearing');
  assert.equal(h.page.dataset.searchOpen, 'false');
  assert.equal(h.button.getAttribute('aria-expanded'), 'false');
  assert.equal(h.button.getAttribute('aria-label'), 'Открыть поиск');
  assert.ok(h.active() === h.button);
  assert.equal(h.input.value, 'красное чёрное');
  h.click();
  assert.ok(h.active() === h.input);
  assert.equal(h.input.value, 'красное чёрное');
});

test('inactive search and input-method composition do not consume Escape or steal focus', () => {
  const h = fixture(); attachWorkspaceHeader(h.page as unknown as HTMLElement);
  assert.equal(h.escape().defaultPrevented, false);
  assert.equal(h.active(), null);
  h.click();
  assert.equal(h.escape(true).defaultPrevented, false);
  assert.equal(h.page.dataset.searchOpen, 'true');
  assert.ok(h.active() === h.input);
});

test('library and cartotheque headers keep independent state and target the input named by aria-controls', () => {
  const library = fixture('knowledgeSearch'), charts = fixture('librarySearch');
  // Another search field on the same page must not receive the header focus.
  const unrelated = Object.assign(library.input.ownerDocument.createElementNS(SVG_NS, 'input'), { value: 'other' });
  unrelated.id = 'otherSearch'; unrelated.setAttribute('type', 'search');
  library.page.insertBefore(unrelated, library.header);
  attachWorkspaceHeader(library.page as unknown as HTMLElement);
  attachWorkspaceHeader(charts.page as unknown as HTMLElement);
  library.input.value = 'ворота'; charts.input.value = 'Анна';
  library.click();
  assert.ok(library.active() === library.input);
  assert.equal(charts.page.dataset.searchOpen, 'false');
  charts.click(); library.escape();
  assert.equal(library.page.dataset.searchOpen, 'false');
  assert.equal(charts.page.dataset.searchOpen, 'true');
  assert.equal(library.input.value, 'ворота');
  assert.equal(charts.input.value, 'Анна');
});

test('optional or incomplete header markup is safe', () => {
  const empty = svgDocument().createElementNS(SVG_NS, 'section');
  assert.doesNotThrow(() => attachWorkspaceHeader(empty as unknown as HTMLElement));
  const missingInput = fixture(); missingInput.input.remove();
  assert.doesNotThrow(() => attachWorkspaceHeader(missingInput.page as unknown as HTMLElement));
  assert.doesNotThrow(() => missingInput.click());
  assert.equal(missingInput.button.getAttribute('aria-expanded'), 'false');
});


test('restored search expansion is visible without stealing focus and later changes notify its owner', () => {
  const h = fixture(); let changes = 0;
  const header = attachWorkspaceHeader(h.page as unknown as HTMLElement, { initialExpanded: true, onChange: () => { changes++; } });
  assert.equal(h.button.getAttribute('aria-expanded'), 'true');
  assert.equal(h.active(), null);
  assert.equal(changes, 0);
  h.escape();
  assert.equal(header!.expanded, false);
  assert.equal(changes, 1);
});
