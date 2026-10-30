import { createResourceScope } from '../src/runtime/resource-scope.ts';
import {libraryRecordEntry} from '../src/state/library-reconciliation.ts';
import type {LibraryListChart} from '../src/domain/library-catalog.ts';
import {chartPresentation} from '../src/domain/chart-presentation.ts';
import {createViewCheckpoint} from '../src/state/view-checkpoint.ts';
import { createLayoutObserver } from '../src/ui/layout/resize-observer.ts';
import { attachChartLink } from '../src/views/chart-link.ts';
import { appRoutePath } from '../shared/app-routes.ts';
import {createHash} from 'node:crypto';
import {attachOfflinePage} from '../src/offline/page-coordinator.ts';
import {attachOfflineWorker,type OfflineWorkerEvents,type OfflineWorkerScope} from '../src/offline/service-worker.ts';
import {createAppBundle,type BundleCaches} from '../src/offline/app-bundle.ts';
import type {OfflineCommand,OfflineTabRequest} from '../shared/offline-contract.ts';
import {createViewStore} from '../src/data/view-store.ts';
import {createStoragePressure} from '../src/data/storage-pressure.ts';
import {createJournal} from '../src/journal.ts';
import { chartId } from './helpers/account-chart.ts';
import { createLocalDayTimeline } from '../src/domain/day-timeline.ts';
import { createNavigation } from '../src/platform/browser/navigation.ts';
import { createApplication } from '../src/application/application.ts';
import {createBackgroundCoordinator} from '../src/platform/browser/background-coordinator.ts';
import {createPageLifecycle} from '../src/platform/browser/lifecycle.ts';
import {createLibraryFillTransfer} from '../src/data/library-fill-transfer.ts';
import type {BackgroundControl,BackgroundStore} from '../src/domain/background-check.ts';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import {createCalculationCache} from '../src/data/calculation-cache.ts';
import { createChartClient } from '../src/data/chart-client.ts';
import { createAccountLibraryStore } from '../src/data/account-library-store.ts';
import { createAccountLibrary } from '../src/state/account-library.ts';
import { createChartActions } from '../src/state/chart-actions.ts';
import { UI_MESSAGES, failureMessage } from '../src/ui/messages.ts';
import { accountNatalChart } from './helpers/account-chart.ts';
import type { AccountChart, PublicAccountChart } from '../shared/chart-record-contract.ts';
import type { ChartClient } from '../src/data/chart-client.ts';
import type { LibrarySession } from '../src/state/account-library.ts';
import type { BirthSubmission } from '../src/views/birth-form.ts';
import { createBirthClient } from '../src/data/birth-client.ts';
import { createChartStore } from '../src/data/chart-store.ts';
import { getConnectionMode, subscribeConnection, type ConnectionSource } from '../src/data/http-transport.ts';
import { actionAvailability } from '../src/ui/action-state.ts';
import { createChartHighlight } from '../src/state/chart-highlight.ts';
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
  contains(node: { id?: string } | null): boolean; focus(): void; matches(selector:string):boolean;
  selectionStart?: number; selectionEnd?: number; selectionDirection?: string;
  setSelectionRange(start:number,end:number,direction?:string):void;
  querySelector(selector: string): BrowserElement | null; querySelectorAll(): BrowserElement[];
  getBoundingClientRect(): { top: number; bottom: number; left: number; right: number; width: number; height: number };
  setAttribute(name: string, value: unknown): void; getAttribute(name: string): string | null; removeAttribute(name: string): void;
  classList: { add(name: string): unknown; remove(name: string): unknown; contains(name: string): boolean; toggle(name: string, enabled?: boolean): void };
  addEventListener(type: string, handler: BrowserListener, options?: boolean | AddEventListenerOptions): void;
  dispatch(type: string, event?: Record<string, unknown>): Promise<void>; click(): Promise<void>;
  open?: boolean; textContent?: string; value?: string; title?: string; showModal(): void; close(): void;
}
interface BrowserDocument {
  body: { dataset: Record<string, string> }; activeElement: BrowserElement | null; fonts?: { ready: Promise<unknown> };
  createElement(tag: string): BrowserElement; getElementById(id: string): BrowserElement | null;
  querySelector(selector: string): BrowserElement | null; querySelectorAll(): BrowserElement[];
  addEventListener(type: string, handler: BrowserListener, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type:string,handler:BrowserListener):void;
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
  connection?: ConnectionSource;
  copyText?: (text: string) => Promise<void>;
  transitStart?: () => Promise<boolean>;
  actualStore?: ReturnType<typeof createChartStore>;
  accountReady?: Promise<unknown>;
  storagePressure?: ReturnType<typeof createStoragePressure>;
  journal?: Parameters<typeof import('../src/app.ts').startApp>[0]['journal'];
  navigation?: ReturnType<typeof createNavigation>; onPersonalReset?: () => void;
  syncTransitWindow?: ReturnType<typeof import('../src/data/calculation-clients.ts').createCalculationClients>['syncTransitWindow'];
  personalCleanup?: Pick<ReturnType<typeof import('../src/data/calculation-clients.ts').createCalculationClients>,'resetPersonal'|'retryPersonalCleanup'>;
  chartClient?: Partial<ChartClient>; accountSession?: (LibrarySession & {diagnosticProof?:string}) | null;
  libraryStorage?: ReturnType<typeof createAccountLibraryStore>;
  realSummary?: boolean; realViewSession?: boolean; realTransit?: boolean; search?: string; restore?: () => Promise<boolean>; savedView?: TestStub<SavedView> | null;
  fonts?: Promise<unknown>; initialPresentation?: ReturnType<typeof studioPresentation> | null;
  studioSize?: { width: number; height: number } | null; metaError?: unknown;
  charts?: readonly TestChart[]; loadKnowledge?: (() => Promise<unknown>) | null;
  chartsReady?: (() => Promise<unknown>) | null; returnEvents?: (Pick<CycleEvent, 'id' | 'body' | 'utc' | 'cycle'> & Partial<CycleEvent>)[];
  getReturn?: (input: CycleInput, signal?: AbortSignal) => Promise<{ chart: ChartInput; event?: Partial<CycleEvent> }>;
  getPoint?: (index: number, options?: { signal?: AbortSignal }) => Promise<LifetimePoint>;
}
// Real argument contracts for injected browser ports; each test supplies its own result.
type AppPorts = Pick<typeof import('../src/runtime/resource-scope.ts'), 'createResourceScope'> & Pick<typeof import('../src/domain/chart-presentation.ts'), 'chartPresentation'> & Pick<typeof import('../src/state/view-checkpoint.ts'), 'createViewCheckpoint'> & Pick<typeof import('../src/ui/layout/resize-observer.ts'), 'createLayoutObserver'> & Pick<typeof import('../src/views/chart-link.ts'), 'attachChartLink'>
  & Pick<typeof import('../shared/app-routes.ts'), 'appRoutePath'>
  & Pick<typeof import('../src/domain/day-timeline.ts'), 'createLocalDayTimeline'>
  & Pick<typeof import('../src/data/birth-client.ts'), 'createBirthClient'>
  & Pick<typeof import('../src/data/chart-client.ts'), 'createChartClient'>
  & Pick<typeof import('../src/data/account-library-store.ts'), 'createAccountLibraryStore'>
  & Pick<typeof import('../src/state/account-library.ts'), 'createAccountLibrary'>
  & Pick<typeof import('../src/state/chart-actions.ts'), 'createChartActions'>
  & Pick<typeof import('../src/ui/messages.ts'), 'UI_MESSAGES' | 'failureMessage'>
  & Pick<typeof import('../src/data/http-transport.ts'), 'getConnectionMode' | 'subscribeConnection'>
  & Pick<typeof import('../src/ui/action-state.ts'), 'actionAvailability'>
  & Pick<typeof import('../src/views/knowledge-entry.ts'), 'attachKnowledgeEntry'>
  & Pick<typeof import('../src/views/activation-popover.ts'), 'attachActivationPopover'>
  & Pick<typeof import('../src/selection/hover-preview.ts'), 'attachHoverPreview'>
  & Pick<typeof import('../src/scene/activation-hover.ts'), 'attachActivationHover'>
  & Pick<typeof import('../src/scene/gestures.ts'), 'attachGestures'>
  & Pick<typeof import('../src/scene/pointer-target.ts'), 'pointerTarget'>
  & Pick<typeof import('../src/scene/modes/mandala.ts'), 'attachMandalaMode'>
  & Pick<typeof import('../src/scene/modes/mandala-motion.ts'), 'createMandalaMotion'>
  & Pick<typeof import('../src/scene/mandala-preview.ts'), 'mandalaPreviewFromPointer' | 'mandalaPreviewFromFocus' | 'mandalaSelectionFromTarget'>
  & Pick<typeof import('../src/scene/updates.ts'), 'createGraphController'>
  & Pick<typeof import('../src/state/chart-highlight.ts'), 'chartHighlight'>
  & Pick<typeof import('../src/views/camera-controls.ts'), 'attachCameraControls' | 'createCameraChangeHandler'>
  & Pick<typeof import('../src/application/application.ts'), 'createApplication'>
  & Pick<typeof import('../src/platform/browser/background-coordinator.ts'), 'createBackgroundCoordinator'>
  & Pick<typeof import('../src/platform/browser/lifecycle.ts'), 'createPageLifecycle'>
  & Pick<typeof import('../src/data/library-fill-transfer.ts'), 'createLibraryFillTransfer'>
  & Pick<typeof import('../src/state/chart-session.ts'), 'createChartSession'>
  & Pick<typeof import('../src/state/chart-exploration.ts'), 'createChartExploration'>
  & Pick<typeof import('../src/state/view-session.ts'), 'createViewSession' | 'viewForRoute'>
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
  & Pick<typeof import('../src/domain/cycles.ts'), 'eligibleCycleChart' | 'personalTimelineTarget' | 'cycleTimeZone'>
  & Pick<typeof import('../src/views/returns-markers.ts'), 'attachReturnMarkers'>
  & Pick<typeof import('../src/domain/returns-window.ts'), 'returnsVisibleWindow'>
  & Pick<typeof import('../src/ui/studio-presentation.ts'), 'studioPresentation'>;
type PortOptions<K extends keyof AppPorts> = AppPorts[K] extends (...args: infer P) => unknown ? NonNullable<P[0]> : never;
type StubPorts = { [K in keyof AppPorts]: AppPorts[K] extends (...args: infer P) => unknown ? (...args: P) => unknown : AppPorts[K] };
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
import { createViewSession, viewForRoute } from '../src/state/view-session.ts';
import { createTransitPlanetFilter } from '../src/state/transit-planets.ts';
import { createReturnsController } from '../src/state/returns.ts';
import { createNatalDayExplorer, type NatalExplorerOptions } from '../src/state/natal-day.ts';
import { createLifetimeExplorer } from '../src/state/lifetime.ts';
import { eligibleCycleChart, personalTimelineTarget, cycleTimeZone } from '../src/domain/cycles.ts';
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
import { attachTransitNavigation, attachLiveTransit as attachRealLiveTransit } from '../src/views/live-transit.ts';
import { holdLoadingContent, commitLoadingLayout } from '../src/views/chart-loading.ts';
import { studioPresentation } from '../src/ui/studio-presentation.ts';

// Execute the whole composition root, preserving declaration and attachment
// order. Browser-heavy views use ports; library/knowledge and state owners are real.
const source = readModuleSource(new URL('../src/app.ts', import.meta.url));
const imports = [...source.matchAll(/^import \{ (.*?) \} from .*;$/gm)].flatMap(match => match[1].split(', '));
const body = source.replace(/^import .*;\n/gm, '').replace('export function startApp', 'function startApp');
const noop = () => {};
function browser() {
  const elements = new Map<string, BrowserElement>(), listeners = new Map<string, Set<BrowserListener>>(); let created = 0;
  const document: BrowserDocument = { body: { dataset: {} }, activeElement: null,
    createElement: tag => element(`${tag}-${++created}`),
    getElementById: (id: string) => ['returnsToggle', 'returnsControls'].includes(id) ? null : element(id), querySelector: (selector: string) => selector === '.app-shell' ? element('shell') : null, querySelectorAll: () => [],
    addEventListener(type, handler, options) { const signal=typeof options==='object'?options.signal:undefined; if(signal?.aborted)return; if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type)!.add(handler);signal?.addEventListener('abort',()=>listeners.get(type)?.delete(handler),{once:true}); },
    removeEventListener(type,handler){listeners.get(type)?.delete(handler);},
    dispatch(type, event) { for(const handler of listeners.get(type)??[])handler(event); } };
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
        focus() { document.activeElement = this; }, matches(){return ['accountEmail','accountCode'].includes(id);},
        setSelectionRange(start,end,direction='none'){this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction;}, querySelector: selector => element(`${id}:${selector}`), querySelectorAll: () => [],
        getBoundingClientRect: () => ({ top: 0, bottom: 820, left: 0, right: 640, width: 640, height: 820 }),
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute: name => attributes.get(name) ?? null, removeAttribute: name => attributes.delete(name),
        classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name), contains: (name: string) => classes.has(name),
          toggle(name: string, enabled = !classes.has(name)) { if (enabled) classes.add(name); else classes.delete(name); } },
        addEventListener(type, handler, options = false) { const signal=typeof options==='object'?options.signal:undefined,capture=typeof options==='boolean'?options:options.capture??false; if(signal?.aborted)return; if (!handlers.has(type)) handlers.set(type, []); const entry={handler,capture}; handlers.get(type)!.push(entry);signal?.addEventListener('abort',()=>{handlers.set(type,handlers.get(type)!.filter(item=>item!==entry));},{once:true}); },
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

