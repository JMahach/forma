import { createCalculatorWorkers } from '../runtime/calculator-workers.mjs';

export const CALCULATOR_LIMITS = Object.freeze({ concurrency: 4, timeoutMs: 15000, outputCharacters: 100000 });

// One physical four-process budget serves scalar cards and reusable Design sessions.
// Day queues keep their existing independent admission.
export function createCalculator({ root, limits = CALCULATOR_LIMITS, spawnWorker, idleMs = 30_000 }) {
  const workers = createCalculatorWorkers({ root, capacity: limits.concurrency, timeoutMs: limits.timeoutMs,
    maxOutput: limits.outputCharacters, spawnWorker, idleMs,
    busy: () => ({ error: 'busy', message: 'Подождите завершения текущего расчёта и повторите попытку.' }),
    unavailable: () => ({ error: 'engine_unavailable', message: 'Локальный движок расчёта недоступен. Проверьте установку зависимостей.' }),
    timeoutError: () => ({ error: 'timeout', message: 'Расчёт занял слишком много времени. Попробуйте ещё раз.' }),
  });
  const calculate = input => workers.run(input).catch(error => error);
  calculate.close = workers.close;
  return calculate;
}
