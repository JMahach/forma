import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartSession } from '../src/state/chart-session.js';
import { createViewSession } from '../src/state/view-session.js';
import { createChartExploration } from '../src/state/chart-exploration.js';
import { createLifetimeExplorer } from '../src/state/lifetime.js';
import { createReturnsController } from '../src/state/returns.js';
import { createChartDayExplorer } from '../src/state/natal-day.js';
import { chartAtMinute } from '../src/domain/natal-day.js';
import { LIFETIME_PLANETS } from '../shared/lifetime-format.js';
import { chartDayFixture, personalChartFixture } from './fixtures/chart-day.mjs';

const tick = () => new Promise(setImmediate);
const startUtc = '2026-09-24T00:00:00Z';
const endExclusiveUtc = '2051-01-01T00:00:00Z';
const metadata = { startUtc, endExclusiveUtc, stepSeconds: 600,
  samples: (Date.parse(endExclusiveUtc) - Date.parse(startUtc)) / 600000, planets: LIFETIME_PLANETS };
const event = { id: 'saturn:2050-01-01T12:00:29.432Z', body: 'saturn', utc: '2050-01-01T12:00:29.432Z', cycle: 1 };
const archiveMoment = index => {
  const utc = new Date(Date.parse(startUtc) + index * 600000).toISOString().replace('.000Z', 'Z');
  return { index, utc, longitudes: Array(11).fill(12), design: { utc,
    designUtc: new Date(Date.parse(utc) - 88 * 86400000).toISOString(), longitudes: Array(11).fill(34), designArcResidualDegrees: 1e-11 } };
};
const exactChart = id => ({ ...chartAtMinute(chartDayFixture({ date: '2050-01-01' }), 720,
  personalChartFixture({ id, birthDate: '2050-01-01' })), utc: event.utc });

// The transport intentionally keeps working after cancellation. Real controller
// generations and session ownership must reject its eventual result themselves.
function deferredRequest(queue, details) {
  return new Promise((resolve, reject) => queue.push({ ...details, resolve, reject }));
}
function harness() {
  const people = [
    { ...chartAtMinute(chartDayFixture(), 754, personalChartFixture({ id: 'person-a', name: 'Person A' })), utc: '2026-09-24T12:34:45.678Z' },
    chartAtMinute(chartDayFixture({ date: '2026-09-25' }), 620,
      personalChartFixture({ id: 'person-b', name: 'Person B', birthDate: '2026-09-25' })),
  ];
  const archiveJobs = [], returnJobs = [], frames = [];
  let exploration, lifetime, returns, natalDay, navigation;
  const transit = { state: { wanted: false }, setWanted(value) { this.state.wanted = value; }, start: async () => true };
  const session = createChartSession({ store: { get: id => people.find(person => person.id === id), has: id => people.some(person => person.id === id) },
    getLifetime: () => lifetime, getReturns: () => returns, getNatalDay: () => natalDay,
    onChange: () => frames.push(session.current) });
  exploration = createChartExploration({ session, getLifetime: () => lifetime, getReturns: () => returns,
    getNatalDay: () => natalDay, getTransit: () => transit, loadLifetime: async () => lifetime });
  natalDay = createChartDayExplorer({ dayClient: { getDay: async chart => chartDayFixture({ date: chart.birthDate }) },
    onRender: exploration.publishDay });
  returns = createReturnsController({ client: {
    events: async input => ({ events: input.body === event.body ? [{ ...event }] : [] }),
    chart: (input, signal) => deferredRequest(returnJobs, { input, signal }),
  }, onRequest: exploration.requestReturn, onRender: exploration.publishReturn });
  lifetime = createLifetimeExplorer({ client: {
    getMeta: async () => metadata,
    getPoint: (index, { signal }) => deferredRequest(archiveJobs, { index, signal }),
  }, getMomentState: exploration.momentState, onModeAccepted: exploration.acceptLifetimeMode,
  onStateChange: exploration.lifetimeChanged,
  onRender: exploration.publishArchive });
  navigation = exploration;
  return { people, session, exploration, lifetime, returns, natalDay, transit, navigation, archiveJobs, returnJobs, frames };
}

