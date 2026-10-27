import test from 'node:test';
import assert from 'node:assert/strict';
import { attachKnowledge } from '../src/views/knowledge.ts';
import { KNOWLEDGE_ENTRIES } from '../src/reference/knowledge-content.ts';
import { createViewStore, VIEW_STORAGE_KEY } from '../src/data/view-store.ts';
import { SVG_NS, svgDocument } from './helpers/svg-dom.ts';
import type { SelectionIdentity } from '../src/selection/selection-targets.ts';

function fixture(options: Parameters<typeof attachKnowledge>[2] = {}) {
  const document = svgDocument(), create = document.createElementNS.bind(document);
  document.createElementNS = (namespace, name) => {
    const node = create(namespace, name);
    node.closest = (selector: string) => {
      for (let current: typeof node | null = node; current; current = current.parentNode as typeof node | null) {
        if (current.matches(selector)) return current;
      }
      return null;
    };
    node.focus = () => {};
    node.scrollIntoView = () => {};
    return node;
  };
  const element = (name: string) => document.createElementNS(SVG_NS, name);
  const page = Object.assign(element('section'), { hidden: true });
  const index = element('nav'), article = element('article'), categories = element('nav');
  const inputEvents = new EventTarget();
  const search = Object.assign(element('input'), { value: '',
    addEventListener: inputEvents.addEventListener.bind(inputEvents), removeEventListener: inputEvents.removeEventListener.bind(inputEvents) });
  const section = Object.assign(element('select'), { value: '' });
  const count = element('p');
  const nodes: Record<string, typeof index> = { knowledgeIndex: index, knowledgeArticle: article,
    knowledgeCategories: categories, knowledgeSearch: search, knowledgeSection: section, knowledgeCount: count };
  for (const [id, node] of Object.entries(nodes)) { node.setAttribute('id', id); page.append(node); }
  const handlers = new Map<string, (event: { target: typeof index }) => void>();
  page.addEventListener = (name: string, callback: unknown) => { handlers.set(name, callback as (event: { target: typeof index }) => void); };
  const selected: SelectionIdentity[] = [];
  const controller = attachKnowledge(page as unknown as HTMLElement, selection => selected.push(selection), options);
  const click = (node: typeof index | null) => { assert.ok(node); handlers.get('click')?.({ target: node! }); };
  const find = (query: string) => { search.value = query; handlers.get('input')?.({ target: search }); };
  const key = (node: typeof index, value: string) => {
    let prevented = false;
    handlers.get('keydown')?.({ target: node, key: value, preventDefault() { prevented = true; } } as never);
    return prevented;
  };
  return { page, index, article, categories, search, section, count, controller, click, find, key, selected };
}

test('library presents the short description, full paragraphs and actual cross-links', () => {
  const h = fixture(); h.controller.show({ type: 'gate', id: 8 });
  const entry = KNOWLEDGE_ENTRIES.find(entry => entry.id === 'gate.8')!;
  assert.ok(h.article.textContent.includes(entry.short));
  for (const paragraph of entry.paragraphs) assert.ok(h.article.textContent.includes(paragraph));
  assert.ok(h.index.textContent.includes('Вклад'), 'gate names are visible, not only screen-reader labels');
  h.click(h.article.querySelector('[data-entry-id="channel.1-8"]'));
  assert.ok(h.article.textContent.includes('Вдохновение'));
  assert.equal(h.article.querySelectorAll('.knowledge-prose p').length, 4);
  h.click(h.article.querySelector('[data-show-topic]'));
  assert.deepEqual(h.selected, [{ type: 'channel', id: '1-8' }]);
});

