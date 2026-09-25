import { createSelectionState } from './selection-state.js';
import { GATES } from '../bodygraph/graph-data.js';
import { selectionKey as key, gatesForSelection as ownedGates } from './selection-targets.js';
import { buildChartSummary } from '../charts/chart-summary-data.js';

const validGates = values => [...new Set(values.filter(id => Number.isInteger(id) && id >= 1 && id <= 64))];
const sameGroup = (first, second) => first.line === second.line && first.source === second.source;

// Ordinary interactions keep their existing controller. Line groups contribute
// independent gate ownership, so removing one group cannot remove an overlap
// still owned by another group, an explicit gate, a center or a channel.
export function createSummarySelectionState() {
  const ordinary = createSelectionState();
  let groups = [], combined = null, activationFilter = null;

  function rebuild() {
    if (!groups.length) { combined = null; activationFilter = null; return; }
    const candidates = new Map(ordinary.items.map(item => [key(item), item]));
    for (const group of groups) for (const id of group.gates) {
      const item = { type: 'gate', id };
      if (!candidates.has(key(item))) candidates.set(key(item), Object.freeze(item));
    }
    // Keep existing order and append new targets in action order. Recalculating
    // a live transit therefore does not reorder gates that are still selected.
    const items = [];
    for (const previous of combined?.items || ordinary.items) {
      const item = candidates.get(key(previous));
      if (item) { items.push(item); candidates.delete(key(previous)); }
    }
    items.push(...candidates.values());
    const last = items.at(-1);
    combined = Object.freeze({
      items: Object.freeze(items),
      primary: last ? Object.freeze({ type: last.type, id: last.id }) : null,
      activation: last?.activation || null,
    });
    activationFilter = Object.freeze({
      groups: Object.freeze(groups.map(({ line, source, gates }) => Object.freeze({ line, source, gates: Object.freeze([...gates]) }))),
      unfilteredGates: Object.freeze([...new Set(ordinary.items.flatMap(ownedGates))]),
    });
  }

  function choose(value) {
    if (!groups.length) return ordinary.choose(value);
    if (!value.additive) {
      groups = []; combined = null; activationFilter = null;
      ordinary.clear();
      return ordinary.choose(value);
    }
    const id = Number(value.id);
    const matchingGroups = value.type === 'gate' ? groups.filter(group => group.gates.includes(id)) : [];
    let effect = { popoverActivation: null };
    if (matchingGroups.length) {
      // Shift on a selected individual gate subtracts it from every line group
      // that owns it, without broadening the other rows to whole-gate selection.
      for (const group of matchingGroups) {
        group.excluded.add(id);
        group.gates = group.gates.filter(gate => gate !== id);
      }
      const gateCenter = GATES.find(gate => gate.id === id)?.center;
      if (ordinary.items.some(item => item.type === 'gate' && item.id === id
        || item.type === 'center' && item.id === gateCenter)) effect = ordinary.choose(value);
    } else {
      effect = ordinary.choose(value);
    }
    rebuild();
    return combined.items.length === 1 ? effect : { popoverActivation: null };
  }

  function chooseSummary(gates, filter, { additive = false } = {}) {
    if (!Number.isInteger(filter?.line) || filter.line < 1 || filter.line > 6
      || !['design', 'personality', 'all'].includes(filter.source)) return;
    const index = groups.findIndex(group => sameGroup(group, filter));
    const nextGates = validGates(gates);
    const complete = index !== -1 && groups[index].gates.length === nextGates.length
      && nextGates.every(id => groups[index].gates.includes(id));
    const repeated = complete && (additive || groups.length === 1 && ordinary.items.length === 0);
    if (!additive) { ordinary.clear(); groups = []; combined = null; }
    if (repeated) {
      if (additive) groups.splice(index, 1);
    } else {
      const group = { line: filter.line, source: filter.source, gates: nextGates, excluded: new Set() };
      // A partially selected count is not pressed: selecting it fills its
      // missing gates first. A later Shift selection removes the full group.
      if (additive && index !== -1) groups[index] = group;
      else groups.push(group);
    }
    rebuild();
  }

  function refresh(chart) {
    if (!groups.length) return;
    const summary = buildChartSummary(chart);
    let changed = false;
    for (const group of groups) {
      const gates = summary.lines[group.line - 1].gates[group.source].filter(id => !group.excluded.has(id));
      if (gates.length !== group.gates.length || gates.some((id, index) => id !== group.gates[index])) {
        group.gates = gates; changed = true;
      }
    }
    if (changed) rebuild();
  }

  return {
    choose, chooseSummary, refresh,
    clear() { ordinary.clear(); groups = []; combined = null; activationFilter = null; },
    get items() { return combined?.items || ordinary.items; },
    get primary() { return combined ? combined.primary : ordinary.primary; },
    get activation() { return combined ? combined.activation : ordinary.activation; },
    get activationFilter() { return activationFilter; },
  };
}
