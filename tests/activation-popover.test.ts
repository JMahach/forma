import type { ChartInput, PlanetFilterView } from '../src/domain/chart-composition.ts';
type ViewportRect = { left: number; top: number; width: number; height: number };
type PanelStyle = Record<string, string> & { setProperty(name: string, value: string): void };
interface PopoverPanel {
  id: string; hidden: boolean; innerHTML: string; dataset: Record<string, string>; style: PanelStyle;
  contains(node: unknown): boolean; getBoundingClientRect(): { width: number; height: number };
}
interface PopoverEvent { target: unknown; defaultPrevented: boolean; preventDefault(): void; [key: string]: unknown }
type Listener = (event: PopoverEvent) => void;
type ViewportLayout = Parameters<typeof attachActivationPopover>[2]['viewportLayout'] & Partial<ReturnType<typeof createViewportLayout>>;
interface PopoverOptions { signal?:AbortSignal;
  viewport?: ViewportRect; visual?: boolean; measurePanel?: (panel: PopoverPanel) => { width: number; height: number }; viewportLayout?: ViewportLayout;
}
interface Anchor {
  dataset: { activation: string }; rect: ReturnType<typeof rectAt>;
  column: { dataset: { columnSide: string; cycleOrigin?: string } };
  getBoundingClientRect(): ReturnType<typeof rectAt>; setAttribute(name: string, value: unknown): void;
  getAttribute(name: string): string | null; removeAttribute(name: string): void; focus(options?: FocusOptions): void;
  closest(selector: string): Anchor | Anchor['column'] | null;
}
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attachActivationPopover, placeActivationPopover } from '../src/views/activation-popover.ts';
import { overlayFixture } from './helpers/chart-composition.ts';
import { createChartComposition } from '../src/domain/chart-composition.ts';
import { activationDetails } from '../src/views/activation-details.ts';
import { createViewportLayout } from './helpers/viewport-layout.ts';

const rectAt = (left: number, top: number, width = 68, height = 40) => ({ left, top, width, height, right: left + width, bottom: top + height });
const panelSize = { width: 254, height: 147 };
function panelPosition(panel: Pick<PopoverPanel, 'style'>) {
  const match = /^translate\(([-\d.]+)px, ([-\d.]+)px\)$/.exec(panel.style.transform);
  assert.ok(match, 'the popup uses a finite 2D screen translation');
  return { left: Number(match![1]), top: Number(match![2]) };
}

function assertContained(position: { left: number; top: number; side: string; arrow: number }, size: { width: number; height: number }, viewport: ViewportRect) {
  assert.ok(position.left >= viewport.left + 12, 'left edge keeps the viewport margin');
  assert.ok(position.top >= viewport.top + 12, 'top edge keeps the viewport margin');
  assert.ok(position.left + size.width <= viewport.left + viewport.width - 12, 'right edge stays in the viewport');
  assert.ok(position.top + size.height <= viewport.top + viewport.height - 12, 'bottom edge stays in the viewport');
  const dimension = ['left', 'right'].includes(position.side) ? size.height : size.width;
  assert.ok(position.arrow >= 15 && position.arrow <= dimension - 15, 'the arrow clears rounded corners');
  for (const key of ['left', 'top', 'arrow'] as const) assert.ok(Number.isFinite(position[key]), `${key} is finite`);
}

test('popover placement stays inside large and phone viewports at every edge and corner, including viewport offsets', () => {
  for (const viewport of [
    { left: 0, top: 0, width: 1440, height: 900 },
    { left: 0, top: 0, width: 390, height: 844 },
    { left: 240, top: 120, width: 1280, height: 720 },
    { left: 35, top: 80, width: 320, height: 520 },
  ] as const) {
    const xs = [viewport.left + 2, viewport.left + (viewport.width - 68) / 2, viewport.left + viewport.width - 70];
    const ys = [viewport.top + 2, viewport.top + (viewport.height - 40) / 2, viewport.top + viewport.height - 42];
    for (const x of xs) for (const y of ys) for (const columnSide of ['right', 'left'] as const) {
      const anchor = rectAt(x, y);
      const before = JSON.stringify({ anchor, viewport, panelSize });
      assertContained(placeActivationPopover(anchor, panelSize, viewport, columnSide), panelSize, viewport);
      assert.equal(JSON.stringify({ anchor, viewport, panelSize }), before, 'placement leaves its inputs unchanged');
    }
  }
});

