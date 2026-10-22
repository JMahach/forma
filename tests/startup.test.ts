import { readModuleSource } from './helpers/module-source.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STUDIO_FOOTPRINT, MANDALA_FRAME } from '../src/scene/geometry/frames.ts';
import { attachGestures } from '../src/scene/gestures.ts';
import { attachCameraControls } from '../src/views/camera-controls.ts';
import { attachLoadingPreview } from '../src/views/loading-preview.ts';
import { lifeTimelineForChart } from '../src/domain/cycles.ts';
import { attachPhoneSheets } from '../src/ui/phone-sheet.ts';
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
import { createCameraChangeHandler } from '../src/views/camera-controls.ts';
import { libraryRecordAtMinute, natalDayFixture } from './fixtures/natal-day.ts';
import { ACTIVATION_COLUMN_REVEAL_DISTANCE } from '../src/scene/geometry/activation-layout.ts';

type StartupPorts = Parameters<typeof import('../src/app.ts').startApp>[0];

// Run the entry module with its browser ports, leaving its actual initialization
// order intact while replacing the network-loaded application.
const source = readModuleSource(new URL('../src/startup.ts', import.meta.url))
  .replace(/^import .*;\n/gm, '').replace("import('./app.ts')", 'loadApp()');
const evaluate = new (Object.getPrototypeOf(async function () {}).constructor)(
  'attachGestures', 'attachCameraControls', 'attachLoadingPreview', 'lifeTimelineForChart', 'attachPhoneSheets', 'holdLoadingContent', 'commitLoadingLayout', 'studioPresentation', 'eligibleCycleChart', 'canExploreNatalDay', 'createCameraChangeHandler', 'createCamera', 'createCameraView', 'MANDALA_FRAME', 'ACTIVATION_COLUMN_REVEAL_DISTANCE', 'createChartLibraryView', 'resolveSelectedChartId', 'STUDIO_FOOTPRINT', 'createPanelState', 'createWorkspaceState', 'getComputedStyle', 'attachPageGestures', 'document', 'ResizeObserver', 'createTransitDayClient', 'createStudioLayout', 'createToast', 'createViewStore', 'createChartStore', 'loadApp', 'location', source);
function tabStorage() {
  const values = new Map();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, String(value)), removeItem: (key: string) => values.delete(key) };
}
const runWithSheets = (attachSheets, ...args) => {
  const storage = args[10] ?? tabStorage();
  args.length = 10;
  args[9] = { ...args[9], href: args[9]?.href || 'http://localhost:3636/' };
  const attachPreview = (options: { button: HTMLButtonElement; location: Pick<Location,"href"|"reload">; getStorage?: () => Storage; beforeNavigate?: () => void; }) => attachLoadingPreview({ ...options, getStorage: () => storage });
  return evaluate(attachGestures, attachCameraControls, attachPreview, lifeTimelineForChart, attachSheets, holdLoadingContent, commitLoadingLayout, studioPresentation, eligibleCycleChart, canExploreNatalDay, createCameraChangeHandler, cameraModule.createCamera, createCameraView, MANDALA_FRAME, ACTIVATION_COLUMN_REVEAL_DISTANCE, createChartLibraryView, chartSession.resolveSelectedChartId, STUDIO_FOOTPRINT, createPanelState, createWorkspaceState,
    () => ({ getPropertyValue: () => '296.8px' }), ...args);
};

const run = (...args) => runWithSheets(attachPhoneSheets, ...args);

