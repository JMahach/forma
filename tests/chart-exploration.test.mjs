import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartSession } from '../src/state/chart-session.js';
import { createViewSession } from '../src/state/view-session.js';
import { createLifetimeExplorer } from '../src/state/lifetime.js';
import { LIFETIME_PLANETS } from '../shared/lifetime-format.js';
import { createChartExploration } from '../src/state/chart-exploration.js';
import { createReturnsController } from '../src/state/returns.js';
import { chartAtMinute } from '../src/domain/natal-day.js';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const event = { id: 'saturn:2050-01-01T12:00:00Z', body: 'saturn', utc: '2050-01-01T12:00:00Z', cycle: 1 };
const moment = utc => ({ id: `moment:${utc}`, utc, source: 'transit', personality: [4], design: [63] });
function harness() {
  const natal = chartAtMinute(natalDayFixture(), 754, personalChartFixture());
  const second = { ...natal, id: 'second', name: 'Вторая карта' };
  let returns, exploration;
  const jobs = [];
  const session = createChartSession({ store: { get: id => [natal, second].find(chart => chart.id === id), has: id => [natal.id, second.id].includes(id) },
    getReturns: () => returns });
  const transit = { state: { wanted: false }, setWanted(value) { this.state.wanted = value; } };
  exploration = createChartExploration({ session, getTransit: () => transit, getReturns: () => returns,
    getLifetime: () => null, getNatalDay: () => ({ state: { opened: false } }), loadLifetime: async () => null });
  returns = createReturnsController({ client: {
    events: async input => ({ events: input.body === event.body ? [event] : [] }),
    chart: () => new Promise(resolve => jobs.push(resolve)),
  }, onRequest: exploration.requestReturn, onRender: exploration.publishReturn });
  session.select(natal.id);
  return { session, returns, exploration, jobs, natal, second };
}

test('pending and canceled exact selection keeps the rail clock on the accepted lifetime result', async () => {
  const h = harness();
  const lifetime = moment('2040-01-01T01:20:00Z');
  h.session.publish(h.session.expect('lifetime'), lifetime);
  await h.returns.open();
  const pending = h.returns.selectEvent(event.id);
  await tick();
  assert.equal(h.exploration.momentState()?.current, lifetime);
  h.returns.close();
  assert.equal(h.exploration.momentState()?.current, lifetime);
  h.jobs[0]({ chart: moment(event.utc), event });
  assert.equal(await pending, false);
  assert.equal(h.session.current.secondary, lifetime);
});

test('late exact data from the previous person is rejected even after the same result kind is requested again', async () => {
  const h = harness();
  await h.returns.open();
  const first = h.returns.selectEvent(event.id); await tick();
  h.session.select(h.second.id);
  await h.returns.open();
  const latest = h.returns.selectEvent(event.id); await tick();
  const accepted = moment(event.utc);
  h.jobs[1]({ chart: accepted, event }); await latest;
  const shown = h.session.current;
  h.jobs[0]({ chart: moment(event.utc), event });
  assert.equal(await first, false);
  assert.equal(h.session.current, shown);
  assert.equal(shown.primary, h.second);
  assert.equal(shown.secondary, accepted);
});

test('covered global Day keeps its minute owner active and lifetime explicitly suspends that owner', () => {
  let wanted = true;
  const transit = { current: moment('2026-10-05T12:00:00Z'), get state() { return { wanted }; }, setWanted(value) { wanted = value; } };
  const session = createChartSession({ store: { get: () => null, has: () => false } });
  const exploration = createChartExploration({ session, getTransit: () => transit,
    getReturns: () => null, getLifetime: () => null, getNatalDay: () => null });
  exploration.acceptLifetimeMode({ opened: true, mode: 'day' });
  assert.equal(wanted, true);
  assert.equal(session.current.primary, transit.current);
  exploration.acceptLifetimeMode({ opened: true, mode: 'lifetime' });
  assert.equal(wanted, false);
  assert.equal(session.owner, 'lifetime');
  exploration.acceptLifetimeMode({ opened: false, mode: 'lifetime' });
  assert.equal(wanted, true);
  assert.equal(session.owner, 'transit');
});


test('an initial closed lazy rail notification cannot override a pending lifetime restoration', () => {
  let wanted = false;
  const session = createChartSession({ store: { get: () => null, has: () => false } });
  session.expect('lifetime');
  const exploration = createChartExploration({ session, getTransit: () => ({ state: { wanted }, setWanted(value) { wanted = value; } }),
    getReturns: () => null, getLifetime: () => null, getNatalDay: () => null });
  exploration.lifetimeChanged({ opened: false, mode: 'day' });
  assert.equal(session.owner, 'lifetime');
  assert.equal(wanted, false);
});

