import type { ChartView } from '../domain/chart-composition.ts';
import type { MandalaCross } from '../domain/mandala-cross.ts';
import type { SelectionTarget, SelectionType, ActivationSelectionFilter } from '../selection/selection-targets.ts';
export interface RenderOptions {
  profile?: 'studio' | 'thumbnail';
  interactive?: boolean;
  idPrefix?: string;
  showLabels?: boolean;
  dimInactive?: boolean;
  showActivations?: boolean;
  showBackdrop?: boolean;
  showMandala?: boolean;
  showMandalaLayer?: boolean;
  selections?: readonly SelectionTarget[];
  previewSelection?: SelectionTarget | null;
  pinnedCrosses?: readonly MandalaCross[];
  activationFilter?: ActivationSelectionFilter | null;
}
export type RenderState = ReturnType<typeof createRenderState>;
export interface RenderedScene { chart: ChartView; state: RenderState; options: RenderOptions }

import { CHANNELS, getChannel, getDefinition } from '../domain/topology.ts';
import { createOverlaySourceState } from '../domain/chart-overlay.ts';
import { chartTopology } from '../domain/chart-composition.ts';
import { gatesForSelection } from '../selection/selection-targets.ts';

// One render snapshot: preview paint stays separate from committed selection.
// Does not mutate the chart, the selection controller, or any DOM element.
export function createRenderState(chart: ChartView, selection: SelectionTarget | null | undefined, options: RenderOptions) {
  const committedSelection = selection;
  const committedSelections = (options.selections || [selection]).filter((item): item is SelectionTarget => Boolean(item));
  const committedIdsByType = new Map<SelectionType, Set<string>>();
  for (const { type, id } of committedSelections) {
    if (!committedIdsByType.has(type)) committedIdsByType.set(type, new Set());
    committedIdsByType.get(type)!.add(String(type === 'channel' ? getChannel(id as string)?.id : id));
  }
  // Hover adds a temporary layer. Only the committed selection owns pressed
  // state; moving the pointer must never erase or broaden that selection.
  const visualSelections = [...committedSelections, options.previewSelection].filter((item): item is SelectionTarget => Boolean(item));
  const topology = chartTopology(chart);
  const personality = new Set((topology.personality || []).map(Number));
  const design = new Set((topology.design || []).map(Number));
  const definition = getDefinition(topology);
  const definedChannels = new Set(definition.channels.map(({ id }) => id));
  const interactive = options.interactive !== false;
  const prefix = String(options.idPrefix || 'bodygraph').replace(/[^a-zA-Z0-9_-]/g, '') || 'bodygraph';
  const relatedChannels = new Set<string>();
  const relatedGates = new Set<number>();
  const halfGates = new Set<number>();
  const selectedGates = new Set<number>();
  const selectedCenters = new Set<string | number>();
  const selectedChannels = new Set<string>();
  for (const value of visualSelections) {
    const gates = gatesForSelection(value);
    gates.forEach(id => relatedGates.add(id));
    if (['gate', 'center', 'mandala-cross'].includes(value.type)) gates.forEach(id => halfGates.add(id));
    if (value.type === 'mandala-cross') gates.forEach(id => selectedGates.add(id));
    if (value.type === 'gate') selectedGates.add(Number(value.id));
    if (value.type === 'center') selectedCenters.add(value.id);
    if (value.type === 'channel') {
      const channel = getChannel(value.id as string);
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
    committedSelection, committedSelections, committedIdsByType, visualSelections,
    hasExplicitSelection: Boolean(options.previewSelection || options.selections),
    personality, design, definition, definedChannels, interactive, prefix,
    overlaySources: createOverlaySourceState(chart),
    relatedChannels, relatedGates, halfGates, selectedGates, selectedCenters,
    selectedChannels, committedGates, previewGates,
  };
}

// Preview contributes paint, but only committed targets own the pressed state.
export function isSelectionPressed(state: RenderState, type: SelectionType, id: string | number, fallback: boolean) {
  return state.hasExplicitSelection
    ? Boolean(state.committedIdsByType.get(type)?.has(String(id))) : fallback;
}
