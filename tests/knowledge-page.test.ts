import test from 'node:test';
import assert from 'node:assert/strict';
import { attachKnowledge } from '../src/views/knowledge.ts';

function harness() {
  const handlers = new Map();
  const node = (attributes = {}, dataset = {}, isButton = false) => ({
    dataset, innerHTML: '', scrollTop: 0,
    setAttribute(name, value) { attributes[name] = String(value); },
    hasAttribute(name: PropertyKey) { return Object.hasOwn(attributes, name); },
    closest(selector: string) { return selector === 'button' && isButton ? this : null; },
    querySelector() { return null; },
  });
  const index = node(), article = node(), selected = [];
  const categories = ['gate', 'center', 'channel'].map(value => node({}, { knowledgeCategory: value }, true));
  const page = {
    ...node(), hidden: true,
    querySelector(selector: string) { return selector === '#knowledgeIndex' ? index : selector === '#knowledgeArticle' ? article : null; },
    querySelectorAll(selector: string) { return selector === '[data-knowledge-category]' ? categories : []; },
    addEventListener(type, callback) { handlers.set(type, callback); },
  };
  const controller = attachKnowledge(page, value => {
    assert.equal(page.hidden, false, 'navigation receives selection while the library is still visible');
    selected.push(value);
    controller.hide();
  });
  return { page, index, article, controller, selected, node,
    dispatch(type: string, options = {}) { handlers.get(type)?.({ target: page, ...options }); } };
}

test('library shows and hides as a workspace section without a modal API', () => {
  const h = harness();
  h.controller.show({ type: 'gate' as const, id: 10 });
  assert.equal(h.page.hidden, false);
  assert.match(h.article.innerHTML, /<h3>10 · /);
  h.controller.hide();
  assert.equal(h.page.hidden, true);
  h.controller.show();
  assert.equal(h.page.hidden, false);
  assert.match(h.article.innerHTML, /<h3>10 · /, 'reopening retains the browsed topic');
});

test('clicking whitespace or pressing Escape does not dismiss a workspace page', () => {
  const h = harness(); h.controller.show();
  for (const [clientX, clientY] of [[0, 0], [1200, 900], [300, 200]] as const) {
    h.dispatch('pointerdown', { clientX, clientY, button: 0 });
    h.dispatch('click', { clientX, clientY });
    assert.equal(h.page.hidden, false);
  }
  h.dispatch('click', { target: h.node() });
  h.dispatch('keydown', { key: 'Escape' });
  assert.equal(h.page.hidden, false);
  assert.deepEqual(h.selected, []);
});

test('show-on-chart delegates the chosen topic and visibility change to workspace navigation', () => {
  const h = harness(); h.controller.show({ type: 'channel' as const, id: '37-40' });
  h.dispatch('click', { target: h.node({ 'data-show-topic': '' }, {}, true) });
  assert.deepEqual(h.selected, [{ type: 'channel' as const, id: '37-40' }]);
  assert.equal(h.page.hidden, true);
});
