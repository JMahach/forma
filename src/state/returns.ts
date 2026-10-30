import type { ObserveClientAction, ClientObservation } from '../../shared/client-report-contract.ts';
import type { ChartRecord } from '../../shared/chart-types.ts';
import type { CycleEvent, CycleInput } from '../../shared/cycles-format.ts';
import type { ChartInput } from '../domain/chart-composition.ts';
import type { CachedCycleChart, CyclesClient, CycleOwner } from '../data/cycles-client.ts';
import type { SavedReturnView } from '../data/view-store.ts';
import {returnSourceKey,type PackageRef,type MajorReturnsPackage} from '../../shared/library-package-contract.ts';
import { getConnectionMode, type ConnectionMode } from '../data/http-transport.ts';
interface ReturnJob<T> { controller: AbortController; promise: Promise<T> }
interface BodyReturns {
  events: CycleEvent[] | null;
  error: { body: string; code: string; message: string } | null;
  job: ReturnJob<boolean> | null;
  release: (() => void) | null;
  availability:number;probe:AbortController|null;
}
interface StoredFamily {
  body:string;input:CycleInput;packet:MajorReturnsPackage|null;record:BodyReturns;version:number;
}
export type ReturnsController = ReturnType<typeof createReturnsController>;
export type ReturnsState = ReturnsController['state'];
interface ReturnsOptions {
  connection?: () => ConnectionMode;
  observe?:ObserveClientAction;
  client?: CyclesClient;
  getOwner?: (chart: ChartRecord) => CycleOwner | null;
  onStateChange?: (state: ReturnsState) => void;
  onRender?: (chart: ChartInput | null, event: CycleEvent | null) => void;
  onRequest?: (event: CycleEvent) => void;
}

import { cycleUtcDifference } from '../../shared/cycles-format.ts';
import { EPHEMERIS_FIRST_YEAR, EPHEMERIS_LAST_YEAR } from '../../shared/date-limits.ts';
import { CYCLE_BODIES, DEFAULT_CYCLE_BODIES, eligibleCycleChart, cycleRangeForChart,
  cycleYearBoundsForChart, cycleEventWithinRange, cycleTimeZone, cycleCalendarYear } from '../domain/cycles.ts';
import { createCyclesClient } from '../data/cycles-client.ts';
import { extractChartData } from '../domain/chart-data.ts';

const BODY_IDS = CYCLE_BODIES.map(item => item.id);
const normalizeBodies = (value: unknown): string[] | null => Array.isArray(value) && value.every(id => BODY_IDS.includes(id))
  ? BODY_IDS.filter(id => value.includes(id)) : null;

