import type { ObserveClientAction, ClientObservation } from '../../shared/client-report-contract.ts';
import type { ChartRecord } from '../../shared/chart-types.ts';
import type { LifetimeMetadata } from '../../shared/lifetime-format.ts';
import type { ChartInput } from '../domain/chart-composition.ts';
import type { LifetimeClient } from '../data/lifetime-client.ts';
import type { TransitDayClient } from '../data/transit-day-client.ts';
import type { NatalDayClient } from '../data/natal-day-client.ts';
import type { SavedLifetimeView } from '../data/view-store.ts';
import type { TransitPlanetFilter } from './transit-planets.ts';
import { getConnectionMode, type ConnectionMode } from '../data/http-transport.ts';
interface LifetimeDayState { current: ChartInput | null; timeline?: { date: string } | null }
export interface LifetimeBounds { minUtc: number; maxUtc: number }
export type LifetimeTarget = SavedLifetimeView & { minimumUtc?: string; maximumUtc?: string };
type LifetimeRestoration = Omit<Partial<LifetimeTarget>, 'opened' | 'requestedUtc'> & { mode: 'day' | 'lifetime'; requestedUtc?: number | null };
type LifetimeDataClient = Omit<LifetimeClient, 'readMinute'> & Partial<Pick<LifetimeClient, 'readMinute'>>;
export interface MomentState { current: ChartInput | null; status: LifetimeStatus; error?: string; errorCode?: string; live?: boolean; retryCount?: number }
type LifetimeStatus = 'idle' | 'loading' | 'ready' | 'error' | 'preparing';
export type LifetimeExplorer = ReturnType<typeof createLifetimeExplorer>;
export type LifetimeState = LifetimeExplorer['state'];
interface LifetimeOptions {
  connection?: () => ConnectionMode;
  observe?:ObserveClientAction;
  dayClient?: TransitDayClient | null;
  natalDayClient?: NatalDayClient | null;
  getPersonalRecord?: () => Partial<ChartRecord> | null;
  client?: LifetimeDataClient;
  getDayState?: () => LifetimeDayState | null;
  now?: () => number;
  getMomentState?: () => MomentState | null | undefined;
  planetFilter?: TransitPlanetFilter;
  onStateChange?: (state: LifetimeState) => void;
  onRender?: () => void;
  onModeAccepted?: (state: Pick<LifetimeState, 'opened' | 'mode'>) => void;
}
type PlanetCommand = 'setPlanet' | 'setAllPlanets' | 'togglePlanet' | 'toggleAllPlanets';

import { createLifetimeClient } from '../data/lifetime-client.ts';
import { lifetimeChartAt, validateLifetimeMetadata, validateLifetimeMoment } from '../domain/lifetime.ts';
import { createTransitPlanetFilter } from './transit-planets.ts';

const dayMilliseconds = 86_400_000;
function dateStart(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value ? milliseconds : NaN;
}

