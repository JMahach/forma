import type { LifetimePoint } from '../src/domain/lifetime.ts';
import type { CycleInput } from '../shared/cycles-format.ts';
import type { TestStub } from './helpers/test-stub.ts';
type TestChart = Partial<SavedChart> & { id: string };
type BrowserListener = (event: Record<string, unknown>) => unknown;
interface BrowserElement {
  id: string; ownerDocument: BrowserDocument; dataset: Record<string, string>; hidden: boolean; inert: boolean; innerHTML: string;
  style: { setProperty(name: string, value: string): void; [name: string]: unknown };
  children: BrowserElement[]; parentElement?: BrowserElement | null; firstChild: BrowserElement | null; nextSibling: BrowserElement | null;
  insertBefore(child: BrowserElement, before: BrowserElement | null): void; replaceChildren(...next: BrowserElement[]): void; remove(): void;
  contains(node: { id?: string } | null): boolean; focus(): void;
  querySelector(selector: string): BrowserElement | null; querySelectorAll(): BrowserElement[];
  getBoundingClientRect(): { top: number; bottom: number; left: number; right: number; width: number; height: number };
  setAttribute(name: string, value: unknown): void; getAttribute(name: string): string | null; removeAttribute(name: string): void;
  classList: { add(name: string): unknown; remove(name: string): unknown; contains(name: string): boolean; toggle(name: string, enabled?: boolean): void };
  addEventListener(type: string, handler: BrowserListener, capture?: boolean): void;
  dispatch(type: string, event?: Record<string, unknown>): Promise<void>; click(): Promise<void>;
  open?: boolean; textContent?: string; value?: string; title?: string; showModal(): void; close(): void;
}
interface BrowserDocument {
  body: { dataset: Record<string, string> }; activeElement: BrowserElement | null; fonts?: { ready: Promise<unknown> };
  createElement(tag: string): BrowserElement; getElementById(id: string): BrowserElement | null;
  querySelector(selector: string): BrowserElement | null; querySelectorAll(): BrowserElement[];
  addEventListener(type: string, handler: BrowserListener): void;
  dispatch(type: string, event: Record<string, unknown>): unknown;
}
import type { SavedChart } from '../shared/chart-types.ts';
import type { SavedView } from '../src/data/view-store.ts';
import type { LifetimeMetadata } from '../shared/lifetime-format.ts';
import type { CycleEvent } from '../shared/cycles-format.ts';
import type { StudioLayout } from '../src/ui/layout/studio-controller.ts';
import type { TimelineKind } from '../src/ui/layout/studio.ts';
import type { Camera } from '../src/scene/camera.ts';
import type { ChartView, ChartComposition, ChartInput } from '../src/domain/chart-composition.ts';
import type { attachLifetimeControls } from '../src/views/lifetime-controls.ts';
import type { attachReturnsPanel, ReturnsPanelState } from '../src/views/returns-panel.ts';
interface HarnessOptions {
  realSummary?: boolean; search?: string; restore?: () => Promise<boolean>; savedView?: TestStub<SavedView> | null;
  fonts?: Promise<unknown>; initialPresentation?: ReturnType<typeof studioPresentation> | null;
  studioSize?: { width: number; height: number } | null; metaError?: unknown;
  charts?: readonly TestChart[]; loadKnowledge?: (() => Promise<unknown>) | null;
  chartsReady?: (() => Promise<unknown>) | null; returnEvents?: (Pick<CycleEvent, 'id' | 'body' | 'utc' | 'cycle'> & Partial<CycleEvent>)[];
  getReturn?: (input: CycleInput, signal?: AbortSignal) => Promise<{ chart: ChartInput; event?: Partial<CycleEvent> }>;
  getPoint?: (index: number, options?: { signal?: AbortSignal }) => Promise<LifetimePoint>;
}
// Real argument contracts for injected browser ports; each test supplies its own result.
type AppPorts = Pick<typeof import('../src/views/knowledge-entry.ts'), 'attachKnowledgeEntry'>
  & Pick<typeof import('../src/views/activation-popover.ts'), 'attachActivationPopover'>
  & Pick<typeof import('../src/selection/hover-preview.ts'), 'attachHoverPreview'>
  & Pick<typeof import('../src/scene/activation-hover.ts'), 'attachActivationHover'>
  & Pick<typeof import('../src/scene/gestures.ts'), 'attachGestures'>
  & Pick<typeof import('../src/scene/pointer-target.ts'), 'pointerTarget'>
  & Pick<typeof import('../src/scene/modes/mandala.ts'), 'attachMandalaMode'>
  & Pick<typeof import('../src/scene/modes/mandala-motion.ts'), 'createMandalaMotion'>
  & Pick<typeof import('../src/scene/mandala-preview.ts'), 'mandalaPreviewFromPointer' | 'mandalaPreviewFromFocus' | 'mandalaSelectionFromTarget'>
  & Pick<typeof import('../src/scene/updates.ts'), 'createGraphController'>
  & Pick<typeof import('../src/views/camera-controls.ts'), 'attachCameraControls' | 'createCameraChangeHandler'>
  & Pick<typeof import('../src/state/chart-session.ts'), 'createChartSession'>
  & Pick<typeof import('../src/state/chart-exploration.ts'), 'createChartExploration'>
  & Pick<typeof import('../src/state/view-session.ts'), 'createViewSession'>
  & Pick<typeof import('../src/state/transit-planets.ts'), 'createTransitPlanetFilter'>
  & Pick<typeof import('../src/views/chart-display.ts'), 'chartCaption'>
  & Pick<typeof import('../src/ui/layout/chart-heading.ts'), 'createChartHeadingLayout'>
  & Pick<typeof import('../src/views/library.ts'), 'attachChartLibrary'>
  & Pick<typeof import('../src/views/all-charts.ts'), 'attachAllCharts'>
  & Pick<typeof import('../src/views/birth-form.ts'), 'attachBirthForm'>
  & Pick<typeof import('../src/views/live-transit.ts'), 'attachLiveTransit' | 'attachTransitNavigation'>
  & Pick<typeof import('../src/views/transit-controls.ts'), 'attachTransitControls'>
  & Pick<typeof import('../src/views/natal-day-controls.ts'), 'attachNatalDayExplorer'>
  & Pick<typeof import('../src/views/chart-summary-panel.ts'), 'attachChartSummary'>
  & Pick<typeof import('../src/ui/telegram-gestures.ts'), 'attachTelegramGestures'>
  & Pick<typeof import('../src/views/performance-monitor.ts'), 'attachPerformanceMonitor'>
  & Pick<typeof import('../src/views/chart-loading.ts'), 'attachChartLoading' | 'holdLoadingContent' | 'commitLoadingLayout'>
  & Pick<typeof import('../src/state/returns.ts'), 'createReturnsController'>
  & Pick<typeof import('../src/data/cycles-client.ts'), 'createCyclesClient'>
  & Pick<typeof import('../src/data/natal-day-client.ts'), 'createNatalDayClient'>
  & Pick<typeof import('../src/domain/personal-age.ts'), 'ageText' | 'completedAge'>
  & Pick<typeof import('../src/domain/cycles.ts'), 'eligibleCycleChart' | 'lifeTimelineForChart' | 'cycleTimeZone'>
  & Pick<typeof import('../src/views/returns-markers.ts'), 'attachReturnMarkers'>
  & Pick<typeof import('../src/domain/returns-window.ts'), 'returnsVisibleWindow'>
  & Pick<typeof import('../src/ui/studio-presentation.ts'), 'studioPresentation'>;
type PortOptions<K extends keyof AppPorts> = NonNullable<Parameters<AppPorts[K]>[0]>;
type StubPorts = { [K in keyof AppPorts]: (...args: Parameters<AppPorts[K]>) => unknown };
import { readModuleSource } from './helpers/module-source.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractChartData } from '../src/domain/chart-data.ts';
import { createPanelState } from '../src/state/panels.ts';
import { createWorkspaceState } from '../src/state/workspace.ts';
import { attachAllCharts } from '../src/views/all-charts.ts';
import { createChartSession } from '../src/state/chart-session.ts';
import { createChartExploration } from '../src/state/chart-exploration.ts';
import { createTransitPlanetFilter } from '../src/state/transit-planets.ts';
import { createReturnsController } from '../src/state/returns.ts';
import { createNatalDayExplorer, type NatalExplorerOptions } from '../src/state/natal-day.ts';
import { createLifetimeExplorer } from '../src/state/lifetime.ts';
import { eligibleCycleChart, lifeTimelineForChart, cycleTimeZone } from '../src/domain/cycles.ts';
import { attachChartLibrary, createChartLibraryView } from '../src/views/library.ts';
import { attachKnowledgeEntry } from '../src/views/knowledge-entry.ts';
import { attachChartSummary } from '../src/views/chart-summary-panel.ts';
import { chartCaption } from '../src/views/chart-display.ts';
import { ageText, completedAge } from '../src/domain/personal-age.ts';
import { returnsVisibleWindow } from '../src/domain/returns-window.ts';
import { libraryRecordAtMinute } from './fixtures/natal-day.ts';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.ts';
import { LIFETIME_PLANETS } from '../shared/lifetime-format.ts';
import { createStudioLayout } from './fixtures/studio-layout.ts';
import { createGraphController } from '../src/scene/updates.ts';
import { attachMandalaMode } from '../src/scene/modes/mandala.ts';
import { renderBodygraph } from '../src/scene/bodygraph-svg.ts';
import { createCamera } from '../src/scene/camera.ts';
import { MANDALA_FRAME, STUDIO_FRAME } from '../src/scene/geometry/frames.ts';
import { attachTransitNavigation } from '../src/views/live-transit.ts';
import { holdLoadingContent, commitLoadingLayout } from '../src/views/chart-loading.ts';
import { studioPresentation } from '../src/ui/studio-presentation.ts';

