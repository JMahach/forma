import test from 'node:test';
import assert from 'node:assert/strict';
import { createNatalDayExplorer, canExploreNatalDay } from '../src/state/natal-day.js';
import { attachNatalDayExplorer } from '../src/views/natal-day-controls.js';
import { createChartSession } from '../src/state/chart-session.js';
import { createChartStore } from '../src/data/chart-store.js';
import { renderBodygraph } from '../src/scene/bodygraph-svg.js';
import { createGraphController } from '../src/scene/updates.js';
import { chartAtMinute, natalDayMinute } from '../src/domain/natal-day.js';
import { attachBirthForm } from '../src/views/birth-form.js';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.mjs';
import { dateDom } from './helpers/date-dom.mjs';

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function harness(getDay = async () => natalDayFixture()) {
  const requests = [], states = [], renders = [];
  const explorer = createNatalDayExplorer({
    dayClient: { getDay: (chart, options) => { requests.push({ chart, options }); return getDay(chart, options); } },
    onStateChange: state => states.push(state), onRender: () => renders.push(explorer.current),
  });
  return { explorer, requests, states, renders };
}

test('only calculated personal charts opt into a day and selecting one never starts a calculation', async () => {
  const h = harness(), chart = personalChartFixture();
  for (const candidate of [null, { ...chart, source: 'manual' }, { ...chart, source: 'transit' }, { ...chart, cityId: '' }, { ...chart, utc: '' }]) {
    assert.equal(canExploreNatalDay(candidate), false);
    h.explorer.select(candidate);
    assert.equal(await h.explorer.open(), false);
  }
  assert.equal(h.requests.length, 0);
  h.explorer.select(chart);
  assert.equal(h.explorer.state.available, true);
  assert.equal(h.explorer.current, null);
  assert.equal(h.requests.length, 0);
  await h.explorer.open();
  assert.equal(h.requests.length, 1);
  assert.equal(h.explorer.current, chart);
  assert.equal(h.explorer.state.index, 754, 'the saved second stays in its own minute');
  assert.equal(h.explorer.state.referenceIndex, 754);
  assert.equal(h.explorer.current.birthTime, '12:34:45');
  assert.deepEqual(h.renders, [], 'opening retains the original exact calculation');
});

test('scrub recalculates both sides locally; reset and close restore the original object including seconds', async () => {
  const h = harness(), chart = Object.freeze(personalChartFixture());
  h.explorer.select(chart); await h.explorer.open();
  h.explorer.scrub(754);
  assert.equal(h.explorer.current.birthTime, '12:34');
  assert.equal(h.explorer.current.utc, '2026-09-24T12:34:00Z');
  assert.equal(h.explorer.current.activations.personality.length, 13);
  assert.equal(h.explorer.current.activations.design.length, 13);
  const previous = h.explorer.current;
  h.explorer.scrub(755);
  assert.notEqual(h.explorer.current.activations.personality[0].longitude, previous.activations.personality[0].longitude);
  assert.equal(h.explorer.state.referenceIndex, 754, 'the birth reference belongs to the original chart');
  const selected = h.explorer.current, notifications = h.states.length, renders = h.renders.length;
  h.explorer.scrub(755.9);
  assert.equal(h.explorer.current, selected, 'repeating the same bounded minute retains the current calculation');
  assert.equal(h.states.length, notifications);
  assert.equal(h.renders.length, renders);
  assert.notEqual(h.explorer.current.activations.design[0].longitude, previous.activations.design[0].longitude);
  assert.equal(h.explorer.current.id, chart.id);
  assert.equal(h.requests.length, 1);
  h.explorer.reset();
  assert.equal(h.explorer.current, chart);
  assert.equal(h.explorer.state.index, 754);
  assert.equal(h.explorer.state.referenceIndex, 754);
  h.explorer.scrub(0); h.explorer.close();
  assert.equal(h.explorer.current, null);
  assert.equal(h.renders.at(-1), null, 'closed view resolves to saved chart at composition root');
  assert.equal(h.explorer.state.current, chart);
  await h.explorer.open();
  assert.equal(h.explorer.current, chart);
  assert.equal(h.requests.length, 1, 'reopening reuses its already loaded day');
  assert.equal(h.explorer.state.referenceIndex, 754);
});