for (const archiveOutcome of ['success', 'error']) for (const returnOutcome of ['success', 'error']) {
  test(`person B's exact return survives late archive ${archiveOutcome} and return ${returnOutcome} from person A`, async () => {
    const h = harness(), originals = JSON.stringify(h.people);
    await h.navigation.select('person-a');
    assert.equal(await h.navigation.toggleReturns(), true);
    const archiveUtc = Date.parse('2027-01-01T03:20:00Z');
    assert.notEqual(h.exploration.beforeScrub(archiveUtc), false);
    const oldArchive = h.lifetime.scrub(archiveUtc); await tick();
    assert.equal(h.archiveJobs.length, 1);
    assert.equal(h.lifetime.state.status, 'loading');
    const oldReturn = h.returns.selectEvent(event.id, { restoredEvent: event }); await tick();
    assert.equal(h.returnJobs.length, 1); assert.equal(h.returnJobs[0].input.birthUtc, h.people[0].utc);
    assert.equal(h.session.owner, 'return'); assert.equal(h.returns.state.loadingChart, true);

    await h.navigation.select('person-b');
    assert.equal(h.archiveJobs[0].signal.aborted, true); assert.equal(h.returnJobs[0].signal.aborted, true);
    assert.equal(h.session.current.primary, h.people[1]); assert.equal(h.session.current.secondary, null);
    assert.equal(await h.navigation.toggleReturns(), true);
    const currentReturn = h.returns.selectEvent(event.id, { restoredEvent: event }); await tick();
    assert.equal(h.returnJobs.length, 2); assert.equal(h.returnJobs[1].input.birthUtc, h.people[1].utc);
    const acceptedChart = exactChart('person-b-return'), acceptedEvent = { ...event };
    h.returnJobs[1].resolve({ chart: acceptedChart, event: acceptedEvent }); assert.equal(await currentReturn, true);
    const accepted = h.session.current, count = h.frames.length;
    assert.equal(accepted.kind, 'return'); assert.equal(accepted.primary, h.people[1]);
    assert.equal(accepted.secondary, acceptedChart); assert.equal(accepted.event, acceptedEvent);
    assert.equal(accepted.utc, '2050-01-01T12:00:29.432Z');

    if (archiveOutcome === 'success') h.archiveJobs[0].resolve(archiveMoment(h.archiveJobs[0].index));
    else h.archiveJobs[0].reject(new Error('obsolete archive failure for person A'));
    if (returnOutcome === 'success') h.returnJobs[0].resolve({ chart: exactChart('obsolete-person-a-return'), event: { ...event } });
    else h.returnJobs[0].reject(new Error('obsolete exact-return failure for person A'));
    assert.deepEqual(await Promise.all([oldArchive, oldReturn]), [false, false]); await tick();
    assert.equal(h.session.selectedId, 'person-b'); assert.equal(h.session.owner, 'return');
    assert.equal(h.session.current, accepted); assert.equal(h.frames.length, count, 'stale work cannot publish or repaint person B');
    assert.equal(h.returns.current, acceptedChart); assert.equal(h.returns.state.selectedEvent, acceptedEvent);
    assert.equal(h.returns.state.chartError, ''); assert.equal(h.returns.state.loadingChart, false);
    assert.equal(h.lifetime.state.error, ''); assert.equal(h.lifetime.state.status, 'ready');
    assert.equal(h.archiveJobs.length, 1, 'the abandoned archive cannot queue another point');
    assert.equal(JSON.stringify(h.people), originals);
  });
}

