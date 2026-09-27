import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveTransit } from '../src/charts/live-transit.js';
import { createChartStore } from '../src/charts/chart-store.js';
import { createGraphController } from '../src/bodygraph/graph-controller.js';
import { transitChartAt } from '../src/transit/day-packet.js';

const day = date => ({
  date, startUtc: `${date}T00:00:00Z`, samples: 1440, stepSeconds: 60,
  engine: 'Swiss Ephemeris', ephemeris: 'test', timezoneDatabase: 'test', nodeModel: 'true', zodiac: 'tropical-geocentric-apparent',
  columns: Array.from({ length: 11 }, (_, col) => Float64Array.from({ length: 1440 }, (_, minute) => col * 30 + minute / 10000)),
});
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function harness({ getDay = async date => day(date), zone = 'UTC', utc = '2026-09-24T12:00:20Z' } = {}) {
  const listeners = new Map(), attributes = new Map(), requests = [], events = [], states = [], messages = [];
  let timestamp = Date.parse(utc), formOpen = false;
  const document = { hidden: false, addEventListener: (name, listener) => listeners.set(name, listener) };
  const button = { title: '', setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name) };
  const live = createLiveTransit({
    document, button, now: () => timestamp, timeZone: () => zone,
    isFormOpen: () => formOpen,
    dayClient: { getDay(date) { requests.push(date); return getDay(date); } },
    onMoment: (chart, previous) => events.push(['moment', chart, previous]),
    onRender: () => events.push(['render']), onStateChange: state => states.push(state),
    toast: message => messages.push(message),
  });
  return {
    live, document, button, requests, events, states, messages, listeners, attributes,
    set utc(value) { timestamp = typeof value === 'number' ? value : Date.parse(value); },
    get utc() { return timestamp; }, set formOpen(value) { formOpen = value; },
  };
}

test('live view loads a local day once and redraws exact coordinate changes from cached minutes', async () => {
  const h = harness();
  await h.live.refresh(true);
  assert.deepEqual(h.requests, ['2026-09-24']);
  assert.equal(h.live.current.utc, '2026-09-24T12:00:00Z');
  assert.equal(h.live.current.activations.personality.length, 13);
  const initial = h.live.current;
  h.events.length = 0;
  h.utc += 20_000;
  await h.live.refresh();
  assert.deepEqual(h.events, [], 'seconds within one sample require no redraw or request');
  h.utc += 20_000;
  await h.live.refresh();
  assert.deepEqual(h.requests, ['2026-09-24']);
  assert.equal(h.live.current.utc, '2026-09-24T12:01:00Z');
  assert.deepEqual(h.live.current.personality, initial.personality, 'small coordinate movement can leave gates unchanged');
  assert.notEqual(h.live.current.activations.personality[0].longitude, initial.activations.personality[0].longitude);
  assert.deepEqual(h.events.map(event => event[0]), ['moment', 'render'], 'mandala rays still receive exact minute positions');
});

test('scrubbing is entirely local, pauses live, and Now resumes without selecting a chart or moving a camera', async () => {
  const h = harness({ zone: 'Asia/Kathmandu' });
  await h.live.refresh(true);
  assert.deepEqual(h.requests, ['2026-09-23', '2026-09-24']);
  h.live.scrub(0);
  const reference = h.live.state.referenceIndex;
  assert.equal(h.live.state.live, false);
  assert.equal(h.live.current.utc, '2026-09-23T18:15:00Z');
  h.utc += 5 * 60_000;
  await h.live.refresh();
  assert.equal(h.live.current.utc, '2026-09-23T18:15:00Z');
  assert.equal(h.live.state.referenceIndex, reference + 5, 'the real clock advances independently of the scrubbed minute');
  assert.equal(h.live.state.index, 0);
  for (const index of [500, 800, 1100, 1439, 0]) h.live.scrub(index);
  assert.equal(h.requests.length, 2, 'every slider position reuses the same two packets');
  assert.ok(h.events.every(event => ['moment', 'render'].includes(event[0])));
  await h.live.goNow();
  assert.equal(h.live.state.live, true);
  assert.equal(h.live.current.utc, '2026-09-24T12:05:00Z');
  assert.equal(h.requests.length, 2);
});