test('placement prefers the column-facing side, flips at a horizontal edge, and uses above or below on phones', () => {
  const desktop = { left: 0, top: 0, width: 1440, height: 900 };
  const centered = rectAt(680, 400);
  const fromLeft = placeActivationPopover(centered, panelSize, desktop, 'left');
  const fromRight = placeActivationPopover(centered, panelSize, desktop, 'right');
  assert.equal(fromLeft.side, 'left');
  assert.equal(centered.left - (fromLeft.left + panelSize.width), 14, 'the left column has a 14px gap');
  assert.equal(fromRight.side, 'right');
  assert.equal(fromRight.left - centered.right, 12, 'the right column keeps its 12px gap');
  const left = rectAt(12, 400), right = rectAt(1360, 400);
  assert.equal(placeActivationPopover(left, panelSize, desktop, 'left').side, 'right');
  assert.equal(placeActivationPopover(right, panelSize, desktop, 'right').side, 'left');
  const phone = { left: 0, top: 0, width: 390, height: 844 };
  for (const columnSide of ['right', 'left'] as const) {
    const below = placeActivationPopover(rectAt(161, 100), panelSize, phone, columnSide);
    const above = placeActivationPopover(rectAt(161, 770), panelSize, phone, columnSide);
    assert.equal(below.side, 'bottom');
    assert.equal(below.top, columnSide === 'left' ? 154 : 152);
    assert.equal(above.side, 'top');
    assert.equal(above.top + panelSize.height, columnSide === 'left' ? 756 : 758);
  }
});

const chartFixture = () => ({
  id: 'popover-fixture', source: 'calculated' as const, personality: [41], design: [19, 41],
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
function popoverHarness(t: test.TestContext, { signal, viewport = { left: 0, top: 0, width: 1440, height: 900 }, visual = true, measurePanel, viewportLayout }: PopoverOptions = {}) {
  const originalGlobals = new Map(['document', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  const listeners = new Map<string, { callback: Listener; options?: unknown }[]>(), anchors = new Map<string, Anchor>(), queries: string[] = [], focusCalls: { anchor: Anchor; options?: FocusOptions }[] = [], cameraMutations: unknown[][] = [];
  const addListener = (surface: string) => (type: string, callback: Listener, options?: unknown) => {
    const key = `${surface}:${type}`;
    const signal=(options as AddEventListenerOptions|undefined)?.signal;if(signal?.aborted)return;
    signal?.addEventListener('abort',()=>listeners.set(key,(listeners.get(key)??[]).filter(item=>item.callback!==callback)),{once:true});
    if (!listeners.has(key)) listeners.set(key, []);
    listeners.get(key)!.push({ callback, options });
  };
  const removeListener = (surface: string) => (type: string, callback: Listener) => {
    const key = `${surface}:${type}`;
    listeners.set(key, (listeners.get(key) || []).filter(listener => listener.callback !== callback));
  };
  const document: { defaultView?: typeof window; addEventListener: ReturnType<typeof addListener>; removeEventListener: ReturnType<typeof removeListener> } = { addEventListener: addListener('document'), removeEventListener: removeListener('document') };
  const window = {
    innerWidth: viewport.width, innerHeight: viewport.height,
    addEventListener: addListener('window'),
    removeEventListener: removeListener('window'),
    scrollTo(...args: unknown[]) { cameraMutations.push(['scrollTo', ...args]); },
    scrollBy(...args: unknown[]) { cameraMutations.push(['scrollBy', ...args]); },
    visualViewport: visual ? {
      offsetLeft: viewport.left, offsetTop: viewport.top, width: viewport.width, height: viewport.height,
      addEventListener: addListener('visualViewport'),
      removeEventListener: removeListener('visualViewport'),
    } : undefined,
  };
  document.defaultView = window;
  if (!viewportLayout) {
    viewportLayout = createViewportLayout(document as unknown as Document);
    t.after(() => viewportLayout!.destroy!());
  }
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: document });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: window });
  const panelChild = {}, styleWrites: [PropertyKey, unknown][] = [], measurements: string[] = [];
  const panel: PopoverPanel = {
    id: 'activationPopover', hidden: true, innerHTML: '', dataset: {},
    style: new Proxy({ setProperty(this: PanelStyle, name: string, value: string) { this[name] = value; } } as unknown as PanelStyle, {
      set(target, key, value) { styleWrites.push([key, value]); (target as Record<PropertyKey, unknown>)[key] = value; return true; },
    }),
    contains(node) { return node === this || node === panelChild; },
    getBoundingClientRect() {
      measurements.push('panel');
      return measurePanel ? measurePanel(this) : { width: Math.min(panelSize.width, Number.parseFloat(this.style.maxWidth) || panelSize.width), height: panelSize.height };
    },
  };
  const svg = {
    querySelector(selector: string) {
      queries.push(selector);
      const id = selector.match(/^\[data-activation="([^"]+)"\]$/)?.[1];
      assert.ok(id, 'the controller resolves a specific activation');
      return anchors.get(id) || null;
    },
    setAttribute(...args: unknown[]) { cameraMutations.push(['svg.setAttribute', ...args]); },
  };
  function addAnchor(id: string, rect = rectAt(660, 320)) {
    const attributes = new Map<string, string>();
    const [prefix] = id.split('-');
    const column = { dataset: { columnSide: ({ design: 'left', personality: 'right', natal: 'left', cycle: 'right' } as Record<string, string>)[prefix],
      ...(['natal', 'cycle'].includes(prefix) ? { cycleOrigin: prefix } : {}) } };
    const anchor: Anchor = {
      dataset: { activation: id }, rect, column,
      getBoundingClientRect() { measurements.push(id); return this.rect; },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name: string) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      focus(options) { focusCalls.push({ anchor: this, options }); },
      closest(selector: string) { return selector === '[data-activation]' ? this : selector === '.activation-column' ? column : null; },
    };
    anchors.set(id, anchor);
    return anchor;
  }
  function dispatch(surface: string, type: string, options: Partial<PopoverEvent> = {}) {
    const event = { target: {}, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options };
    for (const { callback } of listeners.get(`${surface}:${type}`) || []) callback(event);
    return event;
  }
  const controller = attachActivationPopover(panel as unknown as HTMLElement, svg as unknown as SVGSVGElement, { viewportLayout,signal });
  return { controller, panel, panelChild, styleWrites, measurements, anchors, addAnchor, dispatch, listeners, queries, focusCalls, cameraMutations, window, viewportLayout };
}