// Execute the whole composition root, preserving declaration and attachment
// order. Browser-heavy views use ports; library/knowledge and state owners are real.
const source = readModuleSource(new URL('../src/app.ts', import.meta.url));
const imports = [...source.matchAll(/^import \{ (.*?) \} from .*;$/gm)].flatMap(match => match[1].split(', '));
const body = source.replace(/^import .*;\n/gm, '').replace('export function startApp', 'function startApp');
const noop = () => {};
function browser() {
  const elements = new Map<string, BrowserElement>(), listeners = new Map<string, BrowserListener>(); let created = 0;
  const document: BrowserDocument = { body: { dataset: {} }, activeElement: null,
    createElement: tag => element(`${tag}-${++created}`),
    getElementById: (id: string) => ['returnsToggle', 'returnsControls'].includes(id) ? null : element(id), querySelector: (selector: string) => selector === '.app-shell' ? element('shell') : null, querySelectorAll: () => [],
    addEventListener(type, handler) { listeners.set(type, handler); },
    dispatch(type, event) { return listeners.get(type)?.(event); } };
  function element(id: string): BrowserElement {
    if (!elements.has(id)) {
      const classes = new Set<string>(), attributes = new Map<string, string>(), handlers = new Map<string, { handler: BrowserListener; capture: boolean }[]>(), children: BrowserElement[] = [];
      elements.set(id, { id, ownerDocument: document, dataset: {}, hidden: false, inert: false, innerHTML: '',
        style: { setProperty(name, value) { this[name] = value; } },
        children, get firstChild() { return children[0] ?? null; },
        get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] ?? null; },
        insertBefore(child, before) { child.remove(); children.splice(before ? children.indexOf(before) : children.length, 0, child); child.parentElement = this; },
        replaceChildren(...next) { for (const child of [...children] as const) child.remove(); for (const child of next) this.insertBefore(child, null); },
        remove() { const siblings = this.parentElement?.children; if (siblings) { const index = siblings.indexOf(this); if (index >= 0) siblings.splice(index, 1); } this.parentElement = null; },
        contains(node) { return node === this || id === 'library' && ['nowButton', 'openKnowledge'].includes(node?.id!); },
        focus() { document.activeElement = this; }, querySelector: selector => element(`${id}:${selector}`), querySelectorAll: () => [],
        getBoundingClientRect: () => ({ top: 0, bottom: 820, left: 0, right: 640, width: 640, height: 820 }),
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute: name => attributes.get(name) ?? null, removeAttribute: name => attributes.delete(name),
        classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name), contains: (name: string) => classes.has(name),
          toggle(name: string, enabled = !classes.has(name)) { if (enabled) classes.add(name); else classes.delete(name); } },
        addEventListener(type, handler, capture = false) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type)!.push({ handler, capture }); },
        async dispatch(type, event = {}) {
          let stopped = false;
          for (const { handler } of [...handlers.get(type) || []].sort((a, b) => Number(b.capture) - Number(a.capture))) {
            if (stopped) break;
            await handler({ target: this, ...event, stopImmediatePropagation() { stopped = true; } });
          }
        },
        click() { return this.dispatch('click'); },
        showModal() { this.open = true; }, close() { this.open = false; },
      });
    }
    return elements.get(id)!;
  }
  element('canvasWrap').parentElement = element('studio');
  return { document, element };
}

