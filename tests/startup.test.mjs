import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STUDIO_FOOTPRINT, MANDALA_FRAME } from '../src/scene/geometry/frames.js';
import { attachGestures } from '../src/scene/gestures.js';
import { attachCameraControls } from '../src/views/camera-controls.js';
import { attachLoadingPreview } from '../src/views/loading-preview.js';
import { lifeTimelineForChart } from '../src/domain/cycles.js';
import { attachPhoneSheets } from '../src/ui/phone-sheet.js';
import { attachPageGestures } from '../src/ui/page-gestures.js';
import { createPanelState } from '../src/state/panels.js';
import { createWorkspaceState } from '../src/state/workspace.js';
import { createStudioLayout } from '../src/ui/layout/studio-controller.js';
import { attachChartLibrary, createChartLibraryView } from '../src/views/library.js';
import * as chartSession from '../src/state/chart-session.js';
import { libraryDom } from './helpers/library-dom.mjs';
import * as cameraModule from '../src/scene/camera.js';
import { createCameraView } from '../src/scene/camera-view.js';
import { holdLoadingContent, commitLoadingLayout } from '../src/views/chart-loading.js';
import { studioPresentation } from '../src/ui/studio-presentation.js';
import { eligibleCycleChart } from '../src/domain/cycles.js';
import { canExploreNatalDay } from '../src/state/natal-day.js';
import { createCameraChangeHandler } from '../src/views/camera-controls.js';
import { libraryRecordAtMinute, natalDayFixture } from './fixtures/natal-day.mjs';
import { ACTIVATION_COLUMN_REVEAL_DISTANCE } from '../src/scene/geometry/activation-layout.js';

