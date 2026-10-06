import { getDefinition } from './topology.js';
import { isChartOverlay } from './chart-composition.js';

// Two origins share one palette across graph, mandala and source captions.
export const OVERLAY_PALETTE = Object.freeze({ natal: '#c32d35', cycle: '#202020' });

// Source identity survives every projection: gate unions describe topology,
// while the four independent inputs describe whose activation made it.
export const OVERLAY_SOURCES = Object.freeze([
  { id: 'natal-personality', origin: 'natal', source: 'personality', bit: 1, color: OVERLAY_PALETTE.natal },
  { id: 'natal-design', origin: 'natal', source: 'design', bit: 2, color: OVERLAY_PALETTE.natal },
  { id: 'cycle-personality', origin: 'cycle', source: 'personality', bit: 4, color: OVERLAY_PALETTE.cycle },
  { id: 'cycle-design', origin: 'cycle', source: 'design', bit: 8, color: OVERLAY_PALETTE.cycle },
].map(Object.freeze));
const validGates = values => (Array.isArray(values) ? values : []).map(Number)
  .filter(gate => Number.isInteger(gate) && gate >= 1 && gate <= 64);

const originChart = (chart, origin) => isChartOverlay(chart) ? origin === 'natal' ? chart.primary : chart.secondary : null;
export const overlayOriginLabel = (chart, origin) => origin === 'natal' ? originChart(chart, 'natal')?.name?.trim() || 'Личная карта'
  : chart?.kind === 'transit' ? 'Транзит' : 'Возврат';
const sourceLabel = (chart, source) => `${overlayOriginLabel(chart, source.origin)} · ${source.source === 'design' ? 'Дизайн' : 'Личность'}`;

export function overlaySources(chart) {
  if (!isChartOverlay(chart)) return [];
  return OVERLAY_SOURCES.map(source => ({ ...source, label: sourceLabel(chart, source),
    gates: new Set(validGates(originChart(chart, source.origin)[source.source])),
  }));
}

export function createOverlaySourceState(chart) {
  const sources = overlaySources(chart);
  if (!sources.length) return null;
  const masks = new Map();
  for (const source of sources) for (const gate of source.gates) masks.set(gate, (masks.get(gate) || 0) | source.bit);
  return { sources, masks, kind: chart.kind, natal: getDefinition(chart.primary), cycle: getDefinition(chart.secondary) };
}

export function resolveOverlayActivation(chart, id) {
  if (typeof id !== 'string') return null;
  for (const source of OVERLAY_SOURCES) {
    const prefix = `${source.id}-`;
    if (!id.startsWith(prefix)) continue;
    const planet = id.slice(prefix.length);
    const owner = originChart(chart, source.origin);
    if (owner?.source === 'manual') return null;
    const entry = owner?.activations?.[source.source]?.find(entry => entry.planet === planet);
    return entry ? { ...source, label: sourceLabel(chart, source), planet, entry, chart: owner } : null;
  }
  return null;
}
