import { CYCLE_BODIES, eligibleCycleChart, cycleRangeForChart, cycleRangeForYear,
  cycleCalendarYear, cycleYearBoundsForChart, cycleEventWithinRange } from '../domain/cycles.js';
import { createCyclesClient } from '../data/cycles-client.js';

const MAJOR = ['jupiter', 'north_node', 'saturn', 'uranus_opposition', 'chiron', 'uranus'];
const ANNUAL = ['sun', 'mercury', 'venus', 'mars'];
const BODIES = new Set(CYCLE_BODIES.map(item => item.id));
const rememberedEvent = (event, id) => event && event.id === id && BODIES.has(event.body) && Number.isFinite(Date.parse(event.utc)) ? event : null;

// Temporary exact charts belong to this exploration, never to the chart library.
export function createReturnsController({ client = createCyclesClient(), onStateChange = () => {}, onRender = () => {}, onRequest = () => {} } = {}) {
  let natal = null, opened = false, group = 'major', year = new Date().getFullYear(), body = 'saturn';
  let events = [], errors = [], current = null, selectedEvent = null, pendingEvent = null, chartError = '', loadingChart = false;
  let generation = 0, chartGeneration = 0, chartJob = null, failedEvent = null;
  let minYear = 1801, maxYear = 2399, markersEnabled = false, majorGeneration = 0;
  let majorEvents = [], majorErrors = [];
  const majorLoaded = new Set(), majorPending = new Map();
  const loaded = new Set(), pending = new Map(), slots = new Set();
  let queue = [];
  const available = () => eligibleCycleChart(natal);
  const rangeFor = () => group === 'year' ? cycleRangeForYear(natal, year) : cycleRangeForChart(natal);
  const majorGroup = () => group === 'major' || group === 'planet' && MAJOR.includes(body);
  const needsMajor = () => markersEnabled || opened && majorGroup();
  const displayEvents = () => group === 'major' ? majorEvents : group === 'planet' && MAJOR.includes(body) ? majorEvents.filter(event => event.body === body) : events;
  const displayErrors = () => group === 'major' ? majorErrors : group === 'planet' && MAJOR.includes(body) ? majorErrors.filter(error => error.body === body) : errors;
  const state = () => ({ natal, available: available(), opened, group, year, body, minYear, maxYear, range: rangeFor(),
    events: [...displayEvents()], errors: [...displayErrors()], markersEnabled, majorEvents: [...majorEvents], majorErrors: [...majorErrors], pendingBodies: [...new Set([...pending.keys(), ...majorPending.keys()])], loadingChart, selectedEvent, pendingEvent, chartError, current });
  function emit(render = false) { if (render) onRender(current, selectedEvent); onStateChange(state()); }
  function pump() {
    while (slots.size < 2 && queue.length) {
      const job = queue.shift();
      if (job.controller.signal.aborted) { job.resolve(false); continue; }
      slots.add(job);
      Promise.resolve().then(() => job.run(job.controller.signal)).then(job.resolve, job.reject).finally(() => { slots.delete(job); pump(); });
    }
  }
  function enqueue(run, priority = false) {
    const job = { run, controller: new AbortController() };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    priority ? queue.unshift(job) : queue.push(job);
    pump(); return job;
  }
  function abortJob(job) {
    if (!job) return;
    job.controller.abort();
    const index = queue.indexOf(job);
    if (index >= 0) { queue.splice(index, 1); job.resolve(false); }
  }
  function cancelChart() {
    chartGeneration++; abortJob(chartJob); chartJob = null; loadingChart = false; pendingEvent = null;
  }
  function cancel() {
    generation++; cancelChart();
    for (const job of pending.values()) abortJob(job);
    pending.clear();
  }
  function cancelMajor(clear = false) {
    majorGeneration++;
    for (const job of majorPending.values()) abortJob(job);
    majorPending.clear();
    if (clear) { majorEvents = []; majorErrors = []; majorLoaded.clear(); }
  }
  function ensureMajor() {
    if (!needsMajor() || !available()) return Promise.resolve(false);
    const owner = natal, version = majorGeneration;
    const range = cycleRangeForChart(owner);
    if (range.toAge <= range.fromAge) return Promise.resolve(false);
    const wanted = markersEnabled || group === 'major' ? MAJOR : [body];
    let added = false;
    for (const requested of wanted) {
      if (majorLoaded.has(requested) || majorPending.has(requested) || majorErrors.some(error => error.body === requested)) continue;
      const job = enqueue(async signal => {
        if (version !== majorGeneration || signal.aborted || !needsMajor()) return false;
        try {
          const data = await client.events({ birthUtc: owner.utc, timezone: owner.timezone || 'UTC', body: requested, ...range }, signal);
          if (version !== majorGeneration || signal.aborted || !needsMajor()) return false;
          majorEvents = [...majorEvents.filter(event => event.body !== requested), ...data.events].sort((a, b) => Date.parse(a.utc) - Date.parse(b.utc));
          majorLoaded.add(requested); return true;
        } catch (error) {
          if (version !== majorGeneration || signal.aborted || error?.name === 'AbortError') return false;
          majorErrors = [...majorErrors.filter(item => item.body !== requested), { body: requested, code: error.code || 'cycles_unavailable', message: error.message || 'Не удалось рассчитать возвраты.' }];
          return false;
        } finally {
          if (version === majorGeneration) { majorPending.delete(requested); emit(); }
        }
      });
      majorPending.set(requested, job);
      added = true;
    }
    if (added) emit();
    return Promise.all([...majorPending.values()].map(job => job.promise));
  }
  function enableMarkers(value) {
    if (typeof value !== 'boolean') return false;
    if (value === markersEnabled) return Promise.all([...majorPending.values()].map(job => job.promise));
    markersEnabled = value;
    if (!value && !(opened && group === 'major')) cancelMajor();
    emit(); return ensureMajor();
  }
  function wantedBodies() { return group === 'year' ? ANNUAL : [body]; }
  function ensure({ hidden = false } = {}) {
    const background = ensureMajor();
    if ((!opened && !hidden) || !available() || majorGroup()) return background;
    const owner = natal, version = generation, annual = group === 'year', chosenYear = year;
    const range = rangeFor();
    if (!range || range.toAge <= range.fromAge) return Promise.resolve(false);
    for (const requested of wantedBodies()) {
      if (loaded.has(requested) || pending.has(requested) || errors.some(error => error.body === requested)) continue;
      const job = enqueue(async signal => {
        if (version !== generation || (!opened && !hidden) || signal.aborted) return false;
        try {
          const data = await client.events({ birthUtc: owner.utc, timezone: owner.timezone || 'UTC', body: requested, ...range }, signal);
          if (version !== generation || (!opened && !hidden) || signal.aborted) return false;
          const received = annual ? data.events.filter(event => cycleCalendarYear(event.utc, owner.timezone || 'UTC') === chosenYear) : data.events;
          events = [...events.filter(event => event.body !== requested), ...received].sort((a, b) => Date.parse(a.utc) - Date.parse(b.utc));
          loaded.add(requested);
          return true;
        } catch (error) {
          if (version !== generation || signal.aborted || error?.name === 'AbortError') return false;
          errors = [...errors.filter(item => item.body !== requested), { body: requested, code: error.code || 'cycles_unavailable', message: error.message || 'Не удалось рассчитать возвраты.' }];
          return false;
        } finally {
          if (version === generation) { pending.delete(requested); emit(); }
        }
      });
      pending.set(requested, job);
    }
    emit(); return Promise.all([background, ...[...pending.values()].map(job => job.promise)]);
  }
  function select(chart) {
    if (chart === natal) return;
    const same = available() && eligibleCycleChart(chart) && chart.id === natal.id && chart.utc === natal.utc && chart.timezone === natal.timezone;
    if (same) {
      natal = chart;
      emit(Boolean(current)); return;
    }
    const hadPreview = Boolean(current);
    cancel(); cancelMajor(true); natal = chart; opened = false; group = 'major'; body = 'saturn'; events = []; errors = []; loaded.clear();
    current = selectedEvent = failedEvent = null; chartError = '';
    if (available()) {
      ({ minYear, maxYear } = cycleYearBoundsForChart(natal));
      year = Math.max(minYear, Math.min(maxYear, new Date().getFullYear()));
    }
    emit(hadPreview);
    if (markersEnabled) return ensureMajor();
  }
  function open() { if (!available()) return Promise.resolve(false); opened = true; emit(); return ensure(); }
  function close() {
    const changed = opened || loadingChart || pendingEvent || pending.size || !markersEnabled && majorPending.size;
    cancel(); opened = false; if (!markersEnabled) cancelMajor();
    if (changed) emit();
    return ensureMajor();
  }
  function reset() {
    const changed = current || selectedEvent || failedEvent || chartError || loadingChart || pendingEvent;
    cancelChart(); current = selectedEvent = failedEvent = null; chartError = '';
    if (changed) emit(true);
  }
  function exit() { cancel(); cancelMajor(true); markersEnabled = false; opened = false; events = []; errors = []; loaded.clear(); current = selectedEvent = failedEvent = null; chartError = ''; emit(true); }
  function refresh() { cancel(); if (!needsMajor()) cancelMajor(); events = []; errors = []; loaded.clear(); chartError = ''; failedEvent = null; emit(); return ensure(); }
  function setGroup(value) { if (!['major', 'year', 'planet'].includes(value)) return false; if (group === value) return ensure(); group = value; return refresh(); }
  function setYear(value) {
    if (!Number.isInteger(value)) return false;
    const next = Math.max(minYear, Math.min(maxYear, value)); if (next === year) return ensure(); year = next; return refresh();
  }
  function setBody(value) { if (!BODIES.has(value)) return false; if (body === value) return ensure(); body = value; return refresh(); }
  function selectEvent(value, { valid = () => true, restoredEvent = null } = {}) {
    const id = typeof value === 'string' ? value : value?.id;
    const remembered = rememberedEvent(restoredEvent, id);
    const selected = displayEvents().find(event => event.id === id) || majorEvents.find(event => event.id === id) || remembered;
    if (!available() || !selected) return Promise.resolve(false);
    cancelChart(); const version = chartGeneration, owner = natal;
    onRequest(selected);
    loadingChart = true; pendingEvent = selected; failedEvent = null; chartError = ''; emit();
    const job = enqueue(async signal => {
      if (version !== chartGeneration || signal.aborted) return false;
      try {
        const data = await client.chart({ birthUtc: owner.utc, body: selected.body, eventUtc: selected.utc, timezone: owner.timezone || 'UTC' }, signal);
        if (version !== chartGeneration || signal.aborted) return false;
        if (!valid()) { cancelChart(); emit(); return false; }
        const event = data.event;
        current = data.chart;
        selectedEvent = event; loadingChart = false; pendingEvent = null; chartJob = null; emit(true); return true;
      } catch (error) {
        if (version !== chartGeneration || signal.aborted || error?.name === 'AbortError') return false;
        if (!valid()) { cancelChart(); emit(); return false; }
        chartError = error.message || 'Не удалось загрузить карту возврата.'; failedEvent = selected; loadingChart = false; pendingEvent = null; chartJob = null; emit(); return false;
      }
    }, true);
    chartJob = job; return job.promise;
  }
  async function restore(saved, { valid = () => true } = {}) {
    if (!available() || !saved || !valid()) return false;
    const owner = natal, version = generation;
    const owns = () => valid() && owner === natal && version === generation;
    let eventId = saved.eventId;
    if (eventId) {
      const utc = saved.event?.id === eventId ? saved.event.utc : typeof eventId === 'string' ? eventId.slice(eventId.indexOf(':') + 1) : null;
      if (!cycleEventWithinRange(owner, utc)) { eventId = null; reset(); }
    }
    group = ['major', 'year', 'planet'].includes(saved.group) ? saved.group : 'major';
    body = BODIES.has(saved.body) ? saved.body : 'saturn';
    if (Number.isInteger(saved.year)) year = Math.max(minYear, Math.min(maxYear, saved.year));
    opened = saved.opened === true; markersEnabled ||= Boolean(eventId); emit();
    if (!owns()) return false;
    if (eventId && rememberedEvent(saved.event, eventId)) {
      // The saved descriptor locates the exact chart without waiting for lists.
      // Queue it first; markers and an opened list keep their own background work.
      const selecting = selectEvent(eventId, { valid: owns, restoredEvent: saved.event });
      void ensure();
      const selected = await selecting;
      return owns() && selected;
    }
    await ensure({ hidden: true });
    if (!owns()) return false;
    const selected = eventId ? await selectEvent(eventId, { valid: owns, restoredEvent: saved.event }) : true;
    if (!owns()) return false;
    if (!saved.opened) close();
    return selected;
  }
  function retry() {
    if (!opened && !markersEnabled && !failedEvent) return Promise.resolve(false);
    if (failedEvent) return selectEvent(failedEvent.id, { restoredEvent: failedEvent });
    errors = []; majorErrors = []; return ensure();
  }
  return { select, open, close, exit, reset, enableMarkers, setGroup, setYear, setBody, selectEvent, retry, restore,
    get state() { return state(); }, get current() { return current; } };
}