test('an in-flight load may cache data but cannot switch away from a personal chart or publish a transit', async () => {
  let resolve;
  const h = harness({ getDay: () => new Promise(done => { resolve = done; }) });
  const pending = h.live.refresh(true);
  const duplicate = h.live.refresh(true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.attributes.get('aria-busy'), 'true');
  h.live.setWanted(false);
  resolve(day('2026-09-24'));
  await Promise.all([pending, duplicate]);
  assert.equal(h.live.current, null);
  assert.equal(h.live.state.wanted, false);
  assert.deepEqual(h.events, []);
  assert.equal(h.attributes.has('aria-busy'), false);
  h.live.setWanted(true);
  await settle();
  assert.equal(h.live.current.utc, '2026-09-24T12:00:00Z');
  assert.equal(h.requests.length, 1, 'returning to the transit uses the finished packet');
});

test('hidden pages, birth forms and personal-chart mode do not start day requests', async () => {
  const h = harness();
  h.document.hidden = true;
  await h.live.refresh(true);
  h.document.hidden = false;
  h.formOpen = true;
  await h.live.refresh(true);
  h.formOpen = false;
  h.live.setWanted(false);
  await h.live.refresh(true);
  assert.deepEqual(h.requests, []);
  h.live.setWanted(true);
  await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.live.current.utc, '2026-09-24T12:00:00Z');
});

test('day errors retain the prior chart, back off automatic retries and allow explicit recovery', async () => {
  let fail = false;
  const h = harness({ getDay: async date => { if (fail) throw new Error('Day unavailable'); return day(date); } });
  await h.live.refresh(true);
  const previous = h.live.current;
  h.utc = '2026-09-25T00:00:00Z';
  fail = true;
  await h.live.refresh();
  assert.equal(h.live.current, previous);
  assert.equal(h.live.state.status, 'error');
  assert.equal(h.live.state.referenceIndex, null);
  assert.deepEqual(h.messages, ['Day unavailable']);
  await h.live.refresh();
  h.utc += 29_999;
  await h.live.refresh();
  assert.equal(h.requests.length, 2, 'failed automatic requests are not repeated each tick');
  h.utc += 1;
  await h.live.refresh();
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.messages, ['Day unavailable'], 'unchanged failures stay quiet');
  fail = false;
  await h.live.goNow();
  assert.equal(h.live.current.utc, '2026-09-25T00:00:00Z');
  assert.deepEqual(h.messages, ['Day unavailable', 'Транзит дня загружен']);
  assert.equal(h.live.state.status, 'ready');
});

test('a new local day replaces the paused timeline with today and preserves a single ephemeral chart', async () => {
  const h = harness({ zone: 'Asia/Kathmandu', utc: '2026-09-24T18:14:00Z' });
  await h.live.refresh(true);
  h.live.scrub(0);
  h.utc = '2026-09-24T18:15:00Z';
  await h.live.refresh();
  assert.equal(h.live.state.timeline.date, '2026-09-25');
  assert.equal(h.live.state.index, 0);
  assert.equal(h.live.state.live, true);
  assert.equal(h.live.current.utc, '2026-09-24T18:15:00Z');
  assert.equal(h.live.current.id, 'current-transit');
});

test('late previous-day loads cannot replace the current local day', async () => {
  const resolvers = new Map();
  const h = harness({ getDay: date => new Promise(resolve => { resolvers.set(date, resolve); }) });
  const first = h.live.refresh(true);
  assert.equal(h.live.state.referenceIndex, null, 'a loading day has no reference marker');
  h.utc = '2026-09-25T00:00:00Z';
  const second = h.live.refresh();
  resolvers.get('2026-09-25')(day('2026-09-25'));
  await second;
  resolvers.get('2026-09-24')(day('2026-09-24'));
  await first;
  assert.equal(h.live.current.utc, '2026-09-25T00:00:00Z');
  assert.equal(h.live.state.timeline.date, '2026-09-25');
  assert.equal(h.live.state.referenceIndex, 0, 'late data cannot restore yesterday’s marker');
});

test('the existing minute schedule advances the reference while paused without a redraw or extra request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ utc: '2026-09-24T12:00:20Z' });
  assert.equal(h.live.state.referenceIndex, null);
  await h.live.start();
  t.after(() => h.live.stop());
  h.live.scrub(100);
  const selected = h.live.current;
  h.events.length = 0; h.states.length = 0;
  assert.equal(h.live.state.referenceIndex, 720);
  h.utc += 40_025;
  t.mock.timers.tick(40_025);
  await settle();
  assert.equal(h.live.current, selected);
  assert.equal(h.live.state.index, 100);
  assert.equal(h.states.at(-1).referenceIndex, 721);
  assert.equal(h.states.at(-1).live, false);
  assert.deepEqual(h.events, [], 'a reference marker does not redraw the bodygraph');
  assert.equal(h.requests.length, 1, 'the existing cached day and minute timer suffice');
});

