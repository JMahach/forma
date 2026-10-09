import test from 'node:test';
import assert from 'node:assert/strict';
import { createReturnsController } from '../src/state/returns.js';
import { DEFAULT_CYCLE_BODIES } from '../src/domain/cycles.js';
import { chartCaption } from '../src/views/chart-display.js';
import { createViewSession } from '../src/state/view-session.js';
import { createViewStore } from '../src/data/view-store.js';
import { createChartStore } from '../src/data/chart-store.js';
import { createChartSession } from '../src/state/chart-session.js';
import { createChartExploration } from '../src/state/chart-exploration.js';
import { createTransitPlanetFilter } from '../src/state/transit-planets.js';
import { createLifetimeExplorer } from '../src/state/lifetime.js';
import { LIFETIME_PLANETS } from '../shared/lifetime-format.js';
import { createLiveTransit } from '../src/state/live-transit.js';
import { createNatalDayExplorer } from '../src/state/natal-day.js';
import { attachMandalaMode } from '../src/scene/modes/mandala.js';
import { createMandalaMotion } from '../src/scene/modes/mandala-motion.js';
import { createCamera } from '../src/scene/camera.js';
import { STUDIO_FRAME, MANDALA_FRAME } from '../src/scene/geometry/frames.js';
import { chartAtMinute } from '../src/domain/natal-day.js';
import { transitChartAt } from '../src/domain/transit-day.js';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.mjs';
import { dateDom } from './helpers/date-dom.mjs';

const lifetimeFixtures = [];
test.afterEach(() => { for (const explorer of lifetimeFixtures.splice(0)) explorer.close(); });

const day = date => ({ date, startUtc: `${date}T00:00:00Z`, samples: 1440, stepSeconds: 60,
  columns: Array.from({ length: 24 }, (_, column) => Float64Array.from({ length: 1440 }, (_, minute) => column < 22
    ? (column * 20 + minute / 10000) % 360 : column === 22 ? Date.parse(`${date}T00:00:00Z`) / 1000 - 88 * 86400 + minute * 61 : 0)) });
function events() {
  const callbacks = new Map();
  return { hidden: false, addEventListener(name, callback) { callbacks.set(name, callback); },
    contains(target) { return target === this; },
    dispatch(name, event = {}) { callbacks.get(name)?.({ ...event, type: name }); } };
}
const metadata = { startUtc: '2020-01-01T00:00:00Z', endExclusiveUtc: '2020-01-04T00:00:00Z', stepSeconds: 600, samples: 432, planets: [...LIFETIME_PLANETS] };
const point = (index, source = metadata) => {
  const utc = new Date(Date.parse(source.startUtc) + index * 600000).toISOString().replace('.000Z', 'Z');
  return { index, utc, longitudes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    design: { utc, designUtc: new Date(Date.parse(utc) - 88 * 86400000).toISOString(),
      designArcResidualDegrees: 0, longitudes: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21] } };
};
function harness(storage = new Map(), { size = 1000, transitDay = async date => day(date), loadLifetime = null, canRestoreLifetime = null,
    returnsClient = null, openReturnsTimeline = undefined, getNow = () => Date.parse('2026-10-04T12:00:00Z'),
    zone = 'UTC', normalizeSavedView = value => value, lifetimeClient = { getMeta: async () => metadata, getPoint: async index => point(index) } } = {}) {
  const frames = [], writes = [], pending = new Map(), attributes = {}, styles = new Map();
  const storagePort = { getItem: key => storage.get(key) ?? null,
    setItem(key, value) { storage.set(key, value); writes.push([key, value]); } };
  const saved = chartAtMinute(natalDayFixture(), 754, personalChartFixture());
  if (!storage.has('liniya.charts.v1')) storage.set('liniya.charts.v1', JSON.stringify([saved, { ...saved, id: 'second' }]));
  const chartStore = createChartStore({ getStorage: () => storagePort });
  const viewStore = createViewStore({ getStorage: () => storagePort });
  let view, transit, natalDay, mandala, lifetime = null, returns, exploration;
  const planets = createTransitPlanetFilter();
  const changed = () => view?.schedule();
  const session = createChartSession({ store: chartStore, getTransit: () => transit, getNatalDay: () => natalDay,
    getLifetime: () => lifetime, getReturns: () => returns, filterTransit: planets.filter,
    onSelect: () => exploration?.selected(), onChange: () => { changed(); if (session.hasCurrent) frames.push(session.current.utc); } });
  exploration = createChartExploration({ session, getTransit: () => transit, getNatalDay: () => natalDay,
    getLifetime: () => lifetime, getReturns: () => returns, loadLifetime: async () => ensureLifetime(), onChange: changed });
  const setPersonalLive = value => exploration.restoreLive(value);
  const returnEvent = { id: 'saturn:2055-10-01T12:00:00Z', utc: '2055-10-01T12:00:00Z', body: 'saturn', cycle: 1, pass: 1, cycleId: 'saturn:1', age: 29, direction: 'direct' };
  returns = createReturnsController({ client: returnsClient || {
    events: async input => ({ events: input.body === 'saturn' ? [returnEvent] : [] }),
    chart: async input => ({ event: { ...returnEvent, id: `${input.body}:${input.eventUtc}`, body: input.body, utc: input.eventUtc },
      chart: { ...saved, utc: input.eventUtc, personality: [2,14], design: [3,60] } }),
  }, onStateChange: changed, onRequest: exploration.requestReturn, onRender: exploration.publishReturn });
  transit = createLiveTransit({ now: getNow, timeZone: () => zone,
    dayClient: { getDay: transitDay }, onStateChange: changed, onRender: exploration.publishTransit });
  natalDay = createNatalDayExplorer({ dayClient: { getDay: async () => natalDayFixture() }, onStateChange: changed, onRender: exploration.publishDay });
  const camera = createCamera({ getFrame: () => MANDALA_FRAME, getHomeFrame: () => STUDIO_FRAME,
    measureFit: () => ({ area: { x: 0, y: 0, width: size, height: size }, min: .1 }), onChange: changed });
  const motion = createMandalaMotion({ viewport: { style: { setProperty: (name, value) => styles.set(name, value) } },
    requestFrame: () => { assert.fail('restoration must reveal the saved mode without an animation from zero'); },
    onFinish: enabled => mandala.finishTransition(enabled) });
  const button = events(); button.setAttribute = (name, value) => { attributes[name] = value; };
  mandala = attachMandalaMode({ button, canvas: { classList: { toggle() {} } }, gestures: camera, layout: { frame: () => STUDIO_FRAME },
    motion, render() {}, onStateChange: changed });
  function ensureLifetime() {
    if (!lifetime) {
      lifetime = createLifetimeExplorer({ client: lifetimeClient, planetFilter: planets,
        getDayState: () => transit.state, onRender: exploration.publishLifetime,
        getMomentState: exploration.momentState, onModeAccepted: exploration.acceptLifetimeMode,
        onStateChange(state) { exploration.lifetimeChanged(state); changed(); } });
      lifetimeFixtures.push(lifetime);
      lifetime.setAvailable = value => { if (!value) lifetime.close(); };
      lifetime.refreshDay = () => {};
    }
    return lifetime;
  }
  const eventTarget = events(), interactionTarget = events(), cameraSurface = events();
  let counter = 0;
  const savedView = normalizeSavedView(viewStore.read());
  view = createViewSession({ store: { read: () => savedView, write: viewStore.write }, chartStore, session, mandala, camera, transit, natalDay,
    ...(canRestoreLifetime ? { canRestoreLifetime } : {}), openReturnsTimeline,
    planetFilter: planets, getReturns: () => returns, getLifetime: () => lifetime, loadLifetime: loadLifetime || (async () => ensureLifetime()), eventTarget, interactionTarget,
    acceptLifetimeMode: exploration.acceptLifetimeMode,
    getPersonalLive: () => exploration.live, restorePersonalLive: exploration.restoreLive,
    getPersonalPreview: () => exploration.preview, restorePersonalPreview: exploration.restorePreview,
    schedule(callback) { const id = ++counter; pending.set(id, callback); return id; }, cancel: id => pending.delete(id) });
  const restore = view.restore;
  view.restore = async () => {
    try { return await restore(); }
    finally { exploration.finishRestore({ saved: savedView, pendingLifetime: view.pendingLifetime, pendingReturns: view.pendingReturns, interrupted: view.interrupted }); }
  };
  const tick = () => { for (const [id, callback] of [...pending]) { pending.delete(id); callback(); } };
  return { frames, view, session, exploration, returns, returnEvent, mandala, camera, cameraSurface, transit, natalDay, planets, storage, writes, attributes, styles, eventTarget, interactionTarget, ensureLifetime, setPersonalLive, tick };
}

