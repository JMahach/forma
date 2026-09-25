import { CHART_DAY_VERSION, encodeChartDayColumn, encodeChartDay } from '../src/transit/chart-day-packet.js';
import { runDayWorker } from './day-worker.mjs';
import { encodePredictedDay, compressDayPacket } from './day-compression.mjs';
import { negotiateEncoding } from './content-encoding.mjs';

export class ChartDayError extends Error {
  constructor(code, message, status = 503, retryAfter = 5) {
    super(message); this.code = code; this.status = status; this.retryAfter = retryAfter;
  }
}
function validateDate(date) {
  const moment = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  if (!Number.isFinite(moment) || new Date(moment).toISOString().slice(0, 10) !== date || date < '1801-01-01' || date > '2399-12-31') {
    throw new ChartDayError('invalid_date', 'Нужна корректная дата рождения с 1801 по 2399 год.', 422, null);
  }
}
function validateZone(timezone) {
  if (typeof timezone !== 'string' || !timezone || timezone.length > 160 || !/^[A-Za-z0-9_+\-/]+$/.test(timezone)) {
    throw new ChartDayError('invalid_timezone', 'Некорректный часовой пояс города.', 422, null);
  }
}
export function validateChartDayRequest(input, cities) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ChartDayError('invalid_request', 'Некорректные данные.', 400, null);
  if (input.v !== CHART_DAY_VERSION) throw new ChartDayError('unsupported_version', 'Версия дня рождения не поддерживается. Обновите страницу.', 400, null);
  validateDate(input.birthDate);
  const city = typeof input.cityId === 'string' && input.cityId.length <= 40 ? cities.find(input.cityId) : null;
  if (!city) throw new ChartDayError('city_required', 'Выберите город из списка подсказок.', 422, null);
  validateZone(city.timezone);
  return { date: input.birthDate, timezone: city.timezone };
}
export function generateChartDay({ root, date, timezone, spawnWorker, timeoutMs = 30_000, maxOutputBytes = 2_000_000 }) {
  validateDate(date); validateZone(timezone);
  const unavailable = () => new ChartDayError('chart_day_unavailable', 'Не удалось подготовить день рождения. Повторите попытку.');
  return runDayWorker({
    root, script: 'chart_day.py', input: { date, timezone }, spawnWorker, timeoutMs, maxOutputBytes, unavailable,
    timeoutError: () => new ChartDayError('chart_day_timeout', 'День рождения не успел рассчитаться. Повторите попытку.'),
    validate(day) {
      if (!day) throw unavailable();
      if (day.error) {
        const known = ['invalid_date', 'unsupported_date', 'invalid_timezone', 'nonexistent_date'].includes(day.error);
        throw known ? new ChartDayError(day.error, day.message, 422, null) : unavailable();
      }
      if (day.date !== date || day.timezone !== timezone) throw unavailable();
      return day;
    },
  });
}
export function encodeChartDayPacket(day) {
  return encodePredictedDay(day, encodeChartDayColumn, encodeChartDay);
}

// Only bounded, short-lived RAM. No personal disk cache, persistent workers,
// prewarming, request logging, or birth data in a public/cacheable URL.
export function createChartDays({ root, generateDay = (date, timezone) => generateChartDay({ root, date, timezone }),
  now = Date.now, capacity = 4, ttlMs = 600_000, maxQueued = 3 } = {}) {
  const memory = new Map(), pending = new Map(), queue = [];
  let running = false;
  function prune() { for (const [key, entry] of memory) if (entry.expires <= now()) memory.delete(key); }
  async function drain() {
    if (running || !queue.length) return;
    running = true;
    const job = queue.shift();
    try {
      const day = await generateDay(job.date, job.timezone);
      if (day.date !== job.date || day.timezone !== job.timezone) throw new Error('Unexpected chart day');
      const raw = await encodeChartDayPacket(day);
      const packet = { bytes: await compressDayPacket(raw, { quality: 9 }) };
      prune(); memory.set(job.key, { packet, expires: now() + ttlMs });
      while (memory.size > capacity) memory.delete(memory.keys().next().value);
      job.resolve(packet);
    } catch (error) { job.reject(error); }
    finally { pending.delete(job.key); running = false; void drain(); }
  }
  function get(date, timezone) {
    try { validateDate(date); validateZone(timezone); } catch (error) { return Promise.reject(error); }
    const key = `${date}@${timezone}`;
    prune();
    if (memory.has(key)) {
      const entry = memory.get(key); memory.delete(key); memory.set(key, entry);
      return Promise.resolve(entry.packet);
    }
    if (pending.has(key)) return pending.get(key);
    if (queue.length >= maxQueued) return Promise.reject(new ChartDayError('chart_day_busy', 'Подождите завершения расчёта дня рождения и повторите попытку.', 503, 2));
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    pending.set(key, promise); queue.push({ key, date, timezone, resolve, reject }); void drain();
    return promise;
  }
  async function handle(req, res, cities) {
    const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
    if (req.method !== 'POST') { res.writeHead(405, { ...headers, Allow: 'POST' }); res.end(); return; }
    try {
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new ChartDayError('content_type', 'Нужны данные JSON.', 415, null);
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024) throw new ChartDayError('too_large', 'Слишком большой запрос.', 413, null);
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new ChartDayError('invalid_json', 'Не удалось прочитать данные.', 400, null); }
      const { date, timezone } = validateChartDayRequest(input, cities);
      const encoding = negotiateEncoding(req.headers['accept-encoding']);
      if (!encoding) throw new ChartDayError('encoding_not_acceptable', 'Нет поддерживаемого способа передачи дня рождения.', 406, null);
      const packet = await get(date, timezone), body = packet.bytes[encoding];
      res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, Vary: 'Accept-Encoding',
        ...(encoding === 'identity' ? {} : { 'Content-Encoding': encoding }) });
      res.end(body);
    } catch (error) {
      const known = error instanceof ChartDayError;
      res.writeHead(known ? error.status : 503, { ...headers, 'Content-Type': 'application/json; charset=utf-8',
        ...(known && error.retryAfter === null ? {} : { 'Retry-After': String(known ? error.retryAfter : 5) }) });
      res.end(JSON.stringify({ error: known ? error.code : 'chart_day_unavailable', message: known ? error.message : 'Не удалось подготовить день рождения. Повторите попытку.' }));
    }
  }
  return { get, handle, get size() { prune(); return memory.size; }, get queued() { return queue.length; } };
}