function lazyPersonalHarness({ phase = 'module' } = {}) {
  const people = ['person-a', 'person-b'].map(id => ({
    ...chartAtMinute(chartDayFixture(), 754, personalChartFixture({ id })), utc: '2026-09-24T12:34:56.789Z',
  }));
  const metadataJobs = [], points = [], modeChanges = [];
  let lifetime = null, exploration, returns, natalDay, releaseImport;
  const imported = new Promise(resolve => { releaseImport = resolve; });
  const transit = { state: { wanted: false }, setWanted(value) { this.state.wanted = value; } };
  const session = createChartSession({ store: { get: id => people.find(chart => chart.id === id), has: id => people.some(chart => chart.id === id) },
    getLifetime: () => lifetime, getReturns: () => returns, getNatalDay: () => natalDay });
  exploration = createChartExploration({ session, getLifetime: () => lifetime, getReturns: () => returns,
    getNatalDay: () => natalDay, getTransit: () => transit, loadLifetime: () => imported,
    onModeChange: () => modeChanges.push(exploration.returnsEnabled) });
  natalDay = createChartDayExplorer({ dayClient: { getDay: async () => chartDayFixture() }, onRender: exploration.publishDay });
  returns = createReturnsController({ client: { events: async () => ({ events: [] }) },
    onRequest: exploration.requestReturn, onRender: exploration.publishReturn });
  const controller = createLifetimeExplorer({ client: {
    getMeta: ({ signal }) => phase === 'metadata' ? deferredRequest(metadataJobs, { signal }) : Promise.resolve(metadata),
    getPoint: index => { points.push(index); return Promise.resolve(archiveMoment(index)); },
  }, getMomentState: exploration.momentState, onModeAccepted: exploration.acceptLifetimeMode,
    onStateChange: exploration.lifetimeChanged, onRender: exploration.publishArchive });
  const finishImport = () => { lifetime = controller; releaseImport(controller); };
  if (phase === 'metadata') finishImport();
  return { session, exploration, natalDay, returns, controller, people, metadataJobs, points, modeChanges, finishImport };
}

for (const phase of ['module', 'metadata']) test(`personal OFF while ${phase} is pending cancels the actual opening and its exact-birth range`, async () => {
  const h = lazyPersonalHarness({ phase });
  await h.exploration.select('person-a');
  const opening = h.exploration.toggleReturns(); await tick();
  assert.equal(h.exploration.returnsEnabled, true);
  assert.equal(await h.exploration.toggleReturns(), false);
  assert.equal(h.exploration.returnsEnabled, false);
  assert.equal(h.natalDay.state.opened, false);
  if (phase === 'module') h.finishImport();
  else { assert.equal(h.metadataJobs[0].signal.aborted, true); h.metadataJobs[0].resolve(metadata); }
  assert.equal(await opening, false);
  assert.equal(h.controller.state.opened, false);
  assert.equal(h.session.current.primary, h.people[0]);
  assert.equal(h.session.current.utc, '2026-09-24T12:34:56.789Z');
  assert.deepEqual(h.points, []);
});

for (const phase of ['module', 'metadata']) test(`A to B to A cannot revive the first ${phase} opening or clear the new one`, async () => {
  const h = lazyPersonalHarness({ phase });
  await h.exploration.select('person-a');
  const first = h.exploration.toggleReturns(); await tick();
  await h.exploration.select('person-b'); await h.exploration.select('person-a');
  const latest = h.exploration.toggleReturns(); await tick();
  if (phase === 'module') h.finishImport();
  else {
    assert.equal(h.metadataJobs.length, 2);
    h.metadataJobs[0].resolve(metadata);
    assert.equal(await first, false);
    assert.equal(h.exploration.returnsEnabled, true);
    assert.equal(h.modeChanges.at(-1), true);
    h.metadataJobs[1].resolve(metadata);
  }
  assert.equal(await first, false);
  assert.equal(await latest, true);
  assert.equal(h.exploration.returnsEnabled, true);
  assert.equal(h.controller.state.mode, 'archive');
  assert.equal(h.controller.state.requestedUtc, Date.parse('2026-09-24T12:34:56.789Z'));
  assert.equal(h.controller.current, h.people[0]);
  assert.deepEqual(h.points, []);
});

