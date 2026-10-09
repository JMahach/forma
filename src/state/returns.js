import { cycleUtcDifference } from '../../shared/cycles-format.js';
import { EPHEMERIS_FIRST_YEAR, EPHEMERIS_LAST_YEAR } from '../../shared/date-limits.js';
import { CYCLE_BODIES, DEFAULT_CYCLE_BODIES, eligibleCycleChart, cycleRangeForChart,
  cycleYearBoundsForChart, cycleEventWithinRange, cycleTimeZone, cycleCalendarYear } from '../domain/cycles.js';
import { createCyclesClient } from '../data/cycles-client.js';

const BODY_IDS = CYCLE_BODIES.map(item => item.id);
const normalizeBodies = value => Array.isArray(value) && value.every(id => BODY_IDS.includes(id))
  ? BODY_IDS.filter(id => value.includes(id)) : null;

// The selected saved natal prepares its default dates. Extra bodies load on
// demand; all prepared lists remain reusable while exact chart selection is independent.
export function createReturnsController({ client = createCyclesClient(), onStateChange = () => {}, onRender = () => {}, onRequest = () => {} } = {}) {
  let natal = null, opened = false, markersEnabled = false, year = null, bodies = [...DEFAULT_CYCLE_BODIES];
  let current = null, selectedEvent = null, pendingEvent = null, chartError = '', loadingChart = false;
  let generation = 0, chartGeneration = 0, chartJob = null, failedEvent = null, releaseCurrent = null;
  let minYear = EPHEMERIS_FIRST_YEAR, maxYear = EPHEMERIS_LAST_YEAR, calendarZone = 'UTC';
  // null events means not loaded; [] is a completed search with no returns.
  const records = new Map();
  const available = () => eligibleCycleChart(natal);
  const wanted = () => opened || markersEnabled;
  const pendingJobs = (wantedBodies = bodies) => wantedBodies.flatMap(body => records.get(body)?.job ? [records.get(body).job] : []);
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
  // Admission belongs after client RAM/device lookup, not before it. Each
  // controller job is only this tool's cancellable wait for a shared result.
  function start(run) {
    const job = { controller: new AbortController() };
    job.promise = Promise.resolve().then(() => run(job.controller.signal));
    return job;
  }
  function abortJob(job) { job?.controller.abort(); }
  function cancelChart() {
    chartGeneration++; abortJob(chartJob); chartJob = null; loadingChart = false; pendingEvent = null;
  }
  function dropCurrent() { releaseCurrent?.(); releaseCurrent = null; current = null; }
  function acceptChart(input, data, event) {
    const release = client.retainChart?.(input, data);
    dropCurrent(); releaseCurrent = release; current = data.chart;
    selectedEvent = event; failedEvent = null; chartError = ''; loadingChart = false; pendingEvent = null; chartJob = null; emit(true);
  }
  function cancelSearch(record) { abortJob(record.job); record.job = null; }
  function cancelSearches() {
    for (const record of records.values()) { cancelSearch(record); record.release?.(); }
  }
  function ensure({ waitBodies = bodies } = {}) {
    if (!available()) return Promise.resolve(false);
    const owner = natal, version = generation, range = cycleRangeForChart(owner);
    if (range.toAge <= range.fromAge) return Promise.resolve(false);
    let added = false;
    const required = new Set([...DEFAULT_CYCLE_BODIES, ...bodies, ...waitBodies]);
    for (const body of BODY_IDS.filter(body => required.has(body))) {
      let record = records.get(body);
      if (!record) { record = { events: null, error: null, job: null, release: null }; records.set(body, record); }
      if (record.events !== null || record.job || record.error) continue;
      const job = start(async signal => {
        const owns = () => version === generation && !signal.aborted && record.job === job;
        if (!owns()) return false;
        try {
          const input = { birthUtc: owner.utc, timezone: owner.timezone || 'UTC', body, ...range };
          const data = await client.events(input, signal);
          if (!owns()) return false;
          record.release = client.retainEvents?.(input, data);
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
    return Promise.all(pendingJobs(waitBodies).map(job => job.promise));
  }
  function select(chart) {
    if (chart === natal) return;
    const same = available() && eligibleCycleChart(chart) && chart.id === natal.id && chart.utc === natal.utc && chart.timezone === natal.timezone;
    if (same) { natal = chart; emit(Boolean(current)); return; }
    const hadPreview = Boolean(current);
    generation++; cancelChart(); cancelSearches(); records.clear();
    natal = chart; opened = false; year = null; bodies = [...DEFAULT_CYCLE_BODIES];
    dropCurrent(); selectedEvent = failedEvent = null; chartError = ''; calendarZone = 'UTC';
    if (available()) {
      ({ minYear, maxYear } = cycleYearBoundsForChart(natal));
      calendarZone = cycleTimeZone(natal.timezone);
    }
    emit(hadPreview);
    return ensure();
  }
  function enableMarkers(value) {
    if (typeof value !== 'boolean') return false;
    if (value === markersEnabled) return Promise.all(pendingJobs().map(job => job.promise));
    markersEnabled = value;
    emit(); return ensure();
  }
  function open() { if (!available()) return Promise.resolve(false); opened = true; emit(); return ensure(); }
  function close() {
    const changed = opened || loadingChart || pendingEvent;
    cancelChart(); opened = false;
    if (changed) emit();
    return ensure();
  }
  function reset() {
    const changed = current || selectedEvent || failedEvent || chartError || loadingChart || pendingEvent;
    cancelChart(); dropCurrent(); selectedEvent = failedEvent = null; chartError = '';
    if (changed) emit(true);
  }
  function exit() {
    // Closing tools leaves the selected natal's date preparation intact.
    cancelChart(); markersEnabled = false; opened = false;
    dropCurrent(); selectedEvent = failedEvent = null; chartError = ''; emit(true);
  }
  function setBodies(value) {
    const next = normalizeBodies(value);
    if (!next) return false;
    if (next.length === bodies.length && next.every(body => bodies.includes(body))) return ensure();
    bodies = next;
    emit(); return ensure();
  }
  function setYear(value) {
    if (value !== null && !Number.isInteger(value)) return false;
    const next = value === null ? null : Math.max(minYear, Math.min(maxYear, value));
    if (next === year) return ensure();
    year = next; emit(); return ensure();
  }
  function selectEvent(value, { valid = () => true } = {}) {
    const id = typeof value === 'string' ? value : value?.id;
    const selected = [...records.values()].flatMap(record => record.events || []).find(event => event.id === id);
    if (!available() || !selected) return Promise.resolve(false);
    cancelChart(); const version = chartGeneration, owner = natal;
    onRequest(selected);
    loadingChart = true; pendingEvent = selected; failedEvent = null; chartError = ''; emit();
    const job = start(async signal => {
      if (version !== chartGeneration || signal.aborted) return false;
      try {
        const input = { birthUtc: owner.utc, body: selected.body, eventUtc: selected.utc, timezone: owner.timezone || 'UTC' };
        const data = await client.chart(input, signal, { event: selected });
        if (version !== chartGeneration || signal.aborted) return false;
        if (!valid()) { cancelChart(); emit(); return false; }
        acceptChart(input, data, selected); return true;
      } catch (error) {
        if (version !== chartGeneration || signal.aborted || error?.name === 'AbortError') return false;
        if (!valid()) { cancelChart(); emit(); return false; }
        chartError = error.message || 'Не удалось загрузить карту возврата.'; failedEvent = selected; loadingChart = false; pendingEvent = null; chartJob = null; emit(); return false;
      }
    });
    chartJob = job; return job.promise;
  }
  async function restore(saved, { valid = () => true } = {}) {
    if (!available() || !saved || !valid()) return false;
    const version = generation;
    let exactVersion = chartGeneration;
    const owns = () => valid() && version === generation && exactVersion === chartGeneration;
    let eventId = saved.eventId;
    const eventUtc = typeof eventId === 'string' ? eventId.slice(eventId.indexOf(':') + 1) : null;
    if (eventId) {
      if (!cycleEventWithinRange(natal, eventUtc)) { eventId = null; reset(); exactVersion = chartGeneration; }
    }
    bodies = normalizeBodies(saved.bodies) || [...DEFAULT_CYCLE_BODIES];
    year = Number.isInteger(saved.year) ? Math.max(minYear, Math.min(maxYear, saved.year)) : null;
    opened = saved.opened === true; markersEnabled ||= Boolean(eventId); emit();
    if (!owns()) return false;
    // A saved descriptor is presentation history, not numerical authority.
    // Only a current-revision calculation or its exact UTC list can confirm it.
    const eventBody = typeof eventId === 'string' ? eventId.split(':')[0] : null;
    if (BODY_IDS.includes(eventBody) && client.readChart) {
      // The complete calculation owns one verified event label. A session's
      // older ordinal is never needed to render ready current-revision data.
      cancelChart(); exactVersion = chartGeneration;
      const input = { birthUtc: natal.utc, body: eventBody, eventUtc, timezone: natal.timezone || 'UTC' };
      const job = start(signal => client.readChart(input, { signal }));
      chartJob = job;
      let data = null;
      try { data = await job.promise; } catch { /* Optional cached data may be unavailable. */ }
      if (!owns() || job.controller.signal.aborted || chartJob !== job) return false;
      chartJob = null;
      if (data) {
        onRequest(data.event);
        if (!owns()) return false;
        acceptChart(input, data, data.event); ensure(); return true;
      }
    }
    await ensure({ waitBodies: BODY_IDS.includes(eventBody) ? [eventBody] : bodies });
    if (!owns()) return false;
    if (eventId) {
      const events = records.get(eventBody)?.events;
      if (events && !events.some(event => event.id === eventId)) {
        // A revised calculation can refine the root slightly. Only one nearby
        // event is unambiguous; its fresh descriptor owns cycle/pass/direction.
        const candidates = events.filter(event => Math.abs(cycleUtcDifference(event.utc, eventUtc)) <= 1000);
        if (candidates.length !== 1) { reset(); return valid() && version === generation; }
        eventId = candidates[0].id;
      }
      const selecting = selectEvent(eventId, { valid: owns }); exactVersion = chartGeneration;
      return await selecting && owns();
    }
    return true;
  }
  function retry() {
    if (!wanted() && !failedEvent) return Promise.resolve(false);
    if (failedEvent) return selectEvent(failedEvent.id);
    for (const body of bodies) { const record = records.get(body); if (record) record.error = null; }
    return ensure();
  }
  return { select, open, close, exit, reset, enableMarkers, setYear, setBodies, selectEvent, retry, restore,
    get state() { return state(); }, get current() { return current; } };
}
