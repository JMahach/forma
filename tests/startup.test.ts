import { createLayoutObserver } from '../src/ui/layout/resize-observer.ts';
import {clientFailureReason,parseClientContextStep,CLIENT_REPORT_REASONS} from '../shared/client-report-contract.ts';
import {createJournal} from '../src/journal.ts';
import {createCalculationUpdates} from '../src/data/calculation-updates.ts';
import {createCalculationClients} from '../src/data/calculation-clients.ts';
import {createDiagnosticClient} from '../src/data/diagnostic-client.ts';
import {createDiagnosticQueue} from '../src/data/diagnostic-queue.ts';
import {createDiagnosticHandler,DIAGNOSTIC_HTTP_RESERVED_BYTES} from '../server/http/diagnostics.ts';
import {createJournalRuntime} from '../server/journal/runtime.ts';
import {captureResponse} from './helpers/http-response.ts';
import {IDBFactory} from 'fake-indexeddb';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import type {IncomingMessage} from 'node:http';
import type {ClientReport} from '../shared/client-report-contract.ts';
import {accountNatalChart} from './helpers/account-chart.ts';
import { createChartStore } from '../src/data/chart-store.ts';
import { STORAGE_KEY } from '../src/data/storage.ts';
import { createNavigation } from '../src/state/navigation.ts';
import { createStoragePressure } from '../src/data/storage-pressure.ts';
import { viewForRoute } from '../src/state/view-session.ts';
import { getConnectionMode, subscribeConnection } from '../src/data/http-transport.ts';
import { actionAvailability } from '../src/ui/action-state.ts';
import { attachPanelKeyboard } from '../src/views/side-panel-controls.ts';
import { readModuleSource } from './helpers/module-source.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STUDIO_FOOTPRINT, MANDALA_FRAME } from '../src/scene/geometry/frames.ts';
import { attachGestures } from '../src/scene/gestures.ts';
import { attachCameraControls } from '../src/views/camera-controls.ts';
import { attachLoadingPreview } from '../src/views/loading-preview.ts';
import { lifeTimelineForChart } from '../src/domain/cycles.ts';
import { createViewStore } from '../src/data/view-store.ts';
import { attachPageGestures } from '../src/ui/page-gestures.ts';
import { createPanelState } from '../src/state/panels.ts';
import { createWorkspaceState } from '../src/state/workspace.ts';
import { createStudioLayout } from '../src/ui/layout/studio-controller.ts';
import { attachChartLibrary, createChartLibraryView } from '../src/views/library.ts';
import * as chartSession from '../src/state/chart-session.ts';
import { libraryDom } from './helpers/library-dom.ts';
import * as cameraModule from '../src/scene/camera.ts';
import { createCameraView } from '../src/scene/camera-view.ts';
import { holdLoadingContent, commitLoadingLayout } from '../src/views/chart-loading.ts';
import { studioPresentation } from '../src/ui/studio-presentation.ts';
import { eligibleCycleChart } from '../src/domain/cycles.ts';
import { canExploreNatalDay } from '../src/state/natal-day.ts';
import { originalNatalDayMoment } from '../src/domain/natal-day.ts';
import { createCameraChangeHandler } from '../src/views/camera-controls.ts';
import { libraryRecordAtMinute, natalDayFixture } from './fixtures/natal-day.ts';
import { ACTIVATION_COLUMN_REVEAL_DISTANCE } from '../src/scene/geometry/activation-layout.ts';

import type { TestStub } from './helpers/test-stub.ts';
import type { SavedView } from '../src/data/view-store.ts';
import type { TransitDayClient, createTransitDayClient } from '../src/data/transit-day-client.ts';

type RealStartupPorts = Parameters<typeof import('../src/app.ts').startApp>[0];
// Startup uses these layout commands for effects; their production return values
// are not consumed before the real application takes over.
type LayoutFixture = Pick<RealStartupPorts['layout'], 'frame'>
  & Partial<Pick<RealStartupPorts['layout'], 'phone'>> & {
    readViewport?(): Pick<ReturnType<RealStartupPorts['layout']['readViewport']>, 'top' | 'height'>;
    insets(): Pick<ReturnType<RealStartupPorts['layout']['insets']>, 'side' | 'top' | 'bottom'>;
    refresh(...args: Parameters<RealStartupPorts['layout']['refresh']>): void;
    setTimelineKind(...args: Parameters<RealStartupPorts['layout']['setTimelineKind']>): void;
    subscribeViewport(...args: Parameters<RealStartupPorts['layout']['subscribeViewport']>): void;
  };
type DayOptions = NonNullable<Parameters<typeof createTransitDayClient>[0]>;
type ViewFixture = TestStub<Partial<SavedView>>;
type StoreFixture = TestStub<RealStartupPorts['store']>;
type AccountFixture = Pick<RealStartupPorts['account'], 'ready' | 'snapshot' | 'setVisible'>
  & Partial<Pick<RealStartupPorts['account'], 'getSession'>> & {loadingOnly?: boolean};
type StartupPorts = Omit<RealStartupPorts, 'dayClient' | 'calculationClients' | 'layout' | 'viewStore' | 'store' | 'account' | 'savedView'> & {
  dayClient: Partial<TransitDayClient>;
  calculationClients: {transit: Partial<TransitDayClient>; natal: object; cycles: object};
  layout: LayoutFixture;
  viewStore: {read(): ViewFixture | null; write?(value: Partial<SavedView>): boolean};
  store: StoreFixture; account: AccountFixture; savedView: ViewFixture | null; previewLoading?: boolean;
};
type LibraryOptions = Parameters<typeof attachChartLibrary>[0];
type LibraryFixture = Omit<TestStub<LibraryOptions>, 'getCharts'> & {
  getCharts(): readonly TestStub<ReturnType<LibraryOptions['getCharts']>[number]>[];
};
type StartupLocation = Partial<Pick<Location, 'href' | 'pathname' | 'port' | 'hostname' | 'search' | 'reload'>>;
type StartupExports = {
  connectJournal(journal: Pick<ReturnType<typeof createJournal>,'begin'|'setAccount'>):Promise<void>;
  connectOfflineUpdates(refresh:()=>void):void;
};
type LoadApp = () => Promise<{startApp(ports: StartupPorts): unknown}>;
type AccountFactory = (options: Parameters<typeof import('../src/account.ts').attachAccount>[0]) => AccountFixture;

interface FakeStyle {
  [name: `--${string}`]: string;
  transform: string; visibility: string;
  setProperty(name: string, value: string): void;
  removeProperty(name: string): void;
}
interface FakeNode {
  id: string; ownerDocument: FakeDocument; dataset: DOMStringMap; style: FakeStyle;
  hidden: boolean; inert: boolean; textContent: string; innerHTML: string; parentElement: FakeNode | null;
  prepend(child: {parentElement: unknown}): void; contains(target: unknown): boolean; closest(selector: string): FakeNode | null;
  focus(): void; addEventListener(type: string, listener: (event: FakeEvent) => void): void;
  removeEventListener(type: string, listener: (event: FakeEvent) => void): void;
  send(type: string, extra?: Record<string, unknown>): FakeEvent; click(): FakeEvent; listenerCount(type: string): number;
  querySelector(selector: string): FakeNode | null; querySelectorAll(selector: string): FakeNode[];
  setAttribute(name: string, value: unknown): void; getAttribute(name: string): string | null; removeAttribute(name: string): void;
  classList: {contains(name: string): boolean; toggle(name: string, value: boolean): void};
  getBoundingClientRect(): {left: number; right: number; top: number; bottom: number; width: number; height: number};
}
interface FakeEvent {
  target: FakeNode; type: string; pointerId: number; pointerType: string; isPrimary: boolean; button: number;
  clientY: number; timeStamp: number; detail: number; defaultPrevented: boolean;
  preventDefault(): void; stopPropagation(): void;
}
interface FakeDocument extends EventTarget {
  activeElement: unknown;
  defaultView: EventTarget & {innerHeight: number; getComputedStyle(): {bottom: string}};
  body: {dataset: Record<string, string>}; hidden: boolean;
  createElement: ReturnType<typeof libraryDom>['document']['createElement'];
  getElementById(id: string): FakeNode;
  querySelector(selector: string): FakeNode | null;
  querySelectorAll(selector: string): FakeNode[];
}


// Run the entry module with its browser ports, leaving its actual initialization
// order intact while replacing the network-loaded application.
const source = readModuleSource(new URL('../src/startup.ts', import.meta.url))
  .replace(/^import .*;\n/gm, '').replace(/^export /gm,'').replace("import('./app.ts')", 'loadApp()');
