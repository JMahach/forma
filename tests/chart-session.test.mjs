import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartExploration } from '../src/state/chart-exploration.js';
import { createChartSession } from '../src/state/chart-session.js';
import { createTransitPlanetFilter } from '../src/state/transit-planets.js';
import { PLANET_IDS } from '../src/domain/planets.js';
import { createChartStore } from '../src/data/chart-store.js';
import { createNatalDayExplorer } from '../src/state/natal-day.js';
import { createReturnsController } from '../src/state/returns.js';
import { createLifetimeExplorer } from '../src/state/lifetime.js';
import { LIFETIME_PLANETS } from '../shared/lifetime-format.js';
import { createLiveTransit } from '../src/state/live-transit.js';
import { chartAtMinute } from '../src/domain/natal-day.js';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.mjs';

function harness(charts) {
  const writes = [], changes = [];
  charts = charts.map(chart => chartAtMinute(natalDayFixture(), 754, chart));
  const store = createChartStore({ getStorage: () => ({ getItem: () => JSON.stringify(charts), setItem: (...value) => writes.push(value) }) });
  let natal, transit;
  const session = createChartSession({ store, getNatalDay: () => natal, getTransit: () => transit,
    onChange: () => changes.push({ id: session.selectedId, chart: session.current }) });
  natal = createNatalDayExplorer({ dayClient: { getDay: async () => natalDayFixture() }, onRender: () => session.publish('natal-day', natal.current) });
  return { store, session, natal, changes, writes, set transit(value) { transit = value; } };
}


test('session is the only selected-ID owner and navigation emits only the final chart', async () => {
  const h = harness([personalChartFixture(), personalChartFixture({ id: 'second' })]);
  assert.equal('selectedId' in h.store, false); assert.equal('current' in h.store, false);
  const saved = h.store.charts, before = JSON.stringify(saved);
  h.session.select(saved[0].id); await h.natal.open(); h.natal.scrub(1);
  h.changes.length = 0;
  h.session.select('second');
  assert.equal(h.changes.length, 1);
  assert.equal(h.changes[0].chart.primary, saved[1]);
  assert.equal(h.natal.state.opened, false);
  assert.equal(h.session.original, saved[1]); assert.equal(h.session.current.primary, saved[1]);
  assert.equal(h.store.charts, saved); assert.equal(JSON.stringify(saved), before); assert.deepEqual(h.writes, []);
});

test('reselecting a saved chart closes its day preview in one update', async () => {
  const h = harness([personalChartFixture()]);
  h.session.select(h.store.charts[0].id); await h.natal.open(); h.natal.scrub(100);
  h.changes.length = 0; h.session.select(h.session.selectedId);
  assert.equal(h.changes.length, 1); assert.equal(h.changes[0].chart.primary, h.session.original);
});

test('lifetime is a temporary view and selecting a chart closes it without changing saved records', () => {
  const original = { id: 'saved', source: 'calculated', name: 'Saved' };
  const preview = { id: 'lifetime-preview', source: 'transit', utc: '1900-01-01T00:00:00Z' };
  let current = null, closes = 0;
  const lifetime = { get current() { return current; }, close() { current = null; closes++; session.refresh(); } };
  const changes = [];
  const store = { get: id => id === 'saved' ? original : null, has: id => id === 'saved' };
  const session = createChartSession({ store, getLifetime: () => lifetime, onChange: () => changes.push(session.current) });
  session.select('saved');
  current = preview; session.publish(session.expect('lifetime'), current);
  assert.equal(session.current.primary, original); assert.equal(session.current.secondary, preview); assert.equal(session.original, original);
  assert.equal(session.selectedId, 'saved'); assert.equal(session.hasCurrent, true);
  changes.length = 0;
  session.select('saved');
  assert.equal(current, null); assert.equal(closes, 2);
  assert.deepEqual(changes.map(chart => chart.primary), [original]);
});

test('every intermediate natal minute is published synchronously without waiting for release or a frame', async () => {
  const h = harness([personalChartFixture()]);
  h.session.select(h.store.charts[0].id); await h.natal.open(); h.changes.length = 0;
  const minutes = Array.from({ length: 100 }, (_, index) => index + 200);
  for (const minute of minutes) {
    const before = h.changes.length; h.natal.scrub(minute);
    assert.equal(h.changes.length, before + 1);
    assert.equal(Date.parse(h.changes.at(-1).chart.utc), Date.parse('2026-09-24T00:00:00Z') + minute * 60000);
  }
  assert.equal(h.changes.length, minutes.length); assert.deepEqual(h.writes, []);
});

