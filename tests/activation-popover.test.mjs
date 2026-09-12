import test from 'node:test';
import assert from 'node:assert/strict';
import { attachActivationPopover, placeActivationPopover } from '../src/activations/activation-popover.js';
import { activationDetails } from '../src/activations/activation-details.js';

const rectAt = (left, top, width = 68, height = 40) => ({ left, top, width, height, right: left + width, bottom: top + height });
const panelSize = { width: 254, height: 147 };

function assertContained(position, size, viewport) {
  assert.ok(position.left >= viewport.left + 12, 'left edge keeps the viewport margin');
  assert.ok(position.top >= viewport.top + 12, 'top edge keeps the viewport margin');
  assert.ok(position.left + size.width <= viewport.left + viewport.width - 12, 'right edge stays in the viewport');
  assert.ok(position.top + size.height <= viewport.top + viewport.height - 12, 'bottom edge stays in the viewport');
  const dimension = ['left', 'right'].includes(position.side) ? size.height : size.width;
  assert.ok(position.arrow >= 15 && position.arrow <= dimension - 15, 'the arrow clears rounded corners');
  for (const key of ['left', 'top', 'arrow']) assert.ok(Number.isFinite(position[key]), `${key} is finite`);
}

test('popover placement stays inside large and phone viewports at every edge and corner, including viewport offsets', () => {
  for (const viewport of [
    { left: 0, top: 0, width: 1440, height: 900 },
    { left: 0, top: 0, width: 390, height: 844 },
    { left: 240, top: 120, width: 1280, height: 720 },
    { left: 35, top: 80, width: 320, height: 520 },
  ]) {
    const xs = [viewport.left + 2, viewport.left + (viewport.width - 68) / 2, viewport.left + viewport.width - 70];
    const ys = [viewport.top + 2, viewport.top + (viewport.height - 40) / 2, viewport.top + viewport.height - 42];
    for (const x of xs) for (const y of ys) for (const source of ['personality', 'design']) {
      const anchor = rectAt(x, y);
      const before = JSON.stringify({ anchor, viewport, panelSize });
      assertContained(placeActivationPopover(anchor, panelSize, viewport, source), panelSize, viewport);
      assert.equal(JSON.stringify({ anchor, viewport, panelSize }), before, 'placement leaves its inputs unchanged');
    }
  }
});

test('placement prefers the source-facing side, flips at a horizontal edge, and uses above or below on phones', () => {
  const desktop = { left: 0, top: 0, width: 1440, height: 900 };
  const centered = rectAt(680, 400);
  const design = placeActivationPopover(centered, panelSize, desktop, 'design');
  const personality = placeActivationPopover(centered, panelSize, desktop, 'personality');
  assert.equal(design.side, 'left');
  assert.equal(centered.left - (design.left + panelSize.width), 14, 'design has a 14px gap');
  assert.equal(personality.side, 'right');
  assert.equal(personality.left - centered.right, 12, 'personality keeps its 12px gap');
  const left = rectAt(12, 400), right = rectAt(1360, 400);
  assert.equal(placeActivationPopover(left, panelSize, desktop, 'design').side, 'right');
  assert.equal(placeActivationPopover(right, panelSize, desktop, 'personality').side, 'left');
  const phone = { left: 0, top: 0, width: 390, height: 844 };
  for (const source of ['personality', 'design']) {
    const below = placeActivationPopover(rectAt(161, 100), panelSize, phone, source);
    const above = placeActivationPopover(rectAt(161, 770), panelSize, phone, source);
    assert.equal(below.side, 'bottom');
    assert.equal(below.top, source === 'design' ? 154 : 152);
    assert.equal(above.side, 'top');
    assert.equal(above.top + panelSize.height, source === 'design' ? 756 : 758);
  }
});

const chartFixture = () => ({
  id: 'popover-fixture', source: 'calculated', personality: [41], design: [19, 41],
  activations: {
    personality: [
      { planet: 'mercury', gate: 41, line: 1, longitude: 302.1 },
      { planet: 'mars', gate: 41, line: 2, longitude: 303.1 },
    ],
    design: [
      { planet: 'mercury', gate: 41, line: 6, longitude: 307.1 },
      { planet: 'sun', gate: 19, line: 1, longitude: 307.8 },
      { planet: 'north_node', gate: 41, line: 3, longitude: 303.9 },
    ],
  },
});