const evaluate = new (Object.getPrototypeOf(async function () {}).constructor)(
  'createLayoutObserver', 'clientFailureReason', 'parseClientContextStep', 'CLIENT_REPORT_REASONS', 'createStoragePressure', 'createCalculationUpdates', 'createNavigation', 'viewForRoute', 'history', 'window', 'getConnectionMode', 'actionAvailability', 'attachAccount', 'attachPanelKeyboard', 'attachGestures', 'attachCameraControls', 'attachLoadingPreview', 'lifeTimelineForChart', 'holdLoadingContent', 'commitLoadingLayout', 'studioPresentation', 'eligibleCycleChart', 'canExploreNatalDay', 'originalNatalDayMoment', 'createCameraChangeHandler', 'createCamera', 'createCameraView', 'MANDALA_FRAME', 'ACTIVATION_COLUMN_REVEAL_DISTANCE', 'createChartLibraryView', 'resolveSelectedChartId', 'STUDIO_FOOTPRINT', 'createPanelState', 'createWorkspaceState', 'getComputedStyle', 'attachPageGestures', 'document', 'ResizeObserver', 'createCalculationClients', 'createStudioLayout', 'createToast', 'createViewStore', 'createChartStore', 'loadApp', 'location', source + '\nreturn {connectJournal,connectOfflineUpdates};') as (...ports: unknown[]) => Promise<StartupExports>;
function tabStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; }, clear() { values.clear(); },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { values.set(key, String(value)); }, removeItem(key) { values.delete(key); },
  };
}
const run = (guard: typeof attachPageGestures, document: FakeDocument,
  observer: new (...args: unknown[]) => Pick<ResizeObserver, 'observe' | 'disconnect'>,
  dayFactory: (options: DayOptions) => Partial<TransitDayClient>,
  layoutFactory: (options: Parameters<typeof createStudioLayout>[0]) => LayoutFixture,
  toastFactory: () => RealStartupPorts['toast'], viewFactory: (options:Parameters<typeof createViewStore>[0]) => StartupPorts['viewStore'],
  storeFactory: (options:Parameters<typeof createChartStore>[0]) => StoreFixture, loadApp: LoadApp, location: StartupLocation = {},
  storage = tabStorage(), createCamera = cameraModule.createCamera,
  attachAccount: AccountFactory = ({saved, loadingOnly}) => ({ready: Promise.resolve(), snapshot: saved ?? null, loadingOnly, setVisible() {}}),
  updateFactory:(options:Parameters<typeof createCalculationUpdates>[0])=>Pick<ReturnType<typeof createCalculationUpdates>,'refresh'|'onTimelineChanged'>
    =()=>({refresh:async()=>({status:'unavailable'}),onTimelineChanged:async()=>({status:'unconfirmed'})})) => {
  const address = {...location, href: location.href || 'http://localhost:3636/'};
  const attachPreview = (options: Parameters<typeof attachLoadingPreview>[0]) => attachLoadingPreview({...options, getStorage: () => storage});
  const events = new EventTarget();
  const navigate = (_state: unknown, _title: string, path?: string | URL | null) => {if (path != null) address.pathname = String(path);};
  const history = {pushState: navigate, replaceState: navigate};
  const clients = (options: {transit: DayOptions}) => ({transit: dayFactory(options.transit), natal: {}, cycles: {}});
  // Evaluated production code consumes these explicitly partial ports only at this boundary.
  return evaluate((refresh: () => void) => createLayoutObserver(refresh, {Observer: observer as typeof ResizeObserver}), clientFailureReason, parseClientContextStep, CLIENT_REPORT_REASONS, createStoragePressure, updateFactory, createNavigation, viewForRoute, history, events, getConnectionMode, actionAvailability, attachAccount, attachPanelKeyboard, attachGestures, attachCameraControls, attachPreview, lifeTimelineForChart, holdLoadingContent, commitLoadingLayout, studioPresentation, eligibleCycleChart, canExploreNatalDay, originalNatalDayMoment, createCameraChangeHandler, createCamera, createCameraView, MANDALA_FRAME, ACTIVATION_COLUMN_REVEAL_DISTANCE, createChartLibraryView, chartSession.resolveSelectedChartId, STUDIO_FOOTPRINT, createPanelState, createWorkspaceState,
    () => ({ getPropertyValue: () => '296.8px' }), guard, document, observer, clients, layoutFactory, toastFactory, viewFactory, storeFactory, loadApp, address);
};


function startupDocument(overrides: Record<string, object> = {}) {
  const library = libraryDom();
  overrides = { chartList: library.chartList, libraryCount: library.libraryCount, nowButton: library.nowButton, ...overrides };
  const nodes = new Map<string, FakeNode>();
  const element = (id: string): FakeNode => {
    if (!nodes.has(id)) {
      const classes = new Set<string>(), attributes = new Map<string, string>(), listeners = new Map<string, Set<(event: FakeEvent) => void>>();
      const defaults: FakeNode = { id, ownerDocument: document, dataset: {}, style: { transform: '', visibility: '', setProperty(name: string, value: string) { Reflect.set(this, name, value); }, removeProperty(name: string) { Reflect.deleteProperty(this, name); } },
        hidden: false, inert: false, textContent: '', innerHTML: '', parentElement: null,
        prepend(child: { parentElement: unknown }) { child.parentElement = this; },
        contains(target: unknown) {
          for (let node = target; node && typeof node === 'object'; node = (node as { parentElement?: unknown }).parentElement) {
            if (node === this) return true;
          }
          return false;
        },
        closest(selector: string) {
          const ids = selector.split(',').map(value => value.trim().slice(1));
          for (let node: FakeNode | null = this; node; node = node.parentElement) if (ids.includes(node.id)) return node;
          return null;
        },
        focus() { document.activeElement = this; },
        addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener); },
        removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
        send(type: string, extra: Record<string, unknown> = {}) {
          const event: FakeEvent = { target: this, type, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0,
            clientY: 300, timeStamp: 0, detail: type === 'click' ? 1 : 0, defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
          for (const listener of [...listeners.get(type) || []] as const) listener(event);
          return event;
        },
        click() { return this.send('click', { detail: 0 }); },
        listenerCount(type) { return listeners.get(type)?.size || 0; }, querySelector: () => null, querySelectorAll: () => [],
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute: name => attributes.get(name) ?? null, removeAttribute: name => attributes.delete(name),
        classList: { contains: (name: string) => classes.has(name), toggle(name, value) { if (value) classes.add(name); else classes.delete(name); } },
        getBoundingClientRect() {
          const left = id === 'canvasWrap' ? parseFloat(element('studio').style['--studio-left-space']) || 0 : 0;
          const right = id === 'canvasWrap' ? parseFloat(element('studio').style['--studio-right-space']) || 0 : 0;
          return { left: 75 + left, right: 1475 - right, top: 0, bottom: 900, width: id === 'library' ? 296.8 : 1400 - left - right, height: 900 };
        },
      };
      const node = overrides[id] || {};
      for (const [name, value] of Object.entries(defaults)) if (!(name in node)) Reflect.set(node, name, value);
      nodes.set(id, node as FakeNode);
    }
    return nodes.get(id)!;
  };
  const document: FakeDocument = Object.assign(new EventTarget(), { activeElement: null as unknown, defaultView: Object.assign(new EventTarget(), { innerHeight: 900, getComputedStyle: () => ({ bottom: '0px' }) }), body: { dataset: { calculationVersion: 'a'.repeat(64) } }, hidden: false,
    createElement: library.document.createElement, getElementById: element,
    querySelector: (selector: string) => {
      const id = ({ '.app-shell': 'shell', '.chart-tools': 'chartTools', '#summaryScreen .summary-heading': 'summaryHeading' } as Record<string, string>)[selector];
      return id ? element(id) : null;
    },
    querySelectorAll: (selector: string) => selector.split(',').map((s: string) => (({ '.library': 'library', '.chart-summary': 'chartSummary', '.chart-view-tools': 'chartViewTools', '.canvas-wrap': 'canvasWrap' } as Record<string, string>)[s.trim()])).filter((id): id is string => Boolean(id)).map(element) });
  for (const id of ['bodygraph', 'chartLoadingArt'] as const) Object.assign(element(id), {
    viewBox: { baseVal: { x: 0, y: 0, width: 640, height: 820 } },
    preserveAspectRatio: { baseVal: { align: 6, meetOrSlice: 1 } },
  });
  element('summaryChartCaption').parentElement = element('summaryHeading');
  element('lifetimeControls').querySelector = (selector: string) => selector === '.lifetime-heading' ? element('lifetimeHeading') : null;
  element('canvasWrap').parentElement = element('studio');
  element('studio').parentElement = element('workspace');
  element('shell').dataset.booting = 'true';
  return { document, element, rows: library.children };
}

// Real layout code reads only these three style members from the fake DOM.
const layoutStyle: Pick<CSSStyleDeclaration, 'scrollPaddingTop' | 'scrollPaddingLeft' | 'getPropertyValue'> = {
  scrollPaddingTop: '112px', scrollPaddingLeft: '4px', getPropertyValue: () => '0px',
};
const layoutStub = () => ({ frame: () => STUDIO_FOOTPRINT.frame, insets: () => ({ side: 4, top: 112, bottom: 68 }), refresh() {}, setTimelineKind() {}, subscribeViewport() {} });