test('every transit input publishes exact positions while late source updates never change navigation', async () => {
  const h = harness([personalChartFixture()]);
  const columns = Array.from({ length: 24 }, (_, column) => Float64Array.from({ length: 1440 }, (_, minute) => column < 22
    ? (column * 20 + minute / 10000) % 360 : column === 22 ? Date.parse('2026-09-24T00:00:00Z') / 1000 - 88 * 86400 + minute * 61 : minute % 100 * 1e-12));
  const transit = createLiveTransit({ now: () => Date.parse('2026-09-24T12:00:00Z'), timeZone: () => 'UTC',
    dayClient: { getDay: async date => ({ date, startUtc: `${date}T00:00:00Z`, samples: 1440, stepSeconds: 60, columns }) },
    onRender: () => h.session.publish('transit', transit.current) });
  h.transit = transit; await transit.refresh(true); h.changes.length = 0;
  for (const minute of [0, 1, 2, 3, 4, 5, 1438, 1439]) {
    const before = h.changes.length; transit.scrub(minute); assert.equal(h.changes.length, before + 1);
    assert.equal(h.changes.at(-1).chart.primary.activations.personality[0].longitude, columns[0][minute]);
  }
  h.session.select(h.store.charts[0].id); const count = h.changes.length;
  await transit.refresh(true); assert.equal(h.changes.length, count);
  assert.equal(h.session.current.primary, h.store.charts[0]); assert.deepEqual(h.writes, []);
});


test('return chart is a temporary view; switching or reselecting natal ends it in one update', () => {
  const natal = { id: 'natal', source: 'calculated' }, second = { id: 'second', source: 'calculated' };
  const charts = new Map([[natal.id, natal], [second.id, second]]), changes = [];
  let preview = null, selected = null;
  const returns = { get current() { return preview; }, exit() { preview = null; session.refresh(); }, select(chart) { selected = chart; } };
  const session = createChartSession({ store: { get: id => charts.get(id), has: id => charts.has(id) },
    getReturns: () => returns, onChange: () => changes.push(session.current) });
  session.select('natal'); preview = { id: 'temporary-return', utc: '2050-01-01T00:00:00Z' }; session.publish(session.expect('return'), preview, { id: preview.id, body: 'saturn', utc: preview.utc });
  assert.equal(session.current.secondary, preview); assert.equal(session.original, natal); assert.equal(session.selectedId, 'natal');
  changes.length = 0; session.select('second');
  assert.equal(preview, null); assert.equal(selected, second); assert.deepEqual(changes.map(chart => chart.primary), [second]);
  preview = { id: 'another-return' }; changes.length = 0; session.select('second');
  assert.equal(preview, null); assert.deepEqual(changes.map(chart => chart.primary), [second]);
});

function scaleHarness() {
  const h = harness([personalChartFixture()]);
  let cycle = null, scales;
  const calls = [];
  const returns = { get current() { return cycle; }, state: { available: false, opened: false },
    select(chart) { this.state.available = chart.id !== 'current-transit'; },
    exit() { cycle = null; this.state.opened = false; },
    reset() { cycle = null; }, enableMarkers() {},
    close() { this.state.opened = false; },
    async open() { calls.push('returns-open'); this.state.opened = true; return true; } };
  const natal = createNatalDayExplorer({ dayClient: { getDay: async () => natalDayFixture() },
    onRender: () => session.publish('natal-day', natal.current) });
  h.natal = natal;
  const lifetime = createLifetimeExplorer({ client: {
    getMeta: async () => ({ startUtc: '1801-01-01T00:00:00Z', endExclusiveUtc: '2400-01-01T00:00:00Z', stepSeconds: 600, samples: 31_504_320, planets: [...LIFETIME_PLANETS] }),
    getPoint: () => assert.fail('personal mode entry borrows exact birth, never a rounded lifetime point'),
  }, getMomentState: () => scales.momentState() });
  const open = lifetime.open, close = lifetime.close;
  lifetime.open = () => { calls.push('lifetime-open'); return open(); };
  lifetime.close = () => { calls.push('lifetime-close'); close(); };
  const session = createChartSession({ store: h.store, getNatalDay: () => h.natal,
    getLifetime: () => lifetime, getReturns: () => returns });
  scales = createChartExploration({ session, getNatalDay: () => h.natal, getTransit: () => null,
    getLifetime: () => lifetime, getReturns: () => returns, loadLifetime: async () => lifetime });
  return { ...h, session, returns, lifetime, scales, calls,
    set cycle(value) { cycle = value; session.publish(session.expect('return'), cycle, { id: cycle.id, body: 'saturn', utc: cycle.utc }); },
    set lifetimeMoment(value) { session.publish(session.expect('lifetime'), value); } };
}

