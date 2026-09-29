import { PLANETS } from '../domain/planets.js';
import { gatePositionAtLongitude } from '../domain/gate-wheel.js';

// Shared visual decisions for the complete SVG and persistent mandala painter.
export const MANDALA_PALETTE = Object.freeze({
  paper: '#eee8dc', rim: '#a59c8d', light: '#ffffff', empty: '#8e897e',
  design: '#ae6259', personality: '#4b514e', both: '#696257',
  highlight: '#c4d9f1',
});
const gateSet = values => new Set((Array.isArray(values) ? values : [])
  .map(Number).filter(gate => Number.isInteger(gate) && gate >= 1 && gate <= 64));

export function mandalaPlanetEntries(chart) {
  if (!['calculated', 'transit'].includes(chart?.source)) return [];
  return ['design', 'personality'].flatMap(source => {
    if (source === 'design' && chart.source === 'transit') return [];
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
  return { personality: gateSet(chart?.personality), design: gateSet(chart?.design) };
}

export const MANDALA_OPACITY = Object.freeze({ fan: '.11', focus: '.242', sector: '.30', highlight: '.77' });

export function mandalaSectorPaint(geometry, gates, selectedGates, relatedGates) {
  const { gate, ring, halfRings, fan, halfFans } = geometry;
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
  return { rayClass: `mandala-planet-ray${cross ? ' mandala-cross-axis' : ''}`, color: MANDALA_PALETTE[source],
    symbol: PLANETS.find(([id]) => id === planet)?.[1] || '',
    leaderOpacity: '.5', leaderWidth: '.65', symbolOutline: MANDALA_PALETTE.light, symbolOutlineWidth: '3',
    rayOpacity: cross ? '.64' : '.4', rayWidth: cross ? '.8' : '.55',
    radius: cross ? '1.35' : '.85', endpointOpacity: cross ? '1' : '.9' };
}
