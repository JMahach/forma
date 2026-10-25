import type { LifetimeExplorer } from '../src/state/lifetime.ts';
import type { LifetimeMetadata } from '../shared/lifetime-format.ts';
import type { TransitDay } from '../shared/day-packets/transit-format.ts';
import type { CycleEvent, CycleChartResult, CycleInput } from '../shared/cycles-format.ts';
import type { TestReturnsOptions } from './fixtures/returns.ts';
import type { TestLifetimeOptions } from './fixtures/lifetime.ts';
import type { ChartStorage } from '../src/data/storage.ts';
import type { SavedView } from '../src/data/view-store.ts';
type ViewOptions = Parameters<typeof createViewSession>[0];
type LiveOptions = NonNullable<Parameters<typeof createLiveTransit>[0]>;
interface HarnessOptions {
  size?: number; transitDay?: NonNullable<LiveOptions['dayClient']>['getDay'];
  loadLifetime?: ViewOptions['loadLifetime'] | null; canRestoreLifetime?: ViewOptions['canRestoreLifetime'] | null;
  returnsClient?: TestReturnsOptions['client'] | null; panelView?: boolean; openReturnsTimeline?: ViewOptions['openReturnsTimeline'];
  getNow?: () => number; zone?: string; cameraRestored?: boolean;
  getKnowledgeView?: ViewOptions['getKnowledgeView']; getChartsView?: ViewOptions['getChartsView'];
  normalizeSavedView?: (saved: ReturnType<ReturnType<typeof createViewStore>['read']>) => Partial<SavedView> | null;
  lifetimeClient?: TestLifetimeOptions['client'];
}
interface TestEvent { type: string; [key: string]: unknown }
interface EventSurface {
  hidden: boolean; addEventListener(name: string, callback: (event: TestEvent) => void): void;
  contains(target: unknown): boolean; dispatch(name: string, event?: Omit<TestEvent, 'type'>): void;
  setAttribute?: (name: string, value: string) => void;
}
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReturnsController } from './fixtures/returns.ts';
import { DEFAULT_CYCLE_BODIES } from '../src/domain/cycles.ts';
import { chartCaption } from '../src/views/chart-display.ts';
import { createViewSession } from '../src/state/view-session.ts';
import { createPanelState } from '../src/state/panels.ts';
import { createWorkspaceState } from '../src/state/workspace.ts';
import { attachChartSummary } from '../src/views/chart-summary-panel.ts';
import { createViewStore } from '../src/data/view-store.ts';
import { createChartStore } from '../src/data/chart-store.ts';
import { createChartSession } from '../src/state/chart-session.ts';
import { createChartExploration } from '../src/state/chart-exploration.ts';
import { createTransitPlanetFilter } from '../src/state/transit-planets.ts';
import { createLifetimeExplorer } from './fixtures/lifetime.ts';
import { LIFETIME_PLANETS } from '../shared/lifetime-format.ts';
import { createLiveTransit } from '../src/state/live-transit.ts';
import { createNatalDayExplorer } from '../src/state/natal-day.ts';
import { attachMandalaMode } from '../src/scene/modes/mandala.ts';
import { createMandalaMotion } from '../src/scene/modes/mandala-motion.ts';
import { createCamera } from '../src/scene/camera.ts';
import { STUDIO_FRAME, MANDALA_FRAME } from '../src/scene/geometry/frames.ts';
import { libraryRecordAtMinute } from './fixtures/natal-day.ts';
import { transitChartAt } from '../src/domain/transit-day.ts';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.ts';
import { dateDom } from './helpers/date-dom.ts';

const lifetimeFixtures: LifetimeExplorer[] = [];
test.afterEach(() => { for (const explorer of lifetimeFixtures.splice(0)) explorer.close(); });

const day = (date: string) => ({ date, startUtc: `${date}T00:00:00Z`, samples: 1440, stepSeconds: 60,
  columns: Array.from({ length: 24 }, (_, column) => Float64Array.from({ length: 1440 }, (_, minute) => column < 22
    ? (column * 20 + minute / 10000) % 360 : column === 22 ? Date.parse(`${date}T00:00:00Z`) / 1000 - 88 * 86400 + minute * 61 : 0)) } as TransitDay);
function events(): EventSurface {
  const callbacks = new Map<string, (event: TestEvent) => void>();
  return { hidden: false, addEventListener(name, callback) { callbacks.set(name, callback); },
    contains(target) { return target === this; },
    dispatch(name: string, event = {}) { callbacks.get(name)?.({ ...event, type: name }); } };
}
const metadata = { startUtc: '2020-01-01T00:00:00Z', endExclusiveUtc: '2020-01-04T00:00:00Z', stepSeconds: 600, samples: 432, planets: [...LIFETIME_PLANETS] } as unknown as LifetimeMetadata;
const point = (index: number, source = metadata) => {
  const utc = new Date(Date.parse(source.startUtc) + index * 600000).toISOString().replace('.000Z', 'Z');
  return { index, utc, longitudes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    design: { utc, designUtc: new Date(Date.parse(utc) - 88 * 86400000).toISOString(),
      designArcResidualDegrees: 0, longitudes: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21] } };
};
function harness(storage = new Map<string, string>(), { size = 1000, transitDay = async (date: string) => day(date), loadLifetime = null, canRestoreLifetime = null,
    returnsClient = null, panelView = false, openReturnsTimeline = undefined, getNow = () => Date.parse('2026-10-04T12:00:00Z'),
    zone = 'UTC', cameraRestored = false, getKnowledgeView, getChartsView, normalizeSavedView = value => value, lifetimeClient = { getMeta: async () => metadata, getPoint: async (index: number) => point(index) } }: HarnessOptions = {}) {
  const frames: (string|undefined)[] = [], writes: [string, string][] = [], pending = new Map<number, () => void>(), attributes: Record<string, string> = {}, styles = new Map<string, string>();
  const storagePort = { getItem: (key: string) => storage.get(key) ?? null,
    setItem(key: string, value: string) { storage.set(key, value); writes.push([key, value]); } };
  const saved = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture());
  if (!storage.has('liniya.charts.v1')) storage.set('liniya.charts.v1', JSON.stringify([saved, { ...saved, id: 'second' }]));
  const chartStore = createChartStore({ getStorage: () => storagePort as ChartStorage });
  const viewStore = createViewStore({ getStorage: () => storagePort });
  let view: ReturnType<typeof createViewSession>, transit: ReturnType<typeof createLiveTransit>, natalDay: ReturnType<typeof createNatalDayExplorer>, mandala: ReturnType<typeof attachMandalaMode>, lifetime: LifetimeExplorer | null = null, returns: ReturnType<typeof createReturnsController>, exploration: ReturnType<typeof createChartExploration>, summary: ReturnType<typeof attachChartSummary> | null = null;
  const planets = createTransitPlanetFilter(), panels = createPanelState(), workspace = createWorkspaceState();
  const changed = () => { summary?.setReturnsVisible(Boolean(returns?.opened)); view?.schedule(); };
  const session = createChartSession({ store: chartStore, getTransit: () => transit, getNatalDay: () => natalDay,
    getLifetime: () => lifetime, getReturns: () => returns, filterTransit: planets.filter,
    onSelect: () => exploration?.selected(), onChange: () => { changed(); if (session.hasCurrent) frames.push(session.current.utc); } });
  exploration = createChartExploration({ session, getTransit: () => transit, getNatalDay: () => natalDay,
    getLifetime: () => lifetime, getReturns: () => returns, loadLifetime: loadLifetime || (async () => ensureLifetime()), onModeChange: changed, onChange: changed });
  const setPersonalLive = (value: boolean) => exploration.restoreLive(value);
  const returnEvent: CycleEvent = { id: 'saturn:2055-10-01T12:00:00Z', utc: '2055-10-01T12:00:00Z', body: 'saturn', cycle: 1, pass: 1, cycleId: 'saturn:1', age: 29, direction: 'direct' };
  returns = createReturnsController({ client: returnsClient || {
    events: async input => ({ events: input.body === 'saturn' ? [returnEvent] : [] }),
    chart: async input => ({ event: { ...returnEvent, id: `${input.body}:${input.eventUtc}`, body: input.body, utc: input.eventUtc! },
      chart: { ...saved, utc: input.eventUtc, personality: [2,14], design: [3,60] } as CycleChartResult['chart'] }),
  }, onStateChange: changed, onRequest: exploration.requestReturn, onRender: exploration.publishReturn });
  transit = createLiveTransit({ now: getNow, timeZone: () => zone,
    dayClient: { getDay: transitDay }, onStateChange: changed, onRender: exploration.publishTransit });
  natalDay = createNatalDayExplorer({ dayClient: { getDay: async () => natalDayFixture() }, onStateChange: changed, onRender: exploration.publishDay });
  const camera = createCamera({ getFrame: () => MANDALA_FRAME, getHomeFrame: () => STUDIO_FRAME,
    measureFit: () => ({ area: { x: 0, y: 0, width: size, height: size }, viewport: { x: 0, y: 0, width: size, height: size }, min: .1 }), onChange: changed });
  const motion = createMandalaMotion({ viewport: { style: { setProperty: (name: string, value: string) => styles.set(name, value) } } as unknown as HTMLElement,
    requestFrame: () => { assert.fail('restoration must reveal the saved mode without an animation from zero'); },
    onFinish: enabled => mandala.finishTransition(enabled) });
  const button = events(); button.setAttribute = (name, value) => { attributes[name] = value; };
  mandala = attachMandalaMode({ button: button as unknown as HTMLElement, canvas: { classList: { toggle() {} } } as unknown as Element, gestures: camera, layout: { frame: () => STUDIO_FRAME },
    motion, render() {}, onStateChange: changed });
  function ensureLifetime(): LifetimeExplorer {
    if (!lifetime) {
      lifetime = createLifetimeExplorer({ client: lifetimeClient, planetFilter: planets,
        getDayState: () => transit.state, onRender: exploration.publishLifetime,
        getMomentState: exploration.momentState, onModeAccepted: exploration.acceptLifetimeMode,
        onStateChange(state) { exploration.lifetimeChanged(state); changed(); } });
      lifetimeFixtures.push(lifetime);
    }
    return lifetime;
  }
  const eventTarget = events(), interactionTarget = events(), cameraSurface = events();
  let counter = 0;
  const savedView = normalizeSavedView(viewStore.read());
  view = createViewSession({ panels, workspace, store: { read: () => savedView, write: viewStore.write }, chartStore, session, mandala, camera, cameraRestored, transit, natalDay,
    ...(canRestoreLifetime ? { canRestoreLifetime } : {}), openReturnsTimeline, getKnowledgeView, getChartsView,
    planetFilter: planets, getReturns: () => returns, getLifetime: () => lifetime, loadLifetime: loadLifetime || (async () => ensureLifetime()), eventTarget: eventTarget as unknown as EventTarget, interactionTarget: interactionTarget as unknown as EventTarget & { hidden: boolean },
    acceptLifetimeMode: exploration.acceptLifetimeMode,
    getPersonalLive: () => exploration.live, restorePersonalLive: exploration.restoreLive,
    getPersonalPreview: () => exploration.preview, restorePersonalPreview: exploration.restorePreview,
    getLifetimeIntent: () => exploration.pendingTimeline,
    schedule: ((callback: () => void) => { const id = ++counter; pending.set(id, callback); return id; }) as unknown as ViewOptions['schedule'], cancel: id => { pending.delete(id as unknown as number); } });
  const restore = view.restore;
  view.restore = async () => {
    try { return await restore(); }
    finally { exploration.finishRestore({ saved: savedView, pendingLifetime: view.pendingLifetime, pendingReturns: view.pendingReturns, interrupted: view.interrupted }); }
  };
  if (panelView) {
    const document = dateDom(); document.querySelector = () => null;
    const panel = document.createElement('aside'), summaryScreen = document.createElement('section');
    const returnsPanel = document.createElement('section'), returnsButton = document.createElement('button');
    const switcher = document.createElement('button');
    (panel as unknown as { classList: { toggle(): void } }).classList = { toggle() {} };
    summaryScreen.append(returnsButton); panel.append(summaryScreen, returnsPanel);
    summary = attachChartSummary({ panels, panel, summaryScreen, returnsPanel, returnsButton, switcher } as unknown as Parameters<typeof attachChartSummary>[0]);
  }
  const tick = () => { for (const [id, callback] of [...pending] as const) { pending.delete(id); callback(); } };
  return { panels, workspace, summary, frames, view, session, exploration, returns, returnEvent, mandala, camera, cameraSurface, transit, natalDay, planets, storage, writes, attributes, styles, eventTarget, interactionTarget, ensureLifetime, setPersonalLive, tick };
}