function renderedRows(panel: Pick<PopoverPanel, 'innerHTML'>) {
  return [...panel.innerHTML.matchAll(/<span class="activation-detail-label">([^<]+)<\/span><span class="activation-detail-value">(\d+)<\/span>[\s\S]*?<span class="activation-detail-percent">([\d.]+)%<\/span>/g)]
    .map(([, label, value, percent]) => ({ label, value: Number(value), percent }));
}

function expectedRows(entry: { planet: string; gate: number; line: number; longitude: number; }|null|undefined) {
  return activationDetails(entry)!.map(({ label, value, percent }) => ({ label, value, percent: percent.toFixed(2) }));
}

test('opening uses the exact saved source and planet, including duplicate gate numbers and node keys', t => {
  const harness = popoverHarness(t), chart = chartFixture();
  let previous: Anchor | undefined;
  for (const [source, planet] of [['personality', 'mercury'], ['personality', 'mars'], ['design', 'mercury'], ['design', 'north_node']] as const) {
    const id = `${source}-${planet}`, anchor = harness.addAnchor(id);
    const snapshot = JSON.stringify(chart);
    harness.controller.show(chart, id);
    assert.equal(harness.controller.currentId, id);
    assert.equal(harness.panel.hidden, false);
    assert.equal(anchor.getAttribute('aria-describedby'), harness.panel.id);
    if (previous) assert.equal(previous.getAttribute('aria-describedby'), null, 'opening another activation clears the old accessible description');
    assert.deepEqual(renderedRows(harness.panel), expectedRows(chart.activations[source].find((entry: { planet: string; }) => entry.planet === planet)));
    assert.equal(JSON.stringify(chart), snapshot, 'displaying details leaves chart data unchanged');
    previous = anchor;
  }
  assert.deepEqual(harness.focusCalls, [], 'opening does not move focus or scroll');
  assert.deepEqual(harness.cameraMutations, []);
});

