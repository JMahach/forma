import type { Activation } from '../../shared/chart-types.ts';
import type { ChartInput } from './chart-composition.ts';
import { activationSubstructure } from './substructure.ts';

// Variable uses Tone from four Sun/Earth and nodal pairs, not Gate or Color.
// https://jovianarchive.com/blogs/deeper-mechanics-system-theory/variable-the-blueprint-of-brain-body-and-mind
// https://www.mybodygraph.com/blog/what-is-variable-in-human-design-understanding-the-arrows-in-your-chart
// Tone 1–3 is Left; Tone 4–6 is Right:
// https://jovianarchive.com/pages/the-basics-of-substructure-in-human-design
// Advanced Imaging additionally displays Color 1–3 down and 4–6 up,
// independently of Tone (Maia Mechanics' Sun/Earth and Nodes upDown mapping):
// https://app.maiamechanics.com/js/app.0c2c7395.js
const VARIABLES: { id: string; source: 'design' | 'personality'; position: 'top' | 'bottom'; label: string; planets: string[] }[] = [
  { id: 'determination', source: 'design', position: 'top', label: 'Детерминация', planets: ['sun', 'earth'] },
  { id: 'environment', source: 'design', position: 'bottom', label: 'Среда', planets: ['north_node', 'south_node'] },
  { id: 'awareness', source: 'personality', position: 'top', label: 'Осознанность', planets: ['sun', 'earth'] },
  { id: 'perspective', source: 'personality', position: 'bottom', label: 'Перспектива', planets: ['north_node', 'south_node'] },
];

function savedSubstructure(entry: Activation | null | undefined) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !Number.isFinite(entry.longitude) || entry.longitude < 0 || entry.longitude >= 360) return null;
  const { color, tone } = activationSubstructure(entry) || {};
  return [color, tone].every(value => Number.isInteger(value) && value! >= 1 && value! <= 6)
    ? { color: color!, tone: tone! } : null;
}

// Require all eight relevant saved activations before displaying any arrows.
// A missing, duplicated or inconsistent pair has no unambiguous shared Color/Tone.
// This reads the existing calculation; it never infers missing planets or
// recalculates their positions, and manual/transit charts have no natal Variable.
export function calculateVariables(chart: ChartInput | null | undefined) {
  if (chart?.source !== 'calculated') return [];
  const result = [];
  for (const { planets, ...variable } of VARIABLES) {
    const entries = chart.activations?.[variable.source];
    if (!Array.isArray(entries)) return [];
    const substructures = [];
    for (const planet of planets) {
      const matches = entries.filter(entry => entry?.planet === planet);
      if (matches.length !== 1) return [];
      const substructure = savedSubstructure(matches[0]);
      if (substructure === null) return [];
      substructures.push(substructure);
    }
    const { color, tone } = substructures[0];
    if (color !== substructures[1].color || tone !== substructures[1].tone) return [];
    result.push({ ...variable, color, colorDirection: color <= 3 ? 'down' as const : 'up' as const,
      tone, direction: tone <= 3 ? 'left' as const : 'right' as const });
  }
  return result;
}
