import { consumeJob } from '../runtime/job-consumers.mjs';
import { runJsonWorker } from '../runtime/json-worker.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cycleUtcMilliseconds as parseCycleUtc, validCycleResult } from '../../shared/cycles-format.js';

// Device results are keyed by calculation inputs, independent of UI releases.
export async function cyclesCalculationFingerprint(root) {
  const hash = createHash('sha256');
  for (const name of ['server/python/cycles.py', 'server/python/astronomy.py', 'server/python/civil_time.py', 'server/python/errors.py',
    'requirements.txt', 'server/services/cycles.mjs', 'shared/cycles-format.js', 'data/ephe/sepl_18.se1', 'data/ephe/semo_18.se1', 'data/ephe/seas_18.se1']) {
    const bytes = await fs.readFile(path.join(root, name)).catch(error => {
      // Chiron already reports unavailable data per body; its absence must
      // not prevent the rest of the application from starting.
      if (name === 'data/ephe/seas_18.se1' && error.code === 'ENOENT') return null;
      throw error;
    });
    hash.update(`${name}\0${bytes?.length ?? -1}\0`);
    if (bytes) hash.update(bytes);
  }
  return hash.digest('hex');
}

export const CYCLE_BODIES = Object.freeze(['sun', 'moon', 'north_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'uranus_opposition', 'neptune', 'pluto', 'chiron']);
export const CYCLE_LIMITS = Object.freeze({ concurrency: 2, maxQueued: 12, timeoutMs: 45_000, outputBytes: 2_000_000,
  capacity: 24, memoryBytes: 6_000_000, ttlMs: 600_000 });
const YEAR_MS = 365.2425 * 86400000;

export class CycleError extends Error {
  constructor(code, message, status = 503, retryAfter = 3, details = {}) {
    super(message); this.code = code; this.status = status; this.retryAfter = retryAfter; this.details = details;
  }
}
const invalid = (code, message) => new CycleError(code, message, 422, null);
export function cycleUtcMilliseconds(value) {
  const milliseconds = parseCycleUtc(value);
  if (!Number.isFinite(milliseconds)) throw invalid('invalid_datetime', 'Нужен корректный точный момент UTC с датой и временем.');
  if (value < '1801-01-01' || value >= '2400-01-01') throw invalid('unsupported_date', 'Доступны даты с 1801 по 2399 год.');
  return milliseconds;
}

export function validateCycleRequest(input, action) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CycleError('invalid_request', 'Некорректные данные циклов.', 400, null);
  const birth = cycleUtcMilliseconds(input.birthUtc);
  if (!CYCLE_BODIES.includes(input.body)) throw invalid('invalid_body', 'Неизвестный вид возврата.');
  const result = { action, birthUtc: input.birthUtc, body: input.body };
  if (action === 'events') {
    const fromAge = input.fromAge ?? 0, toAge = input.toAge ?? 100;
    if (![fromAge, toAge].every(value => typeof value === 'number' && Number.isFinite(value)) || fromAge < 0 || fromAge >= toAge || toAge > 300 || toAge - fromAge > 120) throw invalid('invalid_range', 'Выберите возраст от 0 до 300 лет, не больше 120 лет за один запрос.');
    if (birth + toAge * YEAR_MS >= Date.UTC(2400, 0, 1)) throw invalid('unsupported_date', 'Диапазон возвратов выходит за доступные эфемериды: до конца 2399 года.');
    return { ...result, fromAge, toAge };
  }
  if (action === 'chart') {
    const event = cycleUtcMilliseconds(input.eventUtc), age = (event - birth) / YEAR_MS;
    if (age <= 0 || age > 300) throw invalid('invalid_event', 'Момент возврата должен быть после рождения в пределах 300 лет.');
    const timezone = input.timezone ?? 'UTC';
    if (typeof timezone !== 'string' || !timezone || timezone.length > 160 || !/^[A-Za-z0-9_+\-/]+$/.test(timezone)) throw invalid('invalid_timezone', 'Неизвестный часовой пояс.');
    return { ...result, eventUtc: input.eventUtc, timezone };
  }
  throw new CycleError('invalid_request', 'Неизвестный режим циклов.', 400, null);
}

function validateResult(result, input) {
  const unavailable = () => new CycleError('cycles_unavailable', 'Не удалось подготовить циклы. Повторите попытку.');
  if (!result || typeof result !== 'object') throw unavailable();
  if (result.error) {
    const known = ['invalid_datetime', 'unsupported_date', 'invalid_body', 'invalid_range', 'invalid_event', 'invalid_timezone', 'ephemeris_unavailable'].includes(result.error);
    throw known ? new CycleError(result.error, result.message, 422, null, result.body === input.body ? { body: result.body } : {}) : unavailable();
  }
  if (input.action === 'events' && result.events?.length > 2000) throw unavailable();
  if (!validCycleResult(input.action, result, input)) throw unavailable();
  return result;
}

// Worker transport returns parsed JSON; drain owns semantic validation and error mapping
// for both this worker and injected generators, before any result enters RAM or HTTP.
export function generateCycles({ root, input, verifiedEvent, spawnWorker, computeQueue, signal, timeoutMs = CYCLE_LIMITS.timeoutMs, maxOutputBytes = CYCLE_LIMITS.outputBytes }) {
  const request = validateCycleRequest(input, input.action);
  return runJsonWorker({ root, script: 'cycles.py', input: verifiedEvent ? { ...request, verifiedEvent } : request, spawnWorker, computeQueue, signal, timeoutMs, maxOutput: maxOutputBytes,
    unavailable: () => new CycleError('cycles_unavailable', 'Локальный движок циклов недоступен. Повторите попытку.'),
    timeoutError: () => new CycleError('cycles_timeout', 'Циклы не успели рассчитаться. Попробуйте меньший диапазон.') });
}

// Personal events stay only in a bounded, expiring RAM cache. Singleflight jobs
// share a worker; admission remains occupied until its process actually closes.
export function createCycles({ root, computeQueue, generate = (input, trusted) => generateCycles({ root, input, computeQueue, ...trusted }), now = Date.now, limits = {}, cacheVersion = null } = {}) {
  if (cacheVersion !== null && !/^[a-f0-9]{64}$/.test(cacheVersion)) throw new RangeError('Invalid cycles version');
  const settings = { ...CYCLE_LIMITS, ...limits }, memory = new Map(), pending = new Map(), queue = [];
  let running = 0, bytes = 0, accepting = true, closing = null;
  const activeWork = new Set();
  const aborted = () => new DOMException('Запрос отменён.', 'AbortError');
  function remove(key) { bytes -= memory.get(key).bytes; memory.delete(key); }
  function prune() { for (const [key, entry] of memory) if (entry.expires <= now()) remove(key); }
  function consume(job, signal) {
    return consumeJob(job, signal, abandoned => {
      const index = queue.indexOf(abandoned);
      if (index >= 0) { queue.splice(index, 1); pending.delete(abandoned.key); abandoned.reject(aborted()); }
      if (pending.get(abandoned.key) === abandoned) pending.delete(abandoned.key);
      abandoned.controller.abort();
    });
  }

  function knownEvent(input) {
    if (input.action !== 'chart') return undefined;
    for (const entry of memory.values()) {
      if (entry.input.birthUtc !== input.birthUtc || entry.input.body !== input.body) continue;
      const event = entry.result.events?.find(event => event.utc === input.eventUtc) || entry.result.event;
      if (event?.utc === input.eventUtc) return event;
    }
    return undefined;
  }
  async function drain() {
    while (accepting && running < settings.concurrency && queue.length) {
      const job = queue.shift(); running++;
      const work = (async () => {
        try {
          prune();
          const result = validateResult(await generate(job.input, { verifiedEvent: knownEvent(job.input), signal: job.controller.signal }), job.input), size = Buffer.byteLength(JSON.stringify(result));
          if (job.controller.signal.aborted) throw aborted();
          prune();
          if (accepting && size <= settings.memoryBytes) {
            memory.set(job.key, { input: job.input, result, bytes: size, expires: now() + settings.ttlMs }); bytes += size;
            while (memory.size > settings.capacity || bytes > settings.memoryBytes) remove(memory.keys().next().value);
          }
          job.resolve(result);
        } catch (error) { job.reject(error); }
        finally { if (pending.get(job.key) === job) pending.delete(job.key); running--; void drain(); }
      })();
      activeWork.add(work);
      void work.finally(() => activeWork.delete(work));
    }
  }
  function get(input, action, signal) {
    if (signal?.aborted) return Promise.reject(aborted());
    if (!accepting) return Promise.reject(new CycleError('cycles_unavailable', 'Расчёт циклов остановлен.'));
    let request;
    try { request = validateCycleRequest(input, action); } catch (error) { return Promise.reject(error); }
    const key = JSON.stringify(request); prune();
    if (memory.has(key)) { const entry = memory.get(key); memory.delete(key); memory.set(key, entry); return Promise.resolve(entry.result); }
    if (pending.has(key)) return consume(pending.get(key), signal);
    if (running >= settings.concurrency && queue.length >= settings.maxQueued) return Promise.reject(new CycleError('cycles_busy', 'Подождите завершения расчёта циклов и повторите попытку.'));
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const job = { key, controller: new AbortController(), input: request, resolve, reject, promise };
    pending.set(key, job); queue.push(job);
    const result = consume(job, signal); void drain();
    return result;
  }
  function close() {
    if (closing) return closing;
    accepting = false;
    for (const job of queue.splice(0)) {
      pending.delete(job.key);
      job.reject(new CycleError('cycles_unavailable', 'Расчёт циклов остановлен.'));
    }
    memory.clear(); bytes = 0;
    // JSON workers retain their admission until their process closes. Their
    // existing timeout bounds draining; no completed birth data is retained.
    closing = Promise.allSettled([...activeWork]).then(() => {});
    return closing;
  }
  return { close, cacheVersion, events: (input, { signal } = {}) => get(input, 'events', signal), chart: (input, { signal } = {}) => get(input, 'chart', signal),
    get size() { prune(); return memory.size; }, get queued() { return queue.length; }, get active() { return running; } };
}
