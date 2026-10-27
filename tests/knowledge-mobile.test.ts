import test from 'node:test';
import assert from 'node:assert/strict';
import { attachKnowledge } from '../src/views/knowledge.ts';
import type { SelectionIdentity } from '../src/selection/selection-targets.ts';
import { SVG_NS, svgDocument } from './helpers/svg-dom.ts';

function fixture(initialPhone = true) {
  let phone = initialPhone;
  const document = svgDocument();
  const create = document.createElementNS.bind(document);
  let active: ReturnType<typeof create> | null = null;
  document.createElementNS = (namespace, name) => {
    const node = create(namespace, name);
    node.closest = (selector: string) => {
      for (let parent: typeof node | null = node; parent; parent = parent.parentNode as typeof node | null) {
        if (parent.matches(selector)) return parent;
      }
      return null;
    };
    node.focus = () => { active = node; };
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
  const count = element('p'), back = element('button');
  back.textContent = 'К разделам';
  const nodes = { knowledgeIndex: index, knowledgeArticle: article, knowledgeCategories: categories,
    knowledgeSearch: search, knowledgeSection: section, knowledgeCount: count, knowledgeBack: back };
  for (const [id, node] of Object.entries(nodes)) { node.id = id; page.append(node); }

  // display:none has no scrollable box: writes are ignored and reads return zero.
  // Retain the underlying offset so reopening an unchanged article behaves like a browser.
  let readingOffset = 0;
  Object.defineProperty(article, 'scrollTop', {
    configurable: true,
    get: () => page.hidden || phone && page.dataset.view === 'catalog' ? 0 : readingOffset,
    set: (value: number) => { if (!page.hidden && (!phone || page.dataset.view !== 'catalog')) readingOffset = value; },
  });
  let catalogueOffset = 0;
  Object.defineProperty(index, 'scrollTop', {
    configurable: true,
    get: () => page.hidden || phone && page.dataset.view === 'article' ? 0 : catalogueOffset,
    set: (value: number) => { if (!page.hidden && (!phone || page.dataset.view !== 'article')) catalogueOffset = value; },
  });
  const articleHandlers = new Map<string, (event: { target: typeof article }) => void>();
  article.addEventListener = (name: string, callback: unknown) => {
    articleHandlers.set(name, callback as (event: { target: typeof article }) => void);
  };
  const handlers = new Map<string, (event: { target: typeof index }) => void>();
  page.addEventListener = (name: string, callback: unknown) => {
    handlers.set(name, callback as (event: { target: typeof index }) => void);
  };
  const selected: SelectionIdentity[] = [];
  const controller = attachKnowledge(page as unknown as HTMLElement,
    selection => selected.push(selection), { isPhone: () => phone });
  const click = (node: typeof index | null) => {
    assert.ok(node, 'the requested control exists');
    handlers.get('click')?.({ target: node });
  };
  const find = (query: string) => { search.value = query; handlers.get('input')?.({ target: search }); };
  const changeSection = (value: string) => { section.value = value; handlers.get('change')?.({ target: section }); };
  const scrollArticle = (offset: number) => {
    article.scrollTop = offset;
    articleHandlers.get('scroll')?.({ target: article });
  };
  return { page, index, article, search, section, back, controller, click, find, changeSection,
    selected, active: () => active, setPhone: (value: boolean) => { phone = value; }, scrollArticle };
}

test('phone catalog opens an article and Back restores the exact filtered catalog and card focus', () => {
  const h = fixture();
  h.controller.show();
  assert.equal(h.page.dataset.view, 'catalog', 'no map selection starts at the catalog');
  h.changeSection('centers');
  assert.equal(h.page.dataset.view, 'catalog', 'changing the native section does not open its first article');
  assert.equal(h.section.value, 'centers');
  assert.ok(h.index.querySelector('[data-entry-id="center.throat"]'));
  h.find('а');
  const first = h.index.firstElementChild;
  const card = h.index.querySelector('[data-entry-id="gate.8"]');
  h.index.scrollTop = 145;
  h.click(card);
  assert.equal(h.page.dataset.view, 'article');
  assert.equal(h.active(), h.article.querySelector('h3'), 'reading begins at the article heading');
  h.click(h.back);
  assert.equal(h.page.dataset.view, 'catalog');
  assert.equal(h.search.value, 'а');
  assert.equal(h.section.value, 'centers', 'a global result must not replace the chosen catalog section');
  assert.equal(h.index.scrollTop, 145);
  assert.equal(h.index.firstElementChild, first);
  assert.equal(h.index.querySelector('[data-entry-id="gate.8"]'), card);
  assert.equal(h.active(), card, 'Back returns focus to the originating card');
  assert.deepEqual(h.selected, [], 'reading does not select the diagram');
});

test('article cross-links preserve the catalog query, section, nodes and originating card', () => {
  const h = fixture(); h.controller.show();
  h.changeSection('centers'); h.find('а');
  const card = h.index.querySelector('[data-entry-id="gate.8"]');
  const first = h.index.firstElementChild;
  h.index.scrollTop = 170;
  h.click(card);
  h.click(h.article.querySelector('[data-entry-id="channel.1-8"]'));
  assert.match(h.article.querySelector('h3')!.textContent, /^1[–-]8 · /);
  assert.equal(h.page.dataset.view, 'article');
  assert.equal(h.active(), h.article.querySelector('h3'));
  assert.equal(h.search.value, 'а', 'following a relation is article navigation, not a new catalog');
  assert.equal(h.section.value, 'centers');
  assert.equal(h.index.firstElementChild, first);
  h.click(h.back);
  assert.equal(h.page.dataset.view, 'catalog');
  assert.equal(h.index.scrollTop, 170);
  assert.equal(h.active(), card, 'relations do not replace the catalog return target');
});

test('unchanged map selection retains mobile view and reading position; a new selection opens its own article', () => {
  const h = fixture(); h.controller.show({ type: 'gate', id: 8 });
  assert.equal(h.page.dataset.view, 'article');
  h.article.scrollTop = 210;
  const heading = h.article.querySelector('h3');
  h.controller.hide(); h.controller.show({ type: 'gate', id: 8 });
  assert.equal(h.page.dataset.view, 'article');
  assert.equal(h.article.querySelector('h3'), heading);
  assert.equal(h.article.scrollTop, 210);
  h.click(h.back);
  h.index.scrollTop = 90;
  const first = h.index.firstElementChild;
  h.controller.hide(); h.controller.show({ type: 'gate', id: 8 });
  assert.equal(h.page.dataset.view, 'catalog', 'reopening does not force an unchanged map selection into reading');
  assert.equal(h.index.firstElementChild, first);
  assert.equal(h.index.scrollTop, 90);
  h.controller.hide(); h.controller.show({ type: 'center', id: 'heart' });
  assert.equal(h.page.dataset.view, 'article');
  assert.equal(h.section.value, 'centers');
  assert.ok(h.article.textContent.includes('Эго'));
  assert.ok(h.index.querySelector('[data-entry-id="center.ego"]'));
  assert.equal(h.article.scrollTop, 0);
});

test('saved article offsets survive hidden rendering and catalog round trips', () => {
  const h = fixture(); h.controller.show({ type: 'gate', id: 8 });
  h.article.scrollTop = 180;
  h.click(h.article.querySelector('[data-entry-id="channel.1-8"]'));
  h.article.scrollTop = 240;
  h.controller.hide();
  assert.equal(h.article.scrollTop, 0, 'the fixture models a hidden reading pane rather than a plain number');
  h.controller.show({ type: 'channel', id: '1-8' });
  assert.equal(h.article.scrollTop, 240, 'showing the same article after map selection restores its visible offset');
  h.click(h.back);
  assert.equal(h.page.dataset.view, 'catalog');
  h.click(h.index.querySelector('[data-entry-id="channel.1-8"]'));
  assert.equal(h.page.dataset.view, 'article');
  assert.equal(h.article.scrollTop, 240, 'a catalog round trip does not replace the saved offset with hidden zero');
  h.controller.hide(); h.controller.show({ type: 'gate', id: 8 });
  assert.equal(h.article.scrollTop, 180, 'returning to a previously read article restores its own offset');
});

test('Back from a map-selected article focuses its visible catalog card without an originating catalog click', () => {
  const h = fixture();
  h.controller.show({ type: 'gate', id: 8 });
  assert.equal(h.page.dataset.view, 'article');
  const card = h.index.querySelector('[data-entry-id="gate.8"]');
  assert.ok(card, 'the map selection has a corresponding catalog card');
  h.click(h.back);
  assert.equal(h.page.dataset.view, 'catalog');
  assert.ok(h.active() === card, 'Back needs a current-entry focus fallback when no card was previously clicked');
});

test('desktop article scroll survives narrowing to phone and opening the same current catalog card', () => {
  const h = fixture(false);
  h.controller.show();
  assert.equal(h.page.dataset.view, 'catalog');
  assert.match(h.article.querySelector('h3')!.textContent, /^37 · /);
  h.scrollArticle(210);
  assert.equal(h.article.scrollTop, 210, 'desktop displays the article alongside the catalog');
  h.setPhone(true);
  assert.equal(h.article.scrollTop, 0, 'narrowing hides the article without creating an explicit navigation event');
  h.click(h.index.querySelector('[data-entry-id="gate.37"]'));
  assert.equal(h.page.dataset.view, 'article');
  assert.equal(h.article.scrollTop, 210, 'scroll tracking must preserve the desktop offset before the pane becomes hidden');
  assert.equal(h.active(), h.article.querySelector('h3'));
});


for (const phone of [true, false]) test(`repeated workspace hides preserve the last visible article offset (${phone ? 'phone' : 'desktop'})`, () => {
  const h = fixture(phone);
  h.controller.show({ type: 'gate', id: 8 });
  h.click(h.article.querySelector('[data-entry-id="channel.1-8"]'));
  h.scrollArticle(240);
  h.controller.hide();
  assert.equal(h.article.scrollTop, 0, 'a hidden pane exposes no layout position');
  h.controller.hide();
  h.controller.hide();
  h.controller.show({ type: 'gate', id: 8 });
  assert.equal(h.controller.snapshot.entryId, 'channel.1-8');
  assert.equal(h.article.scrollTop, 240, 'visiting other workspaces must not overwrite reading state with hidden zero');
  h.click(h.article.querySelector('[data-reading-back]'));
  assert.equal(h.controller.snapshot.entryId, 'gate.8', 'the existing reading chain remains usable');
});

test('repeated workspace hides preserve the filtered phone catalog and its return target', () => {
  const h = fixture(); h.controller.show(); h.find('а');
  const card = h.index.querySelector('[data-entry-id="gate.8"]');
  h.index.scrollTop = 145;
  h.click(card); h.click(h.back);
  h.controller.hide();
  assert.equal(h.index.scrollTop, 0, 'the hidden catalog has no layout position');
  h.controller.hide();
  h.controller.show();
  assert.equal(h.controller.snapshot.view, 'catalog');
  assert.equal(h.search.value, 'а');
  assert.equal(h.index.scrollTop, 145);
  assert.equal(h.index.querySelector('[data-entry-id="gate.8"]'), card);
  h.click(card); h.click(h.back);
  assert.equal(h.active(), card);
  assert.equal(h.index.scrollTop, 145);
});
