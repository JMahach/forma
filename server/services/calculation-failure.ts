import type { JsonWorkerFailure } from '../runtime/json-worker.ts';

export interface CalculationFailureFact {
  event: 'calculation_failed'; component: 'calculator' | 'transit_day' | 'natal_day' | 'cycles';
  reason: JsonWorkerFailure; occurredAt: number;
}
export type CalculationFailureReport = (fact: CalculationFailureFact) => unknown;

/** Only controlled facts leave the source; diagnostic failure never changes the calculation. */
export function createCalculationFailureReporter(component: CalculationFailureFact['component'], report?: CalculationFailureReport) {
  return (reason: JsonWorkerFailure) => {
    if (!report) return;
    try { void Promise.resolve(report({event: 'calculation_failed', component, reason, occurredAt: Date.now()})).catch(() => {}); }
    catch { /* Reporting is independent of the calculation result. */ }
  };
}
