import type { ChartInput } from '../domain/chart-composition.ts';
import type { LocalDayTimeline } from '../domain/day-timeline.ts';
import type { TransitDay } from '../../shared/day-packets/transit-format.ts';
import type { TransitDayClient } from '../data/transit-day-client.ts';
import type { SavedView } from '../data/view-store.ts';
export interface LiveTransitState {
  wanted: boolean; live: boolean; timeline: LocalDayTimeline | null; index: number; referenceIndex: number | null;
  status: 'idle' | 'loading' | 'ready' | 'error'; error: string; errorCode?: string; retryCount: number;
  current: ChartInput | null; loading: boolean; unavailable: boolean;
}
export interface LiveTransitOptions {
  isVisible?: () => boolean;
  isSuspended?: () => boolean;
  onRender?: () => void;
  onStateChange?: (state: LiveTransitState) => void;
  dayClient?: Pick<TransitDayClient, 'getDay'> & Partial<Pick<TransitDayClient, 'retainDay'>>;
  now?: () => number;
  timeZone?: () => string;
}
export type LiveTransit = ReturnType<typeof createLiveTransit>;

import { createTransitDayClient } from '../data/transit-day-client.ts';
import { transitChartAt } from '../domain/transit-day.ts';
import { createLocalDayTimeline, localDateAt, timelineIndexAt, timelineMinute } from '../domain/day-timeline.ts';

