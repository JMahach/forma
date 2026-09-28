import path from 'node:path';
import { spawn } from 'node:child_process';

// Own the JSON process lifetime; services keep admission, limits and feature errors.
export function runJsonWorker({ root, script, input, validate = value => value, unavailable, timeoutError,
  timeoutMs, maxOutput, outputUnit = 'bytes', spawnWorker = spawn }) {
  return new Promise((resolve, reject) => {
    let worker, serialized;
    try {
      serialized = JSON.stringify(input);
      worker = spawnWorker(path.join(root, '.venv/bin/python'), [path.join(root, 'server/python', script)],
        { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { reject(unavailable()); return; }
    let output = '', size = 0, failure = null, settled = false, launched = Boolean(worker.pid);
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    // Killing is only a request. Keep the service's slot until stdio and process close.
    const stop = error => {
      if (settled || failure) return;
      failure = error;
      try { worker.kill('SIGKILL'); } catch { /* The close event still owns completion. */ }
    };
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
  });
}
