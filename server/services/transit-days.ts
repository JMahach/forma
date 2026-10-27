import { createCalculationFailureReporter, type CalculationFailureReport } from './calculation-failure.ts';
import type { TransitDay } from '../packets/encode.ts';
import type { DayPacket } from '../packets/compression.ts';
import type { ComputeQueue, QueueOptions } from '../runtime/compute-queue.ts';
import type { JsonWorkerOptions } from '../runtime/json-worker.ts';
import type { SharedJob } from '../runtime/job-consumers.ts';

interface TransitWork extends SharedJob<DayPacket> {
  date: string;
  background: boolean;
  controller: AbortController;
  resolve: (packet: DayPacket) => void;
  reject: (reason: unknown) => void;
}
interface TransitGetOptions { signal?: AbortSignal; allowCalculate?: boolean }
interface GenerateTransitOptions extends QueueOptions {
  report?: CalculationFailureReport;
  root: string;
  date: string;
  spawnWorker?: JsonWorkerOptions['spawnWorker'];
  computeQueue?: ComputeQueue;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
interface TransitDaysOptions {
  report?: CalculationFailureReport;
  root?: string;
  cacheDir?: string;
  now?: () => Date;
  calculationVersion?: string | null;
  computeQueue?: ComputeQueue;
  generateDay?: (date: string, options: QueueOptions) => Promise<TransitDay>;
  onCacheError?: (error: unknown) => void;
}
export type TransitDays = Awaited<ReturnType<typeof createTransitDays>>;

import { migrateTransitCache, type TransitCacheMigration } from '../runtime/transit-cache-migration.ts';
import path from 'node:path';
import { SUPPORTED_START, SUPPORTED_END_EXCLUSIVE } from '../../shared/date-limits.ts';
import { encodeNumericColumn, encodeTransitDay } from '../packets/encode.ts';
import { runJsonWorker } from '../runtime/json-worker.ts';
import { encodePredictedDay, compressDayPacket } from '../packets/compression.ts';

import { consumeJob, aborted } from '../runtime/job-consumers.ts';
import { calculationVersion } from '../runtime/calculation-version.ts';

const DAY_MS = 86400000, MAX_QUEUED = 5;
const utcDate = (moment: number | Date) => new Date(moment).toISOString().slice(0, 10);

export class TransitDayError extends Error {
  declare code: string;
  declare status: number;
  declare retryAfter: number | null;

