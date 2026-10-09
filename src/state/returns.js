import { CYCLE_BODIES, DEFAULT_CYCLE_BODIES, eligibleCycleChart, cycleRangeForChart,
  cycleYearBoundsForChart, cycleEventWithinRange, cycleTimeZone, cycleCalendarYear } from '../domain/cycles.js';
import { createCyclesClient } from '../data/cycles-client.js';

const BODY_IDS = CYCLE_BODIES.map(item => item.id);
const normalizeBodies = value => Array.isArray(value) && value.every(id => BODY_IDS.includes(id))
  ? BODY_IDS.filter(id => value.includes(id)) : null;
const rememberedEvent = (event, id) => event && event.id === id && BODY_IDS.includes(event.body) && Number.isFinite(Date.parse(event.utc)) ? event : null;

// Filters own the event list; selecting an exact chart is an independent action.
// Each body's full-life result is shared by the list and the lower rail.
export function createReturnsController({ client = createCyclesClient(), onStateChange = () => {}, onRender = () => {}, onRequest = () => {} } = {}) {
  let natal = null, opened = false, markersEnabled = false, year = null, bodies = [...DEFAULT_CYCLE_BODIES];
  let current = null, selectedEvent = null, pendingEvent = null, chartError = '', loadingChart = false;
  let generation = 0, chartGeneration = 0, chartJob = null, failedEvent = null;
  let minYear = 1801, maxYear = 2399, calendarZone = 'UTC';
  // null events means not loaded; [] is a completed search with no returns.
  const records = new Map(), slots = new Set();
  const queue = [];
  const available = () => eligibleCycleChart(natal);
  const wanted = () => opened || markersEnabled;
  const pendingJobs = () => [...records.values()].flatMap(record => record.job ? [record.job] : []);
  let eventView = null;
  function visibleEvents() {
    const sources = bodies.map(body => records.get(body)?.events);
    if (!eventView || eventView.bodies !== bodies || eventView.year !== year || eventView.calendarZone !== calendarZone
        || sources.some((events, index) => events !== eventView.sources[index])) {
      const events = sources.flatMap(events => events || [])
        .filter(event => year === null || cycleCalendarYear(event.utc, calendarZone) === year)
        .sort((a, b) => Date.parse(a.utc) - Date.parse(b.utc));
      eventView = { bodies, year, calendarZone, sources, events };
    }
    // Consumers may reorder or clear their snapshot without changing our view.
    return [...eventView.events];
  }
  const state = () => ({ natal, available: available(), opened, bodies: [...bodies], year, minYear, maxYear,
    range: cycleRangeForChart(natal), events: visibleEvents(),
    errors: bodies.flatMap(body => records.get(body)?.error ? [records.get(body).error] : []), markersEnabled,
    pendingBodies: bodies.filter(body => records.get(body)?.job), loadingChart, selectedEvent, pendingEvent, chartError, current });
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
  function cancelSearch(record) { abortJob(record.job); record.job = null; }
  function cancelSearches() { for (const record of records.values()) cancelSearch(record); }
  function ensure({ hidden = false, extraBody = null } = {}) {
    if ((!wanted() && !hidden) || !available()) return Promise.resolve(false);
    const owner = natal, version = generation, range = cycleRangeForChart(owner);
    if (range.toAge <= range.fromAge) return Promise.resolve(false);
    const requestedBodies = extraBody && !bodies.includes(extraBody) ? [...bodies, extraBody] : bodies;
    let added = false;
    for (const body of requestedBodies) {
      let record = records.get(body);
      if (!record) { record = { events: null, error: null, job: null }; records.set(body, record); }
      if (record.events !== null || record.job || record.error) continue;
      const job = enqueue(async signal => {
        const owns = () => version === generation && !signal.aborted && record.job === job;
        if (!owns()) return false;
        try {
          const data = await client.events({ birthUtc: owner.utc, timezone: owner.timezone || 'UTC', body, ...range }, signal);
          if (!owns()) return false;
          record.events = data.events; return true;
        } catch (error) {
          if (!owns() || error?.name === 'AbortError') return false;
          record.error = { body, code: error.code || 'cycles_unavailable', message: error.message || 'Не удалось рассчитать возвраты.' };
          return false;
        } finally {
          if (owns()) { record.job = null; emit(); }
        }
      });
      record.job = job; added = true;
    }
    if (added) emit();
    return Promise.all(pendingJobs().map(job => job.promise));
  }
  function select(chart) {
    if (chart === natal) return;
    const same = available() && eligibleCycleChart(chart) && chart.id === natal.id && chart.utc === natal.utc && chart.timezone === natal.timezone;
    if (same) { natal = chart; emit(Boolean(current)); return; }
    const hadPreview = Boolean(current);
    generation++; cancelChart(); cancelSearches(); records.clear();
    natal = chart; opened = false; year = null; bodies = [...DEFAULT_CYCLE_BODIES];
    current = selectedEvent = failedEvent = null; chartError = ''; calendarZone = 'UTC';
    if (available()) {
      ({ minYear, maxYear } = cycleYearBoundsForChart(natal));
      calendarZone = cycleTimeZone(natal.timezone);
    }
    emit(hadPreview);
    if (markersEnabled) return ensure();
  }
  function enableMarkers(value) {
    if (typeof value !== 'boolean') return false;
    if (value === markersEnabled) return Promise.all(pendingJobs().map(job => job.promise));
    markersEnabled = value;
    if (!wanted()) cancelSearches();
    emit(); return ensure();
  }
  function open() { if (!available()) return Promise.resolve(false); opened = true; emit(); return ensure(); }
  function close() {
    const changed = opened || loadingChart || pendingEvent || !markersEnabled && pendingJobs().length;
    cancelChart(); opened = false;
    if (!markersEnabled) cancelSearches();
    if (changed) emit();
    return ensure();
  }
  function reset() {
    const changed = current || selectedEvent || failedEvent || chartError || loadingChart || pendingEvent;
    cancelChart(); current = selectedEvent = failedEvent = null; chartError = '';
    if (changed) emit(true);
  }
  function exit() {
    generation++; cancelChart(); cancelSearches(); records.clear(); markersEnabled = false; opened = false;
    current = selectedEvent = failedEvent = null; chartError = ''; emit(true);
  }
  function setBodies(value) {
    const next = normalizeBodies(value);
    if (!next) return false;
    if (next.length === bodies.length && next.every(body => bodies.includes(body))) return ensure();
    bodies = next;
    for (const [body, record] of records) if (!bodies.includes(body)) cancelSearch(record);
    emit(); return ensure();
  }
  function setYear(value) {
    if (value !== null && !Number.isInteger(value)) return false;
    const next = value === null ? null : Math.max(minYear, Math.min(maxYear, value));
    if (next === year) return ensure();
    year = next; emit(); return ensure();
  }
  function selectEvent(value, { valid = () => true, restoredEvent = null } = {}) {
    const id = typeof value === 'string' ? value : value?.id;
    const remembered = rememberedEvent(restoredEvent, id);
    const selected = [...records.values()].flatMap(record => record.events || []).find(event => event.id === id) || remembered;
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
    const version = generation;
    let exactVersion = chartGeneration;
    const owns = () => valid() && version === generation && exactVersion === chartGeneration;
    let eventId = saved.eventId;
    if (eventId) {
      const utc = saved.event?.id === eventId ? saved.event.utc : typeof eventId === 'string' ? eventId.slice(eventId.indexOf(':') + 1) : null;
      if (!cycleEventWithinRange(natal, utc)) { eventId = null; reset(); exactVersion = chartGeneration; }
    }
    bodies = normalizeBodies(saved.bodies) || [...DEFAULT_CYCLE_BODIES];
    year = Number.isInteger(saved.year) ? Math.max(minYear, Math.min(maxYear, saved.year)) : null;
    for (const [body, record] of records) if (!bodies.includes(body)) cancelSearch(record);
    opened = saved.opened === true; markersEnabled ||= Boolean(eventId); emit();
    if (!owns()) return false;
    if (eventId && rememberedEvent(saved.event, eventId)) {
      // Exact restoration goes first; full-life lists may complete afterwards.
      const selecting = selectEvent(eventId, { valid: owns, restoredEvent: saved.event });
      exactVersion = chartGeneration;
      void ensure();
      const selected = await selecting;
      return owns() && selected;
    }
    // Older snapshots can lack the exact descriptor. Search its body even when
    // it is unchecked; the result does not enter the filtered visible list.
    const eventBody = typeof eventId === 'string' ? eventId.split(':')[0] : null;
    await ensure({ hidden: true, extraBody: BODY_IDS.includes(eventBody) ? eventBody : null });
    if (!owns()) return false;
    if (eventId) {
      const selecting = selectEvent(eventId, { valid: owns }); exactVersion = chartGeneration;
      return await selecting && owns();
    }
    return true;
  }
  function retry() {
    if (!wanted() && !failedEvent) return Promise.resolve(false);
    if (failedEvent) return selectEvent(failedEvent.id, { restoredEvent: failedEvent });
    for (const body of bodies) { const record = records.get(body); if (record) record.error = null; }
    return ensure();
  }
  return { select, open, close, exit, reset, enableMarkers, setYear, setBodies, selectEvent, retry, restore,
    get state() { return state(); }, get current() { return current; } };
}