test('beginning an unfinished range edit cancels automatic personal range installation before metadata arrives', async () => {
  const h = lazyPersonalHarness({ phase: 'metadata' });
  await h.exploration.select('person-a');
  const opening = h.exploration.toggleReturns(); await tick();
  h.exploration.invalidateTimeline();
  h.metadataJobs[0].resolve(metadata);
  assert.equal(await opening, false);
  assert.equal(h.controller.state.opened, true);
  assert.equal(h.controller.state.mode, 'day');
  assert.equal(h.controller.state.minUtc, null);
  assert.deepEqual(h.points, []);
});

test('the birth-boundary command cancels a pending archive point and directly restores exact natal', async () => {
  const h = harness();
  await h.navigation.select('person-a'); await h.navigation.toggleReturns();
  const target = Date.parse('2027-01-01T03:20:00Z');
  h.exploration.beforeScrub(target);
  const pending = h.lifetime.scrub(target); await tick();
  assert.equal(h.exploration.beforeScrub(h.lifetime.state.minUtc), false);
  assert.equal(h.session.owner, 'original');
  assert.equal(h.session.current.primary, h.people[0]);
  assert.equal(h.lifetime.state.requestedUtc, Date.parse(h.people[0].utc));
  assert.equal(h.archiveJobs[0].signal.aborted, true);
  h.archiveJobs[0].resolve(archiveMoment(h.archiveJobs[0].index));
  assert.equal(await pending, false);
  assert.equal(h.session.current.secondary, null);
  assert.equal(h.archiveJobs.length, 1);
});


function savedView(h, saved = null) {
  const writes = [];
  const chartStore = { get: id => h.people.find(chart => chart.id === id), has: id => h.people.some(chart => chart.id === id) };
  const view = createViewSession({ store: { read: () => saved, write: value => writes.push(structuredClone(value)) },
    chartStore, session: h.session, transit: h.transit, natalDay: h.natalDay, planetFilter: { snapshot: {}, restore() {} },
    mandala: { enabled: false, setEnabled() {} },
    camera: { reset() {}, setView() {}, getView: () => ({ x: 0, y: 0, k: 1 }), getFittedView: () => ({ x: 0, y: 0, k: 1 }) },
    getReturns: () => h.returns, getLifetime: () => h.lifetime, loadLifetime: async () => h.lifetime,
    canRestoreLifetime: () => h.session.selectedId === 'current-transit' || h.returns.state.available,
    getPersonalPreview: () => h.exploration.preview, getPersonalLive: () => h.exploration.live,
    restorePersonalPreview: h.exploration.restorePreview, restorePersonalLive: h.exploration.restoreLive,
    acceptLifetimeMode: h.exploration.acceptLifetimeMode, openReturnsTimeline: h.exploration.openTimeline,
    eventTarget: null, interactionTarget: null });
  return { view, writes };
}

async function restoreArchiveSnapshot(snapshot) {
  const h = harness();
  const input = { ...snapshot, lifetime: { ...snapshot.lifetime, minimumUtc: h.people[0].utc } };
  const next = savedView(h, input), restoring = next.view.restore(); await tick();
  for (const job of h.archiveJobs) job.resolve(archiveMoment(job.index));
  assert.equal(await restoring, true);
  h.exploration.finishRestore({ saved: input, pendingLifetime: next.view.pendingLifetime,
    pendingReturns: next.view.pendingReturns, interrupted: next.view.interrupted });
  return h;
}