// The controller runs against a small DOM surface and synthetic chart data.
// No browser storage, app bootstrap, real charts, timers, or network are used.
function popoverHarness(t, { viewport = { left: 0, top: 0, width: 1440, height: 900 }, visual = true, measurePanel } = {}) {
  const originalGlobals = new Map(['document', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  const listeners = new Map(), anchors = new Map(), queries = [], focusCalls = [], cameraMutations = [];
  const addListener = surface => (type, callback, options) => {
    const key = `${surface}:${type}`;
    if (!listeners.has(key)) listeners.set(key, []);
    listeners.get(key).push({ callback, options });
  };
  const document = { addEventListener: addListener('document') };
  const window = {
    innerWidth: viewport.width, innerHeight: viewport.height,
    addEventListener: addListener('window'),
    scrollTo(...args) { cameraMutations.push(['scrollTo', ...args]); },
    scrollBy(...args) { cameraMutations.push(['scrollBy', ...args]); },
    visualViewport: visual ? {
      offsetLeft: viewport.left, offsetTop: viewport.top, width: viewport.width, height: viewport.height,
      addEventListener: addListener('visualViewport'),
    } : undefined,
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: document });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: window });
  const panelChild = {};
  const panel = {
    id: 'activationPopover', hidden: true, innerHTML: '', dataset: {},
    style: { setProperty(name, value) { this[name] = value; } },
    contains(node) { return node === this || node === panelChild; },
    getBoundingClientRect() {
      return measurePanel ? measurePanel(this) : { width: Math.min(panelSize.width, Number.parseFloat(this.style.maxWidth) || panelSize.width), height: panelSize.height };
    },
  };
  const svg = {
    querySelector(selector) {
      queries.push(selector);
      const id = selector.match(/^\[data-activation="([^"]+)"\]$/)?.[1];
      assert.ok(id, 'the controller resolves a specific activation');
      return anchors.get(id) || null;
    },
    setAttribute(...args) { cameraMutations.push(['svg.setAttribute', ...args]); },
  };
  function addAnchor(id, rect = rectAt(660, 320)) {
    const attributes = new Map();
    const anchor = {
      dataset: { activation: id }, rect,
      getBoundingClientRect() { return this.rect; },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      focus(options) { focusCalls.push({ anchor: this, options }); },
      closest(selector) { return selector === '[data-activation]' ? this : null; },
    };
    anchors.set(id, anchor);
    return anchor;
  }
  function dispatch(surface, type, options = {}) {
    const event = { target: {}, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options };
    for (const { callback } of listeners.get(`${surface}:${type}`) || []) callback(event);
    return event;
  }
  const controller = attachActivationPopover(panel, svg);
  return { controller, panel, panelChild, anchors, addAnchor, dispatch, listeners, queries, focusCalls, cameraMutations, window };
}

function renderedRows(panel) {
  return [...panel.innerHTML.matchAll(/<span class="activation-detail-label">([^<]+)<\/span><span class="activation-detail-value">(\d+)<\/span>[\s\S]*?<span class="activation-detail-percent">([\d.]+)%<\/span>/g)]
    .map(([, label, value, percent]) => ({ label, value: Number(value), percent }));
}

function expectedRows(entry) {
  return activationDetails(entry).map(({ label, value, percent }) => ({ label, value, percent: percent.toFixed(2) }));
}

