import type { ChartInput } from './chart-composition.ts';
export interface FixingActivation { source: 'design' | 'personality'; planet: string; gate: number; line: number }
export interface LineFixing {
  state: 'none' | 'exalted' | 'detriment' | 'juxtaposed';
  exalted: FixingActivation[];
  detriment: FixingActivation[];
}
import { CHANNELS } from './topology.ts';
import { PLANET_IDS } from './planets.ts';
import { LINE_FIXING_DATA } from './line-fixing-data.ts';

const RULERS = new Set(PLANET_IDS.filter(planet => planet !== 'north_node' && planet !== 'south_node'));
const PLANETS = new Set(PLANET_IDS);
const harmonicGates = new Map(Array.from({ length: 64 }, (_, index) => [index + 1, new Set([index + 1])]));
for (const { gates: [first, second] } of CHANNELS) {
  harmonicGates.get(first)!.add(second);
  harmonicGates.get(second)!.add(first);
}

function validActivations(chart: ChartInput | null | undefined) {
  const result: FixingActivation[] = [];
  for (const source of ['design', 'personality'] as const) {
    const entries = chart?.activations?.[source];
    if (!Array.isArray(entries)) continue;
    const counts = new Map<string, number>();
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
export function calculateLineFixings(chart: ChartInput | null | undefined): Map<string, LineFixing> {
  const activations = validActivations(chart);
  return new Map(activations.map(target => {
    const rule = LINE_FIXING_DATA[`${target.gate}.${target.line}`];
    const connected = harmonicGates.get(target.gate)!;
    const contributors = (rulers: readonly string[] | undefined) => Array.isArray(rulers)
      ? activations.filter(entry => RULERS.has(entry.planet) && rulers.includes(entry.planet) && connected.has(entry.gate))
        .map(entry => ({ ...entry }))
      : [];
    const exalted = contributors(rule?.exalted);
    const detriment = contributors(rule?.detriment);
    const state = exalted.length ? detriment.length ? 'juxtaposed' : 'exalted' : detriment.length ? 'detriment' : 'none';
    return [`${target.source}-${target.planet}`, { state, exalted, detriment }];
  }));
}
