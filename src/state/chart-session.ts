import type { SavedChart } from '../../shared/chart-types.ts';
import type { ChartInput, CompositionEvent } from '../domain/chart-composition.ts';
import type { ChartStore } from '../data/chart-store.ts';
import type { LiveTransit } from './live-transit.ts';
import type { NatalDayExplorer } from './natal-day.ts';
import type { LifetimeExplorer } from './lifetime.ts';
import type { ReturnsController } from './returns.ts';
export type ChartOwner = 'original' | 'natal-day' | 'transit' | 'lifetime' | 'return';
export type ChartSession = ReturnType<typeof createChartSession>;
interface ChartSessionOptions {
  store: Pick<ChartStore, 'has'> & { get(id: string): SavedChart | null | undefined };
  initialSelectedId?: string;
  getTransit?: () => Pick<LiveTransit, 'current' | 'setWanted'> | null;
  getNatalDay?: () => (Pick<NatalDayExplorer, 'select' | 'close' | 'updateMetadata'> & { state: Pick<NatalDayExplorer['state'], 'current'> }) | null;
  getLifetime?: () => Pick<LifetimeExplorer, 'close'> | null;
  getReturns?: () => Pick<ReturnsController, 'select' | 'exit'> | null;
  filterTransit?: (chart: ChartInput) => ChartInput;
  resetTransitFilter?: () => void;
  onSelect?: (record: SavedChart | null) => void;
  onChange?: () => void;
}

import { createChartComposition } from '../domain/chart-composition.ts';
import { extractChartData } from '../domain/chart-data.ts';

const emptyMoment: ChartInput = Object.freeze({ source: 'transit', personality: [], design: [], utc: '' });
const owners = new Set(['original', 'natal-day', 'transit', 'lifetime', 'return']);

export const resolveSelectedChartId = (store: Pick<ChartStore, 'has'>, id: unknown) => id === 'current-transit' || typeof id === 'string' && store.has(id) ? id : 'current-transit';

// The accepted result is a value, not a priority search through tool state.
// A request can outlive its data job; only its owner may publish to this view.
export function createChartSession({ store, initialSelectedId = 'current-transit', getTransit = () => null, getNatalDay = () => null,
  getLifetime = () => null, getReturns = () => null, filterTransit = chart => chart,
  resetTransitFilter = () => {}, onSelect = () => {}, onChange = () => {} }: ChartSessionOptions) {
  let selectedId = resolveSelectedChartId(store, initialSelectedId), selecting = false;
  let owner: ChartOwner = selectedId === 'current-transit' ? 'transit' : 'original';
  let record = store.get(selectedId) || null;
  let baseChart = record ? extractChartData(record) : emptyMoment;
  let accepted = createChartComposition(baseChart, { id: selectedId, primaryLabel: record?.name || 'Транзит' }), hasCurrent = store.has(selectedId);
  let acceptedSource = baseChart, acceptedKind: ChartOwner = 'original';
  function refresh() { if (!selecting) onChange(); }
  function expect(kind: ChartOwner) {
    if (!owners.has(kind)) throw new TypeError(`Unknown chart owner: ${kind}`);
    owner = kind; return owner;
  }
  function accept(kind: ChartOwner, chart: ChartInput | null | undefined, event: CompositionEvent | null = null) {
    if (!chart) return false;
    const filtered = kind === 'transit' ? filterTransit(chart) : chart;
    const overlay = kind === 'return' || (kind === 'transit' || kind === 'lifetime') && selectedId !== 'current-transit' && record?.source !== 'transit';
    const primary = overlay ? baseChart : filtered, secondary = overlay ? filtered : null;
    const compositionKind = overlay ? kind === 'return' ? 'return' : 'transit' : 'single';
    const id = overlay ? kind === 'return' ? `${selectedId}:cycle:${event!.id}` : `${selectedId}:transit-preview`
      : selectedId;
    const primaryLabel = record?.source !== 'transit' && record?.name || 'Транзит';
    const sourceChanged = acceptedKind !== kind;
    acceptedSource = chart; acceptedKind = kind; hasCurrent = chart !== emptyMoment;
    if (accepted.primary === primary && accepted.secondary === secondary && accepted.kind === compositionKind && accepted.event === event
      && accepted.id === id && accepted.primaryLabel === primaryLabel) {
      if (sourceChanged) refresh();
      return true;
    }
    accepted = createChartComposition(primary, { secondary, kind: compositionKind, event, id, primaryLabel });
    refresh(); return true;
  }
  function publish(source: ChartOwner, chart: ChartInput | null | undefined, event: CompositionEvent | null = null) {
    if (selecting || source !== owner) return false;
    return accept(owner, chart, event);
  }
  function showOriginal(kind: ChartOwner = 'original') {
    expect(kind);
    return accept('original', baseChart);
  }
  return {
    get selectedId() { return selectedId; },
    get record() { return record; },
    get baseChart() { return baseChart; },
    get current() { return accepted; },
    get shownSource() { return acceptedKind; },
    get hasCurrent() { return hasCurrent; },
    get owner() { return owner; },
    expect, publish, showOriginal, refresh,
    refilter() { return accept(acceptedKind, acceptedKind === 'lifetime' ? filterTransit(acceptedSource) : acceptedSource, accepted.event); },
    refreshRecord() {
      const next = store.get(selectedId);
      if (!next) return false;
      selecting = true;
      try {
        record = next;
        getReturns()?.select(record);
        getNatalDay()?.updateMetadata(record);
        const source = acceptedKind === 'original' ? baseChart
          : acceptedKind === 'natal-day' ? getNatalDay()!.state.current : acceptedSource;
        accept(acceptedKind, source, accepted.event);
      } finally { selecting = false; }
      refresh(); return true;
    },
    select(id: string) {
      selecting = true;
      try {
        if (selectedId === 'current-transit' && id !== 'current-transit') resetTransitFilter();
        const nextRecord = store.get(id) || null;
        if (nextRecord !== record) baseChart = nextRecord ? extractChartData(nextRecord) : emptyMoment;
        selectedId = id; record = nextRecord;
        expect(id === 'current-transit' ? 'transit' : 'natal-day');
        getReturns()?.exit(); getReturns()?.select(record);
        getLifetime()?.close();
        getNatalDay()?.close(); getNatalDay()?.select(record, baseChart);
        accept('original', baseChart);
        onSelect(record);
        getTransit()?.setWanted(id === 'current-transit');
        if (id === 'current-transit' && getTransit()?.current) accept('transit', getTransit()!.current);
      } finally { selecting = false; }
      refresh();
    },
  };
}