test('selecting an illustrated gate keeps the center article and reveals its gate and channel descriptions', () => {
  const h = fixture(); h.controller.show({ type: 'center', id: 'head' });
  const prose = h.article.querySelector('.knowledge-prose');
  const figure = h.article.querySelector('.knowledge-center-figure');
  assert.ok(figure, 'the center is drawn beside its explanation');
  h.click(figure.querySelector('[data-entry-id="gate.61"]')!.querySelector('text'));
  assert.equal(h.article.querySelector('h3')!.textContent, 'Теменной центр');
  assert.equal(h.article.querySelector('.knowledge-prose'), prose, 'a gate preview does not replace the reading DOM');
  const details = h.article.querySelector('[data-gate-details]')!;
  assert.ok(details.textContent.includes(KNOWLEDGE_ENTRIES.find(entry => entry.id === 'gate.61')!.short));
  assert.ok(details.textContent.includes(KNOWLEDGE_ENTRIES.find(entry => entry.id === 'channel.24-61')!.short));
  assert.ok(details.querySelector('[data-entry-id="gate.24"]'));
  h.click(details.querySelector('[data-entry-id="gate.61"]'));
  assert.match(h.article.querySelector('h3')!.textContent, /^61 · /);
  assert.deepEqual(h.selected, [], 'library navigation does not replace the active chart');
});

test('a gate with three integration routes exposes all three channels and highlights only its own branch', () => {
  const h = fixture(); h.controller.show({ type: 'center', id: 'g' });
  h.click(h.article.querySelector('.knowledge-center-branch[data-gate-id="10"]'));
  assert.equal(h.article.querySelector('h3')!.textContent, 'G-центр');
  assert.equal(h.article.querySelector('.knowledge-center-gate[data-gate-id="10"]')!.getAttribute('data-selected'), 'true');
  assert.equal(h.article.querySelector('.knowledge-center-branch[data-gate-id="10"]')!.getAttribute('data-selected'), 'true');
  assert.equal(h.article.querySelector('.knowledge-center-branch[data-gate-id="1"]')!.getAttribute('data-selected'), 'false');
  const details = h.article.querySelector('[data-gate-details]')!;
  assert.equal(details.querySelectorAll('.knowledge-gate-route').length, 3);
  for (const id of ['channel.10-20', 'channel.10-34', 'channel.10-57']) assert.ok(details.querySelector(`[data-entry-id="${id}"]`), id);
  assert.deepEqual(h.selected, []);
});

test('reading back follows the article chain and restores the center selection and scroll', () => {
  const h = fixture(); h.controller.show({ type: 'center', id: 'g' });
  h.click(h.article.querySelector('.knowledge-center-gate[data-entry-id="gate.1"]'));
  h.article.scrollTop = 214;
  h.click(h.article.querySelector('[data-gate-details] [data-entry-id="gate.1"]'));
  h.click(h.article.querySelector('[data-entry-id="channel.1-8"]'));
  h.click(h.article.querySelector('[data-entry-id="gate.8"]'));
  for (const expected of ['1–8 · Вдохновение', '1 · Самовыражение', 'G-центр']) {
    h.click(h.article.querySelector('[data-reading-back]'));
    assert.equal(h.article.querySelector('h3')!.textContent, expected);
  }
  assert.equal(h.article.scrollTop, 214);
  assert.equal(h.article.querySelector('.knowledge-center-gate[data-gate-id="1"]')!.getAttribute('data-selected'), 'true');
  assert.ok(h.article.querySelector('[data-gate-details]')!.textContent.includes('Самовыражение'));
});

test('keyboard selection previews a gate without moving the article or changing the current chart', () => {
  const h = fixture(); h.controller.show({ type: 'center', id: 'g' });
  const gate = h.article.querySelector('.knowledge-center-gate[data-entry-id="gate.1"]')!;
  assert.equal(h.key(gate, 'Enter'), true);
  assert.equal(h.article.querySelector('h3')!.textContent, 'G-центр');
  assert.equal(h.article.querySelector('.knowledge-center-gate[data-entry-id="gate.1"]'), gate);
  assert.equal(gate.getAttribute('aria-pressed'), 'true');
  assert.equal(h.key(gate, ' '), true);
  assert.deepEqual(h.selected, []);
});

