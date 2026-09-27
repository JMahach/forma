import { GATES } from '../domain/topology.js';

// Committed selection only. Hover, drawing, popover DOM and camera movement
// stay with their existing adapters. Derived fields change atomically with
// the items, and keep their identity until the next selection action.
function snapshot(items) {
  const primary = items.at(-1);
  items.forEach(item => Object.freeze(item));
  return Object.freeze({
    items: Object.freeze(items),
    primary: primary ? Object.freeze({ type: primary.type, id: primary.id }) : null,
    activation: primary?.activation || null,
  });
}

export function createSelectionState() {
  let current = snapshot([]);

  function choose(value) {
    const selectedItems = current.items;
    const next = { type: value.type, id: value.type === 'gate' ? Number(value.id) : value.id };
    const activation = value.type === 'gate' ? value.activation || null : null;
    const index = selectedItems.findIndex(item => item.type === next.type && item.id === next.id);
    const gateCenter = next.type === 'gate' ? GATES.find(gate => gate.id === next.id)?.center : null;
    const subtractFromCenter = value.additive && gateCenter
      && selectedItems.some(item => item.type === 'center' && item.id === gateCenter);
    const repeated = value.additive ? index !== -1 || Boolean(subtractFromCenter)
      : selectedItems.length === 1 && index === 0 && current.activation === activation;
    const item = { ...next, ...(activation ? { activation } : {}) };
    let items;
    if (subtractFromCenter) {
      // Preserve the existing order, activation metadata and deduplication
      // when a full center becomes an independently editable set of gates.
      const expanded = selectedItems.flatMap(selected => {
        if (selected.type === 'gate' && selected.id === next.id) return [];
        if (selected.type !== 'center' || selected.id !== gateCenter) return [selected];
        return GATES.filter(gate => gate.center === gateCenter && gate.id !== next.id)
          .map(gate => selectedItems.find(existing => existing.type === 'gate' && existing.id === gate.id)
            || { type: 'gate', id: gate.id });
      });
      items = [...new Map(expanded.map(selected => [`${selected.type}:${selected.id}`, selected])).values()];
    } else {
      items = value.additive
        ? repeated ? selectedItems.filter((_, position) => position !== index) : [...selectedItems, item]
        : repeated ? [] : [item];
    }
    current = snapshot(items);
    return { popoverActivation: activation && !repeated && items.length === 1 ? activation : null };
  }

  return {
    choose,
    clear() { current = snapshot([]); },
    // Consumers read these snapshots; only choose/clear change the state.
    get items() { return current.items; },
    get primary() { return current.primary; },
    get activation() { return current.activation; },
  };
}