test('unchecked planets show and refresh their exact full records without enabling an activation', t => {
  const harness = popoverHarness(t), original = chartFixture();
  const full = structuredClone(original.activations.personality);
  const chart = { ...original, personality: [], activations: { ...original.activations, personality: [] },
    planetFilter: { selectedPlanets: [], activations: full } as unknown as PlanetFilterView };
  harness.addAnchor('personality-mercury');
  harness.controller.show(chart, 'personality-mercury');
  assert.equal(harness.panel.hidden, false);
  assert.deepEqual(renderedRows(harness.panel), expectedRows(full[0]));
  assert.deepEqual(chart.planetFilter.selectedPlanets, []);
  assert.deepEqual(chart.activations.personality, []);
  const changed = { ...chart, planetFilter: { selectedPlanets: [],
    activations: full.map(entry => entry.planet === 'mercury' ? { ...entry, longitude: 302.125 } : entry) } as unknown as PlanetFilterView };
  harness.controller.refresh(changed);
  assert.deepEqual(renderedRows(harness.panel), expectedRows(changed.planetFilter.activations[0]));
  assert.equal(harness.controller.currentId, 'personality-mercury');
  harness.controller.refresh({ ...changed, planetFilter: { selectedPlanets: [], activations: [] } as unknown as PlanetFilterView });
  assert.equal(harness.panel.hidden, true, 'a missing full record still closes rather than inventing details');
});

test('unchecked design planets use only their own full records and never enable a red or black activation', t => {
  const h = popoverHarness(t), original = chartFixture();
  const full = structuredClone(original.activations.design);
  const chart = { ...original, design: [], activations: { ...original.activations, design: [] },
    planetFilter: { selectedPlanets: ['mercury', 'mars'], selectedDesignPlanets: [],
      activations: original.activations.personality, designActivations: full } as unknown as PlanetFilterView };
  const before = JSON.stringify(chart);
  h.addAnchor('design-mercury'); h.controller.show(chart, 'design-mercury');
  assert.equal(h.panel.hidden, false); assert.deepEqual(renderedRows(h.panel), expectedRows(full[0]));
  assert.equal(JSON.stringify(chart), before);
  const changed = { ...chart, planetFilter: { ...chart.planetFilter,
    designActivations: full.map(entry => entry.planet === 'mercury' ? { ...entry, longitude: 307.125 } : entry) } as unknown as PlanetFilterView };
  h.controller.refresh(changed);
  assert.deepEqual(renderedRows(h.panel), expectedRows(changed.planetFilter.designActivations[0]));
  assert.deepEqual(changed.planetFilter.selectedDesignPlanets, []); assert.deepEqual(changed.activations.design, []);
  h.controller.refresh({ ...changed, planetFilter: { ...changed.planetFilter, designActivations: [] } as unknown as PlanetFilterView });
  assert.equal(h.panel.hidden, true, 'missing design data cannot fall back to a same-named black planet');
});

test('design positions 14px left of its matching planet while the number owns the trigger, description and Escape focus', t => {
  const harness = popoverHarness(t), chart = chartFixture();
  const number = harness.addAnchor('design-mercury', rectAt(700, 320));
  const planet = harness.addAnchor('design-mercury-planet', rectAt(660, 320, 32));
  harness.addAnchor('design-sun-planet', rectAt(500, 160, 32));
  harness.controller.show(chart, 'design-mercury');
  assert.equal(harness.controller.currentId, 'design-mercury', 'the numeric activation remains the popup identity');
  assert.equal(harness.panel.dataset.side, 'left');
  assert.equal(panelPosition(harness.panel).left + panelSize.width, planet.rect.left - 14);
  assert.equal(panelPosition(harness.panel).top + Number.parseFloat(harness.panel.style['--arrow-offset']), planet.rect.top + planet.rect.height / 2, 'the arrow aligns with the matching planet');
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
  assert.equal(panelPosition(harness.panel).left, number.rect.right + 12);
  assert.equal(number.getAttribute('aria-describedby'), harness.panel.id);
  assert.equal(planet.getAttribute('aria-describedby'), null);
  assert.ok(!harness.queries.some(query => query.includes('personality-mercury-planet')), 'personality does not resolve the symbol as a positioning reference');
  const content = harness.panel.innerHTML;
  number.column.dataset.columnSide = 'left';
  harness.controller.reposition();
  assert.equal(harness.panel.dataset.side, 'left');
  assert.equal(panelPosition(harness.panel).left + panelSize.width, planet.rect.left - 14, 'the ordinary left slot uses the matching planet independently of its semantic source');
  assert.equal(harness.panel.innerHTML, content);
});

