import test from 'node:test';
import assert from 'node:assert/strict';
import { attachKnowledge } from '../src/views/knowledge.js';
import { SVG_NS, svgDocument } from './helpers/svg-dom.mjs';

// The shared tree fixture parses the real markup and preserves node identity.
// Only dialog events/focus are adapted; no knowledge rendering is reproduced.
function fixture() {
  const document = svgDocument(), create = document.createElementNS.bind(document);
  document.createElementNS = (namespace, name) => {
    const node = create(namespace, name);
    node.closest = selector => {
      for (let current = node; current; current = current.parentNode) if (current.matches(selector)) return current;
      return null;
    };
    node.focus = () => { document.activeElement = node; };
    node.scrollIntoView = () => {};
    return node;
  };
  const element = name => document.createElementNS(SVG_NS, name);
  const dialog = element('dialog'), index = element('nav'), article = element('article');
  const categories = ['gate', 'center', 'channel'].map(type => {
    const button = element('button'); button.dataset.knowledgeCategory = type; return button;
  });
  dialog.append(...categories, index, article);
  dialog.querySelector = selector => selector === '#knowledgeIndex' ? index : selector === '#knowledgeArticle' ? article : null;
  const handlers = new Map();
  dialog.addEventListener = (name, callback) => handlers.set(name, callback);
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; handlers.get('close')?.(); };
  const controller = attachKnowledge(dialog, () => {});
  const click = target => { target.focus(); handlers.get('click')({ target }); };
  return { document, dialog, index, article, categories, controller, click };
}

test('browsing topics keeps index buttons and the clicked focus target while updating article and pressed state', () => {
  const h = fixture(); h.controller.show({ type: 'gate', id: 37 });
  const buttons = h.index.children;
  assert.equal(buttons.length, 64);
  for (let id = 1; id <= 20; id++) {
    const target = buttons.find(button => button.dataset.topicId === String(id));
    h.click(target);
    assert.ok(h.index.children.every((button, i) => button === buttons[i]), 'topic changes keep the existing index');
    assert.equal(h.document.activeElement, target, 'the pressed button remains the focus target');
    assert.deepEqual(h.index.querySelectorAll('[aria-pressed="true"]'), [target]);
    assert.match(h.article.querySelector('h3').textContent, new RegExp(`^${id} · `));
  }
  assert.equal(h.index.innerHTMLWrites, 1, 'one index is built for the gate category');
});

test('category changes replace the index, while reopening a topic keeps its category and article reset behavior', () => {
  const h = fixture(); h.controller.show({ type: 'gate', id: 37 });
  let previous = h.index.firstElementChild;
  for (const [category, count, label] of [['center', 9, 'Центры'], ['channel', 36, 'Каналы'], ['gate', 64, 'Ворота']]) {
    h.click(h.categories.find(button => button.dataset.knowledgeCategory === category));
    assert.equal(h.index.children.length, count);
    assert.equal(h.index.getAttribute('aria-label'), label);
    assert.notEqual(h.index.firstElementChild, previous);
    assert.equal(h.index.firstElementChild.getAttribute('aria-pressed'), 'true');
    previous = h.index.firstElementChild;
  }
  const buttons = h.index.children;
  h.dialog.close(); h.article.scrollTop = 180;
  h.controller.show({ type: 'gate', id: 10 });
  assert.ok(h.index.children.every((button, i) => button === buttons[i]), 'reopening keeps the category index');
  assert.equal(h.index.querySelector('[aria-pressed="true"]').dataset.topicId, '10');
  assert.match(h.article.querySelector('h3').textContent, /^10 · /);
  assert.equal(h.article.scrollTop, 0, 'showing the article still starts at its heading');
});
