export type PreviewSelection = SelectionTarget & { focusGate?: number };
import type { MandalaCross } from '../domain/mandala-cross.ts';
export type SelectionType = 'gate' | 'center' | 'channel' | 'integration' | 'planet' | 'mandala-cross';
export interface SelectionIdentity { type: SelectionType; id: string | number }
export interface SelectionTarget extends SelectionIdentity { activation?: string | null; cross?: MandalaCross }
export interface SelectionAction extends SelectionTarget { additive?: boolean; pointerType?: string }
export interface SelectionSnapshot {
  items: readonly SelectionTarget[];
  primary: SelectionIdentity | null;
  activation: string | null;
}
export interface SummaryFilter { line: number; source: 'design' | 'personality' | 'all'; gates?: readonly number[] }
export type ActivationSelectionFilter = ActivationFilter | (SummaryFilter & { groups?: never; unfilteredGates?: never });
export interface ActivationFilter {
  groups: readonly (SummaryFilter & { gates: readonly number[] })[];
  unfilteredGates: readonly number[];
}

import { GATES, getChannel } from '../domain/topology.ts';

// Shared identity and topology for ordinary selections, line groups and
// mandala crosses. These helpers do not own or change selection state.
export const selectionKey = (item: SelectionIdentity) => `${item.type}:${item.id}`;

export function gatesForSelection(item: SelectionTarget | null | undefined) {
  switch (item?.type) {
    case 'gate': return [Number(item.id)];
    case 'center': return GATES.filter(gate => gate.center === item.id).map(gate => gate.id);
    case 'channel': return getChannel(item.id as string)?.gates || [];
    case 'integration': return [10, 20, 34, 57];
    case 'mandala-cross': return item.cross?.gates || [];
    default: return [];
  }
}
