import { OVERLAY_SOURCES, OVERLAY_PALETTE, overlaySources } from '../domain/chart-overlay.js';
import { isChartOverlay, primaryChart, chartTopology } from '../domain/chart-composition.js';
import { PLANETS } from '../domain/planets.js';
import { gatePositionAtLongitude } from '../domain/gate-wheel.js';
import { MANDALA_GEOMETRY, mandalaPoint } from './geometry/mandala-geometry.js';

// Shared visual decisions for the complete SVG and persistent mandala painter.
export const MANDALA_PALETTE = Object.freeze({
  paper: '#eee8dc', rim: '#a59c8d', light: '#ffffff', empty: '#8e897e',
  design: '#ae6259', personality: '#4b514e', both: '#696257',
  highlight: '#c4d9f1',
});
const gateSet = values => new Set((Array.isArray(values) ? values : [])
  .map(Number).filter(gate => Number.isInteger(gate) && gate >= 1 && gate <= 64));

export function mandalaPlanetEntries(chart) {
  if (isChartOverlay(chart)) {
    // Each physical chart is prepared once; its two source lanes reuse it.
    const planets = { natal: mandalaPlanetEntries(chart.primary), cycle: mandalaPlanetEntries(chart.secondary) };
    const entries = OVERLAY_SOURCES.flatMap(source => planets[source.origin]
      .filter(entry => entry.source === source.source)
      .map(entry => ({ ...entry, source: source.id, origin: source.origin, lane: source.source })));
    // Exact returns can differ by a numerical residual but share the same
    // rounded SVG endpoint. Split that displayed point, keeping both longitudes.
    const points = entries.map(entry => mandalaPoint(entry.longitude, MANDALA_GEOMETRY.innerRadius).join(','));
    const owners = new Map();
    entries.forEach((entry, index) => {
      if (!owners.has(points[index])) owners.set(points[index], new Set());
      owners.get(points[index]).add(entry.origin);
    });
    return entries.map((entry, index) => ({ ...entry, shared: owners.get(points[index]).size > 1 }));
  }
  chart = primaryChart(chart);
  if (!['calculated', 'transit'].includes(chart?.source)) return [];
  return ['design', 'personality'].flatMap(source => {
    const entries = chart.activations?.[source];
    if (!Array.isArray(entries)) return [];
    return PLANETS.flatMap(([planet]) => {
      const matches = entries.filter(entry => entry?.planet === planet);
      if (matches.length !== 1) return [];
      const entry = matches[0];
      if (!Number.isFinite(entry.longitude) || entry.longitude < 0 || entry.longitude >= 360) return [];
      const position = gatePositionAtLongitude(entry.longitude);
      if (entry.gate !== position.gate || entry.line !== position.line) return [];
      return [{ source, planet, longitude: entry.longitude }];
    });
  });
}

export function mandalaGateSets(chart) {
  const sources = overlaySources(chart);
  const topology = chartTopology(chart);
  return { personality: gateSet(topology?.personality), design: gateSet(topology?.design), ...(sources.length ? { sources } : {}) };
}

export const MANDALA_OPACITY = Object.freeze({ fan: '.11', focus: '.242', sector: '.30', highlight: '.77' });

export function mandalaSectorPaint(geometry, gates, selectedGates, relatedGates) {
  const { gate, ring, halfRings, fan, halfFans } = geometry;
  if (gates.sources) {
    const origins = ['natal', 'cycle'].filter(origin => gates.sources.some(source => source.origin === origin && source.gates.has(gate)));
    const both = origins.length === 2;
    return { state: origins.length ? 'overlay' : 'empty', related: relatedGates.has(gate), pressed: selectedGates.has(gate),
      color: origins.length === 1 ? OVERLAY_PALETTE[origins[0]] : MANDALA_PALETTE[origins.length ? 'both' : 'empty'],
      textWeight: origins.length ? '600' : '400',
      sources: origins.map((origin, index) => ({ source: origin,
        color: OVERLAY_PALETTE[origin],
        ring: both ? halfRings[index] : ring, fan: both ? halfFans[index] : fan })) };
  }
  const hasPersonality = gates.personality.has(gate), hasDesign = gates.design.has(gate);
  const state = hasPersonality && hasDesign ? 'both' : hasDesign ? 'design' : hasPersonality ? 'personality' : 'empty';
  const active = state !== 'empty';
  const sources = state === 'both' ? ['design', 'personality'] : active ? [state] : [];
  return { state, related: relatedGates.has(gate), pressed: selectedGates.has(gate),
    color: MANDALA_PALETTE[state], textWeight: active ? '600' : '400',
    sources: sources.map((source, index) => ({ source, color: MANDALA_PALETTE[source],
      ring: state === 'both' ? halfRings[index] : ring, fan: state === 'both' ? halfFans[index] : fan })),
  };
}

export function mandalaPlanetPaint(source, planet) {
  // Both sources meet the same ring at their exact longitude. Sun/Earth
  // differ only in emphasis; their geometry never receives an offset.
  const cross = planet === 'sun' || planet === 'earth';
  const origin = OVERLAY_SOURCES.find(item => item.id === source)?.origin;
  return { origin, rayClass: `mandala-planet-ray${cross ? ' mandala-cross-axis' : ''}`, color: origin ? OVERLAY_PALETTE[origin] : MANDALA_PALETTE[source],
    symbol: PLANETS.find(([id]) => id === planet)?.[1] || '',
    leaderOpacity: '.5', leaderWidth: '.65', symbolOutline: MANDALA_PALETTE.light, symbolOutlineWidth: '3',
    rayOpacity: cross ? '.64' : '.4', rayWidth: cross ? '.8' : '.55',
    radius: cross ? '1.35' : '.85', endpointOpacity: cross ? '1' : '.9' };
}

// Only coincident origins split the small endpoint; rays retain exact angles.
export function mandalaEndpointPath(paint, x, y, shared = false) {
  const radius = Number(paint.radius), top = y - radius, bottom = y + radius;
  if (shared) return `M ${x} ${top} A ${radius} ${radius} 0 0 ${paint.origin === 'natal' ? 0 : 1} ${x} ${bottom} Z`;
  return `M ${x} ${top} A ${radius} ${radius} 0 1 0 ${x} ${bottom} A ${radius} ${radius} 0 1 0 ${x} ${top} Z`;
}