test('browser reload restores saved chart, mandala endpoint, natal minute and camera without modifying the library', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  // The fixture identity is fixed independently from session internals.
  first.session.select(JSON.parse(first.storage.get('liniya.charts.v1'))[0].id);
  first.mandala.setEnabled(true, { animate: false });
  first.camera.zoom(2); first.camera.pan(40, 25);
  await first.natalDay.open(); first.natalDay.scrub(800);
  first.eventTarget.dispatch('pagehide');
  const beforeLibrary = first.storage.get('liniya.charts.v1');
  const pose = first.camera.getView();
  const second = harness(first.storage); t.after(() => second.transit.stop()); await second.view.restore();
  assert.equal(second.view.interrupted, false);
  assert.equal(second.session.selectedId, JSON.parse(beforeLibrary)[0].id);
  assert.equal(second.mandala.enabled, true); assert.equal(second.attributes['aria-checked'], 'true');
  assert.equal(second.styles.get('--mandala-reveal'), '1');
  assert.equal(second.natalDay.state.opened, true); assert.equal(second.natalDay.state.index, 800);
  assert.equal(second.session.current.utc, '2026-09-24T13:20:00Z');
  assert.deepEqual(second.camera.getView(), pose);
  assert.equal(second.storage.get('liniya.charts.v1'), beforeLibrary);
  second.session.select('second');
  assert.equal(second.mandala.enabled, true); assert.deepEqual(second.camera.getView(), pose);
});

test('day slider pause at the first minute survives refresh while the real clock reference remains current', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  first.transit.scrub(0); first.view.flush();
  const second = harness(first.storage); t.after(() => second.transit.stop()); await second.view.restore();
  assert.equal(second.transit.state.live, false); assert.equal(second.transit.state.index, 0);
  assert.equal(second.transit.current.utc, '2026-10-04T00:00:00Z');
  assert.equal(second.transit.state.referenceIndex, 720);
});

test('camera restoration rebases against the new screen Home and respects maximum zoom', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  first.camera.zoom(2); first.view.flush();
  const second = harness(first.storage, { size: 500 }); t.after(() => second.transit.stop()); await second.view.restore();
  assert.equal(second.camera.getView().k / second.camera.getFittedView().k, 2);
  const third = harness(first.storage, { size: 5000 }); t.after(() => third.transit.stop()); await third.view.restore();
  assert.equal(third.camera.getView().k, 4.5);
});

test('a deleted chart falls back to transit and malformed presentation never clears the saved library', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  first.session.select('missing'); first.view.flush();
  const second = harness(first.storage); t.after(() => second.transit.stop()); await second.view.restore();
  assert.equal(second.session.selectedId, 'current-transit'); assert.equal(second.transit.current.id, 'current-transit');
  assert.equal(JSON.parse(second.storage.get('liniya.charts.v1')).length, 2);
});

test('initial loading cannot overwrite a saved view and a later user action cancels pending paused restoration', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore(); first.transit.scrub(0); first.view.flush();
  let resolve; const second = harness(first.storage, { transitDay: () => new Promise(done => { resolve = done; }) });
  t.after(() => second.transit.stop()); const restoring = second.view.restore();
  second.view.flush(); assert.equal(second.writes.length, 0);
  second.view.interrupt(); second.session.select('second');
  assert.equal(second.view.interrupted, true, 'composition must not apply the old saved preview after new user navigation');
  resolve(day('2026-10-04')); await restoring;
  assert.equal(second.session.selectedId, 'second'); assert.equal(second.transit.state.wanted, false);
  assert.equal(second.transit.current, null);
});

test('coalesced camera updates save the latest position and page hiding flushes pending changes', async t => {
  const h = harness(); t.after(() => h.transit.stop()); await h.view.restore(); h.writes.length = 0;
  for (let i = 0; i < 100; i++) h.camera.zoom(1.002);
  assert.equal(h.writes.length, 0); h.tick(); assert.equal(h.writes.length, 1);
  h.camera.pan(-10, -10); h.interactionTarget.hidden = true; h.interactionTarget.dispatch('visibilitychange');
  assert.equal(h.writes.length, 2);
});


test('reload restores the lifetime range, requested lifetime moment and raw planet choices before fetching a point', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const lifetime = first.ensureLifetime(); await lifetime.open(); await lifetime.setDateRange('2020-01-01', '2020-01-03');
  lifetime.setAllPlanets(false); lifetime.setPlanet('moon', true); lifetime.setPlanet('sun', true, 'design');
  await lifetime.scrub(Date.parse('2020-01-02T09:20:00Z')); first.view.flush();
  const calls = []; const second = harness(first.storage, { lifetimeClient: { getMeta: async () => metadata,
    getPoint: async index => { calls.push(index); return point(index); } } });
  t.after(() => second.transit.stop()); await second.view.restore();
  const restored = second.ensureLifetime();
  assert.equal(restored.state.opened, true); assert.equal(restored.state.mode, 'lifetime');
  assert.equal(restored.state.fromDate, '2020-01-01'); assert.equal(restored.state.toDate, '2020-01-03');
  assert.equal(restored.state.requestedUtc, Date.parse('2020-01-02T09:20:00Z')); assert.deepEqual(calls, [200]);
  assert.equal(second.session.current.utc, '2020-01-02T09:20:00Z');
  assert.deepEqual(second.session.current.primary.activations.personality.map(entry => entry.planet), ['moon']);
  assert.deepEqual(second.session.current.primary.activations.design.map(entry => entry.planet), ['sun']);
  assert.equal(second.transit.state.wanted, false);
});

test('failed lifetime metadata keeps the saved range and moment so retry resumes the same view', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const lifetime = first.ensureLifetime(); await lifetime.open(); await lifetime.setDateRange('2020-01-01', '2020-01-03');
  await lifetime.scrub(Date.parse('2020-01-02T09:20:00Z')); first.view.flush();
  let fail = true; const calls = [];
  const second = harness(first.storage, { lifetimeClient: { getMeta: async () => { if (fail) throw new Error('Offline'); return metadata; },
    getPoint: async index => { calls.push(index); return point(index); } } });
  t.after(() => second.transit.stop()); await second.view.restore();
  const saved = JSON.parse(second.storage.get('liniya.view.v1'));
  assert.equal(saved.lifetime.mode, 'lifetime'); assert.equal(saved.lifetime.requestedUtc, Date.parse('2020-01-02T09:20:00Z'));
  assert.equal(saved.lifetime.fromDate, '2020-01-01');
  assert.equal(second.ensureLifetime().state.status, 'loading');
  assert.equal(second.ensureLifetime().state.retryCount, 1);
  assert.equal(second.ensureLifetime().state.mode, 'lifetime');
  assert.equal(second.transit.state.wanted, false);
  assert.equal(second.session.hasCurrent, false);
  const retained = second.view.pendingLifetime;
  assert.deepEqual([retained.mode, retained.fromDate, retained.toDate, retained.requestedUtc], ['lifetime', '2020-01-01', '2020-01-03', Date.parse('2020-01-02T09:20:00Z')]);
  retained.requestedUtc = 1; retained.fromDate = '2020-01-03';
  assert.deepEqual([second.view.pendingLifetime.fromDate, second.view.pendingLifetime.requestedUtc], ['2020-01-01', Date.parse('2020-01-02T09:20:00Z')]);
  fail = false; await second.ensureLifetime().retry();
  assert.deepEqual(calls, [200]); assert.equal(second.session.current.utc, '2020-01-02T09:20:00Z');
  assert.equal(second.view.pendingLifetime, null);
});

test('failed transit loading retains its paused target and applies it on a successful retry', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore(); first.transit.scrub(0); first.view.flush();
  let fail = true; const second = harness(first.storage, { transitDay: async date => { if (fail) throw new Error('Offline'); return day(date); } });
  t.after(() => second.transit.stop()); await second.view.restore();
  const saved = JSON.parse(second.storage.get('liniya.view.v1'));
  assert.equal(saved.transit.live, false); assert.equal(saved.transit.index, 0);
  fail = false; await second.transit.retry();
  assert.equal(second.transit.state.live, false); assert.equal(second.transit.current.utc, '2026-10-04T00:00:00Z');
});

