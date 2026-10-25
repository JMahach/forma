import test from 'node:test';
import assert from 'node:assert/strict';
import { attachChartSummary } from '../src/views/chart-summary-panel.ts';
import { attachPanelKeyboard } from '../src/views/side-panel-controls.ts';
import { createPanelState } from '../src/state/panels.ts';
import { attachChartLibrary } from '../src/views/library.ts';

type SummaryOptions = Parameters<typeof attachChartSummary>[0];
interface SummaryEvent {
  target: SummaryNode; defaultPrevented: boolean; shiftKey: boolean; preventDefault(): void;
  [key: string]: unknown;
}
interface SummaryNode {
  tagName: string; dataset: Record<string, string>; parentElement: SummaryNode | null; children: SummaryNode[];
  hidden: boolean; inert: boolean; value: string; scrollTop: number; disabled: boolean; open: boolean; markupWrites: number;
  ownerDocument: SummaryNode; innerHTML: string; innerWidth?: number; defaultView?: SummaryNode; focusOptions?: FocusOptions;
  classList: { toggle(name: string, force?: boolean): boolean; contains(name: string): boolean };
  setAttribute(name: string, value: unknown): void; getAttribute(name: string): string | null;
  addEventListener(type: string, handler: (event: SummaryEvent) => void): void;
  dispatch(type: string, options?: Partial<SummaryEvent>): SummaryEvent;
  focus(options?: FocusOptions): void; contains(other: SummaryNode | null): boolean; matches(selector: string): boolean;
  closest(selector: string): SummaryNode | null; querySelectorAll(selector: string): SummaryNode[];
  querySelector(selector: string): SummaryNode | null;
  getElementById?(id: string): SummaryNode | undefined; getBoundingClientRect?(): { top: number; bottom: number };
}
interface HarnessOptions {
  initialReturnsVisible?: boolean; width?: number; withBackdrop?: boolean; callbacks?: boolean;
  panels?: ReturnType<typeof createPanelState>;
}

function harness({ initialReturnsVisible = false, width = 1440, withBackdrop = true, callbacks = true, panels = createPanelState() }: HarnessOptions = {}) {
  const globals = { activeElement: null as SummaryNode | null, dialogOpen: false, libraryOpen: false };
  let document: SummaryNode;
  function node(tag = 'div', attributes: Record<string, string> = {}): SummaryNode {
    const attrs = new Map<string, string>(), classes = new Set<string>(), listeners = new Map<string, ((event: SummaryEvent) => void)[]>();
    let markup = '';
    const element: SummaryNode = {
      tagName: tag.toUpperCase(), dataset: {}, parentElement: null, children: [], hidden: false, inert: false,
      value: '', scrollTop: 0, disabled: false, open: false, markupWrites: 0,
      get ownerDocument() { return document; },
      classList: {
        toggle(name: string, force?: boolean) { const next = force ?? !classes.has(name); if (next) classes.add(name); else classes.delete(name); return next; },
        contains(name: string) { return classes.has(name); },
      },
      setAttribute(name: string, value: unknown) {
        attrs.set(name, String(value));
        if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
      },
      getAttribute(name: string) { return attrs.get(name) ?? null; },
      addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type)!.push(handler); },
      dispatch(type: string, options = {}) {
        const event = { target: this, defaultPrevented: false, shiftKey: false, preventDefault() { this.defaultPrevented = true; }, ...options };
        for (const handler of listeners.get(type) || []) handler(event);
        return event;
      },
      focus(options?: FocusOptions) { globals.activeElement = this; this.focusOptions = options; },
      contains(other) { for (let current = other; current; current = current.parentElement) if (current === this) return true; return false; },
      matches(selector: string) {
        if (selector === 'button') return this.tagName === 'BUTTON';
        const attribute = selector.match(/^\[([^\]]+)\]$/)?.[1];
        return attribute ? attrs.has(attribute) : false;
      },
      closest(selector: string) { for (let current: SummaryNode | null = this; current; current = current.parentElement) if (current.matches(selector)) return current; return null; },
      querySelectorAll(selector: string) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
      querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; },
      get innerHTML() { return markup; },
      set innerHTML(html) {
        this.markupWrites++;
        markup = html;

      },
    };
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    return element;
  }
  const studio = node(), panel = node('aside', { 'aria-labelledby': 'chartSummaryTitle' });
  const summaryScreen = node(), returnsPanel = node('section', { 'aria-labelledby': 'returnsTitle' });
  const returnsBack = node('button'), returnsButton = node('button');
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
  returnsButton.parentElement = summaryScreen;
  returnsBack.parentElement = returnsPanel;
  summaryScreen.children = [returnsButton];
  returnsPanel.children = [returnsBack]; returnsPanel.hidden = true;
  panel.children = [summaryScreen, returnsPanel];
  document = node();
  Object.defineProperty(document, 'activeElement', { get: () => globals.activeElement });
  document.querySelector = selector => selector === 'dialog[open]' && globals.dialogOpen || selector === '.library.open' && globals.libraryOpen ? {} as SummaryNode : null;
  const window = node(); window.innerWidth = width;
  document.defaultView = window;
  document.getElementById = id => id === 'chartSummary' ? panel : id === 'summarySwitch' ? switcher : undefined;
  attachPanelKeyboard(document as unknown as Document, panels);
  let openCalls = 0, closeCalls = 0, returnsCalls = 0;
  const config = {
    panels, initialReturnsVisible, panel, summaryScreen, returnsPanel, switcher, backdrop, returnsButton,
    onReturns() { returnsCalls++; controller.setReturnsVisible(true); },
  } as unknown as SummaryOptions;
  if (callbacks) {
    config.onOpen = () => { openCalls++; globals.libraryOpen = false; };
    config.onClose = () => { closeCalls++; };
  }
  const controller = attachChartSummary(config as unknown as SummaryOptions);
  return {
    controller, panels, node, globals, document, window, panel, summaryScreen, returnsPanel, returnsBack, returnsButton,
    switcher, canvas, camera, studio, backdrop,
    resize(value: number) { window.innerWidth = value; window.dispatch('resize'); controller.layout(); },
    get openCalls() { return openCalls; },
    get closeCalls() { return closeCalls; },
    get returnsCalls() { return returnsCalls; },
  };
}

