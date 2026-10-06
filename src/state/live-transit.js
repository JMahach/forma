import { createTransitDayClient } from '../data/transit-day-client.js';
import { transitChartAt } from '../domain/transit-day.js';
import { createLocalDayTimeline, localDateAt, timelineIndexAt, timelineMinute } from '../domain/day-timeline.js';

// The current day is ephemeral. Cached minute samples never mutate the saved
// chart collection, and completion of a request never navigates between charts.
export function createLiveTransit({
  isVisible = () => true, isSuspended = () => false, onRender = () => {},
  onStateChange = () => {}, dayClient = createTransitDayClient(),
  now = () => Date.now(), timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
}) {
  let wanted = true, live = true, timeline = null, days = null, current = null, index = 0;
  let status = 'idle', error = '', activeLoad = null, sequence = 0, failures = 0, nextRetry = 0;
  let timer = null, running = false, activated = false, loading = false, unavailable = false;
  const retained = new Map();

  const state = () => {
    const utc = now();
    // The reference follows the real clock even while the selected minute is
    // paused. Never paint yesterday's endpoint while a new day is unavailable.
    const referenceIndex = status === 'ready' && days && timeline && utc >= timeline.startUtc && utc < timeline.endUtc
      ? timelineIndexAt(timeline, utc) : null;
    return { wanted, live, timeline, index, referenceIndex, status, error, current, loading, unavailable };
  };
  const notify = () => onStateChange(state());
  const visible = () => wanted && isVisible();
  const keyOf = day => day && `${day.date}@${day.timeZone}`;

  const isCurrentTimeline = () => timeline && timeline.timeZone === timeZone()
    && now() >= timeline.startUtc && now() < timeline.endUtc;

  function retainActiveDays() {
    // Years may need this day while live publication is disabled. Retention
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

  function publish(nextIndex) {
    if (!visible() || !days || !isCurrentTimeline()) return;
    const minute = timelineMinute(timeline, nextIndex);
    if (!days.has(minute.date)) return;
    index = minute.index;
    if (!current || Date.parse(current.utc) !== minute.utc) {
      current = transitChartAt(days.get(minute.date), minute.packetIndex);
      // Exact longitudes move even when gate and line stay the same.
      onRender();
    }
    notify();
  }

  async function load(target) {
    const key = keyOf(target);
    if (activeLoad?.key === key) return activeLoad.promise;
    const requestSequence = ++sequence;
    // Keep successful packets on retry, but never mix different local days.
    const sameDay = keyOf(timeline) === key;
    days = sameDay ? days || new Map() : new Map();
    timeline = target;
    retainActiveDays();
    if (!sameDay || live) index = timelineIndexAt(target, now());
    status = 'loading'; error = '';
    loading = true;
    notify();
    const promise = (async () => {
      try {
        // Ask for the selected minute first. Its chart can appear before the
        // other end of the local day is ready, including a restored pause.
        const currentDate = timelineMinute(target, index).date;
        const dates = [currentDate, ...target.packetDates.filter(date => date !== currentDate)];
        const results = await Promise.allSettled(dates.map(async date => {
          const packet = days.get(date) || await dayClient.getDay(date);
          if (requestSequence !== sequence) return;
          days.set(date, packet);
          retainActiveDays();
          publish(live ? timelineIndexAt(target, now()) : index);
        }));
        if (requestSequence !== sequence) return false;
        if (!isCurrentTimeline()) { status = 'idle'; return false; }
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        timeline = target; status = 'ready'; error = '';
        failures = 0; nextRetry = 0;
        unavailable = false;
        return true;
      } catch (failure) {
        if (requestSequence !== sequence) return false;
        failures += 1;
        nextRetry = now() + Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4));
        status = 'error'; error = failure.message || 'Не удалось загрузить транзит дня.';
        unavailable = true;
        return false;
      } finally {
        if (requestSequence === sequence) {
          activeLoad = null;
          loading = false;
          notify();
        }
      }
    })();
    activeLoad = { key, promise };
    return promise;
  }

  async function refresh(resume = false) {
    activated = true;
    if (resume) live = true;
    if (!visible()) { notify(); return; }
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
    publish(live ? timelineIndexAt(timeline, now()) : index);
  }

  function schedule() {
    clearTimeout(timer);
    if (!running || isSuspended()) return;
    timer = setTimeout(() => {
      refresh();
      schedule();
    }, 60_000 - now() % 60_000 + 25);
  }

  function visibilityChanged() {
    if (!activated) return;
    if (isSuspended()) clearTimeout(timer);
    else { refresh(); schedule(); }
  }

  return {
    get current() { return current; },
    get state() { return state(); },
    refresh, visibilityChanged,
    setWanted(value) {
      wanted = value;
      retainActiveDays();
      notify();
      if (wanted && activated) refresh();
    },
    scrub(value) {
      if (!Number.isFinite(value) || !visible() || status !== 'ready') return;
      live = false;
      publish(value);
    },
    goNow() { return refresh(true); },
    start(saved = null) {
      if (saved?.live === false) {
        const target = createLocalDayTimeline(now(), timeZone());
        if (saved.date === target.date && saved.timeZone === target.timeZone && Number.isSafeInteger(saved.index) && saved.index >= 0) {
          if (keyOf(timeline) !== keyOf(target)) days = null;
          timeline = target; index = timelineMinute(target, saved.index).index; live = false;
        }
      }
      retainActiveDays();
      running = true; schedule(); return refresh();
    },
    retry() { nextRetry = 0; return refresh(); },
    stop() {
      sequence++; activeLoad = null; loading = false; status = 'idle';
      running = false; days = null; retainActiveDays(); clearTimeout(timer); timer = null;
    },
  };
}