test('ordinary rail notifications never choose a different source of the visible chart', () => {
  let wanted = false;
  const transit = { current: moment('2026-10-05T12:00:00Z'), get state() { return { wanted }; }, setWanted(value) { wanted = value; } };
  const session = createChartSession({ store: { get: () => null, has: () => false } });
  session.expect('lifetime');
  const exploration = createChartExploration({ session, getTransit: () => transit,
    getReturns: () => null, getLifetime: () => null, getNatalDay: () => null });
  const shown = session.current;
  exploration.lifetimeChanged({ opened: true, mode: 'day' });
  assert.equal(session.owner, 'lifetime');
  assert.equal(wanted, false);
  assert.equal(session.current, shown);
});

test('turning off a still-loading global rail retains the already accepted transit', async () => {
  const session = createChartSession({ store: { get: () => null, has: () => false } });
  const transit = moment('2026-10-05T12:00:00Z'); session.publish('transit', transit);
  const shown = session.current;
  let resolve;
  const scales = createChartExploration({ session, getLifetime: () => null, getReturns: () => null,
    getTransit: () => null, getNatalDay: () => ({ close() {}, reset() {} }), loadLifetime: () => new Promise(done => { resolve = done; }) });
  const opening = scales.toggleTransit();
  assert.equal(await scales.toggleTransit(), false);
  assert.equal(session.current, shown); assert.equal(session.hasCurrent, true);
  resolve({ state: { opened: false }, open() { assert.fail('cancelled opening must stay closed'); } });
  assert.equal(await opening, false);
  assert.equal(session.current.primary, transit);
});

for (const explicitPreview of [undefined, true]) test(`real restoration at birth preserves ${explicitPreview ? 'explicit sampled lifetime' : 'legacy exact original'} before the first publication`, async () => {
  const natal = { ...chartAtMinute(natalDayFixture(), 754, personalChartFixture()), utc: '2026-09-24T12:34:56.789Z' };
  const metadata = { startUtc: '2026-09-24T00:00:00Z', endExclusiveUtc: '2026-09-27T00:00:00Z', stepSeconds: 600, samples: 432, planets: [...LIFETIME_PLANETS] };
  const saved = { selectedId: natal.id, natalDay: { opened: false },
    lifetime: { opened: true, mode: 'lifetime', fromDate: '2026-09-24', toDate: '2026-09-26', minimumUtc: natal.utc, index: 75,
      ...(explicitPreview === undefined ? {} : { personalPreview: explicitPreview }) } };
  const points = [], frames = [];
  let exploration, returns, lifetime;
  const chartStore = { get: id => id === natal.id ? natal : null, has: id => id === natal.id };
  const session = createChartSession({ store: chartStore, getReturns: () => returns, getLifetime: () => lifetime,
    onChange: () => frames.push(session.current.utc) });
  const transit = { state: {}, setWanted() {}, start: async () => true };
  const natalDay = { state: { opened: false }, select() {}, close() {} };
  exploration = createChartExploration({ session, getReturns: () => returns, getLifetime: () => lifetime,
    getTransit: () => transit, getNatalDay: () => natalDay, loadLifetime: async () => lifetime });
  returns = createReturnsController({ client: { events: async () => ({ events: [] }) },
    onRequest: exploration.requestReturn, onRender: exploration.publishReturn });
  lifetime = createLifetimeExplorer({ client: { getMeta: async () => metadata, getPoint: async index => {
    points.push(index); const utc = new Date(Date.parse(metadata.startUtc) + index * 600000).toISOString();
    return { index, utc, longitudes: Array(11).fill(1), design: { utc, designUtc: '2026-06-28T12:30:00Z', designArcResidualDegrees: 0, longitudes: Array(11).fill(2) } };
  } }, getMomentState: exploration.momentState, onModeAccepted: exploration.acceptLifetimeMode,
    onStateChange: exploration.lifetimeChanged, onRender: exploration.publishLifetime });
  const view = createViewSession({ store: { read: () => saved, write() {} }, chartStore, session,
    mandala: { setEnabled() {}, enabled: false }, camera: { reset() {}, getView: () => ({ x: 0, y: 0, k: 1 }), getFittedView: () => ({ x: 0, y: 0, k: 1 }) },
    transit, natalDay, planetFilter: { snapshot: {} }, getReturns: () => returns, getLifetime: () => lifetime,
    loadLifetime: async () => lifetime, canRestoreLifetime: () => true,
    getPersonalLive: () => exploration.live, getPersonalPreview: () => exploration.preview,
    restorePersonalLive: exploration.restoreLive, restorePersonalPreview: exploration.restorePreview,
    acceptLifetimeMode: exploration.acceptLifetimeMode,
    eventTarget: null, interactionTarget: null });
  assert.equal(await view.restore(), true);
  exploration.finishRestore({ saved, pendingLifetime: view.pendingLifetime, pendingReturns: view.pendingReturns });
  if (explicitPreview) {
    assert.deepEqual(points, [76]); assert.equal(session.current.kind, 'transit');
    assert.equal(session.current.utc, '2026-09-24T12:40:00Z');
  } else {
    assert.deepEqual(points, []); assert.ok(frames.every(utc => utc === natal.utc));
    assert.equal(session.current.primary, natal); assert.equal(session.current.secondary, null);
    assert.equal(session.current.utc, natal.utc);
  }
});