test('single button toggles the accessible overlay and focuses Returns without scrolling', () => {
  const h = harness();
  assert.equal(h.controller.opened, false);
  assert.equal(h.panel.inert, true);
  assert.equal(h.panel.getAttribute('aria-hidden'), 'true');
  assert.equal(h.backdrop!.hidden, true);
  assert.equal(h.switcher.getAttribute('aria-expanded'), 'false');
  assert.equal(h.panel.hidden, false, 'CSS can animate the rendered drawer in both directions');
  h.globals.libraryOpen = true;
  h.switcher.dispatch('click');
  assert.equal(h.controller.opened, true);
  assert.equal(h.panel.classList.contains('open'), true);
  assert.equal(h.panel.inert, false);
  assert.equal(h.panel.getAttribute('aria-hidden'), 'false');
  assert.equal(h.backdrop!.hidden, false);
  assert.equal(h.switcher.getAttribute('aria-expanded'), 'true');
  assert.equal(h.globals.activeElement, h.returnsButton);
  assert.deepEqual(h.returnsButton.focusOptions, { preventScroll: true });
  assert.equal(h.globals.libraryOpen, false, 'opening invokes coordination with the other drawer');
  assert.equal(h.openCalls, 1);
  h.controller.open();
  assert.equal(h.openCalls, 1, 'opening an open drawer does not repeat side effects');
  h.switcher.dispatch('click');
  assert.equal(h.controller.opened, false);
  assert.equal(h.panel.classList.contains('open'), false);
  assert.equal(h.panel.inert, true);
  assert.equal(h.panel.getAttribute('aria-hidden'), 'true');
  assert.equal(h.backdrop!.hidden, true);
  assert.equal(h.switcher.getAttribute('aria-expanded'), 'false');
  assert.equal(h.globals.activeElement, h.switcher);
  assert.deepEqual(h.switcher.focusOptions, { preventScroll: true });
  assert.equal(h.closeCalls, 1);
  h.controller.close();
  assert.equal(h.closeCalls, 1, 'closing a closed drawer does not repeat side effects');
});