test('normal personal navigation always shows the original chart with an active day strip', async () => {
  const h = scaleHarness();
  await h.scales.select(h.store.charts[0].id);
  assert.equal(h.natal.state.opened, true);
  assert.equal(h.natal.state.exactOriginal, true);
  assert.equal(h.session.current.primary, h.session.original);
  assert.equal(h.returns.state.opened, false);
  assert.equal(h.lifetime.state.opened, false);
});

test('card selection leaves each previous scale once, including reselecting a previewed card', async () => {
  const charts = [personalChartFixture(), personalChartFixture({ id: 'second' })].map(chart => chartAtMinute(natalDayFixture(), 754, chart));
  let counts = { exit: 0, close: 0, changes: 0 }, session;
  const natalDay = createNatalDayExplorer({ dayClient: { getDay: async () => natalDayFixture() }, onRender: () => session.publish('natal-day', natalDay.current) });
  const returns = createReturnsController({ onRender: () => session.publish('natal-day', natalDay.current) });
  const exit = returns.exit;
  returns.exit = () => { counts.exit++; exit(); };
  const lifetime = { state: { opened: false }, close() { counts.close++; } };
  session = createChartSession({ store: { get: id => charts.find(chart => chart.id === id), has: id => charts.some(chart => chart.id === id) },
    getNatalDay: () => natalDay, getLifetime: () => lifetime, getReturns: () => returns, onChange: () => counts.changes++ });
  const navigation = createChartExploration({ session, getNatalDay: () => natalDay, getLifetime: () => lifetime, getReturns: () => returns, getTransit: () => null });
  for (const id of [charts[0].id, charts[0].id, charts[1].id]) {
    counts = { exit: 0, close: 0, changes: 0 };
    await navigation.select(id);
    assert.deepEqual(counts, { exit: 1, close: 1, changes: 1 });
    assert.equal(session.current.primary, session.original); assert.equal(natalDay.state.exactOriginal, true);
    assert.equal(natalDay.state.opened, true);
    natalDay.scrub(100);
  }
});

test('card selection cancels a pending day load and its late completion cannot replace the selected day', async () => {
  const charts = [personalChartFixture(), personalChartFixture({ id: 'second' })];
  const requests = [], changes = [];
  let session;
  const natalDay = createNatalDayExplorer({ dayClient: { getDay(chart, { signal }) {
    return new Promise(resolve => requests.push({ chart, signal, resolve }));
  } }, onRender: () => session.publish('natal-day', natalDay.current) });
  session = createChartSession({ store: { get: id => charts.find(chart => chart.id === id), has: id => charts.some(chart => chart.id === id) },
    getNatalDay: () => natalDay, onChange: () => changes.push(session.current) });
  const navigation = createChartExploration({ session, getNatalDay: () => natalDay, getLifetime: () => null, getReturns: () => null, getTransit: () => null });
  const first = navigation.select(charts[0].id);
  const latest = navigation.select(charts[1].id);
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve(natalDayFixture()); assert.equal(await latest, true);
  natalDay.scrub(100);
  const selected = session.current, published = changes.length;
  requests[0].resolve(natalDayFixture()); assert.equal(await first, false);
  assert.equal(session.selectedId, charts[1].id); assert.equal(session.current, selected);
  assert.equal(natalDay.state.opened, true); assert.equal(natalDay.state.index, 100);
  assert.equal(changes.length, published, 'an obsolete day load cannot repaint the selected card');
});

test('opening Returns closes Day and opening Day restores natal without opening the return list', async () => {
  const h = scaleHarness(); await h.scales.select(h.store.charts[0].id);
  await h.scales.toggleReturns();
  assert.equal(h.natal.state.opened, false);
  assert.equal(h.lifetime.state.opened, true);
  assert.equal(h.returns.state.opened, false);
  h.cycle = { id: 'selected-return' };
  await h.scales.openDay();
  assert.equal(h.natal.state.opened, true);
  assert.equal(h.lifetime.state.opened, false);
  assert.equal(h.returns.state.opened, false);
  assert.equal(h.session.current.primary, h.session.original);
  await h.scales.openDay();
  assert.equal(h.natal.state.opened, true);
});

