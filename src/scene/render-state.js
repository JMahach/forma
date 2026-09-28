import { CHANNELS, getChannel, getDefinition } from '../domain/topology.js';
import { gatesForSelection } from '../selection/selection-targets.js';

// One render snapshot: preview paint stays separate from committed selection.
// Does not mutate the chart, the selection controller, or any DOM element.
export function createRenderState(chart, selection, options) {
  const committedSelection = selection;
  const committedSelections = (options.selections || [selection]).filter(Boolean);
  // Hover adds a temporary layer. Only the committed selection owns pressed
  // state; moving the pointer must never erase or broaden that selection.
  const visualSelections = [...committedSelections, options.previewSelection].filter(Boolean);
  const personality = new Set((chart.personality || []).map(Number));
  const design = new Set((chart.design || []).map(Number));
  const definition = getDefinition(chart);
  const definedChannels = new Set(definition.channels.map(({ id }) => id));
  const interactive = options.interactive !== false;
  const prefix = String(options.idPrefix || 'bodygraph').replace(/[^a-zA-Z0-9_-]/g, '') || 'bodygraph';
  const relatedChannels = new Set();
  const relatedGates = new Set();
  const halfGates = new Set();
  const selectedGates = new Set();
  const selectedCenters = new Set();
  const selectedChannels = new Set();
  for (const value of visualSelections) {
    const gates = gatesForSelection(value);
    gates.forEach(id => relatedGates.add(id));
    if (['gate', 'center', 'mandala-cross'].includes(value.type)) gates.forEach(id => halfGates.add(id));
    if (value.type === 'mandala-cross') gates.forEach(id => selectedGates.add(id));
    if (value.type === 'gate') selectedGates.add(Number(value.id));
    if (value.type === 'center') selectedCenters.add(value.id);
    if (value.type === 'channel') {
      const channel = getChannel(value.id);
      if (channel) selectedChannels.add(channel.id);
    }
  }

  CHANNELS.forEach((channel) => {
    const related = channel.gates.some(id => halfGates.has(id)) || selectedChannels.has(channel.id);
    if (related) relatedChannels.add(channel.id);
  });

  const committedGates = new Set(committedSelections.flatMap(gatesForSelection));
  const previewGates = new Set(gatesForSelection(options.previewSelection));
  return {
    committedSelection, committedSelections, visualSelections,
    hasExplicitSelection: Boolean(options.previewSelection || options.selections),
    personality, design, definition, definedChannels, interactive, prefix,
    relatedChannels, relatedGates, halfGates, selectedGates, selectedCenters,
    selectedChannels, committedGates, previewGates,
  };
}

// Preview contributes paint, but only committed targets own the pressed state.
export function isSelectionPressed(state, type, id, fallback) {
  return state.hasExplicitSelection ? state.committedSelections.some(value => type === value.type
    && String(id) === String(type === 'channel' ? getChannel(value.id)?.id : value.id)) : fallback;
}
