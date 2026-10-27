// The complete chart protocol set, independent of presentation order or labels.
const PLANETS = new Set(['sun', 'earth', 'moon', 'north_node', 'south_node', 'mercury', 'venus',
  'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto']);

/** Checks details first, then their gate set; callers own legacy size policy and error wording. */
export function validateChartSide(gates: unknown, entries: unknown, expectedCount: 13 | 0 = 13): 'activations' | 'gates' | null {
  if (!Array.isArray(entries) || entries.length !== expectedCount) return 'activations';
  const planets = new Set<string>(), expectedGates = new Set<number>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'activations';
    const {planet, longitude, gate, line} = entry as Record<string, unknown>;
    if (typeof planet !== 'string' || !PLANETS.has(planet) || planets.has(planet)
      || typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < 0 || longitude >= 360
      || typeof gate !== 'number' || !Number.isInteger(gate) || gate < 1 || gate > 64
      || typeof line !== 'number' || !Number.isInteger(line) || line < 1 || line > 6) return 'activations';
    planets.add(planet); expectedGates.add(gate);
  }
  if (!Array.isArray(gates) || gates.length !== expectedGates.size) return 'gates';
  for (const gate of gates) {
    if (typeof gate !== 'number' || !expectedGates.delete(gate)) return 'gates';
  }
  return null;
}