test('opening uses the exact saved source and planet, including duplicate gate numbers and node keys', t => {
  const harness = popoverHarness(t), chart = chartFixture();
  let previous;
  for (const [source, planet] of [['personality', 'mercury'], ['personality', 'mars'], ['design', 'mercury'], ['design', 'north_node']]) {
    const id = `${source}-${planet}`, anchor = harness.addAnchor(id);
    const snapshot = JSON.stringify(chart);
    harness.controller.show(chart, id);
    assert.equal(harness.controller.currentId, id);
    assert.equal(harness.panel.hidden, false);
    assert.equal(anchor.getAttribute('aria-describedby'), harness.panel.id);
    if (previous) assert.equal(previous.getAttribute('aria-describedby'), null, 'opening another activation clears the old accessible description');
    assert.deepEqual(renderedRows(harness.panel), expectedRows(chart.activations[source].find(entry => entry.planet === planet)));
    assert.equal(JSON.stringify(chart), snapshot, 'displaying details leaves chart data unchanged');
    previous = anchor;
  }
  assert.deepEqual(harness.focusCalls, [], 'opening does not move focus or scroll');
  assert.deepEqual(harness.cameraMutations, []);
});

test('design positions 14px left of its matching planet while the number owns the trigger, description and Escape focus', t => {
  const harness = popoverHarness(t), chart = chartFixture();
  const number = harness.addAnchor('design-mercury', rectAt(700, 320));
  const planet = harness.addAnchor('design-mercury-planet', rectAt(660, 320, 32));
  harness.addAnchor('design-sun-planet', rectAt(500, 160, 32));
  harness.controller.show(chart, 'design-mercury');
  assert.equal(harness.controller.currentId, 'design-mercury', 'the numeric activation remains the popup identity');
  assert.equal(harness.panel.dataset.side, 'left');
  assert.equal(Number.parseFloat(harness.panel.style.left) + panelSize.width, planet.rect.left - 14);
  assert.equal(Number.parseFloat(harness.panel.style.top) + Number.parseFloat(harness.panel.style['--arrow-offset']), planet.rect.top + planet.rect.height / 2, 'the arrow aligns with the matching planet');
  assert.equal(number.getAttribute('aria-describedby'), harness.panel.id);
  assert.equal(planet.getAttribute('aria-describedby'), null, 'positioning does not transfer the accessible description');
  harness.dispatch('document', 'pointerdown', { target: number });
  assert.equal(harness.controller.currentId, 'design-mercury', 'the number remains available to the selection toggle');
  harness.dispatch('document', 'keydown', { key: 'Escape' });
  assert.equal(number.getAttribute('aria-describedby'), null);
  assert.deepEqual(harness.focusCalls, [{ anchor: number, options: { preventScroll: true } }]);
  harness.controller.show(chart, 'design-mercury');
  harness.dispatch('document', 'pointerdown', { target: planet });
  assert.equal(harness.controller.currentId, null, 'the planet is only a positioning reference, not the popup trigger');
  assert.deepEqual(harness.cameraMutations, []);
});

test('personality keeps positioning 12px right of its number even when a planet symbol is present', t => {
  const harness = popoverHarness(t);
  const number = harness.addAnchor('personality-mercury', rectAt(700, 320));
  const planet = harness.addAnchor('personality-mercury-planet', rectAt(660, 320, 32));
  harness.controller.show(chartFixture(), 'personality-mercury');
  assert.equal(harness.panel.dataset.side, 'right');
  assert.equal(Number.parseFloat(harness.panel.style.left), number.rect.right + 12);
  assert.equal(number.getAttribute('aria-describedby'), harness.panel.id);
  assert.equal(planet.getAttribute('aria-describedby'), null);
  assert.ok(!harness.queries.some(query => query.includes('personality-mercury-planet')), 'personality does not resolve the symbol as a positioning reference');
});

test('a red popup flipped right clears the numeric trigger by 14px so a second click can still reach it', t => {
  const viewport = { left: 0, top: 0, width: 688, height: 820 };
  const harness = popoverHarness(t, { viewport });
  const planet = harness.addAnchor('design-mercury-planet', rectAt(169, 320, 17));
  const number = harness.addAnchor('design-mercury', rectAt(188, 320, 36));
  harness.controller.show(chartFixture(), 'design-mercury');
  const left = Number.parseFloat(harness.panel.style.left);
  assert.equal(harness.panel.dataset.side, 'right', 'the left side has insufficient room');
  assert.equal(left, number.rect.right + 14, 'the flipped popup clears the entire number, not only its planet');
  assert.ok((number.rect.left + number.rect.right) / 2 < left, 'the number center cannot be covered by the popup');
  assert.equal(Number.parseFloat(harness.panel.style.top) + Number.parseFloat(harness.panel.style['--arrow-offset']), planet.rect.top + planet.rect.height / 2, 'the arrow retains the planet row alignment');
  assert.equal(number.getAttribute('aria-describedby'), harness.panel.id);
  harness.dispatch('document', 'pointerdown', { target: number });
  assert.equal(harness.controller.currentId, 'design-mercury', 'the second number press remains available to the app toggle');
  assertContained({ left, top: Number.parseFloat(harness.panel.style.top), side: harness.panel.dataset.side, arrow: Number.parseFloat(harness.panel.style['--arrow-offset']) }, panelSize, viewport);
});

