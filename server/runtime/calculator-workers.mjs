import { spawn } from 'node:child_process';
import { runJsonWorker } from './json-worker.mjs';

// One scalar request owns each process slot until the process and stdio close.
export function createCalculatorWorkers({ root, capacity, timeoutMs, maxOutput,
  spawnWorker = spawn, unavailable, timeoutError, busy }) {
  const active = new Set();
  let accepting = true, closing = null;
  return {
    run(input) {
      if (!accepting) return Promise.reject(unavailable());
      // Preserve the bounded shape of the externally reachable Design request.
      if (input?.mode === 'transit_design' && (typeof input.utc !== 'string' || input.utc.length > 64)) return Promise.reject(unavailable());
      if (active.size >= capacity) return Promise.reject(busy());
      const job = { worker: null, task: null };
      active.add(job);
      job.task = runJsonWorker({ root, script: 'calculator.py', input, timeoutMs, maxOutput,
        outputUnit: 'characters', unavailable, timeoutError,
        spawnWorker(...args) { job.worker = spawnWorker(...args); return job.worker; },
      }).finally(() => active.delete(job));
      return job.task;
    },
    close() {
      if (!closing) {
        accepting = false;
        const jobs = [...active];
        for (const { worker } of jobs) {
          try { worker?.kill('SIGKILL'); } catch { /* Completion still waits for close. */ }
        }
        closing = Promise.allSettled(jobs.map(job => job.task)).then(() => {});
      }
      return closing;
    },
  };
}