test('browser reload restores saved chart, mandala endpoint, natal minute and camera without modifying the library', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  // The fixture identity is fixed independently from session internals.
  first.session.select(JSON.parse(first.storage.get('liniya.charts.v1')!)[0].id);
  first.mandala.setEnabled(true, { animate: false });
  first.camera.zoom(2); first.camera.pan(40, 25);
  await first.natalDay.open(); first.natalDay.scrub(800);
  first.eventTarget.dispatch('pagehide');
  const beforeLibrary = first.storage.get('liniya.charts.v1');
  const pose = first.camera.getView();
  const second = harness(first.storage); t.after(() => second.transit.stop()); await second.view.restore();
  assert.equal(second.view.interrupted, false);
  assert.equal(second.session.selectedId, JSON.parse(beforeLibrary!)[0].id);
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
  assert.equal(second.transit.current!.utc, '2026-10-04T00:00:00Z');
  assert.equal(second.transit.state.referenceIndex, 720);
});

test('camera restoration rebases against the new screen Home and respects maximum zoom', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  first.camera.zoom(2); first.view.flush();
  const second = harness(first.storage, { size: 500 }); t.after(() => second.transit.stop()); await second.view.restore();
  assert.equal(second.camera.getView().k / second.camera.getFittedView().k, 2);
  const third = harness(first.storage, { size: 5000, normalizeSavedView(value) { delete value!.camera!.maxK; return value; } }); t.after(() => third.transit.stop()); await third.view.restore();
  assert.equal(third.camera.getView().k, 4.5);
});

test('a deleted chart falls back to transit and malformed presentation never clears the saved library', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  first.session.select('missing'); first.view.flush();
  const second = harness(first.storage); t.after(() => second.transit.stop()); await second.view.restore();
  assert.equal(second.session.selectedId, 'current-transit'); assert.equal(second.session.current.id, 'current-transit');
  assert.equal(second.session.record, null);
  assert.equal(second.session.current.primary.source, 'transit');
  assert.equal(second.session.current.utc, second.transit.current!.utc);
  assert.equal(JSON.parse(second.storage.get('liniya.charts.v1')!).length, 2);
});

test('initial loading cannot overwrite a saved view and a later user action cancels pending paused restoration', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore(); first.transit.scrub(0); first.view.flush();
  let resolve; const second = harness(first.storage, { transitDay: () => new Promise(done => { resolve = done; }) });
  t.after(() => second.transit.stop()); const restoring = second.view.restore();
  second.view.flush(); assert.equal(second.writes.length, 0);
  second.view.interrupt(); second.session.select('second');
  assert.equal(second.view.interrupted, true, 'composition must not apply the old saved preview after new user navigation');
  resolve!(day('2026-10-04')); await restoring;
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
  const calls: unknown[] = []; const second = harness(first.storage, { lifetimeClient: { getMeta: async () => metadata,
    getPoint: async index => { calls.push(index); return point(index); } } });
  t.after(() => second.transit.stop()); await second.view.restore();
  const restored = second.ensureLifetime();
  assert.equal(restored.state.opened, true); assert.equal(restored.state.mode, 'lifetime');
  assert.equal(restored.state.fromDate, '2020-01-01'); assert.equal(restored.state.toDate, '2020-01-03');
  assert.equal(restored.state.requestedUtc, Date.parse('2020-01-02T09:20:00Z')); assert.deepEqual(calls, [200]);
  assert.equal(second.session.current.utc, '2020-01-02T09:20:00Z');
  assert.deepEqual(second.session.current.primary.activations!.personality.map(entry => entry.planet), ['moon']);
  assert.deepEqual(second.session.current.primary.activations!.design.map(entry => entry.planet), ['sun']);
  assert.equal(second.transit.state.wanted, false);
});

test('failed lifetime metadata keeps the saved range and moment so retry resumes the same view', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const lifetime = first.ensureLifetime(); await lifetime.open(); await lifetime.setDateRange('2020-01-01', '2020-01-03');
  await lifetime.scrub(Date.parse('2020-01-02T09:20:00Z')); first.view.flush();
  let fail = true; const calls: unknown[] = [];
  const second = harness(first.storage, { lifetimeClient: { getMeta: async () => { if (fail) throw new Error('Offline'); return metadata; },
    getPoint: async index => { calls.push(index); return point(index); } } });
  t.after(() => second.transit.stop()); await second.view.restore();
  const saved = JSON.parse(second.storage.get('liniya.view.v1')!);
  assert.equal(saved.lifetime.mode, 'lifetime'); assert.equal(saved.lifetime.requestedUtc, Date.parse('2020-01-02T09:20:00Z'));
  assert.equal(saved.lifetime.fromDate, '2020-01-01');
  assert.equal(second.ensureLifetime().state.status, 'loading');
  assert.equal(second.ensureLifetime().state.retryCount, 1);
  assert.equal(second.ensureLifetime().state.mode, 'lifetime');
  assert.equal(second.transit.state.wanted, false);
  assert.equal(second.session.hasCurrent, false);
  const retained = second.view.pendingLifetime;
  assert.deepEqual([retained!.mode, retained!.fromDate, retained!.toDate, retained!.requestedUtc], ['lifetime', '2020-01-01', '2020-01-03', Date.parse('2020-01-02T09:20:00Z')]);
  retained!.requestedUtc = 1; retained!.fromDate = '2020-01-03';
  assert.deepEqual([second.view.pendingLifetime!.fromDate, second.view.pendingLifetime!.requestedUtc], ['2020-01-01', Date.parse('2020-01-02T09:20:00Z')]);
  fail = false; await second.ensureLifetime().retry();
  assert.deepEqual(calls, [200]); assert.equal(second.session.current.utc, '2020-01-02T09:20:00Z');
  assert.equal(second.view.pendingLifetime, null);
});

