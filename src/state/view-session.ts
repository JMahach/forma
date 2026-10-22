import type { ChartStore } from '../data/chart-store.ts';
import type { SavedView, SavedLifetimeView, ViewStore } from '../data/view-store.ts';
import type { Camera } from '../scene/camera.ts';
import type { MandalaMode } from '../scene/modes/mandala.ts';
import type { ChartSession } from './chart-session.ts';
import type { LiveTransit } from './live-transit.ts';
import type { NatalDayExplorer } from './natal-day.ts';
import type { LifetimeExplorer, LifetimeState, LifetimeTarget } from './lifetime.ts';
import type { ReturnsController } from './returns.ts';
import type { PanelState } from './panels.ts';
import type { WorkspaceState } from './workspace.ts';
import type { TransitPlanetFilter } from './transit-planets.ts';
export type ViewSession = ReturnType<typeof createViewSession>;
interface ViewSessionOptions {
  store: Pick<ViewStore, 'write'> & { read: () => Partial<SavedView> | null };
  chartStore: ChartStore;
  session: ChartSession;
  mandala: MandalaMode;
  camera: Pick<Camera, 'getView' | 'getFittedView' | 'maximumScale' | 'restoreView'>;
  cameraRestored?: boolean;
  panels?: PanelState;
  workspace?: WorkspaceState;
  getPhoneSheetMode?: () => SavedView['phoneSheetMode'];
  transit: LiveTransit;
  natalDay: NatalDayExplorer;
  planetFilter: TransitPlanetFilter;
  getPersonalPreview?: () => boolean | undefined;
  getReturns?: () => ReturnsController | null;
  getLifetime?: () => LifetimeExplorer | null;
  loadLifetime?: () => Promise<LifetimeExplorer | null>;
  getLifetimeIntent?: () => LifetimeTarget | null;
  getPersonalLive?: () => boolean | undefined;
  restorePersonalLive?: (value: boolean) => void;
  restorePersonalPreview?: (value: boolean | undefined, target: SavedLifetimeView) => void;
  openReturnsTimeline?: () => Promise<unknown>;
  acceptLifetimeMode?: (state: Pick<LifetimeState, 'opened' | 'mode'>) => void;
  canRestoreLifetime?: () => boolean;
  eventTarget?: EventTarget | null;
  interactionTarget?: (EventTarget & { hidden: boolean }) | null;
  schedule?: typeof globalThis.setTimeout;
  cancel?: typeof globalThis.clearTimeout;
  delay?: number;
}

import { resolveSelectedChartId } from './chart-session.ts';