test('missing Lifetime module keeps its saved range for another reload', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const lifetime = first.ensureLifetime(); await lifetime.open(); await lifetime.setDateRange('2020-01-01', '2020-01-03'); await lifetime.scrub(Date.parse('2020-01-02T09:20:00Z')); first.view.flush();
  const second = harness(first.storage, { loadLifetime: async () => null }); t.after(() => second.transit.stop()); await second.view.restore();
  const saved = JSON.parse(second.storage.get('liniya.view.v1'));
  assert.equal(saved.lifetime.mode, 'lifetime'); assert.equal(saved.lifetime.requestedUtc, Date.parse('2020-01-02T09:20:00Z'));
});


test('reload preserves an empty end as the full available lifetime range', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const lifetime = first.ensureLifetime(); await lifetime.open(); await lifetime.setDateRange('2020-01-02', null);
  await lifetime.scrub(Date.parse('2020-01-02T09:20:00Z')); first.view.flush();
  const second = harness(first.storage); t.after(() => second.transit.stop()); await second.view.restore();
  const restored = second.ensureLifetime();
  assert.equal(restored.state.openEnded, true); assert.equal(restored.state.fromDate, '2020-01-02');
  assert.equal(restored.state.toDate, '2020-01-03'); assert.equal(restored.state.maxUtc, Date.parse('2020-01-03T23:59:59.999Z')); assert.equal(restored.state.requestedUtc, Date.parse('2020-01-02T09:20:00Z'));
});


async function savePersonalLifetime(t) {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const personalId = JSON.parse(first.storage.get('liniya.charts.v1'))[0].id;
  first.session.select(personalId); await first.natalDay.open(); first.natalDay.scrub(800);
  first.exploration.restorePreview(true);
  const lifetime = first.ensureLifetime(); await lifetime.open();
  await lifetime.setDateRange('2020-01-01', '2020-01-03'); await lifetime.scrub(Date.parse('2020-01-02T09:20:00Z')); first.view.flush();
  return { storage: first.storage, personalId };
}

test('eligible personal Lifetime restores exact saved range and moment ahead of an opened natal-day preview', async t => {
  const { storage, personalId } = await savePersonalLifetime(t), calls = [];
  const second = harness(storage, { canRestoreLifetime: () => true, lifetimeClient: {
    getMeta: async () => metadata, getPoint: async index => { calls.push(index); return point(index); } } });
  t.after(() => second.transit.stop());
  assert.equal(await second.view.restore(), true);
  assert.equal(second.view.pendingLifetime, null);
  assert.equal(second.session.selectedId, personalId); assert.equal(second.natalDay.state.opened, false);
  const lifetime = second.ensureLifetime().state;
  assert.deepEqual([lifetime.mode, lifetime.fromDate, lifetime.toDate, lifetime.requestedUtc], ['lifetime', '2020-01-01', '2020-01-03', Date.parse('2020-01-02T09:20:00Z')]);
  assert.deepEqual(calls, [200]); assert.equal(second.session.current.utc, '2020-01-02T09:20:00Z');
  assert.equal(second.session.current.kind, 'transit');
  assert.equal(second.session.current.primary, second.session.original);
  assert.equal(second.session.current.secondary, second.ensureLifetime().current);
  assert.equal(second.returns.current, null, 'an intermediate moment restores without inventing a return event');
});

test('delayed personal Lifetime metadata cannot overwrite the saved target with a borrowed day', async t => {
  const { storage } = await savePersonalLifetime(t), calls = []; let release;
  const second = harness(storage, { canRestoreLifetime: () => true, lifetimeClient: {
    getMeta: () => new Promise(resolve => { release = resolve; }), getPoint: async index => { calls.push(index); return point(index); } } });
  t.after(() => second.transit.stop()); const pending = second.view.restore();
  await new Promise(resolve => setImmediate(resolve)); second.view.flush();
  assert.equal(second.writes.length, 0);
  const saved = JSON.parse(storage.get('liniya.view.v1'));
  assert.deepEqual([saved.lifetime.fromDate, saved.lifetime.toDate, saved.lifetime.requestedUtc], ['2020-01-01', '2020-01-03', Date.parse('2020-01-02T09:20:00Z')]);
  release(metadata); assert.equal(await pending, true); assert.deepEqual(calls, [200]);
});

test('navigation while personal Lifetime metadata is pending cancels restoration before any point', async t => {
  const { storage } = await savePersonalLifetime(t), calls = []; let release;
  const second = harness(storage, { canRestoreLifetime: () => true, lifetimeClient: {
    getMeta: () => new Promise(resolve => { release = resolve; }), getPoint: async index => { calls.push(index); return point(index); } } });
  t.after(() => second.transit.stop()); const pending = second.view.restore();
  await new Promise(resolve => setImmediate(resolve));
  second.view.interrupt(); second.session.select('second');
  release(metadata); assert.equal(await pending, false);
  assert.equal(second.session.selectedId, 'second'); assert.equal(second.ensureLifetime().state.opened, false);
  assert.deepEqual(calls, []);
});

test('personal Lifetime remains opt-in and a deleted saved personal chart cannot restore its lifetime', async t => {
  for (const missing of [false, true]) {
    const { storage, personalId } = await savePersonalLifetime(t);
    if (missing) storage.set('liniya.charts.v1', JSON.stringify(JSON.parse(storage.get('liniya.charts.v1')).filter(chart => chart.id !== personalId)));
    let loads = 0;
    const second = harness(storage, { ...(missing ? { canRestoreLifetime: () => true } : {}), loadLifetime: async () => { loads++; return null; } });
    t.after(() => second.transit.stop()); await second.view.restore();
    assert.equal(loads, 0); assert.equal(second.ensureLifetime().state.opened, false);
    assert.equal(JSON.parse(storage.get('liniya.view.v1')).lifetime, null);
    assert.equal(second.session.selectedId, missing ? 'current-transit' : personalId);
  }
});


test('successful personal Lifetime restore acknowledges a UTC target clamped by the normalized lifespan', async t => {
  const { storage, personalId } = await savePersonalLifetime(t), calls = [];
  // The composition root normalizes a legacy custom range before restoration.
  // Its formerly selected moment can precede the newly fixed birth boundary.
  const saved = JSON.parse(storage.get('liniya.view.v1'));
  saved.lifetime.fromDate = '2020-01-03';
  storage.set('liniya.view.v1', JSON.stringify(saved));
  const second = harness(storage, { canRestoreLifetime: () => true, lifetimeClient: {
    getMeta: async () => metadata, getPoint: async index => { calls.push(index); return point(index); } } });
  t.after(() => second.transit.stop());
  assert.equal(await second.view.restore(), true);
  assert.equal(second.session.selectedId, personalId);
  assert.equal(second.view.pendingLifetime, null);
  assert.equal(second.ensureLifetime().state.requestedUtc, Date.parse('2020-01-03T00:00:00Z'));
  assert.deepEqual(calls, [288]);
  const persisted = JSON.parse(storage.get('liniya.view.v1')).lifetime;
  assert.deepEqual([persisted.fromDate, persisted.toDate, persisted.requestedUtc], ['2020-01-03', '2020-01-03', Date.parse('2020-01-03T00:00:00Z')]);
});


test('same-tab reload restores the exact personal return and transit navigation clears its ownership', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const source = JSON.parse(first.storage.get('liniya.charts.v1'))[0];
  first.session.select(source.id); await first.returns.open(); await first.returns.selectEvent(first.returnEvent.id);
  first.view.flush(); const beforeLibrary = first.storage.get('liniya.charts.v1');
  const second = harness(first.storage); t.after(() => second.transit.stop()); await second.view.restore();
  assert.equal(second.session.selectedId, source.id);
  assert.equal(second.returns.state.opened, true); assert.equal(second.returns.state.selectedEvent.id, first.returnEvent.id);
  assert.equal(second.view.pendingReturns, null);
  assert.equal(second.session.current.primary.id, source.id);
  assert.equal(chartCaption(second.session.current, second.session.original).title, source.name + ' · Возврат Сатурна 1');
  assert.equal(second.storage.get('liniya.charts.v1'), beforeLibrary);
  second.session.select('current-transit'); second.view.flush();
  assert.equal(second.session.current.primary.name, 'Транзит'); assert.equal(second.returns.current, null);
  assert.equal(JSON.parse(second.storage.get('liniya.view.v1')).returns, undefined);
});