test('returning to a center or switching gates restores the expanded channel routes', () => {
  const h = fixture(); h.controller.show({ type: 'center', id: 'g' });
  h.click(h.article.querySelector('.knowledge-center-gate[data-gate-id="10"]'));
  h.article.querySelector('[data-channel-id="channel.10-34"]')!.setAttribute('open', '');
  h.article.scrollTop = 280;
  h.click(h.article.querySelector('[data-gate-details] [data-entry-id="channel.10-34"]'));
  h.click(h.article.querySelector('[data-reading-back]'));
  assert.ok(h.article.querySelector('[data-channel-id="channel.10-34"]')!.hasAttribute('open'));
  assert.equal(h.article.querySelectorAll('.knowledge-gate-route[open]').length, 1);
  assert.equal(h.article.scrollTop, 280);
  h.click(h.article.querySelector('.knowledge-center-gate[data-gate-id="1"]'));
  h.article.querySelector('[data-channel-id="channel.1-8"]')!.removeAttribute('open');
  h.click(h.article.querySelector('.knowledge-center-gate[data-gate-id="10"]'));
  assert.ok(h.article.querySelector('[data-channel-id="channel.10-34"]')!.hasAttribute('open'));
  h.click(h.article.querySelector('.knowledge-center-gate[data-gate-id="1"]'));
  assert.equal(h.article.querySelectorAll('.knowledge-gate-route[open]').length, 0);
});

test('all nine center illustrations link the gates belonging to that library entry', () => {
  const h = fixture(), allGates = new Set<string>();
  for (const entry of KNOWLEDGE_ENTRIES.filter(item => item.kind === 'center')) {
    const id = entry.key === 'ego' ? 'heart' : entry.key === 'solar-plexus' ? 'solar' : String(entry.key);
    h.controller.show({ type: 'center', id });
    const figure = h.article.querySelector('.knowledge-center-figure');
    assert.ok(figure, entry.id);
    const gates = figure.querySelectorAll('[data-entry-id]');
    assert.deepEqual(gates.map(gate => Number(gate.dataset.entryId!.slice(5))).sort((a,b) => a-b),
      [...entry.mechanics!.gates as number[]].sort((a,b) => a-b), entry.id);
    for (const gate of gates) {
      assert.equal(gate.getAttribute('role'), 'button');
      assert.equal(gate.getAttribute('tabindex'), '0');
      assert.ok(gate.getAttribute('aria-label'));
      assert.ok(!allGates.has(gate.dataset.entryId!));
      allGates.add(gate.dataset.entryId!);
    }
  }
  assert.equal(allGates.size, 64);
});

test('search crosses sections, opens a basic topic and handles no matches without losing the article', () => {
  const h = fixture(); h.controller.show({ type: 'gate', id: 8 });
  h.find('красное');
  h.click(h.index.querySelector('[data-entry-id="concept.personality-design"]'));
  assert.ok(h.article.textContent.includes('Личность и Дизайн'));
  assert.equal(h.article.querySelector('[data-show-topic]'), null, 'a concept does not pretend to be a selectable gate');
  const before = h.article.innerHTML;
  h.find('несуществующая-тема-123');
  assert.ok(h.index.textContent.includes('Ничего не найдено'));
  assert.equal(h.article.innerHTML, before);
  h.find('');
  assert.ok(h.index.querySelector('[data-entry-id="gate.8"]'), 'clearing a global query returns to the original catalogue section');
});

test('returning from the map with unchanged selection retains the article and reading position', () => {
  const h = fixture(); h.controller.show({ type: 'gate', id: 8 });
  h.click(h.article.querySelector('[data-entry-id="channel.1-8"]'));
  h.article.scrollTop = 210;
  h.controller.hide(); h.controller.show({ type: 'gate', id: 8 });
  assert.ok(h.article.textContent.includes('Вдохновение'));
  assert.equal(h.article.scrollTop, 210);
  h.controller.hide(); h.controller.show({ type: 'gate', id: 10 });
  assert.match(h.article.querySelector('h3')!.textContent, /^10 · /);
  assert.equal(h.article.scrollTop, 0);
});

test('choosing a result in another section keeps the global search list and its scroll position', () => {
  const h = fixture(); h.controller.show({ type: 'gate', id: 8 });
  h.find('а');
  const first = h.index.firstElementChild;
  h.index.scrollTop = 160;
  h.click(h.index.querySelector('[data-entry-id="channel.1-8"]'));
  assert.ok(h.index.firstElementChild === first, 'global results retain their DOM nodes');
  assert.equal(h.index.scrollTop, 160);
});