const emptyStore = (options: Parameters<typeof createChartStore>[0] = {}) => createChartStore({...options,getStorage:()=>tabStorage()});

function assertPageZoomBlocked(document: EventTarget) {
  const zoom = Object.assign(new Event('wheel', { cancelable: true }), { ctrlKey: true });
  document.dispatchEvent(zoom);
  assert.equal(zoom.defaultPrevented, true, 'native zoom is guarded before the application loads and after failure');
}

test('startup reads the tab once and prefetches only a day that owns the saved view', async () => {
  for (const [savedView, needsDay] of [
    [null, true],
    [{ selectedId: 'current-transit', transit: { live: false } }, true],
    [{ selectedId: 'current-transit', lifetime: { opened: true, mode: 'lifetime' } }, false],
    [{ selectedId: 'personal' }, false],
    [{ selectedId: 'personal', lifetime: { opened: true, mode: 'lifetime', personalPreview: true, personalLive: false } }, false],
    [{ selectedId: 'personal', lifetime: { opened: true, mode: 'lifetime', personalLive: true } }, true],
    [{ selectedId: 'personal', lifetime: { opened: true, mode: 'lifetime', personalLive: true }, returns: { eventId: 'exact' } }, false],
  ] as const) {
    let reads = 0, creates = 0; let options: DayOptions | undefined, received: StartupPorts | undefined;
    const toast = () => {}, layout = layoutStub(), client = {};
    const viewStore = { read() { reads++; return savedView; } };
    const { document } = startupDocument();
    await run(attachPageGestures, document, class { observe() {} disconnect() {} }, value => { options = value; return client; }, () => layout,
      () => toast, () => { creates++; return viewStore; }, emptyStore, async () => {
        assertPageZoomBlocked(document);
        return { startApp(value) { received = value; } };
      });
    assert.equal(options!.calculationVersion, 'a'.repeat(64));
    assert.equal(Boolean(options!.initialDate), needsDay, JSON.stringify(savedView));
    assert.equal(creates, 1); assert.equal(reads, 1);
    const { navigation, storagePressure, calculationClients, calculationUpdates, account, panels, workspace, store, libraryView, camera, cameraView, gestures, previewLoading, initialPresentation, releaseLoadingContent, ...existingPorts } = received!;
    assert.equal(calculationClients.transit, client);
    assert.equal(typeof storagePressure?.write, 'function');
    assert.deepEqual(existingPorts, { dayClient: client, layout, toast, viewStore, savedView });
  }
});

for (const failure of ['import', 'initialization'] as const) {
  test(`${failure} failure replaces endless loading with an explicit reload action`, async () => {
    const attributes = new Map([['aria-busy', 'true']]);
    const canvas = { dataset: { chartState: 'loading' }, setAttribute: (name: string, value: string) => attributes.set(name, value) };
    const status = { textContent: 'Загружаем карту…' };
    let retry: (() => void) | undefined, reloads = 0;
    const button = { hidden: true, addEventListener(type: string, callback: () => void) { assert.equal(type, 'click'); retry = callback; } };
    const nodes = { canvasWrap: canvas, chartLoadingStatus: status, chartLoadingRetry: button };
    const { document } = startupDocument(nodes);
    const error = new Error('Startup failed');
    const savedView = { selectedId: 'current-transit', camera: { x: -100, y: -100, k: 1.7 } };
    let preparedTransform = '';
    const loadApp = async () => {
      preparedTransform = document.getElementById('chartLoadingArt').style.transform;
      assertPageZoomBlocked(document);
      if (failure === 'import') throw error;
      return { startApp() { throw error; } };
    };
    await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), layoutStub, () => () => {},
      () => ({ read: () => savedView }), emptyStore, loadApp, { reload() { reloads++; } });
    assertPageZoomBlocked(document);
    assert.equal(canvas.dataset.chartState, 'error');
    assert.equal(document.querySelector('.app-shell')!.dataset.shellReady, undefined, 'fatal startup cannot expose half-attached controls');
    assert.equal(document.getElementById('chartLoadingArt').getAttribute('hidden'), '', 'fatal application failure shows a plain background even after camera preparation');
    assert.match(preparedTransform, /^matrix3d\(/, 'camera is already prepared before either failure');
    assert.equal(document.getElementById('chartLoadingArt').style.transform, preparedTransform,
      'failure keeps the prepared preview in place instead of reverting to the server position');
    assert.equal(document.getElementById('chartLoadingMessage').hidden, false);
    assert.equal(attributes.get('aria-busy'), 'false');
    assert.equal(document.getElementById('chartLoadingStatus').textContent, 'Не удалось загрузить приложение');
    assert.equal(document.getElementById('chartLoadingRetry').hidden, false);
    assert.equal(reloads, 0, 'a startup failure must not create an automatic reload loop');
    retry!();
    assert.equal(reloads, 1);
  });
}


test('saved panel space and visible shells are restored before the application import finishes', async () => {
  for (const [left, right, screen, expectedWidth, phone = false] of [
    [false, false, 'chart', 1400], [true, false, 'chart', 1103.2],
    [false, true, 'chart', 1103.2], [true, true, 'chart', 806.4],
    [true, true, 'charts', 1103.2],
    [true, true, 'chart', 1400, true], [false, true, 'chart', 1400, true],
  ] as const) {
    const { document, element } = startupDocument();
    const savedView = { selectedId: 'current-transit', panels: { left, right }, workspace: screen };
    let layout: ReturnType<typeof createStudioLayout> | undefined, received: StartupPorts | undefined;
    let initial: {left: boolean; right: boolean; screen: string | undefined; width: number; booting: string | undefined; captionHost: FakeNode | null; studioInert: boolean} | undefined;
    let bootingDuringPlacement: string | undefined;
    await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), (options) => {
      bootingDuringPlacement = element('shell').dataset.booting;
      layout = createStudioLayout({ ...options, viewport: null, media: { matches: phone } as MediaQueryList,
        readStyle: () => layoutStyle as CSSStyleDeclaration });
      return layout;
    }, () => () => {}, () => ({ read: () => savedView }), emptyStore, async () => {
      initial = { left: element('library').classList.contains('open'), right: element('chartSummary').classList.contains('open'),
        screen: element('studio').dataset.workspaceScreen, width: element('canvasWrap').getBoundingClientRect().width, booting: element('shell').dataset.booting,
        captionHost: element('summaryChartCaption').parentElement, studioInert: element('studio').inert };
      return { startApp(value) { received = value; } };
    });
    assert.equal(initial!.left, left, 'the navigation is present while app.ts is still loading');
    assert.equal(initial!.studioInert, Boolean(phone && left), 'only the phone navigation blocks interaction with the chart area behind it');
    assert.equal(initial!.right, right && screen === 'chart' && !(phone && left), 'only the chart workspace projects the saved right panel');
    assert.equal(initial!.screen, screen);
    assert.equal(initial!.captionHost, element('summaryHeading'), 'the loading caption already occupies its ready-layout host');
    assert.ok(Math.abs(initial!.width - expectedWidth) < 1e-7, 'the loading preview already occupies the saved free area');
    assert.equal(bootingDuringPlacement, 'true', 'initial projection is applied with transitions disabled');
    assert.equal(initial!.booting, undefined, 'after placement the loading menu can respond with normal motion');
    assert.deepEqual(received!.panels.snapshot, { left, right: right && !(phone && left) }, 'the app inherits the same restored owner');
    assert.equal(received!.workspace.screen, screen);
    layout!.destroy();
  }
});


test('loading navigation keeps the tab result outside the saved list and retains the current section', async () => {
  const chart = {...libraryRecordAtMinute(natalDayFixture(),754),id:'saved',name:'Анна'};
  for (const [screen, selectedId, expected] of [['chart', 'saved', 'saved'], ['chart', 'missing', 'current-transit'],
    ['library', 'saved', null], ['charts', 'saved', null], ['account', 'saved', null]] as const) {
    const { document, element, rows } = startupDocument();
    let store:ReturnType<typeof createChartStore>;
    let storeReads = 0, attached = false; let loadingError: unknown;
    const savedView = { selectedId, temporaryChart:chart, workspace: screen, panels: { left: true, right: false } };
    await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), layoutStub,
      () => () => {}, () => ({ read: () => savedView }), options => { storeReads++; store=emptyStore(options); return store; }, async () => {
        try {
        assert.equal(element('libraryCount').textContent, '0');
        assert.equal(rows.length, 0);
        assert.doesNotMatch(element('chartList').innerHTML, /Анна/);
        assert.equal(store.temporaryChart?.id, chart.id);
        assert.equal(element('nowButton').getAttribute('aria-pressed'), String(expected === 'current-transit'));
        for (const [id, section] of [['openKnowledge', 'library'], ['openAllCharts', 'charts'], ['openAccount', 'account']] as const) {
          assert.equal(element(id).getAttribute('aria-pressed'), String(screen === section));
          assert.equal(element(id).getAttribute('aria-current'), screen === section ? 'page' : null);
        }
        assert.equal(element('library').classList.contains('open'), true);
        assert.equal(element('chartSummary').classList.contains('open'), false);
        return { startApp(ports) {
          assert.equal(ports.store, store, 'application receives the already-read library owner');
          try {
            const libraryOptions = { getCharts: () => store.displayCharts, removeChart: undefined, getConnectionMode, subscribeConnection,
              panels: ports.panels, view: ports.libraryView, document: document as unknown as Document,
              session: { selectedId }, getSelectedId: () => expected } satisfies LibraryFixture;
            // Only command attachment is exercised; unused event callbacks are absent.
            attachChartLibrary(libraryOptions as unknown as LibraryOptions);
            assert.equal(rows.length, 0, 'attaching real library commands keeps the temporary result outside the menu');
            attached = true;
          } catch (error) { loadingError = error; }
        } };
        } catch (error) { loadingError = error; throw error; }
      });
    assert.ifError(loadingError); assert.equal(attached, true);
    assert.equal(storeReads, 1);
  }
});


