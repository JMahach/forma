import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChartSummary } from '../src/views/chart-summary-data.js';
import { attachChartSummary, renderSummarySections } from '../src/views/chart-summary-panel.js';

const chart = {
  id: 'test-chart', source: 'calculated', design: [20, 34], personality: [29, 46, 20],
  activations: {
    design: [{ planet: 'sun', gate: 34, line: 2 }, { planet: 'earth', gate: 34, line: 2 }, { planet: 'moon', gate: 20, line: 3 }],
    personality: [{ planet: 'sun', gate: 29, line: 1 }, { planet: 'earth', gate: 46, line: 2 }, { planet: 'moon', gate: 20, line: 2 }],
  },
};
const sectionNames = html => [...html.matchAll(/data-summary-section="([^"]+)"/g)].map(match => match[1]);
const plain = value => JSON.parse(JSON.stringify(value));

test('four summary sections render saved counts, unique gates and disclosure state', () => {
  const html = renderSummarySections(buildChartSummary(chart));
  assert.deepEqual(sectionNames(html), ['lines', 'centers', 'channels', 'gates']);
  assert.match(html, /data-summary-section="lines" open/);
  assert.doesNotMatch(html, /data-summary-section="centers" open/);
  assert.match(html, /aria-label="Линия 2, Дизайн: 2"/);
  assert.match(html, /aria-label="Линия 2, Личность: 2"/);
  assert.match(html, /aria-label="Линия 2, Всего: 4"/);
  assert.match(html, /data-summary-line="6"[^>]+disabled/);
  assert.equal([...html.matchAll(/data-summary-type="gate" data-summary-id="34"/g)].length, 1);
  assert.match(html, /Каждая активация считается отдельно, включая лунные узлы/);
});

test('transit renders one column without natal design or total columns', () => {
  const model = buildChartSummary({ ...chart, source: 'transit', design: [], activations: { design: [], personality: chart.activations.personality } });
  const html = renderSummarySections(model);
  assert.match(html, /class="summary-lines is-transit"/);
  assert.match(html, /aria-label="Линия 2, Транзит: 2"/);
  assert.doesNotMatch(html, /data-summary-source="(?:design|all)"/);
  assert.equal([...html.matchAll(/data-summary-source="personality"/g)].length, 6);
});

