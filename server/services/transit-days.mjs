import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { TRANSIT_DAY_VERSION } from '../../shared/day-packets/transit-format.js';
import { decodeTransitDay } from '../../shared/day-packets/decode.js';
import { encodeNumericColumn, encodeTransitDay } from '../packets/encode.mjs';
import { runJsonWorker } from '../runtime/json-worker.mjs';
import { encodePredictedDay, compressDayPacket } from '../packets/compression.mjs';

const decompressGzip = promisify(gunzip);
const DAY_MS = 86400000, MAX_DAYS = 7, MAX_QUEUED = 5;
const OWN_CACHE_FILE = /^\d{4}-\d{2}-\d{2}\.[a-f0-9]{16}\.gz$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const utcDate = moment => new Date(moment).toISOString().slice(0, 10);

export class TransitDayError extends Error {
  constructor(code, message, status = 503, retryAfter = 5) {
    super(message); this.code = code; this.status = status; this.retryAfter = retryAfter;
  }
}
export function transitDateMilliseconds(date) {
  const value = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  if (!Number.isFinite(value) || utcDate(value) !== date || date < '1801-01-01' || date > '2399-12-31') {
    throw new TransitDayError('invalid_date', 'Нужна корректная дата UTC в формате YYYY-MM-DD.', 400, null);
  }
  return value;
}
// Fingerprints protect local disk reuse. Public immutable URLs additionally
// require a TRANSIT_DAY_VERSION bump when calculation rules or data change.
export async function transitCacheFingerprint(root) {
  const hash = createHash('sha256');
  for (const name of ['server/python/astronomy.py', 'server/python/civil_time.py', 'server/python/errors.py', 'server/python/transit_day.py',
    'requirements.txt', 'shared/day-packets/transit-format.js', 'shared/day-packets/float64-codec.js',
    'shared/day-packets/decode.js', 'server/packets/encode.mjs',
    'data/ephe/sepl_18.se1', 'data/ephe/semo_18.se1']) {
    // Deployments may change file timestamps without changing calculation data.
    // Content identity also detects changed bytes with preserved size and mtime.
    hash.update(name).update(await fs.readFile(path.join(root, name)));
  }
  return hash.digest('hex').slice(0, 16);
}

export function generateTransitDay({ root, date, spawnWorker, timeoutMs = 60000, maxOutputBytes = 500000 }) {
  transitDateMilliseconds(date);
  const unavailable = () => new TransitDayError('transit_unavailable', 'Не удалось подготовить дневной транзит. Повторите попытку.');
  return runJsonWorker({
    root, script: 'transit_day.py', input: { date }, spawnWorker, timeoutMs, maxOutput: maxOutputBytes, unavailable,
    timeoutError: () => new TransitDayError('transit_timeout', 'Подготовка дневного транзита заняла слишком много времени. Повторите попытку.'),
    validate(day) {
      if (!day || day.error || day.date !== date) throw unavailable();
      return day;
    },
  });
}

export function encodeDayPacket(day) {
  return encodePredictedDay(day, encodeNumericColumn, encodeTransitDay);
}
async function representations(raw, storedGzip) {
  // q9 keeps exact packet bytes while avoiding q11 work on cold and disk-cache reads.
  const bytes = await compressDayPacket(raw, { quality: 9, storedGzip });
  return { bytes, etags: Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, `"${digest(value)}"`])) };
}

export async function createTransitDays({ root, cacheDir = path.join(root, '.cache/transit', `v${TRANSIT_DAY_VERSION}`), now = () => new Date(), fingerprint,
  generateDay = date => generateTransitDay({ root, date }), onCacheError = () => {} } = {}) {
  fingerprint ||= await transitCacheFingerprint(root);
  if (!/^[a-f0-9]{16}$/.test(fingerprint)) throw new Error('Invalid transit cache fingerprint');
  const memory = new Map(), pending = new Map(), queue = [];
  let running = null, timer = null, warming = false;
  const filename = date => `${date}.${fingerprint}.gz`;

  async function prune() {
    let entries;
    try { entries = await fs.readdir(cacheDir, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') onCacheError(error); return; }
    const files = entries.filter(entry => entry.isFile() && OWN_CACHE_FILE.test(entry.name)).map(entry => entry.name);
    const current = files.filter(name => name.endsWith(`.${fingerprint}.gz`)).sort().reverse();
    const obsolete = files.filter(name => !name.endsWith(`.${fingerprint}.gz`));
    await Promise.all([...obsolete, ...current.slice(MAX_DAYS)].map(name => fs.unlink(path.join(cacheDir, name)).catch(error => { if (error.code !== 'ENOENT') onCacheError(error); })));
  }
  async function load(date) {
    const file = path.join(cacheDir, filename(date));
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 1000000) return null;
      const gz = await fs.readFile(file), raw = await decompressGzip(gz, { maxOutputLength: 1000000 });
      if (decodeTransitDay(raw).date !== date) return null;
      return await representations(raw, gz);
    } catch (error) { if (error.code !== 'ENOENT') onCacheError(error); return null; }
  }
  async function persist(date, packet) {
    await fs.mkdir(cacheDir, { recursive: true });
    const temporary = path.join(cacheDir, `.${filename(date)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, packet.bytes.gzip, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, path.join(cacheDir, filename(date)));
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') onCacheError(error); }); }
    await prune();
  }
  function remember(date, packet) {
    memory.delete(date); memory.set(date, packet);
    while (memory.size > MAX_DAYS) memory.delete(memory.keys().next().value);
    return packet;
  }
  function drain() {
    if (running || !queue.length) return;
    const job = queue.shift();
    running = (async () => {
      try {
        let packet = await load(job.date);
        const generated = !packet;
        if (generated) {
          const day = await generateDay(job.date);
          if (day.date !== job.date) throw new Error('Unexpected transit date');
          packet = await representations(await encodeDayPacket(day));
        }
        // The browser needs the ready packet, not the completion of its disk
        // copy. Persistence keeps this same queue slot: writes cannot pile up.
        job.resolve(remember(job.date, packet));
        if (generated) await persist(job.date, packet).catch(onCacheError);
      } catch (error) { job.reject(error); }
      finally { pending.delete(job.date); running = null; drain(); }
    })();
  }
  function enqueue(job) {
    const nextBackground = job.background ? -1 : queue.findIndex(item => item.background);
    if (nextBackground < 0) queue.push(job); else queue.splice(nextBackground, 0, job);
  }
  function request(date, background) {
    try { transitDateMilliseconds(date); } catch (error) { return Promise.reject(error); }
    if (memory.has(date)) return Promise.resolve(remember(date, memory.get(date)));
    if (pending.has(date)) {
      const job = pending.get(date);
      if (!background && job.background) {
        job.background = false;
        const index = queue.indexOf(job);
        // A running job keeps its slot; only waiting warmup may be reordered.
        if (index >= 0) { queue.splice(index, 1); enqueue(job); }
      }
      return job.promise;
    }
    if (queue.length >= MAX_QUEUED) return Promise.reject(new TransitDayError('transit_busy', 'Дневной транзит готовится. Повторите попытку.', 503, 1));
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const job = { date, background, promise, resolve, reject };
    pending.set(date, job); enqueue(job); void drain();
    return promise;
  }
  function get(date) { return request(date, false); }
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
    warming = false; clearTimeout(timer); timer = null;
    // Stop scheduling immediately; callers may also await the remaining writes.
    while (running) await running;
  }

  return { get, warm, startWarmup, close, prune,
    get size() { return memory.size; }, get queued() { return queue.length; } };
}