function startupDocument(overrides = {}) {
  const library = libraryDom();
  overrides = { chartList: library.chartList, libraryCount: library.libraryCount, nowButton: library.nowButton, ...overrides };
  const nodes = new Map();
  const element = (id: string) => {
    if (!nodes.has(id)) {
      const classes = new Set(), attributes = new Map(), listeners = new Map();
      const defaults = { id, ownerDocument: document, dataset: {} as DOMStringMap, style: { setProperty(name, value) { this[name] = value; }, removeProperty(name: string|number) { delete this[name]; } },
        hidden: false, inert: false, parentElement: null,
        prepend(child: { parentElement: unknown }) { child.parentElement = this; },
        contains(target: unknown) {
          for (let node = target; node && typeof node === 'object'; node = (node as { parentElement?: unknown }).parentElement) {
            if (node === this) return true;
          }
          return false;
        },
        closest(selector: string) {
          const ids = selector.split(',').map(value => value.trim().slice(1));
          for (let node = this; node; node = node.parentElement) if (ids.includes(node.id)) return node;
          return null;
        },
        focus() { document.activeElement = this; },
        addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
        removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
        send(type: string, extra: Record<string, unknown> = {}) {
          const event = { target: this, type, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0,
            clientY: 300, timeStamp: 0, detail: type === 'click' ? 1 : 0, defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
          for (const listener of [...listeners.get(type) || []] as const) listener(event);
          return event;
        },
        click() { return this.send('click', { detail: 0 }); },
        listenerCount(type) { return listeners.get(type)?.size || 0; }, querySelector: () => null, querySelectorAll: () => [],
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute: name => attributes.get(name) ?? null, removeAttribute: name => attributes.delete(name),
        classList: { contains: (name: unknown) => classes.has(name), toggle(name, value) { if (value) classes.add(name); else classes.delete(name); } },
        getBoundingClientRect() {
          const left = id === 'canvasWrap' ? parseFloat(element('studio').style['--studio-left-space']) || 0 : 0;
          const right = id === 'canvasWrap' ? parseFloat(element('studio').style['--studio-right-space']) || 0 : 0;
          return { left: 75 + left, right: 1475 - right, top: 0, bottom: 900, width: id === 'library' ? 296.8 : 1400 - left - right, height: 900 };
        },
      };
      const node = overrides[id] || {};
      for (const [name, value] of Object.entries(defaults)) if (!(name in node)) node[name] = value;
      nodes.set(id, node);
    }
    return nodes.get(id);
  };
  const document = Object.assign(new EventTarget(), { activeElement: null as unknown, defaultView: { innerHeight: 900, getComputedStyle: () => ({ bottom: '0px' }) }, body: { dataset: { calculationVersion: 'a'.repeat(64) } }, hidden: false,
    createElement: library.document.createElement, getElementById: element,
    querySelector: (selector: string) => {
      const id = { '.app-shell': 'shell', '.chart-tools': 'chartTools', '#summaryScreen .summary-heading': 'summaryHeading' }[selector];
      return id ? element(id) : null;
    },
    querySelectorAll: (selector: string) => selector.split(',').map((s: string) => ({ '.library': 'library', '.chart-summary': 'chartSummary', '.chart-view-tools': 'chartViewTools', '.canvas-wrap': 'canvasWrap' }[s.trim()])).filter(Boolean).map(element) });
  for (const id of ['bodygraph', 'chartLoadingArt'] as const) Object.assign(element(id), {
    viewBox: { baseVal: { x: 0, y: 0, width: 640, height: 820 } },
    preserveAspectRatio: { baseVal: { align: 6, meetOrSlice: 1 } },
  });
  for (const [panelId, handleId, contentId] of [['library', 'librarySheetHandle', 'librarySheetContent'], ['chartSummary', 'summarySheetHandle', 'summarySheetContent']] as const) {
    const panel = element(panelId), content = element(contentId);
    content.parentElement = panel;
    element(handleId).parentElement = panel;
    panel.querySelector = (selector: string) => selector === '.phone-sheet-content' ? content : null;
  }
  element('summaryChartCaption').parentElement = element('summaryHeading');
  element('lifetimeControls').querySelector = (selector: string) => selector === '.lifetime-heading' ? element('lifetimeHeading') : null;
  element('canvasWrap').parentElement = element('studio');
  element('studio').parentElement = element('workspace');
  element('shell').dataset.booting = 'true';
  return { document, element, rows: library.children };
}

const layoutStub = () => ({ frame: () => STUDIO_FOOTPRINT.frame, insets: () => ({ side: 4, top: 112, bottom: 68 }), refresh() {}, setTimelineKind() {}, subscribeViewport() {} });

const emptyStore = () => ({ charts: [], has: () => false, get: () => undefined });

function assertPageZoomBlocked(document) {
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
    let reads = 0, creates = 0, options, received;
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
    const { panels, workspace, store, libraryView, camera, cameraView, gestures, previewLoading, initialPresentation, releaseLoadingContent, getPhoneSheetMode, ...existingPorts } = received;
    assert.deepEqual(existingPorts, { dayClient: client, layout, toast, viewStore, savedView });
  }
});