test('saved camera and Mandala are projected onto the preview before application loading and handed over intact', async () => {
  const { document, element } = startupDocument();
  const savedView = { selectedId: 'current-transit', mandala: true, panels: { left: false, right: true },
    camera: { x: -100, y: -100, k: 1.7 } };
  let loadingView: string | undefined, received: StartupPorts | undefined, loadingError: unknown;
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), layoutStub,
    () => () => {}, () => ({ read: () => savedView }), emptyStore, async () => {
      try {
        const canvas = element('canvasWrap'), art = element('chartLoadingArt');
        assert.equal(canvas.classList.contains('has-mandala'), true);
        assert.equal(canvas.style['--mandala-reveal'], '1');
        assert.equal(canvas.style['--activation-column-offset'], `${ACTIVATION_COLUMN_REVEAL_DISTANCE}px`);
        assert.equal(element('mandalaSwitch').getAttribute('aria-checked'), 'true');
        assert.equal(art.style.visibility, 'visible');
        assert.equal(element('fitButton').hidden, false, 'saved zoom already projects the Home tool');
        assert.equal(art.style.transform, element('bodygraph').style.transform);
        loadingView = art.style.transform;
      } catch (error) { loadingError = error; throw error; }
      return { startApp(ports) { received = ports; } };
    });
  assert.ifError(loadingError);
  assert.ok(received!.camera); assert.ok(received!.cameraView);
  assert.ok(Math.abs(received!.camera.getView().k / received!.camera.getFittedView().k - 1.7) < 1e-9);
  assert.equal(element('chartLoadingArt').style.transform, loadingView, 'handoff retains the already painted projection');
});


test('the Preview button holds the next startup without importing the application or fetching a day', async () => {
  for (const hostname of ['localhost', '127.0.0.1', '192.168.1.124'] as const) {
    const storage = tabStorage(); let imports = 0, reloads = 0; let options: DayOptions | undefined;
    const location = { hostname, port: '3636', href: `http://${hostname}:3636/`, reload() { reloads++; } };
    const boot = async (document: FakeDocument) => run(attachPageGestures, document, class { observe() {} disconnect() {} }, value => { options = value; return {}; }, layoutStub,
      () => () => {}, () => ({ read: () => null }), emptyStore, async () => { imports++; return { startApp() {} }; }, location, storage);
    const first = startupDocument();
    await boot(first.document);
    assert.equal(imports, 1, 'an untouched tab loads the application');
    first.element('toggleLoadingPreview').click();
    assert.equal(reloads, 1, 'only the explicit button asks for a reload');
    const { document, element } = startupDocument();
    await boot(document);
    assert.equal(imports, 1, 'button-enabled preview remains the real pre-import scene after reload');
    assert.equal(options!.initialDate, null, 'the held preview has no data consumer');
    assert.equal(element('toggleLoadingPreview').getAttribute('aria-pressed'), 'true');
    assert.equal(element('shell').dataset.booting, undefined, 'user interactions can animate after initial placement');
  }
});

test('legacy preview URLs still start the real application in a fresh tab', async () => {
  const { document, element } = startupDocument(); let imported = false; let options: DayOptions | undefined;
  const search = '?preview=loading&fps=1&perf=1&controls=5&palette=gold';
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, value => { options = value; return {}; }, layoutStub,
    () => () => {}, () => ({ read: () => null }), emptyStore, async () => { imported = true; return { startApp() {} }; },
    { port: '3636', href: `http://localhost:3636/${search}`, search });
  assert.equal(imported, true);
  assert.ok(options!.initialDate, 'an obsolete link cannot suppress normal day loading');
  assert.equal(element('toggleLoadingPreview').getAttribute('aria-pressed'), 'false');
});

test('early loading controls update and persist the tab while application import is pending', async () => {
  const saved: Partial<SavedView> = { version: 1, selectedId: 'current-transit', panels: { left: false, right: false }, mandala: false,
    transit: { live: false, date: '2026-10-04', timeZone: 'UTC', index: 123 }, planets: { selectedPlanets: ['sun'], selectedDesignPlanets: [] } };
  const { document, element } = startupDocument(); const writes: Partial<SavedView>[] = []; const handoff: {ports?: StartupPorts} = {};
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), layoutStub,
    () => () => {}, () => ({ read: () => saved, write: value => { writes.push(value); return true; } }), emptyStore, async () => {
      element('mandalaSwitch').click();
      element('lifetimeToggle').click();
      element('summarySwitch').click();
      assert.equal(element('mandalaSwitch').getAttribute('aria-checked'), 'true');
      assert.equal(element('lifetimeToggle').getAttribute('aria-pressed'), 'true');
      assert.equal(element('studio').dataset.initialTimeline, 'lifetime');
      assert.equal(writes.at(-1)!.panels!.right, true);
      assert.equal(writes.at(-1)!.mandala, true);
      assert.equal(writes.at(-1)!.lifetime!.opened, true);
      assert.deepEqual(writes.at(-1)!.transit, saved.transit);
      assert.deepEqual(writes.at(-1)!.planets, saved.planets);
      return { startApp(ports) { handoff.ports = ports; } };
    });
  const received = handoff.ports;
  assert.ok(received, 'startup handed off without hiding a failed assertion as an import error');
  assert.equal(received!.savedView!.mandala, true);
  assert.equal(received!.savedView!.lifetime!.opened, true);
});



test('saved timeline geometry and tool visibility exist before the application import', async () => {
  const personal = libraryRecordAtMinute(natalDayFixture(), 754);

  for (const [saved, panel, kind, heading] of [
    [{ selectedId: 'current-transit' }, 'transit', 'day', true],
    [{ selectedId: 'current-transit', lifetime: { opened: true, mode: 'lifetime' } }, 'lifetime', 'chronicle', true],
    [{ selectedId: personal.id, lifetime: { opened: true, mode: 'lifetime' } }, 'lifetime', 'day', false],
    [{ selectedId: personal.id, natalDay: { opened: true } }, 'natal-day', 'natal-day', false],
    [{ selectedId: personal.id }, 'natal-day', 'natal-day', false],
    [{ selectedId: personal.id, natalDay: { opened: false } }, 'none', 'day', false],
    [{ selectedId: personal.id, returns: { opened: true } }, 'lifetime', 'day', false],
    [{ selectedId: 'manual' }, 'transit', 'day', true],
    [{ selectedId: 'missing', lifetime: { opened: true, mode: 'lifetime' } }, 'transit', 'day', true],
  ] as const) {
    const { document, element } = startupDocument();
    let options: Parameters<typeof createStudioLayout>[0]; let received: StartupPorts | undefined, failure: unknown;
    const initial={...saved,...(saved.selectedId===personal.id?{temporaryChart:personal}:{})};
    await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), (value) => { options = value; return layoutStub(); },
      () => () => {}, () => ({ read: () => initial }), emptyStore, async () => {
        try {
          assert.equal(element('studio').dataset.initialTimeline, panel, JSON.stringify(saved));
          assert.equal(options.timelineKind, kind);
          for (const [name, id] of [['transit', 'transitControls'], ['natal-day', 'natalDayControls'], ['lifetime', 'lifetimeControls']] as const)
            assert.equal(element(id).hidden, name !== panel);
          assert.equal(element('lifetimeHeading').hidden, !heading);
          assert.equal(element('natalDayToggle').hidden, saved.selectedId !== personal.id);
          assert.equal(element('natalDayToggle').getAttribute('aria-expanded'), String(panel === 'natal-day'));
          assert.equal(element('natalDayToggle').getAttribute('aria-pressed'), String(panel === 'natal-day'));
        } catch (error) { failure = error; }
        return { startApp(ports) { received = ports; } };
      });
    assert.ifError(failure);
    assert.equal(received!.initialPresentation!.timelineKind, kind);
    assert.equal(received!.initialPresentation!.timelinePanel || 'none', panel);
  }
});


