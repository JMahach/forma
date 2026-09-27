import { createChartDayClient } from '../data/natal-day-client.js';
import { chartAtMinute, chartDayMinute, chartDayIndexAt } from '../domain/natal-day.js';

export const canExploreChartDay = chart => Boolean(chart?.source === 'calculated'
  && chart.id !== 'current-transit' && /^\d{4}-\d{2}-\d{2}$/.test(chart.birthDate || '')
  && String(chart.cityId ?? chart.city?.id ?? '').length > 0 && Number.isFinite(Date.parse(chart.utc)));

// The saved chart is the source of truth. A selected minute is a temporary view
// and does not navigate, persist, clear graph selections or move the camera.
export function createChartDayExplorer({
  dayClient = createChartDayClient(), onStateChange = () => {}, onRender = () => {},
} = {}) {
  let original = null, current = null, day = null, index = 0;
  let opened = false, status = 'idle', error = '', exactOriginal = true, sequence = 0, active = null;
  const state = () => ({ original, current, day, index, opened, status, error, exactOriginal, available: canExploreChartDay(original) });
  const notify = () => onStateChange(state());
  const cancel = () => { sequence += 1; active?.controller.abort(); active = null; };

  async function load() {
    if (!opened || !canExploreChartDay(original)) return false;
    if (active) return active.promise;
    const requestSequence = ++sequence, chart = original, controller = new AbortController();
    status = 'loading'; error = ''; notify();
    const promise = (async () => {
      try {
        const result = await dayClient.getDay(chart, { signal: controller.signal });
        if (requestSequence !== sequence || !opened || chart !== original) return false;
        day = result; index = chartDayIndexAt(day, chart.utc); status = 'ready';
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
    const changed = current !== original;
    current = original; exactOriginal = true;
    if (day) index = chartDayIndexAt(day, original.utc);
    notify();
    if (changed) onRender();
  }

  function close() {
    if (!opened) return;
    cancel(); opened = false; status = day ? 'ready' : 'idle'; error = '';
    reset();
  }

  return {
    get current() { return opened ? current : null; },
    get state() { return state(); },
    select(chart) {
      if (chart === original) return;
      cancel(); original = chart; current = chart; day = null; index = 0;
      opened = false; status = 'idle'; error = ''; exactOriginal = true; notify();
    },
    async open() {
      if (!canExploreChartDay(original)) return false;
      opened = true; notify();
      return day ? true : load();
    },
    close,
    toggle() { if (opened) close(); else return this.open(); },
    retry: load,
    reset,
    scrub(value) {
      if (!opened || status !== 'ready' || !day || !Number.isFinite(value)) return;
      const minute = chartDayMinute(day, Math.min(day.samples - 1, Math.max(0, Math.trunc(value))));
      if (!exactOriginal && index === minute.index) return;
      index = minute.index; current = chartAtMinute(day, index, original); exactOriginal = false;
      notify(); onRender();
    },
  };
}
