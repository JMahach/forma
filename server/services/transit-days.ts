import type { TransitDay } from '../packets/encode.ts';
import type { DayPacket } from '../packets/compression.ts';
import type { ComputeQueue, QueueOptions } from '../runtime/compute-queue.ts';
import type { JsonWorkerOptions } from '../runtime/json-worker.ts';
import type { SharedJob } from '../runtime/job-consumers.ts';

interface TransitWork extends SharedJob<DayPacket> {
  date: string;
  background: boolean;
  allowCalculate: boolean;
  controller: AbortController;
  ready: boolean;
  resolve: (packet: DayPacket) => void;
  reject: (reason: unknown) => void;
}
interface TransitGetOptions { signal?: AbortSignal; allowCalculate?: boolean }
interface GenerateTransitOptions extends QueueOptions {
  root: string;
  date: string;
  spawnWorker?: JsonWorkerOptions['spawnWorker'];
  computeQueue?: ComputeQueue;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
interface TransitDaysOptions {
  root?: string;
  cacheDir?: string;
  now?: () => Date;
  fingerprint?: string;
  maxDiskBytes?: number;
  maxPendingReads?: number;
  calculationVersion?: string | null;
  computeQueue?: ComputeQueue;
  generateDay?: (date: string, options: QueueOptions) => Promise<TransitDay>;
  onCacheError?: (error: unknown) => void;
}
export type TransitDays = Awaited<ReturnType<typeof createTransitDays>>;

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { TRANSIT_DAY_VERSION } from '../../shared/day-packets/transit-format.ts';
import { SUPPORTED_START, SUPPORTED_END_EXCLUSIVE } from '../../shared/date-limits.ts';
import { decodeTransitDay } from '../../shared/day-packets/decode.ts';
import { encodeNumericColumn, encodeTransitDay } from '../packets/encode.ts';
import { runJsonWorker } from '../runtime/json-worker.ts';
import { encodePredictedDay, compressDayPacket } from '../packets/compression.ts';

import { consumeJob, aborted } from '../runtime/job-consumers.ts';
import { calculationVersion, inputFingerprint } from '../runtime/calculation-version.ts';

const decompressGzip = promisify(gunzip);
const DAY_MS = 86400000, MAX_DAYS = 7, MAX_QUEUED = 5;
const OWN_CACHE_FILE = /^\d{4}-\d{2}-\d{2}\.[a-f0-9]{16}\.gz$/;
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
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
// Numeric identity and packet encoding are separate: an encoding change only
// replaces the small day files, never the prepared lifetime.
export async function transitCacheFingerprint(root: string, version: string | null = null) {
  const numeric = version || await calculationVersion(root);
  const format = await inputFingerprint(root, ['shared/day-packets/transit-format.ts',
    'shared/day-packets/float64-codec.ts', 'shared/day-packets/decode.ts', 'server/packets/encode.ts']);
  return digest(`${numeric}\0${format}`).slice(0, 16);
}

export function generateTransitDay({ root, date, spawnWorker, computeQueue, signal, priority, timeoutMs = 60000, maxOutputBytes = 1000000 }: GenerateTransitOptions) {
  transitDateMilliseconds(date);
  const unavailable = () => new TransitDayError('transit_unavailable', 'Не удалось подготовить дневной транзит. Повторите попытку.');
  return runJsonWorker({
    root, script: 'transit_day.py', input: { date }, spawnWorker, computeQueue, signal, priority, timeoutMs, maxOutput: maxOutputBytes, unavailable,
    timeoutError: () => new TransitDayError('transit_timeout', 'Подготовка дневного транзита заняла слишком много времени. Повторите попытку.'),
    validate(value) {
      const day = value as TransitDay & { error?: string };
      if (!day || day.error || day.date !== date) throw unavailable();
      return day;
    },
  });
}

export function encodeDayPacket(day: TransitDay) {
  return encodePredictedDay(day, encodeNumericColumn, encodeTransitDay);
}
async function representations(raw: Buffer, storedGzip?: Buffer) {
  // q9 keeps exact packet bytes while avoiding q11 work on cold and disk-cache reads.
  const bytes = await compressDayPacket(raw, { quality: 9, storedGzip });
  return { bytes };
}

export async function createTransitDays({ root, cacheDir = path.join(root!, '.cache/transit', `v${TRANSIT_DAY_VERSION}`), now = () => new Date(), fingerprint, maxDiskBytes = 256 * 1024 * 1024, maxPendingReads = 1024, calculationVersion: version = null, computeQueue,
  generateDay = (date, options) => generateTransitDay({ root: root!, date, computeQueue, ...options }), onCacheError = () => {} }: TransitDaysOptions = {}) {
  version ||= await calculationVersion(root!);
  fingerprint ||= await transitCacheFingerprint(root!, version);
  if (!/^[a-f0-9]{16}$/.test(fingerprint)) throw new Error('Invalid transit cache fingerprint');
  const memory = new Map<string, DayPacket>(), pending = new Map<string, TransitWork>(), queue: TransitWork[] = [], readQueue: TransitWork[] = [];
  let running: Promise<void> | null = null, reading: Promise<void> | null = null, timer: ReturnType<typeof setTimeout> | null = null, warming = false;
  const busy = () => new TransitDayError('transit_busy', 'Дневной транзит готовится. Повторите попытку.', 503, 1);
  const filename = (date: string) => `${date}.${fingerprint}.gz`;

  async function prune() {
    let entries;
    try { entries = await fs.readdir(cacheDir, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onCacheError(error); return; }
    const files = entries.filter(entry => entry.isFile() && OWN_CACHE_FILE.test(entry.name)).map(entry => entry.name);
    const current = await Promise.all(files.filter(name => name.endsWith(`.${fingerprint}.gz`)).map(async name => ({ name, ...await fs.stat(path.join(cacheDir, name)) })));
    current.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let bytes = 0;
    const excess = current.filter(entry => (bytes += entry.size) > maxDiskBytes).map(entry => entry.name);
    const obsolete = files.filter(name => !name.endsWith(`.${fingerprint}.gz`));
    await Promise.all([...obsolete, ...excess].map(name => fs.unlink(path.join(cacheDir, name)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onCacheError(error); })));
  }
  async function load(date: string) {
    const file = path.join(cacheDir, filename(date));
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 1000000) return null;
      const gz = await fs.readFile(file), raw = await decompressGzip(gz, { maxOutputLength: 1000000 });
      const day = decodeTransitDay(raw);
      if (day.date !== date || day.calculationVersion !== version) return null;
      await fs.utimes(file, new Date(), new Date()).catch(onCacheError);
      return await representations(raw, gz);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onCacheError(error); return null; }
  }
  async function persist(date: string, packet: DayPacket) {
    await fs.mkdir(cacheDir, { recursive: true });
    const temporary = path.join(cacheDir, `.${filename(date)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, packet.bytes.gzip, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, path.join(cacheDir, filename(date)));
    } finally { await fs.unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onCacheError(error); }); }
    await prune();
  }
  function remember(date: string, packet: DayPacket) {
    memory.delete(date); memory.set(date, packet);
    while (memory.size > MAX_DAYS) memory.delete(memory.keys().next().value!);
    return packet;
  }
  function drain() {
    if (running || !queue[0]?.ready) return;
    const job = queue.shift()!;
    running = (async () => {
      try {
        await Promise.resolve(); // Assign the running slot before a cache hit can release it.
        // Abandoned packing may finish while a retry is waiting in this queue.
        if (memory.has(job.date)) { job.resolve(remember(job.date, memory.get(job.date)!)); return; }
        const day = await generateDay(job.date, { signal: job.controller.signal, priority: () => job.background ? -1 : 0 });
        if (day.date !== job.date) throw new Error('Unexpected transit date');
        const packet = await representations(await encodeDayPacket({ ...day, calculationVersion: version! }));
        // The browser needs the ready packet, not the completion of its disk
        // copy. Persistence keeps this local preparation slot: writes cannot pile up.
        job.resolve(remember(job.date, packet));
        await persist(job.date, packet).catch(onCacheError);
      } catch (error) { job.reject(error); }
      finally { if (pending.get(job.date) === job) pending.delete(job.date); running = null; drain(); }
    })();
  }
  function discard(job: TransitWork) {
    const index = queue.indexOf(job);
    if (index !== -1) queue.splice(index, 1);
    if (pending.get(job.date) === job) pending.delete(job.date);
  }
  function drainReads() {
    if (reading || !readQueue.length) return;
    const job = readQueue.shift()!;
    // Ready gzip files never wait for astronomy or its disk persistence. One
    // lookup at a time bounds decompression; duplicate dates share pending.
    reading = (async () => {
      try {
        const packet = await load(job.date);
        if (job.controller.signal.aborted) { discard(job); job.reject(aborted()); return; }
        if (packet) { discard(job); job.resolve(remember(job.date, packet)); }
        else if (!job.allowCalculate) { discard(job); job.reject(new TransitDayError('date_out_of_range', 'Доступны транзиты в пределах двух дней от сегодняшней даты UTC.', 422, null)); }
        else if (queue.filter(item => item.ready).length >= MAX_QUEUED + (running ? 0 : 1)) {
          discard(job); job.reject(busy());
        } else job.ready = true;
      } catch (error) { discard(job); job.reject(error); }
      finally { reading = null; drainReads(); drain(); }
    })();
  }
  function enqueue(job: TransitWork) {
    const nextBackground = job.background ? -1 : queue.findIndex(item => item.background);
    if (nextBackground < 0) queue.push(job); else queue.splice(nextBackground, 0, job);
  }
  function consume(job: TransitWork, signal?: AbortSignal) {
    return consumeJob(job, signal, abandoned => {
      const index = readQueue.indexOf(abandoned);
      if (index >= 0) readQueue.splice(index, 1);
      if (queue.includes(abandoned)) { discard(abandoned); abandoned.reject(aborted()); }
      if (pending.get(abandoned.date) === abandoned) pending.delete(abandoned.date);
      abandoned.controller.abort();
    });
  }
  function request(date: string, background: boolean, { signal, allowCalculate = true }: TransitGetOptions = {}): Promise<DayPacket> {
    if (signal?.aborted) return Promise.reject(aborted());
    try { transitDateMilliseconds(date); } catch (error) { return Promise.reject(error); }
    if (memory.has(date)) return Promise.resolve(remember(date, memory.get(date)!));
    if (pending.has(date)) {
      const job = pending.get(date)!;
      if (!background && job.background) {
        job.background = false;
        const index = queue.indexOf(job);
        // A running job keeps its slot; only waiting warmup may be reordered.
        if (index >= 0) { queue.splice(index, 1); enqueue(job); }
      }
      return consume(job, signal);
    }
    if (readQueue.length + Number(Boolean(reading)) >= maxPendingReads) return Promise.reject(busy());
    let resolve!: (packet: DayPacket) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<DayPacket>((yes, no) => { resolve = yes; reject = no; });
    const job = { date, background, allowCalculate, controller: new AbortController(), promise, resolve, reject, ready: false };
    pending.set(date, job); enqueue(job); readQueue.push(job);
    const result = consume(job, signal); drainReads();
    return result;
  }
  function get(date: string, options: TransitGetOptions = {}) { return request(date, false, options); }
  async function warm() {
    const today = Date.parse(`${utcDate(now())}T00:00:00Z`);
    await Promise.allSettled([request(utcDate(today), true), request(utcDate(today + DAY_MS), true)]);
    await running;
    await prune();
  }
  function scheduleMidnight() {
    if (!warming) return;
    const current = new Date(now());
    const midnight = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1);
    timer = setTimeout(() => {
      timer = null;
      if (!warming) return;
      scheduleMidnight();
      void warm().catch(onCacheError);
    }, Math.max(1, midnight - current.getTime() + 50));
    timer.unref?.();
  }
  function startWarmup() {
    if (warming) return;
    warming = true;
    // Schedule before awaiting any work: a slow initial batch may cross UTC
    // midnight. Concurrent warmups share the existing singleflight queue.
    scheduleMidnight();
    void warm().catch(onCacheError);
  }
  async function close() {
    warming = false; clearTimeout(timer ?? undefined); timer = null;
    // Stop scheduling immediately; callers may also await the remaining writes.
    while (reading || running) await Promise.allSettled([reading, running]);
  }

  return { get, warm, startWarmup, close, prune, calculationVersion: version,
    get size() { return memory.size; }, get queued() { return queue.length; } };
}