// Run the entry module with its browser ports, leaving its actual initialization
// order intact while replacing the network-loaded application.
const source = readFileSync(new URL('../src/startup.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace("import('./app.js')", 'loadApp()');
const evaluate = new (Object.getPrototypeOf(async function () {}).constructor)(
  'attachGestures', 'attachCameraControls', 'attachLoadingPreview', 'lifeTimelineForChart', 'attachPhoneSheets', 'holdLoadingContent', 'commitLoadingLayout', 'studioPresentation', 'eligibleCycleChart', 'canExploreNatalDay', 'createCameraChangeHandler', 'createCamera', 'createCameraView', 'MANDALA_FRAME', 'ACTIVATION_COLUMN_REVEAL_DISTANCE', 'createChartLibraryView', 'resolveSelectedChartId', 'STUDIO_FOOTPRINT', 'createPanelState', 'createWorkspaceState', 'getComputedStyle', 'attachPageGestures', 'document', 'ResizeObserver', 'createTransitDayClient', 'createStudioLayout', 'createToast', 'createViewStore', 'createChartStore', 'loadApp', 'location', source);
function tabStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
const runWithSheets = (attachSheets, ...args) => {
  const storage = args[10] ?? tabStorage();
  args.length = 10;
  args[9] = { ...args[9], href: args[9]?.href || 'http://localhost:3636/' };
  const attachPreview = options => attachLoadingPreview({ ...options, getStorage: () => storage });
  return evaluate(attachGestures, attachCameraControls, attachPreview, lifeTimelineForChart, attachSheets, holdLoadingContent, commitLoadingLayout, studioPresentation, eligibleCycleChart, canExploreNatalDay, createCameraChangeHandler, cameraModule.createCamera, createCameraView, MANDALA_FRAME, ACTIVATION_COLUMN_REVEAL_DISTANCE, createChartLibraryView, chartSession.resolveSelectedChartId, STUDIO_FOOTPRINT, createPanelState, createWorkspaceState,
    () => ({ getPropertyValue: () => '296.8px' }), ...args);
};

const run = (...args) => runWithSheets(attachPhoneSheets, ...args);

function startupDocument(overrides = {}) {
  const library = libraryDom();
  overrides = { chartList: library.chartList, libraryCount: library.libraryCount, nowButton: library.nowButton, ...overrides };
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) {
      const classes = new Set(), attributes = new Map(), listeners = new Map();
      const defaults = { id, ownerDocument: document, dataset: {}, style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
        hidden: false, inert: false,
        addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
        removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
        click() { for (const listener of [...listeners.get('click') || []]) listener({ target: this }); },
        listenerCount(type) { return listeners.get(type)?.size || 0; }, querySelector: () => null, querySelectorAll: () => [],
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute: name => attributes.get(name) ?? null, removeAttribute: name => attributes.delete(name),
        classList: { contains: name => classes.has(name), toggle(name, value) { if (value) classes.add(name); else classes.delete(name); } },
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
  const document = Object.assign(new EventTarget(), { defaultView: { innerHeight: 900, getComputedStyle: () => ({ bottom: '0px' }) }, body: { dataset: { calculationVersion: 'a'.repeat(64) } }, hidden: false,
    createElement: library.document.createElement, getElementById: element, querySelector: selector => selector === '.app-shell' ? element('shell') : null,
    querySelectorAll: selector => selector.split(',').map(s => ({ '.library': 'library', '.chart-summary': 'chartSummary', '.chart-view-tools': 'chartViewTools', '.canvas-wrap': 'canvasWrap' }[s.trim()])).filter(Boolean).map(element) });
  for (const id of ['bodygraph', 'chartLoadingArt']) Object.assign(element(id), {
    viewBox: { baseVal: { x: 0, y: 0, width: 640, height: 820 } },
    preserveAspectRatio: { baseVal: { align: 6, meetOrSlice: 1 } },
  });
  element('lifetimeControls').querySelector = selector => selector === '.lifetime-heading' ? element('lifetimeHeading') : null;
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
  ]) {
    let reads = 0, creates = 0, options, received;
    const toast = () => {}, layout = layoutStub(), client = {};
    const viewStore = { read() { reads++; return savedView; } };
    const { document } = startupDocument();
    await run(attachPageGestures, document, class { observe() {} disconnect() {} }, value => { options = value; return client; }, () => layout,
      () => toast, () => { creates++; return viewStore; }, emptyStore, async () => {
        assertPageZoomBlocked(document);
        return { startApp(value) { received = value; } };
      });
    assert.equal(options.calculationVersion, 'a'.repeat(64));
    assert.equal(Boolean(options.initialDate), needsDay, JSON.stringify(savedView));
    assert.equal(creates, 1); assert.equal(reads, 1);
    const { panels, workspace, store, libraryView, camera, cameraView, gestures, previewLoading, initialPresentation, releaseLoadingContent, ...existingPorts } = received;
    assert.deepEqual(existingPorts, { dayClient: client, layout, toast, viewStore, savedView });
  }
});

for (const failure of ['import', 'initialization']) {
  test(`${failure} failure replaces endless loading with an explicit reload action`, async () => {
    const attributes = new Map([['aria-busy', 'true']]);
    const canvas = { dataset: { chartState: 'loading' }, setAttribute: (name, value) => attributes.set(name, value) };
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
    retry();
    assert.equal(reloads, 1);
  });
}