test('panel buttons work before app import and hand the same choices and camera to the application once', async () => {
  const savedView = { selectedId: 'current-transit', panels: { left: false, right: true }, camera: { x: -50, y: -50, k: 1.5 } };
  const { document, element } = startupDocument();
  let layout: ReturnType<typeof createStudioLayout> | undefined, before: string | undefined, received: StartupPorts | undefined, failure: unknown;
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), (options) => {
    layout = createStudioLayout({ ...options, viewport: null, media: { matches: false } as MediaQueryList,
      readStyle: () => layoutStyle as CSSStyleDeclaration });
    return layout;
  }, () => () => {}, () => ({ read: () => savedView }), emptyStore, async () => {
    try {
      assert.equal(element('shell').inert, false);
      assert.equal(element('mainNavigation').inert, true);
      element('openLibrary').click(); element('summarySwitch').click();
      assert.equal(element('library').classList.contains('open'), true);
      assert.equal(element('chartSummary').classList.contains('open'), false);
      assert.equal(element('libraryBackdrop').hidden, false);
      before = element('bodygraph').style.transform;
    } catch (error) { failure = error; }
    return { startApp(ports: StartupPorts) {
      received = ports;
      ports.panels.beginRestore(); ports.panels.restore(savedView.panels);
      ports.panels.setRight(true, { automatic: true });
    } };
  });
  assert.ifError(failure);
  assert.deepEqual(received!.panels.snapshot, { left: true, right: false });
  assert.equal(element('bodygraph').style.transform, before);
  for (const id of ['openLibrary', 'summarySwitch', 'libraryBackdrop', 'summaryBackdrop'] as const) assert.equal(element(id).listenerCount('click'), 0, 'temporary handlers detach before app owns commands');
  received!.releaseLoadingContent!();
  assert.equal(element('mainNavigation').inert, false);
  assert.equal(element('chartSummary').inert, true);
  layout!.destroy();
});


function phoneStartupLayout(options: Parameters<typeof createStudioLayout>[0]) {
  options.onPhoneLayout?.(true);
  return { ...layoutStub(), phone: true, readViewport: () => ({ top: 0, height: 900 }) };
}

test('phone drawers restore open, closed and legacy two-panel states without automatically reopening', async () => {
  for (const [savedPanels, expected] of [
    [{ left: false, right: false }, { left: false, right: false }],
    [{ left: true, right: false }, { left: true, right: false }],
    [{ left: false, right: true }, { left: false, right: true }],
    [{ left: true, right: true }, { left: true, right: false }],
  ]) {
    const { document, element } = startupDocument();
    const handoff: { ports?: StartupPorts } = {};
    await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), phoneStartupLayout,
      () => () => {}, () => ({ read: () => ({ selectedId: 'current-transit', panels: savedPanels }) }), emptyStore,
      async () => ({ startApp(ports: StartupPorts) {
        handoff.ports = ports;
        ports.panels.beginRestore(); ports.panels.restore(ports.savedView?.panels); ports.panels.finishRestore();
      } }));
    await Promise.resolve();
    const received = handoff.ports;
    assert.ok(received);
    assert.deepEqual(received.panels.snapshot, expected);
    assert.equal(element('library').classList.contains('open'), expected.left);
    assert.equal(element('chartSummary').classList.contains('open'), expected.right);
    assert.equal(element('chartSummary').inert, !expected.right);
  }
});

test('phone commands switch sides atomically and newer loading actions survive handoff and another reload', async () => {
  for (const [action, expected] of [
    ['openLibrary', { left: true, right: false }],
    ['summarySwitch', { left: false, right: false }],
    ['summaryBackdrop', { left: false, right: false }],
  ] as const) {
    const storage = tabStorage(), viewStore = createViewStore({ getStorage: () => storage });
    viewStore.write({ version: 1, selectedId: 'current-transit', panels: { left: false, right: true },
      mandala: true, transit: { live: false, date: '2026-10-04', timeZone: 'UTC', index: 400 } });
    const first = startupDocument(); const handoff: { ports?: StartupPorts } = {};
    await run(attachPageGestures, first.document, class { observe() {} disconnect() {} }, () => ({}), phoneStartupLayout,
      () => () => {}, () => viewStore, emptyStore, async () => {
        first.element(action).click();
        return { startApp(ports: StartupPorts) {
          handoff.ports = ports;
          ports.panels.beginRestore(); ports.panels.restore(ports.savedView?.panels); ports.panels.finishRestore();
        } };
      });
    const received = handoff.ports;
    assert.ok(received);
    assert.deepEqual(received.panels.snapshot, expected, 'a late restore cannot replace the new command');
    assert.deepEqual(viewStore.read()!.panels, expected);
    const second = startupDocument(); const next: { ports?: StartupPorts } = {};
    await run(attachPageGestures, second.document, class { observe() {} disconnect() {} }, () => ({}), phoneStartupLayout,
      () => () => {}, () => createViewStore({ getStorage: () => storage }), emptyStore,
      async () => ({ startApp(ports: StartupPorts) { next.ports = ports; ports.panels.finishRestore(); } }));
    const reloaded = next.ports;
    assert.ok(reloaded);
    assert.ok(reloaded.savedView);
    assert.deepEqual(reloaded.panels.snapshot, expected);
    assert.equal(reloaded.savedView.mandala, true);
    assert.deepEqual(reloaded.savedView.transit, { live: false, date: '2026-10-04', timeZone: 'UTC', index: 400 });
  }
});

test('switching phone drawers preserves the selected Returns screen and moment', async () => {
  const { document, element } = startupDocument();
  const personal = libraryRecordAtMinute(natalDayFixture(), 754);
  const saved = { selectedId: personal.id, temporaryChart:personal, panels: { left: false, right: true }, returns: { opened: true, eventId: 'selected-return' } };
  const handoff: { ports?: StartupPorts } = {};
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), phoneStartupLayout,
    () => () => {}, () => ({ read: () => saved }), emptyStore, async () => {
      element('openLibrary').click();
      element('summarySwitch').click();
      return { startApp(ports: StartupPorts) { handoff.ports = ports; ports.panels.finishRestore(); } };
    });
  const received = handoff.ports;
    assert.ok(received);
  assert.deepEqual(received.panels.snapshot, { left: false, right: true });
  assert.equal(element('chartSummary').dataset.screen, 'returns');
  assert.deepEqual(received.savedView?.returns, saved.returns);
});


for (const side of ['left', 'right'] as const) test(`Escape closes the ${side} panel in the real loading Preview`, async () => {
  const { document, element } = startupDocument();
  const storage = tabStorage(); storage.setItem('forma.loading-preview.v1', '1');
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), phoneStartupLayout,
    () => () => {}, () => ({ read: () => ({ selectedId: 'current-transit', panels: { left: side === 'left', right: side === 'right' } }) }), emptyStore,
    async () => { assert.fail('Preview must hold before importing the application'); }, { href: 'http://localhost:3636/', reload() {} }, storage);
  const panel = element(side === 'left' ? 'library' : 'chartSummary');
  assert.equal(panel.classList.contains('open'), true);
  const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
  document.defaultView.dispatchEvent(escape);
  assert.equal(panel.classList.contains('open'), false);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(document.activeElement, element(side === 'left' ? 'openLibrary' : 'summarySwitch'));
});

for (const preview of [false, true]) test(`random chart shares initial availability in ${preview ? 'Preview' : 'ordinary startup'}`, async () => {
  const { document, element } = startupDocument({ randomChartButton: { hidden: true } });
  const storage = tabStorage(); if (preview) storage.setItem('forma.loading-preview.v1', '1');
  let release: (() => void) | undefined;
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), layoutStub,
    () => () => {}, () => ({ read: () => null }), emptyStore,
    async () => ({ startApp(ports: StartupPorts) { release = ports.releaseLoadingContent!; } }),
    { href: 'http://localhost:3636/', reload() {} }, storage);
  assert.equal(element('randomChartButton').hidden, false, 'the same stand button supplies the loading placeholder in both paths');
  assert.equal(element('randomChartButton').inert, true, 'creation cannot interrupt unfinished restoration');
  if (!preview) { release!(); assert.equal(element('randomChartButton').inert, false); }
});


test('the same panel keyboard owner survives handoff without closing both desktop panels', async () => {
  const { document } = startupDocument();
  let received: StartupPorts | undefined;
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), layoutStub,
    () => () => {}, () => ({ read: () => ({ panels: { left: true, right: true } }) }), emptyStore,
    async () => ({ startApp(ports: StartupPorts) { received = ports; ports.panels.finishRestore(); } }));
  assert.ok(received);
  const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
  document.defaultView.dispatchEvent(escape);
  assert.deepEqual(received.panels.snapshot, { left: false, right: true });
});

test('public startup exposes the accepted random action after loading', async () => {
  const { document, element } = startupDocument({ randomChartButton: { hidden: true } });
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), layoutStub,
    () => () => {}, () => ({ read: () => null }), emptyStore, async () => ({ startApp() {} }),
    { href: 'https://forma.juxtaposition.ru/', reload() {} });
  assert.equal(element('randomChartButton').hidden, false);
});

