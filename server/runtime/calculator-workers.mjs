import { spawn } from 'node:child_process';
import { createComputeQueue } from './compute-queue.mjs';
import { runJsonWorker } from './json-worker.mjs';

// One scalar request owns each process slot until the process and stdio close.
export function createCalculatorWorkers({ root, capacity, timeoutMs, maxOutput,
  spawnWorker = spawn, unavailable, timeoutError, busy, computeQueue = createComputeQueue({ concurrency: capacity, maxQueued: 0 }) }) {
  const active = new Set();
  let accepting = true, closing = null;
  return {
    run(input, { signal } = {}) {
      if (!accepting) return Promise.reject(unavailable());
      // Preserve the bounded shape of the externally reachable Design request.
      if (input?.mode === 'transit_design' && (typeof input.utc !== 'string' || input.utc.length > 64)) return Promise.reject(unavailable());
      const job = { task: null, controller: new AbortController() };
      const cancel = () => job.controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      active.add(job);
      job.task = runJsonWorker({ root, script: 'calculator.py', input, timeoutMs, maxOutput,
        outputUnit: 'characters', unavailable, timeoutError, computeQueue, signal: job.controller.signal,
        spawnWorker,
      }).catch(error => { throw !accepting ? unavailable() : error?.code === 'busy' ? busy() : error; }).finally(() => { signal?.removeEventListener('abort', cancel); active.delete(job); });
      return job.task;
    },
    close() {
      if (!closing) {
        accepting = false;
        const jobs = [...active];
        for (const job of jobs) job.controller.abort();
        closing = Promise.allSettled(jobs.map(job => job.task)).then(() => {});
      }
      return closing;
    },
  };
}
