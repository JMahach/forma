import { SUPPORTED_START, SUPPORTED_END_EXCLUSIVE, LIFE_SPAN_YEARS } from '../../shared/date-limits.js';
import { createComputeQueue } from '../runtime/compute-queue.mjs';
import { consumeJob } from '../runtime/job-consumers.mjs';
import { runJsonWorker } from '../runtime/json-worker.mjs';
import { inputFingerprint } from '../runtime/calculation-version.mjs';
import { cycleUtcMilliseconds as parseCycleUtc, validCycleResult } from '../../shared/cycles-format.js';

// Device results are keyed by calculation inputs, independent of UI releases.
export function cyclesCalculationFingerprint(root) {
  // Recurse over all installed inputs, including optional time-conversion files.
  // Missing Chiron data changes the revision without blocking other bodies.
  return inputFingerprint(root, ['server/python/cycles.py', 'server/python/return_index.py', 'server/python/astronomy.py',
    'server/python/civil_time.py', 'server/python/date_limits.py', 'server/python/errors.py',
    'requirements.txt', 'shared/cycles-format.js', 'shared/date-limits.js', 'data/ephe']);
}

export const CYCLE_BODIES = Object.freeze(['sun', 'moon', 'north_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'uranus_opposition', 'neptune', 'pluto', 'chiron']);
export const CYCLE_LIMITS = Object.freeze({ concurrency: 2, maxQueued: 12,
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
  if (milliseconds < SUPPORTED_START || milliseconds >= SUPPORTED_END_EXCLUSIVE) throw invalid('unsupported_date', 'Доступны даты с 1801 по 2399 год.');
  return milliseconds;
}

export function validateCycleRequest(input, action) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CycleError('invalid_request', 'Некорректные данные циклов.', 400, null);
  const birth = cycleUtcMilliseconds(input.birthUtc);
  if (!CYCLE_BODIES.includes(input.body)) throw invalid('invalid_body', 'Неизвестный вид возврата.');
  const result = { action, birthUtc: input.birthUtc, body: input.body };
  if (action === 'events') {
    const fromAge = input.fromAge ?? 0, toAge = input.toAge ?? LIFE_SPAN_YEARS;
    if (![fromAge, toAge].every(value => typeof value === 'number' && Number.isFinite(value)) || fromAge < 0 || fromAge >= toAge || toAge > 300 || toAge - fromAge > 120) throw invalid('invalid_range', 'Выберите возраст от 0 до 300 лет, не больше 120 лет за один запрос.');
    if (birth + toAge * YEAR_MS >= SUPPORTED_END_EXCLUSIVE) throw invalid('unsupported_date', 'Диапазон возвратов выходит за доступные эфемериды: до конца 2399 года.');
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
    if (result.error === 'return_index_unavailable') throw new CycleError(result.error, result.message);
    const known = ['invalid_datetime', 'unsupported_date', 'invalid_body', 'invalid_range', 'invalid_event', 'invalid_timezone', 'ephemeris_unavailable'].includes(result.error);
    throw known ? new CycleError(result.error, result.message, 422, null, result.body === input.body ? { body: result.body } : {}) : unavailable();
  }
  if (input.action === 'events' && result.events?.length > 2000) throw unavailable();
  if (!validCycleResult(input.action, result, input)) throw unavailable();
  return result;
}

// Worker transport returns parsed JSON; drain owns semantic validation and error mapping
// for both this worker and injected generators, before any result enters RAM or HTTP.
export function generateCycles({ root, input, spawnWorker, computeQueue, signal, timeoutMs = 45_000, maxOutputBytes = 2_000_000 }) {
  const request = validateCycleRequest(input, input.action);
  return runJsonWorker({ root, script: 'cycles.py', input: request, spawnWorker, computeQueue, signal, timeoutMs, maxOutput: maxOutputBytes,
    unavailable: () => new CycleError('cycles_unavailable', 'Локальный движок циклов недоступен. Повторите попытку.'),
    timeoutError: () => new CycleError('cycles_timeout', 'Циклы не успели рассчитаться. Попробуйте меньший диапазон.') });
}

// This service owns results and shared consumers. The server's one compute
// queue owns admission; an exact chart takes priority over background dates.
export function createCycles({ root, computeQueue, generate = (input, options) => generateCycles({ root, input, ...options }), now = Date.now, limits = {}, cacheVersion = null } = {}) {
  if (cacheVersion !== null && !/^[a-f0-9]{64}$/.test(cacheVersion)) throw new RangeError('Invalid cycles version');
  const { concurrency, maxQueued, capacity, memoryBytes, ttlMs } = { ...CYCLE_LIMITS, ...limits };
  const memory = new Map(), pending = new Map(), jobs = new Set();
  const queue = computeQueue || createComputeQueue({ concurrency, maxQueued });
  let bytes = 0, accepting = true, closing = null;
  const aborted = () => new DOMException('Запрос отменён.', 'AbortError');
  const stopped = () => new CycleError('cycles_unavailable', 'Расчёт циклов остановлен.');
  function remove(key) { bytes -= memory.get(key).bytes; memory.delete(key); }
  function prune() { for (const [key, entry] of memory) if (entry.expires <= now()) remove(key); }
  function consume(job, signal) {
    return consumeJob(job, signal, abandoned => {
      if (pending.get(abandoned.key) === abandoned) pending.delete(abandoned.key);
      abandoned.controller.abort();
    });
  }
  function get(input, action, signal) {
    if (signal?.aborted) return Promise.reject(aborted());
    if (!accepting) return Promise.reject(stopped());
    let request;
    try { request = validateCycleRequest(input, action); } catch (error) { return Promise.reject(error); }
    const key = JSON.stringify(request); prune();
    if (memory.has(key)) { const entry = memory.get(key); memory.delete(key); memory.set(key, entry); return Promise.resolve(entry.result); }
    if (pending.has(key)) return consume(pending.get(key), signal);
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const job = { key, controller: new AbortController(), started: false, resolve, reject, promise, work: null };
    pending.set(key, job); jobs.add(job);
    const result = consume(job, signal);
    job.work = queue.run(async () => {
      job.started = true;
      const result = validateResult(await generate(request, { signal: job.controller.signal }), request);
      if (job.controller.signal.aborted) throw aborted();
      const size = Buffer.byteLength(JSON.stringify(result));
      prune();
      if (accepting && size <= memoryBytes) {
        memory.set(key, { result, bytes: size, expires: now() + ttlMs }); bytes += size;
        while (memory.size > capacity || bytes > memoryBytes) remove(memory.keys().next().value);
      }
      return result;
    }, { signal: job.controller.signal, priority: action === 'chart' ? 1 : 0 }).finally(() => {
      if (pending.get(key) === job) pending.delete(key);
      jobs.delete(job);
    }).then(resolve, error => {
      reject(!accepting && !job.started ? stopped() : error.code === 'busy'
        ? new CycleError('cycles_busy', 'Подождите завершения расчёта циклов и повторите попытку.') : error);
    });
    return result;
  }
  function close() {
    if (closing) return closing;
    accepting = false;
    for (const job of jobs) if (!job.started) job.controller.abort();
    memory.clear(); bytes = 0;
    // Active workers finish or hit their existing timeout. Closing one service
    // never shuts down the server's queue used by other calculation services.
    closing = Promise.allSettled([...jobs].map(job => job.work)).then(() => { if (!computeQueue) queue.close(); });
    return closing;
  }
  return { close, cacheVersion, events: (input, { signal } = {}) => get(input, 'events', signal), chart: (input, { signal } = {}) => get(input, 'chart', signal),
    get size() { prune(); return memory.size; }, get queued() { return [...jobs].filter(job => !job.started && !job.controller.signal.aborted).length; },
    get active() { return [...jobs].filter(job => job.started).length; } };
}