test('saved panel space and visible shells are restored before the application import finishes', async () => {
  for (const [left, right, screen, expectedWidth, phone = false] of [
    [false, false, 'chart', 1400], [true, false, 'chart', 1103.2],
    [false, true, 'chart', 1103.2], [true, true, 'chart', 806.4],
    [true, true, 'charts', 1103.2],
    [true, true, 'chart', 1400, true], [false, true, 'chart', 1400, true],
  ]) {
    const { document, element } = startupDocument();
    const savedView = { selectedId: 'current-transit', panels: { left, right }, workspace: screen };
    let layout, received, initial, bootingDuringPlacement;
    await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), options => {
      bootingDuringPlacement = element('shell').dataset.booting;
      layout = createStudioLayout({ ...options, viewport: null, media: { matches: phone },
        readStyle: () => ({ scrollPaddingTop: '112px', scrollPaddingLeft: '4px', getPropertyValue: () => '0px' }) });
      return layout;
    }, () => () => {}, () => ({ read: () => savedView }), emptyStore, async () => {
      initial = { left: element('library').classList.contains('open'), right: element('chartSummary').classList.contains('open'),
        screen: element('studio').dataset.workspaceScreen, width: element('canvasWrap').getBoundingClientRect().width, booting: element('shell').dataset.booting };
      return { startApp(value) { received = value; } };
    });
    assert.equal(initial.left, left, 'the navigation is present while app.js is still loading');
    assert.equal(initial.right, right && !(phone && left) && screen === 'chart', 'only the chart workspace projects the saved right panel');
    assert.equal(initial.screen, screen);
    assert.ok(Math.abs(initial.width - expectedWidth) < 1e-7, 'the loading preview already occupies the saved free area');
    assert.equal(bootingDuringPlacement, 'true', 'initial projection is applied with transitions disabled');
    assert.equal(initial.booting, undefined, 'after placement the loading menu can respond with normal motion');
    assert.deepEqual(received.panels.snapshot, { left, right: right && !(phone && left) }, 'the app inherits the same restored owner');
    assert.equal(received.workspace.screen, screen);
    layout.destroy();
  }
});


test('loading navigation uses real saved rows, count and current section before the application loads', async () => {
  const chart = { id: 'saved', name: 'Анна', source: 'manual', personality: [1], design: [] };
  for (const [screen, selectedId, expected] of [['chart', 'saved', 'saved'], ['chart', 'missing', 'current-transit'],
    ['library', 'saved', null], ['charts', 'saved', null], ['account', 'saved', null]]) {
    const { document, element, rows } = startupDocument();
    const store = { charts: [chart], has: id => id === chart.id, get: id => id === chart.id ? chart : undefined };
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
        for (const [id, section] of [['openKnowledge', 'library'], ['openAllCharts', 'charts'], ['openAccount', 'account']]) {
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
  assert.ok(received.camera); assert.ok(received.cameraView);
  assert.ok(Math.abs(received.camera.getView().k / received.camera.getFittedView().k - 1.7) < 1e-9);
  assert.equal(element('chartLoadingArt').style.transform, loadingView, 'handoff retains the already painted projection');
});


test('the Preview button holds the next startup without importing the application or fetching a day', async () => {
  for (const hostname of ['localhost', '127.0.0.1', '192.168.1.124']) {
    const storage = tabStorage(); let imports = 0, reloads = 0, options;
    const location = { hostname, port: '3636', href: `http://${hostname}:3636/`, reload() { reloads++; } };
    const boot = async document => run(attachPageGestures, document, class { observe() {} disconnect() {} }, value => { options = value; return {}; }, layoutStub,
      () => () => {}, () => ({ read: () => null }), emptyStore, async () => { imports++; return { startApp() {} }; }, location, storage);
    const first = startupDocument();
    await boot(first.document);
    assert.equal(imports, 1, 'an untouched tab loads the application');
    first.element('toggleLoadingPreview').click();
    assert.equal(reloads, 1, 'only the explicit button asks for a reload');
    const { document, element } = startupDocument();
    await boot(document);
    assert.equal(imports, 1, 'button-enabled preview remains the real pre-import scene after reload');
    assert.equal(options.initialDate, null, 'the held preview has no data consumer');
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
  assert.ok(options.initialDate, 'an obsolete link cannot suppress normal day loading');
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
  assert.equal(received.savedView.mandala, true);
  assert.equal(received.savedView.lifetime.opened, true);
});



test('saved timeline geometry and tool visibility exist before the application import', async () => {
  const personal = libraryRecordAtMinute(natalDayFixture(), 754);
  const charts = [personal, { id: 'manual', source: 'manual', personality: [1], design: [] }];
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
  ]) {
    const { document, element } = startupDocument();
    let options, received, failure;
    const store = { charts, has: id => charts.some(chart => chart.id === id), get: id => charts.find(chart => chart.id === id) };
    await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), value => { options = value; return layoutStub(); },
      () => () => {}, () => ({ read: () => saved }), () => store, async () => {
        try {
          assert.equal(element('studio').dataset.initialTimeline, panel, JSON.stringify(saved));
          assert.equal(options.timelineKind, kind);
          for (const [name, id] of [['transit', 'transitControls'], ['natal-day', 'natalDayControls'], ['lifetime', 'lifetimeControls']])
            assert.equal(element(id).hidden, name !== panel);
          assert.equal(element('lifetimeHeading').hidden, !heading);
          assert.equal(element('natalDayToggle').hidden, saved.selectedId !== personal.id);
          assert.equal(element('natalDayToggle').getAttribute('aria-expanded'), String(panel === 'natal-day'));
          assert.equal(element('natalDayToggle').getAttribute('aria-pressed'), String(panel === 'natal-day'));
        } catch (error) { failure = error; }
        return { startApp(ports) { received = ports; } };
      });
    assert.ifError(failure);
    assert.equal(received.initialPresentation.timelineKind, kind);
    assert.equal(received.initialPresentation.timelinePanel || 'none', panel);
  }
});


