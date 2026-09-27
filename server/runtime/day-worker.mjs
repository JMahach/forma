import path from 'node:path';
import { spawn } from 'node:child_process';

// Shared process boundary for batch calculations. Feature modules own their
// payloads and errors; this adapter owns I/O, byte limits and process lifetime.
export function runDayWorker({ root, script, input, validate, unavailable, timeoutError,
  timeoutMs, maxOutputBytes, spawnWorker = spawn }) {
  return new Promise((resolve, reject) => {
    const worker = spawnWorker(path.join(root, '.venv/bin/python'), [path.join(root, 'server/python', script)],
      { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', bytes = 0, failure = null, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    // Do not release the caller's queue until the killed process has closed.
    const stop = error => { if (failure) return; failure = error; worker.kill('SIGKILL'); };
    const timer = setTimeout(() => stop(timeoutError()), timeoutMs);
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', chunk => {
      if (failure) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxOutputBytes) stop(unavailable()); else output += chunk;
    });
    worker.on('error', () => finish(unavailable()));
    worker.stdin.on('error', () => stop(unavailable()));
    worker.on('close', code => {
      if (failure || code !== 0) { finish(failure || unavailable()); return; }
      let day;
      try { day = JSON.parse(output); } catch { finish(unavailable()); return; }
      try { finish(null, validate(day)); } catch (error) { finish(error); }
    });
    worker.stdin.end(JSON.stringify(input));
  });
}
