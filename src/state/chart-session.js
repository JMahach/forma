const emptyMoment = Object.freeze({ id: 'current-transit', name: 'Транзит', source: 'transit', personality: [], design: [], utc: '' });

// Navigation has one owner. The saved collection and temporary views keep
// their own state; this session resolves the visible chart without copying it.
export function createChartSession({ store, getTransit = () => null, getNatalDay = () => null, getLifetime = () => null,
  filterTransit = chart => chart, onChange = () => {} }) {
  let selectedId = 'current-transit', selecting = false;
  const original = () => store.get(selectedId) || emptyMoment;
  const current = () => getLifetime()?.current || (selectedId === 'current-transit'
    ? filterTransit(getTransit()?.current || original()) : getNatalDay()?.current || original());
  function refresh() { if (!selecting) onChange(); }
  return {
    get selectedId() { return selectedId; },
    get original() { return original(); },
    get current() { return current(); },
    get hasCurrent() { return Boolean(getLifetime()?.current) || selectedId === 'current-transit' && Boolean(getTransit()?.current) || store.has(selectedId); },
    refresh,
    select(id) {
      selecting = true;
      try {
        selectedId = id;
        getLifetime()?.close();
        // Selecting the same saved card also ends its temporary day preview.
        // Suppress only the navigation transition, never successive scrub input.
        getNatalDay()?.close();
        getNatalDay()?.select(original());
        getTransit()?.setWanted(id === 'current-transit');
      } finally { selecting = false; }
      refresh();
    },
  };
}