test('reopening the returns menu keeps the current lifetime position and exact selected event', async () => {
  const h = scaleHarness(); await h.scales.select(h.store.charts[0].id);
  await h.scales.toggleReturns(); h.cycle = { id: 'exact-return', utc: '2050-01-01T03:24:55Z' };
  const selected = h.session.current, opens = h.calls.filter(call => call === 'lifetime-open').length;
  h.returns.state.opened = false; await h.returns.open();
  assert.equal(h.session.current, selected);
  assert.equal(h.calls.filter(call => call === 'lifetime-open').length, opens);
});

test('Transit Lifetime never becomes personal Returns when navigating back', async () => {
  const h = birthLifetimeHarness();
  await h.navigation.toggleReturns();
  await h.navigation.select('current-transit');
  assert.equal(await h.navigation.toggleTransit(), true);
  assert.equal(await h.lifetime.setDateRange('2026-09-24', '2026-09-26'), true);
  assert.equal(h.session.selectedId, 'current-transit');
  assert.equal(h.lifetime.state.opened, true, 'precondition: the global lifetime is actually open');
  assert.equal(h.lifetime.state.mode, 'lifetime');
  assert.equal(h.lifetime.state.status, 'ready');
  assert.equal(h.session.current.primary, h.lifetime.current);
  assert.equal(h.session.owner, 'lifetime');
  assert.equal(h.calls.length, 1, 'the public range command fetched a real lifetime point');
  await h.navigation.select(h.natal.id);
  assert.equal(h.session.current.primary, h.natal);
  assert.equal(h.session.current.secondary, null);
  assert.equal(h.lifetime.state.opened, false);
  assert.equal(h.returns.state.opened, false);
  assert.equal(h.natalDay.state.opened, true);
});


test('ordinary rail notifications cannot close a list; the explicit exit closes it', async () => {
  const h = scaleHarness(); await h.scales.select(h.store.charts[0].id);
  await h.scales.toggleReturns(); await h.returns.open();
  for (const opened of [false, true, false]) h.scales.lifetimeChanged({ opened });
  assert.equal(h.returns.state.opened, true);
  await h.scales.toggleReturns();
  assert.equal(h.returns.state.opened, false);
});

test('a return selected during a cold metadata load becomes the rail target, while original stays the saved chart', async () => {
  let finishMetadata, metadataCalls = 0;
  const metadata = new Promise(resolve => { finishMetadata = resolve; });
  const event = { id: 'saturn:2026-09-25T12:00:29.432Z', body: 'saturn', utc: '2026-09-25T12:00:29.432Z', cycle: 1 };
  const exact = { ...chartAtMinute(natalDayFixture({ date: '2026-09-25' }), 720, personalChartFixture()), utc: event.utc };
  const h = birthLifetimeHarness({ getMeta: () => { metadataCalls++; return metadata; },
    returnClient: { events: async () => ({ events: [event] }), chart: async () => ({ chart: exact, event }) } });
  const opening = h.navigation.toggleReturns();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(metadataCalls, 1); assert.equal(h.lifetime.state.metadata, null);
  assert.equal(h.lifetime.state.opened, true); assert.equal(h.lifetime.state.status, 'loading');
  assert.equal(await h.returns.selectEvent(event.id, { restoredEvent: event }), true);
  assert.equal(h.session.current.secondary, exact);
  assert.equal(h.lifetime.state.metadata, null, 'the return was accepted before metadata arrived');
  finishMetadata({ startUtc: '2026-09-24T00:00:00Z', endExclusiveUtc: '2026-09-27T00:00:00Z',
    stepSeconds: 600, samples: 432, planets: [...LIFETIME_PLANETS] });
  assert.equal(await opening, true);
  assert.equal(h.lifetime.state.mode, 'lifetime'); assert.equal(h.lifetime.state.status, 'ready');
  assert.equal(h.lifetime.state.requestedUtc, Date.parse(event.utc));
  assert.equal(h.lifetime.state.displayedUtc, Date.parse(event.utc));
  assert.equal(h.lifetime.current, exact);
  assert.equal(h.session.original, h.natal); assert.equal(h.session.current.primary, h.natal);
  assert.equal(h.session.current.secondary, exact); assert.equal(h.session.current.utc, event.utc);
  assert.deepEqual(h.calls, [], 'metadata completion borrows the exact return without requesting a rounded lifetime point');
});