test('failed transit loading retains its paused target and applies it on a successful retry', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore(); first.transit.scrub(0); first.view.flush();
  let fail = true; const second = harness(first.storage, { transitDay: async date => { if (fail) throw new Error('Offline'); return day(date); } });
  t.after(() => second.transit.stop()); await second.view.restore();
  const saved = JSON.parse(second.storage.get('liniya.view.v1')!);
  assert.equal(saved.transit.live, false); assert.equal(saved.transit.index, 0);
  fail = false; await second.transit.retry();
  assert.equal(second.transit.state.live, false); assert.equal(second.transit.current!.utc, '2026-10-04T00:00:00Z');
});

test('missing Lifetime module keeps its saved range for another reload', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const lifetime = first.ensureLifetime(); await lifetime.open(); await lifetime.setDateRange('2020-01-01', '2020-01-03'); await lifetime.scrub(Date.parse('2020-01-02T09:20:00Z')); first.view.flush();
  const second = harness(first.storage, { loadLifetime: async () => null }); t.after(() => second.transit.stop()); await second.view.restore();
  const saved = JSON.parse(second.storage.get('liniya.view.v1')!);
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


async function savePersonalLifetime(t: test.TestContext) {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const personalId = JSON.parse(first.storage.get('liniya.charts.v1')!)[0].id;
  first.session.select(personalId); await first.natalDay.open(); first.natalDay.scrub(800);
  first.exploration.restorePreview(true);
  const lifetime = first.ensureLifetime(); await lifetime.open();
  await lifetime.setDateRange('2020-01-01', '2020-01-03'); await lifetime.scrub(Date.parse('2020-01-02T09:20:00Z')); first.view.flush();
  return { storage: first.storage, personalId };
}

test('eligible personal Lifetime restores exact saved range and moment ahead of an opened natal-day preview', async t => {
  const { storage, personalId } = await savePersonalLifetime(t), calls: unknown[] = [];
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
  assert.equal(second.session.current.primary, second.session.baseChart);
  assert.equal(second.session.current.secondary, second.ensureLifetime().current);
  assert.equal(second.returns.current, null, 'an intermediate moment restores without inventing a return event');
});

test('delayed personal Lifetime metadata cannot overwrite the saved target with a borrowed day', async t => {
  const { storage } = await savePersonalLifetime(t), calls: unknown[] = []; let release;
  const second = harness(storage, { canRestoreLifetime: () => true, lifetimeClient: {
    getMeta: () => new Promise(resolve => { release = resolve; }), getPoint: async index => { calls.push(index); return point(index); } } });
  t.after(() => second.transit.stop()); const pending = second.view.restore();
  await new Promise<void>(resolve => setImmediate(resolve)); second.view.flush();
  assert.equal(second.writes.length, 0);
  const saved = JSON.parse(storage.get('liniya.view.v1')!);
  assert.deepEqual([saved.lifetime.fromDate, saved.lifetime.toDate, saved.lifetime.requestedUtc], ['2020-01-01', '2020-01-03', Date.parse('2020-01-02T09:20:00Z')]);
  release!(metadata); assert.equal(await pending, true); assert.deepEqual(calls, [200]);
});

test('navigation while personal Lifetime metadata is pending cancels restoration before any point', async t => {
  const { storage } = await savePersonalLifetime(t), calls: unknown[] = []; let release;
  const second = harness(storage, { canRestoreLifetime: () => true, lifetimeClient: {
    getMeta: () => new Promise(resolve => { release = resolve; }), getPoint: async index => { calls.push(index); return point(index); } } });
  t.after(() => second.transit.stop()); const pending = second.view.restore();
  await new Promise<void>(resolve => setImmediate(resolve));
  second.view.interrupt(); second.session.select('second');
  release!(metadata); assert.equal(await pending, false);
  assert.equal(second.session.selectedId, 'second'); assert.equal(second.ensureLifetime().state.opened, false);
  assert.deepEqual(calls, []);
});

test('personal Lifetime remains opt-in and a deleted saved personal chart cannot restore its lifetime', async t => {
  for (const missing of [false, true] as const) {
    const { storage, personalId } = await savePersonalLifetime(t);
    if (missing) storage.set('liniya.charts.v1', JSON.stringify(JSON.parse(storage.get('liniya.charts.v1')!).filter((chart: { id: string }) => chart.id !== personalId)));
    let loads = 0;
    const second = harness(storage, { ...(missing ? { canRestoreLifetime: () => true } : {}), loadLifetime: async () => { loads++; return null; } });
    t.after(() => second.transit.stop()); await second.view.restore();
    assert.equal(loads, 0); assert.equal(second.ensureLifetime().state.opened, false);
    assert.equal(JSON.parse(storage.get('liniya.view.v1')!).lifetime, null);
    assert.equal(second.session.selectedId, missing ? 'current-transit' : personalId);
  }
});


test('successful personal Lifetime restore acknowledges a UTC target clamped by the normalized lifespan', async t => {
  const { storage, personalId } = await savePersonalLifetime(t), calls: unknown[] = [];
  // The composition root normalizes a legacy custom range before restoration.
  // Its formerly selected moment can precede the newly fixed birth boundary.
  const saved = JSON.parse(storage.get('liniya.view.v1')!);
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
  const persisted = JSON.parse(storage.get('liniya.view.v1')!).lifetime;
  assert.deepEqual([persisted.fromDate, persisted.toDate, persisted.requestedUtc], ['2020-01-03', '2020-01-03', Date.parse('2020-01-03T00:00:00Z')]);
});


test('same-tab reload restores the exact personal return and transit navigation clears its ownership', async t => {
  const first = harness(undefined, { panelView: true }); t.after(() => first.transit.stop()); await first.view.restore();
  const source = JSON.parse(first.storage.get('liniya.charts.v1')!)[0];
  first.session.select(source.id); await first.returns.open(); await first.returns.selectEvent(first.returnEvent.id);
  first.view.flush(); const beforeLibrary = first.storage.get('liniya.charts.v1');
  const second = harness(first.storage); t.after(() => second.transit.stop()); await second.view.restore();
  assert.equal(second.session.selectedId, source.id);
  assert.equal(second.returns.state.opened, true); assert.equal(second.returns.state.selectedEvent!.id, first.returnEvent.id);
  assert.equal(second.view.pendingReturns, null);
  assert.equal(second.session.record!.id, source.id);
  assert.equal(second.session.current.primary, second.session.baseChart);
  assert.equal(chartCaption(second.session.current, second.session.record).title, source.name + ' · Возврат Сатурна 1');
  assert.equal(second.storage.get('liniya.charts.v1'), beforeLibrary);
  second.session.select('current-transit'); second.view.flush();
  assert.equal(second.session.current.primaryLabel, 'Транзит'); assert.equal(second.session.record, null); assert.equal(second.returns.current, null);
  assert.equal(JSON.parse(second.storage.get('liniya.view.v1')!).returns, undefined);
});

test('navigation during a restored exact return cannot resurrect its personal overlay', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const source = JSON.parse(first.storage.get('liniya.charts.v1')!)[0];
  first.session.select(source.id); await first.returns.open(); await first.returns.selectEvent(first.returnEvent.id); first.view.flush();
  let resolveChart, began: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const second = harness(first.storage, { returnsClient: {
    events: async (input: { body: string; }) => ({ events: input.body === 'saturn' ? [first.returnEvent] : [] }),
    chart: () => new Promise(resolve => { resolveChart = resolve; began(); }),
  } });
  t.after(() => second.transit.stop()); const restoring = second.view.restore(); await started;
  second.view.interrupt(); second.session.select('current-transit');
  resolveChart!({ event: first.returnEvent, chart: { ...source, utc: first.returnEvent.utc } }); await restoring;
  assert.equal(second.session.selectedId, 'current-transit'); assert.equal(second.returns.current, null);
  assert.equal(second.session.current.primaryLabel, 'Транзит'); assert.equal(second.session.record, null);
});


test('selected Saturn survives refresh after list changes to Year and the panel is closed', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const source = JSON.parse(first.storage.get('liniya.charts.v1')!)[0];
  first.session.select(source.id); await first.returns.open(); await first.returns.selectEvent(first.returnEvent.id);
  // The displayed selection remains independent from the list's active filter.
  await first.returns.setYear(2050); first.returns.close(); first.view.flush();
  const second = harness(first.storage); t.after(() => second.transit.stop()); await second.view.restore();
  assert.equal(second.returns.state.year, 2050); assert.equal(second.returns.state.opened, false);
  assert.equal(second.returns.state.selectedEvent!.id, first.returnEvent.id);
  assert.equal(second.session.current.secondary!.utc, first.returnEvent.utc);
});

const returnMetadata = { ...metadata, startUtc: '2026-01-01T00:00:00Z', endExclusiveUtc: '2127-01-01T00:00:00Z',
  samples: (Date.parse('2127-01-01T00:00:00Z') - Date.parse('2026-01-01T00:00:00Z')) / 600000 };
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
async function saveExactLifetime(t: test.TestContext) {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const source = JSON.parse(first.storage.get('liniya.charts.v1')!)[0];
  const event = { ...first.returnEvent, utc: '2055-10-01T12:03:07.123456Z', id: 'saturn:2055-10-01T12:03:07.123456Z' };
  Object.assign(first.returnEvent, event);
  first.session.select(source.id); await first.returns.open();
  assert.equal(await first.returns.selectEvent(event.id), true, 'save an event from the prepared authoritative list');
  await first.returns.setBodies(['moon']); first.returns.close(); first.view.flush();
  const snapshot = JSON.parse(first.storage.get('liniya.view.v1')!);
  snapshot.lifetime = { opened: true, mode: 'lifetime', fromDate: source.utc.slice(0, 10), toDate: '2126-09-24',
    requestedUtc: Date.parse(event.utc), personalPreview: false, personalLive: false };
  first.storage.set('liniya.view.v1', JSON.stringify(snapshot));
  return { storage: first.storage, source, event, target: snapshot.lifetime };
}