function harness({ realSummary = false, search = '', restore = async () => true, savedView = null, fonts, initialPresentation = null, studioSize = null, metaError = null, charts = [], loadKnowledge = null, chartsReady = null, returnEvents = [], getReturn = () => assert.fail('no return calculation expected'), getPoint = () => assert.fail('these navigation actions do not request lifetime points') }: HarnessOptions = {}) {
  const { document, element } = browser();
  if (fonts !== undefined) document.fonts = { ready: fonts };
  const dimensions = studioSize && { ...studioSize };
  const timelineKinds: TimelineKind[] = [];
  let resizeLayout: () => void, layout = { refresh: noop, setTimelineKind: (kind: TimelineKind) => timelineKinds.push(kind), setSidePanels: noop, sideInsets: { width: 640, left: 0, right: 0 } } as unknown as StudioLayout;
  if (dimensions) {
    const rect = () => ({ ...dimensions, top: 0, left: 0, bottom: dimensions.height, right: dimensions.width });
    const studio = element('studio'), canvas = element('canvasWrap');
    studio.getBoundingClientRect = canvas.getBoundingClientRect = rect; canvas.parentElement = studio;
    for (const id of ['lifetimeControls', 'natalDayControls'] as const) element(id).hidden = true;
    element('viewport').querySelector = () => null;
    layout = createStudioLayout({ canvas, studio,
      panels: ['transitControls', 'natalDayControls', 'lifetimeControls'].map(element),
      media: { matches: dimensions.width < 700 }, viewport: null,
      readStyle: () => ({ scrollPaddingTop: '112px', scrollPaddingBottom: '52px', scrollPaddingLeft: '4px',
        getPropertyValue: (name: string) => name === '--timeline-edge-space' ? '8px' : '0px' }) } as unknown as Parameters<typeof createStudioLayout>[0]);
  }
  const store = { charts, storageAvailable: true, get: (id: string) => charts.find(chart => chart.id === id), has: (id: string) => charts.some(chart => chart.id === id),
    remove(id: string) { charts = store.charts = charts.filter(chart => chart.id !== id); } };
  let graph!: PortOptions<'createGraphController'>;
  let gestures!: NonNullable<Parameters<AppPorts['attachGestures']>[1]>;
  let camera!: Camera;
  let natalDay!: ReturnType<typeof createNatalDayExplorer>, returns!: ReturnType<typeof createReturnsController>;
  let birthOptions!: PortOptions<'attachBirthForm'>, lifetime!: ReturnType<typeof createLifetimeExplorer>;
  let lifetimeOptions!: Parameters<typeof attachLifetimeControls>[0];
  let returnsViewOptions!: Parameters<typeof attachReturnsPanel>[0], returnsViewState: ReturnsPanelState | undefined;
  let transitNowRequests = 0, activationHoverClears = 0;
  const clearActivationHover = () => { activationHoverClears++; };
  let lifetimeStateOptions!: NonNullable<Parameters<typeof createLifetimeExplorer>[0]>;
  let transitOptions!: PortOptions<'attachLiveTransit'>;
  let finishModule!: (value: unknown) => void, failModule!: (error: unknown) => void;
  let loads = 0, stateLoads = 0, reloads = 0, renders = 0, dayRequests = 0, chartSelections = 0, interruptions = 0;
  let performanceOptions!: PortOptions<'attachPerformanceMonitor'>;
  let captionUpdates = 0, workspace!: ReturnType<typeof createWorkspaceState>, panels!: ReturnType<typeof createPanelState>;
  let knowledgeOptions!: PortOptions<'attachKnowledgeEntry'>, knowledgeLoads = 0, restoreInterrupted = false;
  const module = new Promise<unknown>((resolve, reject) => { finishModule = resolve; failModule = reject; });
  const memory = {}, natalClient = {};
  const ports: StubPorts = {
    createChartSession, createChartExploration, createTransitPlanetFilter, studioPresentation, holdLoadingContent, commitLoadingLayout,
    attachAllCharts: (options) => {
      const view = attachAllCharts({ ...options, preview: (_canvas, _chart, { onReady } = {}) => { onReady!(true); return noop; } });
      return chartsReady ? { ...view, whenReady: chartsReady } : view;
    },
    createNatalDayClient: (options) => { assert.equal(options!.memory, memory); return natalClient; },
    createReturnsController: (options) => returns = createReturnsController(options),
    eligibleCycleChart, lifeTimelineForChart, cycleTimeZone, returnsVisibleWindow, attachChartLibrary,
    attachKnowledgeEntry: (options) => {
      knowledgeOptions = options;
      return attachKnowledgeEntry({ ...options, load: async () => {
        knowledgeLoads++; if (loadKnowledge) await loadKnowledge();
        return { attachKnowledge: page => ({ show() { page.hidden = false; }, hide() { page.hidden = true; } }) };
      } });
    },
    attachActivationPopover: () => ({ close: noop, reposition: noop, refresh: noop }),
    attachActivationHover: () => ({ clear: clearActivationHover, dispose: noop }),
    attachHoverPreview: (_svg, options) => {
      assert.equal(options.onClear, clearActivationHover, 'preview dismissal also clears its decorative activation highlight');
      return { clear: () => options.onClear?.() };
    },
    attachGestures: (_svg, options) => {
      gestures = options;
      camera = options.camera!;
      camera.setOnChange(options.onChange!);
      return camera;
    },
    pointerTarget: noop,
    attachMandalaMode: (options) => dimensions ? attachMandalaMode(options) : ({ enabled: false }), createMandalaMotion: noop,
    mandalaPreviewFromPointer: noop, mandalaPreviewFromFocus: noop, mandalaSelectionFromTarget: noop,
    createGraphController: (options) => { graph = options;
      if (dimensions) return createGraphController({ ...options, scene: {
        update(chart, selection, settings) { renders++; element('viewport').innerHTML = renderBodygraph(chart, selection, settings); },
        clear() { element('viewport').innerHTML = ''; },
      } });
      return { choose: noop, changeChart: (id: string) => { chartSelections++; options.onChartChange!(id); },
      clear: noop, render: () => { renders++; }, preview: noop, selectionState: { primary: null } }; },
    attachCameraControls: noop, createCameraChangeHandler: () => noop,
    createViewSession: (options) => { assert.equal(options.cameraRestored, true); return {
      restore, get interrupted() { return restoreInterrupted; },
      interrupt() { restoreInterrupted = true; interruptions++; }, schedule: noop,
    }; },
    chartCaption: (...args) => { captionUpdates++; return chartCaption(...args); },
    createChartHeadingLayout: ({ title, subtitle }) => ({ updateText(a: string, b: string) { title.textContent = a; subtitle!.textContent = b; }, refresh: noop }),
    attachBirthForm: options => { birthOptions = options; return { opened: false }; },
    attachLiveTransit: (options) => {
      transitOptions = options;
      const current = dimensions ? store.get('current-transit') : null;
      return { state: { wanted: true, current, status: current ? 'ready' : 'idle' }, current, refresh: noop, setWanted: noop,
        goNow: async () => { transitNowRequests++; return true; } };
    },
    attachTransitNavigation,
    attachTransitControls: ({ panel }) => ({ update: noop, setCoveredByLifetime(value: boolean) { if (dimensions) panel.hidden = value; } }),
    attachNatalDayExplorer: (options: NatalExplorerOptions|undefined) => natalDay = createNatalDayExplorer({ ...options, dayClient: { getDay: async () => { dayRequests++; return natalDayFixture(); } } }),
    attachChartSummary: options => realSummary ? attachChartSummary(options) : ({ close: noop, setReturnsVisible: noop, update: noop, layout() { options.panel.hidden = !options.isAvailable!(); } }), attachTelegramGestures: noop, attachPerformanceMonitor: options => { performanceOptions = options; },
    attachChartLoading: () => ({ update: noop }), createCyclesClient: (options) => { assert.equal(options!.memory, memory); return { events: async (input: CycleInput) => ({ events: returnEvents.filter(event => event.body === input.body) }), chart: getReturn }; }, ageText, completedAge,
    attachReturnMarkers: () => ({ update: noop }),
  };
  for (const name of imports) assert.equal(typeof ports[name as keyof AppPorts], 'function', `provide the explicit browser port ${name}`);
  const startApp = new Function(...imports, 'document', 'ResizeObserver', 'location', 'window', 'getComputedStyle', 'loadLifetimeView', 'loadLifetimeState', 'loadReturnsViewModule',
    `${body.replace("import('./views/lifetime-controls.ts')", 'loadLifetimeView()')
      .replace("import('./state/lifetime.ts')", 'loadLifetimeState()')
      .replace("import('./views/returns-panel.ts')", 'loadReturnsViewModule()')}\nreturn startApp;`)(
    ...imports.map(name => ports[name as keyof AppPorts]), document, class { constructor(callback: () => void) { resizeLayout = callback; } observe() {} }, { search },
    { location: { reload() { reloads++; } } }, () => ({ getPropertyValue: () => '320px' }), () => { loads++; return module; }, async () => {
      stateLoads++;
      return { createLifetimeExplorer(options: NonNullable<Parameters<typeof createLifetimeExplorer>[0]>) {
        lifetimeStateOptions = options;
        lifetime = Object.freeze(createLifetimeExplorer({ ...options, client: {
          getMeta: async () => { if (metaError) throw metaError; return { startUtc: '1801-01-01T00:00:00Z', endExclusiveUtc: '2400-01-01T00:00:00Z',
            stepSeconds: 600, samples: 31_504_320, planets: [...LIFETIME_PLANETS] } as unknown as LifetimeMetadata; },
          getPoint,
        } as NonNullable<Parameters<typeof createLifetimeExplorer>[0]>['client'] }));
        return lifetime;
      } };
    }, async () => ({ attachReturnsPanel(options: Parameters<typeof attachReturnsPanel>[0]) {
      returnsViewOptions = options;
      return { sheet: () => options.getLayout?.() === 'sheet', update(state: ReturnsPanelState) { returnsViewState = state; } };
    } }));
  element('shell').dataset.booting = 'true';
  panels = createPanelState(); workspace = createWorkspaceState();
  panels.restore(savedView?.panels); workspace.restore(savedView?.workspace);
  // Startup hands app.ts a layout that already knows both panel measurements.
  if (realSummary && dimensions) layout.setSidePanels(() => ({ ...panels.snapshot, leftWidth: 320, rightWidth: 320 }));
  camera = createCamera({ getFrame: () => MANDALA_FRAME, getHomeFrame: () => dimensions ? layout.frame() : STUDIO_FRAME,
    measureFit: () => ({ area: { x: 0, y: 0, width: 640, height: 820 },
      viewport: { x: 0, y: 0, width: 640, height: 820 }, min: .1 }), onChange: noop });
  camera.reset();
  const cameraView = { surface: element('canvasWrap'), paint: noop };
  const libraryView = createChartLibraryView({ chartList: element('chartList'), libraryCount: element('libraryCount'), nowButton: element('nowButton'), document } as unknown as Parameters<typeof createChartLibraryView>[0]);
  startApp({ dayClient: { memory }, layout, toast: noop, viewStore: { write: noop }, savedView, panels, workspace, store, libraryView, camera, cameraView, initialPresentation });
  return { element, layout, natalClient, camera, workspace, panels, timelineKinds, performanceOptions,
    get knowledgeLoads() { return knowledgeLoads; }, showKnowledgeSelection: (selection: Parameters<NonNullable<typeof knowledgeOptions.onSelect>>[0]) => knowledgeOptions.onSelect!(selection), resize(width: number, height: number) { Object.assign(dimensions!, { width, height }); resizeLayout(); }, select(id: string) {
      const button = { dataset: { chartId: id } };
      document.dispatch('click', { target: { closest: (selector: string) => selector === '[data-chart-id]' ? button : null } });
    }, get shown() { return graph.getChart() as ChartComposition; }, get renders() { return renders; }, get lifetime() { return lifetime; }, get loads() { return loads; }, get stateLoads() { return stateLoads; },
    get interruptions() { return interruptions; }, get captionUpdates() { return captionUpdates; },
    filter: (id: string) => gestures.onSelect!({ type: 'planet-filter' as const, id }),
    failModule, get reloads() { return reloads; }, get natalDay() { return natalDay; },
    get lifetimeOptions() { return lifetimeOptions; },
    get returnsViewOptions() { return returnsViewOptions; }, get returnsViewState() { return returnsViewState; },
    get transitNowRequests() { return transitNowRequests; },
    get activationHoverClears() { return activationHoverClears; },
    get lifetimeStateOptions() { return lifetimeStateOptions; },
    get returns() { return returns; }, get dayRequests() { return dayRequests; }, get chartSelections() { return chartSelections; },
    clockTick() { transitOptions.onStateChange!({ wanted: false } as Parameters<NonNullable<typeof transitOptions.onStateChange>>[0]); },
    edit() { birthOptions.beforeOpen!(); },
    saveChart(chart: TestChart, options?: Parameters<NonNullable<typeof birthOptions.onSave>>[1]) {
      charts = store.charts = [...charts.filter(previous => previous.id !== chart.id), chart];
      birthOptions.onSave(chart.id, options);
    },
    removeChart(id: string) {
      const action = { dataset: { chartAction: 'delete', actionChartId: id }, closest: (selector: string) => selector === 'details' ? {} : null };
      document.dispatch('click', { target: { closest: (selector: string) => selector === '[data-chart-action]' ? action : null } });
      return element('confirmDeleteChart').click();
    },
    saveMetadata(chart: TestChart) { charts = store.charts = charts.map(previous => previous.id === chart.id ? chart : previous); birthOptions.onSave(chart.id, { metadataOnly: true }); },
    finishModule() { finishModule({ attachLifetimeControls(options: Parameters<typeof attachLifetimeControls>[0]) {
      lifetimeOptions = options;
      const update = (state: ReturnType<typeof createLifetimeExplorer>['state']) => { options.panel.hidden = !state.opened; };
      update(options.explorer.state);
      return { update, refreshMoment: noop, setVisibleWindow: noop, refreshTargets: noop };
    } }); },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('opening the birth form clears the activation highlight through preview dismissal', async () => {
  const h = harness(); await tick();
  const before = h.activationHoverClears;
  h.edit();
  assert.equal(h.activationHoverClears, before + 1);
});

test('lazy Lifetime uses a separate controls view and leaves the real controller independent of DOM methods', async () => {
  const h = harness();
  await tick();
  assert.equal(h.loads, 0); assert.equal(h.stateLoads, 0);
  assert.equal<unknown>(h.lifetime, undefined);
  await h.element('lifetimeToggle').click();
  h.finishModule(); await tick();
  assert.equal(h.loads, 1); assert.equal(h.stateLoads, 1);
  assert.equal(h.lifetimeOptions.explorer, h.lifetime);
  for (const method of ['update', 'refreshMoment', 'setVisibleWindow', 'refreshTargets', 'setAvailable', 'syncTransit'] as const)
    assert.equal(method in h.lifetime!, false, `state cannot acquire the ${method} view method`);
  assert.equal(h.lifetime!.state.opened, true);
  assert.equal(h.element('lifetimeControls').hidden, false);
  await h.element('lifetimeToggle').click();
  assert.equal(h.lifetime!.state.opened, false);
  assert.equal(h.element('lifetimeControls').hidden, true);
  await h.element('lifetimeToggle').click();
  assert.equal(h.lifetime!.state.opened, true);
  assert.equal(h.loads, 1); assert.equal(h.stateLoads, 1);
});

test('explicit library and Transit navigation return a zoomed and panned camera Home before async work completes', async () => {
  const first = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const second = { ...first, id: 'second' };
  const h = harness({ charts: [first, second] });
  await tick();
  for (const id of [first.id, second.id, first.id, first.id] as const) {
    h.camera.zoom(2); h.camera.pan(-40, 25);
    assert.notDeepEqual(h.camera.getView(), h.camera.getFittedView());
    h.select(id);
    assert.equal(h.shown.id, id);
    assert.deepEqual(h.camera.getView(), h.camera.getFittedView(), 'navigation resets synchronously, including reselection');
    h.camera.zoom(1.5); h.camera.pan(-30, 20);
    const exploring = h.camera.getView();
    await tick();
    assert.deepEqual(h.camera.getView(), exploring, 'late natal-day completion must not reset a new camera gesture');
  }
  for (let click = 0; click < 2; click++) {
    h.camera.zoom(2); h.camera.pan(-40, 25);
    await h.element('nowButton').click();
    assert.equal(h.shown.id, 'current-transit');
    assert.deepEqual(h.camera.getView(), h.camera.getFittedView(), 'entering or reselecting Transit uses Home');
  }
});

test('saving the current chart preserves the camera while opening a different saved chart uses Home', async t => {
  const first = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const other = { ...first, id: 'other' };
  const manual = { id: 'manual', name: 'Manual chart', source: 'manual' as const, personality: [1, 41], design: [8, 31] };
  for (const { name, selected, saved, options, home } of [
    { name: 'create a calculated chart', selected: first.id, saved: { ...first, id: 'new' }, home: true },
    { name: 'create a manual chart', selected: first.id, saved: { ...manual, id: 'new-manual' }, home: true },
    { name: 'recalculate the selected chart', selected: first.id, saved: libraryRecordAtMinute(natalDayFixture(), 755, first), home: false },
    { name: 'save the selected chart metadata', selected: first.id, saved: { ...first, name: 'Renamed chart' }, options: { metadataOnly: true }, home: false },
    { name: 'save the selected manual chart', selected: manual.id, saved: { ...manual, personality: [2, 41] }, home: false },
    { name: 'change the selected chart to manual', selected: first.id, saved: { ...manual, id: first.id }, home: false },
    { name: 'recalculate another chart', selected: first.id, saved: libraryRecordAtMinute(natalDayFixture(), 755, other), home: true },
    { name: 'save another chart metadata', selected: first.id, saved: { ...other, name: 'Renamed chart' }, options: { metadataOnly: true }, home: true },
  ] as const) await t.test(name, async () => {
    const h = harness({ charts: [first, other, manual] });
    await tick(); h.select(selected); await tick();
    h.camera.zoom(2); h.camera.pan(-40, 25);
    const exploring = h.camera.getView();
    assert.notDeepEqual(exploring, h.camera.getFittedView());
    h.saveChart(saved, options);
    assert.deepEqual(h.shown.primary, extractChartData(saved), 'the saved numbers must replace the old data even when the record ID is unchanged');
    assert.equal(h.shown.primaryLabel, saved.name);
    assert.deepEqual(h.camera.getView(), home ? h.camera.getFittedView() : exploring,
      home ? 'opening another saved chart resets immediately' : 'updating the current chart preserves the camera');
    h.camera.zoom(1.2); h.camera.pan(-10, 15);
    const afterSave = h.camera.getView();
    await tick();
    assert.deepEqual(h.camera.getView(), afterSave, 'late preparation must not reset a gesture made after saving');
  });
});

test('deleting the selected chart uses Home for the automatically opened fallback', async t => {
  const selected = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const remaining = { ...selected, id: 'remaining' };
  for (const { name, charts, fallback } of [
    { name: 'another saved chart remains', charts: [selected, remaining], fallback: 'remaining' },
    { name: 'the last saved chart returns to Transit', charts: [selected], fallback: 'current-transit' },
  ] as const) await t.test(name, async () => {
    const h = harness({ charts });
    await tick(); h.select(selected.id); await tick();
    h.camera.zoom(2); h.camera.pan(-40, 25);
    assert.notDeepEqual(h.camera.getView(), h.camera.getFittedView());
    await h.removeChart(selected.id);
    assert.equal(h.element('deleteChartError').textContent!, '');
    assert.equal(h.element('deleteChartDialog').open, false);
    assert.equal(h.shown.id, fallback);
    assert.deepEqual(h.camera.getView(), h.camera.getFittedView(), 'opening the fallback resets the camera');
    h.camera.zoom(1.2); h.camera.pan(-10, 15);
    const afterRemoval = h.camera.getView();
    await tick();
    assert.deepEqual(h.camera.getView(), afterRemoval, 'late fallback preparation must not reset a new gesture');
  });
});

test('deleting an unselected chart keeps the current chart and camera', async () => {
  const selected = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const other = { ...selected, id: 'other' };
  const h = harness({ charts: [selected, other] });
  await tick(); h.select(selected.id); await tick();
  h.camera.zoom(2); h.camera.pan(-40, 25);
  const exploring = h.camera.getView(), shown = h.shown;
  await h.removeChart(other.id); await tick();
  assert.equal(h.element('deleteChartError').textContent!, '');
  assert.equal(h.shown, shown);
  assert.deepEqual(h.camera.getView(), exploring);
});

test('clock updates, day and lifetime scrubs, and exact returns preserve the explored camera', async () => {
  const chart = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const event = { id: 'saturn:2050-01-01T12:00:29.432Z', body: 'saturn', utc: '2050-01-01T12:00:29.432Z', cycle: 1 };
  const exact = { ...chart, id: 'exact-return', utc: event.utc };
  const h = harness({ charts: [chart], returnEvents: [event], getReturn: async () => ({ event, chart: exact }),
    getPoint: async (index: number) => {
      const utc = new Date(Date.parse('1801-01-01T00:00:00Z') + index * 600000).toISOString();
      return { index, utc, longitudes: Array.from({ length: 11 }, (_, i) => i * 23),
        design: { utc, designUtc: '2049-10-01T00:00:00Z', designArcResidualDegrees: 0,
          longitudes: Array.from({ length: 11 }, (_, i) => i * 23 + 10) } };
    } });
  await tick(); h.select(chart.id); await tick();
  h.camera.zoom(2); h.camera.pan(-40, 25);
  const exploring = h.camera.getView();
  h.clockTick();
  assert.deepEqual(h.camera.getView(), exploring);
  h.natalDay.scrub(800);
  assert.equal(h.shown.utc, '2026-09-24T13:20:00Z');
  assert.deepEqual(h.camera.getView(), exploring);
  await h.element('lifetimeToggle').click(); h.finishModule(); await tick();
  assert.deepEqual(h.camera.getView(), exploring, 'opening the current chart timeline preserves the camera');
  const target = Date.parse('2050-01-01T12:00:00Z');
  h.lifetimeOptions.beforeScrub!(target); await h.lifetime.scrub(target);
  assert.equal<unknown>(h.shown.kind, 'transit');
  assert.deepEqual(h.camera.getView(), exploring);
  await h.returns.selectEvent(event.id);
  assert.equal<unknown>(h.shown.kind, 'return'); assert.equal(h.shown.secondary, h.returns.current);
  assert.deepEqual(h.camera.getView(), exploring);
});

test('the natal caption keeps todays age across day, life and closed rails while events keep their moment', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2028-09-23T23:59:59Z') });
  const chart = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const h = harness({ charts: [chart] });
  await h.select(chart.id);
  assert.match(h.element('chartSubtitle').textContent!, /12:34.*1\u00a0год$/);
  t.mock.timers.setTime(Date.parse('2028-09-24T00:00:00Z'));
  const requests = h.dayRequests, renders = h.renders;
  h.clockTick();
  assert.match(h.element('chartSubtitle').textContent!, /12:34.*2\u00a0года$/);
  assert.equal(h.dayRequests, requests); assert.equal(h.renders, renders);
  h.natalDay.scrub(755);
  assert.match(h.element('chartSubtitle').textContent!, /12:35.*2\u00a0года$/);
  const opening = h.element('lifetimeToggle').click(); h.finishModule(); await opening; await tick();
  assert.match(h.element('chartSubtitle').textContent!, /12:34.*2\u00a0года$/);
  t.mock.timers.setTime(Date.parse('2029-09-24T00:00:00Z'));
  const lifeRequests = h.dayRequests, lifeRenders = h.renders;
  h.clockTick();
  assert.match(h.element('chartSubtitle').textContent!, /12:34.*3\u00a0года$/);
  assert.equal(h.dayRequests, lifeRequests); assert.equal(h.renders, lifeRenders);
  await h.element('lifetimeToggle').click();
  assert.equal(h.lifetime.state.opened, false); assert.equal(h.natalDay.state.opened, false);
  assert.match(h.element('chartSubtitle').textContent!, /12:34.*3\u00a0года$/);
  await h.select('current-transit');
  assert.doesNotMatch(h.element('chartSubtitle').textContent!, /лет|год/);
});

test('raw range editing supersedes restoration and a cold opening before the date is valid', async () => {
  const h = harness({}); await tick();
  await h.element('lifetimeToggle').click();
  assert.equal(h.interruptions, 1); assert.equal(h.loads, 1);
  const field = h.element('lifetimeFromDate'); field.value = '1';
  await field.dispatch('input');
  assert.equal(h.interruptions, 2, 'unfinished date input already supersedes the saved range');
  h.finishModule(); await tick();
  assert.equal(h.lifetime.state.opened, false, 'arrival cannot reopen the range that typing superseded');
  assert.equal(field.value, '1');
  await h.select('current-transit');
  assert.equal(h.interruptions, 3, 'an explicit chart command reaches the same restoration owner');
});

test('lifetime planet gestures publish the owner projection once and retain both full columns', async () => {
  let requests = 0;
  const h = harness({ getPoint: async (index: number) => {
    requests++;
    const utc = new Date(Date.parse('1801-01-01T00:00:00Z') + index * 600000).toISOString();
    return { index, utc, longitudes: Array.from({ length: 11 }, (_, i) => i * 23),
      design: { utc, designUtc: '1899-10-01T00:00:00Z', designArcResidualDegrees: 0,
        longitudes: Array.from({ length: 11 }, (_, i) => i * 23 + 10) } };
  } });
  await tick(); await h.element('lifetimeToggle').click(); h.finishModule(); await tick();
  await h.lifetime.restore({ opened: true, mode: 'lifetime' as const, fromDate: '1900-01-01', toDate: '1900-01-03',
    requestedUtc: Date.parse('1900-01-02T12:00:00Z') });
  const full = h.shown.primary, calls = requests, before = h.renders;
  assert.equal(full, h.lifetime.current);
  for (const [index, id] of ['moon', 'design:all', 'all', 'all', 'moon'].entries()) {
    h.filter(id);
    assert.equal(h.shown.primary, h.lifetime.current, 'the scene and rail reuse one accepted projection');
    assert.equal(h.renders, before + index + 1, 'each gesture publishes once');
    assert.equal(h.shown.primary.utc, full.utc);
    assert.equal(requests, calls, 'a filter change needs no data request');
  }
  assert.deepEqual(h.shown.primary.activations!.personality, full.activations!.personality.filter((e: { planet: string; }) => e.planet === 'moon'));
  assert.deepEqual(h.shown.primary.activations!.design, full.planetFilter!.designActivations);
});

test('the lazy knowledge entry replaces the center while retaining the persistent navigation', async () => {
  const { element } = harness();
  await element('openLibrary').click();
  assert.equal(element('library').inert, false);
  await element('openKnowledge').click(); await tick();
  assert.equal(element('library').inert, false, 'the persistent navigation stays available beside the reference');
  assert.equal(element('knowledgeDialog').hidden, false, 'the reference page opens after successful application composition');
  assert.equal(element('studio').dataset.workspaceScreen, 'library');
});

test('two real toolbar clicks cancel cold Lifetime without reopening it after module arrival', async () => {
  const h = harness({});
  await tick();
  await h.element('lifetimeToggle').click();
  assert.equal(h.element('lifetimeToggle').getAttribute('aria-pressed'), 'true');
  assert.equal(h.element('lifetimeToggle').title, 'Летопись');
  await h.element('lifetimeToggle').click();
  h.finishModule(); await tick();
  assert.equal(h.loads, 1);
  assert.equal(h.lifetime.state.opened, false);
  assert.equal(h.element('lifetimeToggle').getAttribute('aria-pressed'), 'false');
  await h.element('lifetimeToggle').click(); await tick();
  assert.equal(h.lifetime.state.opened, true, 'the loaded controller is available for a later intentional click');
  assert.equal(h.element('lifetimeToggle').title, 'Летопись');
  await h.element('lifetimeToggle').click();
  assert.equal(h.lifetime.state.opened, false);
});

test('a pending toolbar click cannot switch a newly selected personal card from Day to Returns', async () => {
  const chart = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const h = harness({ charts: [chart] });
  await tick();
  await h.element('lifetimeToggle').click();
  h.select(chart.id);
  h.finishModule(); await tick();
  assert.equal(h.lifetime.state.opened, false);
  assert.equal(h.natalDay.state.opened, true);
  assert.equal(h.element('lifetimeToggle').getAttribute('aria-pressed'), 'false');
});

test('failed Lifetime import keeps the reload action visible after its opening intent settles', async () => {
  const h = harness({});
  await tick(); await h.element('lifetimeToggle').click();
  h.failModule!(new Error('offline')); await tick();
  assert.equal(h.element('lifetimeToggle').title, 'Обновить страницу и загрузить летопись');
  assert.equal(h.element('lifetimeToggle').getAttribute('aria-label'), 'Обновить страницу и загрузить летопись');
  assert.equal(h.element('lifetimeToggle').getAttribute('aria-pressed'), 'false');
  await h.element('lifetimeToggle').click();
  assert.equal(h.reloads, 1);
});

test('the personal rail endpoint uses the shared completed-age wording at a truncated lifetime boundary', async () => {
  const chart = libraryRecordAtMinute(natalDayFixture({ date: '2378-01-01' }), 0,
    personalChartFixture({ birthDate: '2378-01-01', utc: '2378-01-01T00:00:00Z' }));
  const h = harness({ charts: [chart] });
  await tick(); await h.element('lifetimeToggle').click();
  h.select(chart.id); await h.element('natalDayToggle').click();
  assert.equal(h.natalDay.state.opened, false, 'the app owns the Day toggle after its view binding is removed');
  h.finishModule(); await tick();
  assert.deepEqual(h.lifetimeOptions.formatEndpoints!({ toDate: '2399-12-31' } as Parameters<NonNullable<typeof h.lifetimeOptions.formatEndpoints>>[0]), ['Рождение', '21 год']);
});


test('a real day publication reaches the scene once without repeating navigation or changing the accepted source during reads', async () => {
  const chart = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const h = harness({ charts: [chart] });
  await tick(); h.select(chart.id); await tick();
  const count = h.renders;
  h.natalDay.scrub(800);
  assert.equal(h.renders, count + 1);
  assert.equal(h.shown.primary.utc, '2026-09-24T13:20:00Z');
  assert.equal(h.natalDay.state.opened, true);
  assert.equal(h.natalDay.state.exactOriginal, false);
  const shown = h.shown;
  for (let index = 0; index < 30; index++) assert.equal(h.shown, shown);
  assert.equal(h.renders, count + 1);
});

test('entering personal Lifetime closes the Day controller only once', async () => {
  const chart = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const h = harness({ charts: [chart] });
  await tick(); h.select(chart.id); await tick();
  let closes = 0;
  const close = h.natalDay.close;
  h.natalDay.close = () => { closes++; close(); };
  await h.element('lifetimeToggle').click();
  h.finishModule(); await tick();
  assert.equal(h.lifetime.state.opened, true);
  assert.equal(h.lifetime.state.mode, 'lifetime');
  assert.equal(h.natalDay.state.opened, false);
  assert.deepEqual(h.shown.primary, extractChartData(chart));
  assert.equal(closes, 1, 'the command closes Day; a loading notification must not repeat that command');
});

test('metadata editing retains a personal minute and updates future scrubs without another Day request or chart selection', async () => {
  const chart = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const h = harness({ charts: [chart] });
  await tick(); h.select(chart.id); await tick(); h.natalDay.scrub(800);
  const selectedUtc = h.shown.utc, requests = h.dayRequests, selections = h.chartSelections;
  h.edit();
  assert.equal(h.natalDay.state.opened, true);
  assert.equal(h.shown.utc, selectedUtc);
  const updated = { ...chart, name: 'Обновлённое имя', note: 'Новая заметка' };
  h.saveMetadata(updated); await tick();
  assert.equal(h.shown.utc, selectedUtc); assert.equal(h.shown.primaryLabel, updated.name);
  assert.equal(h.natalDay.state.original!.note, updated.note); assert.equal(h.natalDay.state.index, 800);
  assert.equal(h.natalDay.state.exactOriginal, false);
  assert.equal(h.dayRequests, requests); assert.equal(h.chartSelections, selections, 'metadata never enters graph navigation, which clears selection/camera context');
  h.natalDay.scrub(810);
  assert.equal(h.shown.primaryLabel, updated.name); assert.equal(h.natalDay.state.original!.note, updated.note);
  h.natalDay.reset(); assert.deepEqual(h.shown.primary, extractChartData(updated));
});

test('renaming keeps the confirmed exact return and list filters while updating its natal source', async () => {
  const chart = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const event = { id: 'saturn:2050-01-01T12:00:29.432Z', body: 'saturn', utc: '2050-01-01T12:00:29.432Z', cycle: 1 };
  const exact = { ...chart, id: 'exact-return', utc: event.utc };
  let returnRequests = 0;
  const h = harness({ charts: [chart], returnEvents: [event], getReturn: async () => { returnRequests++; return { event, chart: exact }; } });
  await tick(); h.select(chart.id); await tick();
  await h.element('lifetimeToggle').click(); h.finishModule(); await tick();
  await h.returns.selectEvent(event.id);
  await h.returns.setBodies(['venus']);
  const requests = h.dayRequests, selections = h.chartSelections;
  const updated = { ...chart, name: 'Новое имя', note: 'Новая заметка' };
  h.edit(); h.saveMetadata(updated); await tick();
  assert.equal<unknown>(h.shown.kind, 'return'); assert.equal(h.shown.utc, '2050-01-01T12:00:29.432Z');
  assert.match(h.element('chartTitle').textContent!, /^Новое имя · Возврат Сатурна/);
  assert.equal(h.element('chartSubtitle').textContent!, '1 января 2050 г. · 12:00:29 · UTC · 23\u00a0года');
  assert.deepEqual(h.shown.primary, extractChartData(updated)); assert.equal(h.shown.secondary, h.returns.current); assert.equal(h.shown.event, event);
  assert.equal(h.returns.state.selectedEvent, event); assert.deepEqual(h.returns.current, extractChartData(exact));
  assert.equal(h.returns.state.natal, updated); assert.deepEqual(h.returns.state.bodies, ['venus']);
  assert.equal(h.lifetime.state.requestedUtc, Date.parse(event.utc));
  assert.equal(h.dayRequests, requests); assert.equal(returnRequests, 1); assert.equal(h.chartSelections, selections);
});

test('opening the editor still cancels a pending return and its late answer cannot overwrite renamed birth', async () => {
  const chart = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const event = { id: 'saturn:2050-01-01T12:00:29.432Z', body: 'saturn', utc: '2050-01-01T12:00:29.432Z', cycle: 1 };
  let complete, signal;
  const h = harness({ charts: [chart], returnEvents: [event], getReturn: (_query, requestSignal) => {
    signal = requestSignal; return new Promise(resolve => { complete = resolve; });
  } });
  await tick(); h.select(chart.id); await tick();
  await h.element('lifetimeToggle').click(); h.finishModule(); await tick();
  const previousCaption = h.element('chartSubtitle').textContent;
  const pending = h.returns.selectEvent(event.id); await tick();
  assert.equal(h.element('chartSubtitle').textContent!, previousCaption, 'a pending event is not presented as the displayed chart');
  h.edit();
  assert.equal(signal!.aborted, true);
  const updated = { ...chart, name: 'Новое имя', note: 'Новая заметка' }; h.saveMetadata(updated);
  complete!({ event, chart: { ...chart, utc: event.utc } }); assert.equal(await pending, false);
  assert.deepEqual(h.shown.primary, extractChartData(updated)); assert.equal(h.shown.secondary, null);
  assert.equal(h.element('chartTitle').textContent!, 'Новое имя');
  assert.equal(h.element('chartSubtitle').textContent!, previousCaption, 'late return metadata cannot replace the accepted birth caption');
  assert.equal(h.returns.state.loadingChart, false); assert.equal(h.returns.state.selectedEvent, null);
});


test('pending personal life data retains todays natal age until the new moment is actually shown', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2028-10-08T12:00:00Z') });
  const chart = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  let resolve;
  const response = new Promise(done => { resolve = done; });
  const h = harness({ charts: [chart], getPoint: async (index: number) => {
    await response;
    const utc = new Date(Date.parse('1801-01-01T00:00:00Z') + index * 600000).toISOString();
    return { index, utc, longitudes: Array.from({ length: 11 }, (_, i) => i * 23),
      design: { utc, designUtc: '2049-10-01T00:00:00Z', designArcResidualDegrees: 0,
        longitudes: Array.from({ length: 11 }, (_, i) => i * 23 + 10) } };
  } });
  await h.select(chart.id);
  const opening = h.element('lifetimeToggle').click(); h.finishModule(); await opening; await tick();
  const target = Date.parse('2050-01-01T12:00:00Z');
  const beforeLoading = h.captionUpdates;
  h.lifetimeOptions.beforeScrub!(target);
  const pending = h.lifetime.scrub(target);
  await tick();
  assert.equal(h.lifetime.state.status, 'loading', 'pending work still updates the timeline tools');
  assert.equal(h.captionUpdates, beforeLoading, 'loading tools must not reformat the unchanged displayed chart');
  h.clockTick();
  assert.equal<unknown>(h.shown.kind, 'single');
  assert.match(h.element('chartSubtitle').textContent!, /12:34.*2\u00a0года$/);
  const beforeAccepted = h.captionUpdates;
  resolve!(); await pending;
  assert.equal<unknown>(h.shown.kind, 'transit');
  assert.match(h.element('chartSubtitle').textContent!, /2050.*23\u00a0года$/);
  assert.equal(h.captionUpdates, beforeAccepted + 1, 'each accepted chart formats its caption once');
  h.clockTick();
  assert.match(h.element('chartSubtitle').textContent!, /2050.*23\u00a0года$/);
});