test('panel buttons work before app import and hand the same choices and camera to the application once', async () => {
  const savedView = { selectedId: 'current-transit', panels: { left: false, right: true }, camera: { x: -50, y: -50, k: 1.5 } };
  const { document, element } = startupDocument();
  let layout, before, received, failure;
  await run(attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), options => {
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
    return { startApp(ports) {
      received = ports;
      ports.panels.beginRestore(); ports.panels.restore(savedView.panels);
      ports.panels.setRight(true, { automatic: true });
    } };
  });
  assert.ifError(failure);
  assert.deepEqual(received.panels.snapshot, { left: true, right: false });
  assert.equal(element('bodygraph').style.transform, before);
  for (const id of ['openLibrary', 'summarySwitch', 'libraryBackdrop', 'summaryBackdrop']) assert.equal(element(id).listenerCount('click'), 0, 'temporary handlers detach before app owns commands');
  received.releaseLoadingContent();
  assert.equal(element('mainNavigation').inert, false);
  assert.equal(element('chartSummary').inert, true);
  layout.destroy();
});


test('sheet dismissal uses the active close command before and after application handoff', async () => {
  const { document, element } = startupDocument();
  let sheetOptions, closedReturns = 0, earlyOpened, earlyClosed, finalPanel;
  await runWithSheets(options => {
    sheetOptions = options;
    return attachPhoneSheets(options);
  }, attachPageGestures, document, class { observe() {} disconnect() {} }, () => ({}), layoutStub,
  () => () => {}, () => ({ read: () => null }), emptyStore, async () => {
    element('summarySwitch').click();
    earlyOpened = element('summarySwitch').getAttribute('aria-expanded');
    sheetOptions.sheets[1].onClose();
    earlyClosed = element('summarySwitch').getAttribute('aria-expanded');
    return { startApp({ panels }) {
      panels.setRight(true);
      element('summarySwitch').addEventListener('click', () => {
        closedReturns++;
        panels.setRight(false);
      });
      sheetOptions.sheets[1].onClose();
      sheetOptions.sheets[1].onClose();
      finalPanel = panels.right;
    } };
  });
  assert.notEqual(element('shell').dataset.pageState, 'error');
  assert.equal(earlyOpened, 'true');
  assert.equal(earlyClosed, 'false', 'the early command works while app downloads');
  assert.equal(closedReturns, 1, 'the ready command closes return exploration once; stale dismissal cannot reopen it');
  assert.equal(finalPanel, false);
});
