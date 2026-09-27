import { createTransitDayClient } from '../data/transit-day-client.js';
import { transitChartAt } from '../domain/transit-day.js';
import { createLocalDayTimeline, localDateAt, timelineIndexAt, timelineMinute } from '../domain/day-timeline.js';

// The current day is ephemeral. Cached minute samples never mutate the saved
// chart collection, and completion of a request never navigates between charts.
export function createLiveTransit({
  isVisible = () => true, isSuspended = () => false, onMoment = () => {}, onRender = () => {}, toast = () => {},
  onStateChange = () => {}, dayClient = createTransitDayClient(),
  now = () => Date.now(), timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
}) {
  let wanted = true, live = true, timeline = null, days = null, current = null, index = 0;
  let status = 'idle', error = '', activeLoad = null, sequence = 0, failures = 0, nextRetry = 0;
  let timer = null, running = false, loading = false, unavailable = false;

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

  function publish(nextIndex) {
    if (!visible() || !days || status !== 'ready') return;
    const minute = timelineMinute(timeline, nextIndex);
    index = minute.index;
    const next = transitChartAt(days.get(minute.date), minute.packetIndex);
    const previous = current;
    if (!previous || previous.utc !== next.utc) {
      current = next;
      onMoment(next, previous);
      // Exact longitudes move even when gate and line stay the same.
      onRender();
    }
    notify();
  }

  async function load(target, force) {
    const key = keyOf(target);
    if (activeLoad?.key === key) return activeLoad.promise;
    const requestSequence = ++sequence;
    timeline = target;
    index = timelineIndexAt(target, now());
    status = 'loading'; error = '';
    loading = true;
    notify();
    const promise = (async () => {
      try {
        const entries = await Promise.all(target.packetDates.map(async date => [date, await dayClient.getDay(date)]));
        if (requestSequence !== sequence) return false;
        const recovered = failures > 0;
        timeline = target; days = new Map(entries); status = 'ready'; error = '';
        failures = 0; nextRetry = 0;
        unavailable = false;
        if (recovered && visible()) toast('Транзит дня загружен');
        return true;
      } catch (failure) {
        if (requestSequence !== sequence) return false;
        failures += 1;
        nextRetry = now() + Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4));
        status = 'error'; error = failure.message || 'Не удалось загрузить транзит дня.';
        unavailable = true;
        if (visible() && (failures === 1 || force)) toast(error);
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
    if (resume) live = true;
    if (!visible()) { notify(); return; }
    const utc = now(), zone = timeZone();
    const date = localDateAt(utc, zone);
    const target = timeline?.date === date && timeline.timeZone === zone
      ? timeline : createLocalDayTimeline(utc, zone);
    const changedDay = timeline && keyOf(target) !== keyOf(timeline);
    if (changedDay) live = true;
    if (!days || changedDay || status !== 'ready') {
      if (!resume && utc < nextRetry) { notify(); return; }
      if (!await load(target, resume)) return;
    }
    if (!visible()) return;
    publish(live ? timelineIndexAt(timeline, now()) : index);
  }

  function schedule() {
    clearTimeout(timer);
    if (!running || isSuspended()) return;
    timer = setTimeout(async () => {
      await refresh();
      schedule();
    }, 60_000 - now() % 60_000 + 25);
  }

  function visibilityChanged() {
    if (isSuspended()) clearTimeout(timer);
    else { refresh(); schedule(); }
  }

  return {
    get current() { return current; },
    get state() { return state(); },
    refresh, visibilityChanged,
    setWanted(value) {
      wanted = value;
      notify();
      if (wanted) refresh();
    },
    scrub(value) {
      if (!Number.isFinite(value) || !visible() || status !== 'ready') return;
      live = false;
      publish(value);
    },
    goNow() { return refresh(true); },
    start() { running = true; schedule(); return refresh(true); },
    stop() { running = false; clearTimeout(timer); timer = null; },
  };
}