test('year endpoint captions also use UTC when a saved timezone is obsolete', async () => {
  const chart = { ...libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture()), timezone: 'Obsolete/Zone' };
  const h = harness({ charts: [chart] });
  await tick(); await h.element('lifetimeToggle').click();
  h.select(chart.id); await h.element('natalDayToggle').click();
  h.finishModule(); await tick(); await h.returns.setYear(2027);
  const bounds = { minUtc: Date.parse('2026-01-01T00:00:00Z'), maxUtc: Date.parse('2028-01-01T00:00:00Z') };
  const labels = h.lifetimeOptions.formatEndpoints!(bounds as Parameters<NonNullable<typeof h.lifetimeOptions.formatEndpoints>>[0])!;
  assert.match(labels[0], /янв.*2027/); assert.match(labels[1], /дек.*2027/);
});


test('timeline entry stays available without a server HTML availability flag', async () => {
  const h = harness(); await tick();
  assert.equal(h.element('lifetimeToggle').hidden, false);
  await h.element('lifetimeToggle').click();
  assert.equal(h.loads, 1);
  h.finishModule(); await tick();
  assert.equal(h.lifetime.state.opened, true);
});


test('opening a personal timeline before its file is ready retains a restorable life range and the natal chart', async () => {
  const chart = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const h = harness({ charts: [chart], metaError: Object.assign(new Error('Создаём летопись'), { code: 'lifetime_preparing' }) });
  await h.select(chart.id);
  await h.element('lifetimeToggle').click(); h.finishModule(); await tick();
  assert.equal(h.lifetime.state.status, 'preparing');
  assert.equal(h.lifetime.state.mode, 'lifetime');
  assert.equal(h.lifetime.state.fromDate, '2026-09-24');
  assert.equal(h.lifetime.state.toDate, '2126-09-24');
  assert.deepEqual(h.shown.primary, extractChartData(chart));
  assert.equal(h.natalDay.state.opened, false);
});