test('navigation during a restored exact return cannot resurrect its personal overlay', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const source = JSON.parse(first.storage.get('liniya.charts.v1'))[0];
  first.session.select(source.id); await first.returns.open(); await first.returns.selectEvent(first.returnEvent.id); first.view.flush();
  let resolveChart, began;
  const started = new Promise(resolve => { began = resolve; });
  const second = harness(first.storage, { returnsClient: {
    events: async input => ({ events: input.body === 'saturn' ? [first.returnEvent] : [] }),
    chart: () => new Promise(resolve => { resolveChart = resolve; began(); }),
  } });
  t.after(() => second.transit.stop()); const restoring = second.view.restore(); await started;
  second.view.interrupt(); second.session.select('current-transit');
  resolveChart({ event: first.returnEvent, chart: { ...source, utc: first.returnEvent.utc } }); await restoring;
  assert.equal(second.session.selectedId, 'current-transit'); assert.equal(second.returns.current, null);
  assert.equal(second.session.current.primary.name, 'Транзит');
});


test('selected Saturn survives refresh after list changes to Year and the panel is closed', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const source = JSON.parse(first.storage.get('liniya.charts.v1'))[0];
  first.session.select(source.id); await first.returns.open(); await first.returns.selectEvent(first.returnEvent.id);
  // The displayed selection remains independent from the list's active filter.
  await first.returns.setYear(2050); first.returns.close(); first.view.flush();
  const second = harness(first.storage); t.after(() => second.transit.stop()); await second.view.restore();
  assert.equal(second.returns.state.year, 2050); assert.equal(second.returns.state.opened, false);
  assert.equal(second.returns.state.selectedEvent.id, first.returnEvent.id);
  assert.equal(second.session.current.secondary.utc, first.returnEvent.utc);
});

const returnMetadata = { ...metadata, startUtc: '2026-01-01T00:00:00Z', endExclusiveUtc: '2127-01-01T00:00:00Z',
  samples: (Date.parse('2127-01-01T00:00:00Z') - Date.parse('2026-01-01T00:00:00Z')) / 600000 };
const nextTurn = () => new Promise(setImmediate);
async function saveExactLifetime(t) {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const source = JSON.parse(first.storage.get('liniya.charts.v1'))[0];
  const event = { ...first.returnEvent, utc: '2055-10-01T12:03:07.123456Z', id: 'saturn:2055-10-01T12:03:07.123456Z' };
  Object.assign(first.returnEvent, event);
  first.session.select(source.id); await first.returns.open();
  assert.equal(await first.returns.selectEvent(event.id), true, 'save an event from the prepared authoritative list');
  await first.returns.setBodies(['moon']); first.returns.close(); first.view.flush();
  const snapshot = JSON.parse(first.storage.get('liniya.view.v1'));
  snapshot.lifetime = { opened: true, mode: 'lifetime', fromDate: source.utc.slice(0, 10), toDate: '2126-09-24',
    requestedUtc: Date.parse(event.utc), personalPreview: false, personalLive: false };
  first.storage.set('liniya.view.v1', JSON.stringify(snapshot));
  return { storage: first.storage, source, event, target: snapshot.lifetime };
}

test('exact reload waits only for its current body list before owning Lifetime without rounded point work', async t => {
  const { storage, source, event, target } = await saveExactLifetime(t), points = [], lists = [], order = [];
  const refreshed = { ...event, pass: 2, direction: 'retrograde' };
  t.after(() => lists.forEach(job => job.resolve({ events: job.input.body === event.body ? [refreshed] : [] })));
  let releaseChart, restored;
  const second = harness(storage, { canRestoreLifetime: () => true, lifetimeClient: {
    getMeta: async () => { order.push('metadata'); return returnMetadata; },
    getPoint: index => { points.push(index); return new Promise(() => {}); },
  }, returnsClient: {
    events: input => new Promise(resolve => { lists.push({ input, resolve }); }),
    chart: () => { order.push('chart'); return new Promise(resolve => { releaseChart = resolve; }); },
  } });
  t.after(() => second.transit.stop());
  const restoring = second.view.restore().then(value => { restored = value; return value; }); await nextTurn();
  assert.deepEqual(points, [], 'the saved event must load before any rounded lifetime work');
  assert.deepEqual(order, [], 'the current revision must verify the selected body first');
  assert.equal(lists.length, DEFAULT_CYCLE_BODIES.length + 1);
  lists.find(job => job.input.body === event.body).resolve({ events: [refreshed] }); await nextTurn();
  assert.deepEqual(order, ['chart']);
  second.interactionTarget.dispatch('wheel', { target: second.cameraSurface }); second.camera.zoom(2);
  const pose = second.camera.getView();
  releaseChart({ chart: { ...source, utc: event.utc } }); await nextTurn();
  assert.equal(restored, true, 'the other unfinished body lists cannot delay restoration');
  assert.equal(second.returns.state.selectedEvent, refreshed); assert.equal(await restoring, true);
  assert.deepEqual(order, ['chart', 'metadata']); assert.deepEqual(points, []);
  assert.equal(second.ensureLifetime().current.utc, event.utc); assert.equal(second.session.current.utc, event.utc);
  assert.equal(second.ensureLifetime().state.requestedUtc, target.requestedUtc); assert.equal(second.ensureLifetime().state.displayedUtc, Date.parse(event.utc));
  assert.equal(second.returns.state.opened, false); assert.deepEqual(second.returns.state.bodies, ['moon']);
  assert.equal(second.view.pendingReturns, null); assert.equal(second.view.pendingLifetime, null);
  assert.deepEqual(second.camera.getView(), pose);
  assert.equal(lists.length, DEFAULT_CYCLE_BODIES.length + 1, 'body preparation is shared with restoration and never duplicated');
  assert.deepEqual(second.returns.state.pendingBodies, ['moon'], 'the visible Moon list is still pending while the exact Saturn chart is ready');
});

test('navigation while a known return reloads prevents starting its saved Lifetime restoration', async t => {
  const { storage, source, event } = await saveExactLifetime(t); let releaseChart, metadataCalls = 0;
  const second = harness(storage, { canRestoreLifetime: () => true, lifetimeClient: {
    getMeta: async () => { metadataCalls++; return returnMetadata; }, getPoint: async index => point(index, returnMetadata),
  }, returnsClient: { events: async input => ({ events: input.body === event.body ? [event] : [] }),
    chart: () => new Promise(resolve => { releaseChart = resolve; }),
  } });
  t.after(() => second.transit.stop()); const restoring = second.view.restore(); await nextTurn();
  assert.equal(metadataCalls, 0); assert.equal(typeof releaseChart, 'function');
  second.view.interrupt(); second.session.select('second');
  releaseChart({ event, chart: { ...source, utc: event.utc } }); assert.equal(await restoring, false);
  assert.equal(metadataCalls, 0); assert.equal(second.returns.current, null);
  assert.equal(second.view.pendingLifetime, null); assert.equal(second.view.pendingReturns, null);
});

test('an early exact failure is not retried twice and metadata failure keeps its own pending target', async t => {
  for (const failure of ['chart', 'metadata']) {
    const { storage, source, event, target } = await saveExactLifetime(t), points = []; let charts = 0;
    const second = harness(storage, { canRestoreLifetime: () => true, lifetimeClient: {
      getMeta: async () => { if (failure === 'metadata') throw Error('Metadata unavailable'); return returnMetadata; },
      getPoint: async index => { points.push(index); return point(index, returnMetadata); },
    }, returnsClient: { events: async input => ({ events: input.body === event.body ? [event] : [] }), chart: async () => {
      charts++; if (failure === 'chart') throw Error('Exact unavailable'); return { event, chart: { ...source, utc: event.utc } };
    } } });
    t.after(() => second.transit.stop()); assert.equal(await second.view.restore(), false); assert.equal(charts, 1);
    if (failure === 'chart') {
      assert.equal(second.view.pendingReturns.eventId, event.id); assert.equal(second.view.pendingLifetime, null);
      assert.deepEqual(points, [], 'an unavailable exact event does not calculate a hidden rounded substitute');
      assert.equal(second.session.current.primary, second.session.original);
      assert.equal(second.session.current.utc, source.utc);
      assert.equal(second.exploration.momentState().current.utc, source.utc);
      assert.equal(second.returns.state.chartError, 'Exact unavailable');
      assert.equal(JSON.parse(storage.get('liniya.view.v1')).returns.eventId, event.id);
    } else {
      assert.equal(second.view.pendingLifetime.requestedUtc, target.requestedUtc); assert.equal(second.view.pendingReturns, null);
      assert.deepEqual(points, []); assert.equal(second.session.current.utc, event.utc);
    }
  }
});

