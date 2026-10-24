import type { ComputeQueue, QueueOptions } from './compute-queue.ts';

export interface JsonWorkerOptions {
  root: string;
  script: string;
  input: unknown;
  validate?: (value: unknown) => unknown;
  unavailable: () => unknown;
  timeoutError: () => unknown;
  timeoutMs: number;
  maxOutput: number;
  outputUnit?: 'bytes' | 'characters';
  spawnWorker?: typeof spawn;
  computeQueue?: ComputeQueue | null;
  signal?: AbortSignal;
  priority?: QueueOptions['priority'];
}

import path from 'node:path';
import { spawn } from 'node:child_process';
import { pythonExecutable, pythonEnvironment } from './python.ts';

// Own physical process lifetime. The shared queue admits work; services own results.
export function runJsonWorker<T>(options: JsonWorkerOptions & { validate: (value: unknown) => T }): Promise<T>;
export function runJsonWorker(options: JsonWorkerOptions): Promise<unknown>;
export function runJsonWorker({ root, script, input, validate = value => value, unavailable, timeoutError,
  timeoutMs, maxOutput, outputUnit = 'bytes', spawnWorker = spawn, computeQueue = null, signal, priority = 0 }: JsonWorkerOptions): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(new DOMException('Запрос отменён.', 'AbortError'));
  if (computeQueue) return computeQueue.run(() => runJsonWorker({ root, script, input, validate, unavailable, timeoutError,
    timeoutMs, maxOutput, outputUnit, spawnWorker, signal }), { signal, priority });
  return new Promise<unknown>((resolve, reject) => {
    let worker, serialized;
    try {
      serialized = JSON.stringify(input);
      worker = spawnWorker(pythonExecutable(root), [path.join(root, 'server/python', script)],
        { cwd: root, stdio: ['pipe', 'pipe', 'ignore'], env: pythonEnvironment() });
    } catch { reject(unavailable()); return; }
    let output = '', size = 0, failure: unknown = null, settled = false, launched = Boolean(worker.pid);
    const finish = (error: unknown, value?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(value);
    };
    // Killing is only a request. Keep the service's slot until stdio and process close.
    const stop = (error: unknown) => {
      if (settled || failure) return;
      failure = error;
      try { worker.kill('SIGKILL'); } catch { /* The close event still owns completion. */ }
    };
    const cancel = () => stop(new DOMException('Запрос отменён.', 'AbortError'));
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => stop(timeoutError()), timeoutMs);
    worker.once('spawn', () => { launched = true; });
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', chunk => {
      if (settled || failure) return;
      size += outputUnit === 'characters' ? chunk.length : Buffer.byteLength(chunk);
      if (size > maxOutput) stop(unavailable()); else output += chunk;
    });
    worker.stdout.on('error', () => stop(unavailable()));
    worker.stdin.on('error', () => stop(unavailable()));
    worker.on('error', () => {
      if (settled) return;
      // Failed spawn has no live process. Later errors must not release a live slot.
      if (launched || worker.pid) stop(unavailable()); else finish(unavailable());
    });
    worker.on('close', code => {
      if (settled) return;
      if (failure || code !== 0) { finish(failure || unavailable()); return; }
      let result;
      try { result = JSON.parse(output); } catch { finish(unavailable()); return; }
      try { finish(null, validate(result)); } catch (error) { finish(error); }
    });
    try { worker.stdin.end(serialized); } catch { stop(unavailable()); }
    if (signal?.aborted) cancel();
  });
}