test('narrow phone layouts use above or below when a red popup beside the planet would cover its number', t => {
  const harness = popoverHarness(t, { viewport: { left: 0, top: 0, width: 390, height: 844 } });
  for (const [width, planetLeft, numberLeft] of [[390, 89, 108], [320, 20, 39]]) {
    for (const [top, expectedSide] of [[200, 'bottom'], [760, 'top']]) {
      const viewport = { left: 0, top: 0, width, height: 844 };
      harness.window.visualViewport.width = width;
      harness.addAnchor('design-mercury-planet', rectAt(planetLeft, top, 17));
      const number = harness.addAnchor('design-mercury', rectAt(numberLeft, top, 36));
      harness.controller.show(chartFixture(), 'design-mercury');
      const popupTop = Number.parseFloat(harness.panel.style.top);
      assert.equal(harness.panel.dataset.side, expectedSide, 'fitting beside the planet alone is not sufficient');
      assert.ok(expectedSide === 'bottom' ? popupTop >= number.rect.bottom + 14 : popupTop + panelSize.height <= number.rect.top - 14, 'vertical fallback keeps the whole number clear with the same gap');
      assertContained({ left: Number.parseFloat(harness.panel.style.left), top: popupTop, side: harness.panel.dataset.side, arrow: Number.parseFloat(harness.panel.style['--arrow-offset']) }, panelSize, viewport);
      assert.equal(harness.controller.currentId, 'design-mercury');
      assert.equal(number.getAttribute('aria-describedby'), harness.panel.id);
    }
  }
});

test('design falls back to its number when the planet symbol is absent and still requires the number to open', t => {
  const harness = popoverHarness(t), chart = chartFixture();
  const number = harness.addAnchor('design-mercury', rectAt(700, 320));
  harness.controller.show(chart, 'design-mercury');
  assert.equal(harness.panel.hidden, false);
  assert.equal(Number.parseFloat(harness.panel.style.left) + panelSize.width, number.rect.left - 14);
  const planet = harness.addAnchor('design-mercury-planet', rectAt(660, 320, 32));
  harness.controller.reposition();
  assert.equal(Number.parseFloat(harness.panel.style.left) + panelSize.width, planet.rect.left - 14, 'a restored symbol becomes the positioning reference');
  harness.anchors.delete('design-mercury-planet');
  harness.controller.reposition();
  assert.equal(harness.controller.currentId, 'design-mercury');
  assert.equal(Number.parseFloat(harness.panel.style.left) + panelSize.width, number.rect.left - 14, 'removing only the symbol restores number positioning');
  harness.controller.close();
  harness.addAnchor('design-mercury-planet', planet.rect);
  harness.anchors.delete('design-mercury');
  harness.controller.show(chart, 'design-mercury');
  assert.equal(harness.panel.hidden, true, 'a symbol alone cannot replace the numeric trigger');
  assert.equal(harness.controller.currentId, null);
});