test('an old exact snapshot ignores its stale descriptor and restores from the current body list without rounded point work', async t => {
  const { storage, source, event, target } = await saveExactLifetime(t), points: unknown[] = [], lists: { input: CycleInput; resolve: (value: { events: CycleEvent[] }) => void }[] = [], order: unknown[] = [];
  const old = JSON.parse(storage.get('liniya.view.v1')!);
  old.returns.event = { ...event, cycle: 99, cycleId: 'saturn:99', pass: 9 };
  storage.set('liniya.view.v1', JSON.stringify(old));
  const refreshed = { ...event, pass: 2, direction: 'retrograde' as const };
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
  lists.find(job => job.input.body === event.body)!.resolve({ events: [refreshed] }); await nextTurn();
  assert.deepEqual(order, ['chart']);
  second.interactionTarget.dispatch('wheel', { target: second.cameraSurface }); second.camera.zoom(2);
  const pose = second.camera.getView();
  releaseChart!({ chart: { ...source, utc: event.utc } }); await nextTurn();
  assert.equal(restored, true, 'the other unfinished body lists cannot delay restoration');
  assert.equal(second.returns.state.selectedEvent, refreshed); assert.equal(await restoring, true);
  assert.deepEqual(order, ['chart', 'metadata']); assert.deepEqual(points, []);
  assert.equal(second.ensureLifetime().current!.utc, event.utc); assert.equal(second.session.current.utc, event.utc);
  assert.equal(second.ensureLifetime().state.requestedUtc, target.requestedUtc); assert.equal(second.ensureLifetime().state.displayedUtc, Date.parse(event.utc));
  assert.equal(second.returns.state.opened, false); assert.deepEqual(second.returns.state.bodies, ['moon']);
  assert.equal(second.view.pendingReturns, null); assert.equal(second.view.pendingLifetime, null);
  const savedReturns = JSON.parse(storage.get('liniya.view.v1')!).returns;
  assert.equal(savedReturns.eventId, 'saturn:2055-10-01T12:03:07.123456Z');
  assert.equal(Object.hasOwn(savedReturns, 'event'), false, 'a new snapshot retains the target without copying an event descriptor');
  assert.deepEqual(second.camera.getView(), pose);
  assert.equal(lists.length, DEFAULT_CYCLE_BODIES.length + 1, 'body preparation is shared with restoration and never duplicated');
  assert.deepEqual(second.returns.state.pendingBodies, ['moon'], 'the visible Moon list is still pending while the exact Saturn chart is ready');
});

test('navigation while a known return reloads prevents starting its saved Lifetime restoration', async t => {
  const { storage, source, event } = await saveExactLifetime(t); let releaseChart, metadataCalls = 0;
  const second = harness(storage, { canRestoreLifetime: () => true, lifetimeClient: {
    getMeta: async () => { metadataCalls++; return returnMetadata; }, getPoint: async index => point(index, returnMetadata),
  }, returnsClient: { events: async (input: { body: string; }) => ({ events: input.body === event.body ? [event] : [] }),
    chart: () => new Promise(resolve => { releaseChart = resolve; }),
  } });
  t.after(() => second.transit.stop()); const restoring = second.view.restore(); await nextTurn();
  assert.equal(metadataCalls, 0); assert.equal(typeof releaseChart, 'function');
  second.view.interrupt(); second.session.select('second');
  releaseChart!({ event, chart: { ...source, utc: event.utc } }); assert.equal(await restoring, false);
  assert.equal(metadataCalls, 0); assert.equal(second.returns.current, null);
  assert.equal(second.view.pendingLifetime, null); assert.equal(second.view.pendingReturns, null);
});

test('an early exact failure is not retried twice and metadata failure keeps its own pending target', async t => {
  for (const failure of ['chart', 'metadata'] as const) {
    const { storage, source, event, target } = await saveExactLifetime(t), points: unknown[] = []; let charts = 0;
    const second = harness(storage, { canRestoreLifetime: () => true, lifetimeClient: {
      getMeta: async () => { if (failure === 'metadata') throw Error('Metadata unavailable'); return returnMetadata; },
      getPoint: async index => { points.push(index); return point(index, returnMetadata); },
    }, returnsClient: { events: async (input: { body: string; }) => ({ events: input.body === event.body ? [event] : [] }), chart: async () => {
      charts++; if (failure === 'chart') throw Error('Exact unavailable'); return { event, chart: { ...source, utc: event.utc } };
    } } });
    t.after(() => second.transit.stop()); assert.equal(await second.view.restore(), false); assert.equal(charts, 1);
    if (failure === 'chart') {
      assert.equal(second.view.pendingReturns!.eventId, event.id); assert.equal(second.view.pendingLifetime, null);
      assert.deepEqual(points, [], 'an unavailable exact event does not calculate a hidden rounded substitute');
      assert.equal(second.session.current.primary, second.session.baseChart);
      assert.equal(second.session.current.utc, source.utc);
      assert.equal(second.exploration.momentState()!.current!.utc, source.utc);
      assert.equal(second.returns.state.chartError, 'Exact unavailable');
      assert.equal(JSON.parse(storage.get('liniya.view.v1')!).returns.eventId, event.id);
    } else {
      assert.equal(second.view.pendingLifetime!.requestedUtc, target.requestedUtc); assert.equal(second.view.pendingReturns, null);
      assert.deepEqual(points, []); assert.equal(second.session.current.utc, event.utc);
    }
  }
});

test('legacy return IDs restore through event lookup while the original remains accepted', async t => {
  const { storage, source, event } = await saveExactLifetime(t), order: unknown[] = [];
  const snapshot = JSON.parse(storage.get('liniya.view.v1')!);
  snapshot.returns = { ...snapshot.returns, group: 'major', year: 2055, body: 'saturn' }; delete snapshot.returns.bodies; storage.set('liniya.view.v1', JSON.stringify(snapshot));
  const second = harness(storage, { canRestoreLifetime: () => true, lifetimeClient: {
    getMeta: async () => returnMetadata, getPoint: async index => { order.push('point'); return point(index, returnMetadata); },
  }, returnsClient: { events: async (input: { body: string; }) => ({ events: input.body === event.body ? [event] : [] }),
    chart: async () => { order.push('chart'); return { event, chart: { ...source, utc: event.utc } }; },
  } });
  t.after(() => second.transit.stop()); assert.equal(await second.view.restore(), true);
  assert.deepEqual(order, ['chart']); assert.equal(second.session.current.utc, event.utc);
});


async function saveColdReturns(t: test.TestContext) {
  const first = harness(undefined, { panelView: true }); t.after(() => first.transit.stop()); await first.view.restore();
  const source = JSON.parse(first.storage.get('liniya.charts.v1')!)[0];
  first.session.select(source.id); await first.natalDay.open();
  // Older snapshots can contain a drawer before its lazy rail was created.
  first.natalDay.close(); await first.returns.open();
  first.eventTarget.dispatch('pagehide');
  const snapshot = JSON.parse(first.storage.get('liniya.view.v1')!);
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
  assert.equal(JSON.parse(storage.get('liniya.view.v1')!).lifetime.opened, true);
});


test('an open Returns menu owns restoration ahead of a stale natal Day snapshot', async t => {
  const storage = await saveColdReturns(t);
  const snapshot = JSON.parse(storage.get('liniya.view.v1')!);
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
  first.session.select(JSON.parse(first.storage.get('liniya.charts.v1')!)[0].id);
  await first.returns.open(); await first.returns.selectEvent(first.returnEvent.id);
  first.returns.close(); first.view.flush();
  const second = harness(first.storage, { canRestoreLifetime: () => true,
    openReturnsTimeline: async () => second.ensureLifetime().restore({ opened: true, mode: 'lifetime',
      fromDate: '2020-01-01', toDate: '2020-01-03', index: 144 }) });
  t.after(() => second.transit.stop());
  assert.equal(await second.view.restore(), true);
  assert.equal(second.returns.state.opened, false);
  assert.equal(second.returns.state.selectedEvent!.id, first.returnEvent.id);
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
  assert.equal(second.view.pendingReturns!.opened, true);
  const persisted = JSON.parse(storage.get('liniya.view.v1')!);
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
  await new Promise<void>(resolve => setImmediate(resolve));
  second.interactionTarget.dispatch('pointerdown', { target: second.cameraSurface });
  second.camera.zoom(2); second.camera.pan(30, 20);
  const pose = second.camera.getView();
  releaseMetadata!(metadata);
  assert.equal(await restoring, true);
  assert.equal(second.view.interrupted, false);
  assert.equal(second.ensureLifetime().state.requestedUtc, Date.parse('2020-01-02T09:20:00Z'));
  assert.equal(second.session.current.utc, '2020-01-02T09:20:00Z');
  assert.equal(second.session.current.kind, 'transit');
  assert.deepEqual(second.camera.getView(), pose);
  const persisted = JSON.parse(storage.get('liniya.view.v1')!);
  assert.equal(persisted.lifetime.requestedUtc, Date.parse('2020-01-02T09:20:00Z'));
  assert.equal(persisted.camera.k, 2);
});

