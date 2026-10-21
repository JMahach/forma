import type { ChartView, ChartComposition } from './chart-composition.ts';
export interface OverlaySource { id: string; origin: 'natal' | 'cycle'; source: 'personality' | 'design'; bit: number }
import { getDefinition } from './topology.ts';
import { isChartOverlay } from './chart-composition.ts';

// Source identity survives every projection: gate unions describe topology,
// while the four independent inputs describe whose activation made it.
export const OVERLAY_SOURCES: readonly OverlaySource[] = Object.freeze([
  { id: 'natal-personality', origin: 'natal', source: 'personality', bit: 1 },
  { id: 'natal-design', origin: 'natal', source: 'design', bit: 2 },
  { id: 'cycle-personality', origin: 'cycle', source: 'personality', bit: 4 },
  { id: 'cycle-design', origin: 'cycle', source: 'design', bit: 8 },
].map(source => Object.freeze(source as OverlaySource)));
const validGates = (values: unknown) => (Array.isArray(values) ? values : []).map(Number)
  .filter(gate => Number.isInteger(gate) && gate >= 1 && gate <= 64);

const originChart = (chart: ChartView, origin: string) => isChartOverlay(chart) ? origin === 'natal' ? chart.primary : chart.secondary : null;
export const overlayOriginLabel = (chart: Partial<ChartComposition> | null | undefined, origin: string) => origin === 'natal' ? chart?.primaryLabel?.trim() || 'Личная карта'
  : chart?.kind === 'transit' ? 'Транзит' : 'Возврат';
const sourceLabel = (chart: Partial<ChartComposition>, source: OverlaySource) => `${overlayOriginLabel(chart, source.origin)} · ${source.source === 'design' ? 'Дизайн' : 'Личность'}`;

export function overlaySources(chart: ChartView) {
  if (!isChartOverlay(chart)) return [];
  return OVERLAY_SOURCES.map(source => ({ ...source, label: sourceLabel(chart, source),
    gates: new Set(validGates(originChart(chart, source.origin)![source.source])),
  }));
}

export function createOverlaySourceState(chart: ChartView) {
  const sources = overlaySources(chart);
  if (!sources.length) return null;
  const overlay = chart as Extract<ChartComposition, { kind: 'transit' | 'return' }>;
  const masks = new Map<number, number>();
  for (const source of sources) for (const gate of source.gates) masks.set(gate, (masks.get(gate) || 0) | source.bit);
  return { sources, masks, kind: overlay.kind, natal: getDefinition(overlay.primary), cycle: getDefinition(overlay.secondary) };
}

export function resolveOverlayActivation(chart: ChartView, id: unknown) {
  if (typeof id !== 'string') return null;
  for (const source of OVERLAY_SOURCES) {
    const prefix = `${source.id}-`;
    if (!id.startsWith(prefix)) continue;
    const planet = id.slice(prefix.length);
    const owner = originChart(chart, source.origin);
    if (owner?.source === 'manual') return null;
    const entry = owner?.activations?.[source.source]?.find(entry => entry.planet === planet);
    return entry ? { ...source, label: sourceLabel(chart as Partial<ChartComposition>, source), planet, entry, chart: owner } : null;
  }
  return null;
}