test('all subject sections are available without deferred onboarding or private editorial material', () => {
  const h = fixture(); h.controller.show();
  assert.equal(h.categories.querySelectorAll('[data-knowledge-category]').length, 12);
  assert.ok(h.categories.textContent.includes('Устройство карты'));
  assert.doesNotMatch(h.categories.textContent, /С чего начать|О карте|Космолог/);
  h.find('Солнце'); h.click(h.index.querySelector('[data-entry-id="planet.sun"]'));
  assert.ok(h.article.textContent.includes('Главная тема выражения'));
  assert.doesNotMatch(h.article.textContent, /sourceRefs|sourceRegistry|Ра Уру Ху|C:\\Users/);
});


test('library snapshot restores the search and article on a phone without storing reading positions', () => {
  let changes = 0;
  const first = fixture({ isPhone: () => true, onChange: () => { changes++; } });
  first.controller.show(); first.find('красное');
  first.click(first.index.querySelector('[data-entry-id="concept.personality-design"]'));
  first.article.scrollTop = 320;
  assert.ok(changes >= 2, 'query and article selection notify the shared snapshot owner');
  const saved = first.controller.snapshot;
  assert.deepEqual(saved, { query: 'красное', searchOpen: false, collection: 'gates', entryId: 'concept.personality-design', view: 'article' });
  const next = fixture({ initialView: saved, initialSelection: { type: 'gate', id: 8 }, isPhone: () => true });
  next.controller.show({ type: 'gate', id: 8 });
  assert.equal(next.page.dataset.view, 'article');
  assert.equal(next.search.value, 'красное');
  assert.match(next.article.querySelector('h3')!.textContent, /Личность и Дизайн/);
  assert.equal(next.article.scrollTop, 0, 'reload starts at the beginning of the remembered article');
  next.controller.hide(); next.controller.show({ type: 'gate', id: 8 });
  assert.match(next.article.querySelector('h3')!.textContent, /Личность и Дизайн/);
  next.find('');
  assert.equal(next.controller.snapshot.query, '');
  assert.ok(next.index.querySelector('[data-entry-id="gate.8"]'), 'clearing returns to the saved catalogue');
});

test('new diagram selection takes priority after the remembered article has been restored', () => {
  const h = fixture({ initialView: { query: 'Дружба', searchOpen: false, collection: 'gates', entryId: 'gate.37', view: 'article' }, initialSelection: { type: 'gate', id: 8 } });
  h.controller.show({ type: 'gate', id: 8 });
  assert.match(h.article.querySelector('h3')!.textContent, /^37 · /);
  h.controller.hide(); h.controller.show({ type: 'gate', id: 10 });
  assert.match(h.article.querySelector('h3')!.textContent, /^10 · /);
  assert.equal(h.search.value, 'Дружба', 'opening a new diagram topic does not erase an independent search');
});

test('unknown saved library entries and collections fall back to the real catalogue', () => {
  const h = fixture({ initialView: { query: '', searchOpen: true, collection: 'missing', entryId: 'gate.999', view: 'article' } });
  h.controller.show();
  assert.match(h.article.querySelector('h3')!.textContent, /^37 · /);
  assert.ok(h.index.querySelector('[data-entry-id="gate.37"]'));
});


test('a new selection before the first lazy opening supersedes the remembered article', () => {
  const h = fixture({ initialView: { query: 'Дружба', searchOpen: false, collection: 'gates', entryId: 'gate.37', view: 'article' }, initialSelection: null });
  h.controller.show({ type: 'gate', id: 10 });
  assert.match(h.article.querySelector('h3')!.textContent, /^10 · /);
  assert.equal(h.search.value, 'Дружба');
});


