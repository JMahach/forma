import { createLifetimeClient } from '../data/lifetime-client.js';
import { lifetimeChartAt, validateLifetimeMetadata, validateLifetimeMoment } from '../domain/lifetime.js';
import { createTransitPlanetFilter } from './transit-planets.js';

const dayMilliseconds = 86_400_000;
function dateStart(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value ? milliseconds : NaN;
}

// Today reuses the existing transit. A custom date range uses the archive.
// Only one point loads at a time; continuous scrubs retain the latest target.
export function createLifetimeExplorer({
  dayClient = null, client = createLifetimeClient({ dayClient }), getDayState = () => null, now = () => Date.now(),
  getMomentState = () => null,
  planetFilter = createTransitPlanetFilter(),
  onStateChange = () => {}, onRender = () => {}, onModeAccepted = () => {},
} = {}) {
  let metadata = null, fullChart = null, manualChart = null, requestedUtc = null, restoring = false, pendingRestore = null;
  const current = () => planetFilter.filter(fullChart);
  let opened = false, mode = 'day', status = 'idle', error = '', sequence = 0, active = null, notifiedReference = null;
  let openEnded = false, fromDate = null, toDate = null, minDate = null, maxDate = null, minUtc = null, maxUtc = null;
  const shownUtc = () => fullChart ? Date.parse(fullChart.utc) : null;
  const clampUtc = value => Math.max(minUtc, Math.min(maxUtc, value));
  const indexAt = utc => (utc - Date.parse(metadata.startUtc)) / (metadata.stepSeconds * 1000);
  const utcAt = index => Date.parse(metadata.startUtc) + index * metadata.stepSeconds * 1000;
  function gridUtc(value, round = Math.round) {
    if (Math.ceil(indexAt(minUtc)) > Math.floor(indexAt(maxUtc))) return minUtc;
    const index = Math.max(Math.ceil(indexAt(minUtc)), Math.min(Math.floor(indexAt(maxUtc)), round(indexAt(value))));
    return utcAt(index);
  }
  function setBounds(start, end, minimumUtc) {
    minUtc = Math.max(Date.parse(metadata.startUtc), start, minimumUtc ? Date.parse(minimumUtc) : -Infinity);
    maxUtc = Math.min(Date.parse(metadata.endExclusiveUtc), end) - 1;
  }
  function referenceUtc() {
    if (mode !== 'archive' || !metadata || minUtc === null) return null;
    const value = Math.floor(now() / 60000) * 60000;
    return Number.isFinite(value) && value >= minUtc && value <= maxUtc ? value : null;
  }
  const state = () => ({ opened, mode, status, error, metadata, current: opened ? current() : null, requestedUtc, displayedUtc: shownUtc(),
    fromDate, toDate, openEnded, minDate, maxDate, minUtc, maxUtc, referenceUtc: referenceUtc(),
    ...planetFilter.state });
  function notify() { const value = state(); notifiedReference = value.referenceUtc; onStateChange(value); }
  function cancel() { sequence++; active?.controller.abort(); active = null; restoring = false; pendingRestore = null; }
  const dayDate = day => day?.timeline?.date || day?.current?.birthDate || null;
  function borrowDay() {
    const day = getDayState(), chart = day?.current || null, date = dayDate(day);
    const changed = chart !== fullChart || date !== fromDate || date !== toDate;
    fullChart = chart; manualChart = null; requestedUtc = shownUtc();
    fromDate = toDate = date; openEnded = false;
    if (status !== 'error') status = fullChart ? 'ready' : 'loading';
    return changed;
  }
  function syncDay() {
    if (!opened || mode !== 'day' || !borrowDay()) return false;
    notify(); return true;
  }
  function applySelection(method, ...args) {
    const previous = current();
    if (!planetFilter[method](...args)) return false;
    if (previous && current() === previous) return true;
    const generation = sequence;
    notify();
    if (opened && fullChart && generation === sequence) onRender();
    return true;
  }
  // A return or live minute already owns its calculated chart. Moving the rail
  // to that moment must not calculate a second, rounded archive chart.
  function alignMoment(chart) {
    const utc = Date.parse(chart?.utc);
    if (!opened || mode !== 'archive' || !metadata || !Number.isFinite(utc)) return false;
    const next = clampUtc(utc);
    if (chart === fullChart && next === requestedUtc && !manualChart && status === 'ready' && !active) return true;
    cancel(); requestedUtc = next; fullChart = chart; manualChart = null;
    status = 'ready'; error = ''; notify();
    return true;
  }
  function publishReady(chart, utc) {
    cancel(); requestedUtc = utc; fullChart = manualChart = chart;
    status = 'ready'; error = '';
    const generation = sequence; notify();
    if (generation === sequence && opened && mode === 'archive') onRender();
    return Promise.resolve(true);
  }
  function chooseTarget(value, round = Math.round) {
    const clamped = clampUtc(value);
    // A selected manual snapshot survives eviction. A borrowed natal/return
    // chart never becomes an archive snapshot merely by sharing its UTC.
    if (manualChart && shownUtc() === clamped) return { utc: clamped, chart: manualChart };
    const minute = Math.max(Math.ceil(minUtc / 60000) * 60000,
      Math.min(Math.floor(maxUtc / 60000) * 60000, Math.round(clamped / 60000) * 60000));
    const chart = minute <= maxUtc ? client.peekMinute?.(minute) : null;
    return chart ? { utc: minute, chart } : { utc: gridUtc(clamped, round), chart: null };
  }
  function load(restoration = pendingRestore) {
    if (!opened) return Promise.resolve(false);
    if (active) return active.promise;
    const request = { controller: new AbortController(), promise: null }, generation = ++sequence;
    active = request; restoring = Boolean(restoration); status = mode === 'day' && fullChart ? 'ready' : 'loading'; error = '';
    request.promise = Promise.resolve().then(async () => {
      if (generation !== sequence || !opened) return false;
      try {
        let receivedMetadata = false;
        if (!metadata) {
          const value = await client.getMeta({ signal: request.controller.signal });
          if (generation !== sequence || !opened) return false;
          metadata = validateLifetimeMetadata(value); receivedMetadata = true;
          minDate = metadata.startUtc.slice(0, 10);
          maxDate = new Date(Date.parse(metadata.endExclusiveUtc) - 1).toISOString().slice(0, 10);
        }
        if (restoration?.mode === 'archive') {
          const through = restoration.openEnded ? maxDate : restoration.toDate;
          const start = dateStart(restoration.fromDate), end = dateStart(through) + dayMilliseconds;
          if (restoration.fromDate < minDate || through > maxDate || restoration.fromDate > through) {
            pendingRestore = null; mode = 'day'; borrowDay();
            onModeAccepted({ opened, mode });
            if (generation === sequence && opened) notify();
            return false;
          }
          setBounds(start, end, restoration.minimumUtc);
          requestedUtc = clampUtc(restoration.requestedUtc ?? utcAt(restoration.index));
          // Old snapshots only knew archive slots. New UTC snapshots retain
          // their selected minute even when its day must be loaded explicitly.
          if (restoration.requestedUtc === undefined) requestedUtc = gridUtc(requestedUtc);
          else if (restoration.requestedUtc > maxUtc) requestedUtc = Math.max(minUtc, Math.floor(maxUtc / 60000) * 60000);
          mode = 'archive'; fromDate = restoration.fromDate; toDate = through; openEnded = restoration.openEnded;
          status = 'loading';
        }
        if (restoration) onModeAccepted({ opened, mode });
        if (generation !== sequence || !opened) return false;
        if (receivedMetadata || restoration) notify();
        if (generation !== sequence || !opened) return false;
        if (mode === 'day') {
          borrowDay(); notify();
          if (generation !== sequence || !opened) return false;
          if (restoration) onRender();
          pendingRestore = null;
          return true;
        }
        while (generation === sequence && opened && mode === 'archive') {
          const momentState = getMomentState();
          if (momentState) {
            if (momentState.current) alignMoment(momentState.current);
            else {
              manualChart = null; status = momentState.status || 'loading'; error = momentState.error || '';
              pendingRestore = null; notify();
            }
            return true;
          }
          const target = requestedUtc;
          let chart;
          try {
            chart = client.peekMinute?.(target);
            if (!chart && restoration?.requestedUtc !== undefined && !Number.isInteger(indexAt(target))) {
              chart = await client.getMinute(target, { signal: request.controller.signal });
            } else if (!chart) {
              const requestedIndex = indexAt(target);
              const point = await client.getPoint(requestedIndex, { signal: request.controller.signal });
              chart = lifetimeChartAt(metadata, validateLifetimeMoment(point, metadata, requestedIndex));
            }
            if (generation !== sequence || !opened || mode !== 'archive') return false;
            // A live/exact owner can take over while this point is pending.
            // Do not publish it or continue a superseded coalesced scrub.
            if (getMomentState()) continue;
          } catch (failure) {
            if (generation !== sequence || !opened || mode !== 'archive') return false;
            if (getMomentState() || target !== requestedUtc) continue;
            throw failure;
          }
          // A changed range may exclude a completed point. Other completed
          // points still show progress during continuous dragging.
          if (target < minUtc || target > maxUtc) continue;
          fullChart = manualChart = chart;
          status = target === requestedUtc ? 'ready' : 'loading'; error = ''; notify();
          if (generation !== sequence || !opened || mode !== 'archive') return false;
          onRender();
          if (target === requestedUtc) { pendingRestore = null; return true; }
        }
        return false;
      } catch (failure) {
        if (generation !== sequence || request.controller.signal.aborted) return false;
        status = 'error'; error = failure?.message || 'Не удалось загрузить шкалу лет.'; notify();
        return false;
      } finally { if (active === request) { active = null; restoring = false; } }
    });
    notify();
    return request.promise;
  }
  function open() {
    if (opened) return active?.promise || Promise.resolve(true);
    cancel(); opened = true; mode = 'day'; minUtc = maxUtc = null;
    planetFilter.setExpanded(true);
    status = 'idle'; error = ''; borrowDay();
    const generation = sequence;
    onModeAccepted({ opened, mode });
    if (!opened || generation !== sequence) return Promise.resolve(false);
    notify();
    if (!opened || generation !== sequence) return Promise.resolve(false);
    onRender();
    return metadata ? Promise.resolve(true) : load();
  }

  function restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
        || snapshot.opened !== true || !['day', 'archive'].includes(snapshot.mode)
        || snapshot.openEnded !== undefined && typeof snapshot.openEnded !== 'boolean') return Promise.resolve(false);
    if (snapshot.mode === 'archive' && (!(snapshot.requestedUtc === undefined ? Number.isSafeInteger(snapshot.index)
        : Number.isSafeInteger(snapshot.requestedUtc) && Number.isFinite(new Date(snapshot.requestedUtc).getTime()))
        || !Number.isFinite(dateStart(snapshot.fromDate))
        || !snapshot.openEnded && (!Number.isFinite(dateStart(snapshot.toDate)) || snapshot.fromDate > snapshot.toDate))) return Promise.resolve(false);
    if (snapshot.minimumUtc !== undefined && (typeof snapshot.minimumUtc !== 'string'
        || !Number.isFinite(Date.parse(snapshot.minimumUtc))
        || Date.parse(snapshot.minimumUtc) < dateStart(snapshot.fromDate)
        || Date.parse(snapshot.minimumUtc) >= dateStart(snapshot.fromDate) + dayMilliseconds)) return Promise.resolve(false);
    // Copy before awaiting metadata so caller mutation cannot change the restore target.
    const restoration = { mode: snapshot.mode, fromDate: snapshot.fromDate, toDate: snapshot.toDate,
      openEnded: snapshot.openEnded === true, requestedUtc: snapshot.requestedUtc, index: snapshot.index, minimumUtc: snapshot.minimumUtc };
    cancel(); opened = true; mode = restoration.mode; minUtc = maxUtc = null; manualChart = null;
    planetFilter.setExpanded(true); status = 'idle'; error = '';
    if (mode === 'day') borrowDay();
    else { fullChart = null; requestedUtc = restoration.requestedUtc ?? null; fromDate = restoration.fromDate; toDate = restoration.toDate; openEnded = restoration.openEnded; }
    pendingRestore = restoration;
    return load();
  }

  function close() {
    if (!opened) return;
    cancel(); opened = false; status = 'idle'; error = '';
    planetFilter.setExpanded(false);
    onModeAccepted({ opened, mode });
    notify(); onRender();
  }
  function scrub(value) {
    if (!opened || mode !== 'archive' || !metadata || !Number.isFinite(value)) return;
    const next = chooseTarget(value);
    if (next.utc === requestedUtc && status !== 'error' && (manualChart && shownUtc() === next.utc || active && !next.chart)) return;
    if (restoring || pendingRestore) cancel();
    if (next.chart) return publishReady(next.chart, next.utc);
    requestedUtc = next.utc; status = 'loading'; error = ''; notify();
    return load();
  }
  return {
    get current() { return opened ? current() : null; },
    get state() { return state(); },
    open, close, syncDay, scrub, restore, alignMoment,
    adjacentUtc(direction) {
      if (!opened || mode !== 'archive' || !metadata || !Number.isFinite(requestedUtc) || !direction) return null;
      const forward = direction > 0;
      const minute = (forward ? Math.floor(requestedUtc / 60000) + 1 : Math.ceil(requestedUtc / 60000) - 1) * 60000;
      if (!forward && minute <= minUtc) return minUtc;
      if (minute <= maxUtc && client.peekMinute?.(minute)) return minute;
      const grid = utcAt(forward ? Math.floor(indexAt(requestedUtc)) + 1 : Math.ceil(indexAt(requestedUtc)) - 1);
      if (forward && grid > maxUtc) return requestedUtc;
      return clampUtc(grid);
    },
    setPlanet(...args) { return applySelection('setPlanet', ...args); },
    setAllPlanets(...args) { return applySelection('setAllPlanets', ...args); },
    syncClock() {
      if (!opened || referenceUtc() === notifiedReference) return false;
      notify(); return true;
    },
    goNow() { const reference = referenceUtc(); if (reference !== null) return scrub(reference); },
    togglePlanet(...args) { return applySelection('togglePlanet', ...args); },
    toggleAllPlanets(...args) { return applySelection('toggleAllPlanets', ...args); },
    retry: load,
    setDateRange(from, through) {
      const nextOpenEnded = through === null || through === undefined || through === '';
      if (nextOpenEnded) through = maxDate;
      const start = dateStart(from), end = dateStart(through) + dayMilliseconds;
      if (!opened || !metadata || !Number.isFinite(start) || !Number.isFinite(end)
          || from < minDate || through > maxDate || from > through) return false;
      const currentDay = dayDate(getDayState());
      if (!nextOpenEnded && from === currentDay && through === currentDay) {
        if (mode === 'day') return true;
        cancel(); mode = 'day'; minUtc = maxUtc = null;
        status = 'idle'; error = ''; borrowDay();
        const generation = sequence;
        onModeAccepted({ opened, mode });
        if (generation !== sequence || !opened) return false;
        notify(); onRender();
        return true;
      }
      if (mode === 'archive' && from === fromDate && through === toDate) {
        if (openEnded === nextOpenEnded) return true;
        if (restoring || pendingRestore) cancel();
        openEnded = nextOpenEnded;
        const generation = sequence;
        onModeAccepted({ opened, mode });
        if (generation !== sequence || !opened) return false;
        if (!manualChart && !getMomentState()) {
          const target = chooseTarget(requestedUtc);
          requestedUtc = target.utc;
          if (target.chart) return publishReady(target.chart, target.utc);
        }
        notify();
        return !manualChart || shownUtc() !== requestedUtc ? load() : true;
      }
      if (restoring || pendingRestore) cancel();
      setBounds(start, end);
      const shown = Date.parse(fullChart?.utc);
      const target = chooseTarget(mode === 'archive' ? requestedUtc : Number.isFinite(shown) ? shown : minUtc, Math.floor);
      requestedUtc = target.utc;
      mode = 'archive'; fromDate = from; toDate = through; openEnded = nextOpenEnded;
      const generation = sequence;
      onModeAccepted({ opened, mode });
      if (generation !== sequence || !opened) return false;
      if (target.chart && !getMomentState()) return publishReady(target.chart, target.utc);
      const needsPoint = active || !manualChart || shownUtc() !== requestedUtc;
      status = needsPoint ? 'loading' : 'ready'; error = '';
      notify();
      return needsPoint ? load() : true;
    },
  };
}
