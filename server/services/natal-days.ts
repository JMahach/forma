import { createCalculationFailureReporter, type CalculationFailureReport } from './calculation-failure.ts';
import type { NatalDay } from '../packets/encode.ts';
import type { DayPacket } from '../packets/compression.ts';
import type { ComputeQueue, QueueOptions } from '../runtime/compute-queue.ts';
import type { JsonWorkerOptions } from '../runtime/json-worker.ts';
import type { SharedJob } from '../runtime/job-consumers.ts';

interface NatalWork extends SharedJob<DayPacket> {
  key: string;
  date: string;
  timezone: string;
  controller: AbortController;
  resolve: (packet: DayPacket) => void;
  reject: (reason: unknown) => void;
}
interface GenerateNatalOptions extends QueueOptions {
  report?: CalculationFailureReport;
  root: string;
  date: string;
  timezone: string;
  spawnWorker?: JsonWorkerOptions['spawnWorker'];
  computeQueue?: ComputeQueue;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
interface NatalDayOptions {
  report?: CalculationFailureReport;
  root?: string;
  computeQueue?: ComputeQueue;
  generateDay?: (date: string, timezone: string, options: QueueOptions) => Promise<NatalDay>;
  now?: () => number;
  capacity?: number;
  ttlMs?: number;
  maxQueued?: number;
}
export type NatalDays = ReturnType<typeof createNatalDays>;

import { consumeJob } from '../runtime/job-consumers.ts';
import { encodeNatalDayColumn, encodeNatalDay } from '../packets/encode.ts';
import { runJsonWorker } from '../runtime/json-worker.ts';
import { encodePredictedDay, compressDayPacket } from '../packets/compression.ts';
import { SUPPORTED_START, SUPPORTED_END_EXCLUSIVE } from '../../shared/date-limits.ts';

export class NatalDayError extends Error {
  declare code: string;
  declare status: number;
  declare retryAfter: number | null;