test('a red popup flipped right clears the numeric trigger by 14px so a second click can still reach it', t => {
  const viewport = { left: 0, top: 0, width: 688, height: 820 };
  const harness = popoverHarness(t, { viewport });
  const planet = harness.addAnchor('design-mercury-planet', rectAt(169, 320, 17));
  const number = harness.addAnchor('design-mercury', rectAt(188, 320, 36));
  harness.controller.show(chartFixture(), 'design-mercury');
  const left = panelPosition(harness.panel).left;
  assert.equal(harness.panel.dataset.side, 'right', 'the left side has insufficient room');
  assert.equal(left, number.rect.right + 14, 'the flipped popup clears the entire number, not only its planet');
  assert.ok((number.rect.left + number.rect.right) / 2 < left, 'the number center cannot be covered by the popup');
  assert.equal(panelPosition(harness.panel).top + Number.parseFloat(harness.panel.style['--arrow-offset']), planet.rect.top + planet.rect.height / 2, 'the arrow retains the planet row alignment');
  assert.equal(number.getAttribute('aria-describedby'), harness.panel.id);
  harness.dispatch('document', 'pointerdown', { target: number });
  assert.equal(harness.controller.currentId, 'design-mercury', 'the second number press remains available to the app toggle');
  assertContained({ left, top: panelPosition(harness.panel).top, side: harness.panel.dataset.side, arrow: Number.parseFloat(harness.panel.style['--arrow-offset']) }, panelSize, viewport);
});

