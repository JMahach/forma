import { createCalculatorWorkers } from '../runtime/calculator-workers.mjs';

export const CALCULATOR_LIMITS = Object.freeze({ concurrency: 4, timeoutMs: 15000, outputCharacters: 100000 });

// Scalar results use the same physical process budget as days and cycles.
export function createCalculator({ root, limits = CALCULATOR_LIMITS, spawnWorker, computeQueue }) {
  const workers = createCalculatorWorkers({ root, capacity: limits.concurrency, timeoutMs: limits.timeoutMs,
    maxOutput: limits.outputCharacters, spawnWorker, computeQueue,
    busy: () => ({ error: 'busy', message: 'Подождите завершения текущего расчёта и повторите попытку.' }),
    unavailable: () => ({ error: 'engine_unavailable', message: 'Локальный движок расчёта недоступен. Проверьте установку зависимостей.' }),
    timeoutError: () => ({ error: 'timeout', message: 'Расчёт занял слишком много времени. Попробуйте ещё раз.' }),
  });
  const calculate = (input, options) => workers.run(input, options).catch(error => error);
  calculate.close = workers.close;
  return calculate;
}