// One restoration transaction connects existing state owners. Initialization
// cannot overwrite the previous page; explicit moment commands supersede pending work.
export function createViewSession({
  store, chartStore, session, mandala, camera, cameraRestored = false, panels, workspace, getPhoneSheetMode = () => undefined, transit, natalDay, planetFilter,
  getPersonalPreview = () => undefined, getReturns = () => null, getLifetime = () => null, loadLifetime = async () => null,
  getLifetimeIntent = () => null,
  getPersonalLive = () => undefined, restorePersonalLive = () => {}, restorePersonalPreview = () => {},
  openReturnsTimeline = async () => null, acceptLifetimeMode = () => {},
  canRestoreLifetime = () => session.selectedId === 'current-transit',
  eventTarget = globalThis.window, interactionTarget = globalThis.document,
  schedule: defer = globalThis.setTimeout, cancel = globalThis.clearTimeout, delay = 160,
}: ViewSessionOptions) {
  const saved = store.read();
  let restoring = true, restoreInitialized = false, interrupted = false, generation = 0, pending: ReturnType<typeof globalThis.setTimeout> | null = null;
  let pendingTransit = saved?.transit?.live === false ? saved.transit : null;
  let pendingLifetime = saved?.lifetime || null, startedLifetime: SavedLifetimeView | null = null;
  let pendingReturns = saved?.returns || null;
  // The tab's saved shell owns visibility, including a close made in preview.
  // Retain the exact event and filters; old snapshots without panels keep their menu intent.
  if (saved?.panels?.right === false && pendingReturns) pendingReturns = { ...pendingReturns, opened: false };
  let pendingNatal = saved?.natalDay?.opened ? saved.natalDay : null;
  function lifetimeUtc(target: SavedLifetimeView | null, lifetimeState: LifetimeState | undefined) {
    if (Number.isFinite(target?.requestedUtc)) return target!.requestedUtc!;
    // A legacy index has meaning only after the lifetime supplies its origin.
    if (Number.isSafeInteger(target?.index) && lifetimeState?.metadata) {
      return Date.parse(lifetimeState.metadata.startUtc) + target!.index! * lifetimeState.metadata.stepSeconds * 1000;
    }
    return null;
  }
  function applyPending() {
    if (pendingNatal && session.selectedId === saved!.selectedId && natalDay.state.status === 'ready' && natalDay.state.opened) {
      const target = pendingNatal; pendingNatal = null;
      if (!target.exactOriginal) natalDay.scrub(target.index);
    }
    const lifetimeState = getLifetime()?.state;
    // The explorer alone normalizes legacy indices and exact birth bounds.
    // Its ready result acknowledges this started restoration, including retry;
    // a pre-existing ready range cannot consume a target we have not sent yet.
    if (pendingLifetime && pendingLifetime === startedLifetime && lifetimeState?.opened
        && lifetimeState.status === 'ready' && lifetimeState.mode === pendingLifetime.mode
        && (lifetimeState.mode === 'day' || (pendingLifetime.openStart ? lifetimeState.openStart : lifetimeState.fromDate === pendingLifetime.fromDate)
          && (pendingLifetime.openEnded ? lifetimeState.openEnded : lifetimeState.toDate === pendingLifetime.toDate))) pendingLifetime = null;
  }
  function presentationSnapshot() {
    const view = camera.getView(), home = camera.getFittedView();
    const phoneSheetMode = getPhoneSheetMode() ?? saved?.phoneSheetMode;
    return {
      ...(phoneSheetMode ? { phoneSheetMode } : {}),
      mandala: mandala.enabled,
      ...(panels ? { panels: panels.snapshot } : {}),
      ...(workspace ? { workspace: workspace.snapshot } : {}),
      camera: { x: (view.x - home.x) / home.k, y: (view.y - home.y) / home.k, k: view.k / home.k,
        ...(camera.maximumScale ? { maxK: camera.maximumScale() / home.k } : {}) },
    };
  }
  function snapshot(): SavedView {
    const personalPreview = getPersonalPreview();
    const personalLive = getPersonalLive();
    const cycles = getReturns()?.state;
    const returnView = pendingReturns || (cycles?.available && (cycles.opened || cycles.markersEnabled || cycles.selectedEvent) ? { opened: cycles.opened, bodies: [...cycles.bodies], year: cycles.year, eventId: cycles.selectedEvent?.id || null } : null);
    const lifetimeState = getLifetime()?.state, day = natalDay.state, live = transit.state;
    const pendingUtc = lifetimeUtc(pendingLifetime, lifetimeState);
    const lifetimeTarget = pendingLifetime && Number.isFinite(pendingUtc)
      ? Object.fromEntries(Object.entries({ ...pendingLifetime, requestedUtc: pendingUtc }).filter(([key]) => key !== 'index')) as unknown as SavedLifetimeView : pendingLifetime;
    return {
      version: 1, ...(returnView ? { returns: returnView } : {}), selectedId: session.selectedId,
      ...presentationSnapshot(),
      lifetime: lifetimeTarget || getLifetimeIntent() || (lifetimeState?.opened ? { opened: true, mode: lifetimeState.mode, fromDate: lifetimeState.fromDate, toDate: lifetimeState.toDate, ...(Number.isFinite(lifetimeState.requestedUtc) ? { requestedUtc: lifetimeState.requestedUtc! } : {}), ...(lifetimeState.openStart ? { openStart: true } : {}), ...(lifetimeState.openEnded ? { openEnded: true } : {}), ...(typeof personalPreview === 'boolean' ? { personalPreview } : {}), ...(typeof personalLive === 'boolean' ? { personalLive } : {}) } : null),
      transit: pendingTransit || (live.timeline ? { live: live.live, date: live.timeline.date, timeZone: live.timeline.timeZone, index: live.index } : null),
      natalDay: pendingNatal || { opened: day.opened, exactOriginal: day.exactOriginal, index: day.index },
      planets: planetFilter.snapshot,
    };
  }
  function flush() {
    if (pending !== null) cancel(pending);
    pending = null;
    if (restoring) {
      // The visible shell is usable while its chart waits. Preserve that
      // interaction without replacing accepted moments with unfinished data.
      if (restoreInitialized) store.write({ ...saved, version: 1, ...presentationSnapshot() });
      return;
    }
    applyPending(); store.write(snapshot());
  }
  function schedule() {
    if (restoring && !restoreInitialized) return;
    if (!restoring) applyPending();
    if (pending !== null) return;
    pending = defer(flush, delay);
  }
  // Called by the existing UI actions that choose a chart, moment or range.
  // Pointer/focus/keyboard activity alone does not replace a saved target.
  function interrupt() {
    if (restoring) { interrupted = true; generation++; restoring = false; panels?.finishRestore(); }
    pendingTransit = pendingLifetime = pendingNatal = pendingReturns = null;
    schedule();
  }
  eventTarget?.addEventListener('pagehide', flush);
  // Mobile browsers often suspend without pagehide. Flush the latest gesture.
  interactionTarget?.addEventListener('visibilitychange', () => { if (interactionTarget!.hidden) flush(); });

  async function restore() {
    const request = ++generation, valid = () => request === generation;
    restoring = true; restoreInitialized = false;
    panels?.beginRestore();
    let selectedId: string | undefined;
    try {
      if (saved?.planets) planetFilter.restore(saved.planets);
      const id = saved?.selectedId;
      session.select(resolveSelectedChartId(chartStore, id));
      selectedId = session.selectedId;
      if (selectedId !== id) pendingNatal = pendingReturns = null;
      if (selectedId === 'current-transit') pendingReturns = null;
      if (selectedId !== id || !canRestoreLifetime()) pendingLifetime = null;
      if ((pendingReturns?.opened || pendingReturns?.eventId) && canRestoreLifetime()) pendingNatal = null;
      panels?.restore(saved?.panels);
      workspace?.restore(saved?.workspace);
      mandala.setEnabled(saved?.mandala === true, { animate: false });
      if (!cameraRestored) camera.restoreView(saved?.camera);
      if (selectedId !== 'current-transit' && typeof pendingLifetime?.personalLive === 'boolean') {
        const followNow = pendingLifetime.personalLive && !pendingReturns?.eventId;
        if (followNow) pendingTransit = null;
        restorePersonalLive(followNow);
      }
      if (selectedId === 'current-transit' && pendingLifetime?.mode === 'lifetime') {
        acceptLifetimeMode({ opened: true, mode: 'lifetime' });
      }
      restoreInitialized = true;
      const firstChart = await transit.start(pendingTransit, { firstChart: true });
      const needsTransitMoment = selectedId === 'current-transit' ? pendingLifetime?.mode !== 'lifetime' : getPersonalLive() === true;
      const firstMomentReady = !needsTransitMoment || firstChart !== false;
      // The day controller now owns its accepted pause, including retries.
      pendingTransit = null;
      if (!valid() || session.selectedId !== selectedId) return false;
      applyPending();
      let returnRestoration: Promise<boolean> | undefined;
      const restoreReturn = () => {
        if (returnRestoration) return returnRestoration;
        if (panels?.rightRequestDuringRestore != null && pendingReturns) pendingReturns = { ...pendingReturns, opened: false };
        return returnRestoration ??= getReturns()!.restore(pendingReturns,
          { valid: () => valid() && session.selectedId === selectedId });
      };
      // Apply filters before the rail can enable searches. A saved exact event
      // also owns the moment; unrelated event lists need not delay the rail.
      if (pendingReturns && getReturns()?.available) {
        const restoration = restoreReturn();
        if (pendingReturns.eventId) {
          await restoration;
          if (!valid() || session.selectedId !== selectedId) return false;
        }
      }
      if (pendingLifetime?.opened && canRestoreLifetime()) {
        // An opened Lifetime view owns the saved moment ahead of natal-day preview.
        pendingNatal = null;
        const target = pendingLifetime;
        const lifetime = await loadLifetime();
        if (!valid() || session.selectedId !== selectedId || !canRestoreLifetime()) return false;
        if (selectedId === 'current-transit') acceptLifetimeMode({ opened: true, mode: target.mode });
        else if (session.owner !== 'return' && !getPersonalLive()) {
          restorePersonalPreview(target.personalPreview, target);
        }
        if (lifetime) startedLifetime = target;
        const restored = await lifetime?.restore(target);
        if (!valid() || session.selectedId !== selectedId || !canRestoreLifetime()) return false;
        if (restored && pendingLifetime === target) pendingLifetime = null;
        applyPending();
      } else if (pendingNatal && session.selectedId === saved!.selectedId) {
        const id = session.selectedId;
        await natalDay.open();
        if (!valid() || session.selectedId !== id) return false;
        applyPending();
      }
      if (pendingReturns && session.selectedId === saved!.selectedId && getReturns()?.available) {
        const target = pendingReturns;
        const restored = await restoreReturn();
        if (!valid() || session.selectedId !== selectedId) return false;
        // The menu or exact return can be saved before lazy Lifetime controls
        // exist. Resume the normal opening path and retain its target on failure.
        if ((target.opened || getReturns()!.selectedEvent) && !getLifetime()?.state.opened && canRestoreLifetime()) {
          await openReturnsTimeline();
          if (!valid() || session.selectedId !== selectedId) return false;
          const lifetimeState = getLifetime()?.state;
          if (!lifetimeState?.opened || lifetimeState.mode !== 'lifetime') return false;
        }
        if (restored && pendingReturns === target) pendingReturns = null;
      }
      return valid() && firstMomentReady && !pendingReturns && !pendingTransit && !pendingLifetime && !pendingNatal;
    } finally {
      if (valid()) {
        if (session.selectedId !== selectedId) pendingTransit = pendingLifetime = pendingNatal = pendingReturns = null;
        else if (!canRestoreLifetime()) pendingLifetime = null;
        if (panels?.rightRequestDuringRestore != null) {
          // The moment has settled. Close only its menu now, preserving the last
          // explicit panel command and any exact target retained for a retry.
          if (pendingReturns) pendingReturns = { ...pendingReturns, opened: false };
          getReturns()?.close();
        }
        panels?.finishRestore();
        restoring = false; flush();
      }
    }
  }
  return { restore, interrupt, schedule, flush,
    get interrupted() { return interrupted; },
    get pendingReturns() { return pendingReturns ? { ...pendingReturns } : null; },
    get pendingLifetime() { return pendingLifetime ? { ...pendingLifetime } : null; },
  };
}
