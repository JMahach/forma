import { activationDetails } from './activation-details.js';

// Variable uses Tone from four Sun/Earth and nodal pairs, not Gate or Color.
// https://jovianarchive.com/blogs/deeper-mechanics-system-theory/variable-the-blueprint-of-brain-body-and-mind
// https://www.mybodygraph.com/blog/what-is-variable-in-human-design-understanding-the-arrows-in-your-chart
// Tone 1–3 is Left; Tone 4–6 is Right:
// https://jovianarchive.com/pages/the-basics-of-substructure-in-human-design
// Advanced Imaging additionally displays Color 1–3 down and 4–6 up,
// independently of Tone (Maia Mechanics' Sun/Earth and Nodes upDown mapping):
// https://app.maiamechanics.com/js/app.0c2c7395.js
const VARIABLES = [
  { id: 'determination', source: 'design', position: 'top', label: 'Детерминация', planets: ['sun', 'earth'] },
  { id: 'environment', source: 'design', position: 'bottom', label: 'Среда', planets: ['north_node', 'south_node'] },
  { id: 'awareness', source: 'personality', position: 'top', label: 'Осознанность', planets: ['sun', 'earth'] },
  { id: 'perspective', source: 'personality', position: 'bottom', label: 'Перспектива', planets: ['north_node', 'south_node'] },
];

function savedSubstructure(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !Number.isFinite(entry.longitude) || entry.longitude < 0 || entry.longitude >= 360) return null;
  const details = activationDetails(entry);
  const color = details?.find(row => row.key === 'color')?.value;
  const tone = details?.find(row => row.key === 'tone')?.value;
  return [color, tone].every(value => Number.isInteger(value) && value >= 1 && value <= 6)
    ? { color, tone } : null;
}

// Require all eight relevant saved activations before displaying any arrows.
// A missing, duplicated or inconsistent pair has no unambiguous shared Color/Tone.
// This reads the existing calculation; it never infers missing planets or
// recalculates their positions, and manual/transit charts have no natal Variable.
export function calculateVariables(chart) {
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
    result.push({ ...variable, color, colorDirection: color <= 3 ? 'down' : 'up',
      tone, direction: tone <= 3 ? 'left' : 'right' });
  }
  return result;
}