function catalogPage(charts:AccountChart[],accountId:string) {
 return {kind:'page' as const,accountId,marker:charts.length?'1':'0',entries:charts.map(chart=>libraryRecordEntry(chart)),nextCursor:null};
}
function testChartClient(overrides: Partial<ChartClient>): ChartClient {
  const unexpected = async () => {throw new Error('Unexpected chart API call in composition test');};
  return {create:unexpected,update:unexpected,remove:unexpected,addFromSource:unexpected,outcome:unexpected,
    own:unexpected,public:unexpected,list:unexpected,readyDay:unexpected,catalog:unexpected,confirmCatalog:async input=>({kind:'confirmed',accountId:input.expectedAccountId,marker:input.marker}),...overrides};
}
function harness({connection, copyText, transitStart = async () => true, actualStore, accountReady = Promise.resolve(), storagePressure,  journal, navigation, onPersonalReset, personalCleanup, syncTransitWindow, chartClient, libraryStorage, accountSession = null, realSummary = false, realViewSession = false, realTransit = false, search = '', restore = async () => true, savedView = null, fonts, initialPresentation = null, studioSize = null, metaError = null, charts = [], loadKnowledge = null, chartsReady = null, returnEvents = [], getReturn = () => assert.fail('no return calculation expected'), getPoint = () => assert.fail('these navigation actions do not request lifetime points') }: HarnessOptions = {}) {
  const { document, element } = browser();
  let backgroundTimeOffset=0;
  let hovered = false, notifyHover: () => void = noop;
  const inputRestores: string[] = [];
  const notices:string[]=[];
  const resizeFrames = new Map<number, FrameRequestCallback>(); let resizeFrameId = 0;
  const flushResizeFrames = () => { const pending = [...resizeFrames.values()]; resizeFrames.clear(); for (const callback of pending) callback(0); };
  if (fonts !== undefined) document.fonts = { ready: fonts };
  const dimensions = studioSize && { ...studioSize };
  const timelineKinds: TimelineKind[] = [];
  let resizeLayout: () => void, layout = { destroy:noop, refresh: noop, setTimelineKind: (kind: TimelineKind) => timelineKinds.push(kind), setSidePanels: noop, sideInsets: { width: 640, left: 0, right: 0 } } as unknown as StudioLayout;
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
  let publicChart: TestChart | null = null,retainedPublic:PublicAccountChart|null=null;
  let listed:readonly LibraryListChart[]|null=null;
  const fixtureStore = { get publicChart(){return retainedPublic;},acceptPublic(value:PublicAccountChart){retainedPublic=value;publicChart={...value,note:'',createdAt:'',updatedAt:''};},clearPublic(id:string){if(retainedPublic?.id!==id)return false;retainedPublic=null;if(publicChart?.id===id)publicChart=null;return true;}, get displayCharts(){return listed??charts;}, clearTemporary(_id: string) {return false;}, showPublic(value: TestChart | null) {publicChart=value;}, releasePublicSource(source:TestChart){if(publicChart===source)publicChart=null;}, charts, storageAvailable: true, get: (id: string) => charts.find(chart => chart.id === id) ?? (publicChart?.id===id?publicChart:undefined), has: (id: string) => publicChart?.id===id || charts.some(chart => chart.id === id),
    projectLibrary(next: SavedChart[],_available:boolean,_ready:string[],entries?:readonly LibraryListChart[]) { charts = fixtureStore.charts = next;listed=entries??null; },
    remove(id: string) { charts = fixtureStore.charts = charts.filter(chart => chart.id !== id); } };
  const store=actualStore ?? fixtureStore;
  let loadingOptions: PortOptions<'attachChartLoading'>, loadingState: Record<string,unknown> = {};
  let savedSnapshot: Partial<SavedView> | null = null;
  const accountListeners = new Set<() => void>();
  let libraryChannel: {onmessage: ((event: {data: unknown}) => void | Promise<void>) | null} | null = null;
  const noticeListeners = new Set<(value: {kind: 'logout'; ids: string[]}) => void>();
  let graph!: PortOptions<'createGraphController'>;
  let gestures!: NonNullable<Parameters<AppPorts['attachGestures']>[1]>;
  let camera!: Camera;
  let natalDay!: ReturnType<typeof createNatalDayExplorer>, returns!: ReturnType<typeof createReturnsController>;
  let editedId: string | null = null;
  let birthDraft: SavedView['birthForm'] = null;
  let birthOptions!: PortOptions<'attachBirthForm'>, lifetime!: ReturnType<typeof createLifetimeExplorer>;
  let lifetimeOptions!: Parameters<typeof attachLifetimeControls>[0];
  let lifetimeDisposals=0;
  let returnsViewOptions!: Parameters<typeof attachReturnsPanel>[0], returnsViewState: ReturnsPanelState | undefined;
  let transitNowRequests = 0, transitStarts = 0, activationHoverClears = 0;
  const clearActivationHover = () => { activationHoverClears++; };
  let lifetimeStateOptions!: NonNullable<Parameters<typeof createLifetimeExplorer>[0]>;
  let transitOptions!: PortOptions<'attachLiveTransit'>;
  let liveTransit: ReturnType<typeof attachRealLiveTransit> | undefined;
  let finishModule!: (value: unknown) => void, failModule!: (error: unknown) => void;
  let loads = 0, stateLoads = 0, reloads = 0, renders = 0, dayRequests = 0, chartSelections = 0, interruptions = 0;
  let performanceOptions!: PortOptions<'attachPerformanceMonitor'>;
  let captionUpdates = 0, workspace!: ReturnType<typeof createWorkspaceState>, panels!: ReturnType<typeof createPanelState>;
  let knowledgeOptions!: PortOptions<'attachKnowledgeEntry'>, knowledgeLoads = 0, restoreInterrupted = false;
  const module = new Promise<unknown>((resolve, reject) => { finishModule = resolve; failModule = reject; });
  const memory = {}, natalClient = {};
  const copiedLinks: string[] = [];
  // Clipboard is external; the real link view and composition determine its address and availability.
  const copyNotice = {revision: 0, contains: () => false, close() {this.revision++;},
    show() {this.revision++; return {active: true, update() {}, close() {}};}};
  const ports: StubPorts = {
    createApplication,createViewCheckpoint,chartPresentation,createPageLifecycle,createLibraryFillTransfer,
    createBackgroundCoordinator:options=>{
      let control:BackgroundControl={leader:null,checks:{}};
      const coordination:BackgroundStore={read:async()=>structuredClone(control),update:async change=>{
        const next=structuredClone(control),result=change(next);control=next;return result;
      }};
      return createBackgroundCoordinator({...options,store:libraryStorage?.background??coordination,clock:{now:()=>Date.now()+backgroundTimeOffset,after(ms,callback){
      if(ms===25){let cancelled=false;queueMicrotask(()=>{if(!cancelled)callback();});return()=>{cancelled=true;};}
      const timer=setTimeout(callback,ms);timer.unref();return()=>clearTimeout(timer);
    }}});},
    appRoutePath, attachChartLink: options => attachChartLink({...options, notice: copyNotice,
      writeText: copyText ?? (async text => {copiedLinks.push(text);})}),
    createBirthClient, createChartClient: options => chartClient ? testChartClient(chartClient) : createChartClient(options),
    createAccountLibraryStore: () => libraryStorage ?? createAccountLibraryStore({indexedDB: null}),
    createResourceScope, createAccountLibrary, createChartActions, UI_MESSAGES, failureMessage, getConnectionMode, subscribeConnection, actionAvailability,
    createLocalDayTimeline, viewForRoute, createChartSession, createChartExploration, createTransitPlanetFilter, studioPresentation, holdLoadingContent, commitLoadingLayout,
    attachAllCharts: (options) => {
      const view = attachAllCharts({ ...options, preview: (_canvas, _chart, { onReady } = {}) => { onReady!(true); return noop; } });
      const traced={...view,restoreInputFocus(){inputRestores.push('charts');return view.restoreInputFocus();}};
      return chartsReady ? { ...traced, whenReady: chartsReady } : traced;
    },
    createNatalDayClient: (options) => { assert.equal(options!.memory, memory); return natalClient; },
    createReturnsController: (options) => returns = createReturnsController(options),
    eligibleCycleChart, personalTimelineTarget, cycleTimeZone, returnsVisibleWindow, attachChartLibrary,
    attachKnowledgeEntry: (options) => {
      knowledgeOptions = options;
      return attachKnowledgeEntry({ ...options, load: async () => {
        knowledgeLoads++; if (loadKnowledge) await loadKnowledge();
        return { attachKnowledge: page => ({ snapshot:{query:'',searchOpen:false,collection:'',entryId:'',view:'catalog' as const}, restoreInputFocus(){inputRestores.push('knowledge');return true;}, show() { page.hidden = false; }, hide() { page.hidden = true; } }) };
      } });
    },
    attachActivationPopover: () => ({ close: noop, reposition: noop, refresh: noop, destroy:noop }),
    attachActivationHover: () => ({ clear: clearActivationHover, dispose: noop }),
    attachHoverPreview: (_svg, options) => {
      assert.equal(options.onClear, clearActivationHover, 'preview dismissal also clears its decorative activation highlight');
      notifyHover = () => options.onPreview?.({type: 'gate', id: 1});
      return { clear: ({notify = true} = {}) => {
        options.onClear?.();
        if (hovered) { hovered = false; if (notify) options.onPreview?.(null); }
      }, get currentSelection() { return hovered ? {type: 'gate', id: 1} : null; } };
    },
    attachGestures: (_svg, options) => {
      gestures = options;
      camera = options.camera!;
      camera.setOnChange(options.onChange!);
      return camera;
    },
    pointerTarget: noop,
    attachMandalaMode: (options) => dimensions ? attachMandalaMode(options) : ({ enabled: false, setEnabled: noop }), createMandalaMotion: () => ({dispose:noop,setExpanded:noop}),
    mandalaPreviewFromPointer: noop, mandalaPreviewFromFocus: noop, mandalaSelectionFromTarget: noop,
    chartHighlight: createChartHighlight(),
    createGraphController: (options) => { graph = options;
      if (dimensions) return createGraphController({ ...options, scene: {
        update(chart, selection, settings) { renders++; element('viewport').innerHTML = renderBodygraph(chart, selection, settings); },
        clear() { element('viewport').innerHTML = ''; },
      } });
      return { choose: noop, changeChart: (id: string) => { chartSelections++; options.onChartChange!(id); },
      clear: noop, render: () => { renders++; }, preview: noop, selectionState: { primary: null } }; },
    attachCameraControls: noop, createCameraChangeHandler: () => noop,
    createViewSession: (options) => {
      assert.equal(options.cameraRestored, true);
      if (realViewSession) return createViewSession({ ...options, eventTarget: null, interactionTarget: null, delay: 0 });
      return {
      restore, get interrupted() { return restoreInterrupted; },
      interrupt() { restoreInterrupted = true; interruptions++; options.onInterrupt?.(); }, schedule: noop, flush: noop,
      checkpoint: async () => ({kind:'memory-only'}),
    }; },
    chartCaption: (...args) => { captionUpdates++; return chartCaption(...args); },
    createLayoutObserver: refresh => createLayoutObserver(refresh, {
      Observer: class { constructor(callback: () => void) { resizeLayout = callback; } observe() {} disconnect() {} } as unknown as typeof ResizeObserver,
      requestFrame: callback => {resizeFrames.set(++resizeFrameId, callback); return resizeFrameId;}, cancelFrame: id => {resizeFrames.delete(id);},
    }),
    createChartHeadingLayout: ({ title, subtitle }) => ({ updateText(a: string, b: string) { title.textContent = a; subtitle!.textContent = b; }, refresh: noop, destroy:noop }),
    attachBirthForm: options => { birthOptions = options; return { get opened() {return editedId !== null || !!birthDraft;}, get editedId() {return editedId;}, close() {editedId=null;birthDraft=null;}, refreshAvailability:noop, restore() {return false;}, get snapshot(){return birthDraft;}, pending:false, refresh() {if (editedId && !store.get(editedId)) editedId=null;} }; },
    attachLiveTransit: (options) => {
      transitOptions = options;
      if (realTransit) return liveTransit = attachRealLiveTransit({...options,
        now: () => Date.parse('2026-09-24T12:00:20Z'), timeZone: () => 'UTC',
        dayClient: { getDay: async date => natalDayFixture({date}) },
      });
      const current = dimensions ? store.get('current-transit') : null;
      return { state: { wanted: true, current, status: current ? 'ready' : 'idle' }, current, stop:noop, refresh: noop, visibilityChanged: noop, setWanted: noop, start: async () => {transitStarts++;return transitStart();},
        goNow: async () => { transitNowRequests++; return true; } };
    },
    attachTransitNavigation,
    attachTransitControls: ({ panel }) => ({ update: noop, setCoveredByLifetime(value: boolean) { if (dimensions) panel.hidden = value; } }),
    attachNatalDayExplorer: (options: NatalExplorerOptions|undefined) => natalDay = createNatalDayExplorer({ ...options, dayClient: { getDay: async () => { dayRequests++; return natalDayFixture(); } } }),
    attachChartSummary: options => realSummary ? attachChartSummary(options) : ({ close: noop, setReturnsVisible: noop, update: noop, layout() { options.panel.hidden = !options.isAvailable!(); } }), attachTelegramGestures: () => noop, attachPerformanceMonitor: options => { performanceOptions = options; return {destroy:noop}; },
    attachChartLoading: options => {loadingOptions=options;return {update: (value: Record<string,unknown>) => {loadingState=value;}};}, createCyclesClient: (options) => { assert.equal(options!.memory, memory); return { events: async (input: CycleInput) => ({ events: returnEvents.filter(event => event.body === input.body) }), chart: getReturn }; }, ageText, completedAge,
    attachReturnMarkers: () => ({ update: noop }),
  };
  for (const name of imports) assert.equal(typeof ports[name as keyof AppPorts], ['chartHighlight', 'UI_MESSAGES'].includes(name) ? 'object' : 'function', `provide the explicit browser port ${name}`);
  const startApp = new Function(...imports, 'document', 'ResizeObserver', 'location', 'window', 'getComputedStyle', 'loadLifetimeView', 'loadLifetimeState', 'loadReturnsViewModule',
    `${body.replace("import('./views/lifetime-controls.ts')", 'loadLifetimeView()')
      .replace("import('./state/lifetime.ts')", 'loadLifetimeState()')
      .replace("import('./views/returns-panel.ts')", 'loadReturnsViewModule()')}\nreturn startApp;`)(
    ...imports.map(name => ports[name as keyof AppPorts]), document, class { constructor(callback: () => void) { resizeLayout = callback; } observe() {} }, { search, href: 'https://forma.example.test/chart?obsolete=1#old' },
    Object.assign(new EventTarget(),{ location: { reload() { reloads++; } }, BroadcastChannel: class extends EventTarget {
      onmessage: ((event: {data: unknown}) => void | Promise<void>) | null = null;
      constructor(name: string) {super();if(name==='forma-library')libraryChannel = this;else assert.equal(name,'forma-background-checks');}
      postMessage() {} close() {}
    } }), () => ({ getPropertyValue: () => '320px' }), () => { loads++; return module; }, async () => {
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
      return { update(state: ReturnsPanelState) { returnsViewState = state; } };
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
  const calculationClients = onPersonalReset || personalCleanup || syncTransitWindow ? {natal:natalClient,cycles:{events:async()=>({events:[]}),chart:getReturn},
    resetPersonal:async()=>{onPersonalReset?.();return {status:'cleared',generation:1};},retryPersonalCleanup:async()=>null,syncTransitWindow,...personalCleanup} : undefined;
  const application=startApp({ connection, journal, storagePressure, navigation, calculationClients, account: { ready: accountReady, restoreInputFocus(){inputRestores.push('account');return true;}, snapshot: savedView?.account ?? null, setVisible: noop, getSession: () => accountSession, subscribeSession: (listener: () => void) => {accountListeners.add(listener); return () => {accountListeners.delete(listener);};}, subscribeNotices: (listener: (value: {kind:'logout';ids:string[]})=>void) => {noticeListeners.add(listener); return () => {noticeListeners.delete(listener);};}, canRestoreLibrary: async () => true }, dayClient: { memory }, layout, toast: (message:string)=>{notices.push(message);}, viewStore: {clear(){savedSnapshot=null;return true;}, write: (value: Partial<SavedView>) => {savedSnapshot = value; return true;} }, savedView, panels, workspace, store, libraryView, camera, cameraView, initialPresentation });
  return { highlight:ports.chartHighlight, setHovered() { hovered = true; notifyHover(); }, get liveTransit() { return liveTransit; }, copiedLinks, element, layout, natalClient, inputRestores, notices, restoration:application.restoration, stopApplication:application.stopApplication,
    advanceBackground(ms:number){backgroundTimeOffset+=ms;},
    get savedSnapshot(){return savedSnapshot;},prepareOfflineUpdate:application.prepareOfflineUpdate,
    offlineRestored:application.offlineRestored,subscribeOfflineReady:application.subscribeOfflineReady,
    userInput(type='pointerdown'){document.dispatch(type,{target:element('openAccount')});}, get loading(){return loadingState;}, retryLoading(){loadingOptions.onRetry();},
    attachJournal:application.attachJournal,attachReleaseCheck:application.attachReleaseCheck,saveShown:application.saveShownChart,cancelSave:application.cancelChartSave,
    get pendingWrites() {return savedSnapshot?.pendingChartWrites;},
    setBirthDraft(value: SavedView['birthForm']) {birthDraft=value;birthOptions.onDraftChange?.();},
    flushView:application.flushView,get savedBirthDraft(){return savedSnapshot?.birthForm;},
    get cards() {return store.charts;},get rows(){return store.displayCharts;},
    prepareTemporary(chart: SavedChart) {const saved=birthOptions.saveChart(chart);birthOptions.onSave(chart.id);return saved;},
    submitPort(input: BirthSubmission) {return birthOptions.submitChart?.(input,new AbortController().signal);},
    libraryChanged() {assert.ok(libraryChannel); return libraryChannel.onmessage?.({data: {kind: 'changed'}});},
    logoutNotice(ids: string[]) {for (const listener of noticeListeners) listener({kind: 'logout', ids});},
    changeAccount(next: LibrarySession | null) {accountSession = next; for (const listener of accountListeners) listener();},
    async submit(input: BirthSubmission) {
      const pending = birthOptions.submitChart?.(input, new AbortController().signal);
      assert.ok(pending, 'the actual form has its server submission port connected');
      const result = await pending; birthOptions.onSave(result.id, {metadataOnly: result.metadataOnly}); return result;
    }, camera, workspace, panels, timelineKinds, performanceOptions,
    get knowledgeLoads() { return knowledgeLoads; }, showKnowledgeSelection: (selection: Parameters<NonNullable<typeof knowledgeOptions.onSelect>>[0]) => knowledgeOptions.onSelect!(selection), resize(width: number, height: number) { Object.assign(dimensions!, { width, height }); resizeLayout(); flushResizeFrames(); }, notifyResize: () => resizeLayout(), flushResizeFrames, select(id: string) {
      const button = { dataset: { chartId: id } };
      document.dispatch('click', { target: { closest: (selector: string) => selector === '[data-chart-id]' ? button : null } });
    }, get shown() { return graph.getChart() as ChartComposition; }, get renders() { return renders; }, get lifetime() { return lifetime; }, get loads() { return loads; }, get stateLoads() { return stateLoads; },
    get interruptions() { return interruptions; }, get captionUpdates() { return captionUpdates; },
    filter: (id: string) => gestures.onSelect!({ type: 'planet-filter' as const, id }),
    failModule, get reloads() { return reloads; }, get natalDay() { return natalDay; },
    get lifetimeOptions() { return lifetimeOptions; },
    get returnsViewOptions() { return returnsViewOptions; }, get returnsViewState() { return returnsViewState; },
    get transitNowRequests() { return transitNowRequests; },get transitStarts(){return transitStarts;},
    get activationHoverClears() { return activationHoverClears; },
    get lifetimeStateOptions() { return lifetimeStateOptions; },
    get returns() { return returns; }, get dayRequests() { return dayRequests; }, get chartSelections() { return chartSelections; },
    clockTick(timeline?: ReturnType<typeof createLocalDayTimeline>) { transitOptions.onStateChange!({ wanted: false, timeline } as Parameters<NonNullable<typeof transitOptions.onStateChange>>[0]); },
    edit() { birthOptions.beforeOpen!(); },
    saveChart(chart: TestChart, options?: Parameters<NonNullable<typeof birthOptions.onSave>>[1]) {
      charts = fixtureStore.charts = [...charts.filter(previous => previous.id !== chart.id), chart];
      birthOptions.onSave(chart.id, options);
    },
    editChart(id: string) {editedId=id;},
    get editedId() {return editedId;},
    removeChart(id: string) {
      const action = { dataset: { chartAction: 'delete', actionChartId: id }, closest: (selector: string) => selector === 'details' ? {} : null };
      document.dispatch('click', { target: { closest: (selector: string) => selector === '[data-chart-action]' ? action : null } });
      return element('confirmDeleteChart').click();
    },
    saveMetadata(chart: TestChart) { charts = fixtureStore.charts = charts.map(previous => previous.id === chart.id ? chart : previous); birthOptions.onSave(chart.id, { metadataOnly: true }); },
    get lifetimeDisposals(){return lifetimeDisposals;},
    finishModule() { finishModule({ attachLifetimeControls(options: Parameters<typeof attachLifetimeControls>[0]) {
      lifetimeOptions = options;
      const update = (state: ReturnType<typeof createLifetimeExplorer>['state']) => { options.panel.hidden = !state.opened; };
      update(options.explorer.state);
      return { dispose(){lifetimeDisposals++;}, update, refreshMoment: noop, setVisibleWindow: noop, refreshTargets: noop };
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
 await h.stopApplication();await h.stopApplication();
 assert.equal(h.lifetimeDisposals,1,'the root releases its acquired controls exactly once');
});

test('explicit library and Transit navigation return a zoomed and panned camera Home before async work completes', async () => {
  const first = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const second = { ...first, id: 'second' };
  const h = harness({ charts: [first, second] });
  await tick();
  for (const id of [first.id, second.id, first.id, first.id] as const) {
    h.camera.zoomAt({ x: 320, y: 410 }, 2); h.camera.pan(-40, 25);
    assert.notDeepEqual(h.camera.getView(), h.camera.getFittedView());
    h.select(id);
    assert.equal(h.shown.id, id);
    assert.deepEqual(h.camera.getView(), h.camera.getFittedView(), 'navigation resets synchronously, including reselection');
    h.camera.zoomAt({ x: 320, y: 410 }, 1.5); h.camera.pan(-30, 20);
    const exploring = h.camera.getView();
    await tick();
    assert.deepEqual(h.camera.getView(), exploring, 'late natal-day completion must not reset a new camera gesture');
  }
  for (let click = 0; click < 2; click++) {
    h.camera.zoomAt({ x: 320, y: 410 }, 2); h.camera.pan(-40, 25);
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
    h.camera.zoomAt({ x: 320, y: 410 }, 2); h.camera.pan(-40, 25);
    const exploring = h.camera.getView();
    assert.notDeepEqual(exploring, h.camera.getFittedView());
    h.saveChart(saved, options);
    assert.deepEqual(h.shown.primary, extractChartData(saved), 'the saved numbers must replace the old data even when the record ID is unchanged');
    assert.equal(h.shown.primaryLabel, saved.name);
    assert.deepEqual(h.camera.getView(), home ? h.camera.getFittedView() : exploring,
      home ? 'opening another saved chart resets immediately' : 'updating the current chart preserves the camera');
    h.camera.zoomAt({ x: 320, y: 410 }, 1.2); h.camera.pan(-10, 15);
    const afterSave = h.camera.getView();
    await tick();
    assert.deepEqual(h.camera.getView(), afterSave, 'late preparation must not reset a gesture made after saving');
  });
});

test('deleting the selected chart uses Home for the automatically opened fallback', async t => {
  const selected = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const remaining = { ...selected, id: 'remaining' };
  for (const { name, charts, fallback } of [
    { name: 'another saved chart remains', charts: [selected, remaining], fallback: 'current-transit' },
    { name: 'the last saved chart returns to Transit', charts: [selected], fallback: 'current-transit' },
  ] as const) await t.test(name, async () => {
    const h = harness({ charts });
    await tick(); h.select(selected.id); await tick();
    h.camera.zoomAt({ x: 320, y: 410 }, 2); h.camera.pan(-40, 25);
    assert.notDeepEqual(h.camera.getView(), h.camera.getFittedView());
    await h.removeChart(selected.id);
    assert.equal(h.element('deleteChartError').textContent!, '');
    assert.equal(h.element('deleteChartDialog').open, false);
    assert.equal(h.shown.id, fallback);
    assert.deepEqual(h.camera.getView(), h.camera.getFittedView(), 'opening the fallback resets the camera');
    h.camera.zoomAt({ x: 320, y: 410 }, 1.2); h.camera.pan(-10, 15);
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
  h.camera.zoomAt({ x: 320, y: 410 }, 2); h.camera.pan(-40, 25);
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
  h.camera.zoomAt({ x: 320, y: 410 }, 2); h.camera.pan(-40, 25);
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
  assert.equal(element('studio').dataset.workspaceScreen, 'knowledge');
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
  h.camera.zoomAt({ x: 320, y: 410 }, 2); h.camera.pan(-40, 25); h.panels.setRight(true);
  const shown = h.shown, camera = h.camera.getView(), interrupted = h.interruptions;
  const pages = [['openKnowledge', 'knowledge', 'knowledgeDialog'], ['openAllCharts', 'charts', 'allChartsDialog'], ['openAccount', 'account', 'accountPage']];
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
  h.camera.zoomAt({ x: 320, y: 410 }, 2); h.select(chart.id);
  assert.equal(h.workspace.screen, 'chart'); assert.equal(h.shown.id, chart.id);
  assert.equal(h.element('allChartsDialog').hidden, true);
  assert.deepEqual(h.camera.getView(), h.camera.getFittedView());
  await tick(); await h.element('openAccount').click(); h.camera.zoomAt({ x: 320, y: 410 }, 2);
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
    assert.equal(h.workspace.screen, 'knowledge'); assert.equal(h.knowledgeLoads, 1);
    await h.element(button).click(); release!(); await opening; await tick();
    assert.equal(h.workspace.screen, screen); assert.equal(h.element('studio').dataset.workspaceScreen, screen);
    assert.equal(h.element('knowledgeDialog').hidden, true);
    assert.equal(h.element('openKnowledge').getAttribute('aria-current'), null);
    assert.equal(h.element('openKnowledge').getAttribute('aria-busy'), null);
    await h.element('openKnowledge').click(); await tick();
    assert.equal(h.workspace.screen, 'knowledge'); assert.equal(h.element('knowledgeDialog').hidden, false);
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
  await tick(); finishRestore!(true); await tick();
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
  const h = harness({ savedView: { workspace: 'knowledge' }, restore: () => new Promise(() => {}),
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


for (const screen of ['chart', 'knowledge', 'charts'] as const) test(`closing a restoring chronicle releases the initial screen and retains ${screen} after module arrival`, async () => {
  const chart = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const lifetime = { opened: true as const, mode: 'lifetime' as const, fromDate: '2026-09-24', toDate: '2126-09-24', personalPreview: false };
  const h = harness({ realViewSession: true, charts: [chart], chartsReady: async () => true,
    savedView: { selectedId: chart.id, lifetime },
    initialPresentation: studioPresentation({ personalAvailable: true, lifetime, returnsEnabled: true }) });
  await tick();
  assert.equal(h.loads, 1, 'real restoration has started loading the chronicle module');
  assert.equal(h.element('lifetimeToggle').getAttribute('aria-busy'), 'true');
  assert.equal(h.element('shell').dataset.pageState, 'loading');

  await h.element('lifetimeToggle').click();
  await tick();
  assert.equal(h.element('lifetimeToggle').getAttribute('aria-pressed'), 'false');
  assert.equal(h.element('shell').dataset.pageState, 'loading');
  if (screen !== 'chart') {
    await h.element(screen === 'knowledge' ? 'openKnowledge' : 'openAllCharts').click(); await tick();
    assert.equal(h.workspace.screen, screen);
    assert.equal(h.element('shell').dataset.pageState, 'ready', 'an auxiliary screen does not wait for the hidden chronicle');
  }
  h.finishModule(); await tick();

  assert.equal(h.element('shell').dataset.pageState, 'ready', 'module completion must release the initial screen without another action');
  assert.equal(h.element('shell').getAttribute('aria-busy'), 'false');
  assert.equal(h.element('mainNavigation').inert, false);
  assert.equal(h.workspace.screen, screen, 'late module completion preserves the selected screen');
  assert.equal(h.shown.id, chart.id);
  assert.equal(h.lifetime.state.opened, false, 'the interrupted restore must not reopen the chronicle');
  assert.equal(h.element('lifetimeToggle').getAttribute('aria-busy'), null);
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
  await tick(); finishRestore!(true); await tick();
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
  await tick(); finishRestore!(true); await tick();
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
  await tick(); finish!(false); await tick();
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
  const knowledge = harness({ savedView: { workspace: 'knowledge' }, loadKnowledge: async () => { throw new Error('missing module'); },
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
  await tick(); finish!(false); await tick();
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
      ['openKnowledge', 'knowledge', 'knowledgeDialog'],
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


async function openedReturnsHarness(width: number, navigationOpen = false, getReturn?: HarnessOptions['getReturn']) {
  const chart = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  const event = { id: 'saturn:2050-01-01T12:00:29.432Z', body: 'saturn', utc: '2050-01-01T12:00:29.432Z', cycle: 1 };
  const exact = { ...chart, id: 'exact-return', utc: event.utc };
  const transit = { ...chart, id: 'current-transit', source: 'transit' as const, utc: '2028-01-01T12:00:00Z' };
  const h = harness({ realSummary: true, studioSize: { width, height: 844 }, charts: [chart, transit],
    returnEvents: [event], getReturn: getReturn || (async () => ({ event, chart: exact })) });
  await tick(); h.select(chart.id); await tick();
  await h.element('lifetimeToggle').click(); h.finishModule(); await tick();
  await h.element('summarySwitch').click();
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


for (const width of [390, 1400]) for (const reopenBeforeResult of [false, true]) {
  test(`closing the right shell retains pending Returns work at width ${width} (reopen early: ${reopenBeforeResult})`, async () => {
    let signal: AbortSignal | undefined, finish: ((value: Awaited<ReturnType<NonNullable<HarnessOptions['getReturn']>>>) => void) | undefined;
    const { h, event, exact } = await openedReturnsHarness(width, false, (_input, currentSignal) => {
      signal = currentSignal; return new Promise(done => { finish = done; });
    });
    const selecting = h.returnsViewOptions.onSelect(event.id); await tick();
    assert.equal(h.returns.state.loadingChart, true);
    assert.ok(signal); assert.equal(signal.aborted, false);
    await h.element('summarySwitch').click();
    assert.equal(h.panels.right, false);
    assert.equal(h.returns.opened, true);
    assert.equal(signal.aborted, false, 'closing the shell does not cancel its active instrument');
    assert.equal(h.returns.state.loadingChart, true);
    if (reopenBeforeResult) await h.element('summarySwitch').click();
    finish!({ event, chart: exact }); await selecting; await tick();
    assert.equal(h.returns.state.selectedEvent?.id, event.id);
    assert.deepEqual(h.shown.secondary, extractChartData(exact));
    assert.equal(h.panels.right, reopenBeforeResult, 'a late result cannot reopen a closed shell');
    if (!reopenBeforeResult) await h.element('summarySwitch').click();
    assert.equal(h.element('chartSummary').dataset.screen, 'returns');
    assert.equal(h.returns.opened, true);
    assert.equal(h.returnsViewState?.visible, true);
  });
}

test('Back explicitly closes Returns and cancels its pending exact work while retaining the shell', async () => {
  let signal: AbortSignal | undefined, finish: ((value: Awaited<ReturnType<NonNullable<HarnessOptions['getReturn']>>>) => void) | undefined;
  const { h, event, exact } = await openedReturnsHarness(390, false, (_input, currentSignal) => {
    signal = currentSignal; return new Promise(done => { finish = done; });
  });
  const selecting = h.returnsViewOptions.onSelect(event.id); await tick();
  assert.ok(signal); assert.equal(signal.aborted, false);
  h.returnsViewOptions.onBack();
  assert.equal(signal.aborted, true);
  assert.equal(h.returns.opened, false);
  assert.equal(h.returns.state.loadingChart, false);
  assert.equal(h.panels.right, true);
  assert.equal(h.element('chartSummary').dataset.screen, 'summary');
  finish!({ event, chart: exact }); await selecting;
  assert.equal(h.returns.state.selectedEvent, null, 'the canceled result cannot restore the closed instrument');
});


test('the existing birth form creates an account chart through one command and displays the separately read record', async () => {
  const record = accountNatalChart(); let writes = 0, reads = 0;
  const client = {
    async create(input) { writes++; return {...input, outcome: {kind: 'created', chartId: record.id, revision: record.revision}}; },
    async own() { reads++; return {chart:record,catalogMarker:'1'}; },
    async catalog(input){return catalogPage([],input.expectedAccountId);},
  } satisfies Partial<ChartClient>;
  const h = harness({chartClient: client, accountSession: {accountId: record.accountId, sessionId: 'real'}});
  await tick();
  await h.submit({name: record.name, note: record.note, birth: {source: 'calculated', date: '2000-01-01', time: '12:00', cityId: '1'}});
  assert.equal(writes, 1); assert.equal(reads, 1);
  assert.equal(h.shown.id, record.id);
});


test('the connected form recovers an unknown save by lookup without repeating its command', async () => {
  const record = accountNatalChart(); let writes = 0, reads = 0;
  const client = {
    async create() {writes++; throw Object.assign(new Error('lost response'), {code: 'connection_failed'});},
    async outcome(input) {reads++; return {...input, outcome: {kind: 'created', chartId: record.id, revision: record.revision}};},
    async own() {return {chart:record,catalogMarker:'1'};},
    async catalog(input){return catalogPage([],input.expectedAccountId);},
  } satisfies Partial<ChartClient>;
  const h = harness({realViewSession: true, chartClient: client, accountSession: {accountId: record.accountId, sessionId: 'real'}});
  await tick();
  const input = {name: record.name, note: record.note, birth: {source: 'calculated' as const, date: '2000-01-01', time: '12:00', cityId: '1'}};
  await assert.rejects(h.submit(input), {code: 'write_unknown'});
  assert.equal(h.pendingWrites?.length, 1);
  await h.submit(input);
  assert.equal(writes, 1); assert.equal(reads, 1); assert.deepEqual(h.pendingWrites, []);
  assert.equal(h.shown.id, record.id);
});

test('restored pending commands are read after sign-in without recreating their write', async () => {
  const record = accountNatalChart(); let reads = 0;
  const client = {
    async create() {assert.fail('restoration cannot resend a write');},
    async outcome(input) {reads++; return {...input, outcome: {kind: 'created', chartId: record.id, revision: record.revision}};},
    async own() {return {chart:record,catalogMarker:'1'};},
    async catalog(input){return catalogPage([],input.expectedAccountId);},
  } satisfies Partial<ChartClient>;
  const h = harness({chartClient: client, accountSession: {accountId: record.accountId, sessionId: 'real'},
    savedView: {pendingChartWrites: [{operationId: 'a'.repeat(32), expectedAccountId: record.accountId}]}});
  await tick(); assert.equal(reads, 1); assert.equal(h.cards[0]?.id, record.id);
});


test('a delayed logout notice for account A cannot clear the visible library of account B', async () => {
  const record = accountNatalChart(2, '2');
  const client = {
    async own() {return {chart:record,catalogMarker:'1'};},
    async catalog(input){return catalogPage([record],input.expectedAccountId);},
  } satisfies Partial<ChartClient>;
  const h = harness({chartClient: client, accountSession: {accountId: '2', sessionId: 'session-B'}});
  await tick(); assert.equal(h.rows[0]?.id, record.id);
  h.logoutNotice(['session-A']); await tick();
  assert.equal(h.rows[0]?.id, record.id);
});


test('a confirmed library update from another tab refreshes the current chart metadata', async t => {
  const indexedDB = new IDBFactory(), local = createAccountLibraryStore({indexedDB}), other = createAccountLibraryStore({indexedDB});
  t.after(() => {local.close(); other.close();});
  const record = accountNatalChart(); const lease = await local.activate(record.accountId); assert.equal(lease.status, 'stored');
  await local.put(lease.lease, [record]);
  const client = {
    async own() {return {chart:record,catalogMarker:'1'};},
    async catalog(input){return catalogPage([record],input.expectedAccountId);},
  } satisfies Partial<ChartClient>;
  const h = harness({libraryStorage: local, realViewSession: true, chartClient: client,
    accountSession: {accountId: record.accountId, sessionId: 'real'}, savedView: {selectedId: record.id}});
  await h.restoration;await waitForLibraryCheck(local,record.accountId);
  assert.equal(h.element('shell').dataset.pageState, 'ready');
  const latest = {...record, revision: 2, name: 'Обновлённое имя'};
  await other.put((await other.read())!.lease!, [latest]); await h.libraryChanged(); await tick();
  assert.equal(h.cards[0]?.name, latest.name);
  assert.equal(h.element('chartTitle').textContent, latest.name);
});


function addressHarness(pathname: string) {
 const location = {pathname}, events = new EventTarget(), writes: string[] = [];
 const history = {pushState(_data:unknown,_title:string,path?:string|URL|null){location.pathname=String(path);writes.push('push:'+path);},
   replaceState(_data:unknown,_title:string,path?:string|URL|null){location.pathname=String(path);writes.push('replace:'+path);}};
 const navigation = createNavigation({location,history,events});
 return {navigation,location,writes,backTo(path:string){location.pathname=path;events.dispatchEvent(new Event('popstate'));}};
}
test('direct account address overrides a saved different screen and back/forward applies the same owner', async () => {
 const n=addressHarness('/account'), h=harness({navigation:n.navigation, realViewSession:true,savedView:{workspace:'charts',selectedId:'current-transit'}});
 await tick();
 assert.equal(h.workspace.screen,'account');
 n.backTo('/library');await tick();assert.equal(h.workspace.screen,'knowledge');
 n.backTo('/');await tick();assert.equal(h.workspace.screen,'chart');
 assert.equal(h.shown.id,'current-transit');assert.deepEqual(n.writes,[]);
});
test('accepted server save replaces the temporary address without adding a history entry', async () => {
 const n=addressHarness('/chart'), record=accountNatalChart(), access={accountId:'1',sessionId:'session-one'};
 const client={async create(input){return {...input,outcome:{kind:'created',chartId:record.id,revision:record.revision}};},
  async own(){return {chart:record,catalogMarker:'1'};},async catalog(input){return catalogPage([],input.expectedAccountId);}} satisfies Partial<ChartClient>;
 const h=harness({navigation:n.navigation,accountSession:access,chartClient:client});await tick();
 await h.submit({name:record.name,note:'',birth:{source:'calculated',date:'2000-01-01',time:'12:00',cityId:'1'}} as BirthSubmission);
 assert.equal(n.location.pathname,'/chart/'+record.id);assert.deepEqual(n.writes,['replace:/chart/'+record.id]);
});


test('a direct shared chart is read separately and never added to the private library', async () => {
 const record=accountNatalChart(), {accountId,note,noteRevision,publicRevision,...publicRecord}=record;
 const n=addressHarness('/chart/'+record.id);let reads=0;
 const client={async public(id:string){reads++;assert.equal(id,record.id);return publicRecord;}} satisfies Partial<ChartClient>;
 const h=harness({navigation:n.navigation,chartClient:client,realViewSession:true,
  savedView:{selectedId:'current-transit',workspace:'account'}});
 await tick();await tick();
 assert.equal(h.shown.id,record.id);assert.equal(h.workspace.screen,'chart');assert.equal(reads,1);assert.deepEqual(h.cards,[]);
});
test('a late public chart cannot replace a newer address', async () => {
 const record=accountNatalChart(), {accountId,note,noteRevision,publicRevision,...publicRecord}=record;
 let finish!:(value:typeof publicRecord)=>void;
 const n=addressHarness('/account'), client={public:()=>new Promise(resolve=>{finish=resolve;})} satisfies Partial<ChartClient>;
 const h=harness({navigation:n.navigation,chartClient:client,realViewSession:true});
 await tick();n.backTo('/chart/'+record.id);await tick();n.backTo('/');await tick();
 finish(publicRecord);await tick();
 assert.equal(h.shown.id,'current-transit');assert.equal(h.workspace.screen,'chart');assert.deepEqual(h.cards,[]);
});


test('cold shared-chart restoration cannot override a newer account address', async () => {
 const record=accountNatalChart(), {accountId,note,noteRevision,publicRevision,...publicRecord}=record;
 let finish!:(value:typeof publicRecord)=>void;
 const n=addressHarness('/chart/'+record.id), client={public:()=>new Promise(resolve=>{finish=resolve;})} satisfies Partial<ChartClient>;
 const h=harness({navigation:n.navigation,chartClient:client,realViewSession:true});
 await tick();n.backTo('/account');await tick();finish(publicRecord);await tick();await tick();
 assert.equal(h.workspace.screen,'account');assert.equal(n.location.pathname,'/account');
});
test('an account change cancels a pending chart URL read and checks access again', async t => {
 const record=accountNatalChart(), {accountId,note,noteRevision,publicRevision,...publicRecord}=record;
 const n=addressHarness('/chart/'+record.id);
 let finish!:(value:typeof publicRecord)=>void, oldSignal:AbortSignal|undefined, reads=0;
 const client={
  async catalog(input){return catalogPage([],input.expectedAccountId);},
  public(_id:string,signal?:AbortSignal){
   if(++reads===1){oldSignal=signal;return new Promise<typeof publicRecord>(resolve=>{finish=resolve;});}
   return Promise.reject(Object.assign(new Error('private to the previous account'),{code:'not_found',status:404}));
  },
 } satisfies Partial<ChartClient>;
 const store=createChartStore({});store.projectLibrary([],false);
 const h=harness({actualStore:store,navigation:n.navigation,chartClient:client,realViewSession:true,
  accountSession:{accountId:'1',sessionId:'old'},});
 t.after(async()=>{finish?.(publicRecord);await h.stopApplication();n.navigation.destroy();});
 await waitForOwnLink(()=>reads===1);
 h.changeAccount({accountId:'2',sessionId:'new'});
 assert.equal(oldSignal?.aborted,true,'the old account loses its read immediately');
 await h.restoration;await tick();
 assert.equal(reads,2,'only the replacement read checks access with the new account');
 assert.equal(n.location.pathname,'/');assert.equal(h.shown.id,'current-transit');
 finish(publicRecord);await tick();h.flushView();
 assert.equal(store.publicChart,null);assert.equal(h.savedSnapshot?.publicChart??null,null);
 assert.equal(h.shown.id,'current-transit');assert.equal(n.location.pathname,'/');
});
test('returning to the temporary address uses this tab current temporary chart', async () => {
 const n=addressHarness('/'), record={...accountNatalChart(92),id:'temporary-one',name:'Temporary',createdAt:'',updatedAt:''};
 const actualStore=createChartStore({initialTemporaryChart:record});
 const h=harness({actualStore,navigation:n.navigation,savedView:{selectedId:'current-transit'},realViewSession:true});
 await tick();h.select(record.id);await tick();assert.equal(n.location.pathname,'/chart');
 await h.element('openAccount').click();n.backTo('/chart');await tick();
 assert.equal(h.shown.id,record.id);
});


test('retry after a shared chart read failure retries the current route', async () => {
 const record=accountNatalChart(), {accountId,note,noteRevision,publicRevision,...publicRecord}=record;
 let reads=0;const n=addressHarness('/chart/'+record.id);
 const client={async public(){if(++reads===1)throw new Error('offline');return publicRecord;}} satisfies Partial<ChartClient>;
 const h=harness({navigation:n.navigation,chartClient:client,realViewSession:true});
 await tick();assert.equal(h.loading.failed,true);h.retryLoading();await tick();
 assert.equal(reads,2);assert.equal(Boolean(h.loading.failed),false);assert.equal(h.shown.id,record.id);
});
test('a menu selection clears loading of a superseded shared-chart request', async () => {
 const record=accountNatalChart(), {accountId,note,noteRevision,publicRevision,...publicRecord}=record;
 let finish!:(value:typeof publicRecord)=>void;
 const n=addressHarness('/account'), temporary={...personalChartFixture(),id:'temporary-one',name:'Temporary'};
 const client={public:()=>new Promise(resolve=>{finish=resolve;})} satisfies Partial<ChartClient>;
 const h=harness({navigation:n.navigation,chartClient:client,charts:[temporary],realViewSession:true});
 await tick();n.backTo('/chart/'+record.id);await tick();h.select(temporary.id);await tick();
 assert.equal(h.loading.hasChart,true);assert.equal(Boolean(h.loading.loading),false);
 finish(publicRecord);await tick();assert.equal(h.shown.id,temporary.id);assert.equal(Boolean(h.loading.loading),false);
});
test('logout and account change revoke private calculation clients; an old logout does not revoke the new account', async () => {
 let resets=0;const record=accountNatalChart();
 const client={async catalog(input){return catalogPage([],input.expectedAccountId);}} satisfies Partial<ChartClient>;
 const h=harness({chartClient:client,accountSession:{accountId:'1',sessionId:'one'},onPersonalReset:()=>{resets++;}});
 await tick();h.changeAccount({accountId:'2',sessionId:'two'});assert.equal(resets,1);await tick();
 h.logoutNotice(['one']);assert.equal(resets,1);
 h.logoutNotice(['two']);assert.equal(resets,2);
});


function deletionClient(record: ReturnType<typeof accountNatalChart>, overrides: Partial<ChartClient> = {}) {
  return {
    async catalog(input){return catalogPage([{...record}],input.expectedAccountId);},
    async own() {return {chart:record,catalogMarker:'1'};}, ...overrides,
  } satisfies Partial<ChartClient>;
}
test('account deletion waits for server confirmation, then removes the library record and replaces its route', async () => {
  const record=accountNatalChart(), n=addressHarness('/'), writes: string[]=[];
  let finish!: (value: unknown) => void;
  const client=deletionClient(record,{remove: input => {writes.push(input.chartId);return new Promise(resolve=>{finish=()=>resolve({...input,catalogMarker:'2',outcome:{kind:'deleted',chartId:input.chartId}});});}});
  const h=harness({navigation:n.navigation,chartClient:client,accountSession:{accountId:record.accountId,sessionId:'one'}});
  await tick();h.select(record.id);await tick();
  const removing=h.removeChart(record.id);await tick();
  assert.deepEqual(writes,[record.id]);assert.equal(h.cards.length,1);assert.equal(h.element('deleteChartDialog').open,true);
  await h.element('confirmDeleteChart').click();assert.equal(writes.length,1);
  finish(null);await removing;await tick();
  assert.equal(h.cards.length,0);assert.equal(h.shown.id,'current-transit');assert.equal(n.location.pathname,'/');
  assert.equal(h.element('deleteChartDialog').open,false);
});
test('a lost delete response is recovered by lookup and never by a second delete', async () => {
  const record=accountNatalChart();let writes=0,reads=0;
  const client=deletionClient(record,{
    async remove(){writes++;throw Object.assign(new Error('lost'),{code:'connection_failed'});},
    async outcome(input){reads++;return {...input,catalogMarker:'2',outcome:{kind:'deleted',chartId:record.id}};},
  });
  const h=harness({chartClient:client,accountSession:{accountId:record.accountId,sessionId:'one'}});
  await tick();h.select(record.id);await tick();await h.removeChart(record.id);await tick();
  assert.equal(writes,1);assert.equal(reads,1);assert.equal(h.cards.length,0);assert.equal(h.shown.id,'current-transit');
});
test('logout closes the delete dialog and a late result cannot change the new account', async () => {
  const record=accountNatalChart();let finish!:()=>void;
  const client=deletionClient(record,{remove: input=>new Promise(resolve=>{finish=()=>resolve({...input,catalogMarker:'2',outcome:{kind:'deleted',chartId:record.id}});})});
  const h=harness({chartClient:client,accountSession:{accountId:record.accountId,sessionId:'one'}});
  await tick();const pending=h.removeChart(record.id);await tick();
  h.logoutNotice(['one']);assert.equal(h.element('deleteChartDialog').open,false);
  h.changeAccount({accountId:'2',sessionId:'two'});await tick();
  finish();await pending;await tick();assert.equal(h.element('deleteChartDialog').open,false);
});
test('a confirmed deletion of the edited record closes its draft and immediately leaves another chart for transit', async () => {
  const record=accountNatalChart(), other=accountNatalChart(2,record.accountId), n=addressHarness('/');
  const client=deletionClient(record,{
    async catalog(input){return catalogPage([record,other].map(c=>({...c})),input.expectedAccountId);},
    async own(input){return {chart:input.chartId===record.id?record:other,catalogMarker:'1'};},
    async remove(input){return {...input,catalogMarker:'2',outcome:{kind:'deleted',chartId:input.chartId}};},
  });
  const h=harness({navigation:n.navigation,chartClient:client,accountSession:{accountId:record.accountId,sessionId:'one'}});
  await tick();h.select(other.id);await tick();h.editChart(record.id);
  await h.removeChart(record.id);await tick();
  assert.equal(h.editedId,null);assert.equal(h.shown.id,'current-transit');assert.equal(n.location.pathname,'/');
});

test('losing the network during connected server deletion keeps its dialog and shows the accepted offline state',async t=>{
  let mode:'online'|'offline'='online';const listeners=new Set<(mode:'online'|'offline')=>void>();
  const connection: ConnectionSource = {get current(){return mode;},subscribe(fn){listeners.add(fn);return ()=>{listeners.delete(fn);};}};

  const record=accountNatalChart();let finish!:()=>void;
  const client=deletionClient(record,{remove:input=>new Promise(resolve=>{finish=()=>resolve({...input,catalogMarker:'2',outcome:{kind:'deleted',chartId:record.id}});})});
  const h=harness({connection,chartClient:client,accountSession:{accountId:record.accountId,sessionId:'one'}});
  await tick();const pending=h.removeChart(record.id);await tick();
  try {
    mode='offline';for(const listener of listeners)listener(mode);
    assert.equal(h.element('deleteChartDialog').open,true);
    assert.equal(h.element('deleteChartError').children[0]?.textContent,UI_MESSAGES.offline);
  } finally {finish();await pending;}
});


test('diagnostic scope follows access changes and only the matching explicit logout clears reports',async()=>{
 const accounts:(string|null)[]=[],record=accountNatalChart();let exits=0;
 const journal={setAccount(id:string|null){accounts.push(id);},leave(){exits++;},wake(){},
  begin(){return{step(){},finishSuccess(){},reportFailure:async()=>null,reportRecovery:async()=>null,reportError:async()=>null};}};
 const h=harness({journal,accountSession:{accountId:'1',sessionId:'one'},chartClient:{async catalog(input){return catalogPage([],input.expectedAccountId);}}});
 await tick();assert.equal(accounts.at(-1),'1');
 h.changeAccount(null);assert.equal(accounts.at(-1),null);assert.equal(exits,0);
 h.changeAccount({accountId:'2',sessionId:'two'});assert.equal(accounts.at(-1),'2');
 h.logoutNotice(['one']);assert.equal(exits,0);
 h.logoutNotice(['two']);assert.equal(exits,1);
});

test('an unknown save outcome reaches the diagnostic owner without changing write recovery',async()=>{
 const record=accountNatalChart(),seen:{action:unknown;code:unknown;stage:unknown}[]=[];
 const journal={setAccount(){},leave(){},wake(){},begin(action:unknown){return{step(){},finishSuccess(){},
  reportFailure:async()=>null,reportRecovery:async()=>null,
  async reportError(error:unknown,step:{stage:unknown}){seen.push({action,code:(error as {code?:string}).code,stage:step.stage});return null;}};}};
 let writes=0;const client=deletionClient(record,{create:async()=>{writes++;throw Object.assign(new Error('private transport details'),{code:'connection_failed'});},
  outcome:async input=>({...input,outcome:{kind:'unknown'}})});
 const h=harness({journal,chartClient:client,accountSession:{accountId:record.accountId,sessionId:'one'}});await tick();
 await assert.rejects(h.submit({name:'PRIVATE name',note:'PRIVATE note',birth:{source:'calculated',date:'2000-01-01',time:'12:00',cityId:'1'}}),error=>(error as {code?:string}).code==='write_unknown');
 assert.equal(writes,1);assert.equal(seen.length,1);
 assert.deepEqual(seen[0],{action:{action:'chart_save',component:'chart'},code:'write_unknown',stage:'commit'});
 assert.equal(JSON.stringify(seen).includes('PRIVATE'),false);
});

function journalProbe() {
 const scopes:unknown[]=[],failures:unknown[]=[];let finishes=0;
 const journal={setAccount(id:string|null){scopes.push(['account',id]);},leave(){scopes.push(['leave']);},wake(){},
  begin(action:unknown){return {step(){},finishSuccess(){finishes++;},reportFailure:async()=>null,reportRecovery:async()=>null,
   async reportError(error:unknown,step:unknown){failures.push({action,code:(error as {code?:string}).code,step});return null;}};}};
 return {journal,scopes,failures,get finishes(){return finishes;}};
}
function emptyDiagnosticLibrary(){return {async catalog(input){return catalogPage([],input.expectedAccountId);}} satisfies Partial<ChartClient>;}

test('late journal attachment remembers expiry without converting it into a logout',async()=>{
 const h=harness({accountSession:{accountId:'1',sessionId:'one'},chartClient:emptyDiagnosticLibrary()}),probe=journalProbe();await tick();
 h.changeAccount(null);h.attachJournal(probe.journal);
 assert.deepEqual(probe.scopes,[['account','1'],['account',null]]);
 h.changeAccount({accountId:'2',sessionId:'two'});assert.deepEqual(probe.scopes.at(-1),['account','2']);
});
test('late journal attachment preserves guest login without clearing guest reports',async()=>{
 const h=harness({chartClient:emptyDiagnosticLibrary()}),probe=journalProbe();await tick();
 h.changeAccount({accountId:'1',sessionId:'one'});h.attachJournal(probe.journal);
 assert.deepEqual(probe.scopes,[['account','1']]);
});
test('late journal attachment retains a boundary even when accounts return A to B to A',async()=>{
 const h=harness({accountSession:{accountId:'1',sessionId:'one'},chartClient:emptyDiagnosticLibrary()}),probe=journalProbe();await tick();
 h.changeAccount({accountId:'2',sessionId:'two'});h.changeAccount({accountId:'1',sessionId:'new-one'});
 h.attachJournal(probe.journal);assert.deepEqual(probe.scopes,[['account','1'],['leave'],['account','1']]);
 h.attachJournal(probe.journal);assert.equal(probe.scopes.length,3);
});
test('late journal attachment applies a matching explicit logout once',async()=>{
 const h=harness({accountSession:{accountId:'1',sessionId:'one'},chartClient:emptyDiagnosticLibrary()}),probe=journalProbe();await tick();
 h.logoutNotice(['unrelated']);h.logoutNotice(['one']);h.changeAccount(null);
 h.attachJournal(probe.journal);assert.deepEqual(probe.scopes,[['account','1'],['leave'],['account',null]]);
 h.attachJournal(probe.journal);assert.equal(probe.scopes.length,3);
});
test('a failed chart address reports one controlled chart-open failure and performs no write',async()=>{
 const record=accountNatalChart(),probe=journalProbe(),n=addressHarness('/chart/'+record.id);let reads=0;
 harness({journal:probe.journal,navigation:n.navigation,chartClient:{async public(){reads++;throw Object.assign(new Error('PRIVATE route response'),{code:'invalid_response'});}}});
 await tick();await tick();
 assert.equal(reads,1);assert.deepEqual(probe.failures,[{action:{action:'chart_open',component:'chart'},code:'invalid_response',step:{stage:'request'}}]);
 assert.equal(JSON.stringify(probe.failures).includes(record.id),false);assert.equal(JSON.stringify(probe.failures).includes('PRIVATE'),false);
});
test('a superseded chart address remains silent when its rejected request arrives late',async()=>{
 const record=accountNatalChart(),probe=journalProbe(),n=addressHarness('/account');let reject!:(error:unknown)=>void;
 harness({journal:probe.journal,navigation:n.navigation,chartClient:{public:()=>new Promise((_resolve,no)=>{reject=no;})}});
 await tick();n.backTo('/chart/'+record.id);await tick();n.backTo('/account');await tick();
 reject(Object.assign(new Error('PRIVATE old response'),{code:'server_error'}));await tick();
 assert.deepEqual(probe.failures,[]);assert.equal(probe.finishes,1);
});


test('a committed reply after leaving the chart enters the library without late navigation',async()=>{
  const {accountId,revision,noteRevision,publicRevision,...prepared}=accountNatalChart(40);
  const temporary={...prepared,id:'temporary-row',createdAt:'',updatedAt:''},own=accountNatalChart(41);
  const store=createChartStore({initialTemporaryChart:temporary});store.projectLibrary([],false);
  let finish!:()=>void,writes=0;
  const h=harness({actualStore:store,realViewSession:true,navigation:addressHarness('/chart').navigation,
    accountSession:{accountId:'1',sessionId:'late-write'},savedView:{selectedId:temporary.id,temporaryChart:store.temporaryChart},chartClient:{
      async catalog(input){return catalogPage([],input.expectedAccountId);},async own(){return {chart:own,catalogMarker:'1'};},
      async create(input){writes++;return new Promise(resolve=>{finish=()=>resolve({...input,outcome:{kind:'created',chartId:own.id,revision:1},chart:own});});},
    }});
  await h.restoration;const saving=h.saveShown();await tick();assert.equal(writes,1);
  assert.equal(await h.prepareOfflineUpdate(),false,'an active write blocks a release transition');
  await h.element('openKnowledge').click();finish();await saving;await tick();
  assert.ok(store.get(own.id),'a valid committed reply still reaches the current account library');
  assert.equal(h.workspace.screen,'knowledge');assert.equal(h.shown.id,temporary.id);
  assert.equal(writes,1);
});

for (const signedIn of [false,true]) test(`an explicitly saved temporary card first enters the visible list ${signedIn?'while signed in':'after login'}`,async()=>{
  const {accountId:_account,revision:_revision,noteRevision:_note,publicRevision:_public,...prepared}=accountNatalChart(40);
  const temporary={...prepared,id:'temporary-row',calculationReceipt:'signed-calculation',createdAt:'',updatedAt:''};
  const own={...prepared,id:chartId(41),accountId:'1',revision:1,noteRevision:1,publicRevision:1};
  const store=createChartStore({initialTemporaryChart:temporary});
  store.projectLibrary([],false);
  const access={accountId:'1',sessionId:'row-login'};let writes=0;
  const h=harness({actualStore:store,realViewSession:true,navigation:addressHarness('/chart').navigation,
    accountSession:signedIn?access:null,savedView:{selectedId:temporary.id,temporaryChart:store.temporaryChart},chartClient:{
      async catalog(input){return catalogPage([],input.expectedAccountId);},
      async create(input){writes++;return {...input,outcome:{kind:'created',chartId:own.id,revision:1}};},
      async own(){return {chart:own,catalogMarker:'1'};}
    }});
  await h.restoration;
  await h.element('openLibrary').click();
  const visibleIds=()=>h.element('chartList').children.map(row=>row.innerHTML.match(/data-chart-id="([^"]+)"/)?.[1]);
  assert.deepEqual(visibleIds(),[]);
  assert.equal(h.shown.id,temporary.id);
  await h.saveShown();
  if(!signedIn){assert.equal(h.workspace.screen,'account');assert.equal(writes,0);h.changeAccount(access);}
  await waitForOwnLink(()=>store.temporaryChart===null);
  assert.equal(store.temporaryChart,null);
  assert.equal(writes,1);assert.equal(h.shown.id,own.id);
  assert.deepEqual(visibleIds(),[own.id],'the rendered list must not need hover, another click or reopening');
  assert.equal(h.element('libraryCount').textContent,'1');
  assert.equal(h.savedSnapshot?.temporaryChart,null);
});

test('a ready temporary chart survives login and saves once with its calculation receipt',async()=>{
  const {accountId:_account,revision:_revision,noteRevision:_note,publicRevision:_public,...prepared}=accountNatalChart(40);
  const source={...prepared,id:'temporary',calculationReceipt:'signed-calculation',createdAt:'',updatedAt:''};
  const own={...source,id:chartId(41),accountId:'1',revision:1,noteRevision:1,publicRevision:1,calculationReceipt:undefined};
  let writes=0;const commands:Parameters<ChartClient['create']>[0][]=[];
  const h=harness({charts:[source],chartClient:{
    async create(input){writes++;commands.push(input);return {...input,outcome:{kind:'created',chartId:own.id,revision:1}};},
    async own(){return {chart:own,catalogMarker:'1'};},async catalog(input){return catalogPage([],input.expectedAccountId);}}});
  await tick();h.select(source.id);await tick();
  await h.saveShown();await tick();assert.equal(h.workspace.screen,'account');assert.equal(writes,0);
  h.changeAccount({accountId:'1',sessionId:'login'});await tick();await tick();
  assert.equal(writes,1);assert.equal(commands[0].calculationReceipt,'signed-calculation');
  assert.equal('activations' in commands[0],false);assert.equal(h.workspace.screen,'chart');
  assert.equal(h.shown.id,own.id);assert.ok(h.cards.some(chart=>chart.id===own.id));
});

test('the existing add control copies a shared chart after login and opens an existing own match',async()=>{
  const source={...accountNatalChart(42,'7'),note:'',createdAt:'',updatedAt:''};
  const own={...source,id:chartId(43),accountId:'1',note:'Keep my note'};let writes=0;
  const h=harness({charts:[source],chartClient:{
    async addFromSource(input){writes++;assert.equal(input.sourceId,source.id);return {...input,outcome:{kind:'existing',chartId:own.id,revision:1}};},
    async own(){return {chart:own,catalogMarker:'1'};},async catalog(input){return catalogPage([],input.expectedAccountId);}}});
  await tick();h.select(source.id);await tick();
  await h.element('saveShownChart').click();
  await tick();assert.equal(h.workspace.screen,'account');assert.equal(writes,0);
  h.changeAccount({accountId:'1',sessionId:'login'});await tick();await tick();
  assert.equal(writes,1);assert.equal(h.shown.id,own.id);assert.equal(h.cards.find(chart=>chart.id===own.id)?.note,'Keep my note');
});

for(const cancel of ['back','navigation'] as const)test(`a login completed after ${cancel} does not save the earlier chart`,async()=>{
  const source={...accountNatalChart(44,'7'),createdAt:'',updatedAt:''};let writes=0;
  const h=harness({charts:[source],chartClient:{
    async addFromSource(){writes++;assert.fail('cancelled continuation must not write');},
    async catalog(input){return catalogPage([],input.expectedAccountId);}}});
  await tick();h.select(source.id);await tick();await h.saveShown();
  if(cancel==='back')await h.element('accountPage').dispatch('click',{target:{closest:()=>({disabled:false,dataset:{accountAction:'back'}})}});
  else await h.element('openKnowledge').click();
  h.changeAccount({accountId:'1',sessionId:'late'});await tick();await tick();assert.equal(writes,0);
});


for(const tool of ['day','return'] as const)test(`saving after login preserves the open ${tool} and its prepared data`,async()=>{
  const chart={...accountNatalChart(46,'7'),...libraryRecordAtMinute(natalDayFixture(),754,personalChartFixture()),id:chartId(46)};
  const own={...chart,id:chartId(47),accountId:'1',note:'My note'};
  const event={id:'saturn:2050-01-01T12:00:29.432Z',body:'saturn',utc:'2050-01-01T12:00:29.432Z',cycle:1};
  const exact={...chart,id:'exact-return',utc:event.utc};let returnRequests=0;
  const h=harness({charts:[chart],returnEvents:[event],getReturn:async()=>{returnRequests++;return {event,chart:exact};},chartClient:{
    async addFromSource(input){return {...input,outcome:{kind:'created',chartId:own.id,revision:1}};},
    async own(){return {chart:own,catalogMarker:'1'};},async catalog(input){return catalogPage([],input.expectedAccountId);}}});
  await tick();h.select(chart.id);await tick();
  if(tool==='day')h.natalDay.scrub(800);
  else {await h.element('lifetimeToggle').click();h.finishModule();await tick();await h.returns.selectEvent(event.id);await h.returns.setBodies(['venus']);}
  const shown=h.shown,dayRequests=h.dayRequests,selections=h.chartSelections,packet=h.natalDay.state.day;
  await h.saveShown();await tick();assert.equal(h.workspace.screen,'account');
  h.changeAccount({accountId:'1',sessionId:'login'});await tick();await tick();
  assert.equal(h.workspace.screen,'chart');assert.equal(h.shown.id,tool==='day'?own.id:own.id+':cycle:'+event.id);
  assert.equal(h.shown.primary,shown.primary);assert.equal(h.shown.secondary,shown.secondary);assert.equal(h.shown.utc,shown.utc);
  assert.equal(h.dayRequests,dayRequests);assert.equal(h.chartSelections,selections);
  if(tool==='day'){assert.equal(h.natalDay.state.opened,true);assert.equal(h.natalDay.state.index,800);assert.equal(h.natalDay.state.day,packet);}
  else {assert.equal(h.returns.state.selectedEvent,event);assert.deepEqual(h.returns.state.bodies,['venus']);assert.equal(returnRequests,1);}
});

test('the release add control follows the real source and disappears once the saved card is adopted',async()=>{
  const source={...accountNatalChart(48,'7'),createdAt:'',updatedAt:''},own={...source,id:chartId(49),accountId:'1'};
  let writes=0;const h=harness({charts:[source],chartClient:{
    async addFromSource(input){writes++;return {...input,outcome:{kind:'created',chartId:own.id,revision:1}};},
    async own(){return {chart:own,catalogMarker:'1'};},async catalog(input){return catalogPage([],input.expectedAccountId);}}});
  await tick();assert.equal(h.element('saveShownChartGroup').hidden,true);
  h.select(source.id);await tick();assert.equal(h.element('saveShownChartGroup').hidden,false);
  await h.element('saveShownChart').click();await tick();assert.equal(h.workspace.screen,'account');
  h.changeAccount({accountId:'1',sessionId:'login'});await tick();await tick();
  assert.equal(writes,1);assert.equal(h.element('saveShownChartGroup').hidden,true);
});


test('late journal receives the original diagnostic proof through expiry and subsequent logout',async()=>{
 const proof=`v1.1.${'a'.repeat(32)}.${'A'.repeat(43)}`;
 const h=harness({accountSession:{accountId:'1',sessionId:'a'.repeat(32),diagnosticProof:proof},chartClient:emptyDiagnosticLibrary()});await tick();
 h.changeAccount(null);const calls:unknown[]=[];
 const probe=journalProbe();probe.journal.setAccount=(id:string|null,sessionId?:string|null,origin?:string)=>{calls.push([id,sessionId,origin]);};
 h.attachJournal(probe.journal);
 assert.deepEqual(calls,[['1','a'.repeat(32),proof],[null,undefined,undefined]]);
 h.logoutNotice(['a'.repeat(32)]);assert.deepEqual(probe.scopes,[['leave']]);
});

for(const owner of [null,'1'] as const)test(`account switch preserves only the independent draft: ${owner}`,async()=>{
 const h=harness({realViewSession:true,accountSession:{accountId:'1',sessionId:'one'},chartClient:emptyDiagnosticLibrary()});await tick();
 h.setBirthDraft({editingId:null,accountId:owner,calculationMode:'calculated',fields:{chartName:'Черновик',birthDate:'12.',birthTime:'',birthPlace:'',chartNote:''},city:null,fold:null,base:null,focus:null});
 h.changeAccount({accountId:'2',sessionId:'two'});await tick();h.flushView();
 assert.equal(h.savedBirthDraft?.fields.chartName,owner===null?'Черновик':undefined);
 if(owner===null){h.logoutNotice(['two']);h.flushView();assert.equal(h.savedBirthDraft,null);}
});


test('application composition reclaims diagnostics through its journal facade for the shared pressure owner',async t=>{
  const pressure=createStoragePressure({locks:null});
  const journal=createJournal({indexedDB:new IDBFactory(),appVersion:'0.2',environment:'stand',connection:()=> 'offline'});
  t.after(()=>journal.close());await journal.wake();
  await journal.begin({action:'calculate',component:'calculator'}).reportFailure({stage:'request',reason:'connection_failed'});
  harness({journal,storagePressure:pressure});await tick();
  let attempts=0;
  const result=await pressure.write(async()=>++attempts<=2?{status:'quota'}:{status:'complete',value:'saved'});
  assert.deepEqual(result,{status:'complete',value:'saved'});
  assert.equal(await journal.discardForSpace(),'empty');
});


for (const screen of ['account','charts','knowledge'] as const) {
  test(`restored ${screen} screen restores its input through its owner exactly once`, async () => {
    let resolve!:()=>void; const ready=new Promise<void>(done=>{resolve=done;});
    const focus={start:1,end:2,direction:'backward' as const};
    const h=harness({realViewSession:true,accountReady:ready,savedView:{version:1,workspace:screen,
      selectedId:'current-transit', account:{step:'email',email:'a@example.org',focus},
      charts:{query:'abc',searchOpen:true,focus},knowledge:{query:'abc',searchOpen:true,focus,collection:'',entryId:'',view:'catalog'}}});
    assert.deepEqual(h.inputRestores,[]);
    resolve(); await h.restoration; await tick();
    assert.deepEqual(h.inputRestores,[screen]);
    h.clockTick(); await tick();
    assert.deepEqual(h.inputRestores,[screen],'background updates cannot steal focus again');
  });
}

test('new input during account restoration prevents late focus restoration',async()=>{
  let resolve!:()=>void; const ready=new Promise<void>(done=>{resolve=done;});
  const h=harness({realViewSession:true,accountReady:ready,savedView:{version:1,workspace:'account',selectedId:'current-transit',
    account:{step:'email',email:'a@example.org',focus:{start:1,end:2,direction:'none'}}}});
  h.userInput();resolve();await h.restoration;await tick();
  assert.deepEqual(h.inputRestores,[]);
});


test('restoration holds search selection until the visible cards finish loading',async()=>{
  let resolve!:()=>void;const ready=new Promise<void>(done=>{resolve=done;});
  const focus={start:1,end:2,direction:'backward' as const};
  const h=harness({realViewSession:true,chartsReady:()=>ready,savedView:{version:1,workspace:'charts',selectedId:'current-transit',charts:{query:'abc',searchOpen:true,focus}}});
  await h.restoration;h.flushView();
  assert.deepEqual(h.savedSnapshot?.charts?.focus,focus,'a second reload while loading must not lose the pending caret');
  resolve();await tick();
  assert.deepEqual(h.inputRestores,['charts']);
});

test('an update may preserve the email field but may not discard a secret code',async()=>{
 const h=harness({realViewSession:true,savedView:{version:1,workspace:'account',selectedId:'current-transit',
   account:{step:'email',email:'a@example.org',focus:{start:1,end:2,direction:'none'}}}});
 await h.restoration;await tick();h.element('accountEmail').focus();
 assert.equal(h.prepareOfflineUpdate(),true,'email already has a supported restoration owner');
 h.element('accountCode').focus();
 assert.equal(h.prepareOfflineUpdate(),false,'verification code is not persisted');
});

test('peer an input event without key or pointer cannot restore the old email caret',async()=>{
 let resolve!:()=>void;const ready=new Promise<void>(done=>{resolve=done;});
 const h=harness({realViewSession:true,accountReady:ready,savedView:{version:1,workspace:'account',selectedId:'current-transit',
  account:{step:'email',email:'a@example.org',focus:{start:1,end:2,direction:'none'}}}});
 h.userInput('input');resolve();await h.restoration;await tick();
 assert.deepEqual(h.inputRestores,[]);
});
test('peer a pointer gesture cannot erase a lifetime text draft while its module loads',async()=>{
 const draft={fromDate:'01.',toDate:'31.12.2026',focus:{field:'fromDate' as const,start:1,end:2,direction:'none' as const}};
 const h=harness({realViewSession:true,savedView:{version:1,workspace:'chart',selectedId:'current-transit',
  lifetime:{opened:true,mode:'lifetime',fromDate:'2026-01-01',toDate:'2026-12-31'},lifetimeDraft:draft}});
 await tick();h.flushView();assert.deepEqual(h.savedSnapshot?.lifetimeDraft,draft,'before gesture the draft is still pending');
 h.userInput();h.flushView();assert.deepEqual(h.savedSnapshot?.lifetimeDraft,draft,'a pointer gesture may cancel focus but not text');
});


test('quota eviction cannot approve a reload from a RAM-only account chart, and a durable copy restores offline',async t=>{
 const indexedDB=new IDBFactory(),pressure=createStoragePressure({locks:null});
 let useTime=0;const storage=createAccountLibraryStore({indexedDB,pressure,now:()=>useTime}),record=accountNatalChart(70);
 t.after(()=>storage.close());
 const active=await storage.activate(record.accountId);assert.equal(active.status,'stored');if(active.status!=='stored')return;
 await storage.put(active.lease,[record]);
 const h=harness({storagePressure:pressure,libraryStorage:storage,chartClient:deletionClient(record),
  accountSession:{accountId:record.accountId,sessionId:'quota-session'},realViewSession:true});
 await h.restoration;await tick();h.select(record.id);await tick();
 assert.equal(await h.prepareOfflineUpdate(),true,'the actual local copy initially supports reload');
 useTime=100;const incoming=accountNatalChart(71),put=IDBObjectStore.prototype.put,remove=IDBObjectStore.prototype.delete;
 const tracker={removed:false};
 IDBObjectStore.prototype.delete=function(key){if(this.name==='charts')this.transaction.addEventListener('complete',()=>{tracker.removed=true;});return remove.call(this,key);};
 IDBObjectStore.prototype.put=function(value:unknown,key?:IDBValidKey){
  if(this.name==='charts' && (value as {id?:string}).id===incoming.id && !tracker.removed)
   throw new DOMException('full','QuotaExceededError');
  return key===undefined?put.call(this,value):put.call(this,value,key);
 };
 try{assert.deepEqual(storage.capture(record.accountId),active.lease);assert.equal(await storage.touch(active.lease,incoming.id,incoming),true);}
 finally{IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.delete=remove;}
 assert.equal((await storage.read())!.charts.some(row=>row.id===record.id),false,'whole-card placement removed the older packet');
 assert.equal(h.shown.id,record.id,'the working card still exists in RAM');
 assert.equal(await h.prepareOfflineUpdate(),false,'RAM is not evidence of recoverability after reload');
 await storage.put(active.lease,[record]);
 assert.equal(await h.prepareOfflineUpdate(),true,'a new durable copy permits the transition again');
 const noNetwork=async()=>assert.fail('offline restoration must not request the server');
 const connection: ConnectionSource = {current:'offline',subscribe(){return()=>{};}};
 const restored=harness({connection,libraryStorage:storage,chartClient:{catalog:noNetwork,confirmCatalog:noNetwork,own:noNetwork,public:noNetwork},
  realViewSession:true,savedView:h.savedSnapshot});
 await restored.restoration;await tick();
 assert.equal(restored.shown.id,record.id);assert.equal(restored.cards[0]?.note,record.note);
});


test('a temporary calculation uses the tab snapshot and never the guest permanent library',async()=>{
  const store=createChartStore({});
  store.projectLibrary([],false);
  const n=addressHarness('/');
  const h=harness({actualStore:store,navigation:n.navigation,realViewSession:true});
  await h.restoration;
  const first={...accountNatalChart(81),id:'temporary-one',createdAt:'',updatedAt:''};
  assert.equal(h.prepareTemporary(first),true);
  assert.equal(h.shown.id,first.id);
  assert.equal(n.location.pathname,'/chart');
  assert.deepEqual(h.cards,[]);
  assert.equal(h.savedSnapshot?.temporaryChart?.id,first.id);
  assert.equal(await h.prepareOfflineUpdate(),true,'the tab snapshot can restore this ready temporary card');
  const second={...first,id:'temporary-two',name:'Second temporary'};
  h.prepareTemporary(second);
  assert.equal(store.get(first.id),undefined);
  assert.equal(h.savedSnapshot?.temporaryChart?.id,second.id);
  const saved=h.savedSnapshot!;
  const reopened=createChartStore({initialTemporaryChart:saved.temporaryChart});
  reopened.projectLibrary([],false);
  const restored=harness({actualStore:reopened,navigation:addressHarness('/chart').navigation,realViewSession:true,savedView:saved});
  await restored.restoration;
  assert.equal(restored.shown.id,second.id);
  assert.deepEqual(restored.cards,[]);
});

test('ordinary login keeps a temporary card local and only explicit add moves it into the account',async()=>{
  const temporary={...accountNatalChart(82),id:'temporary-one',calculationReceipt:'signed-calculation',createdAt:'',updatedAt:''};
  const store=createChartStore({initialTemporaryChart:temporary});
  store.projectLibrary([],false);
  const own=accountNatalChart(83);let writes=0;
  const h=harness({actualStore:store,realViewSession:true,navigation:addressHarness('/chart').navigation,
    savedView:{selectedId:temporary.id,temporaryChart:store.temporaryChart},chartClient:{
      async catalog(input){return catalogPage([],input.expectedAccountId);},
      async create(input){writes++;return {...input,outcome:{kind:'created',chartId:own.id,revision:1}};},
      async own(){return {chart:own,catalogMarker:'1'};}
    }});
  await h.restoration;
  h.changeAccount({accountId:'1',sessionId:'ordinary-login'});await tick();await tick();
  assert.equal(h.shown.id,temporary.id);assert.equal(writes,0);assert.deepEqual(h.cards,[]);
  assert.equal(h.submitPort({previous:store.temporaryChart!,name:'Edited',note:''}),null,
    'editing the tab card after login stays local');
  h.prepareTemporary({...store.temporaryChart!,name:'Edited'});
  await h.saveShown();await tick();
  assert.equal(writes,1);assert.equal(h.shown.id,own.id);
  assert.equal(store.temporaryChart,null);
  assert.equal(h.savedSnapshot?.temporaryChart,null);
  assert.equal(h.cards.length,1);
});


async function waitForOwnLink(check:()=>boolean) {
  for(let i=0;i<100 && !check();i++)await tick();
  assert.ok(check(),'the requested account projection did not settle');
}
async function waitForLibraryCheck(storage:ReturnType<typeof createAccountLibraryStore>,accountId:string) {
 for(let i=0;i<100;i++){
  const record=(await storage.background.read())?.checks[`library:${accountId}`];
  if(record?.lastSuccessAt!=null && !record.permit)return;
  await tick();
 }
 assert.fail('the admitted library check did not complete');
}

async function ownLinkLoginContinuation(staleProjection=false) {
  const own={...accountNatalChart(91,'1',2),note:'Existing private note'};
  const {accountId:_account,noteRevision:_note,publicRevision:_public,note:_private,...publicFields}=own;
  const source={...publicFields,note:'',createdAt:'',updatedAt:''};
  const store=createChartStore({});
  store.projectLibrary([],false);
  const n=addressHarness('/chart/'+source.id);
  const libraryStorage=createAccountLibraryStore({indexedDB:new IDBFactory()});
  let finish!:()=>void,writes=0,ownReads=0;
  const h=harness({actualStore:store,libraryStorage,navigation:n.navigation,realViewSession:true,
    chartClient:{async public(){return publicFields;},
      async catalog(input){return catalogPage(input.expectedAccountId==='1'?[staleProjection?{...own,revision:1,publicRevision:1}:{...own}]:[],input.expectedAccountId);},
      async addFromSource(input){writes++;await new Promise<void>(done=>{finish=done;});return {...input,outcome:{kind:'existing',chartId:own.id,revision:own.revision}};},
      async own(){ownReads++;return {chart:own,catalogMarker:'1'};}}});
  await h.restoration;await tick();
  assert.equal(h.shown.id,source.id);
  await h.saveShown();await tick();
  assert.equal(h.workspace.screen,'account');assert.equal(writes,0);
  const before={shown:h.shown,selections:h.chartSelections,dayRequests:h.dayRequests};
  h.changeAccount({accountId:'1',sessionId:'own-link-login'});
  await waitForOwnLink(()=>writes===1 && h.rows.some(chart=>chart.id===own.id));
  return {h,n,store,own,source,before,cleanup:()=>libraryStorage.close(),finish:()=>finish(),get writes(){return writes;},get ownReads(){return ownReads;}};
}

for(const staleProjection of [false,true])test(`login returns to an already owned public link after its ${staleProjection?'stale':'ready'} library projection`,async t=>{
  const c=await ownLinkLoginContinuation(staleProjection);t.after(c.cleanup);
  assert.equal(c.writes,1,'the explicit add continuation is kept through account projection');
  assert.equal(c.h.shown.id,c.source.id,'the accepted public result stays until the confirmed own result is read');
  c.finish();await waitForOwnLink(()=>c.h.workspace.screen==='chart');
  assert.equal(c.h.workspace.screen,'chart');
  assert.equal(c.n.location.pathname,'/chart/'+c.own.id);
  assert.equal(c.h.cards.length,1);assert.equal(c.h.cards[0].note,'Existing private note');
  assert.equal(c.ownReads,1);assert.equal(c.writes,1);
  assert.equal(c.h.chartSelections,c.before.selections,'adopting the same chart preserves its active tools');
  assert.equal(c.h.dayRequests,c.before.dayRequests);
  assert.equal(c.h.shown.primary,c.before.shown.primary);
});

for(const cancellation of ['back','navigation'] as const)test(`a late own-link result cannot resume after ${cancellation} cancels login continuation`,async t=>{
  const c=await ownLinkLoginContinuation();t.after(c.cleanup);
  assert.equal(c.writes,1);
  if(cancellation==='back')await c.h.element('accountPage').dispatch('click',{target:{closest:()=>({disabled:false,dataset:{accountAction:'back'}})}});
  else await c.h.element('openKnowledge').click();
  const screen=c.h.workspace.screen,path=c.n.location.pathname;
  c.finish();await tick();await tick();
  assert.equal(c.h.workspace.screen,screen);
  assert.equal(c.n.location.pathname,path);
  assert.equal(c.writes,1);
});


test('an account change cancels the own-link continuation without pinning its old public source',async t=>{
  const c=await ownLinkLoginContinuation();t.after(c.cleanup);
  assert.equal(c.writes,1);
  c.h.changeAccount({accountId:'2',sessionId:'another-account'});await tick();await tick();
  c.finish();await tick();await tick();
  assert.equal(c.h.workspace.screen,'account');assert.equal(c.ownReads,0);
  c.own.name='Changed after another login';
  c.h.changeAccount({accountId:'1',sessionId:'new-login'});await waitForOwnLink(()=>c.h.rows[0]?.name===c.own.name);
  assert.equal(c.h.workspace.screen,'account','ordinary login must not revive the cancelled continuation');
  c.h.select(c.own.id);await waitForOwnLink(()=>c.h.shown.primaryLabel===c.own.name);
  assert.equal(c.ownReads,1,'the light catalogue does not fetch numbers; the explicit open does');
  assert.equal(c.writes,1);
});


test('temporary route after restoring a public URL reads the independent tab card owner',async()=>{
 const temporary={...accountNatalChart(90),id:'temporary-tab',createdAt:'',updatedAt:''};
 const source=accountNatalChart(91,'2');const {accountId,note,noteRevision,publicRevision,...publicRecord}=source;
 const store=createChartStore({initialTemporaryChart:temporary});
 store.projectLibrary([],false);
 const n=addressHarness('/chart/'+source.id);
 const h=harness({actualStore:store,navigation:n.navigation,realViewSession:true,
  savedView:{selectedId:source.id,temporaryChart:store.temporaryChart},chartClient:{async public(){return publicRecord;}}});
 await h.restoration;assert.equal(h.shown.id,source.id);
 n.backTo('/chart');await tick();
 assert.equal(h.shown.id,temporary.id);
});


test('the composed account list retains display records after an unchanged storage refresh', async () => {
  const record = accountNatalChart(), store = createChartStore({});
  const storage = createAccountLibraryStore({indexedDB: new IDBFactory()});
  const active = await storage.activate(record.accountId); assert.equal(active.status, 'stored');
  await storage.put(active.lease, [record]);
  const h = harness({actualStore: store, libraryStorage: storage,
    accountSession: {accountId: record.accountId, sessionId: 'projection'},
    chartClient: {async catalog(input){return catalogPage([{...record}],input.expectedAccountId);}}});
  await h.restoration;
  const cards = h.cards;
  assert.equal(cards.length, 1);
  await h.libraryChanged();
  assert.equal(h.cards, cards, 'composition passes stable records through to the views');
  assert.equal(h.cards[0]!.id, record.id);
});


async function temporaryReplay(t:{after:(cleanup:()=>void)=>void}) {
  const own=accountNatalChart(94), temporary={...own,id:'temporary-replay',createdAt:'',updatedAt:''};
  let writes=0,reads=0,ownReads=0,release!:()=>void;
  let outcome: 'created'|'unknown'='created',failOwn=false;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const storage=createAccountLibraryStore({indexedDB:new IDBFactory()});t.after(()=>storage.close());
  const client={
    async create(){writes++;throw Object.assign(new Error('lost response'),{code:'connection_failed'});},
    async outcome(input){if(++reads===1)await gate;return {...input,outcome:outcome==='unknown'?{kind:'unknown' as const}:{kind:'created' as const,chartId:own.id,revision:own.revision}};},
    async own(){ownReads++;if(failOwn)throw Object.assign(new Error('read unavailable'),{code:'connection_failed'});return {chart:own,catalogMarker:'1'};},
    async catalog(input){return catalogPage([],input.expectedAccountId);},
  } satisfies Partial<ChartClient>;
  const access={accountId:own.accountId,sessionId:'replay'};
  const store=createChartStore({initialTemporaryChart:temporary});store.projectLibrary([],false);
  const first=harness({actualStore:store,realViewSession:true,navigation:addressHarness('/chart').navigation,
    savedView:{selectedId:temporary.id,temporaryChart:store.temporaryChart},accountSession:access,libraryStorage:storage,
    chartClient:client});
  await first.restoration;await first.saveShown();first.flushView();assert.equal(writes,1);
  const data=new Map<string,string>();const viewStore=createViewStore({getStorage:()=>({getItem:key=>data.get(key)??null,setItem:(key,value)=>{data.set(key,value);},removeItem:key=>{data.delete(key);}})});
  viewStore.write(first.savedSnapshot!);const saved=viewStore.read()!;
  const restoredStore=createChartStore({initialTemporaryChart:saved.temporaryChart});restoredStore.projectLibrary([],false);
  const n=addressHarness('/chart');
  const h=harness({actualStore:restoredStore,realViewSession:true,navigation:n.navigation,savedView:saved,
    accountSession:access,libraryStorage:storage,chartClient:client});
  await h.restoration;await waitForOwnLink(()=>reads===1);
  return {h,n,store:restoredStore,own,temporary,client,storage,access,viewStore,
    get writes(){return writes;},get reads(){return reads;},get ownReads(){return ownReads;},
    setOwnFailure(value:boolean){failOwn=value;},finish(value:'created'|'unknown'='created'){outcome=value;release();}};
}

test('recovered temporary save preserves an unrelated selected public source',async t=>{
  const own=accountNatalChart(94),temporary={...own,id:'temporary-replay',createdAt:'',updatedAt:''};
  const {accountId,note,noteRevision,publicRevision,...foreign}=accountNatalChart(116,'2');
  const intent={operationId:'a'.repeat(32),expectedAccountId:'1'};
  const store=createChartStore({initialTemporaryChart:temporary,initialPublicChart:foreign});
  store.projectLibrary([],false);
  let release!:()=>void,reads=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const n=addressHarness('/chart/'+foreign.id);
  const h=harness({actualStore:store,realViewSession:true,navigation:n.navigation,
    accountSession:{accountId:'1',sessionId:'public-during-recovery'},
    savedView:{selectedId:foreign.id,publicChart:foreign,temporaryChart:store.temporaryChart,
      temporaryChartSave:{...intent,sourceId:temporary.id},pendingChartWrites:[intent]},
    chartClient:{
      async catalog(input){return catalogPage([],input.expectedAccountId);},async public(){return foreign;},async own(){return {chart:own,catalogMarker:'1'};},
      async outcome(input){reads++;await gate;return {...input,outcome:{kind:'created',chartId:own.id,revision:own.revision}};},
    }});
  t.after(()=>h.stopApplication());
  await h.restoration;await waitForOwnLink(()=>reads===1);
  assert.equal(h.shown.id,foreign.id);release();
  await waitForOwnLink(()=>store.temporaryChart===null);h.flushView();
  assert.ok(store.get(own.id),'the recovered record is accepted into the library');
  assert.ok(store.get(foreign.id),'recovery must preserve the independently selected public source');
  assert.equal(h.shown.id,foreign.id);assert.equal(n.location.pathname,'/chart/'+foreign.id);
  assert.equal(h.savedSnapshot?.publicChart?.id,foreign.id);
});

test('temporary save replay after reload adopts the confirmed card without another Add write',async t=>{
  const c=await temporaryReplay(t);c.finish();await waitForOwnLink(()=>c.h.cards.length===1);await tick();c.h.flushView();
  assert.equal(c.store.temporaryChart,null);
  assert.equal(c.h.shown.id,c.own.id);assert.equal(c.n.location.pathname,'/chart/'+c.own.id);
  assert.equal(c.h.savedSnapshot?.temporaryChart,null);
  await c.h.saveShown();assert.equal(c.writes,1);assert.equal(c.reads,1);
});

test('unknown temporary save replay is checked by the same operation on explicit Add',async t=>{
  const c=await temporaryReplay(t);c.finish('unknown');await tick();await tick();
  await c.h.saveShown();assert.equal(c.writes,1,'unknown replay must not turn a repeated Add into a new create');
  assert.equal(c.reads,2);assert.equal(c.store.temporaryChart?.id,c.temporary.id);
  assert.equal(c.h.shown.id,c.temporary.id);assert.equal(c.h.pendingWrites?.length,1);
  c.finish();await c.h.saveShown();assert.equal(c.writes,1);assert.equal(c.reads,3);
  assert.equal(c.store.temporaryChart,null);assert.equal(c.h.shown.id,c.own.id);
});

test('temporary save replay does not open the chart over a newer account screen',async t=>{
  const c=await temporaryReplay(t);c.n.backTo('/account');await tick();c.finish();
  await waitForOwnLink(()=>c.h.cards.length===1);await tick();
  assert.equal(c.store.temporaryChart,null);assert.equal(c.h.workspace.screen,'account');assert.equal(c.n.location.pathname,'/account');
});

for(const sameId of [false,true])test(`temporary save replay preserves a newer ${sameId?'edited source':'replacement card'}`,async t=>{
  const c=await temporaryReplay(t);
  const newer={...c.temporary,id:sameId?c.temporary.id:'newer-temporary',name:'New accepted version'};
  c.h.prepareTemporary(newer);c.finish();await waitForOwnLink(()=>c.h.cards.length===1);await tick();c.h.flushView();
  assert.equal(c.store.temporaryChart?.name,'New accepted version');assert.equal(c.h.shown.primaryLabel,'New accepted version');
  assert.equal(c.h.savedSnapshot?.temporaryChart?.name,'New accepted version');assert.equal(c.h.savedSnapshot?.temporaryChartSave,null);assert.equal(c.writes,1);
});

for(const boundary of ['account','logout'] as const)test(`temporary save replay cannot return after ${boundary}`,async t=>{
  const c=await temporaryReplay(t);
  if(boundary==='logout'){c.h.logoutNotice([c.access.sessionId]);c.h.changeAccount(null);}
  else c.h.changeAccount({accountId:'2',sessionId:'other'});
  c.finish();await tick();await tick();c.h.flushView();
  assert.equal(c.store.temporaryChart?.id,c.temporary.id);assert.equal(c.h.shown.id,c.temporary.id);
  assert.equal(c.h.cards.length,0);assert.equal(c.writes,1);assert.deepEqual(c.h.pendingWrites,[]);assert.equal(c.h.savedSnapshot?.temporaryChartSave,null);
});


test('temporary save replay retains its binding through a failed own read and another reload',async t=>{
  const c=await temporaryReplay(t);c.setOwnFailure(true);c.finish();await waitForOwnLink(()=>c.ownReads===1);await tick();c.h.flushView();
  assert.equal(c.store.temporaryChart?.id,c.temporary.id);assert.deepEqual(c.h.pendingWrites,[]);
  c.viewStore.write(c.h.savedSnapshot!);const saved=c.viewStore.read()!;
  c.setOwnFailure(false);
  const store=createChartStore({initialTemporaryChart:saved.temporaryChart});store.projectLibrary([],false);
  const h=harness({actualStore:store,realViewSession:true,navigation:addressHarness('/chart').navigation,savedView:saved,
    accountSession:c.access,libraryStorage:c.storage,chartClient:c.client,});
  await h.restoration;await waitForOwnLink(()=>store.temporaryChart===null);
  assert.equal(h.shown.id,c.own.id);await h.saveShown();assert.equal(c.writes,1);assert.equal(c.reads,2);
});

test('temporary save replay keeps a newer transit route while accepting the library result',async t=>{
  const c=await temporaryReplay(t);c.n.backTo('/');await tick();c.finish();
  await waitForOwnLink(()=>c.h.cards.length===1);await tick();
  assert.equal(c.store.temporaryChart,null);assert.equal(c.h.shown.id,'current-transit');assert.equal(c.n.location.pathname,'/');
});

test('legacy pending snapshots recover every operation without assuming a temporary source',async()=>{
  const records=[accountNatalChart(95),accountNatalChart(96)];let reads=0;
  const pointers=records.map((_,i)=>({operationId:String(i+1).repeat(32),expectedAccountId:'1'}));
  const h=harness({realViewSession:true,savedView:{pendingChartWrites:pointers},accountSession:{accountId:'1',sessionId:'legacy'},chartClient:{
    async outcome(input){reads++;const record=records[pointers.findIndex(p=>p.operationId===input.operationId)]!;return {...input,outcome:{kind:'created',chartId:record.id,revision:record.revision}};},
    async own(input){return {chart:records.find(r=>r.id===input.chartId)!,catalogMarker:'1'};},async catalog(input){return catalogPage([],input.expectedAccountId);}
  }});
  await h.restoration;await waitForOwnLink(()=>reads===2);await waitForOwnLink(()=>h.cards.length===2);
  assert.deepEqual(h.pendingWrites,[]);assert.equal(h.shown.id,'current-transit');
});

for(const available of [true,false])test(`startup checks the actual account storage after initialization (${available?'available':'unavailable'})`,async t=>{
  const store=createChartStore({});store.projectLibrary([],false);
  const storage=createAccountLibraryStore({indexedDB:available?new IDBFactory():null});t.after(()=>storage.close());
  const h=harness({actualStore:store,libraryStorage:storage,realViewSession:true});
  assert.deepEqual(h.notices,[],'an uninitialized loading projection is not a storage failure');
  await h.restoration;
  assert.deepEqual(h.notices,available?[]:['Хранилище браузера недоступно. Изменения не будут сохранены.']);
});


for(const preceding of ['created','unknown'] as const)test(`a preceding ${preceding} operation does not stop the linked temporary replay`,async()=>{
  const own=accountNatalChart(97),other=accountNatalChart(98),temporary={...own,id:'temporary-queued',createdAt:'',updatedAt:''};
  const first={operationId:'a'.repeat(32),expectedAccountId:'1'},second={operationId:'b'.repeat(32),expectedAccountId:'1'};
  const store=createChartStore({initialTemporaryChart:temporary});store.projectLibrary([],false);
  const reads:string[]=[];
  const h=harness({actualStore:store,realViewSession:true,accountSession:{accountId:'1',sessionId:'queued'},
    savedView:{selectedId:temporary.id,temporaryChart:store.temporaryChart,temporaryChartSave:{...second,sourceId:temporary.id},pendingChartWrites:[first,second]},chartClient:{
      async outcome(input){reads.push(input.operationId);return {...input,outcome:input.operationId===first.operationId && preceding==='unknown'
        ?{kind:'unknown'}:{kind:'created',chartId:input.operationId===first.operationId?other.id:own.id,revision:1}};},
      async own(input){return {chart:input.chartId===other.id?other:own,catalogMarker:'1'};},async catalog(input){return catalogPage([],input.expectedAccountId);}
    }});
  await h.restoration;await waitForOwnLink(()=>store.temporaryChart===null);
  assert.deepEqual(reads,[first.operationId,second.operationId]);assert.equal(h.shown.id,own.id);
  assert.deepEqual(h.pendingWrites,preceding==='unknown'?[first]:[]);
});


async function publicReload() {
  const foreign=accountNatalChart(103,'2'),temporary={...accountNatalChart(104),id:'own-tab-card',createdAt:'',updatedAt:''};
  const {accountId,note,noteRevision,publicRevision,...publicFields}=foreign;
  const store=createChartStore({initialTemporaryChart:temporary});store.projectLibrary([],false);
  const n=addressHarness('/chart/'+foreign.id);
  const first=harness({actualStore:store,realViewSession:true,navigation:n.navigation,
    savedView:{selectedId:temporary.id,temporaryChart:store.temporaryChart},chartClient:{async public(){return publicFields;}}});
  await first.restoration;first.flushView();assert.equal(first.shown.id,foreign.id);
  const records=new Map<string,string>(),view=createViewStore({getStorage:()=>({getItem:key=>records.get(key)??null,setItem:(key,value)=>{records.set(key,value);},removeItem:key=>{records.delete(key);}})});
  view.write(first.savedSnapshot!);
  return {foreign,temporary,publicFields,first,view};
}

test('the last public chart restores offline independently of the own temporary card',async()=>{
  const c=await publicReload(),saved=c.view.read()!;
  const store=createChartStore({initialTemporaryChart:saved.temporaryChart,initialPublicChart:saved.publicChart,
    });store.projectLibrary([],false);
  const n=addressHarness('/chart/'+c.foreign.id);
  const h=harness({actualStore:store,realViewSession:true,navigation:n.navigation,savedView:saved,
    chartClient:{async public(){throw Object.assign(new Error('no connection'),{code:'offline'});}}});
  await h.restoration;
  assert.equal(h.shown.id,c.foreign.id);assert.equal(h.loading.failed,undefined);
  assert.equal(store.temporaryChart?.id,c.temporary.id);assert.deepEqual(store.charts,[]);
  assert.equal(await h.prepareOfflineUpdate(),true,'the persisted public source participates in the existing update contract');
  n.backTo('/chart');await tick();assert.equal(h.shown.id,c.temporary.id);
});

test('a confirmed public 404 clears only that public source and restores transit',async()=>{
  const c=await publicReload(),saved=c.view.read()!;
  const store=createChartStore({initialTemporaryChart:saved.temporaryChart,initialPublicChart:saved.publicChart,
    });store.projectLibrary([],false);
  const n=addressHarness('/chart/'+c.foreign.id);
  const h=harness({actualStore:store,realViewSession:true,navigation:n.navigation,savedView:saved,
    chartClient:{async public(){throw Object.assign(new Error('deleted'),{code:'not_found',status:404});}}});
  await h.restoration;await tick();h.flushView();
  assert.equal(store.publicChart,null);assert.equal(h.shown.id,'current-transit');assert.equal(n.location.pathname,'/');
  assert.equal(h.savedSnapshot?.publicChart,null);assert.equal(store.temporaryChart?.id,c.temporary.id);
  assert.equal(h.transitStarts,1,'a cold redirect must start the transit owner rather than leave its day uninitialized');
});

test('a cold 404 fallback cannot publish late route effects after stop or a newer destination',async()=>{
  for(const boundary of ['stop','route'] as const){
    let release!:(ready:boolean)=>void;
    const pending=new Promise<boolean>(resolve=>{release=resolve;});
    const n=addressHarness('/chart/'+chartId(105));
    const h=harness({navigation:n.navigation, transitStart:()=>pending,
      chartClient:{async public(){throw Object.assign(new Error('deleted'),{code:'not_found',status:404});}}});
    await h.restoration;await tick();
    assert.equal(h.transitStarts,1);
    if(boundary==='stop')await h.stopApplication();else n.navigation.navigate({kind:'account'});
    await tick();
    const loading=h.loading, notices=h.notices.length;
    release(false);await tick();
    assert.equal(h.notices.length,notices,'the old failure cannot display a late message');
    assert.equal(h.loading,loading,'the old fallback cannot update route loading after its boundary');
    await h.stopApplication();n.navigation.destroy();
  }
});

test('an offline public URL never restores a different cached public ID',async()=>{
  const c=await publicReload(),saved=c.view.read()!,other=accountNatalChart(105,'2');
  const store=createChartStore({initialTemporaryChart:saved.temporaryChart,initialPublicChart:saved.publicChart,
    });store.projectLibrary([],false);
  const h=harness({actualStore:store,realViewSession:true,navigation:addressHarness('/chart/'+other.id).navigation,savedView:saved,
    chartClient:{async public(){throw Object.assign(new Error('offline'),{code:'offline'});}}});
  await h.restoration;assert.notEqual(h.shown.id,c.foreign.id);assert.equal(h.loading.failed,true);
  assert.equal(store.publicChart?.id,c.foreign.id);assert.equal(store.temporaryChart?.id,c.temporary.id);
});


test('a ready public calculation restores offline without a calculation marker',async()=>{
  const c=await publicReload(),saved=c.view.read()!;
  const store=createChartStore({initialPublicChart:saved.publicChart});store.projectLibrary([],false);
  const h=harness({actualStore:store,realViewSession:true,navigation:addressHarness('/chart/'+c.foreign.id).navigation,savedView:saved,
    chartClient:{async public(){throw Object.assign(new Error('offline'),{code:'offline'});}}});
  await h.restoration;assert.equal(store.has(c.foreign.id),true);assert.equal(h.shown.id,c.foreign.id);
  assert.equal(Boolean(h.loading.failed),false);assert.equal(await h.prepareOfflineUpdate(),true);assert.equal(store.publicChart?.id,c.foreign.id);
});

test('a late public response cannot replace the newer public snapshot or its route',async()=>{
  const c=await publicReload(),saved=c.view.read()!,next=accountNatalChart(106,'2'),old=accountNatalChart(107,'2');
  const publicPart=(record:typeof next)=>{const {accountId,note,noteRevision,publicRevision,...result}=record;return result;};
  let release!:(value:PublicAccountChart)=>void;
  const store=createChartStore({initialPublicChart:saved.publicChart,});store.projectLibrary([],false);
  const n=addressHarness('/account');
  const h=harness({actualStore:store,realViewSession:true,navigation:n.navigation,savedView:saved,
    chartClient:{public(id){return id===old.id?new Promise(resolve=>{release=resolve;}):Promise.resolve(publicPart(next));}}});
  await h.restoration;n.backTo('/chart/'+old.id);await tick();n.backTo('/chart/'+next.id);await tick();await tick();
  release(publicPart(old));await tick();h.flushView();
  assert.equal(h.shown.id,next.id);assert.equal(store.publicChart?.id,next.id);assert.equal(h.savedSnapshot?.publicChart?.id,next.id);
  assert.equal(n.location.pathname,'/chart/'+next.id);assert.equal(store.get(c.foreign.id),undefined);
});

test('deleting an owned card also removes the same ID from the tab public snapshot',async t=>{
  const record=accountNatalChart(108),{accountId,note,noteRevision,publicRevision,...publicFields}=record;
  const storage=createAccountLibraryStore({indexedDB:new IDBFactory()});t.after(()=>storage.close());
  const active=await storage.activate(record.accountId);assert.equal(active.status,'stored');await storage.put(active.lease,[record]);
  const store=createChartStore({initialPublicChart:publicFields,});store.projectLibrary([],false);
  const h=harness({actualStore:store,realViewSession:true,libraryStorage:storage,accountSession:{accountId:record.accountId,sessionId:'owner'},
    navigation:addressHarness('/chart/'+record.id).navigation,savedView:{selectedId:record.id,publicChart:publicFields},
    chartClient:deletionClient(record,{async remove(input){return {...input,catalogMarker:'2',outcome:{kind:'deleted',chartId:input.chartId}};}})});
  await h.restoration;await h.removeChart(record.id);await waitForOwnLink(()=>h.cards.length===0);await tick();h.flushView();
  assert.equal(store.publicChart,null);assert.equal(h.savedSnapshot?.publicChart,null);assert.equal(h.shown.id,'current-transit');
});


for(const outcome of ['updated','not_found','connection_failed'] as const)test(`reconnecting checks the last public original: ${outcome}`,async t=>{
  const c=await publicReload(),saved=c.view.read()!;
  let mode:'online'|'offline'='offline',reads=0;const listeners=new Set<(mode:'online'|'offline')=>void>();
  const connection: ConnectionSource = {get current(){return mode;},subscribe(fn){listeners.add(fn);return()=>{listeners.delete(fn);};}};
  const store=createChartStore({initialTemporaryChart:saved.temporaryChart,initialPublicChart:saved.publicChart,});store.projectLibrary([],false);
  const n=addressHarness('/chart/'+c.foreign.id);
  const h=harness({connection,actualStore:store,realViewSession:true,navigation:n.navigation,savedView:saved,
    chartClient:{async public(){reads++;if(outcome!=='updated')throw Object.assign(new Error(outcome),{code:outcome});return {...c.publicFields,name:'Current original',revision:c.foreign.revision+1};}}});
  await h.restoration;assert.equal(reads,0);h.camera.restoreView({x:-70,y:-90,k:2});const position=h.camera.getSavedView();
  mode='online';for(const listener of listeners)listener(mode);await waitForOwnLink(()=>reads===1);await tick();h.flushView();
  assert.equal(store.temporaryChart?.id,c.temporary.id);
  if(outcome==='not_found'){assert.equal(store.publicChart,null);assert.equal(h.shown.id,'current-transit');assert.equal(n.location.pathname,'/');}
  else {assert.equal(h.shown.id,c.foreign.id);assert.equal(store.publicChart?.name,outcome==='updated'?'Current original':c.foreign.name);assert.deepEqual(h.camera.getSavedView(),position);}
});


test('two real tab owners restore private and public cards before the worker retires old files',async t=>{
  const c=await publicReload(),privateChart=accountNatalChart(115),origin='https://forma.test';
  const privateStorage=createAccountLibraryStore({indexedDB:new IDBFactory()});t.after(()=>privateStorage.close());
  const lease=await privateStorage.activate(privateChart.accountId);assert.equal(lease.status,'stored');await privateStorage.put(lease.lease,[privateChart]);
  const privateView:Partial<SavedView>={version:1,selectedId:privateChart.id,workspace:'chart',panels:{left:true,right:true}};
  const publicView=c.view.read()!;
  const noNetwork=async()=>{throw Object.assign(new Error('offline'),{code:'offline'});};
  const makeApp=(kind:'private'|'public',saved:Partial<SavedView>,accountReady=Promise.resolve())=>{
    const store=createChartStore({initialTemporaryChart:saved.temporaryChart,initialPublicChart:saved.publicChart,
      });store.projectLibrary([],false);
    return harness({connection,actualStore:store,realViewSession:true,savedView:saved,accountReady,
      navigation:addressHarness('/chart/'+(kind==='private'?privateChart.id:c.foreign.id)).navigation,

      ...(kind==='private'?{libraryStorage:privateStorage,accountSession:{accountId:privateChart.accountId,sessionId:'offline-integration'}}:{}),
      chartClient:kind==='private'?deletionClient(privateChart):{public:noNetwork}});
  };
  const connection: ConnectionSource = {current:'offline',subscribe(){return()=>{};}};
  const initialA=makeApp('private',privateView),initialB=makeApp('public',publicView);
  await initialA.restoration;await initialB.restoration;
  assert.equal(initialA.shown.id,privateChart.id);assert.equal(initialB.shown.id,c.foreign.id);
  const cacheEntries=new Map<string,Map<string,Response>>();
  const key=(value:RequestInfo|URL)=>typeof value==='string'?value:value instanceof URL?value.href:value.url;
  const caches:BundleCaches={async keys(){return [...cacheEntries.keys()];},async has(name){return cacheEntries.has(name);},async delete(name){return cacheEntries.delete(name);},
    async open(name){let entries=cacheEntries.get(name);if(!entries){entries=new Map();cacheEntries.set(name,entries);}const owned=entries;
      return {async match(input){return owned.get(key(input))?.clone();},async put(input,response){owned.set(key(input),response.clone());}};}};
  const makeBundle=(label:string)=>{
    const html='<html><body>'+label+'</body></html>',version=createHash('sha256').update(label).digest('hex');
    return {version,bundle:createAppBundle({origin,caches,manifest:{version,files:[{url:'/index.html',sha256:createHash('sha256').update(html).digest('hex'),bytes:Buffer.byteLength(html)}]},
      fetch:async()=>new Response(html,{headers:{'Content-Type':'text/html'}})})};
  };
  const old=makeBundle('old'),next=makeBundle('next');await old.bundle.install();await next.bundle.install();
  const hasOld=()=>[...cacheEntries.keys()].some(name=>name.includes(old.version));assert.equal(hasOld(),true);
  type Application=ReturnType<typeof harness>;
  type WorkerPort=EventTarget&{state:string;postMessage(data:OfflineCommand,ports:MessagePort[]):void};
  type Tab={id:string;kind:'private'|'public';app:Application;container:EventTarget&{controller:WorkerPort};
    registration:EventTarget&{active:WorkerPort;waiting:WorkerPort|null;installing:null;update():Promise<void>};
    workers:Record<string,WorkerPort>;events:EventTarget;visibility:EventTarget&{hidden:boolean};page?:ReturnType<typeof attachOfflinePage>;held:number;reloads:number};
  const tabs=new Map<string,Tab>(),listeners=new Map<string,Partial<{[K in keyof OfflineWorkerEvents]:(event:OfflineWorkerEvents[K])=>void}>>();
  let activations=0;
  const client=(tab:Tab,version:string)=>({id:tab.id,type:'window',url:origin+'/chart/'+(tab.kind==='private'?privateChart.id:c.foreign.id),
    postMessage(message:OfflineTabRequest,ports:Transferable[]){tab.container.dispatchEvent(Object.assign(new Event('message'),{data:message,source:tab.workers[version],ports}));}});
  for(const release of [old,next]) {
    const handlers:Partial<{[K in keyof OfflineWorkerEvents]:(event:OfflineWorkerEvents[K])=>void}>={};listeners.set(release.version,handlers);
    const scope:OfflineWorkerScope={location:{origin},addEventListener(type,listener){handlers[type]=listener as never;},fetch:noNetwork,
      async skipWaiting(){activations++;for(const tab of tabs.values()){tab.registration.active=tab.workers[next.version]!;tab.registration.waiting=null;tab.container.controller=tab.workers[next.version]!;tab.container.dispatchEvent(new Event('controllerchange'));}},
      clients:{async get(id){const tab=tabs.get(id);return tab?client(tab,release.version):undefined;},async matchAll(){return [...tabs.values()].map(tab=>client(tab,release.version));}}};
    attachOfflineWorker(scope,release.bundle,{probeTimeoutMs:500});
  }
  const worker=(id:string,version:string):WorkerPort=>Object.assign(new EventTarget(),{state:'activated',postMessage(data:OfflineCommand,ports:MessagePort[]){
    listeners.get(version)!.message!({data,source:{id},ports,waitUntil(promise){void promise;}});
  }});
  const attach=(tab:Tab,loadedVersion:string)=>{
    tab.page=attachOfflinePage({registration:tab.registration as unknown as ServiceWorkerRegistration,serviceWorker:tab.container as unknown as ServiceWorkerContainer,
      loadedVersion,owner:{prepare:tab.app.prepareOfflineUpdate,restored:tab.app.offlineRestored,subscribe:tab.app.subscribeOfflineReady},
      events:tab.events,visibility:tab.visibility,timeoutMs:600,
      hold(){tab.held++;let active=true;return()=>{if(active){active=false;tab.held--;}};},reload(){tab.reloads++;}});
    void tab.app.restoration.then(()=>tab.page?.check());
  };
  const add=(id:string,kind:Tab['kind'],app:Application)=>{
    const workers={[old.version]:worker(id,old.version),[next.version]:worker(id,next.version)},controller=workers[old.version]!;
    const tab:Tab={id,kind,app,workers,container:Object.assign(new EventTarget(),{controller}),events:new EventTarget(),visibility:Object.assign(new EventTarget(),{hidden:false}),
      registration:Object.assign(new EventTarget(),{active:controller,waiting:workers[next.version]!,installing:null,async update(){}}),held:0,reloads:0};
    tabs.set(id,tab);return tab;
  };
  const a=add('A','private',initialA),b=add('B','public',initialB);attach(a,old.version);attach(b,old.version);
  t.after(()=>{for(const tab of tabs.values())tab.page?.dispose();});
  const settle=async(check:()=>boolean)=>{for(let i=0;i<250&&!check();i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(check(),true);};
  await settle(()=>a.reloads===1 && b.reloads===1);
  assert.equal(activations,1);assert.equal(a.held>0,true);assert.equal(b.held>0,true);assert.equal(hasOld(),true);
  const snapshot=(tab:Tab)=>{
    const data=new Map<string,string>(),view=createViewStore({getStorage:()=>({getItem:k=>data.get(k)??null,setItem:(k,v)=>{data.set(k,v);}})});
    view.write(tab.app.savedSnapshot!);return view.read()!;
  };
  const savedA=snapshot(a),savedB=snapshot(b);
  const reload=(tab:Tab,saved:Partial<SavedView>,ready=Promise.resolve())=>{
    tab.events.dispatchEvent(new Event('pagehide'));tab.page!.dispose();assert.equal(tab.held,0);
    tab.app=makeApp(tab.kind,saved,ready);attach(tab,next.version);return tab.app;
  };
  const newA=reload(a,savedA);await newA.restoration;await a.page!.check();assert.equal(hasOld(),true,'the other tab still has old loaded code');
  let releaseB!:()=>void;const readyB=new Promise<void>(resolve=>{releaseB=resolve;});const newB=reload(b,savedB,readyB);
  await a.page!.check();assert.equal(hasOld(),true,'new loaded code is insufficient until its real application restores');
  releaseB();await newB.restoration;await settle(()=>!hasOld());
  assert.equal(newA.shown.id,privateChart.id);assert.equal(newB.shown.id,c.foreign.id);
  assert.equal(newB.savedSnapshot?.temporaryChart?.id,c.temporary.id);assert.equal(newB.savedSnapshot?.publicChart?.id,c.foreign.id);
  assert.deepEqual(newA.panels.snapshot,{left:true,right:true});assert.equal(newA.cards.length,1);assert.deepEqual(newB.cards,[]);
  assert.equal((await next.bundle.status()).ready,true);assert.equal(activations,1);
});


for(const boundary of ['source','login','stop','workspace','workspace-click'] as const)test(`a delayed public recheck follows source ownership across ${boundary}`,async t=>{
  const c=await publicReload(),saved=c.view.read()!;
  let mode:'online'|'offline'='offline',release!:(value:PublicAccountChart)=>void,reads=0;const listeners=new Set<(mode:'online'|'offline')=>void>();
  const connection: ConnectionSource = {get current(){return mode;},subscribe(fn){listeners.add(fn);return()=>{listeners.delete(fn);};}};
  const store=createChartStore({initialPublicChart:saved.publicChart,});store.projectLibrary([],false);
  const n=addressHarness('/chart/'+c.foreign.id);
  const h=harness({connection,actualStore:store,realViewSession:true,navigation:n.navigation,savedView:saved,
    chartClient:{public(){reads++;return new Promise(resolve=>{release=resolve;});},async catalog(input){return catalogPage([],input.expectedAccountId);}}});
  await h.restoration;mode='online';for(const listener of listeners)listener(mode);await waitForOwnLink(()=>reads===1);
  if(boundary==='workspace')n.backTo('/account');
  else if(boundary==='workspace-click')await h.element('openAccount').click();
  else if(boundary==='source')n.backTo('/');
  else if(boundary==='stop')await h.stopApplication();
  else h.changeAccount({accountId:'3',sessionId:'new-login'});
  await tick();release({...c.publicFields,name:'Late original',revision:c.foreign.revision+1});await tick();h.flushView();
  const expected=boundary.startsWith('workspace')?'Late original':c.foreign.name;
  assert.equal(store.publicChart?.name,expected);assert.equal(h.savedSnapshot?.publicChart?.name,expected);
  assert.equal(reads,1,'one refresh remains one request across a workspace change');
  if(boundary.startsWith('workspace')){assert.equal(h.workspace.screen,'account');assert.equal(n.location.pathname,'/account');}
});


test('late journal attachment reaches the already created returns owner and the lazy lifetime owner',async()=>{
 const chart=libraryRecordAtMinute(natalDayFixture(),754,personalChartFixture()),event={id:'saturn:2050-01-01T12:00:29.432Z',body:'saturn',utc:'2050-01-01T12:00:29.432Z',cycle:1};
 const h=harness({charts:[chart],returnEvents:[event],getReturn:async()=>{throw Object.assign(new Error('private return'),{code:'engine_unavailable'});},
  metaError:Object.assign(new Error('private lifetime'),{code:'lifetime_unavailable'})});
 await tick();h.select(chart.id);await tick();const probe=journalProbe();h.attachJournal(probe.journal);
 await h.returns.selectEvent(event.id);
 const opening=h.element('lifetimeToggle').click();h.finishModule();await opening;await tick();h.lifetime.close();
 assert.deepEqual(probe.failures,[
  {action:{action:'calculate',component:'cycles'},code:'engine_unavailable',step:{stage:'request'}},
  {action:{action:'data_read',component:'lifetime'},code:'lifetime_unavailable',step:{stage:'request'}},
 ]);
});

test('a restoration exception does not authorize reload', async () => {
  const h=harness({restore:async()=>{throw Error('restoration failed');}});
  await h.restoration;
  assert.equal(h.offlineRestored(),false);
  assert.equal(await h.prepareOfflineUpdate(),false);
});


test('the permanent-link action stays hidden before a chart has a public address', async () => {
  const h = harness(); await h.restoration;
  assert.equal(h.element('copyChartLink').hidden, true);
});


test('copying the selected public original uses its decimal ID without a save or network dependency', async () => {
  const original = {...accountNatalChart(107, '2'), id: '9876543210123456789'};
  const {accountId, note, noteRevision, publicRevision, ...publicFields} = original;
  const n = addressHarness('/chart/' + original.id);
  const store = createChartStore({});
  store.projectLibrary([], false);
  const connection = {current: 'online' as 'online'|'offline', subscribe() {return () => {};}};
  const h = harness({connection,actualStore: store, realViewSession: true, navigation: n.navigation,
    chartClient: {async public() {return publicFields;}}});
  await h.restoration;
  assert.equal(h.element('copyChartLink').hidden, false);
  connection.current = 'offline';
    await h.element('copyChartLink').click();
    assert.deepEqual(h.copiedLinks, ['https://forma.example.test/chart/9876543210123456789']);
    assert.deepEqual(h.pendingWrites ?? [], []);
    h.select('current-transit'); await tick();
    assert.equal(h.element('copyChartLink').hidden, true);
    await h.element('copyChartLink').click(); assert.equal(h.copiedLinks.length, 1);
});

test('a temporary card has no copy action until an explicit save adopts its permanent ID', async () => {
  const saved = {...accountNatalChart(108), id: '1234567890'};
  const temporary = {...saved, id: 'own-temporary', createdAt: '', updatedAt: ''};
  const store = createChartStore({initialTemporaryChart: temporary});
  store.projectLibrary([], false);
  let writes = 0;
  const n = addressHarness('/chart');
  const h = harness({navigation: n.navigation, actualStore: store, realViewSession: true,
    savedView: {selectedId: temporary.id, temporaryChart: store.temporaryChart},
    accountSession: {accountId: '1', sessionId: 'copy-link-test'}, chartClient: {
      async create(input) {writes++; return {...input, outcome: {kind: 'created', chartId: saved.id, revision: 1}};},
      async own() {return {chart:saved,catalogMarker:'1'};}, async catalog(input){return catalogPage([],input.expectedAccountId);},
    }});
  await h.restoration;
  assert.equal(h.element('copyChartLink').hidden, true);
  await h.element('copyChartLink').click(); assert.equal(writes, 0); assert.deepEqual(h.copiedLinks, []);
  assert.deepEqual(store.displayCharts, []); assert.equal(h.shown.id, temporary.id);
  h.select('current-transit'); await tick(); n.backTo('/chart'); await tick();
  assert.equal(h.shown.id, temporary.id, 'browser Back restores the same tab slot without a menu row');
  await h.saveShown();
  assert.equal(writes, 1); assert.equal(h.element('copyChartLink').hidden, false);
  await h.element('copyChartLink').click();
  assert.deepEqual(h.copiedLinks, ['https://forma.example.test/chart/1234567890']);
  assert.equal(writes, 1, 'copying the saved result cannot trigger another save');
});


test('the sidebar and Kartoteka display the same alphabetical saved rows', async t => {
  const names = ['Яна', 'Борис', 'Анна'];
  const records = names.map((name, index) => ({...accountNatalChart(120 + index), name}));
  const storage = createAccountLibraryStore({indexedDB: new IDBFactory()}); t.after(() => storage.close());
  const active = await storage.activate('1'); assert.equal(active.status, 'stored'); await storage.put(active.lease, records);
  const store = createChartStore({}); store.projectLibrary([], false);
  const h = harness({actualStore: store, libraryStorage: storage, realViewSession: true,
    accountSession: {accountId: '1', sessionId: 'alphabetical'},
    chartClient: {async catalog(input){return catalogPage(records,input.expectedAccountId);}}});
  await h.restoration; await waitForOwnLink(() => h.cards.length === 3);
  await h.element('openLibrary').click(); await h.element('openAllCharts').click();
  const ids = (id: string) => h.element(id).children.map(row => row.innerHTML.match(/data-chart-id="([^"]+)"/)?.[1]);
  assert.deepEqual(ids('chartList'), [records[2].id, records[1].id, records[0].id]);
  assert.deepEqual(ids('allChartsList'), ids('chartList'));
});


test('studio resize notifications defer geometry writes and collapse repeated deliveries into one frame', async () => {
  const h = harness({studioSize: {width: 1000, height: 800}}); await h.restoration;
  let refreshes = 0; const refresh = h.layout.refresh;
  h.layout.refresh = () => { refreshes++; return refresh(); };
  h.notifyResize(); h.notifyResize(); h.notifyResize();
  assert.equal(refreshes, 0, 'ResizeObserver must not synchronously resize the observed studio or heading');
  h.flushResizeFrames(); assert.equal(refreshes, 1);
});

test('unchanged peer library notifications do not redraw the selected chart', async () => {
 const own=accountNatalChart(95), storage=createAccountLibraryStore({indexedDB:new IDBFactory()});
 const acquired=await storage.activate(own.accountId);assert.equal(acquired.status,'stored');
 await storage.put((await storage.read())!.lease!,[own]);
 const store=createChartStore({});store.projectLibrary([],false);
 const h=harness({actualStore:store,libraryStorage:storage,realViewSession:true,
  accountSession:{accountId:own.accountId,sessionId:'fixture'},
  savedView:{selectedId:own.id},chartClient:{async own(){return {chart:own,catalogMarker:'1'};},
   async catalog(input){return catalogPage([{...own}],input.expectedAccountId);}}});
 try {
  await h.restoration;await waitForLibraryCheck(storage,own.accountId);
  const renders=h.renders,captions=h.captionUpdates;
  for(let i=0;i<5;i++)await h.libraryChanged();
  assert.equal(h.renders,renders);assert.equal(h.captionUpdates,captions);
  await storage.put((await storage.read())!.lease!,[{...own,name:'Changed once',revision:own.revision+1}]);
  await h.libraryChanged();
  assert.equal(h.renders,renders+1,'one changed record updates the graph once');
  assert.equal(h.captionUpdates,captions+1,'one changed record updates its caption once');
  await h.element('openAccount').click();
  const hiddenRenders=h.renders;
  await storage.put((await storage.read())!.lease!,[{...own,name:'Changed while hidden',revision:own.revision+2}]);
  await h.libraryChanged();
  assert.equal(h.renders,hiddenRenders,'hidden scene does not prepare a new drawing');
  h.workspace.setScreen('chart');
  assert.ok(h.renders>hiddenRenders,'returning paints the accepted scene');
 } finally {storage.close();}
});

test('unchanged account form notification does not abort a public refresh', async () => {
 const {accountId,note,noteRevision,publicRevision,...foreign}=accountNatalChart(97,'7');
 let reads=0,refreshSignal:AbortSignal|undefined,finish!:(value:PublicAccountChart)=>void;
 const store=createChartStore({initialPublicChart:foreign,});store.projectLibrary([],false);
 const h=harness({actualStore:store,realViewSession:true,
  navigation:addressHarness('/chart/'+foreign.id).navigation,savedView:{selectedId:foreign.id,publicChart:foreign},
  chartClient:{async public(_id,signal){reads++;if(reads===1)return foreign;refreshSignal=signal;return new Promise(resolve=>{finish=resolve;});}}});
 await h.restoration;for(let i=0;i<10;i++)await tick();await h.element('openAccount').click();
 h.advanceBackground(50*60000);h.userInput('visibilitychange');await tick();assert.equal(reads,2);assert.equal(refreshSignal?.aborted,false);
 h.changeAccount(null);assert.equal(refreshSignal?.aborted,false);
 finish({...foreign,name:'Updated original',revision:foreign.revision+1});await tick();await tick();
 assert.equal(store.publicChart?.name,'Updated original');
});

for (const screen of ['account', 'charts', 'knowledge'] as const) {
  test(`restoring ${screen} defers the transit drawing without blocking a later offline update`, async t => {
    const h = harness({realViewSession: true, realTransit: true,
      savedView: {workspace: screen, selectedId: 'current-transit',
        transit: {live: false, date: '2026-09-24', timeZone: 'UTC', index: 400}}});
    t.after(() => h.liveTransit?.stop());
    await h.restoration;
    const currentTransit = () => h.liveTransit?.current;
    assert.equal(currentTransit(), null, 'hidden startup does not extract or paint a moment');
    assert.equal(h.offlineRestored(), true, 'deferred drawing is not failed restoration');
    h.workspace.setScreen('chart');
    for (let i = 0; i < 8; i++) await tick();
    assert.equal(currentTransit()?.utc, '2026-09-24T06:40:00Z', 'the accepted pause survives hidden startup');
    assert.equal(h.offlineRestored(), true);
    assert.equal(h.prepareOfflineUpdate(), true);
  });
}

test('leaving the chart with a hovered item defers the cleared highlight until return', async t => {
  const h = harness({realViewSession: true, realTransit: true, studioSize: {width: 1000, height: 800}});
  t.after(() => h.liveTransit?.stop());
  await h.restoration;
  for (let i = 0; i < 8; i++) await tick();
  h.setHovered();
  const before = h.renders;
  h.workspace.setScreen('account');
  assert.equal(h.renders, before, 'hover clearing must obey the same hidden-scene gate');
  h.workspace.setScreen('chart');
  assert.ok(h.renders > before, 'the visible scene receives its cleared highlight');
});


test('failed personal cleanup survives a later account boundary and reconnect without another reset',async t=>{
 let mode:'online'|'offline'='online';const listeners=new Set<()=>void>();
 const connection: ConnectionSource = {get current(){return mode;},subscribe(fn){listeners.add(fn);return()=>{listeners.delete(fn);};}};

 let resets=0,retries=0,pending=false,available=false;const record=accountNatalChart();
 const h=harness({connection,chartClient:{async catalog(input){return catalogPage([],input.expectedAccountId);}},
  accountSession:{accountId:'1',sessionId:'one'},personalCleanup:{
   async resetPersonal(){resets++;pending=true;return {status:'unavailable',generation:1};},
   async retryPersonalCleanup(){if(!pending)return null;retries++;if(!available)return {status:'unavailable',generation:1};pending=false;return {status:'cleared',generation:1};},
  }});
 t.after(()=>h.stopApplication());const drain=async()=>{for(let i=0;i<8;i++)await tick();};
 await h.restoration;await drain();
 h.changeAccount(null);h.logoutNotice(['one']);await drain();assert.equal(resets,1);
 h.changeAccount({accountId:'2',sessionId:'two'});await drain();
 mode='offline';for(const fn of listeners)fn();await drain();
 available=true;mode='online';for(const fn of listeners)fn();await drain();
 assert.equal(pending,false,'the failed old cleanup must be resumed by its owner after B signs in');
 assert.equal(resets,1,'retry does not revoke a new generation');assert.equal(retries,2,'one attempt at B and one on reconnect');
});


test('transit storage follows the current local day once per boundary even while exploring the past',async t=>{
  let now=Date.parse('2026-09-30T12:00:00Z');t.mock.method(Date,'now',()=>now);
  const writes:{dates:readonly string[];expiresAt:number}[]=[];
  const h=harness({syncTransitWindow:async window=>{writes.push(window);return {status:'applied',revision:writes.length};}});
  await h.restoration;
  const past=createLocalDayTimeline(Date.parse('2000-01-01T12:00:00Z'),'Europe/Moscow');
  for(let i=0;i<100;i++)h.clockTick(past);
  const current=createLocalDayTimeline(now,'Europe/Moscow');
  assert.deepEqual(writes,[{dates:current.packetDates,expiresAt:current.endUtc}]);
  now=current.endUtc;
  h.clockTick(past);
  assert.deepEqual(writes[1],{dates:createLocalDayTimeline(now,'Europe/Moscow').packetDates,expiresAt:createLocalDayTimeline(now,'Europe/Moscow').endUtc});
  h.clockTick(createLocalDayTimeline(now,'America/New_York'));
  assert.equal(writes.length,3,'a timezone change changes the protected UTC packets');
});

for(const sample of [{error:{code:'not_found'},replaced:false},{error:{code:'offline'},replaced:false},
  {error:undefined,replaced:false},{error:{code:'not_found'},replaced:true}])test(`public refresh failure respects current source: ${sample.error?.code}/${sample.replaced}`,async()=>{
 const {accountId,note,noteRevision,publicRevision,...foreign}=accountNatalChart(97,'7');
 const store=createChartStore({initialPublicChart:foreign});store.projectLibrary([],false);
 let reads=0,reject!:(error:unknown)=>void;
 const h=harness({actualStore:store,realViewSession:true,
  navigation:addressHarness('/chart/'+foreign.id).navigation,savedView:{selectedId:foreign.id,publicChart:foreign},
  chartClient:{async public(){reads++;if(reads===1)return foreign;return new Promise((_,fail)=>{reject=fail;});}}});
 await h.restoration;await tick();h.advanceBackground(50*60000);h.userInput('visibilitychange');await tick();h.userInput('visibilitychange');
 assert.equal(reads,2,'another trigger shares the running refresh');
 if(sample.replaced)store.acceptPublic({...foreign,name:'New source',revision:foreign.revision+1});
 reject(sample.error);await tick();await tick();
 const removed=sample.error?.code==='not_found'&&!sample.replaced;
 assert.equal(store.publicChart===null,removed);
 assert.equal(h.shown.id,removed?'current-transit':foreign.id);
 if(sample.replaced)assert.equal(store.publicChart?.name,'New source');
 await h.stopApplication();
});

for(const boundary of ['timeline','stop'] as const)test(`startup before account readiness yields to ${boundary}`,async()=>{
 let release!:()=>void,restores=0;
 const ready=new Promise<void>(resolve=>{release=resolve;});
 const h=harness({accountReady:ready,restore:async()=>{restores++;return true;},
  initialPresentation:studioPresentation({isTransit:true})});
 if(boundary==='timeline')await h.element('lifetimeToggle').click();else await h.stopApplication();
 release();await h.restoration;await tick();
 assert.equal(restores,0,'a superseded runtime cannot begin restoring old values');
 if(boundary==='timeline'){h.finishModule();await tick();assert.equal(h.lifetime.state.opened,true);}
});

test('an unfinished library refresh does not block a restorable release transition',async()=>{
 let finish!:(value:ReturnType<typeof catalogPage>)=>void,reads=0;
 const h=harness({realViewSession:true,accountSession:{accountId:'1',sessionId:'catalog-pending'},
  chartClient:{catalog(){reads++;return new Promise(resolve=>{finish=resolve;});}}});
 await h.restoration;await tick();assert.equal(reads,1);
 assert.equal(await h.prepareOfflineUpdate(),true,'the existing view is durable while the catalog is still arriving');
 finish(catalogPage([],'1'));await tick();await h.stopApplication();
});

test('a historical absence response with the current card preserves its owned and public view',async t=>{
 const record=accountNatalChart(131),{accountId,note,noteRevision,publicRevision,...publicFields}=record;
 const storage=createAccountLibraryStore({indexedDB:new IDBFactory()});t.after(()=>storage.close());
 const active=await storage.activate(record.accountId);assert.equal(active.status,'stored');if(active.status!=='stored')return;
 await storage.put(active.lease,[record]);
 const store=createChartStore({initialPublicChart:publicFields});store.projectLibrary([],false);
 const h=harness({actualStore:store,realViewSession:true,libraryStorage:storage,accountSession:{accountId:record.accountId,sessionId:'owner'},
  navigation:addressHarness('/chart/'+record.id).navigation,savedView:{selectedId:record.id,publicChart:publicFields},
  chartClient:deletionClient(record,{async remove(input){return {...input,catalogMarker:'2',chart:record,outcome:{kind:'absent',chartId:input.chartId}};}})});
 await h.restoration;await h.removeChart(record.id);await tick();h.flushView();
 assert.equal(store.publicChart?.id,record.id);assert.equal(h.cards[0]?.id,record.id);assert.equal(h.shown.id,record.id);
 await h.stopApplication();
});

test('30 application start-stop cycles release connection and projection subscriptions',async()=>{
 const listeners=new Set<(mode:'online'|'offline'|'server')=>void>();
 const connection:ConnectionSource={current:'online',subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener);};}};
 for(let run=0;run<30;run++){
  const h=harness({connection});await h.restoration;await tick();
  await h.stopApplication();await h.stopApplication();await tick();
  assert.equal(listeners.size,0,`cycle ${run}: no retained connection subscribers`);
  const renders=h.renders;
  h.highlight.set(h.highlight.current==='glow'?'outline':'glow');
  h.panels.setRight(!h.panels.right);h.workspace.setScreen('account');await tick();
  assert.equal(h.renders,renders,`cycle ${run}: closed projection stays closed`);
 }
});

test('restored application fills one missing card once without changing the selected chart',async t=>{
 const storage=createAccountLibraryStore({indexedDB:new IDBFactory()}),record=accountNatalChart(91);
 let reads=0,writes=0;const put=storage.put.bind(storage);
 t.mock.method(storage,'put',async(...args:Parameters<typeof put>)=>{writes+=args[1].filter(chart=>chart.id===record.id).length;return put(...args);});
 const h=harness({charts:[{id:'current-transit',source:'transit',personality:[1],design:[]}],libraryStorage:storage,chartClient:deletionClient(record,{own:async()=>{reads++;return {chart:record,catalogMarker:'1'};}}),
  accountSession:{accountId:record.accountId,sessionId:'fill-session'}});t.after(()=>h.stopApplication());
 await h.restoration;
 for(let i=0;i<100 && !h.cards.some(chart=>chart.id===record.id);i++)await tick();
 assert.equal(reads,1);assert.equal(writes,1,'already committed fill must not persist a second time during acceptance');
 assert.ok(h.cards.some(chart=>chart.id===record.id));assert.notEqual(h.shown?.id,record.id);
 await tick();assert.equal(reads,1);assert.equal(writes,1);
});

test('stopping one tab releases its resources without revoking a live peer library',async t=>{
 const indexedDB=new IDBFactory(),storage=createAccountLibraryStore({indexedDB}),peer=createAccountLibraryStore({indexedDB});
 t.after(()=>{storage.close();peer.close();});
 const record=accountNatalChart(),h=harness({libraryStorage:storage,accountSession:{accountId:record.accountId,sessionId:'active'},chartClient:deletionClient(record)});
 await h.restoration;await tick();
 const before=await peer.activate(record.accountId);assert.equal(before.status,'stored');
 await h.stopApplication();await tick();await tick();
 assert.deepEqual((await peer.read())?.lease,before.lease,'a tab closing does not log out its peer');
});

test('a lazy moment module arriving after stop cannot create a new controller',async()=>{
 const h=harness();await h.restoration;await tick();
 await h.element('lifetimeToggle').click();await h.stopApplication();
 h.finishModule();await tick();
 assert.equal(h.lifetime,undefined,'closed runtime cannot acquire late resources');
});

test('late offline installer receives one foreground allowance when shared storage is unavailable',async t=>{
 const storage=createAccountLibraryStore({indexedDB:null}),probe=journalProbe();
 let mode:ConnectionSource['current']='offline',installs=0,checks=0,stops=0;
 const listeners=new Set<(mode:ConnectionSource['current'])=>void>(),connection:ConnectionSource={get current(){return mode;},subscribe(fn){listeners.add(fn);return()=>{listeners.delete(fn);};}};
 const h=harness({libraryStorage:storage,journal:probe.journal,connection});t.after(()=>h.stopApplication());
 await h.restoration;await tick();
 h.attachReleaseCheck({async install(){installs++;},async check(){checks++;},observe(){},stop(){stops++;}});
 await tick();assert.equal(installs,0,'offline startup waits for an eligible foreground');
 mode='online';for(const listener of listeners)listener(mode);await tick();await tick();
 assert.equal(installs,1);assert.equal(checks,0,'the fallback does not authorize a release update');
 for(let n=0;n<3;n++){h.userInput('visibilitychange');h.attachJournal(probe.journal);await tick();}
 assert.equal(installs,1);assert.equal(checks,0);
 await h.stopApplication();assert.equal(stops,1);
});

test('an installer attached after unavailable app coordination is already paused still receives its allowance',async t=>{
 const storage=createAccountLibraryStore({indexedDB:null}),probe=journalProbe();let installs=0;
 const h=harness({libraryStorage:storage,journal:probe.journal});t.after(()=>h.stopApplication());
 await h.restoration;await tick();await tick();
 h.attachReleaseCheck({async install(){installs++;},async check(){assert.fail('no automatic update permission');},observe(){},stop(){}});
 await tick();assert.equal(installs,1);
});

test('a late first install does not wait an hour after the journal already checked the app scope',async t=>{
 const probe=journalProbe();let installs=0;
 const h=harness({journal:probe.journal});t.after(()=>h.stopApplication());
 await h.restoration;await tick();await tick();
 h.attachReleaseCheck({async install(){installs++;},async check(){},observe(){},stop(){}});
 await tick();assert.equal(installs,1);
});
