import path from 'node:path';
import { spawn } from 'node:child_process';

export const CALCULATOR_LIMITS = Object.freeze({ concurrency: 4, timeoutMs: 15000, outputCharacters: 100000 });

// A fresh Python process per calculation. The closure owns the shared limit;
// callers receive only JSON results, never worker handles or birth-data logs.
export function createCalculator({ root, limits = CALCULATOR_LIMITS, spawnWorker = spawn }) {
  let runningCalculations = 0;
  return async function calculate(input) {
    if (runningCalculations >= limits.concurrency) return { error: 'busy', message: 'Подождите завершения текущего расчёта и повторите попытку.' };
    runningCalculations += 1;
    try {
      return await new Promise(resolve => {
        const worker = spawnWorker(path.join(root, '.venv/bin/python'), [path.join(root, 'server/calculator.py')], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
        let output = '', settled = false;
        const finish = value => { if (settled) return; settled = true; clearTimeout(timeout); resolve(value); };
        const unavailable = { error: 'engine_unavailable', message: 'Локальный движок расчёта недоступен. Проверьте установку зависимостей.' };
        const timeout = setTimeout(() => { worker.kill(); finish({ error: 'timeout', message: 'Расчёт занял слишком много времени. Попробуйте ещё раз.' }); }, limits.timeoutMs);
        worker.stdout.setEncoding('utf8');
        worker.stdout.on('data', chunk => { output += chunk; if (output.length > limits.outputCharacters) { worker.kill(); finish(unavailable); } });
        worker.on('error', () => finish(unavailable));
        worker.stdin.on('error', () => finish(unavailable));
        worker.on('close', code => {
          if (code !== 0) { finish(unavailable); return; }
          try { finish(JSON.parse(output)); } catch { finish(unavailable); }
        });
        worker.stdin.end(JSON.stringify(input));
      });
    } finally { runningCalculations -= 1; }
  };
}
