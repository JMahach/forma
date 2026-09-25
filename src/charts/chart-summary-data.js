import { CENTERS, GATES, getDefinition } from '../bodygraph/graph-data.js';

const gateIds = new Set(GATES.map(gate => gate.id));
const sortedUnique = values => [...new Set(values)].sort((a, b) => a - b);
const validLine = value => Number.isInteger(value) && value >= 1 && value <= 6;

function activeGateSet(values) {
  return new Set(Array.isArray(values) ? values.filter(value => gateIds.has(value)) : []);
}

function savedRows(chart, source, active) {
  const entries = chart.activations?.[source];
  if (chart.source === 'manual' || !Array.isArray(entries)) return [];
  return entries.filter(entry => entry && active.has(entry.gate) && validLine(entry.line));
}

function sunLine(chart, source, active) {
  const entries = chart.activations?.[source];
  if (!Array.isArray(entries)) return null;
  const matches = entries.filter(entry => entry?.planet === 'sun');
  if (matches.length !== 1 || !active.has(matches[0].gate) || !validLine(matches[0].line)) return null;
  return matches[0].line;
}

// Read only saved facts: topology comes from the same gate sets as the diagram.
// A line count counts planetary activations, while selection targets are unique
// gates. In particular, two planets in the same gate still count as two rows.
export function buildChartSummary(chart = {}) {
  chart = chart && typeof chart === 'object' ? chart : {};
  const isTransit = chart.source === 'transit';
  const design = activeGateSet(chart.design);
  const personality = activeGateSet(chart.personality);
  const active = new Set([...design, ...personality]);
  const rows = {
    design: savedRows(chart, 'design', design),
    personality: savedRows(chart, 'personality', personality),
  };
  const allRows = [...rows.design, ...rows.personality];
  const hasLines = allRows.length > 0;
  const definition = getDefinition({ design: [...design], personality: [...personality] });
  const designSun = sunLine(chart, 'design', design);
  const personalitySun = sunLine(chart, 'personality', personality);

  return {
    isTransit,
    hasLines,
    profile: chart.source === 'calculated' && designSun && personalitySun
      ? `${personalitySun}/${designSun}` : null,
    totals: {
      gates: active.size,
      channels: definition.channels.length,
      centers: definition.centers.size,
      activations: hasLines ? allRows.length : null,
    },
    lines: Array.from({ length: 6 }, (_, index) => {
      const line = index + 1;
      const designRows = rows.design.filter(entry => entry.line === line);
      const personalityRows = rows.personality.filter(entry => entry.line === line);
      return {
        line,
        design: designRows.length,
        personality: personalityRows.length,
        total: designRows.length + personalityRows.length,
        gates: {
          design: sortedUnique(designRows.map(entry => entry.gate)),
          personality: sortedUnique(personalityRows.map(entry => entry.gate)),
          all: sortedUnique([...designRows, ...personalityRows].map(entry => entry.gate)),
        },
      };
    }),
    centers: CENTERS.map(({ id, name }) => ({
      id, name, defined: definition.centers.has(id),
      activeGates: GATES.filter(gate => gate.center === id && active.has(gate.id)).map(gate => gate.id),
    })),
    channels: definition.channels.map(({ id, name, gates }) => ({ id, name, gates: [...gates] })),
    gates: GATES.filter(gate => active.has(gate.id)).map(({ id, name }) => ({
      id, name, design: design.has(id), personality: personality.has(id),
      activationCount: hasLines ? allRows.filter(entry => entry.gate === id).length : null,
    })),
  };
}