for (const failure of ['import', 'initialization'] as const) {
  test(`${failure} failure replaces endless loading with an explicit reload action`, async () => {
    const attributes = new Map([['aria-busy', 'true']]);
    const canvas = { dataset: { chartState: 'loading' }, setAttribute: (name: string, value: string) => attributes.set(name, value) };
    const status = { textContent: 'Загружаем карту…' };
    let retry, reloads = 0;
    const button = { hidden: true, addEventListener(type, callback) { assert.equal(type, 'click'); retry = callback; } };
    const nodes = { canvasWrap: canvas, chartLoadingStatus: status, chartLoadingRetry: button };
    const { document } = startupDocument(nodes);
    const error = new Error('Startup failed');
    const loadApp = async () => {
      assertPageZoomBlocked(document);
      if (failure === 'import') throw error;
      return { startApp() { throw error; } };
    };
    await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), layoutStub, () => () => {},
      () => ({ read: () => null }), emptyStore, loadApp, { reload() { reloads++; } });
    assertPageZoomBlocked(document);
    assert.equal(canvas.dataset.chartState, 'error');
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
    let layout, received, initial, bootingDuringPlacement;
    await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), (options) => {
      bootingDuringPlacement = element('shell').dataset.booting;
      layout = createStudioLayout({ ...options, viewport: null, media: { matches: phone },
        readStyle: () => ({ scrollPaddingTop: '112px', scrollPaddingLeft: '4px', getPropertyValue: () => '0px' }) });
      return layout;
    }, () => () => {}, () => ({ read: () => savedView }), emptyStore, async () => {
      initial = { left: element('library').classList.contains('open'), right: element('chartSummary').classList.contains('open'),
        screen: element('studio').dataset.workspaceScreen, width: element('canvasWrap').getBoundingClientRect().width, booting: element('shell').dataset.booting,
        captionHost: element('summaryChartCaption').parentElement, studioInert: element('studio').inert };
      return { startApp(value) { received = value; } };
    });
    assert.equal(initial!.left, left, 'the navigation is present while app.ts is still loading');
    assert.equal(initial!.studioInert, Boolean(phone && left), 'only the phone navigation blocks interaction with the chart area behind it');
    assert.equal(initial!.right, right && screen === 'chart', 'only the chart workspace projects the saved right panel');
    assert.equal(initial!.screen, screen);
    assert.equal(initial!.captionHost, element('summaryHeading'), 'the loading caption already occupies its ready-layout host');
    assert.ok(Math.abs(initial!.width - expectedWidth) < 1e-7, 'the loading preview already occupies the saved free area');
    assert.equal(bootingDuringPlacement, 'true', 'initial projection is applied with transitions disabled');
    assert.equal(initial!.booting, undefined, 'after placement the loading menu can respond with normal motion');
    assert.deepEqual(received!.panels.snapshot, { left, right }, 'the app inherits the same restored owner');
    assert.equal(received!.workspace.screen, screen);
    layout!.destroy();
  }
});


test('loading navigation uses real saved rows, count and current section before the application loads', async () => {
  const chart = { id: 'saved', name: 'Анна', source: 'manual' as const, personality: [1], design: [] };
  for (const [screen, selectedId, expected] of [['chart', 'saved', 'saved'], ['chart', 'missing', 'current-transit'],
    ['library', 'saved', null], ['charts', 'saved', null], ['account', 'saved', null]] as const) {
    const { document, element, rows } = startupDocument();
    const store = { charts: [chart], has: (id: string) => id === chart.id, get: (id: string) => id === chart.id ? chart : undefined };
    let storeReads = 0, firstRow, loadingError, attached = false;
    const savedView = { selectedId, workspace: screen, panels: { left: true, right: false } };
    await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), layoutStub,
      () => () => {}, () => ({ read: () => savedView }), () => { storeReads++; return store; }, async () => {
        try {
        assert.equal(element('libraryCount').textContent, '1');
        assert.equal(rows.length, 1); firstRow = rows[0];
        assert.match(element('chartList').innerHTML, /Анна/);
        assert.equal(firstRow.querySelector('.chart-card').getAttribute('aria-pressed'), String(expected === 'saved'));
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
            attachChartLibrary({ ...ports, view: ports.libraryView, document, session: { selectedId }, getSelectedId: () => expected });
            assert.equal(rows.length, 1);
            assert.equal(rows[0], firstRow, 'attaching real library commands retains the exact prepared DOM row');
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
  let loadingView, received, loadingError;
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
    const storage = tabStorage(); let imports = 0, reloads = 0, options;
    const location = { hostname, port: '3636', href: `http://${hostname}:3636/`, reload() { reloads++; } };
    const boot = async (document) => run(attachPageGestures, document, class { observe() {} disconnect() {} }, value => { options = value; return {}; }, layoutStub,
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
  const { document, element } = startupDocument(); let imported = false, options;
  const search = '?preview=loading&fps=1&perf=1&controls=5&palette=gold';
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, value => { options = value; return {}; }, layoutStub,
    () => () => {}, () => ({ read: () => null }), emptyStore, async () => { imported = true; return { startApp() {} }; },
    { port: '3636', href: `http://localhost:3636/${search}`, search });
  assert.equal(imported, true);
  assert.ok(options!.initialDate, 'an obsolete link cannot suppress normal day loading');
  assert.equal(element('toggleLoadingPreview').getAttribute('aria-pressed'), 'false');
});

test('early loading controls update and persist the tab while application import is pending', async () => {
  const saved = { version: 1, selectedId: 'current-transit', panels: { left: false, right: false }, mandala: false,
    transit: { live: false, date: '2026-10-04', timeZone: 'UTC', index: 123 }, planets: { selectedPlanets: ['sun'], selectedDesignPlanets: [] } };
  const { document, element } = startupDocument(); const writes = []; let received;
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), layoutStub,
    () => () => {}, () => ({ read: () => saved, write: value => { writes.push(value); return true; } }), emptyStore, async () => {
      element('mandalaSwitch').click();
      element('lifetimeToggle').click();
      element('summarySwitch').click();
      assert.equal(element('mandalaSwitch').getAttribute('aria-checked'), 'true');
      assert.equal(element('lifetimeToggle').getAttribute('aria-pressed'), 'true');
      assert.equal(element('studio').dataset.initialTimeline, 'lifetime');
      assert.equal(writes.at(-1).panels.right, true);
      assert.equal(writes.at(-1).mandala, true);
      assert.equal(writes.at(-1).lifetime.opened, true);
      assert.deepEqual(writes.at(-1).transit, saved.transit);
      assert.deepEqual(writes.at(-1).planets, saved.planets);
      return { startApp(ports) { received = ports; } };
    });
  assert.ok(received, 'startup handed off without hiding a failed assertion as an import error');
  assert.equal(received!.savedView.mandala, true);
  assert.equal(received!.savedView.lifetime.opened, true);
});