  constructor(code: string, message: string, status = 503, retryAfter: number | null = 5) {
    super(message); this.code = code; this.status = status; this.retryAfter = retryAfter;
  }
}
export function transitDateMilliseconds(date: unknown) {
  const value = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  if (!Number.isFinite(value) || utcDate(value) !== date || value < SUPPORTED_START || value >= SUPPORTED_END_EXCLUSIVE) {
    throw new TransitDayError('invalid_date', 'Нужна корректная дата UTC в формате YYYY-MM-DD.', 400, null);
  }
  return value;
}
export function generateTransitDay({ root, date, spawnWorker, computeQueue, signal, priority, report, timeoutMs = 60000, maxOutputBytes = 1000000 }: GenerateTransitOptions) {
  transitDateMilliseconds(date);
  const unavailable = () => new TransitDayError('transit_unavailable', 'Не удалось подготовить дневной транзит. Повторите попытку.');
  const failure = createCalculationFailureReporter('transit_day', report);
  const invalid = () => { if (!signal?.aborted) failure('invalid_result'); return unavailable(); };
  return runJsonWorker({
    root, script: 'transit_day.py', input: { date }, spawnWorker, computeQueue, signal, priority, timeoutMs, maxOutput: maxOutputBytes, unavailable, onFailure: failure,
    timeoutError: () => new TransitDayError('transit_timeout', 'Подготовка дневного транзита заняла слишком много времени. Повторите попытку.'),
    validate(value) {
      const day = value as TransitDay & { error?: string };
      if (!day || day.error || day.date !== date) throw invalid();
      return day;
    },
  });
}

export function encodeDayPacket(day: TransitDay) {
  return encodePredictedDay(day, encodeNumericColumn, encodeTransitDay);
}
async function representations(raw: Buffer) {
  return { bytes: await compressDayPacket(raw, { quality: 9 }) };
}

export async function createTransitDays({ root, cacheDir = root ? path.join(root, '.cache/transit') : undefined,
  now = () => new Date(), calculationVersion: version = null, computeQueue, report,
  generateDay = (date, options) => generateTransitDay({ root: root!, date, computeQueue, report, ...options }), onCacheError = () => {} }: TransitDaysOptions = {}) {
  const failure = createCalculationFailureReporter('transit_day', report);
  version ||= await calculationVersion(root!);
  const memory = new Map<string, DayPacket>(), pending = new Map<string, TransitWork>(), queue: TransitWork[] = [];
  let running: Promise<void> | null = null, timer: ReturnType<typeof setTimeout> | null = null, warming = false, warmGeneration = 0;
  let retainedToday = '', retained = new Set<string>();
  const busy = () => new TransitDayError('transit_busy', 'Дневной транзит готовится. Повторите попытку.', 503, 1);

  let migration: TransitCacheMigration = {removed: 0, blocked: 0, reason: 'missing'};
  async function cleanLegacy(directory: string) {
    migration = await migrateTransitCache(directory, computeQueue);
    if (migration.blocked) onCacheError(Object.assign(new Error('Legacy transit cache cleanup left entries untouched'),
      {code: 'TRANSIT_CACHE_MIGRATION_BLOCKED', ...migration}));
  }
  function discard(job: TransitWork) {
    const index = queue.indexOf(job);
    if (index !== -1) queue.splice(index, 1);
    if (pending.get(job.date) === job) pending.delete(job.date);
  }
  function syncWindow() {
    const today = utcDate(now());
    if (today === retainedToday) return;
    retainedToday = today;
    const midnight = Date.parse(`${today}T00:00:00Z`);
    retained = new Set([0, -1, 1, 2].map(offset => midnight + offset * DAY_MS)
      .filter(value => value >= SUPPORTED_START && value < SUPPORTED_END_EXCLUSIVE).map(utcDate));
    for (const date of memory.keys()) if (!retained.has(date)) memory.delete(date);
    for (const job of pending.values()) if (job.background && !retained.has(job.date)) {
      discard(job); job.controller.abort(); job.reject(aborted());
    }
  }
  async function prune() {
    syncWindow();
    if (cacheDir) await cleanLegacy(cacheDir);
  }
  function remember(date: string, packet: DayPacket) {
    syncWindow();
    // HTTP still permits today's minus-two date, and internal callers may ask
    // for another valid date. Their result is transient, not a fifth RAM day.
    if (retained.has(date)) memory.set(date, packet);
    return packet;
  }
  function drain() {
    if (running || !queue.length) return;
    const job = queue.shift()!;
    running = (async () => {
      try {
        await Promise.resolve(); // Assign the slot before a ready result releases it.
        syncWindow();
        if (job.controller.signal.aborted) throw aborted();
        // A cancelled packing job may complete before its retry starts.
        if (memory.has(job.date)) { job.resolve(memory.get(job.date)!); return; }
        const day = await generateDay(job.date, { signal: job.controller.signal, priority: () => job.background ? -1 : 0 });
        let raw: Buffer;
        try {
          if (day.date !== job.date) throw new Error('Unexpected transit date');
          raw = await encodeDayPacket({ ...day, calculationVersion: version! });
        } catch (error) {
          if (job.controller.signal.aborted) throw error;
          failure('invalid_result'); throw new TransitDayError('transit_unavailable', 'Не удалось подготовить дневной транзит. Повторите попытку.');
        }
        const packet = await representations(raw);
        job.resolve(remember(job.date, packet));
      } catch (error) { job.reject(error); }
      finally { if (pending.get(job.date) === job) pending.delete(job.date); running = null; drain(); }
    })();
  }
  function enqueue(job: TransitWork) {
    const nextBackground = job.background ? -1 : queue.findIndex(item => item.background);
    if (nextBackground < 0) queue.push(job); else queue.splice(nextBackground, 0, job);
  }
  function consume(job: TransitWork, signal?: AbortSignal) {
    return consumeJob(job, signal, abandoned => {
      if (queue.includes(abandoned)) { discard(abandoned); abandoned.reject(aborted()); }
      if (pending.get(abandoned.date) === abandoned) pending.delete(abandoned.date);
      abandoned.controller.abort();
    });
  }
  function request(date: string, background: boolean, { signal, allowCalculate = true }: TransitGetOptions = {}): Promise<DayPacket> {
    if (signal?.aborted) return Promise.reject(aborted());
    try { transitDateMilliseconds(date); } catch (error) { return Promise.reject(error); }
    syncWindow();
    if (memory.has(date)) return Promise.resolve(memory.get(date)!);
    if (pending.has(date)) {
      const job = pending.get(date)!;
      if (!background && job.background) {
        job.background = false;
        const index = queue.indexOf(job);
        if (index >= 0) { queue.splice(index, 1); enqueue(job); }
      }
      return consume(job, signal);
    }
    if (!allowCalculate) return Promise.reject(new TransitDayError('date_out_of_range', 'Доступны транзиты в пределах двух дней от сегодняшней даты UTC.', 422, null));
    if (queue.length >= MAX_QUEUED + (running ? 0 : 1)) return Promise.reject(busy());
    let resolve!: (packet: DayPacket) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<DayPacket>((yes, no) => { resolve = yes; reject = no; });
    const job = { date, background, controller: new AbortController(), promise, resolve, reject };
    pending.set(date, job); enqueue(job);
    const result = consume(job, signal); drain();
    return result;
  }
  function get(date: string, options: TransitGetOptions = {}) { return request(date, false, options); }
  async function warm() {
    syncWindow();
    const generation = warmGeneration;
    await Promise.allSettled([...retained].map(async date => {
      while (generation === warmGeneration) {
        syncWindow(); if (!retained.has(date)) return;
        try { await request(date, true); return; }
        catch (error) {
          // Admission pressure is temporary. Retry only admission, never a
          // failed calculation; warmup remains inside the same bounded queue.
          if (!(error instanceof TransitDayError) || error.code !== 'transit_busy' || !running) throw error;
          await running;
        }
      }
    }));
  }
  function scheduleMidnight() {
    if (!warming) return;
    const current = new Date(now());
    const midnight = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1);
    timer = setTimeout(() => {
      timer = null;
      if (!warming) return;
      scheduleMidnight(); void warm().catch(onCacheError);
    }, Math.max(1, midnight - current.getTime() + 50));
    timer.unref?.();
  }
  function startWarmup() {
    if (warming) return;
    warming = true;
    scheduleMidnight(); void warm().catch(onCacheError);
  }
  async function close() {
    warming = false; warmGeneration++; clearTimeout(timer ?? undefined); timer = null;
    while (running) await Promise.allSettled([running]);
  }

  await prune();
  return { get, warm, startWarmup, close, prune, calculationVersion: version,
    get migration() { return {...migration}; },
    get size() { syncWindow(); return memory.size; }, get queued() { return queue.length; } };
}