test('narrow phone layouts use above or below when a red popup beside the planet would cover its number', t => {
  const harness = popoverHarness(t, { viewport: { left: 0, top: 0, width: 390, height: 844 } });
  for (const [width, planetLeft, numberLeft] of [[390, 89, 108], [320, 20, 39]] as const) {
    for (const [top, expectedSide] of [[200, 'bottom'], [760, 'top']] as const) {
      const viewport = { left: 0, top: 0, width, height: 844 };
      harness.window.visualViewport!.width = width;
      harness.addAnchor('design-mercury-planet', rectAt(planetLeft, top, 17));
      const number = harness.addAnchor('design-mercury', rectAt(numberLeft, top, 36));
      harness.controller.show(chartFixture(), 'design-mercury');
      const popupTop = panelPosition(harness.panel).top;
      assert.equal(harness.panel.dataset.side, expectedSide, 'fitting beside the planet alone is not sufficient');
      assert.ok(expectedSide === 'bottom' ? popupTop >= number.rect.bottom + 14 : popupTop + panelSize.height <= number.rect.top - 14, 'vertical fallback keeps the whole number clear with the same gap');
      assertContained({ left: panelPosition(harness.panel).left, top: popupTop, side: harness.panel.dataset.side, arrow: Number.parseFloat(harness.panel.style['--arrow-offset']) }, panelSize, viewport);
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
  assert.equal(panelPosition(harness.panel).left + panelSize.width, number.rect.left - 14);
  const planet = harness.addAnchor('design-mercury-planet', rectAt(660, 320, 32));
  harness.controller.reposition();
  assert.equal(panelPosition(harness.panel).left + panelSize.width, planet.rect.left - 14, 'a restored symbol becomes the positioning reference');
  harness.anchors.delete('design-mercury-planet');
  harness.controller.reposition();
  assert.equal(harness.controller.currentId, 'design-mercury');
  assert.equal(panelPosition(harness.panel).left + panelSize.width, number.rect.left - 14, 'removing only the symbol restores number positioning');
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
  assert.equal(panelPosition(harness.panel).left + panelSize.width, replacementPlanet.rect.left - 14);
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
    measurePanel(panel: { style: { [x: string]: unknown; }; }) {
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
  assertContained({ left: panelPosition(harness.panel).left, top: panelPosition(harness.panel).top, side: harness.panel.dataset.side, arrow: Number.parseFloat(harness.panel.style['--arrow-offset']) }, { width: 254, height: 126 }, viewport);
  assert.deepEqual(harness.cameraMutations, []);
});

test('unknown identifiers and missing or invalid real activation data stay closed without invented rows', t => {
  const harness = popoverHarness(t);
  harness.addAnchor('personality-mercury');
  harness.addAnchor('design-sun');
  harness.addAnchor('personality-earth');
  for (const id of ['gate-41', 'personality-mercury-planet', 'personality-unknown', 'design-sun"] *', '', undefined, null] as const) {
    harness.controller.show(chartFixture(), id as string);
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
  ] as const) {
    harness.controller.show(chart as ChartInput, 'personality-mercury');
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
  const firstLeft = panelPosition(harness.panel).left;
  const replacement = harness.addAnchor('personality-mercury', rectAt(850, 500));
  harness.controller.refresh(chart);
  assert.equal(harness.controller.currentId, 'personality-mercury');
  assert.equal(harness.panel.hidden, false);
  assert.notEqual(panelPosition(harness.panel).left, firstLeft, 'placement uses the new SVG element rather than a detached node');
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
  assert.equal((harness.listeners.get('document:pointerdown')![0].options as AddEventListenerOptions).capture, true, 'outside presses are observed before graph selection');
  for (const target of [harness.panel, harness.panelChild, anchor, { closest: () => anchor }] as const) {
    const event = harness.dispatch('document', 'pointerdown', { target });
    assert.equal(harness.controller.currentId, 'personality-mercury');
    assert.equal(event.defaultPrevented, false, 'the anchor can still reach the ordinary selection handler and toggle there');
  }
  for (const target of [{}, otherAnchor] as const) {
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

test('shared viewport resize and movement reposition the popup using current screen coordinates', t => {
  const viewport = { left: 35, top: 80, width: 320, height: 520 };
  const harness = popoverHarness(t, { viewport }), chart = chartFixture();
  const anchor = harness.addAnchor('personality-mercury', rectAt(160, 200));
  harness.controller.show(chart, 'personality-mercury');
  const checkPlacement = () => {
    const position = { left: panelPosition(harness.panel).left, top: panelPosition(harness.panel).top, side: harness.panel.dataset.side, arrow: Number.parseFloat(harness.panel.style['--arrow-offset']) };
    assertContained(position, harness.panel.getBoundingClientRect(), { left: harness.window.visualViewport!.offsetLeft, top: harness.window.visualViewport!.offsetTop, width: harness.window.visualViewport!.width, height: harness.window.visualViewport!.height });
  };
  checkPlacement();
  assert.equal(harness.panel.style.maxWidth, '296px');
  for (const [surface, type] of [['window', 'resize'], ['visualViewport', 'resize'], ['visualViewport', 'scroll']] as const) {
    const previousTop = panelPosition(harness.panel).top;
    anchor.rect = rectAt(anchor.rect.left, anchor.rect.top + 35);
    harness.window.visualViewport!.offsetTop += 5;
    harness.dispatch(surface, type);
    assert.notEqual(panelPosition(harness.panel).top, previousTop, `${surface} ${type} recomputes placement`);
    assert.equal(harness.controller.currentId, 'personality-mercury');
    checkPlacement();
  }
  assert.deepEqual(harness.cameraMutations, []);
  harness.controller.close();
  assert.equal(harness.viewportLayout.subscriberCount, 0);
  for (const key of ['window:resize', 'visualViewport:resize', 'visualViewport:scroll'] as const) {
    assert.equal(harness.listeners.get(key)?.length || 0, 1, 'the page viewport owner survives popup dismissal');
  }
  harness.controller.show(chart, 'personality-mercury');
  assert.equal(harness.viewportLayout.subscriberCount, 1);
  assert.equal(harness.listeners.get('window:resize')!.length, 1, 'reopening cannot create another native subscription');
});

test('an open activation uses corrected layout bounds and subscribes only until dismissal', t => {
  const listeners = new Set<() => void>();
  let corrected = { left: 0, top: 0, width: 390, height: 844 };
  const h = popoverHarness(t, { viewport: { left: 0, top: 100, width: 390, height: 300 }, viewportLayout: {
    readViewport: () => corrected,
    subscribeViewport: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  } });
  assert.equal(listeners.size, 0, 'a hidden popup has no viewport work');
  const anchor = h.addAnchor('personality-mercury', rectAt(161, 650));
  h.controller.show(chartFixture(), 'personality-mercury');
  assert.equal(h.panel.hidden, false, 'stale Safari keyboard bounds cannot dismiss a visible activation');
  assert.equal(h.panel.style['--popover-max-height'], '820px');
  assert.equal(listeners.size, 1);
  for (const key of ['window:resize', 'visualViewport:resize', 'visualViewport:scroll'] as const) {
    assert.equal(h.listeners.get(key)?.length || 0, 0, `${key} belongs to the layout owner`);
  }
  corrected = { left: 0, top: 20, width: 390, height: 500 };
  anchor.rect = rectAt(161, 300); h.measurements.length = 0;
  for (const notify of listeners) notify();
  assert.equal(h.panel.style['--popover-max-height'], '476px');
  assert.equal(h.measurements.filter(value => value === 'personality-mercury').length, 1);
  const previous = panelPosition(h.panel).top;
  anchor.rect = rectAt(161, 330); h.controller.reposition();
  assert.notEqual(panelPosition(h.panel).top, previous, 'camera changes retain their independent reposition command');
  h.controller.close(); assert.equal(listeners.size, 0);
  h.controller.show(chartFixture(), 'personality-mercury'); assert.equal(listeners.size, 1);
  anchor.rect = rectAt(161, 700);
  for (const notify of [...listeners] as const) notify();
  assert.equal(h.panel.hidden, true); assert.equal(listeners.size, 0, 'offscreen dismissal releases its subscription');
});

test('the shared viewport supplies full page bounds when visualViewport is unavailable', t => {
  const harness = popoverHarness(t, { visual: false, viewport: { left: 0, top: 0, width: 390, height: 844 } });
  harness.addAnchor('personality-mercury', rectAt(161, 300));
  harness.controller.show(chartFixture(), 'personality-mercury');
  assert.equal(harness.panel.hidden, false);
  assert.equal(harness.panel.style.maxWidth, '366px');
  assert.equal(harness.panel.dataset.side, 'bottom');
  assert.equal(panelPosition(harness.panel).top, 352);
});

test('camera movement changes only the 2D translation while reading the current red planet and numeric bounds', t => {
  const h = popoverHarness(t);
  const number = h.addAnchor('design-mercury', rectAt(700, 320));
  const planet = h.addAnchor('design-mercury-planet', rectAt(660, 320, 32));
  h.controller.show(chartFixture(), 'design-mercury');
  const content = h.panel.innerHTML;
  h.styleWrites.length = h.measurements.length = 0;
  for (let frame = 1; frame <= 120; frame++) {
    number.rect = rectAt(700 + frame / 4, 320 + frame / 8);
    planet.rect = rectAt(660 + frame / 4, 320 + frame / 8, 32);
    h.controller.reposition();
    assert.equal(panelPosition(h.panel).left + panelSize.width, planet.rect.left - 14);
  }
  assert.equal(h.styleWrites.length, 120, 'one changed transform write per moving frame');
  assert.ok(h.styleWrites.every(([name]) => name === 'transform'), 'no repeated layout-position, sizing or arrow writes');
  assert.equal(h.measurements.filter(id => id === 'design-mercury').length, 120);
  assert.equal(h.measurements.filter(id => id === 'design-mercury-planet').length, 120);
  assert.equal(h.measurements.filter(id => id === 'panel').length, 120, 'actual popup size remains authoritative');
  assert.equal(h.panel.innerHTML, content, 'repositioning retains the content and its scroll container');
  assert.equal(h.panel.style.left, undefined); assert.equal(h.panel.style.top, undefined);
  h.styleWrites.length = 0; h.controller.reposition();
  assert.deepEqual(h.styleWrites, [], 'an unchanged position writes no styles');
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const rule = css.match(/\.activation-popover\s*\{([^}]+)\}/)![1];
  assert.match(rule, /position: fixed;/); assert.match(rule, /left: 0;/); assert.match(rule, /top: 0;/);
  assert.doesNotMatch(rule, /will-change|translate3d/, 'no forced GPU text layer is introduced');
});

test('panning an anchor out of view or removing it dismisses the popup without changing the camera', t => {
  const harness = popoverHarness(t), chart = chartFixture();
  const anchor = harness.addAnchor('personality-mercury');
  for (const rect of [rectAt(-68, 200), rectAt(1440, 200), rectAt(600, -40), rectAt(600, 900)] as const) {
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


test('overlay popovers resolve four exact origins rather than borrowing the natal gate line', t => {
  const h = popoverHarness(t), natal = chartFixture(), cycle = chartFixture();
  cycle.activations.personality[0] = { planet: 'mercury', gate: 41, line: 6, longitude: 307.1 };
  const chart = overlayFixture(natal, cycle, { kind: 'return' as const, event: { id: 'saturn:1:1' } });
  for (const [id, caption, line] of [
    ['natal-personality-mercury', 'Личная карта · Личность', 1],
    ['natal-design-mercury', 'Личная карта · Дизайн', 6],
    ['cycle-personality-mercury', 'Возврат · Личность', 6],
    ['cycle-design-mercury', 'Возврат · Дизайн', 6],
  ] as const) {
    const anchor = h.addAnchor(id); h.controller.show(chart, id);
    assert.equal(h.panel.hidden, false, id);
    assert.ok(h.panel.innerHTML.includes(caption));
    assert.equal(renderedRows(h.panel)[1].value, line);
    const originalSide = anchor.column.dataset.columnSide;
    assert.equal(h.panel.dataset.side, originalSide, 'both sources use the actual origin column side');
    const content = h.panel.innerHTML;
    anchor.column.dataset.columnSide = originalSide === 'left' ? 'right' : 'left';
    h.controller.reposition();
    assert.equal(h.panel.dataset.side, anchor.column.dataset.columnSide, 'placement follows the container, never a source or origin inferred from the activation ID');
    assert.equal(h.panel.innerHTML, content, 'moving a column does not change its exact activation details');
  }
  cycle.activations.design = [];
  h.controller.refresh(chart); assert.equal(h.panel.hidden, true, 'a missing original entry closes rather than falling back to natal');
});


test('source caption leaves its text readable on the dark popup and keeps origin color in a separate decorative swatch', t => {
  const h = popoverHarness(t), natal = chartFixture(), cycle = chartFixture();
  const chart = overlayFixture(natal, cycle, { kind: 'return' as const, event: { id: 'saturn:1:1' } });
  for (const [id, color, label] of [['natal-personality-mercury', '#c32d35', 'Личная карта · Личность'], ['cycle-design-mercury', '#202020', 'Возврат · Дизайн']] as const) {
    h.addAnchor(id); h.controller.show(chart, id);
    const caption = h.panel.innerHTML.match(/<p class="cycle-activation-caption"([^>]*)>([\s\S]*?)<\/p>/);
    assert.ok(caption);
    assert.doesNotMatch(caption![1], /(?:^|[;"\s])color\s*:/, 'dark source color must not override the light popup text');
    assert.match(caption![2], /class="cycle-activation-swatch"/);
    assert.ok(caption![2].includes(`--cycle-source-color:${color}`));
    assert.match(caption![2], /aria-hidden="true"/);
    assert.ok(caption![2].includes(label));
    assert.equal(renderedRows(h.panel).length, 5, 'exact numeric details remain available');
  }
});

test('overlay popover names are escaped as user text and refresh when the natal chart is renamed', t => {
  const h = popoverHarness(t), natal = { ...chartFixture(), name: 'Марат <img src=x> & "друг"' }, cycle = chartFixture();
  const chart = overlayFixture(natal, cycle, { kind: 'return' as const, event: { id: 'saturn:1:1' } });
  h.addAnchor('natal-personality-mercury'); h.controller.show(chart, 'natal-personality-mercury');
  assert.ok(h.panel.innerHTML.includes('Марат &lt;img src=x&gt; &amp; &quot;друг&quot; · Личность'));
  assert.doesNotMatch(h.panel.innerHTML, /<img/);
  h.controller.refresh(overlayFixture({ ...natal, name: 'Анна <svg>' }, cycle, { kind: 'return' as const, event: { id: 'saturn:1:1' } }));
  assert.ok(h.panel.innerHTML.includes('Анна &lt;svg&gt; · Личность'));
  assert.doesNotMatch(h.panel.innerHTML, /Марат|<svg/);
});


test('single composition popovers use the exact primary row without copying or reprojection', t => {
  const h = popoverHarness(t), raw = chartFixture();
  h.addAnchor('personality-mercury');
  h.controller.show(createChartComposition(raw), 'personality-mercury');
  assert.equal(h.panel.hidden, false);
  assert.deepEqual(renderedRows(h.panel), expectedRows(raw.activations.personality[0]));
});


test('retired popover closes and cannot reacquire its viewport subscription',t=>{
 const owner=new AbortController();let subscriptions=0;
 const h=popoverHarness(t,{signal:owner.signal,viewportLayout:{readViewport:()=>({left:0,top:0,width:1440,height:900}),
  subscribeViewport:()=>{subscriptions++;return()=>{subscriptions--;return true;};}}});
 h.addAnchor('personality-mercury');const chart=chartFixture();h.controller.show(chart,'personality-mercury');
 assert.equal(subscriptions,1);owner.abort();assert.equal(subscriptions,0);assert.equal(h.panel.hidden,true);
 h.controller.show(chart,'personality-mercury');h.controller.refresh(chart);h.controller.reposition();
 assert.equal(subscriptions,0);assert.equal(h.controller.currentId,null);
 assert.equal([...h.listeners.values()].flat().length,0);
});
