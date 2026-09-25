import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartDayExplorer, attachChartDayExplorer, canExploreChartDay } from '../src/charts/chart-day-explorer.js';
import { createChartStore } from '../src/charts/chart-store.js';
import { createGraphController } from '../src/bodygraph/graph-controller.js';
import { chartAtMinute } from '../src/transit/chart-day-packet.js';
import { attachBirthForm } from '../src/charts/birth-form.js';
import { chartDayFixture, personalChartFixture } from './fixtures/chart-day.mjs';

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function harness(getDay = async () => chartDayFixture()) {
  const requests = [], states = [], renders = [];
  const explorer = createChartDayExplorer({
    dayClient: { getDay: (chart, options) => { requests.push({ chart, options }); return getDay(chart, options); } },
    onStateChange: state => states.push(state), onRender: () => renders.push(explorer.current),
  });
  return { explorer, requests, states, renders };
}

test('only calculated personal charts opt into a day and selecting one never starts a calculation', async () => {
  const h = harness(), chart = personalChartFixture();
  for (const candidate of [null, { ...chart, source: 'manual' }, { ...chart, source: 'transit' }, { ...chart, cityId: '' }, { ...chart, utc: '' }]) {
    assert.equal(canExploreChartDay(candidate), false);
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
  assert.notEqual(h.explorer.current.activations.design[0].longitude, previous.activations.design[0].longitude);
  assert.equal(h.explorer.current.id, chart.id);
  assert.equal(h.requests.length, 1);
  h.explorer.reset();
  assert.equal(h.explorer.current, chart);
  assert.equal(h.explorer.state.index, 754);
  h.explorer.scrub(0); h.explorer.close();
  assert.equal(h.explorer.current, null);
  assert.equal(h.renders.at(-1), null, 'closed view resolves to saved chart at composition root');
  assert.equal(h.explorer.state.current, chart);
  await h.explorer.open();
  assert.equal(h.explorer.current, chart);
  assert.equal(h.requests.length, 1, 'reopening reuses its already loaded day');
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
    complete(chartDayFixture()); await pending;
    assert.equal(h.explorer.state.opened, false);
    assert.equal(h.explorer.state.original, change === 'select' ? next : chart);
    assert.equal(h.explorer.state.day, null);
    assert.equal(h.explorer.current, null);
    assert.deepEqual(h.renders, []);
  }
});

test('day failures retain the saved chart and explicit retry recovers without navigation', async () => {
  let fail = true;
  const h = harness(async () => { if (fail) throw new Error('Нет соединения'); return chartDayFixture(); });
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
  return { hidden: false, disabled: false, dataset: {}, value: '', textContent: '', title: '', dateTime: '',
    setAttribute: (key, value) => attributes.set(key, String(value)), getAttribute: key => attributes.get(key),
    addEventListener: (type, listener) => listeners.set(type, listener), dispatch(type) { return listeners.get(type)?.(); },
  };
}
function uiHarness(getDay) {
  const elements = Object.fromEntries(['toggle', 'panel', 'range', 'date', 'time', 'status', 'resetButton'].map(key => [key, element()]));
  const explorer = attachChartDayExplorer({ ...elements, dayClient: { getDay } });
  return { ...elements, explorer };
}

test('controls distinguish repeated local minutes by offset and select the original fold using its UTC instant', async () => {
  const day = chartDayFixture({ date: '2026-11-01', timezone: 'America/New_York', samples: 1500, segments: [
    { index: 0, startUtc: '2026-11-01T04:00:00Z', utcOffset: 'UTC−04:00', offsetSeconds: -14400, fold: 0 },
    { index: 120, startUtc: '2026-11-01T06:00:00Z', utcOffset: 'UTC−05:00', offsetSeconds: -18000, fold: 1 },
    { index: 180, startUtc: '2026-11-01T07:00:00Z', utcOffset: 'UTC−05:00', offsetSeconds: -18000, fold: 0 },
  ] });
  const h = uiHarness(async () => day);
  const chart = personalChartFixture({ birthDate: day.date, timezone: day.timezone, birthTime: '01:30:45', utc: '2026-11-01T06:30:45Z', utcOffset: 'UTC−05:00', fold: 1 });
  h.explorer.select(chart); await h.explorer.open();
  assert.equal(h.range.max, '1499');
  assert.equal(h.range.value, '150');
  assert.equal(h.time.textContent, '01:30:45 · UTC−05:00');
  assert.equal(h.time.getAttribute('aria-label'), '01:30:45, UTC−05:00, America/New_York');
  assert.match(h.time.title, /America\/New_York/);
  assert.equal(h.time.dateTime, chart.utc);
  assert.equal(h.date.textContent, '01.11.2026');
  h.range.value = '90'; h.range.dispatch('input');
  assert.equal(h.time.textContent, '01:30 · UTC−04:00');
  assert.equal(h.explorer.current.fold, 0);
  h.range.value = '150'; h.range.dispatch('input');
  assert.equal(h.time.textContent, '01:30 · UTC−05:00');
  assert.equal(h.explorer.current.fold, 1);
  assert.match(h.range.getAttribute('aria-valuetext'), /UTC−05:00, America\/New_York/);
  h.resetButton.dispatch('click');
  assert.equal(h.explorer.current, chart);
  assert.equal(h.time.textContent, '01:30:45 · UTC−05:00');
  assert.equal(h.resetButton.textContent, 'Исходное');
  assert.equal(h.resetButton.title, 'Вернуться к сохранённому времени рождения');
});

test('opening the birth editor closes a minute preview before the dialog appears and edits the saved birth time', async () => {
  const h = harness(), original = personalChartFixture();
  h.explorer.select(original); await h.explorer.open(); h.explorer.scrub(0);
  assert.notEqual(h.explorer.current, original);
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      ...element(), value: '', classList: { remove() {}, add() {}, toggle() {} },
      removeAttribute() {}, reset() {}, close() {}, querySelector: () => node('formExtras'), querySelectorAll: () => [],
      showModal() {
        assert.equal(h.explorer.state.opened, false);
        assert.equal(h.explorer.current, null);
        assert.equal(h.explorer.state.current, original, 'restored before the editor becomes visible');
      },
    });
    return nodes.get(id);
  }
  node('chartForm').elements = Object.fromEntries(['name', 'birthPlace', 'note'].map(key => [key, node(key)]));
  const form = attachBirthForm({
    document: { getElementById: node, querySelectorAll: () => [] },
    store: { charts: [original], selectedId: original.id, current: original },
    onSave() {}, toast() {}, beforeOpen: h.explorer.close,
  });
  form.open(true, original.id);
  assert.equal(node('birthTime').value, '12:34', 'the edit form uses saved time, never the scrubbed 00:00');
  assert.equal(h.renders.at(-1), null, 'the graph returns to its saved-chart source');
});

