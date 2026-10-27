import { Worker } from 'node:worker_threads';
import { MAIL_BUFFER_LIMITS, type MailBufferedResult, type openMailBuffer } from './mail-buffer.ts';
import { parseJournalEvent, type JournalEvent } from './events.ts';
import { canonicalJSON } from './policy.ts';

export type MailBufferUsage = ReturnType<ReturnType<typeof openMailBuffer>['usage']>;
export interface MailBufferRequest {
  id: number; method: 'stage' | 'batch' | 'acknowledge' | 'maintain' | 'usage'; now: number; payload?: string;
}
interface Pending { request: MailBufferRequest; bytes: number; finish: (value: unknown) => void; fallback: unknown }
const maxCommands = 32, maxInputBytes = 64 * 1024;

/** A single worker owns synchronous SQLite/fsync. Its bounded FIFO shares the existing 3 MiB own-data reserve. */
export function createMailBufferClient({filename, now = Date.now}: {filename: string; now?: () => number}) {
  const pending: Pending[] = [];
  let worker: Worker | undefined, ready = false, failed = false, active: Pending | undefined;
  let nextId = 0, bytes = 0, closing: Promise<void> | undefined;
  function fail() {
    failed = true; ready = false;
    if (active) { active.finish(active.fallback); active = undefined; }
    for (const item of pending.splice(0)) item.finish(item.fallback);
    bytes = 0;
    worker?.unref();
  }
  function pump() {
    if (!worker || failed || !ready || active) return;
    active = pending.shift();
    if (!active) { worker.unref(); return; }
    worker.ref();
    try { worker.postMessage(active.request); } catch { fail(); }
  }
  try {
    worker = new Worker(new URL('./mail-buffer-worker.ts', import.meta.url), {
      workerData: {filename, now: now()}, execArgv: [],
    });
    worker.on('message', (message: {ready?: boolean; id?: number; value?: unknown; failed?: boolean}) => {
      if (failed) return;
      if (message.ready) { ready = true; pump(); return; }
      if (!active || message.id !== active.request.id) { fail(); return; }
      const item = active; active = undefined; bytes -= item.bytes;
      item.finish(message.failed ? item.fallback : message.value); pump();
    });
    worker.on('error', fail); worker.on('exit', fail); worker.unref();
  } catch { fail(); }
  function send<T>(method: MailBufferRequest['method'], fallback: T, payload?: string): Promise<T> {
    const size = payload ? Buffer.byteLength(payload) : 0;
    if (failed || pending.length + (active ? 1 : 0) >= maxCommands || bytes + size > maxInputBytes) return Promise.resolve(fallback);
    let time: number;
    try { time = now(); } catch { return Promise.resolve(fallback); }
    if (!Number.isSafeInteger(time) || time < 0 || time > 8.64e15) return Promise.resolve(fallback);
    bytes += size; worker?.ref();
    return new Promise<T>(resolve => {
      pending.push({request: {id: ++nextId, method, now: time, ...(payload !== undefined ? {payload} : {})}, bytes: size,
        finish: value => resolve(value as T), fallback});
      pump();
    });
  }
  function encode(value: JournalEvent) {
    const event = parseJournalEvent(value);
    if (!event) return undefined;
    const payload = canonicalJSON({...event});
    return Buffer.byteLength(payload) <= MAIL_BUFFER_LIMITS.maxEventBytes ? payload : undefined;
  }
  return {
    stage(value: JournalEvent): Promise<MailBufferedResult> {
      if (failed) return Promise.resolve({status: 'retryable'});
      const payload = encode(value);
      return payload === undefined ? Promise.resolve({status: 'invalid'}) : send('stage', {status: 'retryable'} as MailBufferedResult, payload);
    },
    batch(): Promise<JournalEvent[]> { return send('batch', []); },
    acknowledge(value: JournalEvent): Promise<boolean> {
      const payload = encode(value); return payload === undefined ? Promise.resolve(false) : send('acknowledge', false, payload);
    },
    maintain(): Promise<number | null> { return send('maintain', null); },
    usage(): Promise<MailBufferUsage | null> { return send('usage', null); },
    close(): Promise<void> {
      if (!closing) {
        fail();
        // Callers receive failure immediately; close itself proves the worker released its files.
        closing = worker ? worker.terminate().then(() => {}, () => {}) : Promise.resolve();
      }
      return closing;
    },
  };
}