test('saved timeline geometry and tool visibility exist before the application import', async () => {
  const personal = libraryRecordAtMinute(natalDayFixture(), 754);
  const charts = [personal, { id: 'manual', source: 'manual' as const, personality: [1], design: [] }];
  for (const [saved, panel, kind, heading] of [
    [{ selectedId: 'current-transit' }, 'transit', 'day', true],
    [{ selectedId: 'current-transit', lifetime: { opened: true, mode: 'lifetime' } }, 'lifetime', 'chronicle', true],
    [{ selectedId: personal.id, lifetime: { opened: true, mode: 'lifetime' } }, 'lifetime', 'day', false],
    [{ selectedId: personal.id, natalDay: { opened: true } }, 'natal-day', 'natal-day', false],
    [{ selectedId: personal.id }, 'natal-day', 'natal-day', false],
    [{ selectedId: personal.id, natalDay: { opened: false } }, 'none', 'day', false],
    [{ selectedId: personal.id, returns: { opened: true } }, 'lifetime', 'day', false],
    [{ selectedId: 'manual' }, 'none', 'day', true],
    [{ selectedId: 'missing', lifetime: { opened: true, mode: 'lifetime' } }, 'transit', 'day', true],
  ] as const) {
    const { document, element } = startupDocument();
    let options: { timelineKind: unknown; }, received, failure;
    const store = { charts, has: (id: string) => charts.some(chart => chart.id === id), get: (id: string) => charts.find(chart => chart.id === id) };
    await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), (value: { timelineKind: unknown; }) => { options = value; return layoutStub(); },
      () => () => {}, () => ({ read: () => saved }), () => store, async () => {
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
    assert.equal(received!.initialPresentation.timelineKind, kind);
    assert.equal(received!.initialPresentation.timelinePanel || 'none', panel);
  }
});


test('panel buttons work before app import and hand the same choices and camera to the application once', async () => {
  const savedView = { selectedId: 'current-transit', panels: { left: false, right: true }, camera: { x: -50, y: -50, k: 1.5 } };
  const { document, element } = startupDocument();
  let layout, before, received, failure;
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), (options) => {
    layout = createStudioLayout({ ...options, viewport: null, media: { matches: false },
      readStyle: () => ({ scrollPaddingTop: '112px', scrollPaddingLeft: '4px', getPropertyValue: () => '0px' }) });
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
    return { startApp(ports: { panels: { beginRestore: () => void; restore: (arg0: { left: boolean; right: boolean; }) => void; setRight: (arg0: boolean,arg1: { automatic: boolean; }) => void; }; }) {
      received = ports;
      ports.panels.beginRestore(); ports.panels.restore(savedView.panels);
      ports.panels.setRight(true, { automatic: true });
    } };
  });
  assert.ifError(failure);
  assert.deepEqual(received!.panels.snapshot, { left: true, right: false });
  assert.equal(element('bodygraph').style.transform, before);
  for (const id of ['openLibrary', 'summarySwitch', 'libraryBackdrop', 'summaryBackdrop'] as const) assert.equal(element(id).listenerCount('click'), 0, 'temporary handlers detach before app owns commands');
  received!.releaseLoadingContent();
  assert.equal(element('mainNavigation').inert, false);
  assert.equal(element('chartSummary').inert, true);
  layout!.destroy();
});


