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
  planetFilter = createTransitPlanetFilter(),
  onStateChange = () => {}, onRender = () => {},
} = {}) {
  let metadata = null, fullChart = null, index = 0, displayedIndex = null;
  const current = () => planetFilter.filter(fullChart);
  let opened = false, mode = 'day', status = 'idle', error = '', sequence = 0, active = null, notifiedReference = null;
  let fromDate = null, toDate = null, minDate = null, maxDate = null, minIndex = null, maxIndex = null;
  function referenceIndex() {
    if (mode !== 'archive' || !metadata || minIndex === null) return null;
    const value = Math.floor((now() - Date.parse(metadata.startUtc)) / (metadata.stepSeconds * 1000));
    return Number.isFinite(value) && value >= minIndex && value <= maxIndex ? value : null;
  }
  const state = () => ({ opened, mode, status, error, metadata, current: current(), index, displayedIndex,
    fromDate, toDate, minDate, maxDate, minIndex, maxIndex, referenceIndex: referenceIndex(),
    ...planetFilter.state });
  function notify() { const value = state(); notifiedReference = value.referenceIndex; onStateChange(value); }
  function cancel() { sequence++; active?.controller.abort(); active = null; }
  const dayDate = day => day?.timeline?.date || day?.current?.birthDate || null;
  function borrowDay() {
    const day = getDayState(), chart = day?.current || null, date = dayDate(day);
    const changed = chart !== fullChart || date !== fromDate || date !== toDate;
    fullChart = chart;
    fromDate = toDate = date;
    if (status !== 'error') status = fullChart ? 'ready' : 'loading';
    return changed;
  }
  function syncDay() { if (opened && mode === 'day' && borrowDay()) notify(); }
  function applySelection(method, ...args) {
    const previous = current();
    if (!planetFilter[method](...args)) return false;
    if (previous && current() === previous) return true;
    const generation = sequence;
    notify();
    if (opened && fullChart && generation === sequence) onRender();
    return true;
  }
  function load() {
    if (!opened) return Promise.resolve(false);
    if (active) return active.promise;
    const request = { controller: new AbortController(), promise: null }, generation = ++sequence;
    active = request; status = mode === 'day' && fullChart ? 'ready' : 'loading'; error = '';
    request.promise = Promise.resolve().then(async () => {
      if (generation !== sequence || !opened) return false;
      try {
        if (!metadata) {
          const value = await client.getMeta({ signal: request.controller.signal });
          if (generation !== sequence || !opened) return false;
          metadata = validateLifetimeMetadata(value);
          minDate = metadata.startUtc.slice(0, 10);
          maxDate = new Date(Date.parse(metadata.endExclusiveUtc) - 1).toISOString().slice(0, 10);
          notify();
        }
        if (mode === 'day') { borrowDay(); notify(); return true; }
        while (generation === sequence && opened && mode === 'archive') {
          const requestedIndex = index;
          let chart;
          try {
            const point = await client.getPoint(requestedIndex, { signal: request.controller.signal });
            if (generation !== sequence || !opened || mode !== 'archive') return false;
            chart = lifetimeChartAt(metadata, validateLifetimeMoment(point, metadata, requestedIndex));
          } catch (failure) {
            if (generation !== sequence || !opened || mode !== 'archive') return false;
            if (requestedIndex !== index) continue;
            throw failure;
          }
          // A changed range may exclude a completed point. Other completed
          // points still show progress during continuous dragging.
          if (requestedIndex < minIndex || requestedIndex > maxIndex) continue;
          fullChart = chart; displayedIndex = requestedIndex;
          status = displayedIndex === index ? 'ready' : 'loading'; error = ''; notify();
          if (generation !== sequence || !opened || mode !== 'archive') return false;
          onRender();
          if (index === displayedIndex) return true;
        }
        return false;
      } catch (failure) {
        if (generation !== sequence || request.controller.signal.aborted) return false;
        status = 'error'; error = failure?.message || 'Не удалось загрузить шкалу лет.'; notify();
        return false;
      } finally { if (active === request) active = null; }
    });
    notify();
    return request.promise;
  }
  function open() {
    if (opened) return active?.promise || Promise.resolve(true);
    cancel(); opened = true; mode = 'day'; displayedIndex = minIndex = maxIndex = null;
    planetFilter.setExpanded(true);
    status = 'idle'; error = ''; borrowDay();
    const generation = sequence;
    notify();
    if (!opened || generation !== sequence) return Promise.resolve(false);
    onRender();
    return metadata ? Promise.resolve(true) : load();
  }

  function close() {
    if (!opened) return;
    cancel(); opened = false; status = 'idle'; error = '';
    planetFilter.setExpanded(false); notify(); onRender();
  }
  function scrub(value) {
    if (!opened || mode !== 'archive' || !metadata || !Number.isFinite(value)) return;
    const next = Math.max(minIndex, Math.min(maxIndex, Math.trunc(value)));
    if (next === index && status !== 'error') return;
    index = next; status = 'loading'; error = ''; notify();
    return load();
  }
  return {
    get current() { return opened ? current() : null; },
    get state() { return state(); },
    open, close, syncDay, scrub,
    setPlanet(...args) { return applySelection('setPlanet', ...args); },
    setAllPlanets(...args) { return applySelection('setAllPlanets', ...args); },
    syncClock() { if (opened && referenceIndex() !== notifiedReference) notify(); },
    goNow() { const reference = referenceIndex(); if (reference !== null) return scrub(reference); },
    toggle() { return opened ? close() : open(); },
    togglePlanet(...args) { return applySelection('togglePlanet', ...args); },
    toggleAllPlanets(...args) { return applySelection('toggleAllPlanets', ...args); },
    retry: load,
    setDateRange(from, through) {
      const start = dateStart(from), end = dateStart(through) + dayMilliseconds;
      if (!opened || !metadata || !Number.isFinite(start) || !Number.isFinite(end)
          || from < minDate || through > maxDate || from > through) return false;
      const currentDay = dayDate(getDayState());
      if (from === currentDay && through === currentDay) {
        if (mode === 'day') return true;
        cancel(); mode = 'day'; displayedIndex = minIndex = maxIndex = null;
        status = 'idle'; error = ''; borrowDay(); notify(); onRender();
        return true;
      }
      if (mode === 'archive' && from === fromDate && through === toDate) return true;
      const startUtc = Date.parse(metadata.startUtc), step = metadata.stepSeconds * 1000;
      minIndex = Math.max(0, Math.ceil((start - startUtc) / step));
      maxIndex = Math.min(metadata.samples - 1, Math.ceil((end - startUtc) / step) - 1);
      const shown = Date.parse(fullChart?.utc);
      const target = mode === 'archive' ? index : Number.isFinite(shown) ? Math.floor((shown - startUtc) / step) : minIndex;
      index = Math.max(minIndex, Math.min(maxIndex, target));
      mode = 'archive'; fromDate = from; toDate = through;
      const needsPoint = active || displayedIndex !== index;
      status = needsPoint ? 'loading' : 'ready'; error = '';
      notify();
      return needsPoint ? load() : true;
    },
  };
}