test('switching chart or closing cancels the active view; stale completion cannot reopen or publish it', async () => {
  for (const change of ['select', 'close']) {
    let complete;
    const h = harness(() => new Promise(resolve => { complete = resolve; }));
    const chart = personalChartFixture(), next = personalChartFixture({ id: 'next' });
    h.explorer.select(chart);
    const pending = h.explorer.open();
    assert.equal(h.explorer.state.status, 'loading');
    if (change === 'select') h.explorer.select(next); else h.explorer.close();
    assert.equal(h.requests[0].options.signal.aborted, true);
    complete(natalDayFixture()); await pending;
    assert.equal(h.explorer.state.opened, false);
    assert.equal(h.explorer.state.original, change === 'select' ? next : chart);
    assert.equal(h.explorer.state.day, null);
    assert.equal(h.explorer.current, null);
    assert.deepEqual(h.renders, []);
  }
});

test('day failures retain the saved chart and explicit retry recovers without navigation', async () => {
  let fail = true;
  const h = harness(async () => { if (fail) throw new Error('Нет соединения'); return natalDayFixture(); });
  const chart = personalChartFixture();
  h.explorer.select(chart); await h.explorer.open();
  assert.equal(h.explorer.state.status, 'error');
  assert.equal(h.explorer.state.error, 'Нет соединения');
  assert.equal(h.explorer.current, chart);
  h.explorer.scrub(10);
  assert.equal(h.explorer.current, chart);
  fail = false; await h.explorer.retry();
  assert.equal(h.explorer.state.status, 'ready');
  assert.equal(h.explorer.state.error, '');
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.renders, []);
});

function element() {
  const attributes = new Map(), listeners = new Map();
  return { hidden: false, disabled: false, dataset: {}, style: {}, value: '', textContent: '', title: '', dateTime: '',
    setAttribute: (key, value) => attributes.set(key, String(value)), getAttribute: key => attributes.get(key),
    addEventListener: (type, listener) => listeners.set(type, listener), dispatch(type) { return listeners.get(type)?.(); },
  };
}
function uiHarness(getDay, withMarker = true, options = {}) {
  const elements = Object.fromEntries(['toggle', 'panel', 'range', 'status', 'retryButton', ...(withMarker ? ['marker'] : [])].map(key => [key, element()]));
  elements.hourMarks = dateDom().createElement('div');
  const explorer = attachNatalDayExplorer({ ...elements, dayClient: { getDay }, ...options });
  return { ...elements, explorer };
}

test('scrubbing onto saved birth UTC lights the dot without resetting the saved object', async () => {
  for (const seconds of ['00.000', '29.432']) {
    const h = uiHarness(async () => natalDayFixture());
    const chart = personalChartFixture({ utc: `2026-09-24T12:34:${seconds}Z` });
    h.explorer.select(chart); await h.explorer.open();
    assert.equal(h.marker.getAttribute('aria-pressed'), 'true');
    h.range.value = '755'; h.range.dispatch('input');
    assert.equal(h.marker.getAttribute('aria-pressed'), 'false');
    h.range.value = '754'; h.range.dispatch('input');
    assert.equal(h.marker.getAttribute('aria-pressed'), String(seconds === '00.000'));
    assert.equal(h.explorer.state.exactOriginal, false, 'indicator does not restore or replace the chart');
    h.marker.dispatch('click');
    assert.equal(h.explorer.current, chart); assert.equal(h.marker.getAttribute('aria-pressed'), 'true');
  }
});