test('manual charts display the missing-line explanation and no count buttons', () => {
  const html = renderSummarySections(buildChartSummary({ source: 'manual', design: [34], personality: [20] }));
  assert.deepEqual(sectionNames(html), ['lines', 'centers', 'channels', 'gates']);
  assert.match(html, /Для подсчёта линий нужны планетарные активации/);
  assert.doesNotMatch(html, /data-summary-line=/);
  assert.match(html, /summary-section-count">—</);
  assert.match(renderSummarySections(buildChartSummary({source: 'manual'}), 'неизвестное'), /Ничего не найдено/);
});

test('search normalizes case, spaces and ё while opening matching sections', () => {
  const model = buildChartSummary(chart);
  const html = renderSummarySections(model, '  СЕЛЕЗЕНОЧНЫЙ  ', new Set());
  assert.deepEqual(sectionNames(html), ['centers']);
  assert.match(html, /data-summary-section="centers" open/);
  assert.match(html, /data-summary-id="spleen"/);
  assert.doesNotMatch(html, /data-summary-id="head"/);
  assert.deepEqual(sectionNames(renderSummarySections(model, 'линии')), ['lines']);
  assert.match(renderSummarySections(model, 'несуществующее'), /Ничего не найдено/);
});

test('entity text and attribute values are escaped, query is never reflected as markup', () => {
  const model = buildChartSummary(chart);
  const attack = '"><img src=x onerror="oops">&\'';
  model.centers[0].name = attack;
  model.centers[0].id = attack;
  model.channels[0].name = attack;
  model.gates[0].name = attack;
  const html = renderSummarySections(model);
  assert.doesNotMatch(html, /<img|onerror="oops"/);
  assert.match(html, /&quot;&gt;&lt;img src=x onerror=&quot;oops&quot;&gt;&amp;&#39;/);
  assert.doesNotMatch(renderSummarySections(model, '<svg onload="oops">'), /<svg|onload=/);
});

// Exercise the imported public controller with its DOM contract. No source
// rewriting, application bootstrap, storage or real saved charts are needed.
function harness({ width = 1440, input = chart, withBackdrop = true, callbacks = true } = {}) {
  const globals = { activeElement: null, dialogOpen: false, libraryOpen: false };
  let document;
  function node(tag = 'div', attributes = {}) {
    const attrs = new Map(), classes = new Set(), listeners = new Map();
    let markup = '';
    const element = {
      tagName: tag.toUpperCase(), dataset: {}, parentElement: null, children: [], hidden: false, inert: false,
      value: '', scrollTop: 0, disabled: false, open: false,
      get ownerDocument() { return document; },
      classList: {
        toggle(name, force) { const next = force ?? !classes.has(name); if (next) classes.add(name); else classes.delete(name); return next; },
        contains(name) { return classes.has(name); },
      },
      setAttribute(name, value) {
        attrs.set(name, String(value));
        if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
      },
      getAttribute(name) { return attrs.get(name) ?? null; },
      addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(handler); },
      dispatch(type, options = {}) {
        const event = { target: this, defaultPrevented: false, shiftKey: false, preventDefault() { this.defaultPrevented = true; }, ...options };
        for (const handler of listeners.get(type) || []) handler(event);
        return event;
      },
      focus(options) { globals.activeElement = this; this.focusOptions = options; },
      contains(other) { for (let current = other; current; current = current.parentElement) if (current === this) return true; return false; },
      matches(selector) {
        if (selector === 'button') return this.tagName === 'BUTTON';
        const attribute = selector.match(/^\[([^\]]+)\]$/)?.[1];
        return attribute ? attrs.has(attribute) : false;
      },
      closest(selector) { for (let current = this; current; current = current.parentElement) if (current.matches(selector)) return current; return null; },
      querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
      get innerHTML() { return markup; },
      set innerHTML(html) {
        markup = html;
        this.children = [...html.matchAll(/<(button|details)\b([^>]*)>/g)].map(match => {
          const child = node(match[1]);
          child.parentElement = this;
          for (const [, name, value] of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) child.setAttribute(name, value);
          child.disabled = /\bdisabled\b/.test(match[2]);
          child.open = /\bopen\b/.test(match[2]);
          return child;
        });
      },
    };
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    return element;
  }
  const studio = node(), panel = node(), content = node(), overview = node(), search = node('input');
  const switcher = node('button', { 'aria-controls': 'chartSummary', 'aria-expanded': 'false' });
  const backdrop = withBackdrop ? node() : null;
  const canvas = node('svg');
  const camera = Object.freeze({ transform: 'translate(17 31) scale(1.4)', viewBox: '-65 20 770 820' });
  canvas.setAttribute('viewBox', camera.viewBox);
  canvas.setAttribute('data-camera', camera.transform);
  canvas.innerHTML = '<g class="bodygraph-camera" transform="translate(17 31) scale(1.4)"></g>';
  canvas.querySelector = () => { throw new Error('The drawer must not measure or inspect the chart'); };
  panel.parentElement = studio;
  search.parentElement = content.parentElement = overview.parentElement = panel;
  panel.children = [overview, search, content];
  document = node();
  Object.defineProperty(document, 'activeElement', { get: () => globals.activeElement });
  document.querySelector = selector => selector === 'dialog[open]' && globals.dialogOpen || selector === '.library.open' && globals.libraryOpen ? {} : null;
  const window = node(); window.innerWidth = width;
  document.defaultView = window;
  let openCalls = 0, closeCalls = 0;
  const lineCalls = [], lineOptions = [], selectionCalls = [];
  const config = {
    panel, content, overview, search, switcher, canvas, backdrop,
    onLines(gates, filter, options) { lineCalls.push(plain({ gates, filter })); lineOptions.push(plain(options)); },
    onSelect(value) { selectionCalls.push(plain(value)); },
  };
  if (callbacks) {
    config.onOpen = () => { openCalls++; globals.libraryOpen = false; };
    config.onClose = () => { closeCalls++; };
  }
  const controller = attachChartSummary(config);
  controller.update(input);
  const click = (target, options = {}) => content.dispatch('click', { target, ...options });
  const mode = value => value === 'summary' ? controller.open() : controller.close();
  const lineButton = (line, source = 'all') => content.querySelectorAll('[data-summary-line]').find(button => button.dataset.summaryLine === String(line) && button.dataset.summarySource === source);
  const entityButton = (type, id) => content.querySelectorAll('[data-summary-type]').find(button => button.dataset.summaryType === type && button.dataset.summaryId === String(id));
  const searchFor = value => { search.value = value; search.dispatch('input'); };
  const disclosure = (id, open) => { const section = content.querySelectorAll('[data-summary-section]').find(section => section.dataset.summarySection === id); assert.ok(section); section.open = open; content.dispatch('toggle', { target: section }); };
  return {
    controller, globals, document, window, panel, content, overview, search, switcher, canvas, camera, studio, backdrop,
    lineCalls, lineOptions, selectionCalls, click, mode, lineButton, entityButton, searchFor, disclosure,
    resize(value) { window.innerWidth = value; window.dispatch('resize'); controller.layout(); },
    get openCalls() { return openCalls; },
    get closeCalls() { return closeCalls; },
  };
}