test('controls expose loading, error and retry without enabling unavailable minutes', async () => {
  let fail = true;
  const h = uiHarness(async () => { if (fail) throw new Error('Расчёт недоступен'); return chartDayFixture(); });
  assert.equal(h.toggle.hidden, true);
  h.explorer.select(personalChartFixture());
  assert.equal(h.toggle.hidden, false);
  const pending = h.explorer.open();
  assert.equal(h.panel.hidden, false);
  assert.equal(h.panel.getAttribute('aria-busy'), 'true');
  assert.equal(h.range.disabled, true);
  assert.equal(h.status.textContent, 'Рассчитываем день…');
  await pending;
  assert.equal(h.status.textContent, 'Расчёт недоступен');
  assert.equal(h.resetButton.textContent, 'Повторить');
  assert.equal(h.resetButton.disabled, false);
  fail = false; await h.resetButton.dispatch('click');
  assert.equal(h.range.disabled, false);
  assert.equal(h.status.textContent, '');
  h.toggle.dispatch('click');
  assert.equal(h.panel.hidden, true);
  assert.equal(h.toggle.getAttribute('aria-expanded'), 'false');
});

test('personal scrubbing keeps real graph pins, camera transform and saved storage intact', async () => {
  const original = chartAtMinute(chartDayFixture(), 754, personalChartFixture()), writes = [], values = JSON.stringify([original]);
  const store = createChartStore({ getStorage: () => ({ getItem: () => values, setItem: (...args) => writes.push(args) }) });
  store.select(original.id);
  const before = JSON.stringify(store.charts), charts = store.charts;
  const viewport = { innerHTML: '', transform: 'translate(-70,25) scale(1.4)', querySelector: () => null };
  let explorer;
  const graph = createGraphController({
    getChart: () => explorer?.current || store.current, viewport, alignHeading() {},
    getMandala: () => ({ enabled: true }), activationPopover: { close() {}, show() {}, refresh() {} },
    onChartChange(id) { explorer.close(); store.select(id); explorer.select(store.current); graph.render(); },
  });
  explorer = createChartDayExplorer({ dayClient: { getDay: async () => chartDayFixture() }, onRender: graph.render });
  explorer.select(store.current); await explorer.open();
  graph.choose({ type: 'gate', id: 41 });
  graph.choose({ type: 'mandala-cross', cross: { longitude: 0, source: 'personality' }, additive: true });
  const pins = graph.selectionState.items, crosses = graph.selectionState.crosses, markup = viewport.innerHTML;
  for (const minute of [0, 100, 1200, 1439]) explorer.scrub(minute);
  assert.ok(viewport.innerHTML !== markup, 'minute positions update the rendered graph');
  assert.equal(graph.selectionState.items, pins);
  assert.equal(graph.selectionState.crosses, crosses);
  assert.equal(viewport.transform, 'translate(-70,25) scale(1.4)');
  explorer.reset();
  assert.equal(explorer.current, store.current);
  assert.equal(store.charts, charts);
  assert.equal(JSON.stringify(store.charts), before);
  assert.deepEqual(writes, []);
  explorer.scrub(0);
  graph.changeChart(original.id);
  assert.equal(explorer.state.opened, false, 'explicit selection closes a preview even for the same saved card');
  assert.equal(explorer.current, null);
  assert.equal(explorer.state.current, store.current);
  assert.equal(viewport.transform, 'translate(-70,25) scale(1.4)');
  assert.deepEqual(writes, []);
});
