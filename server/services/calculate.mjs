import { runCalculator } from '../runtime/calculator-process.mjs';

export const CALCULATOR_LIMITS = Object.freeze({ concurrency: 4, timeoutMs: 15000, outputCharacters: 100000 });

// Preserve scalar calculation's four-slot admission independently of day queues.
export function createCalculator({ root, limits = CALCULATOR_LIMITS, spawnWorker }) {
  let runningCalculations = 0;
  return async function calculate(input) {
    if (runningCalculations >= limits.concurrency) return { error: 'busy', message: 'Подождите завершения текущего расчёта и повторите попытку.' };
    runningCalculations += 1;
    try { return await runCalculator({ root, input, limits, spawnWorker }); }
    finally { runningCalculations -= 1; }
  };
}
