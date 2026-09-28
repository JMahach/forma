import { runJsonWorker } from '../runtime/json-worker.mjs';

export const CALCULATOR_LIMITS = Object.freeze({ concurrency: 4, timeoutMs: 15000, outputCharacters: 100000 });

// Preserve scalar calculation's four-slot admission independently of day queues.
export function createCalculator({ root, limits = CALCULATOR_LIMITS, spawnWorker }) {
  let runningCalculations = 0;
  return async function calculate(input) {
    if (runningCalculations >= limits.concurrency) return { error: 'busy', message: 'Подождите завершения текущего расчёта и повторите попытку.' };
    runningCalculations += 1;
    try {
      return await runJsonWorker({ root, script: 'calculator.py', input, spawnWorker,
        timeoutMs: limits.timeoutMs, maxOutput: limits.outputCharacters, outputUnit: 'characters',
        unavailable: () => ({ error: 'engine_unavailable', message: 'Локальный движок расчёта недоступен. Проверьте установку зависимостей.' }),
        timeoutError: () => ({ error: 'timeout', message: 'Расчёт занял слишком много времени. Попробуйте ещё раз.' }),
      });
    } catch (error) { return error; }
    finally { runningCalculations -= 1; }
  };
}