test('reference uses the actual short or long local day and disappears when that loaded day becomes stale', async () => {
  for (const [utc, minutes] of [['2026-03-08T05:00:00Z', 1380], ['2026-11-01T04:00:00Z', 1500]]) {
    const h = harness({ utc, zone: 'America/New_York' });
    await h.live.refresh(true);
    const loaded = h.live.state.timeline;
    assert.equal(loaded.minutes, minutes);
    assert.equal(h.live.state.referenceIndex, 0);
    h.live.scrub(100);
    const selected = h.live.current, requestCount = h.requests.length;
    h.utc = loaded.endUtc - 1;
    await h.live.refresh();
    assert.equal(h.live.state.referenceIndex, minutes - 1);
    assert.equal(h.live.current, selected);
    h.utc = loaded.endUtc;
    assert.equal(h.live.state.referenceIndex, null, 'state never clamps the next day’s now to yesterday’s final tick');
    assert.equal(h.requests.length, requestCount, 'reading reference state cannot initiate a day load');
  }
});

test('the running clock waits for the next minute boundary and uses no per-second network polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ utc: '2026-09-24T12:00:20Z' });
  await h.live.start();
  t.after(() => h.live.stop());
  h.events.length = 0;
  h.utc += 39_000;
  t.mock.timers.tick(39_000);
  await settle();
  assert.deepEqual(h.events, []);
  h.utc += 1025;
  t.mock.timers.tick(1025);
  await settle();
  assert.equal(h.live.current.utc, '2026-09-24T12:01:00Z');
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.events.map(event => event[0]), ['moment', 'render']);
  h.document.hidden = true;
  h.listeners.get('visibilitychange')();
  h.utc += 10 * 60_000;
  t.mock.timers.tick(10 * 60_000);
  await settle();
  assert.equal(h.live.current.utc, '2026-09-24T12:01:00Z');
  h.document.hidden = false;
  h.listeners.get('visibilitychange')();
  await settle();
  assert.equal(h.live.current.utc, '2026-09-24T12:11:00Z');
  assert.equal(h.requests.length, 1);
});

test('scrubbing through the real graph controller preserves pinned selection, camera transform and stored charts', async () => {
  const personal = { id: 'personal', name: 'Saved chart', source: 'manual', personality: [1], design: [8] };
  const fallback = transitChartAt(day('2026-09-23'), 720);
  const writes = [], stored = JSON.stringify([personal, fallback]);
  const store = createChartStore({ getStorage: () => ({ getItem: () => stored, setItem: (...args) => writes.push(args) }) });
  const originalCharts = store.charts, originalValues = JSON.stringify(store.charts);
  const viewport = { innerHTML: '', transform: 'translate(-50,30) scale(1.25)', querySelector: () => null };
  const popoverCharts = [];
  let live;
  const graph = createGraphController({
    getChart: () => live?.current || store.current, hasChart: () => true, viewport,
    getMandala: () => ({ enabled: true }), alignHeading() {},
    activationPopover: { close() {}, show() {}, refresh(chart) { popoverCharts.push(chart); } },
  });
  graph.render();
  assert.equal(popoverCharts.at(-1).utc, fallback.utc, 'the saved transit remains a usable loading/error fallback');
  live = createLiveTransit({
    document: { hidden: false, addEventListener() {} }, button: { setAttribute() {}, removeAttribute() {} },
    now: () => Date.parse('2026-09-24T12:00:00Z'), timeZone: () => 'UTC', dayClient: { getDay: async date => day(date) },
    onMoment() {}, onRender: graph.render, toast() {},
  });
  await live.refresh(true);
  graph.choose({ type: 'gate', id: 41 });
  graph.choose({ type: 'mandala-cross', cross: { longitude: 0, source: 'personality' }, additive: true });
  const items = graph.selectionState.items, crosses = graph.selectionState.crosses, markup = viewport.innerHTML;
  for (const minute of [0, 60, 1000, 1439]) live.scrub(minute);
  assert.equal(graph.selectionState.items, items);
  assert.equal(graph.selectionState.crosses, crosses);
  assert.equal(viewport.transform, 'translate(-50,30) scale(1.25)');
  assert.notEqual(viewport.innerHTML, markup, 'the exact sampled positions are rendered');
  assert.equal(popoverCharts.at(-1), live.current);
  assert.equal(store.charts, originalCharts);
  assert.equal(JSON.stringify(store.charts), originalValues);
  assert.deepEqual(writes, []);
});