test('wheel zoom during an exact return restoration keeps that event and the new camera position', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const source = JSON.parse(first.storage.get('liniya.charts.v1')!)[0];
  first.session.select(source.id); await first.returns.open();
  await first.returns.selectEvent(first.returnEvent.id); first.view.flush();
  let resolveChart, began: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const second = harness(first.storage, { returnsClient: {
    events: async (input: { body: string; }) => ({ events: input.body === 'saturn' ? [first.returnEvent] : [] }),
    chart: () => new Promise(resolve => { resolveChart = resolve; began(); }),
  } });
  t.after(() => second.transit.stop()); const restoring = second.view.restore(); await started;
  second.interactionTarget.dispatch('wheel', { target: second.cameraSurface }); second.camera.zoom(2);
  const pose = second.camera.getView();
  resolveChart!({ event: first.returnEvent, chart: { ...source, utc: first.returnEvent.utc } });
  assert.equal(await restoring, true);
  assert.equal(second.view.interrupted, false);
  assert.equal(second.returns.state.selectedEvent!.id, first.returnEvent.id);
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
  await new Promise<void>(resolve => setImmediate(resolve));
  second.view.interrupt();
  await second.ensureLifetime().scrub(Date.parse('2020-01-02T09:30:00Z')); releasePoint!(point(200));
  assert.equal(await restoring, false);
  assert.equal(second.view.interrupted, true);
  assert.equal(second.ensureLifetime().state.requestedUtc, Date.parse('2020-01-02T09:30:00Z'));
  assert.equal(second.session.current.utc, '2020-01-02T09:30:00Z');
});

test('restored personal live mode uses the shared minute timer and the new current minute', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { storage } = await savePersonalLifetime(t);
  const saved = JSON.parse(storage.get('liniya.view.v1')!);
  saved.lifetime.personalLive = true;
  saved.transit.live = false; saved.transit.index = 0;
  storage.set('liniya.view.v1', JSON.stringify(saved));
  let now = Date.parse('2026-10-04T12:07:00Z');
  const second = harness(storage, { canRestoreLifetime: () => true, getNow: () => now });
  t.after(() => second.transit.stop());
  await second.view.restore();
  assert.equal(second.transit.state.wanted, true);
  assert.equal(second.session.current.secondary!.utc, '2026-10-04T12:07:00Z');
  const current = second.session.current;
  assert.equal(second.session.current, current, 'reading the same minute reuses the composed overlay');
  now += 60000; t.mock.timers.tick(60025);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(second.session.current.secondary!.utc, '2026-10-04T12:08:00Z');
  assert.notEqual(second.session.current, current);
  second.view.flush();
  assert.equal(JSON.parse(storage.get('liniya.view.v1')!).lifetime.personalLive, true);
  assert.equal(JSON.parse(storage.get('liniya.view.v1')!).transit.live, true, 'following Now supersedes an older paused day');
});

test('failed personal live moment completes restoration while an unrelated day packet is still pending', async t => {
  const { storage } = await savePersonalLifetime(t);
  const saved = JSON.parse(storage.get('liniya.view.v1')!);
  saved.lifetime.personalLive = true;
  storage.set('liniya.view.v1', JSON.stringify(saved));
  const second = harness(storage, { canRestoreLifetime: () => true, zone: 'Europe/Moscow', transitDay: date =>
    date === '2026-10-04' ? Promise.reject(new Error('current minute unavailable')) : new Promise(() => {}) });
  t.after(() => second.transit.stop());
  assert.equal(await second.view.restore(), false, 'failure of the visible live moment releases the initial loading gate');
  assert.equal(second.transit.state.loading, true, 'the unused neighboring packet is still pending');
  assert.equal(second.session.hasCurrent, true, 'the saved natal chart remains available for recovery');
});

test('a paused personal lifetime reload never becomes live because its slider is near Now', async t => {
  const { storage } = await savePersonalLifetime(t);
  const saved = JSON.parse(storage.get('liniya.view.v1')!);
  saved.lifetime.personalLive = false;
  storage.set('liniya.view.v1', JSON.stringify(saved));
  const second = harness(storage, { canRestoreLifetime: () => true });
  t.after(() => second.transit.stop()); await second.view.restore();
  assert.equal(second.transit.state.wanted, false);
  assert.equal(second.session.current.utc, '2020-01-02T09:20:00Z');
  second.view.flush();
  assert.equal(JSON.parse(storage.get('liniya.view.v1')!).lifetime.personalLive, false);
});

const drain = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };

test('reload paints the paused minute first while the unrelated local-day packet is pending', async t => {
  const first = harness(undefined, { zone: 'Europe/Moscow' }); t.after(() => first.transit.stop());
  await first.view.restore(); first.transit.scrub(0); first.view.flush();
  let release; const requested: unknown[] = [];
  const second = harness(first.storage, { zone: 'Europe/Moscow', transitDay: date => {
    requested.push(date);
    return date === '2026-10-04' ? new Promise(resolve => { release = resolve; }) : Promise.resolve(day(date));
  } });
  t.after(() => second.transit.stop());
  const restoring = second.view.restore(); await drain();
  assert.deepEqual(requested, ['2026-10-03', '2026-10-04'], 'the target packet has priority');
  assert.deepEqual(second.frames, ['2026-10-03T21:00:00Z']);
  assert.equal(second.transit.state.live, false);
  release!(day('2026-10-04')); await restoring;
  assert.deepEqual(second.frames, ['2026-10-03T21:00:00Z'], 'neighbor completion never flashes Now');
});

test('lifetime reload requests only its saved point and switching back to Day starts the minute clock', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const lifetime = first.ensureLifetime(); await lifetime.open(); await lifetime.setDateRange('2020-01-01', '2020-01-03');
  await lifetime.scrub(Date.parse('2020-01-02T09:20:00Z')); first.view.flush();
  const requests: unknown[] = [], modes: unknown[] = [];
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
  const snapshot = JSON.parse(storage.get('liniya.view.v1')!);
  snapshot.lifetime.personalPreview = true; snapshot.lifetime.personalLive = false;
  snapshot.returns = { opened: true, group: 'major', year: 2026, body: 'saturn', eventId: null };
  storage.set('liniya.view.v1', JSON.stringify(snapshot));
  const pendingLists: ((value: { events: CycleEvent[] }) => void)[] = [];
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
  for (const key of ['Tab', 'Shift', 'Alt', 'Control', 'Meta', 'Escape', 'Enter', 'ArrowRight'] as const) {
    let release;
    const second = harness(new Map(storage), { canRestoreLifetime: () => true,
      loadLifetime: () => new Promise(resolve => { release = () => resolve(second.ensureLifetime()); }) });
    t.after(() => second.transit.stop());
    const restoring = second.view.restore(); await drain();
    second.interactionTarget.dispatch('keydown', { key, target: { id: 'chartTitle' } });
    assert.equal(second.view.interrupted, false, key);
    release!(); await restoring;
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
  assert.equal(JSON.parse(second.storage.get('liniya.view.v1')!).transit.live, false);
  assert.equal(JSON.parse(second.storage.get('liniya.view.v1')!).transit.index, 0);
});


test('a legacy lifetime index becomes UTC after metadata loads and never returns to new snapshots', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const saved = JSON.parse(first.storage.get('liniya.view.v1')!);
  saved.lifetime = { opened: true, mode: 'lifetime', fromDate: '2020-01-01', toDate: '2020-01-03', index: 200 };
  first.storage.set('liniya.view.v1', JSON.stringify(saved));
  const second = harness(first.storage); t.after(() => second.transit.stop());
  assert.equal(await second.view.restore(), true);
  assert.equal(second.session.current.utc, '2020-01-02T09:20:00Z');
  const persisted = JSON.parse(first.storage.get('liniya.view.v1')!).lifetime;
  assert.equal(persisted.requestedUtc, Date.parse('2020-01-02T09:20:00Z'));
  assert.equal('index' in persisted, false);
});


test('a saved lifetime minute restores its exact UTC before writing a fresh snapshot', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const saved = JSON.parse(first.storage.get('liniya.view.v1')!);
  saved.lifetime = { opened: true, mode: 'lifetime', fromDate: '2020-01-01', toDate: '2020-01-03',
    requestedUtc: Date.parse('2020-01-02T09:21:00Z') };
  first.storage.set('liniya.view.v1', JSON.stringify(saved));
  const minutes: unknown[] = [], points: unknown[] = [];
  const second = harness(first.storage, { lifetimeClient: { getMeta: async () => metadata,
    getPoint: async index => { points.push(index); return point(index); },
    getMoment: async utc => { minutes.push(utc); return transitChartAt(day('2020-01-02'), 561); },
  } });
  t.after(() => second.transit.stop());
  assert.equal(await second.view.restore(), true);
  assert.deepEqual(minutes, [Date.parse('2020-01-02T09:21:00Z')]); assert.deepEqual(points, []);
  assert.equal(second.session.current.utc, '2020-01-02T09:21:00Z');
  const persisted = JSON.parse(first.storage.get('liniya.view.v1')!).lifetime;
  assert.equal(persisted.requestedUtc, Date.parse('2020-01-02T09:21:00Z')); assert.equal('index' in persisted, false);
});