test('personal lifetime moments compose a stable overlay without changing natal, exact returns or standalone transit', () => {
  const natal = Object.freeze({ id: 'saved', name: 'Марат', source: 'calculated', utc: '1998-08-18T15:00:00Z', personality: [63], design: [41] });
  const transit = Object.freeze({ id: 'lifetime-preview', source: 'transit', utc: '2050-01-01T12:10:00Z', personality: [4], design: [] });
  let moment = null, exact = null;
  const session = createChartSession({ store: { get: id => id === natal.id ? natal : null, has: id => id === natal.id },
    getLifetime: () => ({ get current() { return moment; }, close() { moment = null; } }),
    getReturns: () => ({ get current() { return exact; }, exit() { exact = null; }, select() {} }) });
  session.select(natal.id); moment = transit; session.publish(session.expect('lifetime'), moment);
  const overlay = session.current;
  assert.equal(overlay.kind, 'transit'); assert.equal(overlay.primary, natal); assert.equal(overlay.secondary, transit);
  assert.deepEqual(overlay.topology.personality, [4, 63]); assert.deepEqual(overlay.topology.design, [41]);
  assert.equal(overlay.utc, transit.utc); assert.equal(overlay.primary.name, 'Марат');
  assert.equal(session.current, overlay, 'unchanged references reuse one projection during hover and painting');
  exact = { id: 'exact-return', utc: '2050-01-01T12:14:59Z', designArcResidualDegrees: 1e-10 };
  session.publish(session.expect('return'), exact, { id: exact.id, body: 'saturn', utc: exact.utc });
  assert.equal(session.current.secondary, exact, 'an exact return owns its seconds and design calculation');
  exact = null; moment = { ...transit, utc: '2050-01-01T12:20:00Z', personality: [64] };
  session.publish(session.expect('lifetime'), moment);
  assert.notEqual(session.current, overlay); assert.deepEqual(session.current.topology.personality, [63, 64]);
  assert.equal(session.original, natal); assert.deepEqual(natal.personality, [63]);
  session.select('current-transit'); moment = transit; session.publish(session.expect('lifetime'), moment);
  assert.equal(session.current.primary, transit, 'global transit stays a standalone chart');
  session.select(natal.id); assert.equal(session.current.primary, natal, 'returning to a personal chart rests at exact birth');
});

function birthLifetimeHarness({ birthUtc = '2026-09-24T12:34:56.789Z', getMeta, returnClient } = {}) {
  const natal = { ...chartAtMinute(natalDayFixture(), 754, personalChartFixture()), utc: birthUtc };
  const metadata = { startUtc: '2026-09-24T00:00:00Z', endExclusiveUtc: '2026-09-27T00:00:00Z',
    stepSeconds: 600, samples: 432, planets: [...LIFETIME_PLANETS] };
  const calls = [], frames = [];
  let lifetime, returns, exploration, navigation, natalDay;
  const transit = { state: { wanted: false }, setWanted(value) { this.state.wanted = value; } };
  const session = createChartSession({
    store: { get: id => id === natal.id ? natal : null, has: id => id === natal.id },
    getLifetime: () => lifetime, getReturns: () => returns, getNatalDay: () => natalDay,
    onChange: () => frames.push(session.current),
  });
  exploration = createChartExploration({ session, getLifetime: () => lifetime, getReturns: () => returns,
    getTransit: () => transit, getNatalDay: () => natalDay, loadLifetime: async () => lifetime });
  natalDay = createNatalDayExplorer({ dayClient: { getDay: async () => natalDayFixture() }, onRender: exploration.publishDay });
  returns = createReturnsController({ client: returnClient || { events: async () => ({ events: [] }) },
    onRequest: exploration.requestReturn, onRender: exploration.publishReturn });
  lifetime = createLifetimeExplorer({ client: {
    getMeta: getMeta || (async () => metadata),
    getPoint: async index => {
      calls.push(index);
      const utc = new Date(Date.parse(metadata.startUtc) + index * 600000).toISOString();
      return { index, utc, longitudes: Array.from({ length: 11 }, (_, n) => n + 1),
        design: { utc, designUtc: '2026-06-28T12:30:00Z', designArcResidualDegrees: 0,
          longitudes: Array.from({ length: 11 }, (_, n) => n + 11) } };
    },
  }, getMomentState: exploration.momentState, onModeAccepted: exploration.acceptLifetimeMode,
  onStateChange: exploration.lifetimeChanged,
  onRender: exploration.publishLifetime });
  navigation = exploration;
  session.select(natal.id); session.showOriginal();
  return { session, lifetime, navigation, exploration, natal, natalDay, returns, calls, frames, get painted() { return frames.at(-1); },
    setPreview: exploration.restorePreview,
    restore(requestedUtc = Date.parse(natal.utc), overrides = {}) { return lifetime.restore({ opened: true, mode: 'lifetime',
      fromDate: '2026-09-24', toDate: '2026-09-26', minimumUtc: natal.utc, requestedUtc, ...overrides }); } };
}