test('design refresh resolves both replacement elements after a redraw and returns focus to the replacement number', t => {
  const harness = popoverHarness(t), chart = chartFixture();
  harness.addAnchor('design-mercury', rectAt(700, 200));
  harness.addAnchor('design-mercury-planet', rectAt(660, 200, 32));
  harness.controller.show(chart, 'design-mercury');
  const replacementNumber = harness.addAnchor('design-mercury', rectAt(900, 500));
  const replacementPlanet = harness.addAnchor('design-mercury-planet', rectAt(860, 500, 32));
  harness.controller.refresh(chart);
  assert.equal(harness.controller.currentId, 'design-mercury');
  assert.equal(Number.parseFloat(harness.panel.style.left) + panelSize.width, replacementPlanet.rect.left - 14);
  assert.equal(replacementNumber.getAttribute('aria-describedby'), harness.panel.id);
  assert.equal(replacementPlanet.getAttribute('aria-describedby'), null);
  harness.dispatch('document', 'keydown', { key: 'Escape' });
  assert.deepEqual(harness.focusCalls, [{ anchor: replacementNumber, options: { preventScroll: true } }]);
  assert.deepEqual(harness.cameraMutations, []);
});

test('the content wrapper retains all five detail rows and short viewport height is applied before measurement', t => {
  const viewport = { left: 0, top: 25, width: 390, height: 150 };
  const harness = popoverHarness(t, {
    viewport,
    measurePanel(panel) {
      assert.equal(panel.style['--popover-max-height'], '126px', 'the content height limit is set before measuring the constrained panel');
      return { width: 254, height: 126 };
    },
  });
  harness.addAnchor('design-mercury', rectAt(190, 75));
  harness.addAnchor('design-mercury-planet', rectAt(150, 75, 32));
  const chart = chartFixture();
  harness.controller.show(chart, 'design-mercury');
  assert.match(harness.panel.innerHTML, /^<div class="activation-detail-content">/);
  assert.equal((harness.panel.innerHTML.match(/class="activation-detail-content"/g) || []).length, 1);
  assert.equal((harness.panel.innerHTML.match(/class="activation-detail-row"/g) || []).length, 5);
  assert.deepEqual(renderedRows(harness.panel), expectedRows(chart.activations.design[0]));
  assert.equal(harness.panel.hidden, false);
  assertContained({ left: Number.parseFloat(harness.panel.style.left), top: Number.parseFloat(harness.panel.style.top), side: harness.panel.dataset.side, arrow: Number.parseFloat(harness.panel.style['--arrow-offset']) }, { width: 254, height: 126 }, viewport);
  assert.deepEqual(harness.cameraMutations, []);
});

test('unknown identifiers and missing or invalid real activation data stay closed without invented rows', t => {
  const harness = popoverHarness(t);
  harness.addAnchor('personality-mercury');
  harness.addAnchor('design-sun');
  harness.addAnchor('personality-earth');
  for (const id of ['gate-41', 'personality-mercury-planet', 'personality-unknown', 'design-sun"] *', '', undefined, null]) {
    harness.controller.show(chartFixture(), id);
    assert.equal(harness.controller.currentId, null);
    assert.equal(harness.panel.hidden, true);
    assert.equal(harness.queries.length, 0, 'invalid IDs never become DOM selectors');
    assert.equal(harness.panel.innerHTML, '');
  }
  for (const chart of [
    { personality: [41], design: [19] },
    { activations: {} },
    { activations: { personality: [] } },
    { activations: { personality: [{ planet: 'mercury', gate: 41, line: 1 }] } },
    { activations: { personality: [{ planet: 'mercury', gate: 41, line: 1, longitude: Infinity }] } },
    { activations: { personality: [{ planet: 'mercury', gate: 41, line: 6, longitude: 302.1 }] } },
  ]) {
    harness.controller.show(chart, 'personality-mercury');
    assert.equal(harness.controller.currentId, null);
    assert.equal(harness.panel.hidden, true);
    assert.equal(harness.panel.innerHTML, '', 'gate arrays or invalid longitude data never supply placeholder details');
  }
  harness.controller.show(chartFixture(), 'personality-earth');
  assert.equal(harness.controller.currentId, null, 'a valid planetary key still requires that planet in the selected source');
  harness.anchors.delete('design-sun');
  harness.controller.show(chartFixture(), 'design-sun');
  assert.equal(harness.panel.hidden, true, 'real activation data without a visible graph anchor stays closed');
});