for (const personalPreview of [undefined, true] as const) test(`metadata retry consumes the legacy birth target for ${personalPreview ? 'an explicit lifetime sample' : 'the exact original'}`, async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const charts = JSON.parse(first.storage.get('liniya.charts.v1')!);
  charts[0].utc = '2026-09-24T12:34:56.789Z';
  first.storage.set('liniya.charts.v1', JSON.stringify(charts));
  const saved = JSON.parse(first.storage.get('liniya.view.v1')!);
  saved.selectedId = charts[0].id;
  saved.lifetime = { opened: true, mode: 'lifetime', fromDate: '2026-09-24', toDate: '2026-09-26', index: 75,
    personalLive: false, ...(personalPreview === undefined ? {} : { personalPreview }) };
  first.storage.set('liniya.view.v1', JSON.stringify(saved));
  const source = { ...metadata, startUtc: '2026-09-24T00:00:00Z', endExclusiveUtc: '2026-09-27T00:00:00Z' };
  let unavailable = true; const points: unknown[] = [];
  const second = harness(first.storage, { canRestoreLifetime: () => true,
    normalizeSavedView: view => ({ ...view, lifetime: { ...view!.lifetime!, minimumUtc: charts[0].utc } }),
    lifetimeClient: { getMeta: async () => { if (unavailable) throw Error('Metadata unavailable'); return source; },
      getPoint: async index => { points.push(index); return point(index, source); } },
  });
  t.after(() => second.transit.stop());
  assert.equal(await second.view.restore(), false);
  assert.equal(second.ensureLifetime().state.status, 'loading');
  assert.equal(second.ensureLifetime().state.retryCount, 1);
  assert.equal(second.view.pendingLifetime!.index, 75);
  assert.equal(JSON.parse(first.storage.get('liniya.view.v1')!).lifetime.index, 75, 'failed metadata cannot invent a UTC origin');
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
  const persisted = JSON.parse(first.storage.get('liniya.view.v1')!).lifetime;
  assert.equal(persisted.requestedUtc, Date.parse(utc)); assert.equal('index' in persisted, false);
  assert.equal(persisted.personalPreview, Boolean(personalPreview));
});


test('a ready matching range cannot consume a saved target before the loader returns its controller', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const lifetime = first.ensureLifetime(); await lifetime.open(); await lifetime.setDateRange('2020-01-01', '2020-01-03');
  await lifetime.scrub(Date.parse('2020-01-02T09:20:00Z')); first.view.flush();
  let second: ReturnType<typeof harness>;
  second = harness(first.storage, { loadLifetime: async () => {
    const available = second.ensureLifetime();
    await available.open(); await available.setDateRange('2020-01-01', '2020-01-03');
    await available.scrub(Date.parse('2020-01-02T08:00:00Z'));
    return null;
  } });
  t.after(() => second.transit.stop());
  assert.equal(await second.view.restore(), false);
  assert.equal(second.ensureLifetime().state.status, 'ready');
  assert.equal(second.view.pendingLifetime!.requestedUtc, Date.parse('2020-01-02T09:20:00Z'));
  assert.equal(JSON.parse(first.storage.get('liniya.view.v1')!).lifetime.requestedUtc, Date.parse('2020-01-02T09:20:00Z'));
});


for (const activation of ['pointerdown', 'Enter', ' '] as const) test(`Retry by ${activation === ' ' ? 'Space' : activation} retains a legacy target while metadata is pending and the page hides`, async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const saved = JSON.parse(first.storage.get('liniya.view.v1')!);
  saved.lifetime = { opened: true, mode: 'lifetime', fromDate: '2020-01-01', toDate: '2020-01-03', index: 200 };
  first.storage.set('liniya.view.v1', JSON.stringify(saved));
  const document = dateDom(), retryButton = document.createElement('button'), retryIcon = document.createElement('svg');
  retryButton.append(retryIcon);
  let attempts = 0, release; const points: unknown[] = [];
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
  const waiting = JSON.parse(first.storage.get('liniya.view.v1')!).lifetime;
  assert.ok(waiting, 'Retry is not a new moment choice and cannot erase the legacy target');
  assert.equal(waiting.index, 200); assert.equal(second.view.pendingLifetime!.index, 200);
  assert.equal(second.view.interrupted, false);
  release!(metadata); assert.equal(await retry, true); second.view.flush();
  assert.deepEqual(points, [200]); assert.equal(second.session.current.utc, '2020-01-02T09:20:00Z');
  assert.equal(second.view.pendingLifetime, null);
  const ready = JSON.parse(first.storage.get('liniya.view.v1')!).lifetime;
  assert.equal(ready.requestedUtc, Date.parse('2020-01-02T09:20:00Z')); assert.equal('index' in ready, false);
});

test('choosing another person during a retried metadata request still supersedes the saved target', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const saved = JSON.parse(first.storage.get('liniya.view.v1')!);
  saved.lifetime = { opened: true, mode: 'lifetime', fromDate: '2020-01-01', toDate: '2020-01-03', index: 200 };
  first.storage.set('liniya.view.v1', JSON.stringify(saved));
  const document = dateDom(), retryButton = document.createElement('button');
  let attempts = 0, release; const points: unknown[] = [];
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
  assert.equal(JSON.parse(first.storage.get('liniya.view.v1')!).lifetime, null);
  release!(metadata); assert.equal(await retry, false); second.view.flush();
  assert.equal(second.session.selectedId, 'second'); assert.equal(second.session.current, selected);
  assert.deepEqual(points, []); assert.equal(JSON.parse(first.storage.get('liniya.view.v1')!).lifetime, null);
});

for (const phase of ['import', 'metadata'] as const) for (const [id, activation] of [
  ['openLibrary', 'pointerdown'], ['openKnowledge', 'Enter'], ['togglePerformance', ' '],
  ['chartTitle', 'pointerdown'], ['topbar-empty-space', 'pointerdown'],
] as const) test(`passive ${id} activation during lifetime ${phase} preserves the saved UTC through pagehide`, async t => {
  const target = Date.parse('2020-01-02T09:20:00Z');
  const saved = { version: 1, selectedId: 'current-transit', mandala: false,
    lifetime: { opened: true, mode: 'lifetime', fromDate: '2020-01-01', toDate: '2020-01-03', requestedUtc: target } };
  const storage = new Map([['liniya.view.v1', JSON.stringify(saved)]]);
  const document = dateDom(), control = document.createElement('button'), icon = document.createElement('svg');
  control.id = id; control.append(icon);
  let release, dayRequests = 0; const points: unknown[] = [];
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
  const waiting = JSON.parse(storage.get('liniya.view.v1')!).lifetime;
  release!();
  assert.equal(await restoring, true, 'opening an auxiliary tool cannot abandon the lifetime owner without a chart');
  assert.equal(h.view.interrupted, false); assert.equal(waiting?.requestedUtc, target);
  assert.equal(h.session.hasCurrent, true); assert.equal(h.session.current.utc, '2020-01-02T09:20:00Z');
  assert.equal(h.ensureLifetime().state.opened, true); assert.equal(h.view.pendingLifetime, null);
  assert.equal(h.transit.state.wanted, false); assert.equal(dayRequests, 0); assert.deepEqual(points, [200]);
  h.view.flush(); assert.equal(JSON.parse(storage.get('liniya.view.v1')!).lifetime.requestedUtc, target);
});

for (const action of ['choose-chart', 'lifetime-off'] as const) test(`passive tools do not exempt ${action} from superseding lifetime restoration`, async t => {
  const storage = new Map([['liniya.view.v1', JSON.stringify({ version: 1, selectedId: 'current-transit',
    lifetime: { opened: true, mode: 'lifetime', fromDate: '2020-01-01', toDate: '2020-01-03', requestedUtc: Date.parse('2020-01-02T09:20:00Z') } })]]);
  const document = dateDom(), passive = document.createElement('button'), choice = document.createElement('button');
  passive.id = 'openLibrary'; choice.id = action === 'lifetime-off' ? 'lifetimeToggle' : '';
  if (action === 'choose-chart') choice.dataset.chartId = 'second';
  let release; const points: unknown[] = [];
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
  release!(); assert.equal(await restoring, false); await nextTurn();
  assert.equal(h.view.interrupted, true); assert.equal(h.view.pendingLifetime, null);
  assert.equal(h.ensureLifetime().state.opened, false); assert.deepEqual(points, []);
  assert.equal(h.session.selectedId, action === 'choose-chart' ? 'second' : 'current-transit');
  assert.equal(h.session.hasCurrent, true);
  assert.equal(h.transit.state.wanted, action === 'lifetime-off');
  h.view.flush(); assert.equal(JSON.parse(storage.get('liniya.view.v1')!).lifetime, null);
});

