import { consumeJob } from '../runtime/job-consumers.mjs';
import { encodeNatalDayColumn, encodeNatalDay } from '../packets/encode.mjs';
import { runJsonWorker } from '../runtime/json-worker.mjs';
import { encodePredictedDay, compressDayPacket } from '../packets/compression.mjs';

export class NatalDayError extends Error {
  constructor(code, message, status = 503, retryAfter = 5) {
    super(message); this.code = code; this.status = status; this.retryAfter = retryAfter;
  }
}
export function validateNatalDate(date) {
  const moment = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  if (!Number.isFinite(moment) || new Date(moment).toISOString().slice(0, 10) !== date || date < '1801-01-01' || date > '2399-12-31') {
    throw new NatalDayError('invalid_date', 'Нужна корректная дата рождения с 1801 по 2399 год.', 422, null);
  }
}
export function validateNatalZone(timezone) {
  if (typeof timezone !== 'string' || !timezone || timezone.length > 160 || !/^[A-Za-z0-9_+\-/]+$/.test(timezone)) {
    throw new NatalDayError('invalid_timezone', 'Некорректный часовой пояс города.', 422, null);
  }
}
export function generateNatalDay({ root, date, timezone, spawnWorker, computeQueue, signal, priority, timeoutMs = 30_000, maxOutputBytes = 2_000_000 }) {
  validateNatalDate(date); validateNatalZone(timezone);
  const unavailable = () => new NatalDayError('natal_day_unavailable', 'Не удалось подготовить день рождения. Повторите попытку.');
  return runJsonWorker({
    root, script: 'natal_day.py', input: { date, timezone }, spawnWorker, computeQueue, signal, priority, timeoutMs, maxOutput: maxOutputBytes, unavailable,
    timeoutError: () => new NatalDayError('natal_day_timeout', 'День рождения не успел рассчитаться. Повторите попытку.'),
    validate(day) {
      if (!day) throw unavailable();
      if (day.error) {
        const known = ['invalid_date', 'unsupported_date', 'invalid_timezone', 'nonexistent_date'].includes(day.error);
        throw known ? new NatalDayError(day.error, day.message, 422, null) : unavailable();
      }
      if (day.date !== date || day.timezone !== timezone) throw unavailable();
      return day;
    },
  });
}
export function encodeNatalDayPacket(day) {
  return encodePredictedDay(day, encodeNatalDayColumn, encodeNatalDay);
}

// Only bounded, short-lived RAM. No personal disk cache, persistent workers,
// prewarming, request logging, or birth data in a public/cacheable URL.
export function createNatalDays({ root, computeQueue, calculationVersion = null, generateDay = (date, timezone, options) => generateNatalDay({ root, date, timezone, computeQueue, ...options }),
  now = Date.now, capacity = 4, ttlMs = 600_000, maxQueued = 3 } = {}) {
  if (calculationVersion !== null && (typeof calculationVersion !== 'string' || !/^[a-f0-9]{64}$/.test(calculationVersion))) throw new TypeError('Invalid calculation version');
  const memory = new Map(), pending = new Map(), queue = [];
  let running = false;
  const aborted = () => new DOMException('Запрос отменён.', 'AbortError');
  function prune() { for (const [key, entry] of memory) if (entry.expires <= now()) memory.delete(key); }
  function consume(job, signal) {
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
    const job = queue.shift();
    try {
      // Abandoned packing may finish while a retry is waiting in this queue.
      prune();
      if (memory.has(job.key)) {
        const entry = memory.get(job.key); memory.delete(job.key); memory.set(job.key, entry);
        job.resolve(entry.packet); return;
      }
      const day = await generateDay(job.date, job.timezone, { signal: job.controller.signal });
      if (job.controller.signal.aborted) throw aborted();
      if (day.date !== job.date || day.timezone !== job.timezone) throw new Error('Unexpected natal day');
      const raw = await encodeNatalDayPacket(calculationVersion ? { ...day, calculationVersion } : day);
      const packet = { bytes: await compressDayPacket(raw, { quality: 9 }) };
      prune(); memory.set(job.key, { packet, expires: now() + ttlMs });
      while (memory.size > capacity) memory.delete(memory.keys().next().value);
      job.resolve(packet);
    } catch (error) { job.reject(error); }
    finally { if (pending.get(job.key) === job) pending.delete(job.key); running = false; void drain(); }
  }
  function get(date, timezone, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(aborted());
    try { validateNatalDate(date); validateNatalZone(timezone); } catch (error) { return Promise.reject(error); }
    const key = `${date}@${timezone}`;
    prune();
    if (memory.has(key)) {
      const entry = memory.get(key); memory.delete(key); memory.set(key, entry);
      return Promise.resolve(entry.packet);
    }
    if (pending.has(key)) return consume(pending.get(key), signal);
    if (queue.length >= maxQueued) return Promise.reject(new NatalDayError('natal_day_busy', 'Подождите завершения расчёта дня рождения и повторите попытку.', 503, 2));
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const job = { key, date, timezone, controller: new AbortController(), resolve, reject, promise };
    pending.set(key, job); queue.push(job);
    const result = consume(job, signal); void drain();
    return result;
  }
  return { get, calculationVersion, get size() { prune(); return memory.size; }, get queued() { return queue.length; } };
}