for (const priorArchive of [false, true]) for (const outcome of ['pending', 'error']) {
  test(`${priorArchive ? 'later' : 'first'} archive ${outcome} resumes its requested target on reload`, async () => {
    const h = harness(), saved = savedView(h);
    await saved.view.restore();
    await h.exploration.select('person-a'); await h.exploration.toggleReturns();
    const target = Date.parse('2027-01-01T03:30:00Z');
    if (priorArchive) {
      h.exploration.beforeScrub(target - 600000);
      const first = h.lifetime.scrub(target - 600000); await tick();
      h.archiveJobs[0].resolve(archiveMoment(h.archiveJobs[0].index)); assert.equal(await first, true);
    }
    const accepted = h.session.current;
    h.exploration.beforeScrub(target);
    const requested = h.lifetime.scrub(target); await tick();
    const job = h.archiveJobs.at(-1);
    if (outcome === 'error') { job.reject(new Error('point offline')); assert.equal(await requested, false); }
    assert.equal(h.session.current, accepted);
    assert.equal(h.session.owner, 'archive');
    saved.view.flush(); const snapshot = saved.writes.at(-1);
    assert.equal(snapshot.lifetime.requestedUtc, target);
    assert.equal(snapshot.lifetime.personalPreview, true);
    if (outcome === 'pending') { h.lifetime.close(); job.reject(new Error('page closed')); await requested; }
    const restored = await restoreArchiveSnapshot(snapshot);
    assert.equal(restored.archiveJobs.length, 1);
    assert.equal(restored.session.shownSource, 'archive');
    assert.equal(Date.parse(restored.session.current.utc), target);
    assert.equal(restored.session.current.primary.utc, h.people[0].utc);
  });
}

for (const outcome of ['error', 'menu-cancel']) for (const lateArchive of ['success', 'error']) {
  test(`unconfirmed Return ${outcome} saves accepted archive before and after stale point ${lateArchive}`, async () => {
    const h = harness(), saved = savedView(h);
    await saved.view.restore();
    await h.exploration.select('person-a'); await h.exploration.toggleReturns();
    const target = Date.parse('2027-01-01T03:20:00Z');
    h.exploration.beforeScrub(target);
    const first = h.lifetime.scrub(target); await tick();
    h.archiveJobs[0].resolve(archiveMoment(h.archiveJobs[0].index)); await first;
    const accepted = h.session.current;
    h.exploration.beforeScrub(target + 600000);
    const abandoned = h.lifetime.scrub(target + 600000); await tick();
    assert.equal(await h.returns.selectEvent('missing-event'), false);
    assert.equal(h.session.owner, 'archive');
    assert.equal(h.lifetime.state.requestedUtc, target + 600000);
    assert.equal(h.archiveJobs[1].signal.aborted, false, 'an invalid Return selection cannot cancel the archive command');
    const pendingReturn = h.returns.selectEvent(event.id, { restoredEvent: event }); await tick();
    saved.view.flush();
    assert.equal(saved.writes.at(-1).lifetime.requestedUtc, target, 'a pending Return already pins the accepted archive, not the abandoned target');
    if (outcome === 'error') h.returnJobs[0].reject(new Error('exact calculation failed'));
    else { h.returns.close(); h.returnJobs[0].resolve({ chart: exactChart('cancelled'), event }); }
    assert.equal(await pendingReturn, false);
    saved.view.flush(); const before = saved.writes.at(-1);
    assert.equal(before.lifetime.personalPreview, true);
    assert.equal(before.lifetime.personalLive, false);
    assert.equal(before.lifetime.requestedUtc, target);
    assert.equal(before.returns, undefined);
    if (lateArchive === 'success') h.archiveJobs[1].resolve(archiveMoment(h.archiveJobs[1].index));
    else h.archiveJobs[1].reject(new Error('abandoned point offline'));
    await abandoned;
    assert.equal(h.session.current, accepted);
    saved.view.flush(); const after = saved.writes.at(-1);
    assert.deepEqual(after.lifetime, before.lifetime);
    for (const snapshot of [before, after]) {
      const restored = await restoreArchiveSnapshot(snapshot);
      assert.equal(restored.session.shownSource, 'archive');
      assert.equal(Date.parse(restored.session.current.utc), target);
    }
  });
}