test('legacy return IDs restore through event lookup while the original remains accepted', async t => {
  const { storage, source, event } = await saveExactLifetime(t), order = [];
  const snapshot = JSON.parse(storage.get('liniya.view.v1')); delete snapshot.returns.event;
  snapshot.returns = { ...snapshot.returns, group: 'major', year: 2055, body: 'saturn' }; delete snapshot.returns.bodies; storage.set('liniya.view.v1', JSON.stringify(snapshot));
  const second = harness(storage, { canRestoreLifetime: () => true, lifetimeClient: {
    getMeta: async () => returnMetadata, getPoint: async index => { order.push('point'); return point(index, returnMetadata); },
  }, returnsClient: { events: async input => ({ events: input.body === event.body ? [event] : [] }),
    chart: async () => { order.push('chart'); return { event, chart: { ...source, utc: event.utc } }; },
  } });
  t.after(() => second.transit.stop()); assert.equal(await second.view.restore(), true);
  assert.deepEqual(order, ['chart']); assert.equal(second.session.current.utc, event.utc);
});


async function saveColdReturns(t) {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const source = JSON.parse(first.storage.get('liniya.charts.v1'))[0];
  first.session.select(source.id); await first.natalDay.open();
  // Older snapshots can contain a drawer before its lazy rail was created.
  first.natalDay.close(); await first.returns.open();
  first.eventTarget.dispatch('pagehide');
  const snapshot = JSON.parse(first.storage.get('liniya.view.v1'));
  assert.equal(snapshot.returns.opened, true);
  assert.equal(snapshot.lifetime, null);
  assert.equal(snapshot.natalDay.opened, false);
  return first.storage;
}

test('reload during a cold Returns opening restores its rail even before a Lifetime snapshot exists', async t => {
  const storage = await saveColdReturns(t);
  const second = harness(storage, { canRestoreLifetime: () => true,
    openReturnsTimeline: async () => second.ensureLifetime().restore({ opened: true, mode: 'lifetime',
      fromDate: '2020-01-01', toDate: '2020-01-03', index: 144 }) });
  t.after(() => second.transit.stop());
  assert.equal(await second.view.restore(), true);
  assert.equal(second.returns.state.opened, true);
  assert.equal(second.natalDay.state.opened, false);
  assert.equal(second.ensureLifetime().state.opened, true);
  assert.equal(second.ensureLifetime().state.mode, 'lifetime');
  assert.equal(JSON.parse(storage.get('liniya.view.v1')).lifetime.opened, true);
});


test('an open Returns menu owns restoration ahead of a stale natal Day snapshot', async t => {
  const storage = await saveColdReturns(t);
  const snapshot = JSON.parse(storage.get('liniya.view.v1'));
  snapshot.natalDay.opened = true;
  storage.set('liniya.view.v1', JSON.stringify(snapshot));
  const second = harness(storage, { canRestoreLifetime: () => true,
    openReturnsTimeline: async () => {
      if (second.natalDay.state.opened) return false;
      return second.ensureLifetime().restore({ opened: true, mode: 'lifetime',
        fromDate: '2020-01-01', toDate: '2020-01-03', index: 144 });
    } });
  t.after(() => second.transit.stop());
  assert.equal(await second.view.restore(), true);
  assert.equal(second.natalDay.state.opened, false);
  assert.equal(second.ensureLifetime().state.opened, true);
  assert.equal(second.returns.state.opened, true);
});


test('a selected return with its phone menu closed restores a missing cold rail', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  first.session.select(JSON.parse(first.storage.get('liniya.charts.v1'))[0].id);
  await first.returns.open(); await first.returns.selectEvent(first.returnEvent.id);
  first.returns.close(); first.view.flush();
  const second = harness(first.storage, { canRestoreLifetime: () => true,
    openReturnsTimeline: async () => second.ensureLifetime().restore({ opened: true, mode: 'lifetime',
      fromDate: '2020-01-01', toDate: '2020-01-03', index: 144 }) });
  t.after(() => second.transit.stop());
  assert.equal(await second.view.restore(), true);
  assert.equal(second.returns.state.opened, false);
  assert.equal(second.returns.state.selectedEvent.id, first.returnEvent.id);
  assert.equal(second.ensureLifetime().state.opened, true);
  assert.equal(second.ensureLifetime().state.mode, 'lifetime');
  assert.equal(second.view.pendingReturns, null);
});

test('a failed cold rail leaves the Returns target pending for another reload', async t => {
  const storage = await saveColdReturns(t);
  const second = harness(storage, { canRestoreLifetime: () => true, openReturnsTimeline: async () => null });
  t.after(() => second.transit.stop());
  assert.equal(await second.view.restore(), false);
  assert.equal(second.returns.state.opened, true);
  assert.equal(second.view.pendingReturns.opened, true);
  const persisted = JSON.parse(storage.get('liniya.view.v1'));
  assert.equal(persisted.returns.opened, true);
  assert.equal(persisted.lifetime, null);
});

test('camera gestures during personal Lifetime loading preserve the lifetime target and the new camera position', async t => {
  const { storage } = await savePersonalLifetime(t);
  let releaseMetadata;
  const second = harness(storage, { canRestoreLifetime: () => true, lifetimeClient: {
    getMeta: () => new Promise(resolve => { releaseMetadata = resolve; }), getPoint: async index => point(index),
  } });
  t.after(() => second.transit.stop());
  const restoring = second.view.restore();
  await new Promise(resolve => setImmediate(resolve));
  second.interactionTarget.dispatch('pointerdown', { target: second.cameraSurface });
  second.camera.zoom(2); second.camera.pan(30, 20);
  const pose = second.camera.getView();
  releaseMetadata(metadata);
  assert.equal(await restoring, true);
  assert.equal(second.view.interrupted, false);
  assert.equal(second.ensureLifetime().state.requestedUtc, Date.parse('2020-01-02T09:20:00Z'));
  assert.equal(second.session.current.utc, '2020-01-02T09:20:00Z');
  assert.equal(second.session.current.kind, 'transit');
  assert.deepEqual(second.camera.getView(), pose);
  const persisted = JSON.parse(storage.get('liniya.view.v1'));
  assert.equal(persisted.lifetime.requestedUtc, Date.parse('2020-01-02T09:20:00Z'));
  assert.equal(persisted.camera.k, 2);
});

test('wheel zoom during an exact return restoration keeps that event and the new camera position', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const source = JSON.parse(first.storage.get('liniya.charts.v1'))[0];
  first.session.select(source.id); await first.returns.open();
  await first.returns.selectEvent(first.returnEvent.id); first.view.flush();
  let resolveChart, began;
  const started = new Promise(resolve => { began = resolve; });
  const second = harness(first.storage, { returnsClient: {
    events: async input => ({ events: input.body === 'saturn' ? [first.returnEvent] : [] }),
    chart: () => new Promise(resolve => { resolveChart = resolve; began(); }),
  } });
  t.after(() => second.transit.stop()); const restoring = second.view.restore(); await started;
  second.interactionTarget.dispatch('wheel', { target: second.cameraSurface }); second.camera.zoom(2);
  const pose = second.camera.getView();
  resolveChart({ event: first.returnEvent, chart: { ...source, utc: first.returnEvent.utc } });
  assert.equal(await restoring, true);
  assert.equal(second.view.interrupted, false);
  assert.equal(second.returns.state.selectedEvent.id, first.returnEvent.id);
  assert.equal(second.session.current.utc, '2055-10-01T12:00:00Z');
  assert.deepEqual(second.camera.getView(), pose);
});

