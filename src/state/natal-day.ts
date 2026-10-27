import type { ChartRecord } from '../../shared/chart-types.ts';
import type { ChartInput } from '../domain/chart-composition.ts';
import type { NatalDay } from '../../shared/day-packets/natal-format.ts';
import type { NatalDayClient } from '../data/natal-day-client.ts';
import { getConnectionMode, type ConnectionMode } from '../data/http-transport.ts';
export interface NatalExplorerState {
  original: ChartRecord | null; current: ChartInput | null; day: NatalDay | null;
  index: number; referenceIndex: number | null; opened: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error'; error: string; exactOriginal: boolean; available: boolean; canOpen: boolean;
}
export interface NatalExplorerOptions {
  dayClient?: Pick<NatalDayClient, 'getDay'> & Partial<Pick<NatalDayClient, 'retainDay' | 'readDay' | 'peekDay'>>;
  connection?: () => ConnectionMode;
  onStateChange?: (state: NatalExplorerState) => void;
  onRender?: () => void;
}
export type NatalDayExplorer = ReturnType<typeof createNatalDayExplorer>;

import { createNatalDayClient } from '../data/natal-day-client.ts';
import { chartAtMinute, natalDayIndexAt, originalNatalDayMoment } from '../domain/natal-day.ts';
import { extractChartData, canExploreNatalDay, withoutChartCalculation } from '../domain/chart-data.ts';
export { canExploreNatalDay } from '../domain/chart-data.ts';

// The saved chart is the source of truth. A selected minute is a temporary view
// and does not navigate, persist, clear graph selections or move the camera.
export function createNatalDayExplorer({
  dayClient = createNatalDayClient(), connection = getConnectionMode, onStateChange = () => {}, onRender = () => {},
}: NatalExplorerOptions = {}) {
  let original: ChartRecord | null = null, baseChart: ChartInput | null = null, current: ChartInput | null = null;
  let day: NatalDay | null = null, index = 0, referenceIndex: number | null = null;
  let releaseDay: (() => void) | null = null;
  let opened = false, status: NatalExplorerState['status'] = 'idle', error = '', exactOriginal = true, sequence = 0;
  let active: { controller: AbortController; promise: Promise<boolean> } | null = null;
  let readyOnDevice = false, availabilitySequence = 0, compatible = true;
  const canOpen = () => compatible && canExploreNatalDay(original) && (connection() !== 'offline' || Boolean(day) || readyOnDevice);
  const state = () => ({ original, current: compatible || !current ? current : withoutChartCalculation(current), day: compatible ? day : null, index, referenceIndex, opened,
    status: compatible ? status : 'idle' as const, error, exactOriginal, available: canExploreNatalDay(original), canOpen: canOpen() });
  const notify = () => onStateChange(state());
  const cancel = () => { sequence += 1; active?.controller.abort(); active = null; };

  const discardDay = () => { releaseDay?.(); releaseDay = null; day = null; index = 0; referenceIndex = null; };

  async function refreshAvailability() {
    const version = ++availabilitySequence, chart = original;
    readyOnDevice = Boolean(day || dayClient.peekDay?.(chart));
    notify();
    if (!compatible || connection() !== 'offline' || readyOnDevice || !canExploreNatalDay(chart) || !dayClient.readDay) return;
    let ready = false;
    try { ready = Boolean(await dayClient.readDay(chart)); } catch { /* Optional device lookup. */ }
    if (version !== availabilitySequence || chart !== original) return;
    readyOnDevice = ready; notify();
  }

  async function load() {
    if (!compatible || !opened || !canExploreNatalDay(original)) return false;
    if (active) return active.promise;
    const requestSequence = ++sequence, chart = original!, controller = new AbortController();
    status = 'loading'; error = ''; notify();
    const promise = (async () => {
      try {
        const result = await dayClient.getDay(chart, { signal: controller.signal });
        if (requestSequence !== sequence || !opened) return false;
        const release = dayClient.retainDay?.(result);
        releaseDay?.(); releaseDay = release ?? null;
        day = result; referenceIndex = natalDayIndexAt(day, chart.utc!); index = referenceIndex; status = 'ready';
        return true;
      } catch (failure) {
        if (requestSequence !== sequence || controller.signal.aborted) return false;
        status = 'error'; error = (failure as Error).message || 'Не удалось загрузить день рождения.';
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
    current = baseChart;
    ({ index, exactOriginal } = originalNatalDayMoment(referenceIndex));
    notify();
    if (changed) onRender();
  }

  function close() {
    if (!opened) return;
    cancel(); discardDay(); opened = false; status = 'idle'; error = '';
    reset(); void refreshAvailability();
  }

  return {
    get current() { return compatible && opened ? current : null; },
    get state() { return state(); },
    select(record: ChartRecord | null, chart: ChartInput | null = record ? extractChartData(record) : null) {
      if (record === original) return;
      cancel(); discardDay(); original = record; baseChart = current = chart;
      readyOnDevice = false;
      opened = false; status = 'idle'; error = ''; exactOriginal = true; void refreshAvailability();
    },
    updateMetadata(record: ChartRecord) {
      original = record;
      notify();
    },
    async open() {
      if (!canExploreNatalDay(original)) return false;
      opened = true; notify();
      return day ? true : load();
    },
    close,
    refreshAvailability,
    invalidateCalculations() { compatible = false; availabilitySequence++; cancel(); notify(); },
    retry: load,
    reset,
    scrub(value: number) {
      if (!compatible || !opened || status !== 'ready' || !day || !Number.isFinite(value)) return;
      const nextIndex = Math.min(day.samples - 1, Math.max(0, Math.trunc(value)));
      if (!exactOriginal && index === nextIndex) return;
      index = nextIndex; current = chartAtMinute(day, index); exactOriginal = false;
      notify(); onRender();
    },
  };
}
