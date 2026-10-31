import type { ChartRecord } from '../../shared/chart-types.ts';
import type { ChartInput } from '../domain/chart-composition.ts';
import type { NatalDay } from '../../shared/day-packets/natal-format.ts';
import type { NatalDayClient } from '../data/natal-day-client.ts';
import {natalDaySourceKey,type PackageRef} from '../../shared/library-package-contract.ts';
import { getConnectionMode, type ConnectionMode } from '../data/http-transport.ts';
export interface NatalExplorerState {
  original: ChartRecord | null; current: ChartInput | null; day: NatalDay | null;
  index: number; referenceIndex: number | null; opened: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error'; error: string; exactOriginal: boolean; available: boolean; canOpen: boolean;
}
export interface NatalExplorerOptions {
  dayClient?: Pick<NatalDayClient, 'getDay'> & Partial<Pick<NatalDayClient, 'retainDay' | 'readLocalDay' | 'peekDay' | 'readStoredDay'>>;
  connection?: () => ConnectionMode;
  onStateChange?: (state: NatalExplorerState) => void;
  onRender?: () => void;
}
export type NatalDayExplorer = ReturnType<typeof createNatalDayExplorer>;

import { createNatalDayClient } from '../data/natal-day-client.ts';
import { chartAtMinute, natalDayIndexAt, originalNatalDayMoment } from '../domain/natal-day.ts';
import { extractChartData, canExploreNatalDay } from '../domain/chart-data.ts';
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
  let readyOnDevice = false, availabilitySequence = 0;
  let storedProbe:AbortController|null=null;
  const canOpen = () => canExploreNatalDay(original) && (connection() !== 'offline' || Boolean(day) || readyOnDevice);
  const state = () => ({ original, current, day, index, referenceIndex, opened,
    status, error, exactOriginal, available: canExploreNatalDay(original), canOpen: canOpen() });
  const notify = () => onStateChange(state());
  const cancel = () => { sequence += 1; active?.controller.abort(); active = null;
    availabilitySequence++;storedProbe?.abort();storedProbe=null; };

  const discardDay = () => { releaseDay?.(); releaseDay = null; day = null; index = 0; referenceIndex = null; };

  const owned=(chart:ChartRecord|null)=>!!chart && 'accountId' in chart && typeof chart.accountId==='string';
  async function refreshAvailability() {
    storedProbe?.abort();storedProbe=null;
    const version = ++availabilitySequence, chart = original;
    readyOnDevice = Boolean(day || !owned(chart) && dayClient.peekDay?.(chart));
    notify();
    if (connection() !== 'offline' || readyOnDevice || !canExploreNatalDay(chart)) return;
    let ready = false;
    // Offline selection may migrate an old complete day before enabling Open.
    // Package notices below only observe: no migration or use mark.
    try {
      ready = Boolean(await (owned(chart)
        ? dayClient.readStoredDay?.(chart,{observeOnly:false})
        : dayClient.readLocalDay?.(chart)));
    } catch { /* Optional device lookup. */ }
    if (version !== availabilitySequence || chart !== original) return;
    readyOnDevice = ready; notify();
  }
  function acceptDay(result:NatalDay,chart:ChartRecord) {
    const release=dayClient.retainDay?.(result);releaseDay?.();releaseDay=release??null;
    day=result;referenceIndex=natalDayIndexAt(day,chart.utc!);index=referenceIndex;status='ready';error='';
  }
  async function refreshStoredPackage(ref:Exclude<PackageRef,{kind:'card'}>):Promise<void> {
    const chart=original;
    if(ref.kind!=='day' || !owned(chart) || !canExploreNatalDay(chart)
      || ref.sourceKey!==natalDaySourceKey({date:chart!.birthDate,timezone:chart!.timezone||'UTC'}))return;
    storedProbe?.abort();const probe=new AbortController(),version=++availabilitySequence;storedProbe=probe;
    let result:NatalDay|null|undefined;
    try{result=await dayClient.readStoredDay?.(chart,{signal:probe.signal,observeOnly:true});}catch{return;}
    finally{if(storedProbe===probe)storedProbe=null;}
    if(version!==availabilitySequence || chart!==original)return;
    const wasOpenable=canOpen(),prepared=!!result && !day;readyOnDevice=!!result;
    if(prepared){sequence++;active?.controller.abort();active=null;acceptDay(result!,chart!);}
    if(prepared || wasOpenable!==canOpen())notify();
  }

  async function load() {
    if (!opened || !canExploreNatalDay(original)) return false;
    if (active) return active.promise;
    const requestSequence = ++sequence, chart = original!, controller = new AbortController();
    status = 'loading'; error = ''; notify();
    const promise = (async () => {
      try {
        const result = connection()==='offline' && owned(chart)
          ?await dayClient.readStoredDay?.(chart,{signal:controller.signal,opened:true})
          :await dayClient.getDay(chart,{signal:controller.signal});
        if (requestSequence !== sequence || !opened) return false;
        if(!result){readyOnDevice=false;opened=false;status='idle';return false;}
        acceptDay(result,chart);
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
    get current() { return opened ? current : null; },
    get pending() { return status==='loading'; },
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
    refreshStoredPackage,

    retry: load,
    reset,
    scrub(value: number) {
      if (!opened || status !== 'ready' || !day || !Number.isFinite(value)) return;
      const nextIndex = Math.min(day.samples - 1, Math.max(0, Math.trunc(value)));
      if (!exactOriginal && index === nextIndex) return;
      index = nextIndex; current = chartAtMinute(day, index); exactOriginal = false;
      notify(); onRender();
    },
  };
}
