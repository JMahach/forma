import { createNatalDayClient } from '../data/natal-day-client.js';
import { chartAtMinute, natalDayIndexAt } from '../domain/natal-day.js';
import { extractChartData, canExploreNatalDay } from '../domain/chart-data.js';
export { canExploreNatalDay } from '../domain/chart-data.js';

// The saved chart is the source of truth. A selected minute is a temporary view
// and does not navigate, persist, clear graph selections or move the camera.
export function createNatalDayExplorer({
  dayClient = createNatalDayClient(), onStateChange = () => {}, onRender = () => {},
} = {}) {
  let original = null, baseChart = null, current = null, day = null, index = 0, referenceIndex = null;
  let releaseDay = null;
  let opened = false, status = 'idle', error = '', exactOriginal = true, sequence = 0, active = null;
  const state = () => ({ original, current, day, index, referenceIndex, opened, status, error, exactOriginal, available: canExploreNatalDay(original) });
  const notify = () => onStateChange(state());
  const cancel = () => { sequence += 1; active?.controller.abort(); active = null; };

  const discardDay = () => { releaseDay?.(); releaseDay = null; day = null; index = 0; referenceIndex = null; };

  async function load() {
    if (!opened || !canExploreNatalDay(original)) return false;
    if (active) return active.promise;
    const requestSequence = ++sequence, chart = original, controller = new AbortController();
    status = 'loading'; error = ''; notify();
    const promise = (async () => {
      try {
        const result = await dayClient.getDay(chart, { signal: controller.signal });
        if (requestSequence !== sequence || !opened) return false;
        const release = dayClient.retainDay?.(result);
        releaseDay?.(); releaseDay = release;
        day = result; referenceIndex = natalDayIndexAt(day, chart.utc); index = referenceIndex; status = 'ready';
        return true;
      } catch (failure) {
        if (requestSequence !== sequence || controller.signal.aborted) return false;
        status = 'error'; error = failure.message || 'Не удалось загрузить день рождения.';
        return false;
      } finally {
        if (requestSequence === sequence) { active = null; notify(); }
      }
    })();
    active = { controller, promise };
    return promise;
  }

  function reset() {
    if (!original) return;
    const changed = current !== baseChart;
    current = baseChart; exactOriginal = true;
    if (day) index = referenceIndex;
    notify();
    if (changed) onRender();
  }

  function close() {
    if (!opened) return;
    cancel(); discardDay(); opened = false; status = 'idle'; error = '';
    reset();
  }

  return {
    get current() { return opened ? current : null; },
    get state() { return state(); },
    select(record, chart = record ? extractChartData(record) : null) {
      if (record === original) return;
      cancel(); discardDay(); original = record; baseChart = current = chart;
      opened = false; status = 'idle'; error = ''; exactOriginal = true; notify();
    },
    updateMetadata(record) {
      original = record;
      notify();
    },
    async open() {
      if (!canExploreNatalDay(original)) return false;
      opened = true; notify();
      return day ? true : load();
    },
    close,
    retry: load,
    reset,
    scrub(value) {
      if (!opened || status !== 'ready' || !day || !Number.isFinite(value)) return;
      const nextIndex = Math.min(day.samples - 1, Math.max(0, Math.trunc(value)));
      if (!exactOriginal && index === nextIndex) return;
      index = nextIndex; current = chartAtMinute(day, index); exactOriginal = false;
      notify(); onRender();
    },
  };
}
