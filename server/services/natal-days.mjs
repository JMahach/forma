import { encodeChartDayColumn, encodeChartDay } from '../packets/encode.mjs';
import { runDayWorker } from '../runtime/day-worker.mjs';
import { encodePredictedDay, compressDayPacket } from '../packets/compression.mjs';

export class ChartDayError extends Error {
  constructor(code, message, status = 503, retryAfter = 5) {
    super(message); this.code = code; this.status = status; this.retryAfter = retryAfter;
  }
}
export function validateNatalDate(date) {
  const moment = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  if (!Number.isFinite(moment) || new Date(moment).toISOString().slice(0, 10) !== date || date < '1801-01-01' || date > '2399-12-31') {
    throw new ChartDayError('invalid_date', 'Нужна корректная дата рождения с 1801 по 2399 год.', 422, null);
  }
}
export function validateNatalZone(timezone) {
  if (typeof timezone !== 'string' || !timezone || timezone.length > 160 || !/^[A-Za-z0-9_+\-/]+$/.test(timezone)) {
    throw new ChartDayError('invalid_timezone', 'Некорректный часовой пояс города.', 422, null);
  }
}
export function generateChartDay({ root, date, timezone, spawnWorker, timeoutMs = 30_000, maxOutputBytes = 2_000_000 }) {
  validateNatalDate(date); validateNatalZone(timezone);
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
    try { validateNatalDate(date); validateNatalZone(timezone); } catch (error) { return Promise.reject(error); }
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
  return { get, get size() { prune(); return memory.size; }, get queued() { return queue.length; } };
}
