import { GATES, getChannel } from '../domain/topology.js';

// Shared identity and topology for ordinary selections, line groups and
// mandala crosses. These helpers do not own or change selection state.
export const selectionKey = item => `${item.type}:${item.id}`;

export function gatesForSelection(item) {
  switch (item?.type) {
    case 'gate': return [Number(item.id)];
    case 'center': return GATES.filter(gate => gate.center === item.id).map(gate => gate.id);
    case 'channel': return getChannel(item.id)?.gates || [];
    case 'integration': return [10, 20, 34, 57];
    case 'mandala-cross': return item.cross?.gates || [];
    default: return [];
  }
}