for (const preview of [false, true]) test(`reopening a saved closed panel keeps Returns in ${preview ? 'Preview' : 'ordinary early loading'}`, async () => {
  const { document, element } = startupDocument();
  const personal = libraryRecordAtMinute(natalDayFixture(), 754);
  const saved = { selectedId: personal.id, temporaryChart:personal, panels: { left: false, right: false }, returns: { opened: true, eventId: 'selected-return' } };
  const storage = tabStorage(); if (preview) storage.setItem('forma.loading-preview.v1', '1');
  let handedOff = false;
  const reopen = () => {
    assert.equal(element('chartSummary').classList.contains('open'), false);
    element('summarySwitch').click();
    assert.equal(element('chartSummary').classList.contains('open'), true);
    assert.equal(element('chartSummary').dataset.screen, 'returns');
  };
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), phoneStartupLayout,
    () => () => {}, () => ({ read: () => saved }), emptyStore, async () => {
      assert.equal(preview, false);
      reopen();
      return { startApp(ports: StartupPorts) {
        assert.deepEqual(ports.savedView?.returns, saved.returns);
        handedOff = true;
        assert.equal(ports.panels.right, true);
        ports.panels.finishRestore();
      } };
    }, { href: 'http://localhost:3636/', reload() {} }, storage);
  if (preview) reopen(); else assert.equal(handedOff, true, 'ordinary startup must reach the ready app');
});

for (const preview of [false, true]) test(`reopening Day discards the previous minute in ${preview ? 'Preview' : 'early loading'}`, async () => {
  const { document, element } = startupDocument();
  const personal = libraryRecordAtMinute(natalDayFixture(), 754);
  const saved = { selectedId: personal.id, temporaryChart: personal,
    natalDay: { opened: true, index: 600, exactOriginal: false } };
  const storage = tabStorage(); if (preview) storage.setItem('forma.loading-preview.v1', '1');
  const writes: Partial<SavedView>[] = [];
  let received: StartupPorts | undefined, failure: unknown;
  const reopen = () => {
    element('natalDayToggle').click();
    assert.equal(writes.at(-1)!.natalDay!.opened, false);
    element('natalDayToggle').click();
    assert.equal(writes.at(-1)!.natalDay!.opened, true);
    assert.equal(writes.at(-1)!.natalDay!.exactOriginal, true,
      'restoration must keep the birth moment instead of replaying minute 600');
  };
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), phoneStartupLayout,
    () => () => {}, () => ({ read: () => saved, write(value) { writes.push(value); return true; } }), emptyStore,
    async () => {
      try { reopen(); } catch (error) { failure = error; }
      return { startApp(ports) { received = ports; } };
    }, { href: 'http://localhost:3636/', reload() {} }, storage);
  if (preview) reopen();
  else {
    assert.ifError(failure);
    assert.equal(received!.savedView!.natalDay!.exactOriginal, true);
  }
});

for (const preview of [false, true]) test(`camera owns the saved position during ${preview ? 'held Preview' : 'application loading'}`, async () => {
  const { document } = startupDocument(), storage = tabStorage();
  if (preview) storage.setItem('forma.loading-preview.v1', '1');
  const saved = { selectedId: 'current-transit', camera: { x: -100, y: -100, k: 1.7 } };
  const writes: Partial<import('../src/data/view-store.ts').SavedView>[] = [];
  let camera: cameraModule.Camera, reads = 0, exercised = false;
  const createCamera = (options: Parameters<typeof cameraModule.createCamera>[0]) => {
    camera = cameraModule.createCamera(options);
    const snapshot = camera.getSavedView.bind(camera);
    camera.getSavedView = () => { reads++; return snapshot(); };
    return camera;
  };
  function persist() {
    const home = camera.getFittedView();
    camera.setView({ ...home, k: 6 }, { maxScale: 7 });
    const position = camera.getView(), expected = camera.getSavedView(), before = reads;
    document.defaultView.dispatchEvent(new Event('pagehide'));
    assert.equal(reads, before + 1, 'startup delegates the snapshot to its existing camera');
    assert.deepEqual(writes.at(-1)?.camera, expected);
    assert.deepEqual(camera.getView(), position, 'saving does not move the camera');
    camera.restoreView(writes.at(-1)!.camera);
    const restored = camera.getView();
    for (const key of ['x', 'y', 'k'] as const) assert.ok(Math.abs(restored[key] - position[key]) < 1e-10);
    assert.ok(Math.abs(camera.maximumScale() - 7) < 1e-10);
    exercised = true;
  }
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), layoutStub,
    () => () => {}, () => ({ read: () => saved, write(value) { writes.push(value); return true; } }), emptyStore,
    async () => { persist(); return { startApp() {} }; },
    { port: '3636', href: 'http://localhost:3636/', reload() {} }, storage, createCamera);
  if (preview) persist();
  assert.equal(exercised, true, 'startup must not swallow a failed persistence check');
});


for (const preview of [false, true]) test(`account workspace is attached once and shares the tab draft in ${preview ? 'Preview' : 'ordinary startup'}`, async () => {
  const storage = tabStorage(); if (preview) storage.setItem('forma.loading-preview.v1', '1');
  const draft = { email: 'a@example.org', attemptEmail: '', attemptId: null, step: 'email' as const, verificationPending: false };
  let attachments = 0, received: StartupPorts | undefined;
  const port = { snapshot: draft, ready: Promise.resolve(), setVisible() {} };
  const viewStore = createViewStore({ getStorage: () => storage });
  viewStore.write({ version: 1, selectedId: 'current-transit', workspace: 'account', account: draft });
  const { document } = startupDocument();
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), layoutStub,
    () => () => {}, () => viewStore, emptyStore, async () => ({ startApp(value) { received = value; } }),
    { href: 'http://localhost:3636/' }, storage, undefined,
    options => { attachments++; assert.equal(options.loadingOnly, preview); assert.deepEqual(options.saved, draft); return port; });
  assert.equal(attachments, 1);
  if (preview) assert.equal(received, undefined); else assert.equal(received?.account, port);
  assert.deepEqual(viewStore.read()?.account, draft);
});


test('a startup failure report retains the already restored account without private input', async () => {
  const {document} = startupDocument();
  const facts: unknown[] = [];
  const port = {ready:Promise.resolve(),snapshot:null,setVisible(){},getSession(){return {accountId:'42',sessionId:'private-session'};}};
  const startup = await run(attachPageGestures, document, class {observe(){} disconnect(){}}, () => ({}), layoutStub,
    () => () => {}, () => ({read:()=>null,write:()=>true}), emptyStore,
    async () => ({startApp(){throw new Error('private form input');}}),
    {href:'http://localhost:3636/'}, tabStorage(), undefined, () => port);
  await startup.connectJournal({setAccount(id:string|null){facts.push(id);},begin(action:unknown){facts.push(action);return {
    step(){},finishSuccess(){},async reportError(){return null;},async reportRecovery(){return null;},
    async reportFailure(step:unknown){facts.push(step);return null;}
  };}});
  assert.deepEqual(facts,['42',{action:'startup',component:'startup'},{stage:'render',reason:'unclassified_error'}]);
});

test('peer early account response must not erase the pending email caret before app handoff',async()=>{
 const storage=tabStorage();const viewStore=createViewStore({getStorage:()=>storage});
 const focus={start:2,end:5,direction:'backward' as const};
 const draft={email:'a@example.org',attemptEmail:'',attemptId:null,step:'email' as const,verificationPending:false};
 viewStore.write({version:1,selectedId:'current-transit',workspace:'account',account:{...draft,focus}});
 const {document}=startupDocument();let changed=()=>{};
 await run(attachPageGestures,document,class {observe(){}disconnect(){}},()=>({}),layoutStub,
  ()=>()=>{},()=>viewStore,emptyStore,async()=>{
   // The initial account lookup emits while app.ts is still loading. No user input happened.
   changed();
   return {startApp(){}};
  },{href:'http://localhost:3636/account',pathname:'/account'},storage,undefined,
  options=>{changed=options.onChange!;return {ready:Promise.resolve(),snapshot:draft,setVisible(){}};});
 assert.deepEqual(viewStore.read()?.account?.focus,focus,'a second reload must still find the saved cursor');
});

test('a new gesture cancels the pending email caret before app handoff',async()=>{
 const storage=tabStorage();const viewStore=createViewStore({getStorage:()=>storage});
 const focus={start:2,end:5,direction:'backward' as const};
 const draft={email:'a@example.org',attemptEmail:'',attemptId:null,step:'email' as const,verificationPending:false};
 viewStore.write({version:1,selectedId:'current-transit',workspace:'account',account:{...draft,focus}});
 const {document}=startupDocument();let changed=()=>{};
 await run(attachPageGestures,document,class {observe(){}disconnect(){}},()=>({}),layoutStub,
  ()=>()=>{},()=>viewStore,emptyStore,async()=>{
   // The initial account lookup emits while app.ts is still loading. No user input happened.
   document.dispatchEvent(new Event('keydown')); changed();
   return {startApp(){}};
  },{href:'http://localhost:3636/account',pathname:'/account'},storage,undefined,
  options=>{changed=options.onChange!;return {ready:Promise.resolve(),snapshot:draft,setVisible(){}};});
 assert.equal(viewStore.read()?.account?.focus,undefined,'new input must not revive an older cursor');
});


