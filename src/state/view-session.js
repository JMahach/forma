// One restoration transaction connects existing state owners. Initialization
// cannot overwrite the previous page; explicit moment commands supersede pending work.
export function createViewSession({
  store, chartStore, session, mandala, camera, transit, natalDay, planetFilter,
  getPersonalPreview = () => undefined, getReturns = () => null, getLifetime = () => null, loadLifetime = async () => null,
  getPersonalLive = () => undefined, restorePersonalLive = () => {}, restorePersonalPreview = () => {},
  openReturnsTimeline = async () => null, acceptLifetimeMode = () => {},
  canRestoreLifetime = () => session.selectedId === 'current-transit',
  eventTarget = globalThis.window, interactionTarget = globalThis.document,
  schedule: defer = globalThis.setTimeout, cancel = globalThis.clearTimeout, delay = 160,
}) {
  const saved = store.read();
  let restoring = true, interrupted = false, generation = 0, pending = null;
  let pendingTransit = saved?.transit?.live === false ? saved.transit : null;
  let pendingLifetime = saved?.lifetime || null, startedLifetime = null;
  let pendingReturns = saved?.returns || null;
  let pendingNatal = saved?.natalDay?.opened ? saved.natalDay : null;
  function lifetimeUtc(target, lifetimeState) {
    if (Number.isFinite(target?.requestedUtc)) return target.requestedUtc;
    // A legacy index has meaning only after the lifetime supplies its origin.
    if (Number.isSafeInteger(target?.index) && lifetimeState?.metadata) {
      return Date.parse(lifetimeState.metadata.startUtc) + target.index * lifetimeState.metadata.stepSeconds * 1000;
    }
    return null;
  }
  function applyPending() {
    if (pendingNatal && session.selectedId === saved.selectedId && natalDay.state.status === 'ready' && natalDay.state.opened) {
      const target = pendingNatal; pendingNatal = null;
      if (!target.exactOriginal) natalDay.scrub(target.index);
    }
    const lifetimeState = getLifetime()?.state;
    // The explorer alone normalizes legacy indices and exact birth bounds.
    // Its ready result acknowledges this started restoration, including retry;
    // a pre-existing ready range cannot consume a target we have not sent yet.
    if (pendingLifetime && pendingLifetime === startedLifetime && lifetimeState?.opened
        && lifetimeState.status === 'ready' && lifetimeState.mode === pendingLifetime.mode
        && (lifetimeState.mode === 'day' || lifetimeState.fromDate === pendingLifetime.fromDate
          && (pendingLifetime.openEnded ? lifetimeState.openEnded : lifetimeState.toDate === pendingLifetime.toDate))) pendingLifetime = null;
  }
  function snapshot() {
    const view = camera.getView(), home = camera.getFittedView();
    const personalPreview = getPersonalPreview();
    const personalLive = getPersonalLive();
    const cycles = getReturns()?.state;
    const returnView = pendingReturns || (cycles?.available && (cycles.opened || cycles.selectedEvent) ? { opened: cycles.opened, group: cycles.group, year: cycles.year, body: cycles.body, eventId: cycles.selectedEvent?.id || null, ...(cycles.selectedEvent ? { event: cycles.selectedEvent } : {}) } : null);
    const lifetimeState = getLifetime()?.state, day = natalDay.state, live = transit.state;
    const pendingUtc = lifetimeUtc(pendingLifetime, lifetimeState);
    const lifetimeTarget = pendingLifetime && Number.isFinite(pendingUtc)
      ? Object.fromEntries(Object.entries({ ...pendingLifetime, requestedUtc: pendingUtc }).filter(([key]) => key !== 'index')) : pendingLifetime;
    return {
      version: 1, ...(returnView ? { returns: returnView } : {}), selectedId: session.selectedId, mandala: mandala.enabled,
      camera: { x: (view.x - home.x) / home.k, y: (view.y - home.y) / home.k, k: view.k / home.k },
      lifetime: lifetimeTarget || (lifetimeState?.opened ? { opened: true, mode: lifetimeState.mode, fromDate: lifetimeState.fromDate, toDate: lifetimeState.toDate, ...(Number.isFinite(lifetimeState.requestedUtc) ? { requestedUtc: lifetimeState.requestedUtc } : {}), ...(lifetimeState.openEnded ? { openEnded: true } : {}), ...(typeof personalPreview === 'boolean' ? { personalPreview } : {}), ...(typeof personalLive === 'boolean' ? { personalLive } : {}) } : null),
      transit: pendingTransit || (live.timeline ? { live: live.live, date: live.timeline.date, timeZone: live.timeline.timeZone, index: live.index } : null),
      natalDay: pendingNatal || { opened: day.opened, exactOriginal: day.exactOriginal, index: day.index },
      planets: planetFilter.snapshot,
    };
  }
  function flush() {
    if (pending !== null) cancel(pending);
    pending = null;
    if (!restoring) { applyPending(); store.write(snapshot()); }
  }
  function schedule() {
    if (restoring) return;
    applyPending();
    if (pending !== null) return;
    pending = defer(flush, delay);
  }
  // Called by the existing UI actions that choose a chart, moment or range.
  // Pointer/focus/keyboard activity alone does not replace a saved target.
  function interrupt() {
    if (restoring) { interrupted = true; generation++; restoring = false; }
    pendingTransit = pendingLifetime = pendingNatal = pendingReturns = null;
    schedule();
  }
  eventTarget?.addEventListener('pagehide', flush);
  // Mobile browsers often suspend without pagehide. Flush the latest gesture.
  interactionTarget?.addEventListener('visibilitychange', () => { if (interactionTarget.hidden) flush(); });

  async function restore() {
    const request = ++generation, valid = () => request === generation;
    let selectedId;
    try {
      if (saved?.planets) planetFilter.restore(saved.planets);
      const id = saved?.selectedId;
      session.select(id === 'current-transit' || chartStore.has(id) ? id : 'current-transit');
      selectedId = session.selectedId;
      if (selectedId !== id) pendingNatal = pendingReturns = null;
      if (selectedId === 'current-transit') pendingReturns = null;
      if (selectedId !== id || !canRestoreLifetime()) pendingLifetime = null;
      if ((pendingReturns?.opened || pendingReturns?.eventId) && canRestoreLifetime()) pendingNatal = null;
      mandala.setEnabled(saved?.mandala === true, { animate: false });
      camera.reset();
      if (saved?.camera) {
        const home = camera.getFittedView(), position = saved.camera;
        camera.setView({ x: home.x + position.x * home.k, y: home.y + position.y * home.k,
          k: Math.min(4.5, position.k * home.k) });
      }
      if (selectedId !== 'current-transit' && typeof pendingLifetime?.personalLive === 'boolean') {
        const followNow = pendingLifetime.personalLive && !pendingReturns?.eventId;
        if (followNow) pendingTransit = null;
        restorePersonalLive(followNow);
      }
      if (selectedId === 'current-transit' && pendingLifetime?.mode === 'lifetime') {
        acceptLifetimeMode({ opened: true, mode: 'lifetime' });
      }
      await transit.start(pendingTransit);
      // The day controller now owns its accepted pause, including retries.
      pendingTransit = null;
      if (!valid() || session.selectedId !== selectedId) return false;
      applyPending();
      let returnRestoration;
      const restoreReturn = () => returnRestoration ??= getReturns().restore(pendingReturns,
        { valid: () => valid() && session.selectedId === selectedId });
      // A saved exact event owns the moment. Restore it before Lifetime so the
      // rail can borrow its chart instead of calculating a rounded point.
      if (pendingReturns?.eventId && pendingReturns.event?.id === pendingReturns.eventId
          && Number.isFinite(Date.parse(pendingReturns.event.utc)) && getReturns()?.state.available) {
        await restoreReturn();
        if (!valid() || session.selectedId !== selectedId) return false;
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
      } else if (pendingNatal && session.selectedId === saved.selectedId) {
        const id = session.selectedId;
        await natalDay.open();
        if (!valid() || session.selectedId !== id) return false;
        applyPending();
      }
      if (pendingReturns && session.selectedId === saved.selectedId && getReturns()?.state.available) {
        const target = pendingReturns;
        const restored = await restoreReturn();
        if (!valid() || session.selectedId !== selectedId) return false;
        // The menu or exact return can be saved before lazy Lifetime controls
        // exist. Resume the normal opening path and retain its target on failure.
        if ((target.opened || getReturns().state.selectedEvent) && !getLifetime()?.state.opened && canRestoreLifetime()) {
          await openReturnsTimeline();
          if (!valid() || session.selectedId !== selectedId) return false;
          const lifetimeState = getLifetime()?.state;
          if (!lifetimeState?.opened || lifetimeState.mode !== 'lifetime') return false;
        }
        if (restored && pendingReturns === target) pendingReturns = null;
      }
      return valid() && !pendingReturns && !pendingTransit && !pendingLifetime && !pendingNatal;
    } finally {
      if (valid()) {
        if (session.selectedId !== selectedId) pendingTransit = pendingLifetime = pendingNatal = pendingReturns = null;
        else if (!canRestoreLifetime()) pendingLifetime = null;
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