test('choosing birth at its already selected lifetime UTC paints the exact natal chart again', async () => {
  const h = birthLifetimeHarness({ birthUtc: '2026-09-24T12:30:00Z' });
  h.setPreview(true); await h.restore();
  assert.equal(h.painted.kind, 'transit');
  assert.equal(h.lifetime.state.requestedUtc, Date.parse(h.natal.utc));
  const original = JSON.stringify(h.natal), count = h.frames.length;
  h.navigation.resetMoment();
  assert.equal(h.lifetime.state.requestedUtc, Date.parse(h.natal.utc));
  assert.equal(h.lifetime.state.opened, true); assert.equal(h.session.current.primary, h.natal);
  assert.equal(h.painted.primary, h.natal); assert.equal(h.painted.secondary, null);
  assert.ok(h.frames.length > count, 'birth must repaint even when the lifetime UTC already matches');
  assert.equal(JSON.stringify(h.natal), original); assert.deepEqual(h.calls, [75]);
});

test('Birth resets from another lifetime slot using its saved chart with no rounded point request', async () => {
  const h = birthLifetimeHarness(), saved = JSON.stringify(h.natal);
  h.setPreview(true); await h.restore(Date.parse('2026-09-24T13:20:00Z'));
  assert.deepEqual(h.calls, [80]); assert.equal(h.painted.kind, 'transit');
  h.navigation.resetMoment(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls, [80], 'reset must not request an invisible rounded birth chart');
  assert.equal(h.lifetime.state.requestedUtc, Date.parse(h.natal.utc));
  assert.equal(h.lifetime.state.displayedUtc, Date.parse(h.natal.utc));
  assert.equal(h.lifetime.current, h.natal); assert.equal(h.painted.utc, h.natal.utc);
  assert.equal(h.painted.primary, h.natal, 'birth retains Design and the personality transit at the exact birth time');
  assert.equal(JSON.stringify(h.natal), saved);
  h.setPreview(true); await h.lifetime.scrub(Date.parse(h.natal.utc));
  assert.deepEqual(h.calls, [80, 76], 'explicit manual lifetime selection starts at its first legal grid sample');
  assert.equal(h.lifetime.state.displayedUtc, Date.parse('2026-09-24T12:40:00Z')); assert.equal(h.painted.kind, 'transit');
});

test('restoring the exact birth boundary borrows its saved chart without a lifetime request', async () => {
  const h = birthLifetimeHarness();
  assert.equal(h.lifetime.state.opened, false);
  await h.lifetime.open(); assert.equal(h.lifetime.state.mode, 'day');
  assert.equal(await h.restore(), true);
  assert.deepEqual(h.calls, []); assert.equal(h.lifetime.state.requestedUtc, Date.parse(h.natal.utc));
  assert.equal(h.lifetime.current, h.natal); assert.equal(h.lifetime.state.displayedUtc, Date.parse(h.natal.utc));
  h.session.refresh(); assert.equal(h.painted.utc, h.natal.utc); assert.equal(h.painted.primary, h.natal);
  h.setPreview(true); await h.lifetime.scrub(Date.parse(h.natal.utc));
  assert.deepEqual(h.calls, [76]); assert.equal(h.painted.utc, '2026-09-24T12:40:00Z');
});

test('manual birth-range ownership and a later custom range do not borrow Birth', async () => {
  const h = birthLifetimeHarness(); h.setPreview(true); await h.restore(Date.parse('2026-09-24T12:40:00Z'));
  assert.deepEqual(h.calls, [76]); assert.equal(h.painted.kind, 'transit');
  assert.notEqual(h.lifetime.current, h.natal, 'an explicitly sampled birth range retains its sampled owner');
  await h.lifetime.setDateRange('2026-09-25', '2026-09-26');
  assert.equal(h.lifetime.state.requestedUtc, h.lifetime.state.minUtc);
  assert.equal(h.lifetime.state.minUtc, Date.parse('2026-09-25T00:00:00Z'));
  assert.deepEqual(h.calls, [76, 144]); assert.notEqual(h.lifetime.current, h.natal);
  h.lifetime.close(); assert.equal(h.lifetime.state.opened, false);
});