test('birth-day hour marks follow packet segments even when historical UTC offset has seconds', async () => {
  const day = natalDayFixture({ date: '1900-01-01', timezone: 'Europe/Moscow', segments: [
    { index: 0, startUtc: '1899-12-31T21:29:43Z', utcOffset: 'UTC+02:30:17', offsetSeconds: 9017, fold: 0 },
  ] });
  const h = uiHarness(async () => day);
  h.explorer.select(personalChartFixture({ birthDate: day.date, utc: '1900-01-01T10:04:28Z' }));
  await h.explorer.open();
  const marks = h.hourMarks.children;
  assert.equal(marks.length, 25);
  assert.equal(marks[6].children[0].textContent, '06');
  assert.equal(Number.parseFloat(marks[6].style['--hour-position']), 360 / 1439 * 100);
  h.explorer.scrub(755);
  assert.equal(h.hourMarks.children, marks);
  h.explorer.close();
  assert.equal(h.hourMarks.children.length, 0);
});

test('birth day retry appears only on failure without needing a duplicate clock or restore button', async () => {
  const elements = Object.fromEntries(['toggle', 'panel', 'range', 'status', 'retryButton'].map(key => [key, element()]));
  let fail = true;
  const explorer = attachNatalDayExplorer({ ...elements, dayClient: { getDay: async () => {
    if (fail) throw Error('Offline');
    return natalDayFixture();
  } } });
  explorer.select(personalChartFixture());
  assert.equal(elements.retryButton.hidden, true);
  await explorer.open();
  assert.equal(elements.retryButton.hidden, false);
  fail = false; await elements.retryButton.dispatch('click');
  assert.equal(explorer.state.status, 'ready');
  assert.equal(elements.retryButton.hidden, true);
  assert.match(elements.range.getAttribute('aria-valuetext'), /UTC/);
});

test('only user natal scrubs and birth choices interrupt restoration; open, internal reset and retry do not', async () => {
  let fail = true, interruptions = 0;
  const h = uiHarness(async () => { if (fail) throw Error('Offline'); return natalDayFixture(); }, true,
    { onMomentInput: () => { interruptions++; } });
  const chart = personalChartFixture(); h.explorer.select(chart); await h.explorer.open();
  fail = false; await h.retryButton.dispatch('click');
  assert.equal(h.explorer.state.status, 'ready'); assert.equal(interruptions, 0);
  h.explorer.scrub(800); h.explorer.reset(); assert.equal(interruptions, 0);
  h.range.value = '801'; h.range.dispatch('input');
  assert.equal(h.explorer.current.utc, '2026-09-24T13:21:00Z'); assert.equal(interruptions, 1);
  h.marker.dispatch('click'); assert.equal(h.explorer.current, chart); assert.equal(interruptions, 2);
  h.explorer.scrub(802); h.marker.dispatch('click');
  assert.equal(h.explorer.current, chart); assert.equal(interruptions, 3);
});

test('controls distinguish repeated local minutes by offset and select the original fold using its UTC instant', async () => {
  const day = natalDayFixture({ date: '2026-11-01', timezone: 'America/New_York', samples: 1500, segments: [
    { index: 0, startUtc: '2026-11-01T04:00:00Z', utcOffset: 'UTC−04:00', offsetSeconds: -14400, fold: 0 },
    { index: 120, startUtc: '2026-11-01T06:00:00Z', utcOffset: 'UTC−05:00', offsetSeconds: -18000, fold: 1 },
    { index: 180, startUtc: '2026-11-01T07:00:00Z', utcOffset: 'UTC−05:00', offsetSeconds: -18000, fold: 0 },
  ] });
  const h = uiHarness(async () => day);
  const chart = personalChartFixture({ birthDate: day.date, timezone: day.timezone, birthTime: '01:30:45', utc: '2026-11-01T06:30:45Z', utcOffset: 'UTC−05:00', fold: 1 });
  h.explorer.select(chart); await h.explorer.open();
  assert.equal(h.range.max, '1499');
  assert.equal(h.range.value, '150');
  const reference = `${150 / 1499 * 100}%`;
  assert.equal(h.marker.hidden, false);
  assert.equal(h.marker.style.left, reference, 'the marker follows saved UTC into the correct repeated-hour fold');

  assert.match(h.range.getAttribute('aria-valuetext'), /^01\.11\.2026, 01:30:45, UTC−05:00/);
  h.range.value = '90'; h.range.dispatch('input');

  assert.equal(h.explorer.current.fold, 0);
  assert.equal(h.marker.style.left, reference, 'previewing the first 01:30 cannot move the saved second-fold marker');
  h.range.value = '150'; h.range.dispatch('input');

  assert.equal(h.explorer.current.fold, 1);
  assert.match(h.range.getAttribute('aria-valuetext'), /UTC−05:00, America\/New_York/);
  h.marker.dispatch('click');
  assert.equal(h.explorer.current, chart);

  assert.equal(h.retryButton.hidden, true);
  assert.equal(h.retryButton.title, 'Повторить загрузку дня рождения');
  assert.equal(h.marker.style.left, reference);
  h.range.value = '149'; h.range.dispatch('input');
  h.marker.dispatch('click');
  assert.equal(h.explorer.current, chart, 'the reference button restores the saved object, not its rounded minute');

  assert.equal(h.marker.getAttribute('aria-label'), 'Вернуться к сохранённому времени рождения');
});