test('opening chronicle preserves scene presentation while a real resize can change mandala columns', async () => {
  const transit = { ...libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture()), id: 'current-transit', source: 'transit' as const };
  const h = harness({ charts: [transit], studioSize: { width: 550, height: 590 } });
  await tick(); await h.element('mandalaSwitch').click();
  const shown = h.shown, insets = { ...h.layout.insets() };
  assert.equal(h.layout.showMandalaColumns, false);
  assert.doesNotMatch(h.element('viewport').innerHTML, /class="activation-columns"/);
  await h.element('lifetimeToggle').click(); h.finishModule(); await tick();
  assert.equal(h.lifetime.state.mode, 'day');
  assert.equal(h.shown.utc, shown.utc, 'opening preserves the accepted transit moment');
  assert.deepEqual(h.layout.insets(), insets, 'the taller dock must not shrink or recenter the scene');
  assert.equal(h.layout.showMandalaColumns, false);
  assert.doesNotMatch(h.element('viewport').innerHTML, /class="activation-columns"/);
  const rendered = h.renders;
  h.clockTick(); h.resize(550, 590);
  assert.equal(h.renders, rendered, 'unchanged presentation needs no extra drawing');
  h.resize(550, 530);
  assert.equal(h.renders, rendered + 1, 'a real presentation change draws once');
  assert.equal(h.layout.showMandalaColumns, true);
  assert.match(h.element('viewport').innerHTML, /class="activation-columns"/, 'shorter window can make room beside the mandala');
  h.resize(550, 590);
  assert.doesNotMatch(h.element('viewport').innerHTML, /class="activation-columns"/);
  await h.element('lifetimeToggle').click();
  assert.deepEqual(h.layout.insets(), insets);
  assert.equal(h.layout.showMandalaColumns, false);
});