for (const preview of [false,true]) test(`one tab result survives early gestures and legacy projection during ${preview?'Preview':'startup'}`,async()=>{
  const chart={...libraryRecordAtMinute(natalDayFixture(),754),id:'own-temporary',name:'Своя карта'};
  const legacy={id:'old-local',name:'Прежняя запись',source:'manual',personality:[1],design:[]};
  const local=tabStorage();local.setItem(STORAGE_KEY,JSON.stringify([legacy]));
  const original=local.getItem(STORAGE_KEY);
  const tab=tabStorage(),viewStore=createViewStore({getStorage:()=>tab});
  viewStore.write({version:1,selectedId:chart.id,temporaryChart:chart,panels:{left:true,right:false},workspace:'chart',
    camera:{x:-100,y:-100,k:1.7},natalDay:{opened:true,exactOriginal:true,index:754}});
  if(preview)tab.setItem('forma.loading-preview.v1','1');
  const {document,element,rows}=startupDocument();
  let store:ReturnType<typeof createChartStore>|undefined,received:StartupPorts|undefined,imports=0;
  await run(attachPageGestures,document,class{observe(){}disconnect(){}},()=>({}),layoutStub,
    ()=>()=>{},()=>viewStore,options=>{store=createChartStore({...options,getStorage:()=>local});return store;},async()=>{
      imports++;
      element('mandalaSwitch').click();
      return{startApp(ports){received=ports;}};
    },{href:'http://localhost:3636/chart',pathname:'/chart'},tab);
  assert.ok(store);
  assert.equal(store.temporaryChart?.id,chart.id);
  assert.deepEqual(store.charts,[],'old local records are not the guest collection');
  assert.equal(store.has('old-local'),false);
  assert.equal(local.getItem(STORAGE_KEY),original);
  assert.equal(rows.length,0);
  assert.doesNotMatch(element('chartList').innerHTML,/Своя карта/);
  assert.doesNotMatch(element('chartList').innerHTML,/Прежняя запись/);
  assert.equal(element('studio').dataset.initialTimeline,'natal-day');
  if(preview)element('mandalaSwitch').click();
  document.defaultView.dispatchEvent(new Event('pagehide'));
  assert.equal(viewStore.read()?.temporaryChart?.id,chart.id);
  assert.equal(viewStore.read()?.selectedId,chart.id);
  assert.equal(viewStore.read()?.mandala,true);
  assert.equal(imports,preview?0:1);
  if(!preview){
    assert.equal(received?.store,store);
    assert.equal(received?.savedView?.temporaryChart?.id,chart.id);
    assert.equal(received?.savedView?.selectedId,chart.id);
    assert.equal(received?.savedView?.mandala,true);
  }
});

test('legacy local records remain untouched but do not become a guest collection at startup',async()=>{
  const local=tabStorage();
  local.setItem(STORAGE_KEY,JSON.stringify([{id:'legacy',name:'Старая карта',source:'manual',personality:[1],design:[]}])) ;
  const original=local.getItem(STORAGE_KEY),{document,element,rows}=startupDocument();
  let received:StartupPorts|undefined;
  await run(attachPageGestures,document,class{observe(){}disconnect(){}},()=>({}),layoutStub,
    ()=>()=>{},()=>({read:()=>({version:1,selectedId:'legacy'})}),
    options=>createChartStore({...options,getStorage:()=>local}),async()=>({startApp(ports){received=ports;}}));
  assert.ok(received);
  assert.deepEqual(received.store.charts,[]);
  assert.equal(received.store.temporaryChart,null);
  assert.equal(rows.length,0);
  assert.equal(element('nowButton').getAttribute('aria-pressed'),'true');
  assert.equal(local.getItem(STORAGE_KEY),original);
});


for(const preview of [false,true])test(`the last public source joins early restoration in ${preview?'Preview':'startup'}`,async()=>{
  const own=accountNatalChart(113),foreign=accountNatalChart(114,'2');
  const {accountId,note,noteRevision,publicRevision,...fields}=foreign,publicChart={...fields,calculationVersion:'a'.repeat(64)};
  const temporaryChart={...own,id:'own-temporary',createdAt:'',updatedAt:''};
  const tab=tabStorage(),viewStore=createViewStore({getStorage:()=>tab});
  viewStore.write({version:1,selectedId:foreign.id,publicChart,temporaryChart,panels:{left:false,right:true},workspace:'chart'});
  if(preview)tab.setItem('forma.loading-preview.v1','1');
  const {document,element}=startupDocument();let store:ReturnType<typeof createChartStore>|undefined,received:StartupPorts|undefined;
  await run(attachPageGestures,document,class{observe(){}disconnect(){}},()=>({}),layoutStub,
    ()=>()=>{},()=>viewStore,options=>{store=createChartStore({...options,getStorage:()=>tabStorage()});return store;},
    async()=>({startApp(ports){received=ports;}}),{href:'http://localhost:3636/chart/'+foreign.id,pathname:'/chart/'+foreign.id},tab);
  assert.equal(store?.has(foreign.id),true);assert.equal(store?.get(foreign.id)?.note,'');assert.equal(store?.temporaryChart?.id,temporaryChart.id);
  element('mandalaSwitch').click();document.defaultView.dispatchEvent(new Event('pagehide'));
  assert.equal(viewStore.read()?.publicChart?.id,foreign.id);assert.equal(viewStore.read()?.temporaryChart?.id,temporaryChart.id);
  assert.equal(viewStore.read()?.selectedId,foreign.id);
  if(!preview)assert.equal(received?.store,store);
});


for (const trigger of ['account','panel'] as const) test(`early ${trigger} update preserves a private route and its return before the library loads`,async()=>{
  const storage=tabStorage(),viewStore=createViewStore({getStorage:()=>storage});
  const own=accountNatalChart(121),eventId='saturn:2020-02-02T19:27:23.000Z';
  viewStore.write({version:1,selectedId:own.id,workspace:'chart',returns:{opened:true,bodies:['saturn'],year:null,eventId},
    lifetime:{opened:true,mode:'lifetime',fromDate:'1990-05-15',toDate:'2090-05-15',requestedUtc:Date.parse('2020-02-02T19:27:23.000Z')}});
  const {document}=startupDocument();let changed=()=>{},received:StartupPorts|undefined;
  await run(attachPageGestures,document,class {observe(){}disconnect(){}},()=>({}),layoutStub,
    ()=>()=>{},()=>viewStore,emptyStore,async()=>{
      if(trigger==='account')changed();else document.getElementById('openLibrary')!.click();
      return {startApp(value){received=value;}};
    },{href:'http://localhost:3636/chart/'+own.id,pathname:'/chart/'+own.id},storage,undefined,
    options=>{changed=options.onChange!;return {ready:Promise.resolve(),snapshot:null,setVisible(){}};});
  assert.equal(viewStore.read()?.selectedId,own.id);
  assert.equal(received?.savedView?.selectedId,own.id);
  assert.equal(received?.savedView?.returns?.eventId,eventId);
  assert.equal(received?.savedView?.lifetime?.requestedUtc,Date.parse('2020-02-02T19:27:23.000Z'));
});


