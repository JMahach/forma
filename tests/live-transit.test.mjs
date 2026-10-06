import test from 'node:test';
import assert from 'node:assert/strict';
import { attachLiveTransit as createLiveTransit } from '../src/views/live-transit.js';
import { createChartStore } from '../src/data/chart-store.js';
import { renderBodygraph } from '../src/scene/bodygraph-svg.js';
import { createGraphController } from '../src/scene/updates.js';
import { transitChartAt } from '../src/domain/transit-day.js';

const day = date => ({
  date, startUtc: `${date}T00:00:00Z`, samples: 1440, stepSeconds: 60,
  engine: 'Swiss Ephemeris', ephemeris: 'test', timezoneDatabase: 'test', nodeModel: 'true', zodiac: 'tropical-geocentric-apparent',
  columns: Array.from({ length: 24 }, (_, col) => Float64Array.from({ length: 1440 }, (_, minute) => col < 22
    ? (col * 30 + minute / 10000) % 360 : col === 22 ? Date.parse(`${date}T00:00:00Z`) / 1000 - 88 * 86400 + minute * 61 : minute % 100 * 1e-12)),
});
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function harness({ getDay = async date => day(date), zone = 'UTC', utc = '2026-09-24T12:00:20Z' } = {}) {
  const listeners = new Map(), attributes = new Map(), requests = [], events = [], states = [], messages = [];
  let timestamp = Date.parse(utc), formOpen = false, previous = null;
  const document = { hidden: false, addEventListener: (name, listener) => listeners.set(name, listener) };
  const button = { title: '', setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name) };
  const live = createLiveTransit({
    document, button, now: () => timestamp, timeZone: () => zone,
    isFormOpen: () => formOpen,
    dayClient: { getDay(date) { requests.push(date); return getDay(date); } },
    onRender: () => { events.push(['render', live.current, previous]); previous = live.current; },
    onStateChange: state => states.push(state),
    toast: message => messages.push(message),
  });
  return {
    live, document, button, requests, events, states, messages, listeners, attributes,
    set utc(value) { timestamp = typeof value === 'number' ? value : Date.parse(value); },
    get utc() { return timestamp; }, set formOpen(value) { formOpen = value; },
    set zone(value) { zone = value; },
  };
}

test('live view loads a local day once and redraws exact coordinate changes from cached minutes', async () => {
  const h = harness();
  await h.live.refresh(true);
  assert.deepEqual(h.requests, ['2026-09-24']);
  assert.equal(h.live.current.utc, '2026-09-24T12:00:00Z');
  assert.equal(h.live.current.activations.personality.length, 13);
  assert.equal(h.live.current.activations.design.length, 13);
  assert.equal(Date.parse(h.live.current.designUtc) / 1000, day('2026-09-24').columns[22][720]);
  assert.equal(h.live.current.designArcResidualDegrees, day('2026-09-24').columns[23][720]);
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
  assert.deepEqual(h.events.map(event => event[0]), ['render'], 'mandala rays still receive exact minute positions');
  assert.equal(h.events[0][1], h.live.current); assert.equal(h.events[0][2], initial);
});

test('repeated publication keeps state notifications without reading the same minute again', async () => {
  let columnReads = 0;
  const h = harness({ zone: 'Asia/Kathmandu', getDay: async date => {
    const packet = day(date);
    packet.columns = packet.columns.map(column => new Proxy(column, { get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) columnReads++;
      return Reflect.get(target, key, target);
    } }));
    return packet;
  } });
  await h.live.refresh(true);
  assert.equal(h.requests.length, 2);
  assert.equal(columnReads, 24, 'both packet completions and load completion materialize one complete two-sided chart');
  const first = h.live.current;
  assert.deepEqual(first, transitChartAt(day('2026-09-24'), 720));

  h.events.length = 0; h.states.length = 0;
  await h.live.refresh();
  assert.equal(columnReads, 24);
  assert.equal(h.live.current, first);
  assert.deepEqual(h.events, []);
  assert.equal(h.states.length, 1, 'a ready refresh publishes reference once, without repeating an identical loading state');

  h.states.length = 0;
  h.live.scrub(h.live.state.index);
  assert.equal(columnReads, 24);
  assert.equal(h.live.current, first);
  assert.equal(h.states.length, 1);
  assert.equal(h.states[0].live, false, 'selecting the current minute still pauses live mode');

  h.utc += 60_000;
  await h.live.goNow();
  assert.equal(columnReads, 48, 'the next minute is materialized exactly once');
  assert.deepEqual(h.live.current, transitChartAt(day('2026-09-24'), 721));
  assert.deepEqual(h.events.map(event => event[0]), ['render']);
  assert.equal(h.live.state.live, true);
});