test('a new lifetime scrub still supersedes a pending restored point', async t => {
  const { storage } = await savePersonalLifetime(t);
  let releasePoint;
  const second = harness(storage, { canRestoreLifetime: () => true, lifetimeClient: {
    getMeta: async () => metadata,
    getPoint: index => index === 200 ? new Promise(resolve => { releasePoint = resolve; }) : Promise.resolve(point(index)),
  } });
  t.after(() => second.transit.stop()); const restoring = second.view.restore();
  await new Promise(resolve => setImmediate(resolve));
  second.view.interrupt();
  await second.ensureLifetime().scrub(Date.parse('2020-01-02T09:30:00Z')); releasePoint(point(200));
  assert.equal(await restoring, false);
  assert.equal(second.view.interrupted, true);
  assert.equal(second.ensureLifetime().state.requestedUtc, Date.parse('2020-01-02T09:30:00Z'));
  assert.equal(second.session.current.utc, '2020-01-02T09:30:00Z');
});

test('restored personal live mode uses the shared minute timer and the new current minute', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { storage } = await savePersonalLifetime(t);
  const saved = JSON.parse(storage.get('liniya.view.v1'));
  saved.lifetime.personalLive = true;
  saved.transit.live = false; saved.transit.index = 0;
  storage.set('liniya.view.v1', JSON.stringify(saved));
  let now = Date.parse('2026-10-04T12:07:00Z');
  const second = harness(storage, { canRestoreLifetime: () => true, getNow: () => now });
  t.after(() => second.transit.stop());
  await second.view.restore();
  assert.equal(second.transit.state.wanted, true);
  assert.equal(second.session.current.secondary.utc, '2026-10-04T12:07:00Z');
  const current = second.session.current;
  assert.equal(second.session.current, current, 'reading the same minute reuses the composed overlay');
  now += 60000; t.mock.timers.tick(60025);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.session.current.secondary.utc, '2026-10-04T12:08:00Z');
  assert.notEqual(second.session.current, current);
  second.view.flush();
  assert.equal(JSON.parse(storage.get('liniya.view.v1')).lifetime.personalLive, true);
  assert.equal(JSON.parse(storage.get('liniya.view.v1')).transit.live, true, 'following Now supersedes an older paused day');
});

test('a paused personal lifetime reload never becomes live because its slider is near Now', async t => {
  const { storage } = await savePersonalLifetime(t);
  const saved = JSON.parse(storage.get('liniya.view.v1'));
  saved.lifetime.personalLive = false;
  storage.set('liniya.view.v1', JSON.stringify(saved));
  const second = harness(storage, { canRestoreLifetime: () => true });
  t.after(() => second.transit.stop()); await second.view.restore();
  assert.equal(second.transit.state.wanted, false);
  assert.equal(second.session.current.utc, '2020-01-02T09:20:00Z');
  second.view.flush();
  assert.equal(JSON.parse(storage.get('liniya.view.v1')).lifetime.personalLive, false);
});

const drain = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };

test('reload paints the paused minute first while the unrelated local-day packet is pending', async t => {
  const first = harness(undefined, { zone: 'Europe/Moscow' }); t.after(() => first.transit.stop());
  await first.view.restore(); first.transit.scrub(0); first.view.flush();
  let release; const requested = [];
  const second = harness(first.storage, { zone: 'Europe/Moscow', transitDay: date => {
    requested.push(date);
    return date === '2026-10-04' ? new Promise(resolve => { release = resolve; }) : Promise.resolve(day(date));
  } });
  t.after(() => second.transit.stop());
  const restoring = second.view.restore(); await drain();
  assert.deepEqual(requested, ['2026-10-03', '2026-10-04'], 'the target packet has priority');
  assert.deepEqual(second.frames, ['2026-10-03T21:00:00Z']);
  assert.equal(second.transit.state.live, false);
  release(day('2026-10-04')); await restoring;
  assert.deepEqual(second.frames, ['2026-10-03T21:00:00Z'], 'neighbor completion never flashes Now');
});

test('lifetime reload requests only its saved point and switching back to Day starts the minute clock', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const lifetime = first.ensureLifetime(); await lifetime.open(); await lifetime.setDateRange('2020-01-01', '2020-01-03');
  await lifetime.scrub(Date.parse('2020-01-02T09:20:00Z')); first.view.flush();
  const requests = [], modes = [];
  const second = harness(first.storage, { transitDay: async date => { requests.push(date); return day(date); },
    lifetimeClient: { getMeta: async () => { modes.push(second.ensureLifetime().state.mode); return metadata; }, getPoint: async index => point(index) } });
  t.after(() => second.transit.stop());
  await second.view.restore();
  assert.deepEqual(requests, []);
  assert.deepEqual(modes, ['lifetime']);
  assert.deepEqual(second.frames, ['2020-01-02T09:20:00Z']);
  second.ensureLifetime().close(); await drain();
  assert.deepEqual(requests, ['2026-10-04']);
  assert.equal(second.transit.state.live, true);
  assert.equal(second.session.current.utc, '2026-10-04T12:00:00Z');
});

test('a ready personal lifetime appears before its unrelated return list finishes', async t => {
  const { storage } = await savePersonalLifetime(t);
  const snapshot = JSON.parse(storage.get('liniya.view.v1'));
  snapshot.lifetime.personalPreview = true; snapshot.lifetime.personalLive = false;
  snapshot.returns = { opened: true, group: 'major', year: 2026, body: 'saturn', eventId: null };
  storage.set('liniya.view.v1', JSON.stringify(snapshot));
  const pendingLists = [];
  const second = harness(storage, { canRestoreLifetime: () => true,
    returnsClient: { events: () => new Promise(resolve => pendingLists.push(resolve)) } });
  t.after(() => second.transit.stop());
  let finished = false; const restoring = second.view.restore().then(() => { finished = true; }); await drain();
  assert.equal(second.ensureLifetime().state.status, 'ready');
  assert.equal(finished, false);
  assert.equal(second.session.current.utc, '2020-01-02T09:20:00Z');
  for (let i = 0; i < 10 && !finished; i++) { pendingLists.splice(0).forEach(resolve => resolve({ events: [] })); await drain(); }
  await restoring;
});

test('keyboard activity without a moment command preserves restoration', async t => {
  const { storage } = await savePersonalLifetime(t);
  for (const key of ['Tab', 'Shift', 'Alt', 'Control', 'Meta', 'Escape', 'Enter', 'ArrowRight']) {
    let release;
    const second = harness(new Map(storage), { canRestoreLifetime: () => true,
      loadLifetime: () => new Promise(resolve => { release = () => resolve(second.ensureLifetime()); }) });
    t.after(() => second.transit.stop());
    const restoring = second.view.restore(); await drain();
    second.interactionTarget.dispatch('keydown', { key, target: { id: 'chartTitle' } });
    assert.equal(second.view.interrupted, false, key);
    release(); await restoring;
    assert.equal(second.session.current.utc, '2020-01-02T09:20:00Z');
  }
});

test('an inactive saved Day pause does not hold lifetime restoration pending', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  first.transit.scrub(0);
  const lifetime = first.ensureLifetime(); await lifetime.open(); await lifetime.setDateRange('2020-01-01', '2020-01-03');
  await lifetime.scrub(Date.parse('2020-01-02T09:20:00Z')); first.view.flush();
  let dayRequests = 0;
  const second = harness(first.storage, { transitDay: async date => { dayRequests++; return day(date); } });
  t.after(() => second.transit.stop());
  assert.equal(await second.view.restore(), true);
  assert.equal(dayRequests, 0);
  assert.equal(second.session.current.utc, '2020-01-02T09:20:00Z');
  assert.equal(JSON.parse(second.storage.get('liniya.view.v1')).transit.live, false);
  assert.equal(JSON.parse(second.storage.get('liniya.view.v1')).transit.index, 0);
});


test('a legacy lifetime index becomes UTC after metadata loads and never returns to new snapshots', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const saved = JSON.parse(first.storage.get('liniya.view.v1'));
  saved.lifetime = { opened: true, mode: 'lifetime', fromDate: '2020-01-01', toDate: '2020-01-03', index: 200 };
  first.storage.set('liniya.view.v1', JSON.stringify(saved));
  const second = harness(first.storage); t.after(() => second.transit.stop());
  assert.equal(await second.view.restore(), true);
  assert.equal(second.session.current.utc, '2020-01-02T09:20:00Z');
  const persisted = JSON.parse(first.storage.get('liniya.view.v1')).lifetime;
  assert.equal(persisted.requestedUtc, Date.parse('2020-01-02T09:20:00Z'));
  assert.equal('index' in persisted, false);
});