test('opening, resizing and closing never measure, hide, disable or transform the chart', () => {
  for (const width of [390, 850, 1440] as const) {
    const h = harness({ width });
    const markup = h.canvas.innerHTML;
    for (const operation of [h.controller.open, () => h.resize(800), h.controller.layout, () => h.resize(1440), h.controller.close] as const) {
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

test('backdrop closes and restores focus from anywhere inside the panel', () => {
  const h = harness();
  h.controller.open();
  h.returnsButton.focus();
  h.backdrop!.dispatch('click');
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
  assert.equal(h.globals.activeElement, h.returnsButton);
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

test('Escape closes summary unless a dialog or earlier handler owns the event', () => {
  const h = harness({ width: 390 });
  h.controller.open();
  h.window.dispatch('keydown', { key: 'Enter' });
  assert.equal(h.controller.opened, true);
  for (const blocker of ['dialogOpen'] as const) {
    h.globals[blocker] = true;
    const event = h.window.dispatch('keydown', { key: 'Escape' });
    assert.equal(h.controller.opened, true);
    assert.equal(event.defaultPrevented, false);
    h.globals[blocker] = false;
  }
  h.window.dispatch('keydown', { key: 'Escape', defaultPrevented: true });
  assert.equal(h.controller.opened, true);
  const event = h.window.dispatch('keydown', { key: 'Escape' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.controller.opened, false);
  assert.equal(h.canvas.inert, false);
  assert.equal(h.globals.activeElement, h.switcher);
});

test('single native button does not consume obsolete segmented-control arrow shortcuts', () => {
  const h = harness();
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab'] as const) {
    assert.equal(h.switcher.dispatch('keydown', { key }).defaultPrevented, false);
    assert.equal(h.controller.opened, false);
  }
});

function observeLayoutWrites(h: ReturnType<typeof harness>) {
  const writes: string[] = [];
  for (const [element, property] of [[h.panel, 'hidden'], [h.panel, 'inert'], [h.backdrop!, 'hidden']] as const) {
    let value = element[property];
    Object.defineProperty(element, property, {
      get: () => value,
      set(next) { writes.push(property); value = next; },
    });
  }
  for (const [element, method] of [[h.panel, 'setAttribute'], [h.switcher, 'setAttribute'], [h.panel.classList, 'toggle']] as const) {
    const observed = element as unknown as Record<typeof method, (name: string, value?: unknown) => unknown>;
    const original = observed[method];
    observed[method] = function (...args: [string, unknown?]) { writes.push(args[0]); return original.apply(this, args); };
  }
  return writes;
}

test('camera layout repeats perform no DOM writes, including after resize and close', () => {
  const h = harness(), writes = observeLayoutWrites(h);
  for (const opened of [false, true, false] as const) {
    if (opened) h.controller.open(); else h.controller.close();
    writes.length = 0;
    for (let i = 0; i < 1000; i++) h.controller.layout();
    assert.equal(writes.length, 0, `unchanged ${opened ? 'open' : 'closed'} drawer does not rewrite DOM`);
    h.resize(opened ? 390 : 1440);
    assert.equal(writes.length, 0, 'responsive CSS does not require repeating drawer state writes');
    assert.equal(h.panel.hidden, false, 'closing transition retains the rendered panel');
    assert.equal(h.panel.inert, !opened);
    assert.equal(h.panel.classList.contains('open'), opened);
    assert.equal(h.backdrop!.hidden, !opened);
  }
  assert.equal(h.openCalls, 1);
  assert.equal(h.closeCalls, 1);
  assert.equal(h.globals.activeElement, h.switcher);
});

test('Returns projection preserves a closed shell until its explicit opening command', () => {
  const h = harness();
  h.switcher.focus();
  assert.equal(typeof h.controller.setReturnsVisible, 'function');
  h.controller.setReturnsVisible(true);
  assert.equal(h.controller.opened, false);
  assert.equal(h.panels.right, false);
  h.controller.open();
  assert.equal(h.controller.opened, true);
  assert.equal(h.controller.screen, 'returns');
  assert.equal(h.panel.dataset.screen, 'returns');
  assert.equal(h.panel.classList.contains('open'), true);
  assert.equal(h.panel.inert, false);
  assert.equal(h.panel.getAttribute('aria-hidden'), 'false');
  assert.equal(h.panel.getAttribute('aria-labelledby'), 'returnsTitle');
  assert.equal(h.summaryScreen.hidden, true);
  assert.equal(h.returnsPanel.hidden, false);
  assert.equal(h.backdrop!.hidden, false);
  assert.equal(h.switcher.getAttribute('aria-expanded'), 'true');
  assert.equal(h.globals.activeElement, h.switcher, 'the returns view chooses its own initial focus');
  assert.equal(h.openCalls, 1);
  assert.equal(h.closeCalls, 0);
});

test('closing and reopening the shell preserves the active Returns screen', () => {
  for (const dismiss of [(h: ReturnType<typeof harness>) => h.controller.close(), (h: ReturnType<typeof harness>) => h.switcher.dispatch('click'), (h: ReturnType<typeof harness>) => h.backdrop!.dispatch('click')]) {
    const h = harness();
    h.panels.setRight(true); h.controller.setReturnsVisible(true); h.returnsBack.focus();
    dismiss(h);
    assert.equal(h.controller.screen, 'closed');
    assert.equal(h.controller.opened, false);
    assert.equal(h.panel.classList.contains('open'), false);
    assert.equal(h.panel.inert, true);
    assert.equal(h.panel.getAttribute('aria-hidden'), 'true');
    assert.equal(h.backdrop!.hidden, true);
    assert.equal(h.switcher.getAttribute('aria-expanded'), 'false');
    assert.equal(h.panel.dataset.screen, 'returns', 'closing keeps the same presentation for its slide out');
    assert.equal(h.returnsPanel.hidden, false, 'the inert shell can still animate its contents');
    assert.equal(h.globals.activeElement, h.switcher);
    assert.deepEqual(h.switcher.focusOptions, { preventScroll: true });
    assert.equal(h.closeCalls, 1);
    h.controller.close(); h.controller.layout();
    assert.equal(h.closeCalls, 1);
    assert.equal(h.openCalls, 0);
    h.controller.open();
    assert.equal(h.controller.screen, 'returns');
    assert.equal(h.returnsPanel.hidden, false);
    assert.equal(h.summaryScreen.hidden, true);
  }
});

test('Escape consumed by a nested return control leaves the shell open; the next Escape closes it', () => {
  const h = harness();
  h.panels.setRight(true); h.controller.setReturnsVisible(true); h.returnsBack.focus();
  h.window.dispatch('keydown', { key: 'Escape', defaultPrevented: true });
  assert.equal(h.controller.screen, 'returns');
  assert.equal(h.closeCalls, 0);
  const event = h.window.dispatch('keydown', { key: 'Escape' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.controller.screen, 'closed');
  assert.equal(h.closeCalls, 0, 'the shared keyboard owner changes shell state without invoking content callbacks');
  assert.equal(h.globals.activeElement, h.switcher);
});

test('returns projection and camera layout repeats preserve focus and avoid shell DOM writes', () => {
  const h = harness();
  h.panels.setRight(true); h.controller.setReturnsVisible(true); h.returnsBack.focus();
  const writes = observeLayoutWrites(h);
  for (let i = 0; i < 1000; i++) { h.controller.setReturnsVisible(true); h.controller.layout(); }
  h.resize(390); h.resize(1440);
  assert.equal(writes.length, 0);
  assert.equal(h.globals.activeElement, h.returnsBack);
  assert.equal(h.controller.screen, 'returns');
  assert.equal(h.openCalls, 0);
  assert.equal(h.closeCalls, 0);
});

test('leaving returns keeps the right panel open and restores summary focus without a close command', () => {
  const h = harness();
  h.panels.setRight(true); h.controller.setReturnsVisible(true); h.returnsBack.focus();
  h.controller.setReturnsVisible(false);
  assert.equal(h.controller.screen, 'summary');
  assert.equal(h.panel.inert, false);
  assert.equal(h.globals.activeElement, h.returnsButton);
  assert.equal(h.closeCalls, 0);
  h.controller.setReturnsVisible(true); h.canvas.focus();
  h.controller.setReturnsVisible(false);
  assert.equal(h.globals.activeElement, h.canvas, 'external navigation retains its own focus');
});

test('restoring panel state opens summary without taking focus or closing the left panel', () => {
  const h = harness();
  h.canvas.focus();
  h.panels.restore({ left: true, right: true });
  assert.equal(h.controller.screen, 'summary');
  assert.equal(h.panel.classList.contains('open'), true);
  assert.equal(h.panels.left, true);
  assert.equal(h.globals.activeElement, h.canvas);
  assert.equal(h.openCalls, 0);
  h.controller.close();
  assert.deepEqual(h.panels.snapshot, { left: true, right: false });
});


test('library and summary use one independent panel state and DOM synchronization does not steal focus', () => {
  const h = harness(), ids = new Map<string, SummaryNode>();
  for (const id of ['library', 'chartList', 'libraryCount', 'nowButton', 'libraryBackdrop', 'openLibrary',
    'newChartButton', 'deleteChartName', 'deleteChartError', 'deleteChartDialog', 'cancelDeleteChart', 'confirmDeleteChart'] as const) ids.set(id, h.node());
  const libraryPanel = ids.get('library'), nowButton = ids.get('nowButton');
  nowButton!.parentElement = libraryPanel!;
  ids.get('chartList')!.getBoundingClientRect = () => ({ top: 0, bottom: 300 });
  h.document.getElementById = id => ids.get(id);
  const library = attachChartLibrary({ document: h.document, panels: h.panels,
    store: { charts: [] }, session: { selectedId: 'current-transit' } } as unknown as Parameters<typeof attachChartLibrary>[0]);
  h.controller.open(); library.open();
  assert.deepEqual(h.panels.snapshot, { left: true, right: true });
  assert.equal(library.opened, true);
  assert.equal(h.controller.opened, true);
  assert.equal(h.globals.activeElement, nowButton);
  h.canvas.focus(); h.panels.restore({ left: false, right: true }); library.syncOpen();
  assert.equal(libraryPanel!.inert, true);
  assert.equal(ids.get('openLibrary')!.getAttribute('aria-expanded'), 'false');
  assert.equal(h.globals.activeElement, h.canvas);
  h.panels.setLeft(true); library.syncOpen();
  assert.equal(libraryPanel!.inert, false);
  assert.equal(h.globals.activeElement, h.canvas, 'restoration and layout synchronization do not move focus');
  h.controller.close();
  assert.equal(library.opened, true);
  ids.get('openLibrary')!.dispatch('click');
  assert.deepEqual(h.panels.snapshot, { left: false, right: false });
});


test('restored returns shell attaches directly without a temporary summary or another panel request', () => {
  for (const right of [false, true] as const) {
    const panels = createPanelState(); panels.restore({ left: true, right });
    let changes = 0; panels.subscribe(() => changes++);
    const h = harness({ panels, initialReturnsVisible: true });
    assert.equal(h.panel.dataset.screen, 'returns');
    assert.equal(h.controller.screen, right ? 'returns' : 'closed');
    assert.equal(h.summaryScreen.hidden, true);
    assert.equal(h.returnsPanel.hidden, false);
    h.controller.setReturnsVisible(true);
    assert.equal(changes, 0, 'attaching restored content cannot reopen the panel');
    assert.deepEqual(panels.snapshot, { left: true, right });
  }
});

test('Back restores the ordinary panel and focuses its Returns entry', () => {
  const h = harness();
  h.controller.open();
  h.returnsButton.dispatch('click');
  h.returnsBack.focus();
  h.controller.setReturnsVisible(false);
  assert.equal(h.controller.screen, 'summary');
  assert.equal(h.panel.dataset.screen, 'summary');
  assert.equal(h.panel.getAttribute('aria-labelledby'), 'chartSummaryTitle');
  assert.equal(h.summaryScreen.hidden, false);
  assert.equal(h.returnsPanel.hidden, true);
  assert.equal(h.globals.activeElement, h.returnsButton);
  assert.equal(h.openCalls, 1);
  assert.equal(h.closeCalls, 0);
});

for (const width of [390, 1440] as const) test(`Returns entry at ${width}px changes the shared screen without closing its shell`, () => {
  const h = harness({ width });
  h.controller.open();
  h.returnsButton.dispatch('click');
  assert.equal(h.returnsCalls, 1);
  assert.equal(h.controller.screen, 'returns');
  assert.equal(h.controller.opened, true);
  assert.equal(h.closeCalls, 0);
  h.returnsBack.focus();
  h.controller.open();
  assert.equal(h.controller.screen, 'returns', 'an already open shell does not change its active instrument');
  assert.equal(h.globals.activeElement, h.returnsBack);
});

for (const property of ['hidden', 'disabled'] as const) test(`a ${property} Returns entry never receives focus or dispatches an action`, () => {
  const h = harness();
  h.returnsButton[property] = true;
  h.controller.open();
  assert.equal(h.globals.activeElement, h.switcher);
  h.returnsButton.dispatch('click');
  assert.equal(h.returnsCalls, 0);
  h.panels.setRight(true); h.controller.setReturnsVisible(true); h.returnsBack.focus();
  h.controller.setReturnsVisible(false);
  assert.equal(h.globals.activeElement, h.switcher);
});