test('scrubbing is entirely local, pauses live, and Now resumes without selecting a chart or moving a camera', async () => {
  const h = harness({ zone: 'Asia/Kathmandu' });
  await h.live.refresh(true);
  assert.deepEqual(h.requests, ['2026-09-24', '2026-09-23']);
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
  assert.ok(h.events.every(event => ['render'].includes(event[0])));
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
  assert.deepEqual(h.messages, [], 'a failed day never opens an error toast');
  await h.live.refresh();
  h.utc += 29_999;
  await h.live.refresh();
  assert.equal(h.requests.length, 2, 'failed automatic requests are not repeated each tick');
  h.utc += 1;
  await h.live.refresh();
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.messages, [], 'automatic retries stay quiet');
  fail = false;
  await h.live.goNow();
  assert.equal(h.live.current.utc, '2026-09-25T00:00:00Z');
  assert.deepEqual(h.messages, [], 'explicit recovery does not open a success toast');
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
  assert.deepEqual(h.events.map(event => event[0]), ['render']);
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
  const complete = transitChartAt(day('2026-09-23'), 720);
  // Older saved transit fallbacks contain only Personality. Live two-sided
  // charts remain ephemeral and never rewrite that legacy stored record.
  const fallback = { ...complete, design: [], designUtc: null, designArcResidualDegrees: null,
    activations: { ...complete.activations, design: [] } };
  const writes = [], stored = JSON.stringify([personal, fallback]);
  const store = createChartStore({ getStorage: () => ({ getItem: () => stored, setItem: (...args) => writes.push(args) }) });
  const originalCharts = store.charts, originalValues = JSON.stringify(store.charts);
  const viewport = { innerHTML: '', transform: 'translate(-50,30) scale(1.25)', querySelector: () => null };
  const popoverCharts = [];
  let live;
  const graph = createGraphController({
    scene: { update(chart, selection, options) { viewport.innerHTML = renderBodygraph(chart, selection, options); }, clear() { viewport.innerHTML = ''; } },
    getChart: () => live?.current || store.get('current-transit'), hasChart: () => true, viewport,
    getMandala: () => ({ enabled: true }),
    activationPopover: { close() {}, show() {}, refresh(chart) { popoverCharts.push(chart); } },
  });
  graph.render();
  assert.equal(popoverCharts.at(-1).utc, fallback.utc, 'the saved transit remains a usable loading/error fallback');
  live = createLiveTransit({
    document: { hidden: false, addEventListener() {} }, button: { setAttribute() {}, removeAttribute() {} },
    now: () => Date.parse('2026-09-24T12:00:00Z'), timeZone: () => 'UTC', dayClient: { getDay: async date => day(date) },
    onRender: graph.render, toast() {},
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

// A local day can span two UTC packets. Chart readiness and range readiness
// must remain independent, including late failures and midnight transitions.
test('current packet draws immediately, but scrubbing waits for every minute of the local day', async () => {
  const resolves = new Map();
  const h = harness({ zone: 'Asia/Kathmandu', getDay: date => new Promise(resolve => resolves.set(date, resolve)) });
  const loading = h.live.refresh(true);
  resolves.get('2026-09-24')(day('2026-09-24'));
  await settle();
  assert.equal(h.live.current.utc, '2026-09-24T12:00:00Z');
  assert.equal(h.live.state.status, 'loading');
  assert.equal(h.live.state.referenceIndex, null);
  const first = h.live.current;
  h.live.scrub(0);
  assert.equal(h.live.current, first, 'an incomplete slider range cannot be selected');
  h.utc += 60_000;
  const tick = h.live.refresh();
  assert.equal(h.live.current.utc, '2026-09-24T12:01:00Z');
  resolves.get('2026-09-23')(day('2026-09-23'));
  await Promise.all([loading, tick]);
  assert.equal(h.live.state.status, 'ready');
  assert.equal(h.events.filter(([type]) => type === 'render').length, 2, 'range completion does not redraw the same minute');
  h.live.scrub(0);
  assert.equal(h.live.current.utc, '2026-09-23T18:15:00Z');
});

test('a missing edge packet does not discard the current chart or block its minute clock during retry backoff', async () => {
  let fail = true;
  const h = harness({ zone: 'Asia/Kathmandu', getDay: async date => {
    if (date === '2026-09-23' && fail) throw new Error('Missing edge');
    return day(date);
  } });
  await h.live.refresh(true);
  assert.equal(h.live.current.utc, '2026-09-24T12:00:00Z');
  assert.equal(h.live.state.status, 'error');
  h.utc = '2026-09-24T12:01:00Z';
  await h.live.refresh();
  assert.equal(h.live.current.utc, '2026-09-24T12:01:00Z');
  assert.equal(h.requests.filter(date => date === '2026-09-24').length, 1, 'successful packet retained on retry');
  h.utc += 10_000;
  await h.live.refresh();
  assert.equal(h.requests.length, 3);
  fail = false;
  await h.live.goNow();
  assert.equal(h.live.state.status, 'ready');
  assert.equal(h.requests.filter(date => date === '2026-09-24').length, 1);
});

test('late packets cannot publish a clamped last minute after the local day has ended', async () => {
  const resolves = new Map();
  const h = harness({ zone: 'Asia/Kathmandu', utc: '2026-09-24T18:14:00Z', getDay: date => new Promise(resolve => resolves.set(date, resolve)) });
  const loading = h.live.refresh(true);
  h.utc = '2026-09-24T18:15:00Z';
  resolves.get('2026-09-24')(day('2026-09-24'));
  resolves.get('2026-09-23')(day('2026-09-23'));
  await loading;
  assert.equal(h.live.current, null);
  assert.deepEqual(h.events, []);
});

test('minute scheduling continues while the rest of a local day is loading', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const resolves = new Map();
  const h = harness({ zone: 'Asia/Kathmandu', getDay: date => new Promise(resolve => resolves.set(date, resolve)) });
  const loading = h.live.start();
  t.after(() => h.live.stop());
  resolves.get('2026-09-24')(day('2026-09-24'));
  await settle();
  for (const advance of [40_025, 60_000]) {
    h.utc += advance;
    t.mock.timers.tick(advance);
    await settle();
  }
  assert.equal(h.live.current.utc, '2026-09-24T12:02:00Z');
  assert.equal(h.requests.length, 2, 'overlapping clock refreshes share one load');
  resolves.get('2026-09-23')(day('2026-09-23'));
  await loading;
});


test('partial packets remain cached while a personal chart, hidden page or birth form owns the view', async () => {
  for (const mode of ['personal', 'hidden', 'form']) {
    const resolves = new Map();
    const h = harness({ zone: 'Asia/Kathmandu', getDay: date => new Promise(resolve => resolves.set(date, resolve)) });
    const loading = h.live.refresh(true);
    if (mode === 'personal') h.live.setWanted(false);
    else if (mode === 'hidden') h.document.hidden = true;
    else h.formOpen = true;
    resolves.get('2026-09-24')(day('2026-09-24'));
    await settle();
    assert.equal(h.live.current, null, `${mode} prevents early current-packet publication`);
    assert.deepEqual(h.events, []);
    h.utc += 60_000;
    if (mode === 'personal') h.live.setWanted(true);
    else if (mode === 'hidden') { h.document.hidden = false; h.listeners.get('visibilitychange')(); }
    else { h.formOpen = false; h.live.refresh(); }
    await settle();
    assert.equal(h.live.current.utc, '2026-09-24T12:01:00Z');
    assert.equal(h.live.state.status, 'loading');
    resolves.get('2026-09-23')(day('2026-09-23'));
    await loading;
    assert.equal(h.live.state.status, 'ready');
    assert.equal(h.requests.length, 2, 'resuming reuses both active requests');
    assert.equal(h.events.filter(([type]) => type === 'render').length, 1);
  }
});

test('changing timezone supersedes a partial local day without accepting old completion or error', async () => {
  const pending = [];
  const h = harness({ zone: 'Asia/Kathmandu', getDay: date => new Promise((resolve, reject) => pending.push({ date, resolve, reject })) });
  const oldLoad = h.live.refresh(true);
  pending[0].resolve(day(pending[0].date));
  await settle();
  assert.equal(h.live.current.utc, '2026-09-24T12:00:00Z');
  h.zone = 'America/New_York';
  const currentLoad = h.live.refresh();
  assert.equal(h.live.state.timeline.timeZone, 'America/New_York');
  assert.deepEqual(pending.map(request => request.date), ['2026-09-24', '2026-09-23', '2026-09-24', '2026-09-25']);
  pending[2].resolve(day('2026-09-24'));
  pending[3].resolve(day('2026-09-25'));
  await currentLoad;
  pending[1].reject(new Error('Obsolete timezone edge failed'));
  await oldLoad;
  assert.equal(h.live.state.status, 'ready');
  assert.equal(h.live.state.timeline.timeZone, 'America/New_York');
  assert.equal(h.live.state.referenceIndex, 480);
  assert.deepEqual(h.messages, []);
  h.live.scrub(0);
  assert.equal(h.live.current.utc, '2026-09-24T04:00:00Z');
});

test('a partial range can cross UTC midnight without clamping to the previous packet', async () => {
  const resolves = new Map();
  const h = harness({ zone: 'America/New_York', utc: '2026-09-24T23:59:20Z', getDay: date => new Promise(resolve => resolves.set(date, resolve)) });
  const loading = h.live.refresh(true);
  resolves.get('2026-09-24')(day('2026-09-24'));
  await settle();
  assert.equal(h.live.current.utc, '2026-09-24T23:59:00Z');
  h.utc = '2026-09-25T00:00:25Z';
  const ticking = h.live.refresh();
  assert.equal(h.live.current.utc, '2026-09-24T23:59:00Z', 'pending new UTC packet retains the known exact minute');
  resolves.get('2026-09-25')(day('2026-09-25'));
  await Promise.all([loading, ticking]);
  assert.equal(h.live.state.timeline.date, '2026-09-24', 'UTC midnight does not advance the local date');
  assert.equal(h.live.state.live, true);
  assert.equal(h.live.current.utc, '2026-09-25T00:00:00Z');
  assert.deepEqual(h.events.filter(([type]) => type === 'render').map(([, chart]) => chart.utc), [
    '2026-09-24T23:59:00Z', '2026-09-25T00:00:00Z',
  ]);
});

test('partial live days keep their exact minute through both DST clock transitions', async () => {
  for (const [before, after, minutes] of [
    ['2026-03-08T06:59:20Z', '2026-03-08T07:00:00Z', 1380],
    ['2026-11-01T05:59:20Z', '2026-11-01T06:00:00Z', 1500],
  ]) {
    const resolves = new Map();
    const h = harness({ zone: 'America/New_York', utc: before, getDay: date => new Promise(resolve => resolves.set(date, resolve)) });
    const loading = h.live.refresh(true);
    const currentDate = before.slice(0, 10);
    resolves.get(currentDate)(day(currentDate));
    await settle();
    const beforeIndex = h.live.state.index;
    h.utc = after;
    const tick = h.live.refresh();
    assert.equal(h.live.current.utc, after);
    assert.equal(h.live.state.index, beforeIndex + 1, 'elapsed UTC minutes remain monotonic across skipped/repeated wall-clock hours');
    assert.equal(h.live.state.timeline.minutes, minutes);
    for (const [date, resolve] of resolves) if (date !== currentDate) resolve(day(date));
    await Promise.all([loading, tick]);
    assert.equal(h.live.state.status, 'ready');
    assert.equal(h.live.state.referenceIndex, beforeIndex + 1);
  }
});

test('after range completion every distinct slider minute still publishes synchronously', async () => {
  const h = harness({ zone: 'America/New_York' });
  await h.live.refresh(true);
  h.events.length = 0;
  const timeline = h.live.state.timeline;
  const indices = [0, 1, 500, 501, 500, 1200, 1439, 1438, 0];
  for (const index of indices) {
    h.live.scrub(index);
    assert.equal(Date.parse(h.live.current.utc), timeline.startUtc + index * 60_000);
    assert.equal(h.live.state.index, index);
    assert.equal(h.live.state.live, false);
  }
  assert.equal(h.events.filter(([type]) => type === 'render').length, indices.length);
  assert.equal(h.requests.length, 2);
});

test('a completed load from an expired date or timezone cannot enable a stale slider', async () => {
  for (const change of ['midnight', 'timezone']) {
    const resolves = new Map();
    const h = harness({ zone: 'Asia/Kathmandu', utc: '2026-09-24T18:14:20Z', getDay: date => new Promise(resolve => resolves.set(date, resolve)) });
    const loading = h.live.refresh(true);
    if (change === 'midnight') h.utc = '2026-09-24T18:15:00Z';
    else h.zone = 'UTC';
    for (const [date, resolve] of resolves) resolve(day(date));
    await loading;
    assert.equal(h.live.current, null);
    assert.deepEqual(h.events, []);
    assert.equal(h.live.state.status, 'idle', `${change} leaves the obsolete range unavailable until its replacement loads`);
    assert.equal(h.live.state.referenceIndex, null);
    h.live.scrub(0);
    assert.equal(h.live.state.live, true, 'a disabled stale range cannot pause current transit');
  }
});

test('a failed current packet retries without rerequesting the successful local-day edge', async () => {
  let unavailable = true;
  const h = harness({ zone: 'Asia/Kathmandu', getDay: async date => {
    if (date === '2026-09-24' && unavailable) throw new Error('Current packet unavailable');
    return day(date);
  } });
  await h.live.refresh(true);
  assert.equal(h.live.current, null, 'an earlier edge is not substituted for the actual current minute');
  assert.equal(h.live.state.status, 'error');
  h.utc += 29_999;
  await h.live.refresh();
  assert.equal(h.requests.length, 2);
  unavailable = false;
  h.utc += 1;
  await h.live.refresh();
  assert.equal(h.live.current.utc, '2026-09-24T12:00:00Z');
  assert.equal(h.live.state.status, 'ready');
  assert.equal(h.requests.filter(date => date === '2026-09-23').length, 1);
  assert.equal(h.requests.filter(date => date === '2026-09-24').length, 2);
  assert.deepEqual(h.messages, [], 'partial failures and successful retries do not open toasts');
});


test('initial selection does not race a paused startup target, and retry preserves it', async t => {
  let fail = true;
  const h = harness({ getDay: async date => { if (fail) throw new Error('Offline'); return day(date); } });
  t.after(() => h.live.stop());
  h.live.setWanted(true);
  assert.deepEqual(h.requests, []);
  await h.live.start({ live: false, date: '2026-09-24', timeZone: 'UTC', index: 12 });
  assert.equal(h.live.state.live, false);
  assert.equal(h.live.state.index, 12);
  fail = false; await h.live.retry();
  assert.equal(h.live.current.utc, '2026-09-24T00:12:00Z');
  assert.equal(h.live.state.live, false);
  await h.live.goNow();
  assert.equal(h.live.current.utc, '2026-09-24T12:00:00Z');
  assert.equal(h.live.state.live, true);
});

test('an expired paused startup target follows the current local day', async t => {
  const h = harness(); t.after(() => h.live.stop());
  await h.live.start({ live: false, date: '2026-09-23', timeZone: 'UTC', index: 0 });
  assert.equal(h.live.current.utc, '2026-09-24T12:00:00Z');
  assert.equal(h.live.state.live, true);
});
