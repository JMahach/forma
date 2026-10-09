import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChartSession } from '../src/state/chart-session.js';
import { createChartExploration } from '../src/state/chart-exploration.js';
import { createTransitPlanetFilter } from '../src/state/transit-planets.js';
import { createReturnsController } from '../src/state/returns.js';
import { createNatalDayExplorer } from '../src/state/natal-day.js';
import { createLifetimeExplorer } from '../src/state/lifetime.js';
import { eligibleCycleChart, lifeTimelineForChart, cycleTimeZone } from '../src/domain/cycles.js';
import { attachChartLibrary } from '../src/views/library.js';
import { attachKnowledgeEntry } from '../src/views/knowledge-entry.js';
import { chartCaption } from '../src/views/chart-display.js';
import { ageText, completedAge } from '../src/domain/personal-age.js';
import { returnsVisibleWindow } from '../src/domain/returns-window.js';
import { chartAtMinute } from '../src/domain/natal-day.js';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.mjs';
import { LIFETIME_PLANETS } from '../shared/lifetime-format.js';

// Execute the whole composition root, preserving declaration and attachment
// order. Browser-heavy views use ports; library/knowledge and state owners are real.
const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const imports = [...source.matchAll(/^import \{ (.*?) \} from .*;$/gm)].flatMap(match => match[1].split(', '));
const body = source.replace(/^import .*;\n/gm, '').replace('export function startApp', 'function startApp');
const noop = () => {};
function browser() {
  const elements = new Map(), listeners = new Map();
  const document = { body: { dataset: {} }, activeElement: null,
    getElementById: element, querySelector: () => null, querySelectorAll: () => [],
    addEventListener(type, handler) { listeners.set(type, handler); } };
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set(), attributes = new Map(), handlers = new Map();
      elements.set(id, { id, dataset: {}, hidden: false, inert: false, innerHTML: '',
        contains(node) { return node === this || id === 'library' && ['nowButton', 'openKnowledge'].includes(node?.id); },
        focus() { document.activeElement = this; }, querySelector: () => element(`${id}-child`), querySelectorAll: () => [],
        getBoundingClientRect: () => ({ top: 0, bottom: 200 }),
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute: name => attributes.get(name) ?? null, removeAttribute: name => attributes.delete(name),
        classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
        addEventListener(type, handler, capture = false) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push({ handler, capture }); },
        async dispatch(type, event = {}) {
          let stopped = false;
          for (const { handler } of [...handlers.get(type) || []].sort((a, b) => Number(b.capture) - Number(a.capture))) {
            if (stopped) break;
            await handler({ target: this, ...event, stopImmediatePropagation() { stopped = true; } });
          }
        },
        click() { return this.dispatch('click'); },
      });
    }
    return elements.get(id);
  }
  return { document, element };
}