test('live preview remains live until a failed Return pins its accepted moment for reload', async () => {
  const h = harness(), saved = savedView(h);
  await saved.view.restore();
  await h.exploration.select('person-a'); await h.exploration.toggleReturns();
  const liveChart = { ...exactChart('live'), source: 'transit', utc: '2027-01-01T03:20:00Z' };
  h.transit.current = liveChart;
  Object.assign(h.transit.state, { current: liveChart, status: 'ready', live: true });
  h.transit.goNow = () => true;
  h.lifetime.syncTransit = () => h.lifetime.syncDay() || h.lifetime.syncClock();
  assert.equal(h.exploration.followNow(), true);
  saved.view.flush();
  assert.equal(saved.writes.at(-1).lifetime.personalLive, true);
  assert.equal(saved.writes.at(-1).lifetime.personalPreview, true);
  assert.equal(h.transit.state.wanted, true);
  const pendingReturn = h.returns.selectEvent(event.id, { restoredEvent: event }); await tick();
  h.returnJobs[0].reject(new Error('exact calculation failed')); assert.equal(await pendingReturn, false);
  saved.view.flush(); const snapshot = saved.writes.at(-1);
  assert.equal(h.session.current.secondary, liveChart);
  assert.equal(h.transit.state.wanted, false);
  assert.equal(h.exploration.live, false);
  assert.equal(snapshot.lifetime.personalLive, false);
  assert.equal(snapshot.lifetime.personalPreview, true);
  assert.equal(snapshot.lifetime.requestedUtc, Date.parse(liveChart.utc));
  const restored = await restoreArchiveSnapshot(snapshot);
  assert.equal(Date.parse(restored.session.current.utc), Date.parse(liveChart.utc));
});

for (const source of ['original', 'natal-day']) test(`failed Return retains accepted ${source} identity and exact UTC`, async () => {
  const h = harness(), saved = savedView(h);
  await saved.view.restore();
  await h.exploration.select('person-a');
  if (source === 'original') await h.exploration.toggleReturns();
  else h.natalDay.scrub(800);
  assert.equal(h.session.shownSource, source);
  const accepted = h.session.current, original = JSON.stringify(h.people[0]), utc = accepted.utc;
  const pendingReturn = h.returns.selectEvent(event.id, { restoredEvent: event }); await tick();
  assert.equal(h.session.current, accepted);
  if (h.lifetime.state.opened) assert.equal(h.lifetime.state.requestedUtc, Date.parse(utc));
  h.returnJobs[0].reject(new Error('exact calculation failed')); assert.equal(await pendingReturn, false);
  assert.equal(h.session.current, accepted);
  assert.equal(h.session.current.utc, utc);
  assert.equal(h.exploration.preview, false);
  assert.equal(JSON.stringify(h.people[0]), original);
  assert.equal(h.archiveJobs.length, 0);
  saved.view.flush(); const snapshot = saved.writes.at(-1);
  assert.equal(snapshot.returns, undefined);
  if (source === 'original') {
    assert.equal(snapshot.lifetime.personalPreview, false);
    const restored = await restoreArchiveSnapshot(snapshot);
    assert.equal(restored.session.current.utc, utc);
    assert.equal(restored.session.shownSource, 'original');
  } else assert.equal(snapshot.natalDay.index, 800);
});

