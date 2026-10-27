// The compact menu owns a group of navigation targets, not chart data.
// The chart session remains the sole owner of the displayed card.
export function createLibrarySelection(initialIds?: readonly string[]) {
  let selected = new Set(initialIds), order: string[] = [], observedId: string | undefined;
  function sync(availableIds: readonly string[], currentId: string) {
    order = [...new Set(availableIds)];
    const available = new Set(order);
    selected = new Set([...selected].filter(id => available.has(id)));
    if (observedId === undefined) {
      if (available.has(currentId) && (initialIds === undefined || selected.size > 0)) selected.add(currentId);
    } else if (observedId !== currentId && !selected.has(currentId)) {
      selected = new Set(available.has(currentId) ? [currentId] : []);
    }
    observedId = currentId;
  }
  function choose(id: string, additive: boolean, currentId: string): string | null {
    if (!order.includes(id)) return null;
    if (!additive) { selected = new Set([id]); return id; }
    if (!selected.has(id)) { selected.add(id); return id; }
    selected.delete(id);
    return selected.has(currentId) ? currentId : [...selected].at(-1) ?? null;
  }
  function adjacent(currentId: string, direction: -1 | 1): string | null {
    const group = order.filter(id => selected.has(id));
    if (!group.length) return null;
    const index = group.indexOf(currentId);
    if (index < 0) return direction === 1 ? group[0]! : group.at(-1)!;
    return group[Math.max(0, Math.min(group.length - 1, index + direction))]!;
  }
  return { sync, choose, adjacent, get snapshot() { return [...selected]; } };
}