  constructor(code: string, message: string, status = 503, retryAfter: number | null = 5) {
    super(message); this.code = code; this.status = status; this.retryAfter = retryAfter;
  }
}
export function validateNatalDayDate(date: unknown): asserts date is string {
  const moment = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  if (!Number.isFinite(moment) || new Date(moment).toISOString().slice(0, 10) !== date || moment < SUPPORTED_START || moment >= SUPPORTED_END_EXCLUSIVE) {
    throw new NatalDayError('invalid_date', 'Нужна корректная дата рождения с 1801 по 2399 год.', 422, null);
  }
}
export function validateNatalZone(timezone: unknown): asserts timezone is string {
  if (typeof timezone !== 'string' || !timezone || timezone.length > 160 || !/^[A-Za-z0-9_+\-/]+$/.test(timezone)) {
    throw new NatalDayError('invalid_timezone', 'Некорректный часовой пояс города.', 422, null);
  }
}
export function generateNatalDay({ root, date, timezone, spawnWorker, computeQueue, signal, priority, report, timeoutMs = 30_000, maxOutputBytes = 2_000_000 }: GenerateNatalOptions) {
  validateNatalDayDate(date); validateNatalZone(timezone);
  const unavailable = () => new NatalDayError('natal_day_unavailable', 'Не удалось подготовить день рождения. Повторите попытку.');
  const failure = createCalculationFailureReporter('natal_day', report);
  const invalid = () => { if (!signal?.aborted) failure('invalid_result'); return unavailable(); };
  return runJsonWorker({
    root, script: 'natal_day.py', input: { date, timezone }, spawnWorker, computeQueue, signal, priority, timeoutMs, maxOutput: maxOutputBytes, unavailable, onFailure: failure,
    timeoutError: () => new NatalDayError('natal_day_timeout', 'День рождения не успел рассчитаться. Повторите попытку.'),
    validate(value) {
      const day = value as NatalDay & { error?: string; message?: string };
      if (!day) throw invalid();
      if (day.error) {
        const known = ['invalid_date', 'unsupported_date', 'invalid_timezone', 'nonexistent_date'].includes(day.error);
        throw known ? new NatalDayError(day.error, day.message!, 422, null) : invalid();
      }
      if (day.date !== date || day.timezone !== timezone) throw invalid();
      return day;
    },
  });
}
export function encodeNatalDayPacket(day: NatalDay) {
  return encodePredictedDay(day, encodeNatalDayColumn, encodeNatalDay);
}

// Only bounded, short-lived RAM. No personal disk cache, persistent workers,
// prewarming, request logging, or birth data in a public/cacheable URL.
export function createNatalDays({ root, computeQueue, report, generateDay = (date, timezone, options) => generateNatalDay({ root: root!, date, timezone, computeQueue, report, ...options }),
  now = Date.now, capacity = 10, ttlMs = 600_000, maxQueued = 3 }: NatalDayOptions = {}) {
  const failure = createCalculationFailureReporter('natal_day', report);
  const memory = new Map<string, { packet: DayPacket; expires: number }>(), pending = new Map<string, NatalWork>(), queue: NatalWork[] = [];
  let running = false;
  const aborted = () => new DOMException('Запрос отменён.', 'AbortError');
  function prune() { for (const [key, entry] of memory) if (entry.expires <= now()) memory.delete(key); }
  function consume(job: NatalWork, signal?: AbortSignal) {
    return consumeJob(job, signal, abandoned => {
      const index = queue.indexOf(abandoned);
      if (index >= 0) { queue.splice(index, 1); pending.delete(abandoned.key); abandoned.reject(aborted()); }
      if (pending.get(abandoned.key) === abandoned) pending.delete(abandoned.key);
      abandoned.controller.abort();
    });
  }

  async function drain() {
    if (running || !queue.length) return;
    running = true;
    const job = queue.shift()!;
    try {
      // Abandoned packing may finish while a retry is waiting in this queue.
      prune();
      if (memory.has(job.key)) {
        const entry = memory.get(job.key)!; memory.delete(job.key); memory.set(job.key, entry);
        job.resolve(entry.packet); return;
      }
      const day = await generateDay(job.date, job.timezone, { signal: job.controller.signal });
      if (job.controller.signal.aborted) throw aborted();
      let raw: Buffer;
      try {
        if (day.date !== job.date || day.timezone !== job.timezone) throw new Error('Unexpected natal day');
        raw = await encodeNatalDayPacket(day);
      } catch (error) {
          if (job.controller.signal.aborted) throw error;
          failure('invalid_result'); throw new NatalDayError('natal_day_unavailable', 'Не удалось подготовить день рождения. Повторите попытку.');
        }
      const packet = { bytes: await compressDayPacket(raw, { quality: 9 }) };
      prune(); memory.set(job.key, { packet, expires: now() + ttlMs });
      while (memory.size > capacity) memory.delete(memory.keys().next().value!);
      job.resolve(packet);
    } catch (error) { job.reject(error); }
    finally { if (pending.get(job.key) === job) pending.delete(job.key); running = false; void drain(); }
  }
  function get(date: string, timezone: string, { signal }: { signal?: AbortSignal } = {}): Promise<DayPacket> {
    if (signal?.aborted) return Promise.reject(aborted());
    try { validateNatalDayDate(date); validateNatalZone(timezone); } catch (error) { return Promise.reject(error); }
    const key = `${date}@${timezone}`;
    prune();
    if (memory.has(key)) {
      const entry = memory.get(key)!; memory.delete(key); memory.set(key, entry);
      return Promise.resolve(entry.packet);
    }
    if (pending.has(key)) return consume(pending.get(key)!, signal);
    if (queue.length >= maxQueued) return Promise.reject(new NatalDayError('natal_day_busy', 'Подождите завершения расчёта дня рождения и повторите попытку.', 503, 2));
    let resolve!: (packet: DayPacket) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<DayPacket>((yes, no) => { resolve = yes; reject = no; });
    const job = { key, date, timezone, controller: new AbortController(), resolve, reject, promise };
    pending.set(key, job); queue.push(job);
    const result = consume(job, signal); void drain();
    return result;
  }
  return { get, get size() { prune(); return memory.size; }, get queued() { return queue.length; } };
}