test('the personal timeline and natal-day tool share one prepared-day client', async () => {
  const chart = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const h = harness({ charts: [chart] }); h.select(chart.id); await tick();
  await h.element('lifetimeToggle').click(); h.finishModule(); await tick();
  assert.equal(h.lifetimeStateOptions.natalDayClient, h.natalClient);
  assert.equal(h.lifetimeStateOptions.getPersonalRecord!(), chart);
});


test('workspace pages preserve the chart moment and camera while keeping one current navigation item', async () => {
  const chart = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const h = harness({ charts: [chart] });
  await tick(); h.select(chart.id); await tick(); h.natalDay.scrub(800);
  h.camera.zoom(2); h.camera.pan(-40, 25); h.panels.setRight(true);
  const shown = h.shown, camera = h.camera.getView(), interrupted = h.interruptions;
  const pages = [['openKnowledge', 'library', 'knowledgeDialog'], ['openAllCharts', 'charts', 'allChartsDialog'], ['openAccount', 'account', 'accountPage']];
  for (const [button, screen, page] of pages) {
    await h.element(button).click(); await tick();
    assert.equal(h.workspace.screen, screen); assert.equal(h.element('studio').dataset.workspaceScreen, screen);
    for (const [otherButton, otherScreen, otherPage] of pages) {
      assert.equal(h.element(otherPage).hidden, otherPage !== page);
      assert.equal(h.element(otherButton).getAttribute('aria-current'), otherScreen === screen ? 'page' : null);
    }
    assert.equal(h.element('chartSummary').hidden, true);
    assert.equal(h.panels.right, true, 'hiding the chart does not discard its open panel');
    assert.equal(h.shown, shown); assert.equal(h.shown.utc, '2026-09-24T13:20:00Z');
    assert.deepEqual(h.camera.getView(), camera);
    assert.equal(h.interruptions, interrupted, 'changing an auxiliary page must not cancel a pending chart restoration');
  }
  await h.element('openKnowledge').click();
  h.showKnowledgeSelection({ type: 'gate' as const, id: 37 });
  assert.equal(h.workspace.screen, 'chart'); assert.equal(h.element('chartSummary').hidden, false);
  for (const [button, , page] of pages) {
    assert.equal(h.element(page).hidden, true); assert.equal(h.element(button).getAttribute('aria-current'), null);
  }
  assert.equal(h.shown, shown); assert.deepEqual(h.camera.getView(), camera); assert.equal(h.interruptions, interrupted);
});

