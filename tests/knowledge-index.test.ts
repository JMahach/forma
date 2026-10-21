import test from 'node:test';
import assert from 'node:assert/strict';
import { attachKnowledge } from '../src/views/knowledge.ts';
import { SVG_NS, svgDocument } from './helpers/svg-dom.ts';

// The shared tree fixture parses the real markup and preserves node identity.
// Only page events/focus are adapted; no knowledge rendering is reproduced.
function fixture() {
  const document = svgDocument(), create = document.createElementNS.bind(document);
  document.createElementNS = (namespace, name) => {
    const node = create(namespace, name);
    node.closest = (selector: string) => {
      for (let current = node; current; current = current.parentNode) if (current.matches(selector)) return current;
      return null;
    };
    node.focus = () => { document.activeElement = node; };
    node.scrollIntoView = () => {};
    return node;
  };
  const element = (name: string) => document.createElementNS(SVG_NS, name);
  const dialog = element('section'), index = element('nav'), article = element('article');
  dialog.hidden = true;
  const categories = ['gate', 'center', 'channel'].map(type => {
    const button = element('button'); button.dataset.knowledgeCategory = type; return button;
  });
  dialog.append(...categories, index, article);
  dialog.querySelector = (selector: string) => selector === '#knowledgeIndex' ? index : selector === '#knowledgeArticle' ? article : null;
  const handlers = new Map();
  dialog.addEventListener = (name, callback) => handlers.set(name, callback);
  const controller = attachKnowledge(dialog, () => {});
  const click = (target: { focus: () => void; }) => { target.focus(); handlers.get('click')({ target }); };
  return { document, dialog, index, article, categories, controller, click };
}

test('browsing topics keeps index buttons and the clicked focus target while updating article and pressed state', () => {
  const h = fixture(); h.controller.show({ type: 'gate' as const, id: 37 });
  const buttons = h.index.children;
  assert.equal(buttons.length, 64);
  for (let id = 1; id <= 20; id++) {
    const target = buttons.find((button: { dataset: { topicId: string; }; }) => button.dataset.topicId === String(id));
    h.click(target!);
    assert.ok(h.index.children.every((button, i) => button === buttons[i]), 'topic changes keep the existing index');
    assert.equal(h.document.activeElement, target, 'the pressed button remains the focus target');
    assert.deepEqual(h.index.querySelectorAll('[aria-pressed="true"]'), [target]);
    assert.match(h.article.querySelector('h3')!.textContent, new RegExp(`^${id} · `));
  }
  assert.equal(h.index.innerHTMLWrites, 1, 'one index is built for the gate category');
});

test('category changes replace the index, while reopening a topic keeps its category and article reset behavior', () => {
  const h = fixture(); h.controller.show({ type: 'gate' as const, id: 37 });
  let previous = h.index.firstElementChild;
  for (const [category, count, label] of [['center', 9, 'Центры'], ['channel', 36, 'Каналы'], ['gate', 64, 'Ворота']] as const) {
    h.click(h.categories.find(button => button.dataset.knowledgeCategory === category)!);
    assert.equal(h.index.children.length, count);
    assert.equal(h.index.getAttribute('aria-label'), label);
    assert.notEqual(h.index.firstElementChild, previous);
    assert.equal(h.index.firstElementChild.getAttribute('aria-pressed'), 'true');
    previous = h.index.firstElementChild;
  }
  const buttons = h.index.children;
  h.controller.hide(); h.article.scrollTop = 180;
  h.controller.show({ type: 'gate' as const, id: 10 });
  assert.ok(h.index.children.every((button, i) => button === buttons[i]), 'reopening keeps the category index');
  assert.equal(h.index.querySelector('[aria-pressed="true"]')!.dataset.topicId, '10');
  assert.match(h.article.querySelector('h3')!.textContent, /^10 · /);
  assert.equal(h.article.scrollTop, 0, 'showing the article still starts at its heading');
});