// Keep the real chart and return owners; the deferred lifetime port controls only
// when the lazy timeline is available, so navigation races remain observable.
function returnListHarness({ active = false, restoreResult = true } = {}) {
  const natal = chartAtMinute(natalDayFixture(), 754, personalChartFixture());
  const second = { ...natal, id: 'second-list-chart', name: 'Вторая карта' };
  let returns, exploration, lifetime = null, finishLoad, loads = 0, dayCloses = 0;
  const restorations = [];
  const rail = {
    state: { opened: false, mode: 'lifetime', requestedUtc: Date.parse('2040-03-02T12:00:00Z'), fromDate: '2039-01-01', toDate: '2041-12-31' },
    restore(saved) {
      restorations.push(saved);
      if (restoreResult) Object.assign(this.state, saved);
      return Promise.resolve(restoreResult);
    },
    close() { this.state.opened = false; },
    setAvailable() {},
  };
  const natalDay = {
    state: { opened: false, available: true },
    close() { this.state.opened = false; dayCloses++; },
    select() {}, reset() {}, open() { this.state.opened = true; return true; },
  };
  const session = createChartSession({
    store: { get: id => [natal, second].find(chart => chart.id === id), has: id => [natal.id, second.id].includes(id) },
    getReturns: () => returns, getLifetime: () => lifetime, getNatalDay: () => natalDay,
    onSelect: () => exploration?.selected(),
  });
  exploration = createChartExploration({ session, getReturns: () => returns, getLifetime: () => lifetime,
    getNatalDay: () => natalDay, getTransit: () => null,
    loadLifetime() { loads++; return new Promise(resolve => { finishLoad = resolve; }); },
  });
  returns = createReturnsController({ client: { events: async () => ({ events: [] }) } });
  session.select(natal.id);
  natalDay.state.opened = !active;
  if (active) { lifetime = rail; rail.state.opened = true; }
  return { session, returns, exploration, natalDay, rail, restorations, natal, second,
    get loads() { return loads; }, get dayCloses() { return dayCloses; },
    installRail() { lifetime = rail; rail.state.opened = true; },
    finishLoad(value = rail) { if (value) lifetime = value; finishLoad(value); },
  };
}

test('return list entry is unavailable for the current transit and does not load a personal timeline', async () => {
  const h = returnListHarness();
  h.session.select('current-transit');
  assert.equal(await h.exploration.openReturnsList(), false);
  assert.equal(h.returns.state.opened, false);
  assert.equal(h.loads, 0);
  assert.deepEqual(h.restorations, []);
});

test('return list entry records its opening immediately and opens the existing personal timeline', async () => {
  const h = returnListHarness(), shown = h.session.current, dayCloses = h.dayCloses;
  await h.returns.setBodies(['saturn']); await h.returns.setYear(2050);
  const opening = h.exploration.openReturnsList();
  assert.equal(h.returns.state.opened, true, 'the controller owns the intent before the lazy timeline arrives');
  assert.equal(h.loads, 1);
  assert.equal(h.dayCloses, dayCloses + 1);
  assert.equal(h.natalDay.state.opened, false);
  assert.equal(h.session.current, shown, 'opening a list does not replace the accepted chart');
  h.finishLoad(); await opening;
  assert.equal(h.restorations.length, 1);
  assert.equal(h.rail.state.opened, true);
  assert.equal(h.rail.state.mode, 'lifetime');
  assert.equal(h.rail.state.minimumUtc, h.natal.utc);
  assert.equal(h.returns.state.opened, true);
  assert.equal(h.returns.state.year, 2050);
  assert.deepEqual(h.returns.state.bodies, ['saturn']);
});