test('selecting a saved chart or Transit returns from a workspace page to the chart at Home', async () => {
  const chart = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const h = harness({ charts: [chart] }); await tick();
  await h.element('openAllCharts').click();
  h.camera.zoom(2); h.select(chart.id);
  assert.equal(h.workspace.screen, 'chart'); assert.equal(h.shown.id, chart.id);
  assert.equal(h.element('allChartsDialog').hidden, true);
  assert.deepEqual(h.camera.getView(), h.camera.getFittedView());
  await tick(); await h.element('openAccount').click(); h.camera.zoom(2);
  await h.element('nowButton').click();
  assert.equal(h.workspace.screen, 'chart'); assert.equal(h.shown.id, 'current-transit');
  assert.equal(h.element('accountPage').hidden, true);
  assert.deepEqual(h.camera.getView(), h.camera.getFittedView());
});

for (const [button, screen] of [['openAccount', 'account'], ['openAllCharts', 'charts'], ['nowButton', 'chart']] as const) {
  test(`late knowledge loading cannot replace the newer ${screen} screen`, async () => {
    let release;
    const h = harness({ loadKnowledge: () => new Promise(done => { release = done; }) }); await tick();
    const opening = h.element('openKnowledge').click(); await tick();
    assert.equal(h.workspace.screen, 'library'); assert.equal(h.knowledgeLoads, 1);
    await h.element(button).click(); release!(); await opening; await tick();
    assert.equal(h.workspace.screen, screen); assert.equal(h.element('studio').dataset.workspaceScreen, screen);
    assert.equal(h.element('knowledgeDialog').hidden, true);
    assert.equal(h.element('openKnowledge').getAttribute('aria-current'), null);
    assert.equal(h.element('openKnowledge').getAttribute('aria-busy'), null);
    await h.element('openKnowledge').click(); await tick();
    assert.equal(h.workspace.screen, 'library'); assert.equal(h.element('knowledgeDialog').hidden, false);
    assert.equal(h.knowledgeLoads, 1, 'intentional reopening reuses the loaded page without resurrecting an old navigation');
  });
}


test('initial loading enables scene controls and normal panel motion while unreadied content stays inert', () => {
  const h = harness({ restore: () => new Promise(() => {}) });
  assert.equal(h.element('shell').dataset.pageState, 'loading');
  assert.equal(h.element('shell').dataset.booting, undefined, 'initial placement is committed before interactive loading begins');
  for (const id of ['openLibrary', 'summarySwitch', 'mandalaSwitch', 'lifetimeToggle', 'fitButton'] as const)
    assert.equal(h.element(id).inert, false, `${id} remains available during real loading`);
  assert.equal(h.element('shell').inert, false);
  assert.equal(h.element('mainNavigation').inert, true);
  assert.equal(h.element('lifetimeControls').inert, true);
});

test('the initial chart and chrome reveal together after restoration and fonts, then stay revealed', async () => {
  let finishRestore, finishFonts;
  const moment = { id: 'current-transit', source: 'transit' as const, personality: [1], design: [] };
  const h = harness({ charts: [moment], restore: () => new Promise(done => { finishRestore = done; }),
    fonts: new Promise(done => { finishFonts = done; }) });
  assert.equal(h.element('shell').dataset.pageState, 'loading');
  finishRestore!(true); await tick();
  assert.equal(h.element('shell').dataset.pageState, 'loading', 'the font metrics are part of the first screen');
  finishFonts!(); await tick();
  assert.equal(h.element('shell').dataset.pageState, 'ready');
  assert.equal(h.element('shell').dataset.booting, undefined);
  assert.equal(h.element('shell').inert, false);
  await h.element('nowButton').click(); await tick();
  assert.equal(h.element('shell').dataset.pageState, 'ready', 'later data updates never cover the whole page again');
});

test('a failed first restoration reveals the existing recovery interface instead of an endless shell', async () => {
  const h = harness({ restore: async () => false }); await tick();
  assert.equal(h.element('shell').dataset.pageState, 'error');
  assert.equal(h.element('shell').inert, false); assert.equal(h.element('shell').dataset.booting, undefined);
});

test('workspace readiness waits for its lazy content but never for the hidden chart restoration', async () => {
  let finishKnowledge;
  const h = harness({ savedView: { workspace: 'library' }, restore: () => new Promise(() => {}),
    loadKnowledge: () => new Promise(done => { finishKnowledge = done; }) });
  await tick(); assert.equal(h.element('shell').dataset.pageState, 'loading');
  finishKnowledge!(); await tick();
  assert.equal(h.element('shell').dataset.pageState, 'ready');
  assert.equal(h.element('knowledgeDialog').hidden, false);
  const account = harness({ savedView: { workspace: 'account' }, restore: () => new Promise(() => {}) });
  await tick(); assert.equal(account.element('shell').dataset.pageState, 'ready');
});

test('a timeline command during delayed restoration survives the late failed restore result', async () => {
  let finishRestore;
  const initialPresentation = studioPresentation({ isTransit: true });
  const h = harness({ initialPresentation, restore: () => new Promise(done => { finishRestore = done; }) });
  await tick();
  assert.equal(h.element('shell').dataset.pageState, 'loading');
  assert.equal(h.element('lifetimeToggle').hidden, false);
  assert.equal(h.element('lifetimeToggle').getAttribute('aria-pressed'), 'false');
  await h.element('openLibrary').click(); assert.equal(h.panels.left, true);
  await h.element('openLibrary').click(); assert.equal(h.panels.left, false);
  await h.element('lifetimeToggle').click();
  assert.equal(h.interruptions, 1, 'an explicit mode choice supersedes pending restoration');
  assert.equal(h.element('lifetimeToggle').getAttribute('aria-pressed'), 'true', 'opening intent is visible before lazy data arrives');
  h.finishModule(); await tick();
  assert.equal(h.lifetime.state.opened, true);
  assert.equal(h.element('lifetimeToggle').getAttribute('aria-expanded'), 'true');
  const kind = h.timelineKinds.at(-1);
  finishRestore!(false); await tick();
  assert.equal(h.lifetime.state.opened, true, 'the old restore cannot close the chosen timeline');
  assert.equal(h.element('lifetimeToggle').getAttribute('aria-pressed'), 'true');
  assert.equal(h.timelineKinds.at(-1), kind);
  assert.notEqual(h.element('shell').dataset.pageState, 'error', 'failure of an obsolete restore is not the current screen error');
});


test('clicking a saved enabled chronicle before its controller arrives closes it without starting another load', async () => {
  let finishRestore;
  const moment = { id: 'current-transit', source: 'transit' as const, personality: [1], design: [] };
  const lifetime = { opened: true as const, mode: 'lifetime' as const };
  const initialPresentation = studioPresentation({ isTransit: true, lifetime, transitEnabled: true });
  const h = harness({ charts: [moment], savedView: { selectedId: moment.id, lifetime }, initialPresentation,
    restore: () => new Promise(done => { finishRestore = done; }) });
  await tick();
  assert.equal<unknown>(h.lifetime, undefined);
  assert.equal(h.element('lifetimeToggle').getAttribute('aria-pressed'), 'true');
  await h.element('lifetimeToggle').click();
  assert.equal(h.element('lifetimeToggle').getAttribute('aria-pressed'), 'false', 'the first click closes the mode shown as enabled');
  assert.equal(h.element('lifetimeToggle').getAttribute('aria-expanded'), 'false');
  assert.equal(h.loads, 0, 'closing the saved mode must not open its lazy controller');
  assert.equal(h.timelineKinds.at(-1), 'day');
  finishRestore!(true); await tick();
  assert.equal(h.element('lifetimeToggle').getAttribute('aria-pressed'), 'false');
  assert.equal(h.loads, 0, 'a late restoration cannot reopen the cancelled mode');
});

test('clicking a saved enabled natal day before restoration closes it and a late restore cannot reopen it', async () => {
  let finishRestore;
  const chart = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const initialPresentation = studioPresentation({ personalAvailable: true, dayOpened: true });
  const h = harness({ charts: [chart], savedView: { selectedId: chart.id, natalDay: { opened: true } }, initialPresentation,
    restore: () => new Promise(done => { finishRestore = done; }) });
  await tick();
  assert.equal(h.natalDay.state.opened, false);
  assert.equal(h.element('natalDayToggle').getAttribute('aria-pressed'), 'true');
  await h.element('natalDayToggle').click();
  assert.equal(h.natalDay.state.opened, false, 'the first click closes the day shown as enabled');
  assert.equal(h.dayRequests, 0, 'closing does not start a new day request');
  assert.equal(h.element('natalDayToggle').getAttribute('aria-pressed'), 'false');
  assert.equal(h.element('natalDayToggle').getAttribute('aria-expanded'), 'false');
  finishRestore!(true); await tick();
  assert.equal(h.natalDay.state.opened, false);
  assert.equal(h.dayRequests, 0, 'the saved open day cannot supersede an explicit close');
  assert.equal(h.element('natalDayToggle').getAttribute('aria-pressed'), 'false');
});


test('the saved timeline layout is retained through lazy restoration before accepting the actual panel', async () => {
  let finish;
  const initialPresentation = studioPresentation({ isTransit: true, lifetime: { opened: true, mode: 'lifetime' as const }, transitEnabled: true });
  const h = harness({ initialPresentation, restore: () => new Promise(done => { finish = done; }) });
  await tick();
  assert.equal(h.timelineKinds.at(-1), 'chronicle');
  for (const state of ['aria-pressed', 'aria-expanded'] as const) assert.equal(h.element('lifetimeToggle').getAttribute(state), 'true');
  assert.equal(h.element('lifetimeToggle').hidden, false);
  assert.equal(h.element('lifetimeControls').hidden, false);
  assert.equal(h.element('transitControls').hidden, true);
  h.clockTick();
  assert.equal(h.timelineKinds.at(-1), 'chronicle', 'intermediate live-transit updates cannot remove the saved dates layout');
  for (const state of ['aria-pressed', 'aria-expanded'] as const) assert.equal(h.element('lifetimeToggle').getAttribute(state), 'true', 'saved selection remains visible while restoration is pending');
  assert.equal(h.element('lifetimeControls').hidden, false);
  assert.equal(h.element('transitControls').hidden, true);
  finish!(false); await tick();
  assert.equal(h.timelineKinds.at(-1), 'day', 'completion accepts the actual state, including its failure recovery');
  assert.equal(h.element('shell').dataset.pageState, 'error');
});