for(const source of ['view','versions'] as const)test(`early ${source} failure crosses the real journal, HTTP and writer with its original time and anonymous owner`,async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'forma-startup-journal-')),indexedDB=new IDBFactory();
 let time=1_000_000,online=false,access:{accountId:string;sessionId:string}|null=null,versionWork:Promise<unknown>|undefined;
 t.mock.method(Date,'now',()=>time);
 const runtime=createJournalRuntime({directory,environment:'stand',now:()=>time,clientReservedBytes:DIAGNOSTIC_HTTP_RESERVED_BYTES});
 const http=createDiagnosticHandler({origins:['https://forma.example.test'],accounts:{diagnosticOwner:()=>null},
  write:({deliveryIp,...report})=>runtime.receiveClient(report,deliveryIp)});
 const send=createDiagnosticClient({fetch:async(url,options)=>{
  assert.equal(url,'/api/diagnostics');
  const request=Object.assign(Readable.from([options!.body as string]),{url:'/api/diagnostics',method:'POST',
   headers:{...Object.fromEntries(new Headers(options?.headers)),host:'forma.example.test',origin:'https://forma.example.test'},socket:{remoteAddress:'192.0.2.20'}}) as unknown as IncomingMessage;
  const response=captureResponse();await http(request,response);
  return new Response(response.body,{status:response.status,headers:{'Content-Type':'application/json'}});
 }});
 const journal=createJournal({indexedDB,appVersion:'test-1',environment:'stand',now:()=>time,connection:()=>online?'online':'offline',send});
 const inspect=createDiagnosticQueue({indexedDB,now:()=>time}),clients=createCalculationClients({cacheOptions:{indexedDB:new IDBFactory()}});
 let updates:ReturnType<typeof createCalculationUpdates>|undefined;
 t.after(async()=>{updates?.close();clients.close();inspect.close();await journal.close();await runtime.close();fs.rmSync(directory,{recursive:true,force:true});});
 const {document}=startupDocument(),storage=tabStorage();
 let ports:StartupPorts|undefined;
 const startup=await run(attachPageGestures,document,class{observe(){}disconnect(){}},()=>({}),layoutStub,()=>()=>{},
  options=>createViewStore({...options,getStorage:()=>({...storage,getItem(key){if(source==='view')throw new Error('PRIVATE snapshot');return storage.getItem(key);},setItem(){throw new Error('PRIVATE disk');}})}),
  emptyStore,async()=>({startApp(value){ports=value;access={accountId:'42',sessionId:'session-later'};return {attachJournal(value:ReturnType<typeof createJournal>){value.setAccount(access!.accountId,access!.sessionId);}};}}),
  {href:'http://localhost:3636/'},storage,undefined,()=>({ready:Promise.resolve(),snapshot:null,setVisible(){},getSession:()=>access}),
  options=>{updates=createCalculationUpdates({...options,clients,expected:{calculationVersion:'a'.repeat(64),cyclesVersion:'b'.repeat(64)},
    request:async()=>{if(source==='versions')throw Object.assign(new Error('PRIVATE request'),{code:'connection_failed'});return {calculationVersion:'c'.repeat(64),cyclesVersion:'b'.repeat(64)};}});
    return {...updates,refresh(){return versionWork=updates!.refresh();}};});
 await versionWork;time+=5000;await startup.connectJournal(journal);
 online=true;await journal.wake();
 const read=():ClientReport[]=>{const archive=path.join(directory,'archive');return fs.existsSync(archive)?fs.readdirSync(archive).filter(file=>file.endsWith('.jsonl')).flatMap(file=>fs.readFileSync(path.join(archive,file),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))):[];};
 for(let i=0;i<300 && !read().length;i++)await new Promise(resolve=>setTimeout(resolve,5));
 const reports=read();assert.equal(reports.length,1);assert.equal(reports[0]!.occurredAt,1_000_000);assert.equal(reports[0]!.accountId,null);
 assert.equal(reports[0]!.reason,source==='view'?'storage_unavailable':'connection_failed');
 assert.doesNotMatch(JSON.stringify(reports),/PRIVATE|session-later/);assert.ok(ports);
 await journal.wake();assert.equal(read().length,1);
 const state=await inspect.state();assert.equal(state.status,'ready');if(state.status==='ready')assert.equal(state.count,0);
});


test('an early incompatible calculation response reaches the release updater attached after startup',async t=>{
 const clients=createCalculationClients({cacheOptions:{indexedDB:new IDBFactory()}});
 let owner:ReturnType<typeof createCalculationUpdates>|undefined,first:Promise<unknown>|undefined,ports:StartupPorts|undefined;
 t.after(()=>{owner?.close();clients.close();});
 const expected={calculationVersion:'a'.repeat(64),cyclesVersion:'b'.repeat(64)};
 const newer={calculationVersion:'c'.repeat(64),cyclesVersion:'d'.repeat(64)};
 const before=await clients.status(),{document}=startupDocument();
 const startup=await run(attachPageGestures,document,class{observe(){}disconnect(){}},()=>({}),layoutStub,()=>()=>{},
  ()=>({read:()=>null}),emptyStore,async()=>({startApp(value){ports=value;}}),{},undefined,undefined,undefined,
  options=>{
   owner=createCalculationUpdates({...options,clients,expected,request:async()=>newer});
   return {onTimelineChanged:owner.onTimelineChanged,refresh(options){const work=owner!.refresh(options);first??=work;return work;}};
  });
 await first;await Promise.resolve();let discoveries=0;
 startup.connectOfflineUpdates(()=>{discoveries++;});
 assert.equal(discoveries,1,'the response is retained until entry supplies the existing updater');
 const next=await ports!.calculationUpdates!.refresh();
 assert.deepEqual(next,{status:'incompatible',versions:newer});
 assert.equal(discoveries,2,'the application receives the same connected refresh path');
 assert.deepEqual(await clients.status(),before,'an old client never confirms a new numerical epoch');
});

test('an incompatible local window wakes the same updater, but cancelled and unavailable results do not',async()=>{
 const {document}=startupDocument();let ports:StartupPorts|undefined,discoveries=0;
 let result:'cancelled'|'unavailable'='cancelled';
 const startup=await run(attachPageGestures,document,class{observe(){}disconnect(){}},()=>({}),layoutStub,()=>()=>{},
  ()=>({read:()=>null}),emptyStore,async()=>({startApp(value){ports=value;}}),{},undefined,undefined,undefined,
  ()=>({refresh:async()=>({status:result}),onTimelineChanged:async()=>({status:'incompatible'})}));
 startup.connectOfflineUpdates(()=>{discoveries++;});assert.equal(discoveries,0);
 result='unavailable';assert.equal((await ports!.calculationUpdates!.refresh()).status,'unavailable');assert.equal(discoveries,0);
 assert.equal((await ports!.calculationUpdates!.onTimelineChanged(null)).status,'incompatible');
 assert.equal(discoveries,1);
});

test('connected view storage reports one failure per outage, recovers on disk success and resets at an account boundary',async t=>{
 const reports:ClientReport[]=[],indexedDB=new IDBFactory();
 const journal=createJournal({indexedDB,appVersion:'test-1',environment:'stand',connection:()=> 'online',send:async body=>{
  reports.push(...body.reports);return {schemaVersion:1,results:body.reports.map(r=>({eventId:r.eventId,status:'accepted',receivedAt:1,duplicate:false}))};}});
 t.after(()=>journal.close());let fail=false,access:{accountId:string;sessionId:string}|null=null;
 const {document}=startupDocument(),storage=tabStorage();let ports:StartupPorts|undefined;
 const startup=await run(attachPageGestures,document,class{observe(){}disconnect(){}},()=>({}),layoutStub,()=>()=>{},
  options=>createViewStore({...options,getStorage:()=>({...storage,setItem(key,value){if(fail)throw new Error('private disk');storage.setItem(key,value);}})}),emptyStore,
  async()=>({startApp(value){ports=value;return {attachJournal(){}};}}),{href:'http://localhost:3636/'},storage,undefined,
  ()=>({ready:Promise.resolve(),snapshot:null,setVisible(){},getSession:()=>access}));
 await startup.connectJournal(journal);
 const wait=async(count:number)=>{for(let i=0;i<150 && reports.length<count;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(reports.length,count);};
 const snapshot={version:1 as const,selectedId:'current-transit'};
 fail=true;for(let i=0;i<100;i++)assert.equal(ports!.viewStore.write!({...snapshot,mandala:!!(i%2)}),false);
 await wait(1);assert.equal(reports[0]!.accountId,null);
 fail=false;assert.equal(ports!.viewStore.write!(snapshot),true);
 fail=true;assert.equal(ports!.viewStore.write!({...snapshot,mandala:true}),false);await wait(2);
 access={accountId:'42',sessionId:'different-session'};journal.setAccount(access.accountId,access.sessionId);
 assert.equal(ports!.viewStore.write!({...snapshot,mandala:true}),false);await wait(3);assert.equal(reports[2]!.accountId,'42');
 for(let i=0;i<10;i++)ports!.viewStore.write!({...snapshot,mandala:true});await journal.wake();assert.equal(reports.length,3);
});

test('a confirmed returns-only mismatch invalidates only that domain before discovering the next bundle',async()=>{
 const {document}=startupDocument();let ports:StartupPorts|undefined;
 document.body.dataset.calculationVersion='a'.repeat(64);document.body.dataset.cyclesVersion='b'.repeat(64);
 const invalidations:{calculation:boolean;returns:boolean}[]=[];
 const startup=await run(attachPageGestures,document,class{observe(){}disconnect(){}},()=>({}),layoutStub,()=>()=>{},
  ()=>({read:()=>null}),emptyStore,async()=>({startApp(value){ports=value;return {invalidateCalculations(value:{calculation:boolean;returns:boolean}){invalidations.push({...value});}};}}),{},undefined,undefined,undefined,
  ()=>({refresh:async()=>({status:'incompatible',versions:{calculationVersion:'a'.repeat(64),cyclesVersion:'c'.repeat(64)}}),onTimelineChanged:async()=>({status:'unconfirmed'})}));
 await ports!.calculationUpdates!.refresh();
 assert.deepEqual(invalidations.at(-1),{calculation:false,returns:true});
 let discoveries=0;startup.connectOfflineUpdates(()=>{discoveries++;});assert.equal(discoveries,1);
});