test('the upper Returns toggle leaves the whole mode even after its list was closed', async () => {
  const h = scaleHarness(); await h.scales.select(h.store.charts[0].id);
  await h.scales.toggleReturns();
  assert.equal(h.lifetime.state.opened, true);
  assert.equal(h.returns.state.opened, false);
  assert.equal(h.natal.state.opened, false);
  h.cycle = { id: 'selected-return', utc: '2050-01-01T03:24:55Z' };
  await h.returns.open();
  h.returns.close();
  await h.scales.toggleReturns();
  assert.equal(h.lifetime.state.opened, false);
  assert.equal(h.returns.state.opened, false);
  assert.equal(h.natal.state.opened, false);
  assert.equal(h.natal.state.exactOriginal, true);
  assert.equal(h.session.current.primary, h.session.original);
  await h.scales.toggleReturns();
  assert.equal(h.lifetime.state.opened, true);
  assert.equal(h.returns.state.opened, false);
  assert.equal(h.natal.state.opened, false);
});

test('the Day toggle switches off without enabling Returns and switches back on at the original minute', async () => {
  const h = scaleHarness(); await h.scales.select(h.store.charts[0].id);
  h.natal.scrub(800);
  assert.notEqual(h.session.current.primary, h.session.original);
  await h.scales.toggleDay();
  assert.equal(h.natal.state.opened, false);
  assert.equal(h.lifetime.state.opened, false);
  assert.equal(h.returns.state.opened, false);
  assert.equal(h.session.current.primary, h.session.original);
  await h.scales.toggleDay();
  assert.equal(h.natal.state.opened, true);
  assert.equal(h.natal.state.exactOriginal, true);
  assert.equal(h.session.current.primary, h.session.original);
  await h.scales.toggleDay();
  assert.equal(h.natal.state.opened, false);
  assert.equal(h.lifetime.state.opened, false);
  assert.equal(h.returns.state.opened, false);
});

test('switching between Day and Returns is exclusive and switching Returns off leaves both off', async () => {
  const h = scaleHarness(); await h.scales.select(h.store.charts[0].id);
  await h.scales.toggleReturns();
  assert.equal(h.natal.state.opened, false);
  assert.equal(h.lifetime.state.opened, true);
  await h.scales.toggleDay();
  assert.equal(h.natal.state.opened, true);
  assert.equal(h.lifetime.state.opened, false);
  assert.equal(h.returns.state.opened, false);
  await h.scales.toggleReturns();
  assert.equal(h.natal.state.opened, false);
  assert.equal(h.lifetime.state.opened, true);
  assert.equal(h.returns.state.opened, false);
  await h.scales.toggleReturns();
  assert.equal(h.natal.state.opened, false);
  assert.equal(h.lifetime.state.opened, false);
  assert.equal(h.returns.state.opened, false);
  assert.equal(h.session.current.primary, h.session.original);
});


function lazyTransitScaleHarness({ metadataPending = false } = {}) {
  const chart = chartAtMinute(natalDayFixture(), 754, personalChartFixture());
  let session, lifetime = null, finishImport, finishMetadata;
  const imported = new Promise(resolve => { finishImport = resolve; });
  const metadata = { startUtc: '1801-01-01T00:00:00Z', endExclusiveUtc: '2400-01-01T00:00:00Z',
    stepSeconds: 600, samples: 31_504_320, planets: [...LIFETIME_PLANETS] };
  const meta = metadataPending ? new Promise(resolve => { finishMetadata = resolve; }) : Promise.resolve(metadata);
  const controller = createLifetimeExplorer({ client: { getMeta: () => meta,
    getPoint: () => assert.fail('opening standalone Lifetime starts in Day and needs no lifetime point') } });
  const natalDay = createNatalDayExplorer({ dayClient: { getDay: async () => natalDayFixture() }, onRender: () => session.publish('natal-day', natalDay.current) });
  const returns = createReturnsController();
  session = createChartSession({ store: { get: id => id === chart.id ? chart : null, has: id => id === chart.id },
    getNatalDay: () => natalDay, getLifetime: () => lifetime, getReturns: () => returns });
  const scales = createChartExploration({ session, getNatalDay: () => natalDay, getLifetime: () => lifetime, getReturns: () => returns, getTransit: () => null, loadLifetime: () => imported });
  return { chart, session, natalDay, scales, controller,
    finishImport() { lifetime = controller; finishImport(controller); },
    finishMetadata() { finishMetadata(metadata); } };
}

