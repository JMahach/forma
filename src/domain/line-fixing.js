import { CHANNELS } from './topology.js';
import { PLANET_IDS } from './planets.js';
import { LINE_FIXING_DATA } from './line-fixing-data.js';

const RULERS = new Set(PLANET_IDS.filter(planet => planet !== 'north_node' && planet !== 'south_node'));
const PLANETS = new Set(PLANET_IDS);
const harmonicGates = new Map(Array.from({ length: 64 }, (_, index) => [index + 1, new Set([index + 1])]));
for (const { gates: [first, second] } of CHANNELS) {
  harmonicGates.get(first).add(second);
  harmonicGates.get(second).add(first);
}

function validActivations(chart) {
  const result = [];
  for (const source of ['design', 'personality']) {
    const entries = chart?.activations?.[source];
    if (!Array.isArray(entries)) continue;
    const counts = new Map();
    for (const entry of entries) {
      if (PLANETS.has(entry?.planet)) counts.set(entry.planet, (counts.get(entry.planet) || 0) + 1);
    }
    for (const entry of entries) {
      if (!PLANETS.has(entry?.planet) || counts.get(entry.planet) !== 1) continue;
      const { planet, gate, line } = entry;
      if (!Number.isInteger(gate) || gate < 1 || gate > 64 || !Number.isInteger(line) || line < 1 || line > 6) continue;
      // Never retain caller-owned records or resolve conflicting duplicate rows.
      result.push({ source, planet, gate, line });
    }
  }
  return result;
}

// Interpret only the supplied chart. Nodes can have a fixed line, but cannot
// themselves fix another line; a ruler's own line number does not restrict it.
export function calculateLineFixings(chart) {
  const activations = validActivations(chart);
  return new Map(activations.map(target => {
    const rule = LINE_FIXING_DATA[`${target.gate}.${target.line}`];
    const connected = harmonicGates.get(target.gate);
    const contributors = rulers => Array.isArray(rulers)
      ? activations.filter(entry => RULERS.has(entry.planet) && rulers.includes(entry.planet) && connected.has(entry.gate))
        .map(entry => ({ ...entry }))
      : [];
    const exalted = contributors(rule?.exalted);
    const detriment = contributors(rule?.detriment);
    const state = exalted.length ? detriment.length ? 'juxtaposed' : 'exalted' : detriment.length ? 'detriment' : 'none';
    return [`${target.source}-${target.planet}`, { state, exalted, detriment }];
  }));
}
