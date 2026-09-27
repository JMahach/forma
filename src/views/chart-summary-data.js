import { buildChartFacts } from '../domain/chart-facts.js';
import { getCenter, getChannel, getGate } from '../reference/catalog.js';

export function buildChartSummary(chart) {
  const facts = buildChartFacts(chart);
  return { ...facts,
    centers: facts.centers.map(item => ({ ...item, name: getCenter(item.id).name })),
    channels: facts.channels.map(item => ({ ...item, name: getChannel(item.id).name })),
    gates: facts.gates.map(item => ({ ...item, name: getGate(item.id).name })),
  };
}