// The current day is ephemeral. Cached minute samples never mutate the saved
// chart collection, and completion of a request never navigates between charts.
export function createLiveTransit({
  isVisible = () => true, isSuspended = () => false, onRender = () => {},
  onStateChange = () => {}, dayClient = createTransitDayClient(),
  now = () => Date.now(), timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
}: LiveTransitOptions) {
  let wanted = true, live = true, index = 0;
  let timeline: LocalDayTimeline | null = null, days: Map<string, TransitDay> | null = null, current: ReturnType<typeof transitChartAt> | null = null;
  let status: LiveTransitState['status'] = 'idle', error = '', errorCode = '', sequence = 0, failures = 0, nextRetry = 0;
  let activeLoad: { key: string | null; promise: Promise<boolean>; failedDates: Set<string> } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null, running = false, activated = false, loading = false, unavailable = false;
  const retained = new Map<string, () => void>();
  // Initial presentation can wait for its selected minute independently of the
  // complete slider range. These are pending observers, never retained results.
  const firstChartWaiters = new Set<(accepted: boolean) => void>();
  function finishFirstCharts(accepted: boolean) {
    for (const finish of [...firstChartWaiters]) finish(accepted);
  }

  const state = () => {
    const utc = now();
    // The reference follows the real clock even while the selected minute is
    // paused. Never paint yesterday's endpoint while a new day is unavailable.
    const referenceIndex = status === 'ready' && days && timeline && utc >= timeline.startUtc && utc < timeline.endUtc
      ? timelineIndexAt(timeline, utc) : null;
    return { wanted, live, timeline, index, referenceIndex, status, error, errorCode, retryCount: failures, current, loading, unavailable };
  };
  const notify = () => onStateChange(state());
  const visible = () => wanted && isVisible();
  const keyOf = (day: LocalDayTimeline | null) => day && `${day.date}@${day.timeZone}`;

  const isCurrentTimeline = () => timeline && timeline.timeZone === timeZone()
    && now() >= timeline.startUtc && now() < timeline.endUtc;
  const selectedMinute = () => timeline && timelineMinute(timeline, live ? timelineIndexAt(timeline!, now()) : index);
  function acceptedCurrent() {
    if (!visible() || !days || !isCurrentTimeline()) return false;
    const minute = selectedMinute();
    return days.has(minute!.date) && Date.parse(current?.utc!) === minute!.utc;
  }

  function retainActiveDays() {
    // Lifetime may need this day while live publication is disabled. Retention
    // follows ownership of the packet objects, not which tool is visible.
    const active = days;
    for (const [date, release] of retained) {
      if (!active || !days?.has(date)) { release(); retained.delete(date); }
    }
    if (active && dayClient.retainDay) {
      for (const [date, packet] of days || []) {
        if (!retained.has(date)) retained.set(date, dayClient.retainDay(packet));
      }
    }
  }

  function publish(nextIndex: number) {
    if (!visible() || !days || !isCurrentTimeline()) return;
    const minute = timelineMinute(timeline!, nextIndex);
    if (!days.has(minute.date)) return;
    index = minute.index;
    if (!current || Date.parse(current.utc!) !== minute.utc) {
      current = transitChartAt(days.get(minute.date)!,  minute.packetIndex);
      // Exact longitudes move even when gate and line stay the same.
      onRender();
    }
    notify();
    if (acceptedCurrent()) finishFirstCharts(true);
  }

  function waitForFirstChart(completion: Promise<unknown>) {
    return new Promise<boolean>(resolve => {
      const finish = (value: boolean) => { firstChartWaiters.delete(finish); resolve(Boolean(value)); };
      firstChartWaiters.add(finish);
      if (acceptedCurrent()) finish(true);
      else if (!visible() || activeLoad?.failedDates.has(selectedMinute()?.date!)) finish(false);
      completion.then(() => finish(acceptedCurrent()), () => finish(false));
    });
  }

  async function load(target: LocalDayTimeline): Promise<boolean> {
    const key = keyOf(target);
    if (activeLoad?.key === key) return activeLoad.promise;
    finishFirstCharts(false);
    const requestSequence = ++sequence, failedDates = new Set<string>();
    // Keep successful packets on retry, but never mix different local days.
    const sameDay = keyOf(timeline) === key;
    if (!sameDay) { failures = 0; nextRetry = 0; }
    days = sameDay ? days || new Map() : new Map();
    timeline = target;
    retainActiveDays();
    if (!sameDay || live) index = timelineIndexAt(target, now());
    status = 'loading'; error = ''; errorCode = '';
    loading = true;
    notify();
    const promise = (async () => {
      try {
        // Ask for the selected minute first. Its chart can appear before the
        // other end of the local day is ready, including a restored pause.
        const currentDate = timelineMinute(target, index).date;
        const dates = [currentDate, ...target.packetDates.filter(date => date !== currentDate)];
        const results = await Promise.allSettled(dates.map(async date => {
          try {
            const packet = days!.get(date) || await dayClient.getDay(date);
            if (requestSequence !== sequence) return;
            days!.set(date, packet);
            retainActiveDays();
            if (!visible() || !isCurrentTimeline()) finishFirstCharts(false);
            publish(live ? timelineIndexAt(target, now()) : index);
          } catch (failure) {
            failedDates.add(date);
            // A missing background edge cannot invalidate the accepted minute.
            // A failed selected packet must not wait for that edge to settle.
            if (requestSequence === sequence && date === timelineMinute(target,
              live ? timelineIndexAt(target, now()) : index).date) finishFirstCharts(false);
            throw failure;
          }
        }));
        if (requestSequence !== sequence) return false;
        if (!isCurrentTimeline()) { status = 'idle'; return false; }
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        timeline = target; status = 'ready'; error = ''; errorCode = '';
        failures = 0; nextRetry = 0;
        unavailable = false;
        return true;
      } catch (failure) {
        if (requestSequence !== sequence) return false;
        failures += 1;
        nextRetry = now() + Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4));
        status = 'error'; error = (failure as Error).message || 'Не удалось загрузить транзит дня.'; errorCode = (failure as {code?: string}).code || '';
        unavailable = true;
        return false;
      } finally {
        if (requestSequence === sequence) {
          activeLoad = null;
          loading = false;
          notify(); schedule();
        }
      }
    })();
    activeLoad = { key, promise, failedDates };
    return promise;
  }

  async function refresh(resume = false) {
    activated = true;
    if (resume) { finishFirstCharts(false); live = true; }
    if (!visible()) { finishFirstCharts(false); notify(); return; }
    const utc = now(), zone = timeZone();
    const date = localDateAt(utc, zone);
    const target = timeline?.date === date && timeline.timeZone === zone
      ? timeline : createLocalDayTimeline(utc, zone);
    const changedDay = timeline && keyOf(target) !== keyOf(timeline);
    if (changedDay) live = true;
    // A partial range must not stop the minute clock for a packet we do have.
    if (!changedDay && live && status !== 'ready') publish(timelineIndexAt(target, utc));
    if (!days || changedDay || status !== 'ready') {
      if (!resume && utc < nextRetry) { notify(); return; }
      if (!await load(target)) return;
    }
    if (!visible() || keyOf(target) !== keyOf(timeline)) return;
    publish(live ? timelineIndexAt(timeline!, now()) : index);
  }

  function schedule() {
    clearTimeout(timer!);
    if (!running || !wanted || isSuspended()) return;
    const utc = now(), retryDelay = visible() && nextRetry > utc ? nextRetry - utc : Infinity;
    timer = setTimeout(() => {
      refresh();
      schedule();
    }, Math.min(retryDelay, 60_000 - utc % 60_000 + 25));
  }

  function visibilityChanged() {
    if (!activated) return;
    if (isSuspended()) { clearTimeout(timer!); finishFirstCharts(false); }
    else { refresh(); schedule(); }
  }

  return {
    get current() { return current; },
    get state() { return state(); },
    refresh, visibilityChanged,
    setWanted(value: boolean) {
      if (wanted !== value) { failures = 0; nextRetry = 0; }
      wanted = value;
      if (!wanted) finishFirstCharts(false);
      retainActiveDays();
      notify();
      if (wanted && activated) refresh();
      schedule();
    },
    scrub(value: number) {
      if (!Number.isFinite(value) || !visible() || status !== 'ready') return;
      live = false;
      publish(value);
    },
    goNow() { return refresh(true); },
    start(saved: SavedView['transit'] = null, { firstChart = false } = {}) {
      if (saved?.live === false) {
        const target = createLocalDayTimeline(now(), timeZone());
        if (saved.date === target.date && saved.timeZone === target.timeZone && Number.isSafeInteger(saved.index) && saved.index >= 0) {
          if (keyOf(timeline) !== keyOf(target)) days = null;
          timeline = target; index = timelineMinute(target, saved.index).index; live = false;
        }
      }
      retainActiveDays();
      running = true; schedule();
      const completion = refresh();
      return firstChart ? waitForFirstChart(completion) : completion;
    },
    retry() { nextRetry = 0; return refresh(); },
    stop() {
      finishFirstCharts(false);
      sequence++; activeLoad = null; loading = false; status = 'idle'; failures = 0; nextRetry = 0;
      running = false; days = null; retainActiveDays(); clearTimeout(timer!); timer = null;
    },
  };
}
