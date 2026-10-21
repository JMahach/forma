import type { ChartView } from '../domain/chart-composition.ts';
import type { MandalaCross } from '../domain/mandala-cross.ts';
import type { SelectionTarget, SelectionAction, SelectionSnapshot, SummaryFilter, ActivationFilter } from './selection-targets.ts';
export type SelectionModel = ReturnType<typeof createSelectionModel>;
import { createSummarySelectionState } from './summary-selection-state.ts';
import { crossAtLongitude } from '../domain/mandala-cross.ts';
import { selectionKey as key, gatesForSelection as ownedGates } from './selection-targets.ts';

const EMPTY_CROSSES: readonly MandalaCross[] = Object.freeze([]);
const crossKey = (cross: MandalaCross) => `${cross.type}:${cross.gates.join(',')}`;

type CrossInput = Pick<MandalaCross, 'longitude'> & Partial<MandalaCross>;
export interface CrossAction extends Omit<SelectionAction, 'type' | 'id' | 'cross'> { type: 'mandala-cross'; id?: string | number; cross: CrossInput }

function snapshotCross(value: CrossInput | undefined) {
  const source = value?.source === undefined ? 'personality' : value?.source;
  if (!Number.isFinite(value?.longitude) || !['personality', 'design'].includes(source!)) return null;
  const cross = crossAtLongitude(value!.longitude, { source: source as 'design' | 'personality' });
  cross.positions.forEach(Object.freeze);
  Object.freeze(cross.positions);
  Object.freeze(cross.gates);
  return Object.freeze(cross);
}

/**
 * Crosses own their four gates independently of ordinary and summary selection.
 * Their exact axes are snapshots, never silently moved by a new hover. All
 * consumers still receive ordinary gate items; only the wheel uses `crosses`.
 * Removing a gate excludes it from every owning group. A complete visible
 * quartet can restore its pinned axes if that gate is explicitly added again.
 */
export function createSelectionModel() {
  const base = createSummarySelectionState();
  let groups: { cross: MandalaCross; excluded: Set<number> }[] = [];
  let combined: (SelectionSnapshot & { activationFilter: ActivationFilter | null }) | null = null;
  let crosses = EMPTY_CROSSES;
  // A channel/integration cut by Shift becomes ordinary independent gates.
  // Keep their ownership separate from line groups so removing a line group
  // later cannot erase another remaining half of that channel.
  const expandedGates = new Map<number, SelectionTarget>();

  function rebuild() {
    if (!groups.length && !expandedGates.size) { combined = null; crosses = EMPTY_CROSSES; return; }
    const candidates = new Map(base.items.map(item => [key(item), item]));
    for (const item of expandedGates.values()) if (!candidates.has(key(item))) candidates.set(key(item), item);
    const crossGates = new Set(groups.flatMap(group => group.cross.gates.filter(id => !group.excluded.has(id))));
    for (const id of crossGates) {
      const item = Object.freeze({ type: 'gate' as const, id });
      if (!candidates.has(key(item))) candidates.set(key(item), item);
    }
    const items: SelectionTarget[] = [];
    for (const previous of combined?.items || base.items) {
      const item = candidates.get(key(previous));
      if (item) { items.push(item); candidates.delete(key(previous)); }
    }
    items.push(...candidates.values());
    const visibleGates = new Set(items.flatMap(ownedGates));
    crosses = Object.freeze(groups.filter(group => group.cross.gates.every(id => visibleGates.has(id))).map(group => group.cross));
    const last = items.at(-1), filter = base.activationFilter;
    const activationFilter = filter ? Object.freeze({
      groups: filter.groups,
      unfilteredGates: Object.freeze([...new Set([...filter.unfilteredGates, ...expandedGates.keys(), ...crossGates])]),
    }) : null;
    combined = Object.freeze({
      items: Object.freeze(items),
      primary: last ? Object.freeze({ type: last.type, id: last.id }) : null,
      activation: last?.activation || null, activationFilter,
    });
  }

  function clearCrosses() { groups = []; expandedGates.clear(); combined = null; crosses = EMPTY_CROSSES; }

  function choose(value: SelectionAction | CrossAction) {
    if (value?.type === 'mandala-cross') {
      const cross = snapshotCross(value.cross);
      if (!cross) return;
      const index = groups.findIndex(group => crossKey(group.cross) === crossKey(cross));
      const repeated = index !== -1 && (value.additive || groups.length === 1 && base.items.length === 0 && expandedGates.size === 0);
      if (!value.additive) {
        base.clear(); clearCrosses();
        if (!repeated) groups.push({ cross, excluded: new Set() });
      } else if (repeated) groups.splice(index, 1);
      else groups.push({ cross, excluded: new Set() });
      rebuild();
      return;
    }

    if (!groups.length && !expandedGates.size) return base.choose(value);
    if (!value.additive) {
      base.clear(); clearCrosses();
      return base.choose(value);
    }
    const id = Number(value.id);
    if (value.type === 'gate' && Number.isInteger(id) && id >= 1 && id <= 64) {
      const ownedByCross = groups.some(group => group.cross.gates.includes(id) && !group.excluded.has(id));
      const ownedByExpanded = expandedGates.has(id);
      const ownedByBase = base.items.some(item => ownedGates(item).includes(id));
      if (ownedByCross || ownedByExpanded || ownedByBase) {
        for (const group of groups) if (group.cross.gates.includes(id)) group.excluded.add(id);
        expandedGates.delete(id);
        // Base's established gate/center/line-group subtraction is preserved.
        // Expand only composite types which that controller cannot split.
        const composites = base.items.filter(item => ['channel', 'integration'].includes(item.type) && ownedGates(item).includes(id));
        for (const item of composites) {
          base.choose({ ...item, additive: true });
          for (const gate of ownedGates(item)) if (gate !== id) expandedGates.set(gate, Object.freeze({ type: 'gate', id: gate }));
        }
        if (base.items.some(item => ownedGates(item).includes(id))) base.choose(value);
        rebuild();
        return;
      }
    }
    base.choose(value);
    rebuild();
  }

  function chooseSummary(gates: readonly number[], filter: SummaryFilter, { additive = false } = {}) {
    if (!Array.isArray(gates) || !Number.isInteger(filter?.line) || filter.line < 1 || filter.line > 6
      || !['design', 'personality', 'all'].includes(filter.source)) return;
    if (!additive && (groups.length || expandedGates.size)) { base.clear(); clearCrosses(); }
    base.chooseSummary(gates, filter, { additive });
    rebuild();
  }

  function refresh(chart: ChartView) {
    const previousItems = base.items, previousFilter = base.activationFilter;
    base.refresh(chart);
    if (previousItems !== base.items || previousFilter !== base.activationFilter) rebuild();
  }

  return {
    choose, chooseSummary, refresh,
    clear() { base.clear(); clearCrosses(); },
    get items() { return combined?.items || base.items; },
    get primary() { return combined ? combined.primary : base.primary; },
    get activation() { return combined ? combined.activation : base.activation; },
    get activationFilter() { return combined ? combined.activationFilter : base.activationFilter; },
    get crosses() { return crosses; },
  };
}