// EventTarget has no DOM ancestry: dispatch document capture first, then the
// element's real command only when capture did not consume the click.
function captureClick(document: EventTarget, target: { click: () => void }, detail = 1) {
  const event = Object.assign(new Event('click', { cancelable: true }), { detail });
  Object.defineProperty(event, 'target', { value: target });
  document.dispatchEvent(event);
  if (!event.defaultPrevented) target.click();
  return event;
}
function swipeSheetHandle(handle: { send: (type: string, extra?: Record<string, unknown>) => { defaultPrevented: boolean } }, direction: -1 | 1) {
  handle.send('pointerdown', { clientY: 300, timeStamp: 0 });
  handle.send('pointermove', { clientY: 300 + direction * 60, timeStamp: 50 });
  handle.send('pointerup', { clientY: 300 + direction * 60, timeStamp: 60 });
  assert.equal(handle.send('click').defaultPrevented, true, 'the swipe compatibility click cannot change the settled size');
}
function phoneStartupLayout() {
  return { ...layoutStub(), phone: true, readViewport: () => ({ top: 0, height: 900 }) };
}

test('sheet collapse preserves the returns screen before and after application handoff', async () => {
  const { document, element } = startupDocument();
  const personal = libraryRecordAtMinute(natalDayFixture(), 754);
  const saved = { selectedId: personal.id, panels: { left: false, right: true }, returns: { opened: true, eventId: 'selected-return' } };
  const store = { charts: [personal], has: (id: string) => id === personal.id, get: (id: string) => id === personal.id ? personal : undefined };
  let received, failure, closedReturns = 0;
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), phoneStartupLayout,
    () => () => {}, () => ({ read: () => saved }), () => store, async () => {
      try {
        assert.equal(element('chartSummary').dataset.screen, 'returns');
        element('summarySheetHandle').click();
        swipeSheetHandle(element('summarySheetHandle'), 1);
        assert.equal(element('chartSummary').dataset.sheetSize, 'collapsed');
        assert.equal(element('chartSummary').classList.contains('open'), true);
        assert.equal(element('summarySwitch').getAttribute('aria-expanded'), 'true');
        assert.equal(element('summarySheetContent').inert, true);
        assert.equal(element('chartSummary').dataset.screen, 'returns');
        swipeSheetHandle(element('summarySheetHandle'), -1);
        assert.equal(element('chartSummary').dataset.sheetSize, 'medium');
      } catch (error) { failure = error; }
      return { startApp(ports) {
        received = ports;
        ports.releaseLoadingContent();
        ports.panels.finishRestore();
        element('summarySwitch').addEventListener('click', () => { closedReturns++; ports.panels.setRight(false); });
      } };
    });
  assert.ifError(failure);
  assert.ok(received, 'the real sheet controller reaches application handoff');
  document.activeElement = element('summarySheetContent');
  swipeSheetHandle(element('summarySheetHandle'), 1);
  assert.equal(element('chartSummary').dataset.sheetSize, 'collapsed');
  assert.equal(element('chartSummary').dataset.screen, 'returns');
  assert.equal(element('summarySheetContent').inert, true);
  assert.equal(document.activeElement, element('summarySheetHandle'), 'focus leaves folded content but stays in the same sheet');
  assert.equal(received.panels.right, true);
  assert.equal(closedReturns, 0, 'changing height never issues the ready close command');
  assert.deepEqual(received.savedView.returns, saved.returns);
});

