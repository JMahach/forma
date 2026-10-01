import path from 'node:path';
import { spawn } from 'node:child_process';
import { runJsonWorker } from './json-worker.mjs';

// Slots count actual processes, including idle or terminating Design workers.
// A scalar request may retire an idle session, but cannot spawn until it closes.
export function createCalculatorWorkers({ root, capacity, timeoutMs, maxOutput, idleMs = 30_000,
  spawnWorker = spawn, unavailable, timeoutError, busy }) {
  const slots = new Set();
  let accepting = true, closing = null, nextId = 0;
  const protocolOutput = Math.min(maxOutput, 8192), protocolInput = 512;

  function stop(slot, error = unavailable()) {
    if (slot.stopping || !slot.worker) return;
    slot.stopping = true;
    clearTimeout(slot.idleTimer);
    if (slot.job) { clearTimeout(slot.job.timer); slot.job.failure = error; }
    try { slot.worker.kill('SIGKILL'); } catch { /* Only close releases a live process slot. */ }
  }

  function start(slot) {
    let worker, launched = false, closed = false;
    slot.closed = new Promise(resolve => { slot.didClose = resolve; });
    const finish = () => {
      if (closed) return;
      closed = true; clearTimeout(slot.idleTimer);
      slot.worker = null;
      if (slot.job) {
        const job = slot.job; slot.job = null; clearTimeout(job.timer);
        job.reject(job.failure || unavailable());
      }
      slot.didClose();
      if (!slot.busy) slots.delete(slot);
    };
    try {
      worker = spawnWorker(path.join(root, '.venv/bin/python'), [path.join(root, 'server/python/design_worker.py')],
        { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { finish(); return; }
    slot.worker = worker; launched = Boolean(worker.pid);
    worker.once('spawn', () => { launched = true; });
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', chunk => {
      if (slot.stopping) return;
      if (!slot.job) { stop(slot); return; }
      if (Buffer.byteLength(slot.output) + Buffer.byteLength(chunk) > protocolOutput) { stop(slot); return; }
      slot.output += chunk;
      const newline = slot.output.indexOf('\n');
      if (newline < 0) return;
      // Exactly one bounded line belongs to the current request, with no tail.
      if (newline !== slot.output.length - 1) { stop(slot); return; }
      let response;
      try { response = JSON.parse(slot.output.slice(0, newline)); } catch { stop(slot); return; }
      const job = slot.job, value = response?.result;
      const validError = value && typeof value.error === 'string' && typeof value.message === 'string';
      const validPoint = value?.utc === job.utc && typeof value.designUtc === 'string' && Number.isFinite(Date.parse(value.designUtc))
        && Number.isFinite(value.designArcResidualDegrees) && Array.isArray(value.longitudes)
        && value.longitudes.length === 11 && value.longitudes.every(Number.isFinite);
      if (!response || Object.keys(response).length !== 2 || response.id !== job.id || (!validError && !validPoint)) { stop(slot); return; }
      clearTimeout(job.timer); slot.job = null; slot.output = '';
      job.resolve(value);
    });
    worker.stdout.on('error', () => stop(slot));
    worker.stdin.on('error', () => stop(slot));
    worker.on('error', () => {
      if (closed) return;
      if (launched || worker.pid) stop(slot);
      else finish(); // Failed spawn has no process to wait for.
    });
    worker.once('close', finish);
  }

  function design(slot, utc) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      let line;
      try {
        if (typeof utc !== 'string' || utc.length > 64 || !Number.isSafeInteger(id)) throw unavailable();
        line = JSON.stringify({ id, utc }) + '\n';
        if (Buffer.byteLength(line) > protocolInput) throw unavailable();
      } catch { reject(unavailable()); return; }
      slot.output = '';
      slot.job = { id, utc, resolve, reject, failure: null, timer: null };
      if (!slot.worker) start(slot);
      if (!slot.worker || !slot.job) return;
      slot.job.timer = setTimeout(() => stop(slot, timeoutError()), timeoutMs);
      try { slot.worker.stdin.write(line); } catch { stop(slot); }
    }).finally(() => {
      slot.busy = false;
      if (!slot.worker || slot.stopping || !accepting) {
        if (!slot.worker) slots.delete(slot);
        else stop(slot);
      } else {
        slot.idleTimer = setTimeout(() => stop(slot), idleMs);
        slot.idleTimer.unref?.();
      }
    });
  }

  async function scalar(slot, input) {
    try {
      if (slot.worker) { stop(slot); await slot.closed; }
      if (!accepting) throw unavailable();
      return await runJsonWorker({ root, script: 'calculator.py', input, spawnWorker,
        timeoutMs, maxOutput, outputUnit: 'characters', unavailable, timeoutError });
    } finally { slots.delete(slot); }
  }

  return {
    run(input) {
      if (!accepting) return Promise.reject(unavailable());
      const isDesign = input?.mode === 'transit_design';
      let slot = isDesign ? [...slots].find(value => !value.busy && !value.stopping) : null;
      if (!slot && slots.size < capacity) { slot = { busy: false, worker: null, job: null, stopping: false }; slots.add(slot); }
      if (!slot) slot = [...slots].find(value => !value.busy && !value.stopping);
      if (!slot) return Promise.reject(busy());
      slot.busy = true; clearTimeout(slot.idleTimer);
      slot.task = isDesign ? design(slot, input.utc) : scalar(slot, input);
      return slot.task;
    },
    close() {
      if (!closing) {
        accepting = false;
        const current = [...slots];
        current.forEach(slot => stop(slot));
        closing = Promise.allSettled(current.flatMap(slot => [slot.task, slot.closed].filter(Boolean))).then(() => {});
      }
      return closing;
    },
  };
}