test('a resized initial card viewport is measured again before revealing its new thumbnails', async () => {
  let calls = 0, finish;
  const h = harness({ savedView: { workspace: 'charts' }, restore: () => new Promise(() => {}), chartsReady: () => {
    calls++;
    return calls === 1 ? Promise.resolve(null) : new Promise(done => { finish = done; });
  } });
  await tick();
  assert.equal(calls, 2);
  assert.equal(h.element('shell').dataset.pageState, 'loading');
  finish!(true); await tick();
  assert.equal(h.element('shell').dataset.pageState, 'ready');
});

test('initial workspace and font failures release the existing navigation', async () => {
  const knowledge = harness({ savedView: { workspace: 'library' }, loadKnowledge: async () => { throw new Error('missing module'); },
    fonts: Promise.reject(new Error('font failed')), restore: () => new Promise(() => {}) });
  await tick();
  assert.equal(knowledge.element('shell').dataset.pageState, 'error');
  assert.equal(knowledge.element('shell').inert, false);
  const charts = harness({ savedView: { workspace: 'charts' }, chartsReady: async () => false, restore: () => new Promise(() => {}) });
  await tick();
  assert.equal(charts.element('shell').dataset.pageState, 'error');
  assert.equal(charts.element('shell').inert, false);
});


test('real pending loading accepts menu changes and releases its content restriction on completion', async () => {
  let finish;
  const h = harness({ restore: () => new Promise(done => { finish = done; }) });
  await h.element('openLibrary').click();
  assert.equal(h.panels.left, true); assert.equal(h.element('library').inert, false);
  assert.equal(h.element('mainNavigation').inert, true);
  h.panels.setRight(true);
  await h.element('libraryBackdrop').click();
  assert.equal(h.panels.left, false); assert.equal(h.element('library').inert, true);
  finish!(false); await tick();
  assert.deepEqual(h.panels.snapshot, { left: false, right: true });
  assert.equal(h.element('mainNavigation').inert, false);
  assert.equal(h.element('lifetimeControls').inert, false);
  assert.equal(h.element('library').inert, true, 'reveal does not unlock the closed panel');
});


for (const [width, phone] of [[390, true], [1200, false]] as const) {
  test(`explicit workspace navigation reveals the selected page and closes only the phone menu (width: ${width})`, async () => {
    const h = harness({ studioSize: { width, height: 844 } });
    await tick();
    for (const [button, screen, page] of [
      ['openAllCharts', 'charts', 'allChartsDialog'],
      ['openAccount', 'account', 'accountPage'],
      ['openKnowledge', 'library', 'knowledgeDialog'],
    ] as const) {
      h.panels.setLeft(true);
      await h.element(button).click(); await tick();
      assert.equal(h.workspace.screen, screen);
      assert.equal(h.element(page).hidden, false);
      assert.equal(h.panels.left, !phone);
      assert.equal(h.element('library').inert, phone);
      assert.equal(h.element('openLibrary').getAttribute('aria-expanded'), String(!phone));
      h.panels.setLeft(true);
      await h.element(button).click(); await tick();
      assert.equal(h.panels.left, !phone, 'choosing the already active screen still completes navigation');
    }
  });

  test(`explicit saved-chart and Transit selection close only the phone menu (width: ${width})`, async () => {
    const chart = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
    const h = harness({ charts: [chart], studioSize: { width, height: 844 } });
    await tick();
    for (const repeat of [false, true] as const) {
      h.panels.setLeft(true);
      if (!repeat) await h.element('openAccount').click();
      h.panels.setLeft(true);
      h.select(chart.id); await tick();
      assert.equal(h.workspace.screen, 'chart');
      assert.equal(h.shown.id, chart.id);
      assert.equal(h.panels.left, !phone, 'selecting a chart also completes navigation when it was already selected');
    }
    h.panels.setLeft(true);
    await h.element('nowButton').click();
    assert.equal(h.workspace.screen, 'chart');
    assert.equal(h.shown.id, 'current-transit');
    assert.equal(h.panels.left, !phone);
  });
}

test('restoring and projecting a phone workspace preserves its saved menu until explicit navigation', async () => {
  const h = harness({ studioSize: { width: 390, height: 844 },
    savedView: { workspace: 'account', panels: { left: true, right: false } } });
  await tick();
  assert.equal(h.workspace.screen, 'account');
  assert.equal(h.panels.left, true);
  assert.equal(h.element('library').inert, false);
  h.workspace.restore('charts'); await tick();
  assert.equal(h.workspace.screen, 'charts');
  assert.equal(h.panels.left, true, 'showing a restored screen is not a user navigation command');
  await h.element('openAllCharts').click();
  assert.equal(h.panels.left, false);
});


test('legacy performance parameters cannot enable the FPS monitor at application startup', () => {
  for (const search of ['', '?fps=1', '?perf=1', '?fps=1&perf=1&preview=loading'] as const) {
    const app = harness({ search });
    assert.equal(Boolean(app.performanceOptions!.initiallyEnabled), false, search);
    assert.equal(app.performanceOptions!.button, app.element('togglePerformance'), 'the existing button remains attached');
  }
});


async function openedReturnsHarness(width: number, navigationOpen = false) {
  const chart = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const event = { id: 'saturn:2050-01-01T12:00:29.432Z', body: 'saturn', utc: '2050-01-01T12:00:29.432Z', cycle: 1 };
  const exact = { ...chart, id: 'exact-return', utc: event.utc };
  const transit = { ...chart, id: 'current-transit', source: 'transit' as const, utc: '2028-01-01T12:00:00Z' };
  const h = harness({ realSummary: true, studioSize: { width, height: 844 }, charts: [chart, transit],
    returnEvents: [event], getReturn: async () => ({ event, chart: exact }) });
  await tick(); h.select(chart.id); await tick();
  await h.element('lifetimeToggle').click(); h.finishModule(); await tick();
  await h.element('summaryReturns').click(); await tick();
  if (navigationOpen) h.panels.setLeft(true);
  assert.ok(h.returnsViewOptions, 'the lazy returns view receives the actual app callbacks');
  assert.equal(h.returns.opened, true);
  assert.equal(h.returnsViewState?.visible, true);
  assert.equal(h.panels.right, true);
  assert.equal(h.element('chartSummary').dataset.screen, 'returns');
  return { h, chart, event, exact };
}

for (const [width, phone, placement, navigationOpen] of [[390, true, 'side', false], [760, false, 'sheet', true], [1400, false, 'side', false]] as const) {
  test(`returns list choices retain the open ${phone ? 'phone' : 'desktop'} ${placement} at width ${width}`, async () => {
    const { h, chart, event, exact } = await openedReturnsHarness(width, navigationOpen);
    assert.equal(h.layout.phone, phone);
    assert.equal(h.layout.returnsLayout, placement);
    const assertOpened = () => {
      assert.equal(h.returns.opened, true);
      assert.equal(h.returnsViewState?.visible, true);
      assert.equal(h.panels.right, true);
      assert.equal(h.element('chartSummary').classList.contains('open'), true);
      assert.equal(h.element('chartSummary').dataset.screen, 'returns');
      assert.equal(h.lifetime.state.opened, true);
    };
    await h.returnsViewOptions.onSelect(event.id);
    assert.equal(h.returns.state.selectedEvent?.id, event.id);
    assert.deepEqual(h.shown.secondary, extractChartData(exact));
    assertOpened();
    h.returnsViewOptions.onBirth!();
    assert.deepEqual(h.shown.primary, extractChartData(chart));
    assert.equal(h.shown.secondary, null);
    assert.equal(h.returns.state.selectedEvent, null);
    assertOpened();
    h.returnsViewOptions.onNow!();
    assert.equal(h.transitNowRequests, 1, 'the app dispatches the existing follow-now action');
    assert.equal(h.returnsViewState?.live, true);
    assertOpened();
  });
}

for (const width of [390, 1400]) test(`breaking a comparison retains returns filters and the open panel at width ${width}`, async () => {
  const { h, chart, event } = await openedReturnsHarness(width);
  await h.returns.setYear(2050); await h.returns.setBodies(['saturn']);
  await h.returnsViewOptions.onSelect(event.id);
  const panels = h.panels.snapshot, interruptions = h.interruptions;
  const camera = h.camera.getView();
  await h.element('summaryBreakComparison').click();
  assert.deepEqual(h.shown.primary, extractChartData(chart));
  assert.equal(h.shown.secondary, null);
  assert.equal(h.returns.state.selectedEvent, null);
  assert.equal(h.returns.state.year, 2050, 'breaking the pair preserves the list period');
  assert.deepEqual(h.returns.state.bodies, ['saturn']);
  assert.equal(h.returns.opened, true);
  assert.equal(h.lifetime.state.opened, true);
  assert.deepEqual(h.panels.snapshot, panels);
  assert.equal(h.element('chartSummary').dataset.screen, 'returns');
  assert.equal(h.element('chartSummary').classList.contains('open'), true);
  assert.equal(h.returnsViewState?.visible, true);
  assert.equal(h.interruptions, interruptions + 1, 'the explicit action supersedes pending restoration');
  assert.deepEqual(h.camera.getView(), camera);
});