test('outside taps preserve every sheet size and its explicit command only reveals without closing', async () => {
  for (const size of ['collapsed', 'medium', 'expanded'] as const) {
    const { document, element } = startupDocument();
    const saved = { selectedId: 'current-transit', panels: { left: false, right: true } };
    let received, commandCalls = 0;
    await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), phoneStartupLayout,
      () => () => {}, () => ({ read: () => saved }), emptyStore, async () => ({ startApp(ports) {
        received = ports;
        ports.releaseLoadingContent(); ports.panels.finishRestore();
        element('summarySwitch').addEventListener('click', () => { commandCalls++; });
      } }));
    assert.ok(received);
    if (size !== 'collapsed') element('summarySheetHandle').click();
    if (size === 'expanded') swipeSheetHandle(element('summarySheetHandle'), -1);
    const height = element('chartSummary').style['--phone-sheet-height'];
    captureClick(document, element('summarySheetContent'));
    for (let index = 0; index < 3; index++) captureClick(document, element('canvasWrap'));
    assert.equal(element('chartSummary').dataset.sheetSize, size);
    assert.equal(element('chartSummary').style['--phone-sheet-height'], height);
    assert.equal(element('summarySheetContent').inert, size === 'collapsed');
    assert.equal(received.panels.right, true);
    for (let index = 0; index < 3; index++) {
      const reveal = captureClick(document, element('summarySwitch'));
      assert.equal(reveal.defaultPrevented, true, 'capture consumes the command before the closing handler');
      assert.equal(element('chartSummary').dataset.sheetSize, size === 'collapsed' ? 'medium' : size);
      assert.equal(element('summarySheetContent').inert, false);
      assert.equal(received.panels.right, true);
      assert.equal(commandCalls, 0);
    }
  }
});

test('a chart pan and a subsequent outside tap both preserve the sheet height', async () => {
  const { document, element } = startupDocument();
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), phoneStartupLayout,
    () => () => {}, () => ({ read: () => ({ panels: { left: false, right: true } }) }), emptyStore,
    async () => ({ startApp() {} }));
  element('summarySheetHandle').click();
  const pointer = (type: string, x: number) => document.dispatchEvent(Object.assign(new Event(type), { isPrimary: true, clientX: x, clientY: 100 }));
  pointer('pointerdown', 100); pointer('pointermove', 130);
  captureClick(document, element('canvasWrap'));
  assert.equal(element('chartSummary').dataset.sheetSize, 'medium', 'the compatibility click after a pan is ignored');
  pointer('pointerdown', 130);
  captureClick(document, element('canvasWrap'));
  assert.equal(element('chartSummary').dataset.sheetSize, 'medium');
});

test('an empty phone chart starts with the folded summary, while Account starts without a sheet', async () => {
  for (const screen of ['chart', 'account'] as const) {
    const { document, element } = startupDocument();
    let received, initial;
    await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), phoneStartupLayout,
      () => () => {}, () => ({ read: () => ({ workspace: screen, panels: { left: false, right: false } }) }), emptyStore, async () => {
        await Promise.resolve();
        initial = { left: element('library').classList.contains('open'), right: element('chartSummary').classList.contains('open'),
          size: element('chartSummary').dataset.sheetSize, contentInert: element('summarySheetContent').inert };
        return { startApp(ports) { received = ports; ports.panels.finishRestore(); } };
      });
    assert.ok(received);
    assert.equal(initial.left, false);
    assert.equal(initial.right, screen === 'chart');
    assert.equal(initial.size, screen === 'chart' ? 'collapsed' : undefined);
    if (screen === 'chart') assert.equal(initial.contentInert, true);
    assert.deepEqual(received.panels.snapshot, { left: false, right: screen === 'chart' });
  }
});

test('phone sheet reload restores its settled height and preserves newer loading gestures', async () => {
  for (const [savedMode, action, expected] of [
    ['collapsed', 'none', 'collapsed'], ['medium', 'none', 'medium'], ['expanded', 'none', 'expanded'],
    ['collapsed', 'reveal', 'medium'], ['medium', 'expand', 'expanded'], ['expanded', 'collapse', 'collapsed'],
  ] as const) {
    const { document, element } = startupDocument(), storage = tabStorage();
    const viewStore = createViewStore({ getStorage: () => storage });
    viewStore.write({ version: 1, selectedId: 'current-transit', panels: { left: false, right: true }, phoneSheetMode: savedMode });
    let initialSize;
    const handoff: { ports?: StartupPorts } = {};
    await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), phoneStartupLayout,
      () => () => {}, () => viewStore, emptyStore, async () => {
        initialSize = element('chartSummary').dataset.sheetSize;
        if (action === 'reveal' || action === 'expand') element('summarySheetHandle').click();
        if (action === 'collapse') element('summarySheetHandle').send('keydown', { key: 'Escape' });
        return { startApp(ports: StartupPorts) {
          handoff.ports = ports;
          ports.panels.beginRestore(); ports.panels.restore(ports.savedView?.panels); ports.panels.finishRestore();
          ports.releaseLoadingContent?.();
        } };
      });
    assert.ok(handoff.ports);
    const received = handoff.ports;
    assert.equal(initialSize, savedMode, 'the saved height is painted before application loading finishes');
    assert.equal(element('chartSummary').dataset.sheetSize, expected, 'late restoration cannot replace a newer gesture');
    assert.equal(element('summarySheetContent').inert, expected === 'collapsed');
    assert.equal(createViewStore({ getStorage: () => storage }).read()!.phoneSheetMode, expected,
      'settled loading gestures update the same tab snapshot for another reload');
    assert.equal(received.getPhoneSheetMode?.(), expected, 'the application reads the retained controller');
    assert.equal(received.panels.right, true, 'folding does not close the chart or Returns owner');
  }
});