for (const outcome of ['error', 'menu-cancel']) test(`accepted archive survives first Return ${outcome}, snapshot and real restoration`, async () => {
  const h = harness(), saved = savedView(h);
  await saved.view.restore();
  await h.exploration.select('person-a'); await h.exploration.toggleReturns();
  const target = Date.parse('2027-01-01T03:20:00Z');
  h.exploration.beforeScrub(target);
  const archive = h.lifetime.scrub(target); await tick();
  h.archiveJobs[0].resolve(archiveMoment(h.archiveJobs[0].index)); assert.equal(await archive, true);
  const accepted = h.session.current;
  const pendingReturn = h.returns.selectEvent(event.id, { restoredEvent: event }); await tick();
  assert.equal(h.session.owner, 'return'); assert.equal(h.session.shownSource, 'archive');
  if (outcome === 'error') h.returnJobs[0].reject(new Error('exact calculation failed'));
  else { h.returns.close(); h.returnJobs[0].resolve({ chart: exactChart('cancelled'), event }); }
  assert.equal(await pendingReturn, false); assert.equal(h.session.current, accepted);
  saved.view.flush();
  const snapshot = saved.writes.at(-1);
  assert.equal(snapshot.lifetime.requestedUtc, target);
  assert.equal(snapshot.returns, undefined, 'an unaccepted request is not a saved exact return');

  const restored = harness();
  // The app adds the selected person's exact lower bound to the saved rail.
  const input = { ...snapshot, lifetime: { ...snapshot.lifetime, minimumUtc: restored.people[0].utc } };
  const next = savedView(restored, input), restoring = next.view.restore(); await tick();
  for (const job of restored.archiveJobs) job.resolve(archiveMoment(job.index));
  assert.equal(await restoring, true);
  restored.exploration.finishRestore({ saved: input, pendingLifetime: next.view.pendingLifetime,
    pendingReturns: next.view.pendingReturns, interrupted: next.view.interrupted });
  assert.equal(restored.session.shownSource, 'archive');
  assert.equal(Date.parse(restored.session.current.utc), target);
  assert.equal(restored.session.current.primary.utc, '2026-09-24T12:34:45.678Z');
  assert.equal(restored.session.current.kind, accepted.kind);
  assert.deepEqual(restored.session.current.secondary, accepted.secondary);
  assert.equal(snapshot.lifetime.personalPreview, true);
});

test('a confirmed Return remains the saved exact event after a subsequent request fails', async () => {
  const h = harness(), saved = savedView(h);
  await saved.view.restore();
  await h.exploration.select('person-a'); await h.exploration.toggleReturns();
  const first = h.returns.selectEvent(event.id, { restoredEvent: event }); await tick();
  h.returnJobs[0].resolve({ chart: exactChart('confirmed'), event }); assert.equal(await first, true);
  const accepted = h.session.current;
  const second = h.returns.selectEvent(event.id, { restoredEvent: event }); await tick();
  h.returnJobs[1].reject(new Error('later request failed')); assert.equal(await second, false);
  saved.view.flush(); const snapshot = saved.writes.at(-1);
  assert.equal(snapshot.lifetime.personalPreview, false);
  assert.equal(snapshot.returns.eventId, event.id);
  assert.deepEqual(snapshot.returns.event, event);
  const restored = harness();
  const input = { ...snapshot, lifetime: { ...snapshot.lifetime, minimumUtc: restored.people[0].utc } };
  const next = savedView(restored, input), restoring = next.view.restore(); await tick();
  assert.equal(restored.returnJobs.length, 1);
  restored.returnJobs[0].resolve({ chart: exactChart('confirmed'), event });
  assert.equal(await restoring, true);
  restored.exploration.finishRestore({ saved: input, pendingLifetime: next.view.pendingLifetime,
    pendingReturns: next.view.pendingReturns, interrupted: next.view.interrupted });
  assert.equal(restored.session.shownSource, 'return'); assert.equal(restored.session.current.kind, 'return');
  assert.equal(restored.session.current.utc, event.utc);
  assert.deepEqual(restored.session.current.secondary, accepted.secondary);
  assert.equal(restored.archiveJobs.length, 0, 'the exact event never becomes a sampled archive point');
});
