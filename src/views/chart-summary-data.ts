import type { ChartView } from '../domain/chart-composition.ts';
export type ChartSummary = ReturnType<typeof buildChartSummary>;
import { buildChartFacts } from '../domain/chart-facts.ts';
import { getCenter, getChannel, getGate } from '../reference/catalog.ts';

export function buildChartSummary(chart: ChartView) {
  const facts = buildChartFacts(chart);
  return { ...facts,
    centers: facts.centers.map(item => ({ ...item, name: getCenter(item.id)!.name })),
    channels: facts.channels.map(item => ({ ...item, name: getChannel(item.id)!.name })),
    gates: facts.gates.map(item => ({ ...item, name: getGate(item.id)!.name })),
  };
}