function harness({ metaError = null, charts = [], getReturn = () => assert.fail('no return calculation expected'), getPoint = () => assert.fail('these navigation actions do not request lifetime points') } = {}) {
  const { document, element } = browser();
  const store = { charts, storageAvailable: true, get: id => charts.find(chart => chart.id === id), has: id => charts.some(chart => chart.id === id) };
  let graph, gestures, natalDay, returns, birthOptions, lifetime, lifetimeOptions, transitOptions, finishModule, failModule, loads = 0, reloads = 0, renders = 0, dayRequests = 0, chartSelections = 0, interruptions = 0;
  const module = new Promise((resolve, reject) => { finishModule = resolve; failModule = reject; });
  const ports = {
    createChartSession, createChartExploration, createTransitPlanetFilter,
    createReturnsController: options => returns = createReturnsController(options),
    eligibleCycleChart, lifeTimelineForChart, cycleTimeZone, returnsVisibleWindow, attachChartLibrary,
    attachKnowledgeEntry: options => attachKnowledgeEntry({ ...options, eventTarget: document,
      load: async () => ({ attachKnowledge: dialog => ({ show() { dialog.open = true; } }) }) }),
    attachActivationPopover: () => ({ close: noop, reposition: noop }),
    attachHoverPreview: () => ({ clear: noop }),
    attachGestures: (_svg, options) => { gestures = options; return { reset: noop, resize: noop }; },
    pointerTarget: noop, createCameraView: noop,
    attachMandalaMode: () => ({ enabled: false }), createMandalaMotion: noop,
    mandalaPreviewFromPointer: noop, mandalaPreviewFromFocus: noop, mandalaSelectionFromTarget: noop,
    createGraphController: options => { graph = options; return { choose: noop, chooseSummary: noop, changeChart: id => { chartSelections++; options.onChartChange(id); },
      clear: noop, render: () => { renders++; }, preview: noop, selectionState: { primary: null } }; },
    attachCameraControls: noop, createCameraChangeHandler: () => noop,
    createChartStore: () => store,
    createViewSession: () => ({ restore: async () => true, interrupt: () => { interruptions++; }, schedule: noop }),
    chartCaption,
    createChartHeadingLayout: ({ title, subtitle }) => ({ updateText(a, b) { title.textContent = a; subtitle.textContent = b; }, refresh: noop }),
    attachBirthForm: options => { birthOptions = options; return { opened: false }; },
    attachLiveTransit: options => { transitOptions = options; return { state: { wanted: true }, current: null, refresh: noop, setWanted: noop }; },
    attachTransitNavigation: noop,
    attachTransitControls: () => ({ update: noop, setCoveredByLifetime: noop }),
    attachNatalDayExplorer: options => natalDay = createNatalDayExplorer({ ...options, dayClient: { getDay: async () => { dayRequests++; return natalDayFixture(); } } }),
    attachChartSummary: () => ({ close: noop, setReturnsVisible: noop }), attachTelegramGestures: noop, attachPerformanceMonitor: noop,
    attachChartLoading: () => ({ update: noop }), createCyclesClient: () => ({ events: async () => ({ events: [] }), chart: getReturn }), ageText, completedAge,
    updateReturnsEntry: noop, attachReturnMarkers: () => ({ update: noop }),
  };
  for (const name of imports) assert.equal(typeof ports[name], 'function', `provide the explicit browser port ${name}`);
  const startApp = new Function(...imports, 'document', 'ResizeObserver', 'location', 'window', 'loadLifetimeView',
    `${body.replace("import('./views/lifetime-controls.js')", 'loadLifetimeView()')}\nreturn startApp;`)(
    ...imports.map(name => ports[name]), document, class { observe() {} }, { search: '' },
    { location: { reload() { reloads++; } } }, () => { loads++; return module; });
  startApp({ dayClient: {}, layout: { refresh: noop }, toast: noop, viewStore: { write: noop }, savedView: null });
  return { element, select: id => graph.onChartChange(id), get shown() { return graph.getChart(); }, get renders() { return renders; }, get lifetime() { return lifetime; }, get loads() { return loads; },
    get interruptions() { return interruptions; },
    filter: id => gestures.onSelect({ type: 'planet-filter', id }),
    failModule, get reloads() { return reloads; }, get natalDay() { return natalDay; },
    get lifetimeOptions() { return lifetimeOptions; },
    get returns() { return returns; }, get dayRequests() { return dayRequests; }, get chartSelections() { return chartSelections; },
    clockTick() { transitOptions.onStateChange({ wanted: false }); },
    edit() { birthOptions.beforeOpen(); },
    saveMetadata(chart) { charts = store.charts = charts.map(previous => previous.id === chart.id ? chart : previous); birthOptions.onSave(chart.id, { metadataOnly: true }); },
    finishModule() { finishModule({ attachLifetimeControls(options) {
      lifetimeOptions = options;
      lifetime = createLifetimeExplorer({ ...options, client: {
        getMeta: async () => { if (metaError) throw metaError; return { startUtc: '1801-01-01T00:00:00Z', endExclusiveUtc: '2400-01-01T00:00:00Z',
          stepSeconds: 600, samples: 31_504_320, planets: [...LIFETIME_PLANETS] }; },
        getPoint,
      } });
      lifetime.setAvailable = value => { if (!value) lifetime.close(); };
      lifetime.syncTransit = noop;
      lifetime.setVisibleWindow = value => { lifetime.visibleWindow = value; };
      return lifetime;
    } }); },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('the natal caption keeps todays age across day, life and closed rails while events keep their moment', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2028-09-23T23:59:59Z') });
  const chart = chartAtMinute(natalDayFixture(), 754, personalChartFixture());
  const h = harness({ charts: [chart] });
  await h.select(chart.id);
  assert.match(h.element('chartSubtitle').textContent, /12:34.*1\u00a0год$/);
  t.mock.timers.setTime(Date.parse('2028-09-24T00:00:00Z'));
  const requests = h.dayRequests, renders = h.renders;
  h.clockTick();
  assert.match(h.element('chartSubtitle').textContent, /12:34.*2\u00a0года$/);
  assert.equal(h.dayRequests, requests); assert.equal(h.renders, renders);
  h.natalDay.scrub(755);
  assert.match(h.element('chartSubtitle').textContent, /12:35.*2\u00a0года$/);
  const opening = h.element('lifetimeToggle').click(); h.finishModule(); await opening; await tick();
  assert.match(h.element('chartSubtitle').textContent, /12:34.*2\u00a0года$/);
  t.mock.timers.setTime(Date.parse('2029-09-24T00:00:00Z'));
  const lifeRequests = h.dayRequests, lifeRenders = h.renders;
  h.clockTick();
  assert.match(h.element('chartSubtitle').textContent, /12:34.*3\u00a0года$/);
  assert.equal(h.dayRequests, lifeRequests); assert.equal(h.renders, lifeRenders);
  await h.element('lifetimeToggle').click();
  assert.equal(h.lifetime.state.opened, false); assert.equal(h.natalDay.state.opened, false);
  assert.match(h.element('chartSubtitle').textContent, /12:34.*3\u00a0года$/);
  await h.select('current-transit');
  assert.doesNotMatch(h.element('chartSubtitle').textContent, /лет|год/);
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
  const h = harness({ getPoint: async index => {
    requests++;
    const utc = new Date(Date.parse('1801-01-01T00:00:00Z') + index * 600000).toISOString();
    return { index, utc, longitudes: Array.from({ length: 11 }, (_, i) => i * 23),
      design: { utc, designUtc: '1899-10-01T00:00:00Z', designArcResidualDegrees: 0,
        longitudes: Array.from({ length: 11 }, (_, i) => i * 23 + 10) } };
  } });
  await tick(); await h.element('lifetimeToggle').click(); h.finishModule(); await tick();
  await h.lifetime.restore({ opened: true, mode: 'lifetime', fromDate: '1900-01-01', toDate: '1900-01-03',
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
  assert.deepEqual(h.shown.primary.activations.personality, full.activations.personality.filter(e => e.planet === 'moon'));
  assert.deepEqual(h.shown.primary.activations.design, full.planetFilter.designActivations);
});

test('application starts before the lazy knowledge entry closes its initialized library', async () => {
  const { element } = harness();
  await element('openLibrary').click();
  assert.equal(element('library').inert, false);
  await element('openKnowledge').click();
  assert.equal(element('library').inert, true, 'opening the lazy reference dismisses the actual library');
  assert.equal(element('knowledgeDialog').open, true, 'the reference opens after successful application composition');
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
  const chart = chartAtMinute(natalDayFixture(), 754, personalChartFixture());
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
  h.failModule(new Error('offline')); await tick();
  assert.equal(h.element('lifetimeToggle').title, 'Обновить страницу и загрузить летопись');
  assert.equal(h.element('lifetimeToggle').getAttribute('aria-label'), 'Обновить страницу и загрузить летопись');
  assert.equal(h.element('lifetimeToggle').getAttribute('aria-pressed'), 'false');
  await h.element('lifetimeToggle').click();
  assert.equal(h.reloads, 1);
});

test('the personal rail endpoint uses the shared completed-age wording at a truncated lifetime boundary', async () => {
  const chart = chartAtMinute(natalDayFixture({ date: '2378-01-01' }), 0,
    personalChartFixture({ birthDate: '2378-01-01', utc: '2378-01-01T00:00:00Z' }));
  const h = harness({ charts: [chart] });
  await tick(); await h.element('lifetimeToggle').click();
  h.select(chart.id); await h.element('natalDayToggle').click();
  assert.equal(h.natalDay.state.opened, false, 'the app owns the Day toggle after its view binding is removed');
  h.finishModule(); await tick();
  assert.deepEqual(h.lifetimeOptions.formatEndpoints({ toDate: '2399-12-31' }), ['Рождение', '21 год']);
});


test('a real day publication reaches the scene once without repeating navigation or changing the accepted source during reads', async () => {
  const chart = chartAtMinute(natalDayFixture(), 754, personalChartFixture());
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
  const chart = chartAtMinute(natalDayFixture(), 754, personalChartFixture());
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
  assert.equal(h.shown.primary, chart);
  assert.equal(closes, 1, 'the command closes Day; a loading notification must not repeat that command');
});

test('metadata editing retains a personal minute and updates future scrubs without another Day request or chart selection', async () => {
  const chart = chartAtMinute(natalDayFixture(), 754, personalChartFixture());
  const h = harness({ charts: [chart] });
  await tick(); h.select(chart.id); await tick(); h.natalDay.scrub(800);
  const selectedUtc = h.shown.utc, requests = h.dayRequests, selections = h.chartSelections;
  h.edit();
  assert.equal(h.natalDay.state.opened, true);
  assert.equal(h.shown.utc, selectedUtc);
  const updated = { ...chart, name: 'Обновлённое имя', note: 'Новая заметка' };
  h.saveMetadata(updated); await tick();
  assert.equal(h.shown.utc, selectedUtc); assert.equal(h.shown.primary.name, updated.name);
  assert.equal(h.shown.primary.note, updated.note); assert.equal(h.natalDay.state.index, 800);
  assert.equal(h.natalDay.state.exactOriginal, false);
  assert.equal(h.dayRequests, requests); assert.equal(h.chartSelections, selections, 'metadata never enters graph navigation, which clears selection/camera context');
  h.natalDay.scrub(810);
  assert.equal(h.shown.primary.name, updated.name); assert.equal(h.shown.primary.note, updated.note);
  h.natalDay.reset(); assert.equal(h.shown.primary, updated);
});

test('renaming keeps the confirmed exact return and list filters while updating its natal source', async () => {
  const chart = chartAtMinute(natalDayFixture(), 754, personalChartFixture());
  const event = { id: 'saturn:2050-01-01T12:00:29.432Z', body: 'saturn', utc: '2050-01-01T12:00:29.432Z', cycle: 1 };
  const exact = { ...chart, id: 'exact-return', utc: event.utc };
  let returnRequests = 0;
  const h = harness({ charts: [chart], getReturn: async () => { returnRequests++; return { event, chart: exact }; } });
  await tick(); h.select(chart.id); await tick();
  await h.element('lifetimeToggle').click(); h.finishModule(); await tick();
  await h.returns.selectEvent(event.id, { restoredEvent: event });
  await h.returns.setBodies(['venus']);
  const requests = h.dayRequests, selections = h.chartSelections;
  const updated = { ...chart, name: 'Новое имя', note: 'Новая заметка' };
  h.edit(); h.saveMetadata(updated); await tick();
  assert.equal(h.shown.kind, 'return'); assert.equal(h.shown.utc, '2050-01-01T12:00:29.432Z');
  assert.match(h.element('chartTitle').textContent, /^Новое имя · Возврат Сатурна/);
  assert.equal(h.element('chartSubtitle').textContent, '1 января 2050 г. · 12:00:29 · UTC · 23\u00a0года');
  assert.equal(h.shown.primary, updated); assert.equal(h.shown.secondary, exact); assert.equal(h.shown.event, event);
  assert.equal(h.returns.state.selectedEvent, event); assert.equal(h.returns.current, exact);
  assert.equal(h.returns.state.natal, updated); assert.deepEqual(h.returns.state.bodies, ['venus']);
  assert.equal(h.lifetime.state.requestedUtc, Date.parse(event.utc));
  assert.equal(h.dayRequests, requests); assert.equal(returnRequests, 1); assert.equal(h.chartSelections, selections);
});

test('opening the editor still cancels a pending return and its late answer cannot overwrite renamed birth', async () => {
  const chart = chartAtMinute(natalDayFixture(), 754, personalChartFixture());
  const event = { id: 'saturn:2050-01-01T12:00:29.432Z', body: 'saturn', utc: '2050-01-01T12:00:29.432Z', cycle: 1 };
  let complete, signal;
  const h = harness({ charts: [chart], getReturn: (_query, requestSignal) => {
    signal = requestSignal; return new Promise(resolve => { complete = resolve; });
  } });
  await tick(); h.select(chart.id); await tick();
  await h.element('lifetimeToggle').click(); h.finishModule(); await tick();
  const previousCaption = h.element('chartSubtitle').textContent;
  const pending = h.returns.selectEvent(event.id, { restoredEvent: event }); await tick();
  assert.equal(h.element('chartSubtitle').textContent, previousCaption, 'a pending event is not presented as the displayed chart');
  h.edit();
  assert.equal(signal.aborted, true);
  const updated = { ...chart, name: 'Новое имя', note: 'Новая заметка' }; h.saveMetadata(updated);
  complete({ event, chart: { ...chart, utc: event.utc } }); assert.equal(await pending, false);
  assert.equal(h.shown.primary, updated); assert.equal(h.shown.secondary, null);
  assert.equal(h.element('chartTitle').textContent, 'Новое имя');
  assert.equal(h.element('chartSubtitle').textContent, previousCaption, 'late return metadata cannot replace the accepted birth caption');
  assert.equal(h.returns.state.loadingChart, false); assert.equal(h.returns.state.selectedEvent, null);
});


test('pending personal life data retains todays natal age until the new moment is actually shown', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2028-10-08T12:00:00Z') });
  const chart = chartAtMinute(natalDayFixture(), 754, personalChartFixture());
  let resolve;
  const response = new Promise(done => { resolve = done; });
  const h = harness({ charts: [chart], getPoint: async index => {
    await response;
    const utc = new Date(Date.parse('1801-01-01T00:00:00Z') + index * 600000).toISOString();
    return { index, utc, longitudes: Array.from({ length: 11 }, (_, i) => i * 23),
      design: { utc, designUtc: '2049-10-01T00:00:00Z', designArcResidualDegrees: 0,
        longitudes: Array.from({ length: 11 }, (_, i) => i * 23 + 10) } };
  } });
  await h.select(chart.id);
  const opening = h.element('lifetimeToggle').click(); h.finishModule(); await opening; await tick();
  const target = Date.parse('2050-01-01T12:00:00Z');
  h.lifetimeOptions.beforeScrub(target);
  const pending = h.lifetime.scrub(target);
  await tick(); h.clockTick();
  assert.equal(h.shown.kind, 'single');
  assert.match(h.element('chartSubtitle').textContent, /12:34.*2\u00a0года$/);
  resolve(); await pending;
  assert.equal(h.shown.kind, 'transit');
  assert.match(h.element('chartSubtitle').textContent, /2050.*23\u00a0года$/);
  h.clockTick();
  assert.match(h.element('chartSubtitle').textContent, /2050.*23\u00a0года$/);
});

test('year endpoint captions also use UTC when a saved timezone is obsolete', async () => {
  const chart = { ...chartAtMinute(natalDayFixture(), 754, personalChartFixture()), timezone: 'Obsolete/Zone' };
  const h = harness({ charts: [chart] });
  await tick(); await h.element('lifetimeToggle').click();
  h.select(chart.id); await h.element('natalDayToggle').click();
  h.finishModule(); await tick(); await h.returns.setYear(2027);
  const bounds = { minUtc: Date.parse('2026-01-01T00:00:00Z'), maxUtc: Date.parse('2028-01-01T00:00:00Z') };
  const labels = h.lifetimeOptions.formatEndpoints(bounds);
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
  const chart = chartAtMinute(natalDayFixture(), 754, personalChartFixture());
  const h = harness({ charts: [chart], metaError: Object.assign(new Error('Создаём летопись'), { code: 'lifetime_preparing' }) });
  await h.select(chart.id);
  await h.element('lifetimeToggle').click(); h.finishModule(); await tick();
  assert.equal(h.lifetime.state.status, 'preparing');
  assert.equal(h.lifetime.state.mode, 'lifetime');
  assert.equal(h.lifetime.state.fromDate, '2026-09-24');
  assert.equal(h.lifetime.state.toDate, '2126-09-24');
  assert.equal(h.shown.primary, chart);
  assert.equal(h.natalDay.state.opened, false);
});
