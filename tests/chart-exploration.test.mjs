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
