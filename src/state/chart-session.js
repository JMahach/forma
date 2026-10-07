import { createChartComposition } from '../domain/chart-composition.js';

const emptyMoment = Object.freeze({ id: 'current-transit', name: 'Транзит', source: 'transit', personality: [], design: [], utc: '' });
const owners = new Set(['original', 'natal-day', 'transit', 'lifetime', 'return']);

// The accepted result is a value, not a priority search through tool state.
// A request can outlive its data job; only its owner may publish to this view.
export function createChartSession({ store, getTransit = () => null, getNatalDay = () => null,
  getLifetime = () => null, getReturns = () => null, filterTransit = chart => chart,
  onSelect = () => {}, onChange = () => {} }) {
  let selectedId = 'current-transit', selecting = false, owner = 'transit';
  let original = store.get(selectedId) || emptyMoment;
  let accepted = createChartComposition(original), hasCurrent = store.has(selectedId);
  let acceptedSource = original, acceptedKind = 'original';
  function refresh() { if (!selecting) onChange(); }
  function expect(kind) {
    if (!owners.has(kind)) throw new TypeError(`Unknown chart owner: ${kind}`);
    owner = kind; return owner;
  }
  function accept(kind, chart, event = null) {
    if (!chart) return false;
    const filtered = kind === 'transit' ? filterTransit(chart) : chart;
    const overlay = kind === 'return' || (kind === 'transit' || kind === 'lifetime') && selectedId !== 'current-transit' && original.source !== 'transit';
    const primary = overlay ? original : filtered, secondary = overlay ? filtered : null;
    const compositionKind = overlay ? kind === 'return' ? 'return' : 'transit' : 'single';
    acceptedSource = chart; acceptedKind = kind; hasCurrent = chart !== emptyMoment;
    if (accepted.primary === primary && accepted.secondary === secondary && accepted.kind === compositionKind && accepted.event === event) return true;
    accepted = createChartComposition(primary, { secondary, kind: compositionKind, event });
    refresh(); return true;
  }
  function publish(source, chart, event = null) {
    if (selecting || source !== owner) return false;
    return accept(owner, chart, event);
  }
  function showOriginal(kind = 'original') {
    expect(kind);
    return accept('original', original);
  }
  return {
    get selectedId() { return selectedId; },
    get original() { return original; },
    get current() { return accepted; },
    get shownSource() { return acceptedKind; },
    get hasCurrent() { return hasCurrent; },
    get owner() { return owner; },
    expect, publish, showOriginal, refresh,
    refilter() { return accept(acceptedKind, acceptedKind === 'lifetime' ? filterTransit(acceptedSource) : acceptedSource, accepted.event); },
    refreshOriginal() {
      const next = store.get(selectedId);
      if (!next) return false;
      selecting = true;
      try {
        original = next;
        getReturns()?.select(original);
        getNatalDay()?.updateMetadata(original);
        const source = acceptedKind === 'original' ? original
          : acceptedKind === 'natal-day' ? getNatalDay().state.current : acceptedSource;
        accept(acceptedKind, source, accepted.event);
      } finally { selecting = false; }
      refresh(); return true;
    },
    select(id) {
      selecting = true;
      try {
        selectedId = id; original = store.get(id) || emptyMoment;
        expect(id === 'current-transit' ? 'transit' : 'natal-day');
        getReturns()?.exit(); getReturns()?.select(original);
        getLifetime()?.close();
        getNatalDay()?.close(); getNatalDay()?.select(original);
        accept('original', original);
        onSelect(original);
        getTransit()?.setWanted(id === 'current-transit');
        if (id === 'current-transit' && getTransit()?.current) accept('transit', getTransit().current);
      } finally { selecting = false; }
      refresh();
    },
  };
}
