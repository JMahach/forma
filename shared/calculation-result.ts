import { validateChartSide } from './chart-activations.ts';

/** Shared chart payload shape. Consumers separately check requested source, date and metadata. */
export function validChartCalculationResult(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const chart = (value as {chart?: unknown}).chart;
  if (!chart || typeof chart !== 'object' || Array.isArray(chart)) return false;
  const record = chart as Record<string, unknown>, activations = record.activations;
  if (!activations || typeof activations !== 'object' || Array.isArray(activations)) return false;
  const sides = activations as Record<string, unknown>;
  return validateChartSide(record.personality, sides.personality) === null
    && validateChartSide(record.design, sides.design) === null;
}