test('a saved lifetime minute restores its exact UTC before writing a fresh snapshot', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const saved = JSON.parse(first.storage.get('liniya.view.v1'));
  saved.lifetime = { opened: true, mode: 'lifetime', fromDate: '2020-01-01', toDate: '2020-01-03',
    requestedUtc: Date.parse('2020-01-02T09:21:00Z') };
  first.storage.set('liniya.view.v1', JSON.stringify(saved));
  const minutes = [], points = [];
  const second = harness(first.storage, { lifetimeClient: { getMeta: async () => metadata,
    getPoint: async index => { points.push(index); return point(index); },
    getMinute: async utc => { minutes.push(utc); return transitChartAt(day('2020-01-02'), 561); },
  } });
  t.after(() => second.transit.stop());
  assert.equal(await second.view.restore(), true);
  assert.deepEqual(minutes, [Date.parse('2020-01-02T09:21:00Z')]); assert.deepEqual(points, []);
  assert.equal(second.session.current.utc, '2020-01-02T09:21:00Z');
  const persisted = JSON.parse(first.storage.get('liniya.view.v1')).lifetime;
  assert.equal(persisted.requestedUtc, Date.parse('2020-01-02T09:21:00Z')); assert.equal('index' in persisted, false);
});


for (const personalPreview of [undefined, true]) test(`metadata retry consumes the legacy birth target for ${personalPreview ? 'an explicit lifetime sample' : 'the exact original'}`, async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const charts = JSON.parse(first.storage.get('liniya.charts.v1'));
  charts[0].utc = '2026-09-24T12:34:56.789Z';
  first.storage.set('liniya.charts.v1', JSON.stringify(charts));
  const saved = JSON.parse(first.storage.get('liniya.view.v1'));
  saved.selectedId = charts[0].id;
  saved.lifetime = { opened: true, mode: 'lifetime', fromDate: '2026-09-24', toDate: '2026-09-26', index: 75,
    personalLive: false, ...(personalPreview === undefined ? {} : { personalPreview }) };
  first.storage.set('liniya.view.v1', JSON.stringify(saved));
  const source = { ...metadata, startUtc: '2026-09-24T00:00:00Z', endExclusiveUtc: '2026-09-27T00:00:00Z' };
  let unavailable = true; const points = [];
  const second = harness(first.storage, { canRestoreLifetime: () => true,
    normalizeSavedView: view => ({ ...view, lifetime: { ...view.lifetime, minimumUtc: charts[0].utc } }),
    lifetimeClient: { getMeta: async () => { if (unavailable) throw Error('Metadata unavailable'); return source; },
      getPoint: async index => { points.push(index); return point(index, source); } },
  });
  t.after(() => second.transit.stop());
  assert.equal(await second.view.restore(), false);
  assert.equal(second.ensureLifetime().state.status, 'loading');
  assert.equal(second.ensureLifetime().state.retryCount, 1);
  assert.equal(second.view.pendingLifetime.index, 75);
  assert.equal(JSON.parse(first.storage.get('liniya.view.v1')).lifetime.index, 75, 'failed metadata cannot invent a UTC origin');
  unavailable = false;
  assert.equal(await second.ensureLifetime().retry(), true);
  const utc = personalPreview ? '2026-09-24T12:40:00Z' : '2026-09-24T12:34:56.789Z';
  assert.equal(second.ensureLifetime().state.status, 'ready');
  assert.equal(second.ensureLifetime().state.requestedUtc, Date.parse(utc));
  assert.equal(second.session.current.utc, utc);
  assert.equal(second.session.owner, personalPreview ? 'lifetime' : 'original');
  assert.deepEqual(points, personalPreview ? [76] : []);
  assert.equal(second.view.pendingLifetime, null, 'the accepted core result consumes the pre-birth legacy target');
  second.view.flush();
  const persisted = JSON.parse(first.storage.get('liniya.view.v1')).lifetime;
  assert.equal(persisted.requestedUtc, Date.parse(utc)); assert.equal('index' in persisted, false);
  assert.equal(persisted.personalPreview, Boolean(personalPreview));
});


test('a ready matching range cannot consume a saved target before the loader returns its controller', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const lifetime = first.ensureLifetime(); await lifetime.open(); await lifetime.setDateRange('2020-01-01', '2020-01-03');
  await lifetime.scrub(Date.parse('2020-01-02T09:20:00Z')); first.view.flush();
  let second;
  second = harness(first.storage, { loadLifetime: async () => {
    const available = second.ensureLifetime();
    await available.open(); await available.setDateRange('2020-01-01', '2020-01-03');
    await available.scrub(Date.parse('2020-01-02T08:00:00Z'));
    return null;
  } });
  t.after(() => second.transit.stop());
  assert.equal(await second.view.restore(), false);
  assert.equal(second.ensureLifetime().state.status, 'ready');
  assert.equal(second.view.pendingLifetime.requestedUtc, Date.parse('2020-01-02T09:20:00Z'));
  assert.equal(JSON.parse(first.storage.get('liniya.view.v1')).lifetime.requestedUtc, Date.parse('2020-01-02T09:20:00Z'));
});


for (const activation of ['pointerdown', 'Enter', ' ']) test(`Retry by ${activation === ' ' ? 'Space' : activation} retains a legacy target while metadata is pending and the page hides`, async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const saved = JSON.parse(first.storage.get('liniya.view.v1'));
  saved.lifetime = { opened: true, mode: 'lifetime', fromDate: '2020-01-01', toDate: '2020-01-03', index: 200 };
  first.storage.set('liniya.view.v1', JSON.stringify(saved));
  const document = dateDom(), retryButton = document.createElement('button'), retryIcon = document.createElement('svg');
  retryButton.append(retryIcon);
  let attempts = 0, release; const points = [];
  const second = harness(first.storage, { lifetimeClient: {
    getMeta: () => ++attempts === 1 ? Promise.reject(Error('Offline')) : new Promise(resolve => { release = resolve; }),
    getPoint: async index => { points.push(index); return point(index); },
  } });
  t.after(() => second.transit.stop());
  retryButton.addEventListener('click', () => second.ensureLifetime().retry());
  assert.equal(await second.view.restore(), false);
  const pointer = activation === 'pointerdown';
  second.interactionTarget.dispatch(pointer ? 'pointerdown' : 'keydown', { target: pointer ? retryIcon : retryButton, key: pointer ? undefined : activation });
  const retry = retryButton.dispatch('click'); await nextTurn();
  assert.equal(typeof release, 'function');
  second.eventTarget.dispatch('pagehide');
  const waiting = JSON.parse(first.storage.get('liniya.view.v1')).lifetime;
  assert.ok(waiting, 'Retry is not a new moment choice and cannot erase the legacy target');
  assert.equal(waiting.index, 200); assert.equal(second.view.pendingLifetime.index, 200);
  assert.equal(second.view.interrupted, false);
  release(metadata); assert.equal(await retry, true); second.view.flush();
  assert.deepEqual(points, [200]); assert.equal(second.session.current.utc, '2020-01-02T09:20:00Z');
  assert.equal(second.view.pendingLifetime, null);
  const ready = JSON.parse(first.storage.get('liniya.view.v1')).lifetime;
  assert.equal(ready.requestedUtc, Date.parse('2020-01-02T09:20:00Z')); assert.equal('index' in ready, false);
});

test('choosing another person during a retried metadata request still supersedes the saved target', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const saved = JSON.parse(first.storage.get('liniya.view.v1'));
  saved.lifetime = { opened: true, mode: 'lifetime', fromDate: '2020-01-01', toDate: '2020-01-03', index: 200 };
  first.storage.set('liniya.view.v1', JSON.stringify(saved));
  const document = dateDom(), retryButton = document.createElement('button');
  let attempts = 0, release; const points = [];
  const second = harness(first.storage, { lifetimeClient: {
    getMeta: () => ++attempts === 1 ? Promise.reject(Error('Offline')) : new Promise(resolve => { release = resolve; }),
    getPoint: async index => { points.push(index); return point(index); },
  } });
  t.after(() => second.transit.stop());
  retryButton.addEventListener('click', () => second.ensureLifetime().retry());
  assert.equal(await second.view.restore(), false);
  second.interactionTarget.dispatch('pointerdown', { target: retryButton });
  const retry = retryButton.dispatch('click'); await nextTurn();
  second.view.interrupt();
  second.session.select('second'); second.eventTarget.dispatch('pagehide');
  assert.equal(second.view.pendingLifetime, null);
  const selected = second.session.current;
  assert.equal(JSON.parse(first.storage.get('liniya.view.v1')).lifetime, null);
  release(metadata); assert.equal(await retry, false); second.view.flush();
  assert.equal(second.session.selectedId, 'second'); assert.equal(second.session.current, selected);
  assert.deepEqual(points, []); assert.equal(JSON.parse(first.storage.get('liniya.view.v1')).lifetime, null);
});

