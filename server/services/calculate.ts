import type { CalculationRequest, CalculationError, ChartRecord } from '../../shared/chart-types.ts';
import type { NumericMoment, DesignMoment } from '../../shared/day-packets/moment-columns.ts';
import type { ComputeQueue } from '../runtime/compute-queue.ts';
import type { JsonWorkerOptions } from '../runtime/json-worker.ts';

type CalculationResult = (({ chart: ChartRecord } | NumericMoment | DesignMoment) & { error?: never }) | CalculationError;
interface CalculatorOptions {
  root: string;
  limits?: { concurrency: number; timeoutMs: number; outputCharacters: number };
  spawnWorker?: JsonWorkerOptions['spawnWorker'];
  computeQueue?: ComputeQueue;
}
export type Calculator = ReturnType<typeof createCalculator>;

import { createCalculatorWorkers } from '../runtime/calculator-workers.ts';

export const CALCULATOR_LIMITS = Object.freeze({ concurrency: 4, timeoutMs: 15000, outputCharacters: 100000 });

// Scalar results use the same physical process budget as days and cycles.
export function createCalculator({ root, limits = CALCULATOR_LIMITS, spawnWorker, computeQueue }: CalculatorOptions) {
  const workers = createCalculatorWorkers({ root, capacity: limits.concurrency, timeoutMs: limits.timeoutMs,
    maxOutput: limits.outputCharacters, spawnWorker, computeQueue,
    busy: () => ({ error: 'busy', message: 'Подождите завершения текущего расчёта и повторите попытку.' }),
    unavailable: () => ({ error: 'engine_unavailable', message: 'Локальный движок расчёта недоступен. Проверьте установку зависимостей.' }),
    timeoutError: () => ({ error: 'timeout', message: 'Расчёт занял слишком много времени. Попробуйте ещё раз.' }),
  });
  const calculate = (input: CalculationRequest, options?: { signal?: AbortSignal }): Promise<CalculationResult> => workers.run(input, options).catch((error: unknown) => error) as Promise<CalculationResult>;
  calculate.close = workers.close;
  return calculate;
}
