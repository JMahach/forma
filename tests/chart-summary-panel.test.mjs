import test from 'node:test';
import assert from 'node:assert/strict';
import { overlayFixture } from './helpers/chart-composition.mjs';
import { createChartComposition } from '../src/domain/chart-composition.js';
import { buildChartSummary } from '../src/views/chart-summary-data.js';
import { attachChartSummary, renderSummarySections } from '../src/views/chart-summary-panel.js';
import { createGraphController } from '../src/scene/updates.js';
import { createTransitPlanetFilter } from '../src/state/transit-planets.js';
import { PLANET_IDS } from '../src/domain/planets.js';

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

for (const scenario of [
  { name: 'Day P-only', expanded: false, design: false, personality: true },
  { name: 'Day P+D', expanded: false, design: true, personality: true },
  { name: 'Lifetime P-only', expanded: true, design: false, personality: true },
  { name: 'Lifetime P+D', expanded: true, design: true, personality: true },
  { name: 'Lifetime D-only', expanded: true, design: true, personality: false },
]) test(`transit line summary follows accepted sources: ${scenario.name}`, () => {
  const activations = {
    personality: PLANET_IDS.map((planet, index) => ({ planet, gate: 1 + index % 3, line: 1 + index % 6 })),
    design: PLANET_IDS.map((planet, index) => ({ planet, gate: 20 + index % 4, line: 1 + (index + 2) % 6 })),
  };
  const moment = { id: 'current-transit', source: 'transit', activations,
    personality: [1, 2, 3], design: [20, 21, 22, 23] };
  const filter = createTransitPlanetFilter();
  filter.setExpanded(scenario.expanded);
  filter.setAllPlanets(scenario.design, 'design');
  if (!scenario.personality) filter.setAllPlanets(false, 'personality');
  const accepted = createChartComposition(filter.filter(moment));
  const h = harness({ input: accepted });
  h.controller.open();
  const html = h.content.innerHTML.match(/data-summary-section="lines"[\s\S]*?<\/details>/)[0];
  const buttons = [...html.matchAll(/<button[^>]*data-summary-line="(\d)"[^>]*data-summary-source="(\w+)"[^>]*>(\d+)<\/button>/g)];
  const sources = ['design', 'personality'].filter(source => scenario[source]);
  const columns = sources.length === 2 ? [...sources, 'all'] : sources;
  const total = sources.length * PLANET_IDS.length;
  assert.equal(Number(html.match(/summary-section-count">(\d+)</)[1]), total);
  assert.deepEqual([...new Set(buttons.map(button => button[2]))], columns);
  assert.equal(buttons.filter(button => button[2] !== 'all').reduce((sum, button) => sum + Number(button[3]), 0), total);
  assert.equal(html.includes('summary-lines is-transit'), sources.length === 1, 'single and dual sources use their existing table layouts');
  if (scenario.design) assert.match(html, /role="columnheader" class="summary-design">Дизайн</);
  for (const [, lineText, source, countText] of buttons) {
    const line = Number(lineText);
    const rows = (source === 'all' ? sources.flatMap(side => activations[side]) : activations[source]).filter(row => row.line === line);
    assert.equal(Number(countText), rows.length);
    const button = h.lineButton(line, source);
    assert.equal(button.disabled, rows.length === 0);
    if (!rows.length) continue;
    h.click(button);
    assert.deepEqual(h.lineCalls.at(-1), {
      gates: [...new Set(rows.map(row => row.gate))].sort((a, b) => a - b), filter: { line, source },
    });
    h.controller.update(accepted, { filter: { line, source } });
    assert.equal(button.getAttribute('aria-pressed'), 'true');
  }
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
      value: '', scrollTop: 0, disabled: false, open: false, markupWrites: 0,
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
        this.markupWrites++;
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
  const studio = node(), panel = node('aside', { 'aria-labelledby': 'chartSummaryTitle' });
  const summaryScreen = node(), returnsPanel = node('section', { 'aria-labelledby': 'returnsTitle' });
  const returnsBack = node('button');
  const content = node(), overview = node(), search = node('input');
  const switcher = node('button', { 'aria-controls': 'chartSummary', 'aria-expanded': 'false' });
  const backdrop = withBackdrop ? node() : null;
  const canvas = node('svg');
  const camera = Object.freeze({ transform: 'translate(17 31) scale(1.4)', viewBox: '-65 20 770 820' });
  canvas.setAttribute('viewBox', camera.viewBox);
  canvas.setAttribute('data-camera', camera.transform);
  canvas.innerHTML = '<g class="bodygraph-camera" transform="translate(17 31) scale(1.4)"></g>';
  canvas.querySelector = () => { throw new Error('The drawer must not measure or inspect the chart'); };
  panel.parentElement = studio;
  summaryScreen.parentElement = returnsPanel.parentElement = panel;
  search.parentElement = content.parentElement = overview.parentElement = summaryScreen;
  returnsBack.parentElement = returnsPanel;
  summaryScreen.children = [overview, search, content];
  returnsPanel.children = [returnsBack]; returnsPanel.hidden = true;
  panel.children = [summaryScreen, returnsPanel];
  document = node();
  Object.defineProperty(document, 'activeElement', { get: () => globals.activeElement });
  document.querySelector = selector => selector === 'dialog[open]' && globals.dialogOpen || selector === '.library.open' && globals.libraryOpen ? {} : null;
  const window = node(); window.innerWidth = width;
  document.defaultView = window;
  let openCalls = 0, closeCalls = 0;
  const lineCalls = [], lineOptions = [], selectionCalls = [];
  const config = {
    panel, summaryScreen, returnsPanel, content, overview, search, switcher, backdrop,
    onLines(gates, filter, options) { lineCalls.push(plain({ gates, filter })); lineOptions.push(plain(options)); },
    onSelect(value) { selectionCalls.push(plain(value)); },
  };
  if (callbacks) {
    config.onOpen = () => { openCalls++; globals.libraryOpen = false; controller.setReturnsVisible(false); };
    config.onClose = () => { closeCalls++; controller.setReturnsVisible(false); };
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
    controller, globals, document, window, panel, summaryScreen, returnsPanel, returnsBack,
    content, overview, search, switcher, canvas, camera, studio, backdrop,
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
  h.controller.open();
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
  h.controller.open();
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
  h.controller.open();
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
  h.controller.open();
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
  h.controller.open();
  assert.match(h.overview.innerHTML, /Транзит/);
  assert.doesNotMatch(h.overview.innerHTML, /Профиль/);
  h.disclosure('gates', true);
  h.searchFor('линии');
  const html = h.content.innerHTML;
  h.controller.update({ ...transit, activations: { design: [], personality: transit.activations.personality.map(row => ({ ...row, longitude: 123 })) } });
  assert.equal(h.search.value, 'линии');
  assert.equal(h.content.innerHTML, html);
});

function observeLayoutWrites(h) {
  const writes = [];
  for (const [element, property] of [[h.panel, 'hidden'], [h.panel, 'inert'], [h.backdrop, 'hidden']]) {
    let value = element[property];
    Object.defineProperty(element, property, {
      get: () => value,
      set(next) { writes.push(property); value = next; },
    });
  }
  for (const [element, method] of [[h.panel, 'setAttribute'], [h.switcher, 'setAttribute'], [h.panel.classList, 'toggle']]) {
    const original = element[method];
    element[method] = function (...args) { writes.push(args[0]); return original.apply(this, args); };
  }
  return writes;
}

test('camera layout repeats perform no DOM writes, including after resize and close', () => {
  const h = harness(), writes = observeLayoutWrites(h);
  for (const opened of [false, true, false]) {
    if (opened) h.controller.open(); else h.controller.close();
    writes.length = 0;
    for (let i = 0; i < 1000; i++) h.controller.layout();
    assert.equal(writes.length, 0, `unchanged ${opened ? 'open' : 'closed'} drawer does not rewrite DOM`);
    h.resize(opened ? 390 : 1440);
    assert.equal(writes.length, 0, 'responsive CSS does not require repeating drawer state writes');
    assert.equal(h.panel.hidden, false, 'closing transition retains the rendered panel');
    assert.equal(h.panel.inert, !opened);
    assert.equal(h.panel.classList.contains('open'), opened);
    assert.equal(h.backdrop.hidden, !opened);
  }
  assert.equal(h.openCalls, 1);
  assert.equal(h.closeCalls, 1);
  assert.equal(h.globals.activeElement, h.switcher);
});

test('selection updates write only changed aria state and preserve focused buttons', () => {
  const h = harness(), writes = [];
  h.controller.open();
  const buttons = [...h.content.querySelectorAll('[data-summary-line]'), ...h.content.querySelectorAll('[data-summary-type]')];
  for (const button of buttons) {
    const original = button.setAttribute;
    button.setAttribute = function (name, value) { writes.push({ button, name, value }); original.call(this, name, value); };
  }
  const selected = { items: [{ type: 'gate', id: 34 }], filter: { line: 2, source: 'design' } };
  h.entityButton('gate', 34).focus();
  for (let i = 0; i < 1000; i++) h.controller.update(chart);
  assert.equal(writes.length, 0, 'unchanged unselected buttons are not rewritten');
  h.controller.update(chart, selected);
  assert.deepEqual(writes.map(write => write.button), [h.lineButton(2, 'design'), h.entityButton('gate', 34)]);
  writes.length = 0;
  for (let i = 0; i < 1000; i++) h.controller.update(chart, selected);
  assert.equal(writes.length, 0, 'unchanged selected buttons are not rewritten');
  assert.equal(h.globals.activeElement, h.entityButton('gate', 34));
  h.controller.update(chart);
  assert.equal(writes.length, 2, 'clearing selection updates both previously selected buttons');
  assert.ok(writes.every(write => write.name === 'aria-pressed' && write.value === 'false'));
});

test('reopening applies changed chart data while preserving same-chart search and scroll', () => {
  const h = harness();
  h.controller.open(); h.searchFor('линии'); h.content.scrollTop = 83; h.controller.close();
  const next = { ...chart, activations: { ...chart.activations,
    design: chart.activations.design.map(row => row.planet === 'sun' ? { ...row, line: 4 } : row),
  } };
  h.controller.update(next, { filter: { line: 4, source: 'design' } });
  assert.equal(h.controller.opened, false);
  assert.equal(h.panel.hidden, false);
  assert.equal(h.panel.inert, true);
  assert.equal(h.search.value, 'линии');
  assert.equal(h.content.scrollTop, 83);
  assert.equal(h.lineButton(4, 'design').disabled, true, 'closing keeps the previous markup');
  assert.equal(h.globals.activeElement, h.switcher);
  h.controller.open();
  assert.equal(h.lineButton(4, 'design').disabled, false);
  assert.equal(h.lineButton(4, 'design').getAttribute('aria-pressed'), 'true');
  assert.match(h.overview.innerHTML, /Профиль <strong>1\/4<\/strong>/);
  assert.equal(h.globals.activeElement, h.search);
  assert.equal(h.lineButton(4, 'design').getAttribute('aria-pressed'), 'true');
});


test('closed summary defers chart inspection and markup until opened, then uses the latest chart', () => {
  const h = harness();
  let reads = 0;
  for (let line = 1; line <= 6; line++) {
    const next = { ...chart, id: 'last-chart' };
    Object.defineProperty(next, 'activations', { get() {
      reads++;
      return { ...chart.activations, personality: [{ planet: 'sun', gate: 29, line }] };
    } });
    h.controller.update(next, { items: [{ type: 'gate', id: 34 }] });
  }
  assert.equal(reads, 0, 'a closed drawer must not inspect activation data');
  assert.equal(h.content.markupWrites, 0);
  assert.equal(h.overview.markupWrites, 0);
  h.controller.open();
  assert.equal(h.content.markupWrites, 1);
  assert.equal(h.overview.markupWrites, 1);
  assert.match(h.overview.innerHTML, /Профиль <strong>6\/2<\/strong>/);
  assert.equal(h.entityButton('gate', 34).getAttribute('aria-pressed'), 'true');
});

test('closed updates preserve old markup for the closing animation and render the latest view on reopen', () => {
  const h = harness();
  h.controller.open();
  h.disclosure('gates', true);
  h.searchFor('ворота');
  h.content.scrollTop = 75;
  h.controller.close();
  const html = h.content.innerHTML, writes = h.content.markupWrites;
  h.controller.update({ ...chart, id: 'other-chart', personality: [29] });
  h.controller.update({ ...chart, id: 'other-chart', personality: [46] });
  assert.equal(h.content.innerHTML, html);
  assert.equal(h.content.markupWrites, writes);
  h.controller.open();
  assert.equal(h.content.markupWrites, writes + 1);
  assert.equal(h.search.value, '');
  assert.equal(h.content.scrollTop, 0);
  assert.equal(h.entityButton('gate', 29), undefined);
  assert.ok(h.entityButton('gate', 46));
  assert.ok(h.content.querySelectorAll('[data-summary-section]').find(x => x.dataset.summarySection === 'gates').open);
});

test('reopening the same chart keeps search and scroll while applying selection received when closed', () => {
  const h = harness();
  h.controller.open();
  h.searchFor('ворота');
  h.content.scrollTop = 91;
  h.controller.close();
  const writes = h.content.markupWrites;
  h.controller.update(chart, { items: [{ type: 'gate', id: 34 }] });
  h.controller.open();
  assert.equal(h.content.markupWrites, writes);
  assert.equal(h.search.value, 'ворота');
  assert.equal(h.content.scrollTop, 91);
  assert.equal(h.entityButton('gate', 34).getAttribute('aria-pressed'), 'true');
});

test('the panel owns summary facts and unchanged selection avoids DOM queries during scene hover', () => {
  const current = plain(chart), h = harness({ input: current });
  let activationReads = 0, queries = 0;
  const activations = current.activations;
  Object.defineProperty(current, 'activations', { get() { activationReads++; return activations; } });
  const query = h.content.querySelectorAll.bind(h.content);
  h.content.querySelectorAll = selector => { queries++; return query(selector); };
  const selection = { items: [], primary: null, activationFilter: null };
  const graph = createGraphController({ getChart: () => current, selectionState: selection,
    viewport: {}, scene: { update() {}, clear() {} }, getSummary: () => h.controller,
    activationPopover: { refresh() {}, close() {} } });
  for (let hover = 0; hover < 50; hover++) graph.render();
  assert.equal(activationReads, 0, 'the scene must not inspect facts for a closed summary');
  assert.equal(queries, 0); assert.equal(h.content.markupWrites, 0);
  h.controller.open(); queries = 0;
  const writes = h.content.markupWrites, focused = h.entityButton('gate', 34); focused.focus(); queries = 0; activationReads = 0;
  for (let hover = 0; hover < 50; hover++) graph.render();
  assert.equal(activationReads, 100, 'only the panel checks the two activation sources on each visible update');
  assert.equal(queries, 0, 'unchanged visible selection needs no repeated DOM scan');
  assert.equal(h.content.markupWrites, writes); assert.equal(h.globals.activeElement, focused);
  selection.items.push({ type: 'gate', id: 34 });
  graph.render(); assert.equal(queries, 2); assert.equal(focused.getAttribute('aria-pressed'), 'true');
  selection.items = selection.items.map(item => ({ ...item }));
  graph.render(); assert.equal(queries, 2, 'equal copied selection values do not trigger another DOM scan');
  selection.activationFilter = { line: 2, source: 'design' };
  graph.render(); assert.equal(h.lineButton(2, 'design').getAttribute('aria-pressed'), 'true');
  selection.activationFilter.line = 3;
  graph.render(); assert.equal(h.lineButton(2, 'design').getAttribute('aria-pressed'), 'false');
  assert.equal(h.lineButton(3, 'design').getAttribute('aria-pressed'), 'true');
  activations.design[0].line = 4;
  graph.render(); assert.equal(h.content.markupWrites, writes + 1, 'mutable chart facts still rebuild the model');
  assert.match(h.overview.innerHTML, /Профиль <strong>1\/4<\/strong>/);
  assert.equal(h.entityButton('gate', 34).getAttribute('aria-pressed'), 'true');
});


test('compositions keep summary lazy and name the real natal lines beside the union topology', () => {
  let reads = 0;
  const natal = { ...chart, name: 'Анна <svg>' };
  Object.defineProperty(natal, 'activations', { get() { reads++; return chart.activations; } });
  const moment = { id: 'moment', source: 'transit', personality: [63, 4], design: [],
    activations: { personality: [{ planet: 'sun', gate: 63, line: 6 }], design: [] } };
  const h = harness({ input: createChartComposition(natal) });
  h.controller.update(overlayFixture(natal, moment, { kind: 'transit' }));
  assert.equal(reads, 0);
  assert.equal(h.content.markupWrites, 0);
  h.controller.open();
  assert.match(h.overview.innerHTML, /Топология наложения/);
  assert.match(h.content.innerHTML, /Линии: Анна &lt;svg&gt;/);
  assert.doesNotMatch(h.content.innerHTML, /<svg>|Транзит/);
  assert.equal(h.lineButton(2, 'design').disabled, false);
  assert.equal(h.lineButton(6, 'personality').disabled, true);
  assert.ok(h.entityButton('gate', 63));
});

test('returns alone opens the shared shell without opening or rendering the summary', () => {
  const h = harness();
  h.switcher.focus();
  assert.equal(typeof h.controller.setReturnsVisible, 'function');
  h.controller.setReturnsVisible(true);
  assert.equal(h.controller.opened, true);
  assert.equal(h.controller.screen, 'returns');
  assert.equal(h.panel.dataset.screen, 'returns');
  assert.equal(h.panel.classList.contains('open'), true);
  assert.equal(h.panel.inert, false);
  assert.equal(h.panel.getAttribute('aria-hidden'), 'false');
  assert.equal(h.panel.getAttribute('aria-labelledby'), 'returnsTitle');
  assert.equal(h.summaryScreen.hidden, true);
  assert.equal(h.returnsPanel.hidden, false);
  assert.equal(h.backdrop.hidden, false);
  assert.equal(h.switcher.getAttribute('aria-expanded'), 'true');
  assert.equal(h.globals.activeElement, h.switcher, 'the returns view chooses its own initial focus');
  assert.equal(h.content.markupWrites, 0);
  assert.equal(h.openCalls, 0);
  assert.equal(h.closeCalls, 0);
});

test('Back to summary preserves search, disclosure, scroll and the existing DOM', () => {
  const h = harness();
  h.controller.open(); h.disclosure('gates', true); h.searchFor('ворота');
  h.content.scrollTop = 91;
  const gate = h.entityButton('gate', 34), writes = h.content.markupWrites;
  h.controller.close(); h.controller.setReturnsVisible(true);
  h.returnsBack.focus();
  h.controller.open();
  assert.equal(h.controller.screen, 'summary');
  assert.equal(h.controller.opened, true);
  assert.equal(h.panel.dataset.screen, 'summary');
  assert.equal(h.panel.getAttribute('aria-labelledby'), 'chartSummaryTitle');
  assert.equal(h.summaryScreen.hidden, false);
  assert.equal(h.returnsPanel.hidden, true);
  assert.equal(h.search.value, 'ворота');
  assert.equal(h.content.scrollTop, 91);
  assert.equal(h.content.markupWrites, writes);
  assert.equal(h.entityButton('gate', 34), gate);
  assert.equal(h.globals.activeElement, h.search);
  h.searchFor('');
  assert.ok(h.content.querySelectorAll('[data-summary-section]').find(x => x.dataset.summarySection === 'gates').open);
});

test('closing a returns-only shell closes its owner once and keeps content for the exit animation', () => {
  for (const dismiss of [h => h.controller.close(), h => h.switcher.dispatch('click'), h => h.backdrop.dispatch('click')]) {
    const h = harness();
    h.controller.setReturnsVisible(true); h.returnsBack.focus();
    dismiss(h);
    assert.equal(h.controller.screen, 'closed');
    assert.equal(h.controller.opened, false);
    assert.equal(h.panel.classList.contains('open'), false);
    assert.equal(h.panel.inert, true);
    assert.equal(h.panel.getAttribute('aria-hidden'), 'true');
    assert.equal(h.backdrop.hidden, true);
    assert.equal(h.switcher.getAttribute('aria-expanded'), 'false');
    assert.equal(h.panel.dataset.screen, 'returns', 'closing keeps the same presentation for its slide out');
    assert.equal(h.returnsPanel.hidden, false, 'the inert shell can still animate its contents');
    assert.equal(h.globals.activeElement, h.switcher);
    assert.deepEqual(h.switcher.focusOptions, { preventScroll: true });
    assert.equal(h.closeCalls, 1);
    h.controller.close(); h.controller.layout();
    assert.equal(h.closeCalls, 1);
    assert.equal(h.openCalls, 0);
  }
});

test('Escape consumed by a nested return control leaves the shell open; the next Escape closes it', () => {
  const h = harness();
  h.controller.setReturnsVisible(true); h.returnsBack.focus();
  h.document.dispatch('keydown', { key: 'Escape', defaultPrevented: true });
  assert.equal(h.controller.screen, 'returns');
  assert.equal(h.closeCalls, 0);
  const event = h.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.controller.screen, 'closed');
  assert.equal(h.closeCalls, 1);
  assert.equal(h.globals.activeElement, h.switcher);
});

test('returns projection and camera layout repeats preserve focus and avoid shell DOM writes', () => {
  const h = harness();
  h.controller.setReturnsVisible(true); h.returnsBack.focus();
  const writes = observeLayoutWrites(h);
  for (let i = 0; i < 1000; i++) { h.controller.setReturnsVisible(true); h.controller.layout(); }
  h.resize(390); h.resize(1440);
  assert.equal(writes.length, 0);
  assert.equal(h.globals.activeElement, h.returnsBack);
  assert.equal(h.controller.screen, 'returns');
  assert.equal(h.openCalls, 0);
  assert.equal(h.closeCalls, 0);
});

test('the hidden summary defers chart inspection behind returns and applies the latest chart on Back', () => {
  const h = harness();
  h.controller.open();
  h.controller.setReturnsVisible(true);
  let reads = 0;
  const next = { ...chart, id: 'next-chart' };
  Object.defineProperty(next, 'activations', { get() { reads++; return chart.activations; } });
  const writes = h.content.markupWrites;
  h.controller.update(next, { items: [{ type: 'gate', id: 34 }] });
  assert.equal(reads, 0);
  assert.equal(h.content.markupWrites, writes);
  h.controller.open();
  assert.equal(h.controller.screen, 'summary');
  assert.ok(reads > 0);
  assert.equal(h.entityButton('gate', 34).getAttribute('aria-pressed'), 'true');
  assert.equal(h.openCalls, 2, 'Back invokes coordination even if summary was requested before returns');
});

test('externally hidden returns releases shell focus without issuing a second close command', () => {
  const h = harness();
  h.controller.setReturnsVisible(true); h.returnsBack.focus();
  h.controller.setReturnsVisible(false);
  assert.equal(h.controller.screen, 'closed');
  assert.equal(h.panel.inert, true);
  assert.equal(h.globals.activeElement, h.switcher);
  assert.equal(h.closeCalls, 0);
  h.controller.setReturnsVisible(true); h.canvas.focus();
  h.controller.setReturnsVisible(false);
  assert.equal(h.globals.activeElement, h.canvas, 'external navigation retains its own focus');
});