test('closed return filters survive a reload of the personal rail without an exact event', async t => {
  const first = harness(new Map(), { canRestoreLifetime: () => true, lifetimeClient: {
    getMeta: async () => returnMetadata, getPoint: async index => point(index, returnMetadata),
  } });
  t.after(() => first.transit.stop()); await first.view.restore();
  const source = JSON.parse(first.storage.get('liniya.charts.v1')!)[0]; first.session.select(source.id);
  await first.exploration.openTimeline(); await first.returns.setBodies([]); await first.returns.setYear(2050);
  first.returns.close(); first.view.flush();
  const saved = JSON.parse(first.storage.get('liniya.view.v1')!);
  assert.deepEqual(saved.returns, { opened: false, bodies: [], year: 2050, eventId: null });
  const calls: CycleInput[] = [];
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
    events: async (input: { body: string; }) => ({ events: input.body === event.body ? [event] : [] }),
    chart: (input, signal) => { chartSignal = signal; return new Promise(resolve => { releaseChart = resolve; }); },
  } });
  t.after(() => second.transit.stop()); const restoring = second.view.restore(); await nextTurn();
  await second.returns.setBodies([]); await second.returns.setYear(2060);
  assert.equal(chartSignal!.aborted, false);
  releaseChart!({ event, chart: { ...source, utc: event.utc } }); assert.equal(await restoring, true);
  assert.equal(second.session.current.utc, event.utc); assert.equal(second.returns.state.selectedEvent!.id, event.id);
  second.view.flush(); const saved = JSON.parse(storage.get('liniya.view.v1')!).returns;
  assert.deepEqual(saved.bodies, []); assert.equal(saved.year, 2060); assert.equal(saved.eventId, event.id);
});


test('reload preserves an empty start and its selected UTC moment', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const lifetime = first.ensureLifetime(); await lifetime.open(); await lifetime.setDateRange(null, '2020-01-03');
  await lifetime.scrub(Date.parse('2020-01-02T09:20:00Z')); first.view.flush();
  const second = harness(first.storage); t.after(() => second.transit.stop()); await second.view.restore();
  const restored = second.ensureLifetime();
  assert.equal(restored.state.openStart, true); assert.equal(restored.state.fromDate, '2020-01-01');
  assert.equal(restored.state.toDate, '2020-01-03'); assert.equal(restored.state.minUtc, Date.parse('2020-01-01T00:00:00Z'));
  assert.equal(restored.state.requestedUtc, Date.parse('2020-01-02T09:20:00Z'));
  assert.equal(second.view.pendingLifetime, null);
});


test('panel state survives chart selection and reload and is restored before the camera is fitted', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  first.panels.restore({ left: true, right: true });
  first.session.select('second'); first.view.flush();
  const second = harness(first.storage); t.after(() => second.transit.stop());
  const restoreView = second.camera.restoreView;
  let seenAtFit;
  second.camera.restoreView = (...args) => { seenAtFit = second.panels.snapshot; return restoreView(...args); };
  await second.view.restore();
  assert.deepEqual(second.panels.snapshot, { left: true, right: true });
  assert.deepEqual(seenAtFit, { left: true, right: true });
  assert.equal(second.session.selectedId, 'second');
});

test('reload preserves an elevated camera limit needed after a panel has narrowed the view', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  const home = first.camera.getFittedView();
  first.camera.setView({ x: home.x, y: home.y, k: 6 }, { maxScale: 7 });
  first.view.flush();
  const second = harness(first.storage); t.after(() => second.transit.stop()); await second.view.restore();
  assert.equal(second.camera.getView().k, 6);
  assert.equal(second.camera.maximumScale(), 7);
});


for (const delayed of ['events', 'return'] as const) for (const reopen of [false, true] as const) {
  test(`a right-panel command during ${delayed} restoration preserves the exact return (reopen: ${reopen})`, async t => {
    const first = harness(undefined, { panelView: true }); t.after(() => first.transit.stop()); await first.view.restore();
    const source = JSON.parse(first.storage.get('liniya.charts.v1')!)[0];
    first.session.select(source.id); first.summary!.open(); await first.returns.open(); await first.returns.selectEvent(first.returnEvent.id); first.view.flush();
    let release;
    const second = harness(first.storage, { panelView: true, returnsClient: {
      events: (input: { body: string; }) => {
        const result = { events: input.body === 'saturn' ? [first.returnEvent] : [] };
        return delayed === 'events' && input.body === 'saturn'
          ? new Promise(done => { release = () => done(result); }) : Promise.resolve(result);
      },
      chart: input => {
        const result = { event: first.returnEvent,
          chart: { ...source, utc: input.eventUtc, personality: [2, 14], design: [3, 60] } };
        return delayed === 'return' ? new Promise(done => { release = () => done(result); }) : Promise.resolve(result);
      },
    } });
    t.after(() => second.transit.stop());
    const restoring = second.view.restore(); await new Promise(done => setImmediate(done));
    assert.equal(typeof release, 'function');
    second.summary!.close();
    if (reopen) second.summary!.open();
    release!();
    assert.equal(await restoring, true);
    assert.equal(second.view.interrupted, false);
    assert.equal(second.returns.state.selectedEvent?.id, first.returnEvent.id);
    assert.equal(second.session.current.utc, first.returnEvent.utc);
    assert.equal(second.summary!.screen, reopen ? 'returns' : 'closed');
    assert.equal(second.returns.opened, true, 'the shell command preserves the saved Returns screen');
    const saved = JSON.parse(second.storage.get('liniya.view.v1')!);
    assert.equal(saved.panels.right, reopen); assert.equal(saved.returns.opened, true);
    assert.equal(saved.returns.eventId, first.returnEvent.id);
  });
}


test('reload restores the workspace before fitting the retained chart camera', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  first.session.select('second'); first.camera.zoom(2); first.camera.pan(35, 20);
  first.panels.restore({ left: true, right: true }); first.workspace.setScreen('charts'); first.view.flush();
  const pose = first.camera.getView(), second = harness(first.storage); t.after(() => second.transit.stop());
  const restoreView = second.camera.restoreView; let seenAtFit;
  second.camera.restoreView = (...args) => { seenAtFit = second.workspace.screen; return restoreView(...args); };
  await second.view.restore();
  assert.equal(seenAtFit, 'charts'); assert.equal(second.workspace.screen, 'charts');
  assert.equal(second.session.selectedId, 'second');
  for (const key of ['x', 'y', 'k'] as const) assert.ok(Math.abs(second.camera.getView()[key] - pose[key]) < 1e-9, `retained camera ${key}`);
  assert.deepEqual(second.panels.snapshot, { left: true, right: true });
  assert.equal(JSON.parse(second.storage.get('liniya.view.v1')!).workspace, 'charts');
});

test('changing workspace during a pending reload keeps the new screen and finishes the saved moment', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  first.transit.scrub(0); first.workspace.setScreen('library'); first.view.flush();
  let release;
  const second = harness(first.storage, { transitDay: date => new Promise(done => { release = () => done(day(date)); }) });
  t.after(() => second.transit.stop()); const restoring = second.view.restore();
  assert.equal(second.workspace.screen, 'library');
  second.workspace.setScreen('account'); second.view.schedule();
  release!(); assert.equal(await restoring, true);
  assert.equal(second.workspace.screen, 'account'); assert.equal(second.view.interrupted, false);
  assert.equal(second.transit.current!.utc, '2026-10-04T00:00:00Z');
  const saved = JSON.parse(second.storage.get('liniya.view.v1')!);
  assert.equal(saved.workspace, 'account'); assert.equal(saved.transit.index, 0); assert.equal(saved.transit.live, false);
});


test('panel commands before app restore survive the same owner being restored again', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  first.panels.restore({ left: false, right: true }); first.view.flush();
  const second = harness(first.storage); t.after(() => second.transit.stop());
  second.panels.restore({ left: false, right: true });
  second.panels.beginRestore();
  second.panels.setLeft(true); second.panels.setRight(false);
  const restoreView = second.camera.restoreView;
  let seenAtFit;
  second.camera.restoreView = (...args) => { seenAtFit = second.panels.snapshot; return restoreView(...args); };
  assert.equal(await second.view.restore(), true);
  assert.deepEqual(seenAtFit, { left: true, right: false });
  assert.deepEqual(second.panels.snapshot, { left: true, right: false });
  assert.deepEqual(JSON.parse(second.storage.get('liniya.view.v1')!).panels, { left: true, right: false });
  assert.equal(second.panels.restoring, false);
  assert.equal(second.panels.rightRequestDuringRestore, null);
});


test('an already restored startup camera is retained after early panel interaction and full restoration', async t => {
  const saved = { version: 1, selectedId: 'current-transit', panels: { left: false, right: true }, camera: { x: -50, y: -50, k: 1.5 } };
  const h = harness(new Map([['liniya.view.v1', JSON.stringify(saved)]]), { cameraRestored: true });
  t.after(() => h.transit.stop());
  h.panels.restore(saved.panels); h.camera.restoreView(saved.camera);
  h.panels.beginRestore(); h.panels.setLeft(true); h.panels.setRight(false);
  // Startup already adapted this same camera to the newly chosen free area.
  h.camera.zoom(1.2); h.camera.pan(-20, -30);
  const prepared = h.camera.getView();
  assert.equal(await h.view.restore(), true);
  assert.deepEqual(h.panels.snapshot, { left: true, right: false });
  assert.deepEqual(h.camera.getView(), prepared, 'restoration does not reapply the old saved transform after handoff');
});


test('presentation persistence waits until synchronous restoration has applied the saved view', async t => {
  const first = harness(); t.after(() => first.transit.stop()); await first.view.restore();
  first.mandala.setEnabled(true, { animate: false }); first.camera.zoom(2); first.view.flush();
  const encoded = first.storage.get('liniya.view.v1');
  const second = harness(first.storage); t.after(() => second.transit.stop());
  second.view.schedule(); second.tick(); second.eventTarget.dispatch('pagehide');
  assert.equal(first.storage.get('liniya.view.v1'), encoded, 'default owners before restore cannot erase the saved pose');
  assert.equal(second.writes.length, 0);
  await second.view.restore();
});