// Today reuses the existing transit. A custom date range uses the lifetime.
// Only one point loads at a time; continuous scrubs retain the latest target.
export function createLifetimeExplorer({
  observe, connection = getConnectionMode, dayClient = null, natalDayClient = null, getPersonalRecord = () => null,
  client = createLifetimeClient({ dayClient, natalDayClient, getPersonalRecord }), getDayState = () => null, now = () => Date.now(),
  getMomentState = () => null,
  planetFilter = createTransitPlanetFilter(),
  onStateChange = () => {}, onRender = () => {}, onModeAccepted = () => {},
}: LifetimeOptions = {}) {
  let observation:ClientObservation|undefined;
  let metadata: LifetimeMetadata | null = null, fullChart: ChartInput | null = null, exploredChart: ChartInput | null = null;
  let requestedUtc: number | null = null, restoring = false, pendingRestore: LifetimeRestoration | null = null;
  const current = () => planetFilter.filter(fullChart);
  let interacting = false, selection = 0, selectionBounds: LifetimeBounds | null = null, selectionRound = Math.round;
  let opened = false, mode: 'day' | 'lifetime' = 'day', status: LifetimeStatus = 'idle', error = '', errorCode = '', sequence = 0;
  let active: { controller: AbortController; promise: Promise<boolean> } | null = null, notifiedReference: number | null = null;
  let retryCount = 0, retryTimer: ReturnType<typeof setTimeout> | null = null;
  let openStart = false, openEnded = false;
  let fromDate: string | null = null, toDate: string | null = null, minDate: string | null = null, maxDate: string | null = null;
  let minUtc: number | null = null, maxUtc: number | null = null, rangeCeiling: string | null = null;
  const shownUtc = () => fullChart ? Date.parse(fullChart.utc!) : null;
  const clampUtc = (value: number) => Math.max(minUtc!, Math.min(maxUtc!, value));
  const indexAt = (utc: number) => (utc - Date.parse(metadata!.startUtc)) / (metadata!.stepSeconds * 1000);
  const utcAt = (index: number) => Date.parse(metadata!.startUtc) + index * metadata!.stepSeconds * 1000;
  const limits = (bounds: LifetimeBounds | null) => ({ min: Math.max(minUtc!, bounds?.minUtc ?? minUtc!), max: Math.min(maxUtc!, bounds?.maxUtc ?? maxUtc!) });
  function gridUtc(value: number, round = Math.round, bounds: LifetimeBounds | null = null) {
    const { min, max } = limits(bounds), first = Math.ceil(indexAt(min)), last = Math.floor(indexAt(max));
    if (first > last) return bounds ? null : min;
    const index = Math.max(first, Math.min(last, round(indexAt(value))));
    return utcAt(index);
  }
  function setBounds(start: number, end: number, minimumUtc?: string, maximumUtc?: string) {
    rangeCeiling = maximumUtc ?? null;
    minUtc = Math.max(Date.parse(metadata!.startUtc), start, minimumUtc ? Date.parse(minimumUtc) : -Infinity);
    maxUtc = Math.min(Date.parse(metadata!.endExclusiveUtc) - 1, end - 1, rangeCeiling ? Date.parse(rangeCeiling) : Infinity);
  }
  function referenceUtc() {
    if (mode !== 'lifetime' || !metadata || minUtc === null) return null;
    const value = Math.floor(now() / 60000) * 60000;
    return Number.isFinite(value) && value >= minUtc && value <= maxUtc! ? value : null;
  }
  const offline = () => connection() === 'offline';
  const canScrub = () => (!offline() || mode === 'day' && Boolean(getDayState()?.current)
    || Boolean(metadata && minUtc !== null && maxUtc !== null && Number.isFinite(client.nearestMinute?.(requestedUtc ?? minUtc, {min: minUtc, max: maxUtc}, Math.round))));
  const state = () => ({ opened, mode, status, error, errorCode, retryCount, metadata, offline: offline(), canScrub: canScrub(), current: opened ? current() : null, requestedUtc, displayedUtc: shownUtc(),
    fromDate, toDate, openStart, openEnded, minDate, maxDate, minUtc, maxUtc, referenceUtc: referenceUtc(),
    ...planetFilter.state });
  function notify() { const value = state(); notifiedReference = value.referenceUtc; onStateChange(value); }
  function cancel() {
    observation?.finishSuccess();observation=undefined;
    clearTimeout(retryTimer!); retryTimer = null; retryCount = 0;
    sequence++; active?.controller.abort(); active = null; restoring = false; pendingRestore = null; selectionBounds = null; selectionRound = Math.round;
  }
  const dayDate = (day: LifetimeDayState | null) => day?.timeline?.date || day?.current?.localDate || null;
  function borrowDay() {
    const day = getDayState(), chart = day?.current || null, date = dayDate(day);
    const changed = chart !== fullChart || date !== fromDate || date !== toDate;
    fullChart = chart!; exploredChart = null; requestedUtc = shownUtc();
    fromDate = toDate = date; openStart = openEnded = false;
    if (!['error', 'preparing'].includes(status) && retryCount === 0) status = fullChart ? 'ready' : 'loading';
    return changed;
  }
  function syncDay() {
    if (!opened || mode !== 'day' || !borrowDay()) return false;
    notify(); return true;
  }
  function applySelection<K extends PlanetCommand>(method: K, ...args: Parameters<TransitPlanetFilter[K]>) {
    const previous = current();
    if (!(planetFilter[method] as (...values: Parameters<TransitPlanetFilter[K]>) => boolean)(...args)) return false;
    if (previous && current() === previous) return true;
    const generation = sequence;
    notify();
    if (opened && fullChart && generation === sequence) onRender();
    return true;
  }
  // A return or live minute already owns its calculated chart. Moving the rail
  // to that moment must not calculate a second, rounded lifetime chart.
  function alignMoment(chart: ChartInput | null | undefined) {
    const utc = Date.parse(chart?.utc!);
    if (!opened || mode !== 'lifetime' || !metadata || !Number.isFinite(utc)) return false;
    const next = clampUtc(utc);
    if (chart === fullChart && next === requestedUtc && !exploredChart && status === 'ready' && !active) return true;
    cancel(); requestedUtc = next; fullChart = chart!; exploredChart = null;
    status = 'ready'; error = ''; errorCode = ''; notify();
    return true;
  }
  function publishReady(chart: ChartInput, utc: number) {
    cancel(); requestedUtc = utc; fullChart = exploredChart = chart;
    status = 'ready'; error = ''; errorCode = '';
    const generation = sequence; notify();
    if (generation === sequence && opened && mode === 'lifetime') onRender();
    return Promise.resolve(true);
  }
  function chooseTarget(value: number, round = Math.round, bounds: LifetimeBounds | null = null) {
    const { min, max } = limits(bounds);
    if (min > max) return null;
    const clamped = Math.max(min, Math.min(max, value));
    // The accepted exploration result survives cache eviction. A borrowed natal/return
    // chart never becomes an exploration result merely by sharing its UTC.
    if (exploredChart && shownUtc() === clamped) return { utc: clamped, chart: exploredChart };
    const prepared = client.nearestMinute?.(clamped, { min, max }, round);
    if (Number.isFinite(prepared)) return { utc: prepared!, chart: client.peekMinute(prepared!) };
    const minute = Math.max(Math.ceil(min / 60000) * 60000,
      Math.min(Math.floor(max / 60000) * 60000, Math.round(clamped / 60000) * 60000));
    const chart = minute <= max ? client.peekMinute?.(minute) : null;
    if (chart || minute <= max && client.hasMinute?.(minute)) return { utc: minute, chart };
    // Another tab may have saved this day after the catalogue was prepared.
    // Keep the minute until a cache-only lookup can confirm it or miss.
    if (minute <= max && client.readMinute && !Number.isInteger(indexAt(minute))) return { utc: minute, chart: null };
    const utc = gridUtc(clamped, round, bounds);
    return utc === null ? null : { utc, chart: client.peekMinute?.(utc) || null };
  }
  function load(restoration = pendingRestore, refreshNatalDay = false) {
    if (!opened) return Promise.resolve(false);
    if (active) return active.promise;
    clearTimeout(retryTimer!); retryTimer = null;
    observation??=observe?.({action:'data_read',component:'lifetime'});
    const currentObservation=observation;
    const request = { controller: new AbortController(), promise: null as unknown as Promise<boolean> }, generation = ++sequence;
    active = request; restoring = Boolean(restoration); status = mode === 'day' && fullChart && retryCount === 0 ? 'ready' : 'loading'; error = ''; errorCode = '';
    request.promise = Promise.resolve().then(async () => {
      if (generation !== sequence || !opened) return false;
      try {
        let receivedMetadata = false;
        // An explicit opening checks whether the selected natal's day has
        // appeared since the last visit. Scrubs reuse that preparation.
        if (!metadata || refreshNatalDay || restoration?.mode === 'lifetime' && getPersonalRecord()) {
          const value = await client.getMeta({ signal: request.controller.signal, refreshNatalDay });
          if (generation !== sequence || !opened) return false;
          metadata = validateLifetimeMetadata(value); receivedMetadata = true;
          minDate = metadata!.startUtc.slice(0, 10);
          maxDate = new Date(Date.parse(metadata!.endExclusiveUtc) - 1).toISOString().slice(0, 10);
        }
        if (restoration?.mode === 'lifetime') {
          const from = restoration.openStart ? minDate : restoration.fromDate;
          const through = restoration.openEnded || (restoration.minimumUtc && restoration.toDate! > maxDate!)
            ? maxDate : restoration.toDate;
          const start = dateStart(from), end = dateStart(through) + dayMilliseconds;
          if (from! < minDate! || through! > maxDate! || from! > through!) {
            pendingRestore = null; mode = 'day'; borrowDay();
            onModeAccepted({ opened, mode });
            if (generation === sequence && opened) notify();
            return false;
          }
          setBounds(start, end, restoration.minimumUtc, restoration.maximumUtc);
          requestedUtc = clampUtc(restoration.requestedUtc ?? utcAt(restoration.index!));
          // Old snapshots only knew lifetime slots. New UTC snapshots retain
          // their selected minute even when its day must be loaded explicitly.
          if (restoration.requestedUtc === undefined) requestedUtc = gridUtc(requestedUtc);
          else if (restoration.requestedUtc! > maxUtc!) requestedUtc = Math.max(minUtc!, Math.floor(maxUtc! / 60000) * 60000);
          mode = 'lifetime'; fromDate = from!; toDate = through!; openStart = restoration.openStart!; openEnded = restoration.openEnded!;
          status = 'loading';
        }
        if (restoration) onModeAccepted({ opened, mode });
        if (generation !== sequence || !opened) return false;
        if (receivedMetadata || restoration) notify();
        if (generation !== sequence || !opened) return false;
        if (mode === 'day') {
          retryCount = 0; borrowDay(); notify();
          if (generation !== sequence || !opened) return false;
          if (restoration) onRender();
          pendingRestore = null;
          return true;
        }
        while (generation === sequence && opened && mode === 'lifetime') {
          const momentState = getMomentState();
          if (momentState) {
            if (momentState.current) alignMoment(momentState.current);
            else {
              exploredChart = null; status = momentState.status || 'loading'; error = momentState.error || ''; errorCode = momentState.errorCode || '';
              pendingRestore = null; notify();
            }
            return true;
          }
          let target = requestedUtc!;
          const selected = selection, bounds = selectionBounds, round = selectionRound;
          let chart: ChartInput | null | undefined, checkedDay: { date: string } | null = null;
          try {
            chart = client.peekMinute?.(target);
            if (!chart && client.readMinute && (offline() || client.hasMinute?.(target) || !Number.isInteger(indexAt(target)))) {
              chart = await client.readMinute(target, { signal: request.controller.signal });
              // Historical natal minutes can have UTC seconds; their miss
              // does not inspect the whole-minute transit day.
              if (target % 60000 === 0) checkedDay = { date: new Date(target).toISOString().slice(0, 10) };
            }
            if (generation !== sequence || !opened || mode !== 'lifetime') return false;
            // A disk miss has no ready progress to show. Recheck ownership and
            // the selected UTC before starting another request for this target.
            if (!chart && (getMomentState() || target !== requestedUtc)) continue;
            if (!chart && offline()) {
              pendingRestore = null; retryCount = 0; requestedUtc = shownUtc();
              status = fullChart ? 'ready' : 'idle'; error = ''; errorCode = ''; notify(); return false;
            }
            if (!chart) {
              // A catalogue can outlive a disk entry. Restoration and scrubbing
              // share the same bounded fallback to a prepared grid point.
              if (!Number.isInteger(indexAt(target))) {
                const fallback = gridUtc(target, round, bounds);
                // A narrow range can contain an exact birth boundary but no
                // prepared slot. Its boundary is not a valid file index.
                if (fallback === null || !Number.isInteger(indexAt(fallback))) {
                  if (target !== requestedUtc) continue;
                  pendingRestore = null; retryCount = 0;
                  requestedUtc = shownUtc(); status = fullChart ? 'ready' : 'idle'; notify();
                  return false;
                }
                if (exploredChart && shownUtc() === fallback) {
                  requestedUtc = fallback; status = 'ready'; error = ''; errorCode = ''; pendingRestore = null; notify();
                  return true;
                }
                if (target === requestedUtc) { requestedUtc = fallback; notify(); }
                target = fallback;
              }
              const requestedIndex = indexAt(target);
              const point = await client.getPoint(requestedIndex, { signal: request.controller.signal, checkedDay });
              chart = lifetimeChartAt(metadata, validateLifetimeMoment(point, metadata, requestedIndex));
            }
            if (generation !== sequence || !opened || mode !== 'lifetime') return false;
            // A live/exact owner can take over while this point is pending.
            // Do not publish it or continue a superseded coalesced scrub.
            if (getMomentState()) continue;
          } catch (failure) {
            if (generation !== sequence || !opened || mode !== 'lifetime') return false;
            if (getMomentState() || target !== requestedUtc) continue;
            throw failure;
          }
          // A changed range may exclude a completed point. Other completed
          // points still show progress during continuous dragging.
          if (target < minUtc! || target > maxUtc! || selected !== selection && !interacting) continue;
          fullChart = exploredChart = chart;
          retryCount = 0;
          status = target === requestedUtc ? 'ready' : 'loading'; error = ''; errorCode = ''; notify();
          if (generation !== sequence || !opened || mode !== 'lifetime') return false;
          onRender();
          if (target === requestedUtc) { pendingRestore = null; return true; }
        }
        return false;
      } catch (failure) {
        const problem = failure as Error & { code?: string };
        if (generation !== sequence || request.controller.signal.aborted) return false;
        if(problem?.code!=='lifetime_preparing')void currentObservation?.reportError(failure,{stage:'request'});
        error = ''; errorCode = problem?.code || '';
        if (offline() || problem?.code === 'offline') { status = fullChart ? 'ready' : 'idle'; retryCount = 0; }
        else if (problem?.code === 'lifetime_preparing') { status = 'preparing'; retryCount = 0; }
        else if (!metadata && problem?.code === 'lifetime_unavailable') {
          // Opening rejected the prepared file. A repaired file can be tried
          // again explicitly; repeating the same validation cannot repair it.
          status = 'error'; retryCount = 0; error = problem.message || 'Данные летописи недоступны.';
        } else {
          status = 'loading'; retryCount++;
          // Keep the selected target and last good chart. A new command cancels
          // this wait; only the still-current load may retry after its backoff.
          const delay = Math.min(30_000, 1000 * 2 ** Math.min(retryCount - 1, 5));
          retryTimer = setTimeout(() => {
            if (generation !== sequence || !opened) return;
            retryTimer = null; void load();
          }, delay);
        }
        notify();
        return false;
      } finally { if (active === request) {
        active = null; restoring = false;
        if(retryTimer===null){currentObservation?.finishSuccess();if(observation===currentObservation)observation=undefined;}
      } }
    });
    notify();
    return request.promise;
  }
  function open() {
    if (opened) return active?.promise || Promise.resolve(true);
    cancel(); opened = true; mode = 'day'; minUtc = maxUtc = rangeCeiling = null;
    planetFilter.setExpanded(true);
    status = 'idle'; error = ''; errorCode = ''; borrowDay();
    const generation = sequence;
    onModeAccepted({ opened, mode });
    if (!opened || generation !== sequence) return Promise.resolve(false);
    notify();
    if (!opened || generation !== sequence) return Promise.resolve(false);
    onRender();
    const refreshNatalDay = Boolean(getPersonalRecord());
    return offline() && fullChart || metadata && !refreshNatalDay ? Promise.resolve(true) : load(null, refreshNatalDay);
  }

  function restore(input: unknown) {
    const snapshot = input as LifetimeTarget | null;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
        || snapshot.opened !== true || !['day', 'lifetime'].includes(snapshot.mode)
        || snapshot.openEnded !== undefined && typeof snapshot.openEnded !== 'boolean'
        || snapshot.openStart !== undefined && typeof snapshot.openStart !== 'boolean') return Promise.resolve(false);
    if (snapshot.mode === 'lifetime' && (!(snapshot.requestedUtc === undefined ? Number.isSafeInteger(snapshot.index)
        : Number.isSafeInteger(snapshot.requestedUtc) && Number.isFinite(new Date(snapshot.requestedUtc!).getTime()))
        || !Number.isFinite(dateStart(snapshot.fromDate))
        || !snapshot.openEnded && (!Number.isFinite(dateStart(snapshot.toDate)) || snapshot.fromDate! > snapshot.toDate!))) return Promise.resolve(false);
    if (snapshot.minimumUtc !== undefined && (typeof snapshot.minimumUtc !== 'string'
        || !Number.isFinite(Date.parse(snapshot.minimumUtc))
        || Date.parse(snapshot.minimumUtc) < dateStart(snapshot.fromDate)
        || Date.parse(snapshot.minimumUtc) >= dateStart(snapshot.fromDate) + dayMilliseconds)) return Promise.resolve(false);
    if (snapshot.maximumUtc !== undefined && (typeof snapshot.maximumUtc !== 'string'
        || !Number.isFinite(Date.parse(snapshot.maximumUtc))
        || Date.parse(snapshot.maximumUtc) < Math.max(dateStart(snapshot.fromDate), snapshot.minimumUtc ? Date.parse(snapshot.minimumUtc) : -Infinity)
        || Date.parse(snapshot.maximumUtc) < dateStart(snapshot.toDate)
        || Date.parse(snapshot.maximumUtc) >= dateStart(snapshot.toDate) + dayMilliseconds)) return Promise.resolve(false);
    // Copy before awaiting metadata so caller mutation cannot change the restore target.
    const restoration = { mode: snapshot.mode, fromDate: snapshot.fromDate, toDate: snapshot.toDate,
      openStart: snapshot.openStart === true, openEnded: snapshot.openEnded === true, requestedUtc: snapshot.requestedUtc, index: snapshot.index, minimumUtc: snapshot.minimumUtc, maximumUtc: snapshot.maximumUtc };
    cancel(); opened = true; mode = restoration.mode; minUtc = maxUtc = rangeCeiling = null; exploredChart = null;
    planetFilter.setExpanded(true); status = 'idle'; error = ''; errorCode = '';
    if (mode === 'day') borrowDay();
    else { fullChart = null; requestedUtc = restoration.requestedUtc ?? null; fromDate = restoration.fromDate; toDate = restoration.toDate; openStart = restoration.openStart!; openEnded = restoration.openEnded!; }
    pendingRestore = restoration;
    return load(restoration, Boolean(getPersonalRecord()));
  }

  function close() {
    if (!opened) return;
    cancel(); interacting = false; opened = false; status = 'idle'; error = ''; errorCode = '';
    planetFilter.setExpanded(false);
    onModeAccepted({ opened, mode });
    notify(); onRender();
  }
  function scrub(value: number, bounds: LifetimeBounds | null = null, round = Math.round) {
    if (!opened || mode !== 'lifetime' || !metadata || !Number.isFinite(value)
        || bounds && (!Number.isFinite(bounds.minUtc) || !Number.isFinite(bounds.maxUtc))) return;
    const next = chooseTarget(value, round, bounds);
    if (!next) return;
    if (next.utc === requestedUtc && status !== 'error' && (exploredChart && shownUtc() === next.utc || active && !next.chart)) return;
    if (restoring || pendingRestore || retryTimer !== null || active && client.hasMinute?.(next.utc)) cancel();
    // The visible year constrains this command and its disk-miss fallback,
    // while the explorer keeps the person's full range and saved UTC.
    selectionBounds = bounds ? { minUtc: bounds.minUtc, maxUtc: bounds.maxUtc } : null;
    selectionRound = round;
    if (next.chart) return publishReady(next.chart, next.utc);
    selection++; retryCount = 0; requestedUtc = next.utc; status = 'loading'; error = ''; errorCode = ''; notify();
    return load();
  }
  function adjacentUtc(direction: number) {
    if (!opened || mode !== 'lifetime' || !metadata || !Number.isFinite(requestedUtc) || !direction) return null;
    const forward = direction > 0;
    const minute = (forward ? Math.floor(requestedUtc! / 60000) + 1 : Math.ceil(requestedUtc! / 60000) - 1) * 60000;
    if (!forward && minute <= minUtc!) return minUtc;
    const ready = minute <= maxUtc! && (client.hasMinute?.(minute) || client.peekMinute?.(minute));
    const grid = utcAt(forward ? Math.floor(indexAt(requestedUtc!)) + 1 : Math.ceil(indexAt(requestedUtc!)) - 1);
    const fallback = ready ? minute : forward && grid > maxUtc! ? requestedUtc : clampUtc(grid);
    const prepared = client.adjacentMinute?.(requestedUtc!, direction);
    if (!Number.isFinite(prepared) || prepared! < minUtc! || prepared! > maxUtc!) return fallback;
    if (Math.abs(prepared! - requestedUtc!) <= 60000) return prepared!;
    return fallback === requestedUtc ? prepared! : forward ? Math.min(prepared!, fallback!) : Math.max(prepared!, fallback!);
  }
  return {
    get current() { return opened ? current() : null; },
    get state() { return state(); },
    open, close, syncDay, scrub, restore, alignMoment,
    refreshAvailability: notify,

    setInteracting(value: boolean) { interacting = Boolean(value); },
    adjacentUtc,
    step(direction: number, bounds: LifetimeBounds | null = null, beforeSelect: (utc: number) => boolean | void = () => {}) {
      let target = adjacentUtc(direction);
      if (!Number.isFinite(target)) return;
      const forward = direction > 0;
      const minute = (forward ? Math.floor(requestedUtc! / 60000) + 1 : Math.ceil(requestedUtc! / 60000) - 1) * 60000;
      // Preserve the exact birth endpoint and prepared natal samples, including
      // historical UTC seconds. Only an unknown neighbour needs a disk probe.
      const ready = target === minUtc || client.hasMinute?.(target!) || client.peekMinute?.(target!);
      if (!ready && client.readMinute && minute >= minUtc! && minute <= maxUtc!)
        target = target === requestedUtc ? minute : forward ? Math.min(target!, minute) : Math.max(target!, minute);
      const { min, max } = limits(bounds);
      if (min > max) return;
      target = Math.max(min, Math.min(max, target!));
      if (beforeSelect(target) === false) return;
      return scrub(target, bounds, forward ? Math.ceil : Math.floor);
    },
    setPlanet(...args: Parameters<TransitPlanetFilter['setPlanet']>) { return applySelection('setPlanet', ...args); },
    setAllPlanets(...args: Parameters<TransitPlanetFilter['setAllPlanets']>) { return applySelection('setAllPlanets', ...args); },
    syncClock() {
      if (!opened || referenceUtc() === notifiedReference) return false;
      notify(); return true;
    },
    goNow() { const reference = referenceUtc(); if (reference !== null) return scrub(reference); },
    togglePlanet(...args: Parameters<TransitPlanetFilter['togglePlanet']>) { return applySelection('togglePlanet', ...args); },
    toggleAllPlanets(...args: Parameters<TransitPlanetFilter['toggleAllPlanets']>) { return applySelection('toggleAllPlanets', ...args); },
    retry: load,
    setDateRange(from: string | null | undefined, through: string | null | undefined) {
      const nextOpenStart = from === null || from === undefined || from === '';
      if (nextOpenStart) from = minDate;
      const nextOpenEnded = through === null || through === undefined || through === '';
      if (nextOpenEnded) through = maxDate;
      const start = dateStart(from), end = dateStart(through) + dayMilliseconds;
      if (!opened || !metadata || !Number.isFinite(start) || !Number.isFinite(end)
          || from! < minDate! || through! > maxDate! || from! > through!) return false;
      selectionBounds = null; selectionRound = Math.round;
      const currentDay = dayDate(getDayState());
      if (!nextOpenStart && !nextOpenEnded && from === currentDay && through === currentDay) {
        if (mode === 'day') return true;
        cancel(); mode = 'day'; minUtc = maxUtc = rangeCeiling = null;
        status = 'idle'; error = ''; errorCode = ''; borrowDay();
        const generation = sequence;
        onModeAccepted({ opened, mode });
        if (generation !== sequence || !opened) return false;
        notify(); onRender();
        return true;
      }
      if (mode === 'lifetime' && from === fromDate && through === toDate) {
        if (openStart === nextOpenStart && openEnded === nextOpenEnded) return true;
        if (restoring || pendingRestore || retryTimer !== null) cancel();
        openStart = nextOpenStart; openEnded = nextOpenEnded;
        const generation = sequence;
        onModeAccepted({ opened, mode });
        if (generation !== sequence || !opened) return false;
        if (!exploredChart && !getMomentState()) {
          const target = chooseTarget(requestedUtc!)!;
          requestedUtc = target.utc;
          if (target.chart) return publishReady(target.chart, target.utc);
        }
        notify();
        return !exploredChart || shownUtc() !== requestedUtc ? load() : true;
      }
      if (restoring || pendingRestore || retryTimer !== null) cancel();
      retryCount = 0; setBounds(start, end);
      const shown = Date.parse(fullChart?.utc!);
      const target = chooseTarget(mode === 'lifetime' ? requestedUtc! : Number.isFinite(shown) ? shown : minUtc!, Math.floor)!;
      selectionRound = Math.floor;
      requestedUtc = target.utc;
      mode = 'lifetime'; fromDate = from!; toDate = through!; openStart = nextOpenStart; openEnded = nextOpenEnded;
      const generation = sequence;
      onModeAccepted({ opened, mode });
      if (generation !== sequence || !opened) return false;
      if (target.chart && !getMomentState()) return publishReady(target.chart, target.utc);
      const needsPoint = active || !exploredChart || shownUtc() !== requestedUtc;
      status = needsPoint ? 'loading' : 'ready'; error = ''; errorCode = '';
      notify();
      return needsPoint ? load() : true;
    },
  };
}