test('line count clicks dispatch unique gates and repeat clicks remain an app decision', () => {
  const h = harness();
  h.mode('summary');
  h.click(h.lineButton(2));
  h.click(h.lineButton(2));
  assert.deepEqual(h.lineCalls, [
    { gates: [20, 34, 46], filter: { line: 2, source: 'all' } },
    { gates: [20, 34, 46], filter: { line: 2, source: 'all' } },
  ]);
  assert.equal(h.controller.opened, true, 'wide-screen drawer stays open after selection');
  assert.equal(h.lineButton(2).getAttribute('aria-pressed'), 'false', 'controller does not invent pinned selection state');
  h.controller.update(chart, { filter: { line: 2, source: 'all' } });
  assert.equal(h.lineButton(2).getAttribute('aria-pressed'), 'true');
  assert.equal(h.lineButton(2, 'design').getAttribute('aria-pressed'), 'false');
  h.controller.update(chart);
  assert.equal(h.lineButton(2).getAttribute('aria-pressed'), 'false');
});

test('source-specific counts and entity clicks delegate exact selection intent', () => {
  const h = harness();
  h.click(h.lineButton(2, 'design'));
  h.click(h.lineButton(2, 'personality'));
  assert.deepEqual(h.lineCalls.map(call => call.gates), [[34], [20, 46]]);
  h.click(h.entityButton('gate', 34), { shiftKey: true });
  h.click(h.entityButton('center', 'sacral'));
  assert.deepEqual(h.selectionCalls, [
    { type: 'gate', id: '34', additive: true },
    { type: 'center', id: 'sacral', additive: false },
  ]);
  h.controller.update(chart, { items: [{ type: 'gate', id: 34 }] });
  assert.equal(h.entityButton('gate', 34).getAttribute('aria-pressed'), 'true');
  assert.equal(h.entityButton('center', 'sacral').getAttribute('aria-pressed'), 'false');
  h.click(h.lineButton(6));
  assert.equal(h.lineCalls.length, 2, 'disabled empty counts do not dispatch');
});

test('Shift counts carry additive intent and several selected line groups stay pressed', () => {
  const h = harness();
  h.click(h.lineButton(2, 'design'));
  h.click(h.lineButton(3, 'design'), { shiftKey: true });
  assert.deepEqual(h.lineOptions, [{ additive: false }, { additive: true }]);
  h.controller.update(chart, { filter: { groups: [{ line: 2, source: 'design' }, { line: 3, source: 'design' }], unfilteredGates: [] } });
  assert.equal(h.lineButton(2, 'design').getAttribute('aria-pressed'), 'true');
  assert.equal(h.lineButton(3, 'design').getAttribute('aria-pressed'), 'true');
  assert.equal(h.lineButton(2, 'personality').getAttribute('aria-pressed'), 'false');
});