test('closing chart navigation before switching to Account never schedules a hidden summary', async () => {
  const { document } = startupDocument();
  let received;
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), phoneStartupLayout,
    () => () => {}, () => ({ read: () => ({ panels: { left: true, right: false } }) }), emptyStore,
    async () => ({ startApp(ports) { received = ports; ports.panels.finishRestore(); } }));
  assert.ok(received);
  const changes: { left: boolean; right: boolean }[] = [];
  received.panels.subscribe(value => changes.push(value));
  received.panels.setLeft(false);
  received.workspace.setScreen('account');
  await Promise.resolve();
  assert.equal(received.workspace.screen, 'account');
  assert.deepEqual(received.panels.snapshot, { left: false, right: false });
  assert.deepEqual(changes, [{ left: false, right: false }], 'the deferred chart default does not reopen a panel on Account');
});


test('revealing the folded summary opens returns only for the active personal returns mode', async () => {
  for (const [label, pressed, screen, expected] of [
    ['Возвраты', 'true', 'summary', 1], ['Возвраты', 'false', 'summary', 0],
    ['Летопись', 'true', 'summary', 0], ['Возвраты', 'true', 'returns', 0],
  ] as const) {
    const { document, element } = startupDocument();
    let requested = 0;
    await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), phoneStartupLayout,
      () => () => {}, () => ({ read: () => ({ panels: { left: false, right: true } }) }), emptyStore,
      async () => ({ startApp(ports) { ports.releaseLoadingContent(); } }));
    element('lifetimeToggle').setAttribute('aria-label', label);
    element('lifetimeToggle').setAttribute('aria-pressed', pressed);
    element('chartSummary').dataset.screen = screen;
    element('summaryReturns').addEventListener('click', () => { requested++; element('chartSummary').dataset.screen = 'returns'; });
    swipeSheetHandle(element('summarySheetHandle'), 1);
    assert.equal(element('chartSummary').dataset.sheetSize, 'collapsed');
    assert.equal(requested, 0, 'folding never starts or closes an exploration');
    swipeSheetHandle(element('summarySheetHandle'), -1);
    assert.equal(element('chartSummary').dataset.sheetSize, 'medium');
    assert.equal(requested, expected, `${label}, ${pressed}, ${screen}`);
    assert.equal(element('chartSummary').dataset.screen, expected ? 'returns' : screen);
  }
});


test('phone navigation covers the independent returns sheet without changing its height or exploration', async () => {
  for (const mode of ['medium', 'collapsed'] as const) {
    const { document, element } = startupDocument();
    const personal = libraryRecordAtMinute(natalDayFixture(), 754);
    const saved = { selectedId: personal.id, panels: { left: false, right: true }, returns: { opened: true, eventId: 'selected-return' } };
    const store = { charts: [personal], has: (id: string) => id === personal.id, get: (id: string) => id === personal.id ? personal : undefined };
    let sheets: ReturnType<typeof attachPhoneSheets>, failure, received;
    await runWithSheets(options => { sheets = attachPhoneSheets(options); return sheets; },
      attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), phoneStartupLayout,
      () => () => {}, () => ({ read: () => saved }), () => store, async () => {
        try {
          if (mode === 'medium') element('summarySheetHandle').click();
          const height = element('chartSummary').style['--phone-sheet-height'];
          assert.equal(element('chartSummary').dataset.screen, 'returns');
          const opened = captureClick(document, element('openLibrary'));
          assert.equal(opened.defaultPrevented, false, 'the navigation button reaches its own toggle command');
          assert.equal(element('library').classList.contains('open'), true);
          assert.equal(element('chartSummary').classList.contains('open'), true, 'opening navigation does not replace the lower sheet');
          assert.equal(element('studio').inert, true, 'the visible area behind navigation cannot receive interaction');
          captureClick(document, element('librarySheetContent'));
          captureClick(document, element('canvasWrap'));
          assert.equal(element('chartSummary').dataset.sheetSize, mode, 'navigation and background clicks do not fold the covered sheet');
          assert.equal(element('chartSummary').style['--phone-sheet-height'], height);
          assert.equal(element('chartSummary').dataset.screen, 'returns');
          captureClick(document, element('openLibrary'));
          assert.equal(element('library').classList.contains('open'), false);
          assert.equal(element('studio').inert, false);
          assert.equal(element('chartSummary').classList.contains('open'), true);
          assert.equal(element('chartSummary').dataset.sheetSize, mode);
          assert.equal(element('chartSummary').style['--phone-sheet-height'], height);
          assert.equal(element('chartSummary').dataset.screen, 'returns');
        } catch (error) { failure = error; }
        return { startApp(ports) { received = ports; } };
      });
    assert.ifError(failure);
    assert.ok(received);
    assert.deepEqual(received.panels.snapshot, { left: false, right: true });
    assert.deepEqual(received.savedView.returns, saved.returns);
  }
});