for (const flushBy of ['timer', 'pagehide', 'visibilitychange'] as const) test(`loading ${flushBy} persists only current presentation while preserving the pending exact range and filters`, async t => {
  const { storage } = await savePersonalLifetime(t);
  const saved = JSON.parse(storage.get('liniya.view.v1')!);
  saved.planets = { selectedPlanets: ['moon'], selectedDesignPlanets: ['sun'] };
  saved.returns = { opened: false, bodies: ['saturn'], year: null, eventId: null };
  storage.set('liniya.view.v1', JSON.stringify(saved));
  const encoded = storage.get('liniya.view.v1');
  let release;
  const second = harness(storage, { canRestoreLifetime: () => true, lifetimeClient: {
    getMeta: () => new Promise(resolve => { release = resolve; }), getPoint: async index => point(index),
  } });
  t.after(() => second.transit.stop());
  const restoring = second.view.restore(); await nextTurn();
  assert.equal(typeof release, 'function');
  second.camera.zoom(1.4); second.camera.pan(20, 10);
  second.mandala.setEnabled(true, { animate: false });
  second.panels.setLeft(true); second.panels.setRight(true); second.workspace.setScreen('account');
  second.view.schedule();
  assert.equal(storage.get('liniya.view.v1'), encoded, 'many changes are coalesced before the pending flush');
  if (flushBy === 'timer') second.tick();
  else if (flushBy === 'pagehide') second.eventTarget.dispatch('pagehide');
  else { second.interactionTarget.hidden = true; second.interactionTarget.dispatch('visibilitychange'); }
  const pending = JSON.parse(storage.get('liniya.view.v1')!);
  assert.equal(pending.mandala, true);
  assert.deepEqual(pending.panels, { left: true, right: true });
  assert.equal(pending.workspace, 'account');
  assert.ok(Math.abs(pending.camera.k - 1.4) < 1e-9);
  assert.notEqual(pending.camera.x, saved.camera.x);
  assert.notEqual(pending.camera.y, saved.camera.y);
  for (const key of ['selectedId', 'lifetime', 'transit', 'natalDay', 'planets', 'returns'] as const)
    assert.deepEqual(pending[key], saved[key], `${key} keeps the accepted target, not a partially initialized owner`);
  assert.equal(second.view.interrupted, false);
  const pose = second.camera.getView();
  release!(metadata); assert.equal(await restoring, true);
  assert.deepEqual(second.camera.getView(), pose);
  assert.equal(second.mandala.enabled, true);
  assert.equal(second.workspace.screen, 'account');
  assert.equal(second.ensureLifetime().state.requestedUtc, saved.lifetime.requestedUtc);
});


for (const personal of [false, true] as const) for (const flushBy of ['flush', 'pagehide'] as const) {
  test(`pending ${personal ? 'personal' : 'transit'} timeline import retains its opening through ${flushBy}`, async t => {
    let release;
    const h = harness(new Map(), { loadLifetime: () => new Promise(resolve => { release = resolve; }) });
    t.after(() => h.transit.stop());
    await h.view.restore();
    if (personal) h.session.select('saved-person');
    const libraryBefore = h.storage.get('liniya.charts.v1');
    h.view.interrupt();
    const opening = personal ? h.exploration.toggleReturns() : h.exploration.toggleTransit();
    h.camera.zoom(1.4);
    if (flushBy === 'flush') h.view.flush();
    else h.eventTarget.dispatch('pagehide');
    const saved = JSON.parse(h.storage.get('liniya.view.v1')!);
    assert.equal(saved.lifetime?.opened, true, 'the selected tool survives even before its controller exists');
    assert.equal(saved.lifetime.mode, personal ? 'lifetime' : 'day');
    if (personal) {
      assert.equal(saved.lifetime.fromDate, '2026-09-24');
      assert.equal(saved.lifetime.requestedUtc, Date.parse('2026-09-24T12:34:00Z'));
      assert.equal(saved.lifetime.personalPreview, false, 'opening at birth retains the exact original chart');
    }
    assert.ok(Math.abs(saved.camera.k - 1.4) < 1e-9);
    assert.equal(h.storage.get('liniya.charts.v1'), libraryBefore, 'an opening changes only tab presentation');
    h.exploration.closeScales();
    h.eventTarget.dispatch('pagehide');
    assert.equal(JSON.parse(h.storage.get('liniya.view.v1')!).lifetime, null, 'closing before import cancels the saved opening');
    release!(null); assert.equal(await opening, false);
    h.view.flush();
    assert.equal(JSON.parse(h.storage.get('liniya.view.v1')!).lifetime, null, 'late import completion cannot restore the canceled intent');
  });
}


for (const command of ['none', 'open', 'open-close'] as const) {
  test(`saved closed right shell preserves the active Returns screen through a late exact result (${command})`, async t => {
    const first = harness(undefined, { panelView: true });
    t.after(() => first.transit.stop()); await first.view.restore();
    const source = JSON.parse(first.storage.get('liniya.charts.v1')!)[0];
    first.session.select(source.id); await first.returns.open();
    await first.returns.selectEvent(first.returnEvent.id); first.view.flush();
    const snapshot = JSON.parse(first.storage.get('liniya.view.v1')!);
    snapshot.panels = { left: true, right: false };
    assert.equal(snapshot.returns.opened, true, 'preview retained the old menu content but closed its shell');
    first.storage.set('liniya.view.v1', JSON.stringify(snapshot));
    const libraryBefore = first.storage.get('liniya.charts.v1');
    let release;
    const second = harness(first.storage, { panelView: true, returnsClient: {
      events: async (input: { body: string; }) => ({ events: input.body === 'saturn' ? [first.returnEvent] : [] }),
      chart: input => new Promise(done => { release = () => done({ event: first.returnEvent,
        chart: { ...source, utc: input.eventUtc, personality: [2, 14], design: [3, 60] } }); }),
    } });
    t.after(() => second.transit.stop());
    const restoring = second.view.restore(); await nextTurn();
    assert.equal(typeof release, 'function');
    assert.equal(second.panels.right, false, 'restoring chart data cannot reopen the saved closed shell');
    assert.equal(second.returns.opened, true, 'restoration retains the active screen behind the closed shell');
    if (command !== 'none') second.summary!.open();
    if (command === 'open-close') second.summary!.close();
    release!(); assert.equal(await restoring, true);
    assert.equal(second.summary!.screen, command === 'open' ? 'returns' : 'closed');
    assert.equal(second.returns.opened, true);
    assert.equal(second.returns.state.selectedEvent!.id, first.returnEvent.id);
    assert.equal(second.session.current.utc, first.returnEvent.utc);
    const saved = JSON.parse(second.storage.get('liniya.view.v1')!);
    assert.equal(saved.panels.right, command === 'open');
    assert.equal(saved.returns.opened, true);
    assert.equal(saved.returns.eventId, first.returnEvent.id);
    assert.equal(second.storage.get('liniya.charts.v1'), libraryBefore);
  });
}

test('legacy Returns snapshots without panel visibility still restore their open menu', async t => {
  const first = harness(undefined, { panelView: true });
  t.after(() => first.transit.stop()); await first.view.restore();
  first.session.select('saved-person'); await first.returns.open();
  await first.returns.selectEvent(first.returnEvent.id); first.view.flush();
  const snapshot = JSON.parse(first.storage.get('liniya.view.v1')!);
  delete snapshot.panels;
  first.storage.set('liniya.view.v1', JSON.stringify(snapshot));
  const second = harness(first.storage, { panelView: true });
  t.after(() => second.transit.stop());
  assert.equal(await second.view.restore(), true);
  assert.equal(second.summary!.screen, 'returns');
  assert.equal(second.returns.state.selectedEvent!.id, first.returnEvent.id);
});


test('search and article survive chart restoration, pagehide and a still-unloaded library', async t => {
  const knowledge = { query: 'красное', searchOpen: true, collection: 'gates', entryId: 'concept.personality-design', view: 'article' as const };
  let charts = { query: 'Анна', searchOpen: true };
  let ready!: (value: TransitDay) => void;
  const storage = new Map([['liniya.view.v1', JSON.stringify({ version: 1, selectedId: 'current-transit', knowledge, charts })]]);
  const h = harness(storage, { getChartsView: () => charts, transitDay: () => new Promise(resolve => { ready = resolve; }) });
  t.after(() => h.transit.stop());
  const restore = h.view.restore();
  charts = { query: '', searchOpen: false };
  h.view.flush();
  let saved = JSON.parse(storage.get('liniya.view.v1')!);
  assert.deepEqual(saved.knowledge, knowledge, 'an unmounted library must retain its saved article');
  assert.deepEqual(saved.charts, charts, 'new page input survives an unrelated chart loading');
  ready(day('2026-10-04')); await restore;
  h.eventTarget.dispatch('pagehide');
  saved = JSON.parse(storage.get('liniya.view.v1')!);
  assert.deepEqual(saved.knowledge, knowledge);
  assert.deepEqual(saved.charts, charts);
  const nextKnowledge = { ...knowledge, query: '', entryId: 'gate.8', view: 'catalog' as const };
  const next = harness(storage, { getKnowledgeView: () => nextKnowledge, getChartsView: () => charts });
  t.after(() => next.transit.stop()); await next.view.restore(); next.view.flush();
  assert.deepEqual(JSON.parse(storage.get('liniya.view.v1')!).knowledge, nextKnowledge);
});