test('single button toggles the accessible overlay and focuses search without scrolling', () => {
  const h = harness();
  assert.equal(h.controller.opened, false);
  assert.equal(h.panel.inert, true);
  assert.equal(h.panel.getAttribute('aria-hidden'), 'true');
  assert.equal(h.backdrop.hidden, true);
  assert.equal(h.switcher.getAttribute('aria-expanded'), 'false');
  assert.equal(h.panel.hidden, false, 'CSS can animate the rendered drawer in both directions');
  h.globals.libraryOpen = true;
  h.switcher.dispatch('click');
  assert.equal(h.controller.opened, true);
  assert.equal(h.panel.classList.contains('open'), true);
  assert.equal(h.panel.inert, false);
  assert.equal(h.panel.getAttribute('aria-hidden'), 'false');
  assert.equal(h.backdrop.hidden, false);
  assert.equal(h.switcher.getAttribute('aria-expanded'), 'true');
  assert.equal(h.globals.activeElement, h.search);
  assert.deepEqual(h.search.focusOptions, { preventScroll: true });
  assert.equal(h.globals.libraryOpen, false, 'opening invokes coordination with the other drawer');
  assert.equal(h.openCalls, 1);
  h.controller.open();
  assert.equal(h.openCalls, 1, 'opening an open drawer does not repeat side effects');
  h.switcher.dispatch('click');
  assert.equal(h.controller.opened, false);
  assert.equal(h.panel.classList.contains('open'), false);
  assert.equal(h.panel.inert, true);
  assert.equal(h.panel.getAttribute('aria-hidden'), 'true');
  assert.equal(h.backdrop.hidden, true);
  assert.equal(h.switcher.getAttribute('aria-expanded'), 'false');
  assert.equal(h.globals.activeElement, h.switcher);
  assert.deepEqual(h.switcher.focusOptions, { preventScroll: true });
  assert.equal(h.closeCalls, 1);
  h.controller.close();
  assert.equal(h.closeCalls, 1, 'closing a closed drawer does not repeat side effects');
});

test('opening, resizing and closing never measure, hide, disable or transform the chart', () => {
  for (const width of [390, 850, 1440]) {
    const h = harness({ width });
    const markup = h.canvas.innerHTML;
    for (const operation of [h.controller.open, () => h.resize(800), h.controller.layout, () => h.resize(1440), h.controller.close]) {
      operation();
      assert.equal(h.canvas.inert, false);
      assert.equal(h.canvas.hidden, false);
      assert.equal(h.studio.classList.contains('summary-reading-mode'), false);
      assert.equal(h.panel.classList.contains('is-reading-mode'), false);
      assert.equal(h.canvas.innerHTML, markup);
      assert.equal(h.canvas.getAttribute('viewBox'), h.camera.viewBox);
      assert.equal(h.canvas.getAttribute('data-camera'), h.camera.transform);
    }
  }
});

test('manual charts open without inspecting diagram bounds', () => {
  const h = harness({ width: 390, input: { id: 'manual', source: 'manual', design: [34], personality: [20] } });
  h.controller.open();
  assert.equal(h.controller.opened, true);
  assert.equal(h.canvas.inert, false);
  assert.match(h.content.innerHTML, /Для подсчёта линий нужны планетарные активации/);
});

test('ordinary narrow-screen selection closes the drawer; Shift selection keeps it open', () => {
  for (const width of [390, 850]) {
    const h = harness({ width });
    h.controller.open();
    h.click(h.lineButton(2), { shiftKey: true });
    h.click(h.entityButton('gate', 34), { shiftKey: true });
    assert.equal(h.controller.opened, true);
    h.click(h.lineButton(2));
    assert.equal(h.controller.opened, false);
    assert.equal(h.globals.activeElement, h.switcher);
    h.controller.open();
    h.click(h.entityButton('center', 'sacral'));
    assert.equal(h.controller.opened, false);
  }
  const h = harness({ width: 851 });
  h.controller.open();
  h.click(h.entityButton('gate', 34));
  assert.equal(h.controller.opened, true);
});

test('backdrop closes and restores focus from anywhere inside the panel', () => {
  const h = harness();
  h.controller.open();
  h.entityButton('gate', 34).focus();
  h.backdrop.dispatch('click');
  assert.equal(h.controller.opened, false);
  assert.equal(h.globals.activeElement, h.switcher);
});