test('opening the birth editor reads the saved birth time while the selected minute stays visible', async () => {
  const h = harness(), original = personalChartFixture();
  h.explorer.select(original); await h.explorer.open(); h.explorer.scrub(0);
  assert.notEqual(h.explorer.current, original);
  const preview = h.explorer.current;
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      ...element(), value: '', classList: { remove() {}, add() {}, toggle() {} },
      removeAttribute() {}, reset() {}, close() {}, querySelector: () => node('formExtras'), querySelectorAll: () => [],
      showModal() {
        assert.equal(h.explorer.state.opened, true);
        assert.equal(h.explorer.current, preview);
      },
    });
    return nodes.get(id);
  }
  node('chartForm').elements = Object.fromEntries(['name', 'birthPlace', 'note'].map(key => [key, node(key)]));
  const form = attachBirthForm({
    document: { getElementById: node, querySelectorAll: () => [] },
    store: { charts: [original] }, session: { selectedId: original.id, original },
    onSave() {}, toast() {}, beforeOpen() {},
  });
  form.open(true, original.id);
  assert.equal(node('birthTime').value, '12:34', 'the edit form uses saved time, never the scrubbed 00:00');
  assert.equal(h.renders.at(-1), preview, 'editing does not replace the displayed minute');
});

test('metadata replacement during a pending birth Day keeps its request valid and supplies new future captions', async () => {
  let complete;
  const h = harness(() => new Promise(resolve => { complete = resolve; })), original = personalChartFixture();
  h.explorer.select(original); const loading = h.explorer.open();
  const updated = { ...original, name: 'Новое имя', note: 'Новая заметка' };
  h.explorer.updateMetadata(updated);
  assert.equal(h.explorer.current, updated); assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.signal.aborted, false);
  complete(natalDayFixture()); assert.equal(await loading, true);
  assert.equal(h.explorer.state.status, 'ready'); assert.equal(h.explorer.state.referenceIndex, 754);
  h.explorer.scrub(800);
  assert.equal(h.explorer.current.name, updated.name); assert.equal(h.explorer.current.note, updated.note);
  assert.equal(h.requests.length, 1);
});

test('refreshing the accepted natal metadata retains real graph pins, crosses and camera transform', async () => {
  let original = chartAtMinute(natalDayFixture(), 754, personalChartFixture()), graph, explorer;
  const viewport = { innerHTML: '', transform: 'translate(-70,25) scale(1.4)', querySelector: () => null };
  const session = createChartSession({ store: { get: () => original, has: () => true }, getNatalDay: () => explorer, onChange: () => graph?.render() });
  explorer = createNatalDayExplorer({ dayClient: { getDay: async () => natalDayFixture() }, onRender: () => session.publish('natal-day', explorer.state.current) });
  session.select(original.id); await explorer.open();
  graph = createGraphController({ getChart: () => session.current, viewport,
    scene: { update(chart, selection, options) { viewport.innerHTML = renderBodygraph(chart, selection, options); }, clear() {} },
    getMandala: () => ({ enabled: true }), activationPopover: { close() {}, show() {}, refresh() {} } });
  explorer.scrub(800); graph.choose({ type: 'gate', id: 41 });
  graph.choose({ type: 'mandala-cross', cross: { longitude: 0, source: 'personality' }, additive: true });
  const pins = graph.selectionState.items, crosses = graph.selectionState.crosses, utc = session.current.utc;
  original = { ...original, name: 'Новое имя', note: 'Новая заметка' }; session.refreshOriginal();
  assert.equal(session.current.utc, utc); assert.equal(session.current.primary.name, original.name);
  assert.equal(graph.selectionState.items, pins); assert.equal(graph.selectionState.crosses, crosses);
  assert.equal(viewport.transform, 'translate(-70,25) scale(1.4)');
});