// Owned natal packages are prepared by the server and library fill. The tool
// acquires dates on demand; temporary charts retain their existing preparation.
export function createReturnsController({ observe, connection = getConnectionMode, client = createCyclesClient(), getOwner = () => null, onStateChange = () => {}, onRender = () => {}, onRequest = () => {} }: ReturnsOptions = {}) {
  let natal: ChartRecord | null = null, opened = false, markersEnabled = false;
  let natalOwner: CycleOwner | null = null;
  const ownerSnapshot = (chart: ChartRecord | null) => { const owner=chart && getOwner(chart);return owner?{...owner}:null; };
  const sameOwner = (left:CycleOwner|null,right:CycleOwner|null) => left?.chartId===right?.chartId && left?.expectedAccountId===right?.expectedAccountId;
  let year: number | null = null, bodies = [...DEFAULT_CYCLE_BODIES];
  let current: ChartInput | null = null, selectedEvent: CycleEvent | null = null, pendingEvent: CycleEvent | null = null, chartError = '', chartErrorCode = '', loadingChart = false;
  let generation = 0, chartGeneration = 0;
  let chartJob: ReturnJob<unknown> | null = null, failedEvent: CycleEvent | null = null, releaseCurrent: (() => void) | null = null;
  let minYear = EPHEMERIS_FIRST_YEAR, maxYear = EPHEMERIS_LAST_YEAR, calendarZone = 'UTC';
  // null events means not loaded; [] is a completed search with no returns.
  const records = new Map<string, BodyReturns>();
  function recordFor(body:string) {
    let record=records.get(body);
    if(!record){record={events:null,error:null,job:null,release:null,availability:0,probe:null};records.set(body,record);}
    return record;
  }
  // Availability is a view of the current owner's existing data, not another
  // chart cache. A changed selection cancels all outstanding device probes.
  let readyEvents = new Set<string>(), availabilityJob: AbortController | null = null;
  const offline = () => connection() === 'offline';
  const readyWholeBodies=new Set<string>();
  const readyBodies = () => BODY_IDS.filter(body => records.get(body)?.events != null && (!offline() || !natalOwner || readyWholeBodies.has(body)));
  const available = () => eligibleCycleChart(natal);
  const wanted = () => opened || markersEnabled;
  const pendingJobs = (wantedBodies = bodies) => wantedBodies.flatMap(body => records.get(body)?.job ? [records.get(body)!.job!] : []);
  let eventView: { bodies: string[]; year: number | null; calendarZone: string; sources: (CycleEvent[] | null | undefined)[]; events: CycleEvent[] } | null = null;
  function visibleEvents() {
    const sources = bodies.map(body => records.get(body)?.events);
    if (!eventView || eventView.bodies !== bodies || eventView.year !== year || eventView.calendarZone !== calendarZone
        || sources.some((events, index) => events !== eventView!.sources[index])) {
      const events = sources.flatMap(events => events || [])
        .filter(event => year === null || cycleCalendarYear(event.utc, calendarZone) === year)
        .sort((a, b) => Date.parse(a.utc) - Date.parse(b.utc));
      eventView = { bodies, year, calendarZone, sources, events };
    }
    // Consumers may reorder or clear their snapshot without changing our view.
    return [...eventView.events];
  }
  const state = () => ({ natal, available: available(), opened, bodies: [...bodies], year, minYear, maxYear,
    offline: offline(), canOpen: available() && (!offline() || readyBodies().length > 0), readyBodies: readyBodies(), readyEvents: [...readyEvents],
    range: cycleRangeForChart(natal), events: visibleEvents(),
    errors: bodies.flatMap(body => records.get(body)?.error ? [records.get(body)!.error!] : []), markersEnabled,
    pendingBodies: bodies.filter(body => records.get(body)?.job), loadingChart, selectedEvent, pendingEvent, chartError, chartErrorCode, current });
  function emit(render = false) { if (render) onRender(current, selectedEvent); onStateChange(state()); }
  // Admission belongs after client RAM/device lookup, not before it. Each
  // controller job is only this tool's cancellable wait for a shared result.
  function start<T>(run: (signal: AbortSignal) => Promise<T>): ReturnJob<T> {
    const job: ReturnJob<T> = { controller: new AbortController(), promise: null as unknown as Promise<T> };
    job.promise = Promise.resolve().then(() => run(job.controller.signal));
    return job;
  }
  function abortJob(job: ReturnJob<unknown> | null) { job?.controller.abort(); }
  function cancelChart() {
    chartGeneration++; abortJob(chartJob); chartJob = null; loadingChart = false; pendingEvent = null;
  }
  function dropCurrent() { releaseCurrent?.(); releaseCurrent = null; current = null; }
  function acceptChart(input: CycleInput, data: CachedCycleChart, event: CycleEvent) {
    const release = client.retainChart?.(input, data);
    dropCurrent(); releaseCurrent = release; current = extractChartData(data.chart);
    selectedEvent = event; failedEvent = null; chartError = ''; chartErrorCode = ''; loadingChart = false; pendingEvent = null; chartJob = null; emit(true);
  }
  function cancelSearch(record: BodyReturns) { abortJob(record.job); record.job = null; }
  function cancelSearches() {
    for (const record of records.values()) { cancelSearch(record);record.availability++;record.probe?.abort();record.probe=null;record.release?.(); record.release = null; }
  }
  function acceptStoredFamily(part:StoredFamily) {
    if(part.version!==part.record.availability)return false;
    const {body,input,packet,record}=part;
    const wasReady=readyWholeBodies.has(body);
    if(packet)readyWholeBodies.add(body);else readyWholeBodies.delete(body);
    let changed=offline() && wasReady!==!!packet;
    if(packet && record.events===null){record.release?.();record.release=client.retainEvents?.(input,packet.dates)??null;record.events=packet.dates.events;changed=true;}
    if(packet && (record.error || record.job)){cancelSearch(record);record.error=null;}
    return changed;
  }
  function publishStoredFamilies() {
    readyEvents=new Set(offline()?visibleEvents().filter(event=>readyWholeBodies.has(event.body)).map(event=>event.id):[]);
    if(offline() && current && selectedEvent)readyEvents.add(selectedEvent.id);
    emit();
  }
  async function readStoredFamily(owner:ChartRecord,destination:CycleOwner,body:string,
    options:{signal:AbortSignal;observeOnly?:boolean;probe?:AbortController}):Promise<StoredFamily> {
    const record=recordFor(body),version=++record.availability;record.probe?.abort();record.probe=options.probe??null;
    const input={birthUtc:owner.utc!,timezone:owner.timezone||'UTC',body,...cycleRangeForChart(owner)!};
    let packet:MajorReturnsPackage|null=null;
    try{packet=await client.readFamily(input,destination,{signal:options.signal,observeOnly:options.observeOnly});}catch{/* Optional device read. */}
    finally{if(record.probe===options.probe)record.probe=null;}
    return {body,input,packet,record,version};
  }
  async function refreshOwnedFamilies(owner:ChartRecord,destination:CycleOwner,signal:AbortSignal,owns:()=>boolean) {
    const parts=await Promise.all(DEFAULT_CYCLE_BODIES.map(body=>readStoredFamily(owner,destination,body,{signal})));
    if(!owns() || !sameOwner(destination,ownerSnapshot(natal)))return;
    availabilityJob=null;const changed=parts.map(acceptStoredFamily);if(changed.some(Boolean))publishStoredFamilies();
  }
  async function refreshStoredPackage(ref:Exclude<PackageRef,{kind:'card'}>):Promise<void> {
    const owner=natal,destination=ownerSnapshot(owner);
    if(ref.kind!=='major-returns' || !available() || !destination
      || ref.sourceKey!==returnSourceKey({birthUtc:owner!.utc!,timezone:owner!.timezone||'UTC'}))return;
    const probe=new AbortController();
    const part=await readStoredFamily(owner!,destination,ref.family,{signal:probe.signal,probe,observeOnly:true});
    if(sameOwner(destination,ownerSnapshot(natal)) && acceptStoredFamily(part))publishStoredFamilies();
  }
  async function refreshReadyCharts() {
    availabilityJob?.abort(); availabilityJob = null;
    if (!offline() || !available()) { const changed = readyEvents.size > 0; readyEvents.clear();readyWholeBodies.clear(); if (changed) emit(); return; }
    const controller = new AbortController(), version = generation, owner = natal!;
    availabilityJob = controller;
    const destination=getOwner(owner);
    if(destination)return refreshOwnedFamilies(owner,destination,controller.signal,()=>!controller.signal.aborted && version===generation && offline());
    const events = visibleEvents(), visible = new Map(events.map(event => [event.id,event]));
    readyEvents = new Set([...readyEvents].filter(id => visible.has(id)));
    if (current && selectedEvent) readyEvents.add(selectedEvent.id);
    emit();
    const owns = () => !controller.signal.aborted && version === generation && offline();
    const candidates = client.preparedChartInputs
      ? await client.preparedChartInputs({birthUtc:owner.utc!,timezone:owner.timezone||'UTC'},{signal:controller.signal}).catch(()=>[])
      : events.map(event=>({birthUtc:owner.utc!,body:event.body,eventUtc:event.utc,timezone:owner.timezone||'UTC'}));
    if(!owns())return;
    // An absent catalogue key is no longer ready. Only the accepted chart
    // remains usable independently of cache ownership; candidates are rechecked.
    readyEvents = new Set(current && selectedEvent ? [selectedEvent.id] : []);
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (owns() && index < candidates.length) {
        const input = candidates[index++], event = visible.get(`${input.body}:${input.eventUtc}`);
        if(!event)continue;
        if (current && event.id === selectedEvent?.id) continue;
        let ready = false;
        try { ready = Boolean(await client.readChart?.({ birthUtc: owner.utc!, timezone: owner.timezone || 'UTC', body: event.body, eventUtc: event.utc }, { signal: controller.signal })); }
        catch { /* A failed optional device read leaves the action unavailable. */ }
        if (!owns()) return;
        if (ready) readyEvents.add(event.id); else readyEvents.delete(event.id);
      }
    }));
    if (owns()) { availabilityJob = null; emit(); }
  }
  function refreshAvailability() {
    if (!offline()) { availabilityJob?.abort(); availabilityJob = null; readyEvents.clear(); emit(); return Promise.resolve(); }
    return ensure().then(() => {});
  }
  function ensure({ waitBodies = bodies } = {}) {
    if (!available()) return Promise.resolve(false);
    if(offline() && natal && getOwner(natal))return refreshReadyCharts().then(()=>[readyBodies().length>0]);
    if(!wanted() && (natalOwner || natal && 'accountId' in natal && typeof natal.accountId==='string'))return Promise.resolve(false);
    const owner = natal, version = generation, range = cycleRangeForChart(owner)!;
    if (range.toAge <= range.fromAge) return Promise.resolve(false);
    let added = false,remaining=0,observation:ClientObservation|undefined;
    const required = new Set([...DEFAULT_CYCLE_BODIES, ...bodies, ...waitBodies]);
    for (const body of BODY_IDS.filter(body => required.has(body))) {
      const record = recordFor(body);
      if (record.events !== null || record.job || record.error) continue;
      observation??=observe?.({action:'calculate',component:'cycles'});remaining++;
      const job = start(async signal => {
        const owns = () => version === generation && !signal.aborted && record.job === job;
        try {
          if (!owns()) return false;
          const input = { birthUtc: owner!.utc!, timezone: owner!.timezone || 'UTC', body, ...range };
          const requestedOwner = getOwner(owner!);
          const data = offline() ? await client.readEvents?.(input, {signal,owner:requestedOwner}) : await client.events(input, signal, {owner: requestedOwner});
          if (!owns()) return false;
          if (!data) return false;
          record.release = client.retainEvents?.(input, data);
          record.events = data.events;
          const destination=natal && getOwner(natal);
          if(destination && (destination.chartId!==requestedOwner?.chartId || destination.expectedAccountId!==requestedOwner?.expectedAccountId))
            void client.syncPrepared?.(input,destination,signal).catch(()=>{});
          return true;
        } catch (failure) {
          const error = failure as Error & { code?: string };
          if (!owns() || error?.name === 'AbortError') return false;
          void observation?.reportError(failure,{stage:'request'});
          record.error = { body, code: error.code || 'cycles_unavailable', message: error.message || 'Не удалось рассчитать возвраты.' };
          return false;
        } finally {
          try { if (owns()) { record.job = null; emit(); } }
          finally { if(--remaining===0)observation?.finishSuccess(); }
        }
      });
      record.job = job; added = true;
    }
    if (added) emit();
    return Promise.all(pendingJobs(waitBodies).map(job => job.promise)).then(async result => { await refreshReadyCharts(); return result; });
  }
  /** Confirmation changes library identity, never the prepared numerical input. */
  function adopt(chart:ChartRecord) {
    if(!available() || !eligibleCycleChart(chart) || chart.utc!==natal!.utc || chart.timezone!==natal!.timezone)return false;
    const destination=ownerSnapshot(chart),range=cycleRangeForChart(chart);
    const changed=natal!.id!==chart.id || !sameOwner(natalOwner,destination);
    natal=chart;natalOwner=destination;
    if(changed && destination && range) {
      for(const [body,record] of records)if(record.events!==null && DEFAULT_CYCLE_BODIES.includes(body))
        void client.syncPrepared?.({birthUtc:chart.utc!,timezone:chart.timezone||'UTC',body,...range},destination).catch(()=>{});
      // A restored full chart can outlive its optional list of dates in device storage.
      if(current && selectedEvent && !records.get(selectedEvent.body)?.events?.some(event=>event.utc===selectedEvent!.utc))
        void client.syncPrepared?.({birthUtc:chart.utc!,timezone:chart.timezone||'UTC',body:selectedEvent.body,eventUtc:selectedEvent.utc},destination).catch(()=>{});
    }
    emit(Boolean(current));return true;
  }
  function select(chart: ChartRecord | null) {
    if (chart === natal && sameOwner(natalOwner,ownerSnapshot(chart))) return;
    const same = available() && eligibleCycleChart(chart) && chart!.id === natal!.id && chart!.utc === natal!.utc && chart!.timezone === natal!.timezone;
    if (same && adopt(chart!)) return;
    const hadPreview = Boolean(current);
    generation++; availabilityJob?.abort(); availabilityJob = null; readyEvents.clear();readyWholeBodies.clear(); cancelChart(); cancelSearches(); records.clear();
    natal = chart; natalOwner=ownerSnapshot(chart); opened = false; year = null; bodies = [...DEFAULT_CYCLE_BODIES];
    dropCurrent(); selectedEvent = failedEvent = null; chartError = ''; chartErrorCode = ''; calendarZone = 'UTC';
    if (available()) {
      ({ minYear, maxYear } = cycleYearBoundsForChart(natal!));
      calendarZone = cycleTimeZone(natal!.timezone);
    }
    emit(hadPreview);
    return ensure();
  }
  function enableMarkers(value: boolean) {
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
    return Promise.all(pendingJobs().map(job => job.promise));
  }
  function reset() {
    const changed = current || selectedEvent || failedEvent || chartError || loadingChart || pendingEvent;
    cancelChart(); dropCurrent(); selectedEvent = failedEvent = null; chartError = ''; chartErrorCode = '';
    if (changed) emit(true);
  }
  function exit() {
    // Closing tools leaves the selected natal's date preparation intact.
    cancelChart(); markersEnabled = false; opened = false;
    dropCurrent(); selectedEvent = failedEvent = null; chartError = ''; chartErrorCode = ''; emit(true);
  }
  function setBodies(value: unknown) {
    const next = normalizeBodies(value);
    if (!next) return false;
    if (next.length === bodies.length && next.every(body => bodies.includes(body))) return ensure();
    bodies = next;
    emit(); return ensure();
  }
  function setYear(value: number | null) {
    if (value !== null && !Number.isInteger(value)) return false;
    const next = value === null ? null : Math.max(minYear, Math.min(maxYear, value));
    if (next === year) return ensure();
    year = next; emit(); return ensure();
  }
  function selectEvent(value: string | CycleEvent, { valid = () => true }: { valid?: () => boolean } = {}) {
    const id = typeof value === 'string' ? value : value?.id;
    const selected = [...records.values()].flatMap(record => record.events || []).find(event => event.id === id);
    if (!available() || !selected) return Promise.resolve(false);
    if (offline() && !readyEvents.has(selected.id)) return Promise.resolve(false);
    cancelChart(); const version = chartGeneration, owner = natal;
    onRequest(selected);
    loadingChart = true; pendingEvent = selected; failedEvent = null; chartError = ''; chartErrorCode = ''; emit();
    const observation=observe?.({action:'calculate',component:'cycles'});
    const job = start(async signal => {
      if (version !== chartGeneration || signal.aborted) return false;
      try {
        const input = { birthUtc: owner!.utc!, body: selected.body, eventUtc: selected.utc, timezone: owner!.timezone || 'UTC' };
        const requestedOwner=getOwner(owner!);
        const data = offline() ? await client.readChart?.(input, {signal,owner:requestedOwner,opened:true}) : await client.chart(input, signal, { event: selected, owner: requestedOwner });
        if (version !== chartGeneration || signal.aborted) return false;
        if (!data) { readyEvents.delete(selected.id); loadingChart = false; pendingEvent = null; chartJob = null; emit(); return false; }
        if (!valid()) { cancelChart(); emit(); return false; }
        const destination=natal && getOwner(natal);
        if(destination && (destination.chartId!==requestedOwner?.chartId || destination.expectedAccountId!==requestedOwner?.expectedAccountId))
          void client.syncPrepared?.(input,destination,signal).catch(()=>{});
        acceptChart(input, data, selected); return true;
      } catch (failure) {
          const error = failure as Error & { code?: string };
        if (version !== chartGeneration || signal.aborted || error?.name === 'AbortError') return false;
        if (!valid()) { cancelChart(); emit(); return false; }
        void observation?.reportError(failure,{stage:'request'});
        chartError = error.message || 'Не удалось загрузить карту возврата.'; chartErrorCode = error.code || ''; failedEvent = selected; loadingChart = false; pendingEvent = null; chartJob = null; emit(); return false;
      }
    });
    chartJob = job; return job.promise.finally(()=>observation?.finishSuccess());
  }
  async function restore(saved: SavedReturnView | null | undefined, { valid = () => true }: { valid?: () => boolean } = {}) {
    if (!available() || !saved || !valid()) return false;
    const version = generation;
    let exactVersion = chartGeneration;
    const owns = () => valid() && version === generation && exactVersion === chartGeneration;
    let eventId = saved.eventId;
    const eventUtc = typeof eventId === 'string' ? eventId.slice(eventId.indexOf(':') + 1) : null;
    if (eventId) {
      if (!cycleEventWithinRange(natal, eventUtc!)) { eventId = null; reset(); exactVersion = chartGeneration; }
    }
    bodies = normalizeBodies(saved.bodies) || [...DEFAULT_CYCLE_BODIES];
    year = Number.isInteger(saved.year) ? Math.max(minYear, Math.min(maxYear, saved.year!)) : null;
    opened = saved.opened === true; markersEnabled ||= Boolean(eventId); emit();
    if (!owns()) return false;
    // The saved event ID is only a target. Its descriptor comes from a
    // prepared calculation or the current exact UTC list.
    const eventBody = typeof eventId === 'string' ? eventId.split(':')[0] : null;
    if (BODY_IDS.includes(eventBody!) && client.readChart) {
      // The complete calculation owns one verified event label. A session's
      // older ordinal is never needed to render ready data.
      cancelChart(); exactVersion = chartGeneration;
      const input = { birthUtc: natal!.utc!, body: eventBody!, eventUtc: eventUtc!, timezone: natal!.timezone || 'UTC' };
      const requestedOwner=getOwner(natal!);
      const job = start(signal => client.readChart(input, { signal,owner:requestedOwner,opened:true }));
      chartJob = job;
      let data = null;
      try { data = await job.promise; } catch { /* Optional cached data may be unavailable. */ }
      if (!owns() || job.controller.signal.aborted || chartJob !== job) return false;
      chartJob = null;
      if (data) {
        onRequest(data.event!);
        if (!owns()) return false;
        acceptChart(input, data, data.event!); ensure(); return true;
      }
    }
    await ensure({ waitBodies: BODY_IDS.includes(eventBody!) ? [eventBody!] : bodies });
    if (!owns()) return false;
    if (eventId) {
      const events = records.get(eventBody!)?.events;
      if (events && !events.some(event => event.id === eventId)) {
        // A revised calculation can refine the root slightly. Only one nearby
        // event is unambiguous; its fresh descriptor owns cycle/pass/direction.
        const candidates = events.filter(event => Math.abs(cycleUtcDifference(event.utc, eventUtc!)) <= 1000);
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
  return { select, adopt, open, close, exit, reset, enableMarkers, setYear, setBodies, selectEvent, retry, restore, refreshAvailability,refreshStoredPackage,

    get available() { return available(); }, get natal() { return natal; }, get opened() { return opened; },
    get year() { return year; }, get selectedEvent() { return selectedEvent; },
    get pending() { return loadingChart || bodies.some(body=>Boolean(records.get(body)?.job)); },
    get state() { return state(); }, get current() { return current; } };
}