for (const phase of ['import', 'metadata']) for (const [id, activation] of [
  ['openLibrary', 'pointerdown'], ['openKnowledge', 'Enter'], ['togglePerformance', ' '],
  ['chartTitle', 'pointerdown'], ['topbar-empty-space', 'pointerdown'],
]) test(`passive ${id} activation during lifetime ${phase} preserves the saved UTC through pagehide`, async t => {
  const target = Date.parse('2020-01-02T09:20:00Z');
  const saved = { version: 1, selectedId: 'current-transit', mandala: false,
    lifetime: { opened: true, mode: 'lifetime', fromDate: '2020-01-01', toDate: '2020-01-03', requestedUtc: target } };
  const storage = new Map([['liniya.view.v1', JSON.stringify(saved)]]);
  const document = dateDom(), control = document.createElement('button'), icon = document.createElement('svg');
  control.id = id; control.append(icon);
  let release, dayRequests = 0; const points = [];
  const h = harness(storage, {
    transitDay: async date => { dayRequests++; return day(date); },
    ...(phase === 'import' ? { loadLifetime: () => new Promise(resolve => { release = () => resolve(h.ensureLifetime()); }) } : {}),
    lifetimeClient: {
      getMeta: () => phase === 'metadata' ? new Promise(resolve => { release = () => resolve(metadata); }) : Promise.resolve(metadata),
      getPoint: async index => { points.push(index); return point(index); },
    },
  });
  t.after(() => h.transit.stop());
  const restoring = h.view.restore(); await nextTurn();
  assert.equal(typeof release, 'function'); assert.equal(h.session.owner, 'lifetime');
  const pointer = activation === 'pointerdown';
  h.interactionTarget.dispatch(pointer ? 'pointerdown' : 'keydown', { target: pointer ? icon : control, key: pointer ? undefined : activation });
  h.tick(); h.eventTarget.dispatch('pagehide');
  const waiting = JSON.parse(storage.get('liniya.view.v1')).lifetime;
  release();
  assert.equal(await restoring, true, 'opening an auxiliary tool cannot abandon the lifetime owner without a chart');
  assert.equal(h.view.interrupted, false); assert.equal(waiting?.requestedUtc, target);
  assert.equal(h.session.hasCurrent, true); assert.equal(h.session.current.utc, '2020-01-02T09:20:00Z');
  assert.equal(h.ensureLifetime().state.opened, true); assert.equal(h.view.pendingLifetime, null);
  assert.equal(h.transit.state.wanted, false); assert.equal(dayRequests, 0); assert.deepEqual(points, [200]);
  h.view.flush(); assert.equal(JSON.parse(storage.get('liniya.view.v1')).lifetime.requestedUtc, target);
});

for (const action of ['choose-chart', 'lifetime-off']) test(`passive tools do not exempt ${action} from superseding lifetime restoration`, async t => {
  const storage = new Map([['liniya.view.v1', JSON.stringify({ version: 1, selectedId: 'current-transit',
    lifetime: { opened: true, mode: 'lifetime', fromDate: '2020-01-01', toDate: '2020-01-03', requestedUtc: Date.parse('2020-01-02T09:20:00Z') } })]]);
  const document = dateDom(), passive = document.createElement('button'), choice = document.createElement('button');
  passive.id = 'openLibrary'; choice.id = action === 'lifetime-off' ? 'lifetimeToggle' : '';
  if (action === 'choose-chart') choice.dataset.chartId = 'second';
  let release; const points = [];
  const h = harness(storage, {
    ...(action === 'choose-chart' ? { loadLifetime: () => new Promise(resolve => { release = () => resolve(h.ensureLifetime()); }) } : {}),
    lifetimeClient: { getMeta: () => action === 'lifetime-off' ? new Promise(resolve => { release = () => resolve(metadata); }) : Promise.resolve(metadata),
      getPoint: async index => { points.push(index); return point(index); } },
  });
  t.after(() => h.transit.stop());
  const restoring = h.view.restore(); await nextTurn();
  h.interactionTarget.dispatch('pointerdown', { target: passive });
  h.interactionTarget.dispatch('pointerdown', { target: choice });
  h.view.interrupt();
  if (action === 'choose-chart') await h.exploration.select('second');
  else await h.exploration.toggleTransit();
  release(); assert.equal(await restoring, false); await nextTurn();
  assert.equal(h.view.interrupted, true); assert.equal(h.view.pendingLifetime, null);
  assert.equal(h.ensureLifetime().state.opened, false); assert.deepEqual(points, []);
  assert.equal(h.session.selectedId, action === 'choose-chart' ? 'second' : 'current-transit');
  assert.equal(h.session.hasCurrent, true);
  assert.equal(h.transit.state.wanted, action === 'lifetime-off');
  h.view.flush(); assert.equal(JSON.parse(storage.get('liniya.view.v1')).lifetime, null);
});

test('closed return filters survive a reload of the personal rail without an exact event', async t => {
  const first = harness(new Map(), { canRestoreLifetime: () => true, lifetimeClient: {
    getMeta: async () => returnMetadata, getPoint: async index => point(index, returnMetadata),
  } });
  t.after(() => first.transit.stop()); await first.view.restore();
  const source = JSON.parse(first.storage.get('liniya.charts.v1'))[0]; first.session.select(source.id);
  await first.exploration.openTimeline(); await first.returns.setBodies([]); await first.returns.setYear(2050);
  first.returns.close(); first.view.flush();
  const saved = JSON.parse(first.storage.get('liniya.view.v1'));
  assert.deepEqual(saved.returns, { opened: false, bodies: [], year: 2050, eventId: null });
  const calls = [];
  const second = harness(first.storage, { canRestoreLifetime: () => true, lifetimeClient: {
    getMeta: async () => returnMetadata, getPoint: async index => point(index, returnMetadata),
  }, loadLifetime: async () => { void second.returns.enableMarkers(true); return second.ensureLifetime(); },
  returnsClient: { events: async input => { calls.push(input); return { events: [] }; } } });
  t.after(() => second.transit.stop()); await second.view.restore();
  assert.deepEqual(second.returns.state.bodies, []); assert.equal(second.returns.state.year, 2050);
  assert.equal(second.returns.state.opened, false); assert.equal(second.returns.state.selectedEvent, null);
  assert.equal(calls.length, DEFAULT_CYCLE_BODIES.length, 'selecting a natal prepares default bodies once even when every visible filter is off');
  assert.deepEqual(new Set(calls.map(input => input.body)), new Set(DEFAULT_CYCLE_BODIES));
});

test('changing filters during exact reload keeps the chart request and saves the latest filters', async t => {
  const { storage, source, event } = await saveExactLifetime(t);
  let releaseChart, chartSignal;
  const second = harness(storage, { canRestoreLifetime: () => true, lifetimeClient: {
    getMeta: async () => returnMetadata, getPoint: async () => assert.fail('exact reload must not load a sampled point'),
  }, returnsClient: {
    events: async input => ({ events: input.body === event.body ? [event] : [] }),
    chart: (input, signal) => { chartSignal = signal; return new Promise(resolve => { releaseChart = resolve; }); },
  } });
  t.after(() => second.transit.stop()); const restoring = second.view.restore(); await nextTurn();
  await second.returns.setBodies([]); await second.returns.setYear(2060);
  assert.equal(chartSignal.aborted, false);
  releaseChart({ event, chart: { ...source, utc: event.utc } }); assert.equal(await restoring, true);
  assert.equal(second.session.current.utc, event.utc); assert.equal(second.returns.state.selectedEvent.id, event.id);
  second.view.flush(); const saved = JSON.parse(storage.get('liniya.view.v1')).returns;
  assert.deepEqual(saved.bodies, []); assert.equal(saved.year, 2060); assert.equal(saved.eventId, event.id);
});