test('outside taps preserve the current height of a revealed phone sheet', async () => {
  const { document, element } = startupDocument();
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), phoneStartupLayout,
    () => () => {}, () => ({ read: () => ({ panels: { left: false, right: true } }) }), emptyStore,
    async () => ({ startApp() {} }));
  element('summarySheetHandle').click();
  const height = element('chartSummary').style['--phone-sheet-height'];
  for (let index = 0; index < 3; index++) captureClick(document, element('canvasWrap'));
  assert.equal(element('chartSummary').dataset.sheetSize, 'medium');
  assert.equal(element('chartSummary').style['--phone-sheet-height'], height);
  assert.equal(element('chartSummary').classList.contains('open'), true);
});


test('actual startup reload round-trips each sheet height through the same tab record', async () => {
  for (const mode of ['collapsed', 'medium', 'expanded'] as const) {
    const storage = tabStorage();
    const viewStore = createViewStore({ getStorage: () => storage });
    viewStore.write({ version: 1, selectedId: 'current-transit', panels: { left: false, right: true },
      phoneSheetMode: 'medium', mandala: true, transit: { live: false, date: '2026-10-04', timeZone: 'UTC', index: 400 } });
    const first = startupDocument();
    await run(attachPageGestures, first.document, class { observe() {} disconnect() {} }, () => ({}), phoneStartupLayout,
      () => () => {}, () => viewStore, emptyStore, async () => {
        assert.equal(first.element('chartSummary').dataset.sheetSize, 'medium');
        if (mode === 'collapsed') first.element('summarySheetHandle').send('keydown', { key: 'Escape' });
        if (mode === 'expanded') first.element('summarySheetHandle').send('keydown', { key: 'ArrowUp' });
        first.document.hidden = true;
        first.document.dispatchEvent(new Event('visibilitychange'));
        return { startApp(ports: StartupPorts) { ports.releaseLoadingContent?.(); } };
      });
    assert.notEqual(first.element('shell').dataset.pageState, 'error', 'initialization and loading assertions must complete');
    assert.equal(viewStore.read()!.phoneSheetMode, mode);
    const second = startupDocument();
    let beforeReady, afterReady;
    await run(attachPageGestures, second.document, class { observe() {} disconnect() {} }, () => ({}), phoneStartupLayout,
      () => () => {}, () => createViewStore({ getStorage: () => storage }), emptyStore, async () => {
        beforeReady = second.element('chartSummary').dataset.sheetSize;
        return { startApp(ports: StartupPorts) {
          ports.panels.beginRestore(); ports.panels.restore(ports.savedView?.panels); ports.panels.finishRestore();
          ports.releaseLoadingContent?.(); afterReady = second.element('chartSummary').dataset.sheetSize;
        } };
      });
    assert.notEqual(second.element('shell').dataset.pageState, 'error', 'reload initialization must complete');
    assert.equal(beforeReady, mode, 'a fresh startup restores the stored height before app readiness');
    assert.equal(afterReady, mode, 'handoff preserves the restored height');
    const saved = createViewStore({ getStorage: () => storage }).read()!;
    assert.equal(saved.mandala, true);
    assert.deepEqual(saved.transit, { live: false, date: '2026-10-04', timeZone: 'UTC', index: 400 });
    assert.deepEqual(saved.panels, { left: false, right: true });
  }
});