test('opening the return list on an active timeline preserves its range, moment and filters', async () => {
  const h = returnListHarness({ active: true });
  const preview = moment('2040-03-02T12:00:00Z');
  h.session.publish(h.session.expect('lifetime'), preview);
  await h.returns.setBodies(['saturn']); await h.returns.setYear(2050);
  const shown = h.session.current, range = { ...h.rail.state }, dayCloses = h.dayCloses;
  const opening = h.exploration.openReturnsList();
  assert.equal(h.returns.state.opened, true);
  await opening;
  assert.equal(h.loads, 0);
  assert.deepEqual(h.restorations, [], 're-entering the list must not restore the full life range');
  assert.deepEqual(h.rail.state, range);
  assert.equal(h.session.current, shown);
  assert.equal(h.session.current.secondary, preview);
  assert.equal(h.dayCloses, dayCloses);
  assert.equal(h.returns.state.year, 2050);
  assert.deepEqual(h.returns.state.bodies, ['saturn']);
});

test('closing the return list while the timeline loads prevents a late list reopening', async () => {
  const h = returnListHarness();
  const opening = h.exploration.openReturnsList();
  assert.equal(h.returns.state.opened, true);
  h.returns.close();
  h.finishLoad(); await opening;
  assert.equal(h.returns.state.opened, false);
  assert.equal(h.returns.state.natal, h.natal);
});

test('a return list opening from the previous chart cannot open the list on a newly selected chart', async () => {
  const h = returnListHarness();
  const opening = h.exploration.openReturnsList();
  h.session.select(h.second.id);
  h.finishLoad(); await opening;
  assert.equal(h.returns.state.natal, h.second);
  assert.equal(h.returns.state.opened, false);
  assert.deepEqual(h.restorations, [], 'the canceled request cannot restore its old birth range');
});

for (const failure of ['load', 'restore']) test(`failed ${failure} during return list opening clears its otherwise hidden opening intent`, async () => {
  const h = returnListHarness({ restoreResult: failure !== 'restore' });
  const shown = h.session.current;
  const opening = h.exploration.openReturnsList();
  assert.equal(h.returns.state.opened, true);
  h.finishLoad(failure === 'load' ? null : h.rail);
  assert.equal(await opening, false);
  assert.equal(h.returns.state.opened, false);
  assert.equal(h.exploration.returnsEnabled, false);
  assert.equal(h.session.current, shown);
});

test('an obsolete opening failure does not close the return list of the newly selected chart', async () => {
  const h = returnListHarness();
  const opening = h.exploration.openReturnsList();
  h.session.select(h.second.id);
  await h.returns.open();
  h.finishLoad(null); await opening;
  assert.equal(h.returns.state.natal, h.second);
  assert.equal(h.returns.state.opened, true);
});

test('an opening failure does not close the list when another action already enabled this charts timeline', async () => {
  const h = returnListHarness();
  const opening = h.exploration.openReturnsList();
  h.installRail();
  h.finishLoad(null); await opening;
  assert.equal(h.exploration.returnsEnabled, true);
  assert.equal(h.returns.state.opened, true);
  assert.deepEqual(h.restorations, []);
});

test('entering returns from a birthday-minute preview restores the natal chart before opening its life range', async () => {
  const h = returnListHarness();
  const minute = moment(new Date(Date.parse(h.natal.utc) + 60_000).toISOString());
  h.session.publish(h.session.expect('natal-day'), minute);
  assert.equal(h.session.current.primary, minute);
  const opening = h.exploration.openReturnsList();
  assert.equal(h.session.owner, 'original', 'the closed Day tool cannot keep ownership of the life timeline');
  assert.equal(h.session.current.primary, h.natal);
  assert.equal(h.session.current.secondary, null);
  assert.equal(h.natalDay.state.opened, false);
  h.finishLoad(); await opening;
  assert.equal(h.rail.state.requestedUtc, Date.parse(h.natal.utc));
  assert.equal(h.session.current.utc, h.natal.utc, 'the displayed chart and initial rail position agree');
});