test('remembered library search restores selection without changing the remembered article', () => {
  const focus={start:1,end:3,direction:'backward'} as const;
  const h=fixture({initialView:{query:'горло',searchOpen:true,collection:'centers',entryId:'center.throat',view:'catalog',focus}});
  Object.assign(h.search,{selectionStart:0,selectionEnd:0,selectionDirection:'none',
    focus(){Object.assign(h.search.ownerDocument,{activeElement:h.search});},
    setSelectionRange(start:number,end:number,direction:string){Object.assign(h.search,{selectionStart:start,selectionEnd:end,selectionDirection:direction});}});
  assert.equal(h.controller.restoreInputFocus(),false);
  h.controller.show();
  assert.equal(h.controller.restoreInputFocus(),true);
  assert.deepEqual(h.controller.snapshot.focus,focus);
  assert.equal(h.controller.snapshot.entryId,'center.throat');
  h.controller.hide(); assert.equal(h.controller.snapshot.focus,undefined);
});


test('every published article is reachable from search and its displayed cross-links return to the same reading context', t => {
  const h = fixture(); h.controller.show();
  let traversed = 0;
  for (const entry of KNOWLEDGE_ENTRIES) {
    h.find(entry.title);
    h.click(h.index.querySelector(`[data-entry-id="${entry.id}"]`));
    assert.equal(h.controller.snapshot.entryId, entry.id);
    for (const paragraph of entry.paragraphs) assert.ok(h.article.textContent.includes(paragraph), entry.id);
    const groups = h.article.querySelectorAll('[data-relation-panel]').map(panel => ({
      group: panel.dataset.relationPanel,
      targets: panel.querySelectorAll('[data-entry-id]').map(link => link.dataset.entryId),
    }));
    for (const { group, targets } of groups) for (const id of targets) {
      h.click(h.article.querySelector(`[data-relation-group="${group}"]`));
      const panel = h.article.querySelector(`[data-relation-panel="${group}"]`)!;
      assert.ok('hidden' in panel && panel.hidden === false, 'the relation group is visible before following its link');
      h.click(panel.querySelector(`[data-entry-id="${id}"]`));
      assert.equal(h.controller.snapshot.entryId, id);
      h.click(h.article.querySelector('[data-reading-back]'));
      assert.equal(h.controller.snapshot.entryId, entry.id);
      assert.equal(h.controller.snapshot.query, entry.title);
      traversed++;
    }
  }
  assert.deepEqual(h.selected, [], 'reading and relation navigation never select a chart');
  t.diagnostic(`${KNOWLEDGE_ENTRIES.length} published articles and ${traversed} displayed relation links traversed`);
});

test('real tab serialization restores reading separately from Cartoteka and drops only in-memory reading history', () => {
  const records = new Map<string, string>();
  const storage = { getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value); } };
  const store = createViewStore({ getStorage: () => storage });
  const first = fixture({ isPhone: () => true }); first.controller.show(); first.find('Вклад');
  first.click(first.index.querySelector('[data-entry-id="gate.8"]'));
  first.click(first.article.querySelector('[data-entry-id="channel.1-8"]'));
  first.article.scrollTop = 220;
  assert.equal(store.write({ version: 1, selectedId: '', mandala: false,
    camera: null, lifetime: null, transit: null, natalDay: null, planets: null,
    workspace: 'library', knowledge: first.controller.snapshot, charts: { query: 'Анна', searchOpen: true } }), true);
  const saved = createViewStore({ getStorage: () => storage }).read()!;
  const second = fixture({ isPhone: () => true, initialView: saved.knowledge }); second.controller.show();
  assert.equal(second.search.value, 'Вклад');
  assert.equal(second.controller.snapshot.entryId, 'channel.1-8');
  assert.equal(second.page.dataset.view, 'article');
  assert.equal(second.article.scrollTop, 0);
  assert.equal(second.article.querySelector('[data-reading-back]'), null);
  second.find('');
  assert.equal(store.write({ ...saved, knowledge: second.controller.snapshot }), true);
  const cleared = createViewStore({ getStorage: () => storage }).read()!;
  assert.equal(cleared.knowledge?.query, '');
  assert.equal(cleared.knowledge?.entryId, 'channel.1-8');
  assert.deepEqual(cleared.charts, { query: 'Анна', searchOpen: true });
  store.write({ ...cleared, charts: { query: '', searchOpen: false } });
  assert.deepEqual(store.read()!.knowledge, cleared.knowledge);
  assert.deepEqual([...records.keys()], [VIEW_STORAGE_KEY]);
});
