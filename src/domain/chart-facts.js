import { primaryChart, chartTopology, isChartOverlay } from './chart-composition.js';
import { CENTERS, GATES, getDefinition } from './topology.js';

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

function lineFacts(rows) {
  return Array.from({ length: 6 }, (_, index) => {
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
  });
}

export function chartLineGates(chart, line, source) {
  if (!validLine(line) || !['design', 'personality', 'all'].includes(source)) return [];
  const primary = primaryChart(chart && typeof chart === 'object' ? chart : {});
  if (primary.source === 'manual') return [];
  const sources = source === 'all' ? ['design', 'personality'] : [source];
  return sortedUnique(sources.flatMap(side => savedRows(primary, side, activeGateSet(primary[side])))
    .filter(entry => entry.line === line).map(entry => entry.gate));
}

// Read only saved facts: topology comes from the same gate sets as the diagram.
// A line count counts planetary activations, while selection targets are unique
// gates. In particular, two planets in the same gate still count as two rows.
export function buildChartFacts(chart = {}) {
  chart = chart && typeof chart === 'object' ? chart : {};
  const rowsChart = primaryChart(chart);
  const topology = chartTopology(chart);
  const isTransit = rowsChart.source === 'transit';
  const design = activeGateSet(topology.design);
  const personality = activeGateSet(topology.personality);
  const rowDesign = activeGateSet(rowsChart.design);
  const rowPersonality = activeGateSet(rowsChart.personality);
  const active = new Set([...design, ...personality]);
  const rows = {
    design: savedRows(rowsChart, 'design', rowDesign),
    personality: savedRows(rowsChart, 'personality', rowPersonality),
  };
  const allRows = [...rows.design, ...rows.personality];
  const hasLines = allRows.length > 0;
  const definition = getDefinition({ design: [...design], personality: [...personality] });
  const designSun = sunLine(rowsChart, 'design', rowDesign);
  const personalitySun = sunLine(rowsChart, 'personality', rowPersonality);

  return {
    isTransit,
    scope: isChartOverlay(chart) ? 'overlay' : 'single',
    rowsLabel: isChartOverlay(chart) ? rowsChart.name?.trim() || 'Личная карта' : null,
    hasLines,
    profile: rowsChart.source === 'calculated' && designSun && personalitySun
      ? `${personalitySun}/${designSun}` : null,
    totals: {
      gates: active.size,
      channels: definition.channels.length,
      centers: definition.centers.size,
      activations: hasLines ? allRows.length : null,
    },
    lines: lineFacts(rows),
    centers: CENTERS.map(({ id }) => ({
      id, defined: definition.centers.has(id),
      activeGates: GATES.filter(gate => gate.center === id && active.has(gate.id)).map(gate => gate.id),
    })),
    channels: definition.channels.map(({ id, gates }) => ({ id, gates: [...gates] })),
    gates: GATES.filter(gate => active.has(gate.id)).map(({ id }) => ({
      id, design: design.has(id), personality: personality.has(id),
      activationCount: hasLines ? allRows.filter(entry => entry.gate === id).length : null,
    })),
  };
}