test('programmatic close preserves outside focus unless explicitly asked to restore it', () => {
  const h = harness();
  h.controller.open();
  h.canvas.focus();
  h.controller.close();
  assert.equal(h.globals.activeElement, h.canvas);
  h.controller.toggle();
  assert.equal(h.globals.activeElement, h.search);
  h.canvas.focus();
  h.controller.close({ focus: true });
  assert.equal(h.globals.activeElement, h.switcher);
});

test('optional backdrop and lifecycle callbacks are not required', () => {
  const h = harness({ withBackdrop: false, callbacks: false });
  h.controller.toggle();
  assert.equal(h.controller.opened, true);
  h.controller.toggle();
  assert.equal(h.controller.opened, false);
});

test('Escape closes summary unless a dialog, drawer or earlier handler owns the event', () => {
  const h = harness({ width: 390 });
  h.mode('summary');
  h.document.dispatch('keydown', { key: 'Enter' });
  assert.equal(h.controller.opened, true);
  for (const blocker of ['dialogOpen', 'libraryOpen']) {
    h.globals[blocker] = true;
    const event = h.document.dispatch('keydown', { key: 'Escape' });
    assert.equal(h.controller.opened, true);
    assert.equal(event.defaultPrevented, false);
    h.globals[blocker] = false;
  }
  h.document.dispatch('keydown', { key: 'Escape', defaultPrevented: true });
  assert.equal(h.controller.opened, true);
  const event = h.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.controller.opened, false);
  assert.equal(h.canvas.inert, false);
  assert.equal(h.globals.activeElement, h.switcher);
});

test('single native button does not consume obsolete segmented-control arrow shortcuts', () => {
  const h = harness();
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab']) {
    assert.equal(h.switcher.dispatch('keydown', { key }).defaultPrevented, false);
    assert.equal(h.controller.opened, false);
  }
});

test('expanded sections persist through chart updates and search does not overwrite them', () => {
  const h = harness();
  h.disclosure('lines', false);
  h.disclosure('gates', true);
  h.searchFor('центры');
  h.disclosure('centers', false);
  h.searchFor('');
  let expanded = h.content.querySelectorAll('[data-summary-section]').filter(section => section.open).map(section => section.dataset.summarySection);
  assert.deepEqual(expanded, ['gates']);
  const next = { ...chart, id: 'next-chart', design: [34], activations: { ...chart.activations, design: chart.activations.design.slice(0, 2) } };
  h.controller.update(next);
  expanded = h.content.querySelectorAll('[data-summary-section]').filter(section => section.open).map(section => section.dataset.summarySection);
  assert.deepEqual(expanded, ['gates']);
});

test('search and scroll reset between charts but not for selection-only updates', () => {
  const h = harness();
  h.searchFor('ворота');
  h.content.scrollTop = 83;
  h.controller.update(chart, { items: [{ type: 'gate', id: 34 }] });
  assert.equal(h.search.value, 'ворота');
  assert.equal(h.content.scrollTop, 83);
  assert.deepEqual(sectionNames(h.content.innerHTML), ['gates']);
  h.controller.update({ ...chart, id: 'other-chart' });
  assert.equal(h.search.value, '');
  assert.equal(h.content.scrollTop, 0);
  assert.deepEqual(sectionNames(h.content.innerHTML), ['lines', 'centers', 'channels', 'gates']);
  assert.match(h.overview.innerHTML, /Профиль <strong>1\/2<\/strong>/);
});

test('transit refresh with only coordinates changed preserves disclosure and search', () => {
  const transit = { ...chart, id: 'transit', source: 'transit', design: [], activations: { design: [], personality: chart.activations.personality } };
  const h = harness({ input: transit });
  assert.match(h.overview.innerHTML, /Транзит/);
  assert.doesNotMatch(h.overview.innerHTML, /Профиль/);
  h.disclosure('gates', true);
  h.searchFor('линии');
  const html = h.content.innerHTML;
  h.controller.update({ ...transit, activations: { design: [], personality: transit.activations.personality.map(row => ({ ...row, longitude: 123 })) } });
  assert.equal(h.search.value, 'линии');
  assert.equal(h.content.innerHTML, html);
});