test('refresh updates only the open activation and dismisses it when that source or planet disappears', t => {
  const harness = popoverHarness(t), chart = chartFixture();
  const anchor = harness.addAnchor('personality-mercury');
  harness.controller.show(chart, 'personality-mercury');
  const initialMarkup = harness.panel.innerHTML;
  const updated = chartFixture();
  updated.activations.personality[0] = { planet: 'mercury', gate: 41, line: 3, longitude: 304.1 };
  harness.controller.refresh(updated);
  assert.equal(harness.controller.currentId, 'personality-mercury');
  assert.notEqual(harness.panel.innerHTML, initialMarkup);
  assert.deepEqual(renderedRows(harness.panel), expectedRows(updated.activations.personality[0]));
  updated.activations.personality = updated.activations.personality.filter(entry => entry.planet !== 'mercury');
  harness.controller.refresh(updated);
  assert.equal(harness.controller.currentId, null, 'matching gate and planet in design cannot replace the missing personality record');
  assert.equal(harness.panel.hidden, true);
  assert.equal(anchor.getAttribute('aria-describedby'), null);
  harness.controller.refresh(chart);
  assert.equal(harness.panel.hidden, true, 'a later refresh does not reopen a dismissed popup');
});

test('graph redraw resolves the replacement anchor and preserves the popup identity and accessible description', t => {
  const harness = popoverHarness(t), chart = chartFixture();
  const original = harness.addAnchor('personality-mercury', rectAt(600, 200));
  harness.controller.show(chart, 'personality-mercury');
  const firstLeft = harness.panel.style.left;
  const replacement = harness.addAnchor('personality-mercury', rectAt(850, 500));
  harness.controller.refresh(chart);
  assert.equal(harness.controller.currentId, 'personality-mercury');
  assert.equal(harness.panel.hidden, false);
  assert.notEqual(harness.panel.style.left, firstLeft, 'placement uses the new SVG element rather than a detached node');
  assert.equal(replacement.getAttribute('aria-describedby'), harness.panel.id);
  const escape = harness.dispatch('document', 'keydown', { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(replacement.getAttribute('aria-describedby'), null);
  assert.equal(harness.focusCalls.length, 1);
  assert.equal(harness.focusCalls[0].anchor, replacement);
  assert.notEqual(harness.focusCalls[0].anchor, original);
  assert.deepEqual(harness.focusCalls[0].options, { preventScroll: true });
  assert.deepEqual(harness.cameraMutations, []);
});

test('inside and current-anchor presses preserve the popup; outside presses dismiss without stealing focus', t => {
  const harness = popoverHarness(t), chart = chartFixture();
  const anchor = harness.addAnchor('personality-mercury');
  const otherAnchor = harness.addAnchor('design-mercury');
  harness.controller.show(chart, 'personality-mercury');
  assert.equal(harness.listeners.get('document:pointerdown')[0].options, true, 'outside presses are observed before graph selection');
  for (const target of [harness.panel, harness.panelChild, anchor, { closest: () => anchor }]) {
    const event = harness.dispatch('document', 'pointerdown', { target });
    assert.equal(harness.controller.currentId, 'personality-mercury');
    assert.equal(event.defaultPrevented, false, 'the anchor can still reach the ordinary selection handler and toggle there');
  }
  for (const target of [{}, otherAnchor]) {
    harness.controller.show(chart, 'personality-mercury');
    const event = harness.dispatch('document', 'pointerdown', { target });
    assert.equal(harness.controller.currentId, null);
    assert.equal(harness.panel.hidden, true);
    assert.equal(anchor.getAttribute('aria-describedby'), null);
    assert.equal(event.defaultPrevented, false, 'the outside press remains available to its own target');
  }
  assert.deepEqual(harness.focusCalls, []);
  assert.deepEqual(harness.cameraMutations, []);
});

test('Escape and explicit close clean up the description, and only Escape restores anchor focus', t => {
  const harness = popoverHarness(t), chart = chartFixture();
  const anchor = harness.addAnchor('personality-mercury');
  harness.controller.show(chart, 'personality-mercury');
  assert.equal(harness.dispatch('document', 'keydown', { key: 'Enter' }).defaultPrevented, false);
  assert.equal(harness.controller.currentId, 'personality-mercury');
  assert.equal(harness.dispatch('document', 'keydown', { key: 'Escape' }).defaultPrevented, true);
  assert.equal(harness.panel.hidden, true);
  assert.equal(harness.controller.currentId, null);
  assert.equal(anchor.getAttribute('aria-describedby'), null);
  assert.equal(harness.focusCalls.length, 1);
  assert.deepEqual(harness.focusCalls[0], { anchor, options: { preventScroll: true } });
  assert.equal(harness.dispatch('document', 'keydown', { key: 'Escape' }).defaultPrevented, false, 'a closed popup does not consume Escape');
  harness.controller.show(chart, 'personality-mercury');
  harness.controller.close();
  harness.controller.close();
  assert.equal(harness.panel.hidden, true);
  assert.equal(anchor.getAttribute('aria-describedby'), null);
  assert.equal(harness.focusCalls.length, 1, 'programmatic close does not steal focus');
  assert.deepEqual(harness.cameraMutations, []);
});

test('resize and visual viewport movement reposition the popup using current screen coordinates', t => {
  const viewport = { left: 35, top: 80, width: 320, height: 520 };
  const harness = popoverHarness(t, { viewport }), chart = chartFixture();
  const anchor = harness.addAnchor('personality-mercury', rectAt(160, 200));
  harness.controller.show(chart, 'personality-mercury');
  const checkPlacement = () => {
    const position = { left: Number.parseFloat(harness.panel.style.left), top: Number.parseFloat(harness.panel.style.top), side: harness.panel.dataset.side, arrow: Number.parseFloat(harness.panel.style['--arrow-offset']) };
    assertContained(position, harness.panel.getBoundingClientRect(), { left: harness.window.visualViewport.offsetLeft, top: harness.window.visualViewport.offsetTop, width: harness.window.visualViewport.width, height: harness.window.visualViewport.height });
  };
  checkPlacement();
  assert.equal(harness.panel.style.maxWidth, '296px');
  for (const [surface, type] of [['window', 'resize'], ['visualViewport', 'resize'], ['visualViewport', 'scroll']]) {
    const previousTop = harness.panel.style.top;
    anchor.rect = rectAt(anchor.rect.left, anchor.rect.top + 35);
    harness.window.visualViewport.offsetTop += 5;
    harness.dispatch(surface, type);
    assert.notEqual(harness.panel.style.top, previousTop, `${surface} ${type} recomputes placement`);
    assert.equal(harness.controller.currentId, 'personality-mercury');
    checkPlacement();
  }
  assert.deepEqual(harness.cameraMutations, []);
});

test('the layout viewport is a fallback when visualViewport is unavailable', t => {
  const harness = popoverHarness(t, { visual: false, viewport: { left: 0, top: 0, width: 390, height: 844 } });
  harness.addAnchor('personality-mercury', rectAt(161, 300));
  harness.controller.show(chartFixture(), 'personality-mercury');
  assert.equal(harness.panel.hidden, false);
  assert.equal(harness.panel.style.maxWidth, '366px');
  assert.equal(harness.panel.dataset.side, 'bottom');
  assert.equal(harness.panel.style.top, '352px');
});

test('panning an anchor out of view or removing it dismisses the popup without changing the camera', t => {
  const harness = popoverHarness(t), chart = chartFixture();
  const anchor = harness.addAnchor('personality-mercury');
  for (const rect of [rectAt(-68, 200), rectAt(1440, 200), rectAt(600, -40), rectAt(600, 900)]) {
    anchor.rect = rectAt(600, 200);
    harness.controller.show(chart, 'personality-mercury');
    anchor.rect = rect;
    harness.controller.reposition();
    assert.equal(harness.controller.currentId, null);
    assert.equal(harness.panel.hidden, true);
    assert.equal(anchor.getAttribute('aria-describedby'), null);
  }
  anchor.rect = rectAt(-30, 200);
  harness.controller.show(chart, 'personality-mercury');
  assert.equal(harness.panel.hidden, false, 'a partially visible activation can still show its details');
  harness.anchors.delete('personality-mercury');
  harness.controller.reposition();
  assert.equal(harness.controller.currentId, null);
  assert.equal(harness.panel.hidden, true);
  assert.deepEqual(harness.focusCalls, []);
  assert.deepEqual(harness.cameraMutations, []);
});
