import { validChartCalculationResult } from '../../shared/calculation-result.ts';
import { createCalculationFailureReporter, type CalculationFailureReport } from './calculation-failure.ts';
import type { CalculationRequest, CalculationError, ChartRecord } from '../../shared/chart-types.ts';
import type { NumericMoment, DesignMoment } from '../../shared/day-packets/moment-columns.ts';
import type { ComputeQueue } from '../runtime/compute-queue.ts';
import type { JsonWorkerOptions } from '../runtime/json-worker.ts';

type CalculationResult = (({ chart: ChartRecord } | NumericMoment | DesignMoment) & { error?: never }) | CalculationError;
interface CalculatorOptions {
  root: string;
  report?: CalculationFailureReport;
  limits?: { concurrency: number; timeoutMs: number; outputCharacters: number };
  spawnWorker?: JsonWorkerOptions['spawnWorker'];
  computeQueue?: ComputeQueue;
}
export type Calculator = ReturnType<typeof createCalculator>;

import { createCalculatorWorkers } from '../runtime/calculator-workers.ts';

export const CALCULATOR_LIMITS = Object.freeze({ concurrency: 4, timeoutMs: 15000, outputCharacters: 100000 });

// Scalar results use the same physical process budget as days and cycles.
export function createCalculator({ root, limits = CALCULATOR_LIMITS, spawnWorker, computeQueue, report }: CalculatorOptions) {
  const failure = createCalculationFailureReporter('calculator', report);
  const workers = createCalculatorWorkers({ root, capacity: limits.concurrency, timeoutMs: limits.timeoutMs,
    maxOutput: limits.outputCharacters, spawnWorker, computeQueue, onFailure: failure,
    busy: () => ({ error: 'busy', message: 'Подождите завершения текущего расчёта и повторите попытку.' }),
    unavailable: () => ({ error: 'engine_unavailable', message: 'Локальный движок расчёта недоступен. Проверьте установку зависимостей.' }),
    timeoutError: () => ({ error: 'timeout', message: 'Расчёт занял слишком много времени. Попробуйте ещё раз.' }),
  });
  const calculate = (input: CalculationRequest, options?: { signal?: AbortSignal }): Promise<CalculationResult> => workers.run(input, options).then(value => {
    // Transport rejections are already reported by the physical worker.
    if (options?.signal?.aborted) return value;
    if (value && typeof value === 'object' && 'error' in value && value.error) {
      if (value.error === 'calculation_failed' || value.error === 'design_search_failed') failure('invalid_result');
      else if (value.error === 'engine_unavailable') failure('process');
    } else if ((input.mode === undefined || input.mode === 'natal' || input.mode === 'transit') && !validChartCalculationResult(value)) {
      failure('invalid_result');
      return { error: 'calculation_failed', message: 'Не удалось выполнить расчёт. Проверьте исходные данные и локальные файлы эфемерид.' };
    }
    return value;
  }).catch((error: unknown) => error) as Promise<CalculationResult>;
  calculate.close = workers.close;
  return calculate;
}
