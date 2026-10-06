import { lifeTimelineForChart } from '../domain/cycles.js';

// One owner for chart navigation and moment commands. Tools retain their
// ranges, jobs and local cancellation; the session accepts their visible result.
export function createChartExploration({ session, getTransit, getNatalDay, getLifetime, getReturns,
  loadLifetime, enabled = true, onTimelineReady = () => {}, onModeChange = () => {}, onChange = () => {} }) {
  let timelineOpening = null, restoreBirthBoundary = false;
  const personal = () => Boolean(getReturns()?.state.available);
  const live = () => personal() && session.owner === 'transit';
  // Archive requests must resume even before their first result. A pending or
  // failed Return instead keeps the previously accepted preview.
  const preview = () => personal() && ['archive', 'transit'].includes(session.owner === 'return' ? session.shownSource : session.owner);
  function syncTransitWanted() {
    const transit = getTransit();
    if (!transit) return;
    const wanted = session.owner === 'transit';
    if (transit.state.wanted !== wanted) transit.setWanted(wanted);
  }
  function invalidateTimeline() { timelineOpening = null; restoreBirthBoundary = false; }
  function selected() {
    invalidateTimeline();
    getLifetime()?.setAvailable(session.selectedId === 'current-transit' || personal());
  }
  function select(id) {
    invalidateTimeline();
    session.select(id);
    return getNatalDay().state.available ? getNatalDay().open() : false;
  }
  function openDay() {
    invalidateTimeline();
    session.showOriginal('natal-day'); syncTransitWanted();
    getReturns()?.exit(); getLifetime()?.close();
    getNatalDay().reset();
    return getNatalDay().open();
  }
  function closeScales() {
    invalidateTimeline();
    if (session.selectedId === 'current-transit') session.expect('transit');
    else session.showOriginal();
    syncTransitWanted();
    getReturns()?.exit(); getLifetime()?.close();
    getNatalDay().close();
    session.refresh(); onModeChange();
    return false;
  }
  function resetMoment() {
    invalidateTimeline();
    session.showOriginal(getNatalDay().state.opened ? 'natal-day' : 'original');
    syncTransitWanted();
    getReturns()?.reset(); getNatalDay().reset();
    const lifetime = getLifetime(), archive = lifetime?.state;
    if (archive?.opened && archive.mode === 'archive' && archive.metadata) lifetime.alignMoment(session.original);
    // Birth may already have the same UTC as the preview; still repaint its
    // exact saved chart when child controllers have nothing left to reset.
    session.refresh();
  }
  async function toggleTransit() {
    if (!enabled || session.selectedId !== 'current-transit') return false;
    if (timelineOpening || getLifetime()?.state.opened) return closeScales();
    const request = {};
    timelineOpening = request; onModeChange();
    try {
      const lifetime = getLifetime() || await loadLifetime();
      if (timelineOpening !== request || !lifetime) return false;
      await lifetime.open();
      return timelineOpening === request && Boolean(lifetime.state.opened);
    } finally {
      if (timelineOpening === request) { timelineOpening = null; onModeChange(); }
    }
  }
  async function toggleReturns() {
    if (!enabled || !personal()) return false;
    if (timelineOpening || getLifetime()?.state.opened && !getNatalDay().state.opened) return closeScales();
    session.showOriginal();
    return openTimeline();
  }
  function followNow() {
    if (!personal()) return false;
    invalidateTimeline();
    session.expect('transit');
    getReturns().reset();
    void getTransit().goNow();
    syncTransitWanted();
    publishTransit();
    getLifetime()?.syncTransit(); onChange();
    return true;
  }
  function requestReturn() {
    restoreBirthBoundary = false; session.expect('return'); syncTransitWanted();
    // Keep the saved rail UTC on the accepted chart as soon as this command
    // supersedes an archive request, rather than waiting for its stale reply.
    getLifetime()?.alignMoment(momentState().current);
  }
  function publishReturn(moment, event) {
    if (moment && session.publish('return', moment, event)) getLifetime()?.alignMoment(moment);
  }
  function publishDay() { session.publish('natal-day', getNatalDay()?.state.current); }
  function publishTransit() {
    session.publish('transit', getTransit()?.current);
    if (live() && getTransit()?.current) getLifetime()?.alignMoment(getTransit().current);
  }
  function publishArchive() {
    const years = getLifetime();
    if (years?.state.mode === 'day') publishTransit();
    else session.publish('archive', years?.current);
  }
  function beforeScrub(value) {
    if (!personal()) return;
    invalidateTimeline();
    const years = getLifetime();
    if (years.state.mode === 'archive' && value <= years.state.minUtc) {
      resetMoment(); getReturns().close(); return false;
    }
    session.expect('archive'); syncTransitWanted();
    getReturns().reset(); getReturns().close();
  }
  // Called by accepted open/close/range commands, and before restoring a saved
  // global range. Ordinary loading/clock/filter notifications never navigate.
  function acceptLifetimeMode(state) {
    if (session.selectedId === 'current-transit') {
      const kind = state.opened && state.mode === 'archive' ? 'archive' : 'transit';
      session.expect(kind);
      if (kind === 'transit') publishTransit();
    }
    syncTransitWanted();
  }
  function lifetimeChanged(state) {
    // Old saved views did not distinguish exact birth from a sampled preview.
    // The accepted range supplies that boundary after metadata is available.
    if (session.selectedId !== 'current-transit' && restoreBirthBoundary
        && state.opened && state.mode === 'archive' && state.metadata && state.minUtc !== null) {
      const target = restoreBirthBoundary, birth = Date.parse(session.original.utc);
      restoreBirthBoundary = false;
      const atBirth = Number.isSafeInteger(target.index)
        ? target.index === Math.round((birth - Date.parse(state.metadata.startUtc)) / (state.metadata.stepSeconds * 1000))
        : (target.requestedUtc ?? state.requestedUtc) === birth;
      if (state.minUtc === birth && atBirth) session.showOriginal();
    }
  }
  function restorePreview(value, target = {}) {
    if (session.owner === 'return' || live()) return;
    restoreBirthBoundary = value === undefined ? target : false;
    if (value !== false) session.expect('archive');
    else session.showOriginal();
  }
  function restoreLive(value) { if (value) followNow(); }
  function momentState() {
    if (session.owner === 'return') {
      const accepted = session.current;
      return { current: accepted.secondary || accepted.primary, status: 'ready', live: false };
    }
    if (live()) return getTransit()?.state;
    if (personal() && session.owner === 'original')
      return { current: session.original, status: 'ready', live: false };
    return null;
  }
  async function openTimeline() {
    if (!enabled || !personal()) return false;
    const natal = session.original, span = lifeTimelineForChart(natal);
    if (!span) return false;
    const request = {};
    const valid = () => timelineOpening === request;
    timelineOpening = request;
    getNatalDay().close();
    getReturns().enableMarkers(true);
    onModeChange();
    try {
      const controller = getLifetime() || await loadLifetime();
      if (!controller || !valid()) return false;
      await controller.open();
      if (!valid() || !controller.state.metadata) return false;
      const metadata = controller.state.metadata;
      const shown = session.current;
      const start = live() ? Date.now() : Date.parse(shown.kind === 'return' ? shown.utc : natal.utc);
      const lastDate = new Date(Date.parse(metadata.endExclusiveUtc) - 1).toISOString().slice(0, 10);
      const toDate = span.toDate < lastDate ? span.toDate : lastDate;
      const restored = await controller.restore({ opened: true, mode: 'archive', fromDate: span.fromDate, toDate, minimumUtc: natal.utc, requestedUtc: start });
      if (!valid() || !restored) return false;
      onTimelineReady(); return true;
    } catch { return false; }
    finally {
      if (valid()) { timelineOpening = null; onModeChange(); }
    }
  }
  function finishRestore({ saved, pendingLifetime, pendingReturns, interrupted }) {
    if (interrupted || !personal()) return;
    const years = getLifetime()?.state;
    if (years?.opened && years.mode === 'archive' || pendingLifetime?.opened && pendingLifetime.mode === 'archive') {
      const discardedReturn = Boolean(saved?.returns?.eventId && !pendingReturns && !getReturns().state.selectedEvent);
      if (discardedReturn) { session.showOriginal(); getLifetime()?.alignMoment(session.original); }
      else if (session.owner !== 'return' && !live()) {
        const atBirth = years?.metadata && years.requestedUtc === years.minUtc
          && years.minUtc === Date.parse(session.original.utc);
        if (!atBirth && saved?.lifetime?.personalPreview !== false) {
          session.expect('archive'); publishArchive();
        }
      }
      getReturns().enableMarkers(true); session.refresh();
    } else {
      const savedClosed = saved?.selectedId === session.selectedId && saved?.natalDay?.opened === false;
      if (!savedClosed && !getNatalDay().state.opened && session.current.kind !== 'return' && !getReturns().state.opened && !timelineOpening)
        void getNatalDay().open();
    }
    syncTransitWanted();
  }
  return { select, selected, openDay, resetMoment, toggleTransit, toggleReturns,
    toggleDay: () => getNatalDay().state.opened ? closeScales() : openDay(),
    get returnsEnabled() { return personal() && Boolean(timelineOpening || getLifetime()?.state.opened && !getNatalDay().state.opened); },
    get transitEnabled() { return session.selectedId === 'current-transit' && Boolean(timelineOpening || getLifetime()?.state.opened); },
    followNow, requestReturn, publishReturn, publishDay,
    publishTransit, publishArchive, beforeScrub, acceptLifetimeMode, lifetimeChanged, restorePreview, restoreLive,
    momentState, openTimeline, finishRestore, invalidateTimeline,
    get live() { return live(); }, get preview() { return preview(); } };
}