for (const destination of ['saved-person', 'current-transit']) test(`navigation to ${destination} cancels pending standalone Lifetime before its module loads`, async () => {
  const h = lazyTransitScaleHarness();
  const opening = h.scales.toggleTransit();
  assert.equal(h.scales.transitEnabled, true);
  await h.scales.select(destination);
  h.finishImport();
  assert.equal(await opening, false);
  assert.equal(h.controller.state.opened, false);
  assert.equal(h.scales.transitEnabled, false);
  assert.equal(h.natalDay.state.opened, destination === 'saved-person');
  assert.equal(h.session.selectedId, destination);
});

for (const phase of ['module', 'metadata']) test(`second standalone Lifetime click cancels the pending ${phase} and leaves both rails closed`, async () => {
  const h = lazyTransitScaleHarness({ metadataPending: phase === 'metadata' });
  const opening = h.scales.toggleTransit();
  if (phase === 'metadata') { h.finishImport(); await Promise.resolve(); }
  assert.equal(h.scales.transitEnabled, true);
  assert.equal(await h.scales.toggleTransit(), false);
  assert.equal(h.scales.transitEnabled, false);
  if (phase === 'module') h.finishImport(); else h.finishMetadata();
  assert.equal(await opening, false);
  assert.equal(h.controller.state.opened, false);
  assert.equal(h.natalDay.state.opened, false);
});

test('a cancelled standalone Lifetime continuation cannot clear a later click sharing the same module', async () => {
  const h = lazyTransitScaleHarness();
  const first = h.scales.toggleTransit();
  await h.scales.toggleTransit();
  const latest = h.scales.toggleTransit();
  h.finishImport();
  assert.equal(await first, false);
  assert.equal(await latest, true);
  assert.equal(h.scales.transitEnabled, true);
  assert.equal(h.controller.state.opened, true);
  assert.equal(h.controller.state.mode, 'day');
  assert.equal(await h.scales.toggleTransit(), false);
  assert.equal(h.controller.state.opened, false);
  assert.equal(await h.scales.toggleTransit(), true, 'a loaded controller can be reopened normally');
});

function filteredTransitSession() {
  const natal = personalChartFixture();
  const rows = offset => PLANET_IDS.map((planet, index) => ({ planet, gate: index + offset, line: 1 }));
  const moment = { id: 'current-transit', source: 'transit', utc: '2026-10-09T12:00:00Z',
    activations: { personality: rows(1), design: rows(20) } };
  moment.personality = moment.activations.personality.map(row => row.gate);
  moment.design = moment.activations.design.map(row => row.gate);
  const planets = createTransitPlanetFilter();
  planets.setExpanded(true);
  for (const source of ['personality', 'design']) {
    planets.setAllPlanets(false, source);
    for (const planet of ['uranus', 'neptune', 'pluto']) planets.setPlanet(planet, true, source);
  }
  const session = createChartSession({
    store: { get: id => id === natal.id ? natal : moment, has: () => true },
    getTransit: () => ({ current: moment, setWanted() {} }),
    getLifetime: () => ({ close: () => planets.setExpanded(false) }),
    filterTransit: planets.filter, resetTransitFilter: planets.reset,
  });
  return { natal, moment, planets, session };
}

test('leaving Transit restores all personality planets without enabling Design in a personal overlay', () => {
  const { natal, moment, planets, session } = filteredTransitSession();
  const original = JSON.stringify({ natal, moment });
  const previous = planets.filter(moment);
  assert.equal(previous.activations.personality.length, 3);
  assert.equal(previous.activations.design.length, 3);
  session.select(natal.id);
  planets.setExpanded(true);
  // A retained projection must also recover its complete source rows.
  const complete = planets.filter(previous);
  session.publish(session.expect('lifetime'), complete);
  assert.equal(session.current.primary, natal);
  assert.deepEqual(session.current.secondary.activations.personality.map(row => row.planet), PLANET_IDS);
  assert.deepEqual(session.current.secondary.activations.design, []);
  session.select('current-transit');
  planets.setExpanded(true);
  assert.deepEqual(planets.snapshot, { selectedPlanets: PLANET_IDS, selectedDesignPlanets: [] });
  assert.equal(JSON.stringify({ natal, moment }), original);
});

test('staying in Transit preserves individual lifetime choices across day and lifetime views', () => {
  const { planets, session, moment } = filteredTransitSession();
  const chosen = planets.snapshot;
  planets.setExpanded(false);
  assert.equal(planets.filter(moment).activations.personality.length, PLANET_IDS.length);
  session.select('current-transit');
  planets.setExpanded(true);
  assert.deepEqual(planets.snapshot, chosen);
  assert.deepEqual(planets.filter(moment).activations.personality.map(row => row.planet), ['uranus', 'neptune', 'pluto']);
});
