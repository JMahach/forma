import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { TRANSIT_DAY_VERSION, encodeNumericColumn, encodeTransitDay, decodeTransitDay } from '../src/transit/day-packet.js';
import { runDayWorker } from './day-worker.mjs';
import { encodePredictedDay, compressDayPacket } from './day-compression.mjs';
import { negotiateEncoding } from './content-encoding.mjs';

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
function dateMilliseconds(date) {
  const value = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  if (!Number.isFinite(value) || utcDate(value) !== date || date < '1801-01-01' || date > '2399-12-31') {
    throw new TransitDayError('invalid_date', 'Нужна корректная дата UTC в формате YYYY-MM-DD.', 400, null);
  }
  return value;
}
export function validateTransitDayQuery(searchParams, now = new Date()) {
  const version = searchParams.get('v');
  if (version !== null && version !== TRANSIT_DAY_VERSION) throw new TransitDayError('unsupported_version', 'Версия дневного транзита не поддерживается.', 400, null);
  const date = searchParams.get('date'), value = dateMilliseconds(date);
  const today = Date.parse(`${utcDate(now)}T00:00:00Z`);
  if (Math.abs(value - today) > 2 * DAY_MS) throw new TransitDayError('date_out_of_range', 'Доступны транзиты в пределах двух дней от сегодняшней даты UTC.', 422, null);
  return { date, versioned: version === TRANSIT_DAY_VERSION };
}

// Fingerprints protect local disk reuse. Public immutable URLs additionally
// require a TRANSIT_DAY_VERSION bump when calculation rules or data change.
export async function transitCacheFingerprint(root) {
  const hash = createHash('sha256');
  for (const name of ['server/calculator.py', 'server/transit_day.py', 'requirements.txt', 'src/transit/day-packet.js']) {
    hash.update(name).update(await fs.readFile(path.join(root, name)));
  }
  for (const name of ['data/ephe/sepl_18.se1', 'data/ephe/semo_18.se1']) {
    const stat = await fs.stat(path.join(root, name));
    hash.update(`${name}:${stat.size}:${stat.mtimeMs}`);
  }
  return hash.digest('hex').slice(0, 16);
}

export function generateTransitDay({ root, date, spawnWorker, timeoutMs = 60000, maxOutputBytes = 500000 }) {
  dateMilliseconds(date);
  const unavailable = () => new TransitDayError('transit_unavailable', 'Не удалось подготовить дневной транзит. Повторите попытку.');
  return runDayWorker({
    root, script: 'transit_day.py', input: { date }, spawnWorker, timeoutMs, maxOutputBytes, unavailable,
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
  const bytes = await compressDayPacket(raw, { storedGzip });
  return { bytes, etags: Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, `"${digest(value)}"`])) };
}

export async function createTransitDays({ root, cacheDir = path.join(root, '.cache/transit', `v${TRANSIT_DAY_VERSION}`), now = () => new Date(), fingerprint,
  generateDay = date => generateTransitDay({ root, date }), onCacheError = () => {} } = {}) {
  fingerprint ||= await transitCacheFingerprint(root);
  if (!/^[a-f0-9]{16}$/.test(fingerprint)) throw new Error('Invalid transit cache fingerprint');
  const memory = new Map(), pending = new Map(), queue = [];
  let running = false, timer = null, warming = false;
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
  async function drain() {
    if (running || !queue.length) return;
    running = true;
    const job = queue.shift();
    try {
      let packet = await load(job.date);
      if (!packet) {
        const day = await generateDay(job.date);
        if (day.date !== job.date) throw new Error('Unexpected transit date');
        packet = await representations(await encodeDayPacket(day));
        await persist(job.date, packet).catch(onCacheError);
      }
      job.resolve(remember(job.date, packet));
    } catch (error) { job.reject(error); }
    finally { pending.delete(job.date); running = false; void drain(); }
  }
  function get(date) {
    try { dateMilliseconds(date); } catch (error) { return Promise.reject(error); }
    if (memory.has(date)) return Promise.resolve(remember(date, memory.get(date)));
    if (pending.has(date)) return pending.get(date);
    if (queue.length >= MAX_QUEUED) return Promise.reject(new TransitDayError('transit_busy', 'Дневной транзит готовится. Повторите попытку.', 503, 1));
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    pending.set(date, promise); queue.push({ date, resolve, reject }); void drain();
    return promise;
  }
  async function warm() {
    const today = Date.parse(`${utcDate(now())}T00:00:00Z`);
    await Promise.allSettled([get(utcDate(today)), get(utcDate(today + DAY_MS))]);
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
  function close() { warming = false; clearTimeout(timer); timer = null; }

  async function handle(req, res, url) {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' }); res.end(); return; }
    try {
      const { date, versioned } = validateTransitDayQuery(url.searchParams, now());
      const encoding = negotiateEncoding(req.headers['accept-encoding']);
      if (!encoding) throw new TransitDayError('encoding_not_acceptable', 'Нет поддерживаемого способа передачи дневного транзита.', 406, null);
      const packet = await get(date), body = packet.bytes[encoding], etag = packet.etags[encoding];
      const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length,
        'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
        Vary: 'Accept-Encoding', ETag: etag, 'X-Content-Type-Options': 'nosniff',
        ...(encoding === 'identity' ? {} : { 'Content-Encoding': encoding }) };
      const matched = String(req.headers['if-none-match'] || '').split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag);
      res.writeHead(matched ? 304 : 200, headers);
      res.end(matched || req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      const known = error instanceof TransitDayError;
      res.writeHead(known ? error.status : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        ...(known && error.retryAfter === null ? {} : { 'Retry-After': String(known ? error.retryAfter : 5) }) });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: known ? error.code : 'transit_unavailable', message: known ? error.message : 'Не удалось подготовить дневной транзит. Повторите попытку.' }));
    }
  }
  return { get, handle, warm, startWarmup, close, prune,
    get size() { return memory.size; }, get queued() { return queue.length; } };
}