test('controls expose loading, error and retry without enabling unavailable minutes', async () => {
  let fail = true;
  const h = uiHarness(async () => { if (fail) throw new Error('Расчёт недоступен'); return natalDayFixture(); });
  assert.equal(h.toggle.hidden, true);
  h.explorer.select(personalChartFixture());
  assert.equal(h.toggle.hidden, false);
  const pending = h.explorer.open();
  assert.equal(h.panel.hidden, false);
  assert.equal(h.panel.getAttribute('aria-busy'), 'true');
  assert.equal(h.range.disabled, true);
  assert.equal(h.status.textContent, 'Рассчитываем день…');
  assert.equal(h.panel.dataset.status, 'loading');
  assert.equal(h.marker.hidden, true);
  await pending;
  assert.equal(h.status.textContent, 'Расчёт недоступен');
  assert.equal(h.retryButton.textContent, 'Повторить');
  assert.equal(h.retryButton.disabled, false);
  assert.equal(h.panel.dataset.status, 'error');
  assert.equal(h.marker.hidden, true);
  fail = false; await h.retryButton.dispatch('click');
  assert.equal(h.range.disabled, false);
  assert.equal(h.status.textContent, '');
  assert.equal(h.panel.dataset.status, 'ready');
  assert.equal(h.marker.hidden, false);
  h.explorer.close();
  assert.equal(h.panel.hidden, true);
  assert.equal(h.toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(h.marker.hidden, true);
});

test('saved birth marker has exact endpoints for different day lengths and never follows a scrubbed minute', async () => {
  for (const samples of [1, 1380, 1410, 1440, 1470, 1500]) {
    const day = natalDayFixture({ samples });
    let requests = 0;
    const h = uiHarness(async () => { requests++; return day; });
    for (const index of new Set([0, Math.floor((samples - 1) / 2), samples - 1])) {
      const utc = new Date(Date.parse(natalDayMinute(day, index).utc) + 45_000).toISOString();
      const original = personalChartFixture({ utc });
      h.explorer.select(original);
      assert.equal(h.marker.hidden, true);
      await h.explorer.open();
      const reference = `${index / Math.max(1, samples - 1) * 100}%`;
      assert.equal(h.marker.style.left, reference);
      assert.equal(h.marker.hidden, false);
      const loaded = requests;
      for (const minute of [0, samples - 1, 0]) {
        h.explorer.scrub(minute);
        assert.equal(h.marker.style.left, reference);
        assert.equal(h.range.value, String(minute));
        assert.match(h.range.getAttribute('aria-valuetext'), /UTC\+00:00/);
      }
      h.explorer.reset();
      assert.equal(h.marker.style.left, reference);
      assert.equal(h.explorer.current, original);
      assert.equal(requests, loaded, 'marking, scrubbing and resetting reuse the loaded day');
    }
  }
});

test('closed, changed and stale birth-day loads cannot show an old reference marker', async () => {
  let complete;
  const h = uiHarness(() => new Promise(resolve => { complete = resolve; }));
  h.explorer.select(personalChartFixture());
  const first = h.explorer.open();
  assert.equal(h.marker.hidden, true);
  assert.equal(h.explorer.state.referenceIndex, null);
  h.explorer.select(personalChartFixture({ id: 'next' }));
  complete(natalDayFixture()); await first;
  assert.equal(h.marker.hidden, true);
  assert.equal(h.marker.style.left, '');
  assert.equal(h.panel.dataset.status, 'idle');
  assert.equal(h.explorer.state.referenceIndex, null, 'a stale load cannot supply a birth reference');
  const second = h.explorer.open();
  h.explorer.close();
  complete(natalDayFixture()); await second;
  assert.equal(h.marker.hidden, true);
  assert.equal(h.marker.style.left, '');
  const third = h.explorer.open();
  complete(natalDayFixture()); await third;
  assert.equal(h.marker.hidden, false);
  h.explorer.select(personalChartFixture({ id: 'third' }));
  assert.equal(h.marker.hidden, true, 'selecting another saved chart removes the previous marker immediately');
  assert.equal(h.marker.style.left, '');
  assert.equal(h.explorer.state.referenceIndex, null);
});

test('birth controls remain usable when the optional marker is omitted', async () => {
  const h = uiHarness(async () => natalDayFixture(), false);
  h.explorer.select(personalChartFixture());
  await h.explorer.open();
  h.explorer.scrub(800);
  assert.equal(h.range.value, '800');
  assert.equal(h.panel.dataset.status, 'ready');
});

test('personal scrubbing keeps real graph pins, camera transform and saved storage intact', async () => {
  const original = chartAtMinute(natalDayFixture(), 754, personalChartFixture()), writes = [], values = JSON.stringify([original]);
  const store = createChartStore({ getStorage: () => ({ getItem: () => values, setItem: (...args) => writes.push(args) }) });
  const session = createChartSession({ store });
  session.select(original.id);
  const before = JSON.stringify(store.charts), charts = store.charts;
  const viewport = { innerHTML: '', transform: 'translate(-70,25) scale(1.4)', querySelector: () => null };
  let explorer;
  const graph = createGraphController({
    scene: { update(chart, selection, options) { viewport.innerHTML = renderBodygraph(chart, selection, options); }, clear() { viewport.innerHTML = ''; } },
    getChart: () => explorer?.current || session.original, viewport,
    getMandala: () => ({ enabled: true }), activationPopover: { close() {}, show() {}, refresh() {} },
    onChartChange(id) { explorer.close(); session.select(id); explorer.select(session.original); graph.render(); },
  });
  explorer = createNatalDayExplorer({ dayClient: { getDay: async () => natalDayFixture() }, onRender: graph.render });
  explorer.select(session.original); await explorer.open();
  graph.choose({ type: 'gate', id: 41 });
  graph.choose({ type: 'mandala-cross', cross: { longitude: 0, source: 'personality' }, additive: true });
  const pins = graph.selectionState.items, crosses = graph.selectionState.crosses, markup = viewport.innerHTML;
  for (const minute of [0, 100, 1200, 1439]) explorer.scrub(minute);
  assert.ok(viewport.innerHTML !== markup, 'minute positions update the rendered graph');
  assert.equal(graph.selectionState.items, pins);
  assert.equal(graph.selectionState.crosses, crosses);
  assert.equal(viewport.transform, 'translate(-70,25) scale(1.4)');
  explorer.reset();
  assert.equal(explorer.current, session.original);
  assert.equal(store.charts, charts);
  assert.equal(JSON.stringify(store.charts), before);
  assert.deepEqual(writes, []);
  explorer.scrub(0);
  graph.changeChart(original.id);
  assert.equal(explorer.state.opened, false, 'explicit selection closes a preview even for the same saved card');
  assert.equal(explorer.current, null);
  assert.equal(explorer.state.current, session.original);
  assert.equal(viewport.transform, 'translate(-70,25) scale(1.4)');
  assert.deepEqual(writes, []);
});

test('birth reference tooltip describes the saved chart time', async () => {
  const h = uiHarness(async () => natalDayFixture());
  h.explorer.select(personalChartFixture()); await h.explorer.open();
  assert.equal(h.marker.title, 'Сохраненное время карты');
});
