import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LIFETIME_PLANETS, LIFETIME_STEP_SECONDS, LIFETIME_FILE_VERSION, LIFETIME_FILE_FORMAT, LIFETIME_PROVENANCE_INPUTS, LIFETIME_FIELDS, LIFETIME_POINT_BYTES } from '../../shared/lifetime-format.js';

import { PERSONALITY_COLUMN, DESIGN_COLUMN, DESIGN_UNIX_SECONDS_COLUMN, DESIGN_RESIDUAL_COLUMN, validMomentValue } from '../../shared/day-packets/moment-columns.js';

import { LIFETIME_EXACT_VERSION } from '../../shared/lifetime-exact-format.js';
import { consumeJob, aborted } from '../runtime/job-consumers.mjs';
import { inputFingerprint, calculationVersion } from '../runtime/calculation-version.mjs';

const MAX_METADATA_BYTES = 16_384;

export function lifetimeFileFingerprint(root) {
  return inputFingerprint(root, LIFETIME_PROVENANCE_INPUTS);
}

// One owner opens the completed file on demand. A later request can find it
// after preparation; ready requests share one verified file and moment cache.
export function createLifetimeService({ root = fileURLToPath(new URL('../../', import.meta.url)),
  file = path.join(root, '.cache/lifetime/lifetime-1801-2400.f64le'), calculate, calculationVersion: version = null } = {}) {
  let source = null, moments = null, opening = null, closing = null, closed = false;
  function ready() {
    if (closed) return Promise.reject(unavailable());
    if (moments) return Promise.resolve(moments);
    if (!opening) opening = (async () => {
      const opened = await createLifetimeFile({ file, metadataFile: file.replace(/\.f64le$/, '.metadata.json'), root });
      try {
        const calculationFingerprint = version || await calculationVersion(root);
        if (closed) throw unavailable();
        moments = createLifetimeMoments({ lifetimeFile: opened, calculate, calculationFingerprint });
        source = opened;
        return moments;
      } catch (error) { await opened.close(); throw error; }
    })().finally(() => { opening = null; });
    return opening;
  }
  return {
    async getMetadata() { return (await ready()).metadata; },
    async getMoment(index, options) { return (await ready()).getMoment(index, options); },
    async getUtcMoment(utc, options) { return (await ready()).getUtcMoment(utc, options); },
    close() {
      if (!closing) {
        closed = true;
        closing = (async () => { await opening?.catch(() => {}); await source?.close(); })();
      }
      return closing;
    },
  };
}

export class LifetimeError extends Error {
  constructor(code, message, status = 503) {
    super(message); this.code = code; this.status = status;
  }
}
const unavailable = () => new LifetimeError('lifetime_unavailable', 'Данные летописи недоступны.');
const invalidIndex = () => new LifetimeError('invalid_index', 'Выберите момент в пределах шкалы.', 400);
const designUnavailable = () => new LifetimeError('lifetime_unavailable', 'Не удалось рассчитать Дизайн. Повторите попытку.');
const busy = () => new LifetimeError('busy', 'Подождите завершения текущего расчёта и повторите попытку.');

export const LIFETIME_MOMENT_LIMITS = Object.freeze({ cacheEntries: 1024, pending: 4, readConcurrency: 4, pendingReads: 1024 });

function momentUtc(value) {
  const milliseconds = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds) || ![new Date(milliseconds).toISOString(), new Date(milliseconds).toISOString().replace('.000Z', 'Z')].includes(value)) {
    throw new LifetimeError('invalid_utc', 'Нужен корректный момент UTC.', 400);
  }
  if (milliseconds < Date.UTC(1801, 0, 1) || milliseconds >= Date.UTC(2400, 0, 1)) {
    throw new LifetimeError('unsupported_date', 'Доступны даты с 1801 по 2399 год.', 422);
  }
  return new Date(milliseconds).toISOString().replace('.000Z', 'Z');
}

const validLongitudes = values => Array.isArray(values) && values.length === LIFETIME_PLANETS.length
  && values.every(value => Number.isFinite(value) && value >= 0 && value < 360);

function validatedDesign(point, utc, engine = null) {
  if (point?.error === 'busy') throw busy();
  const moment = Date.parse(point?.designUtc), selected = Date.parse(utc);
  if (point?.error || (engine !== null && (typeof engine !== 'string' || point?.engine !== engine))
      || point?.utc !== utc || !Number.isFinite(moment)
      || moment >= selected || moment < selected - 110 * 86_400_000
      || !Number.isFinite(point?.designArcResidualDegrees) || point.designArcResidualDegrees < 0 || point.designArcResidualDegrees > 1e-7
      || !validLongitudes(point?.longitudes)) throw designUnavailable();
  return Object.freeze({ utc, designUtc: point.designUtc, designArcResidualDegrees: point.designArcResidualDegrees,
    longitudes: Object.freeze([...point.longitudes]) });
}

// One bounded cache holds complete moments. Grid reads and off-grid scalar
// calculations have separate admission, so a busy calculator cannot block disk.
export function createLifetimeMoments({ lifetimeFile, calculate, capacity = LIFETIME_MOMENT_LIMITS.cacheEntries,
  maxPending = LIFETIME_MOMENT_LIMITS.pending, calculationFingerprint = null } = {}) {
  if (!lifetimeFile) return null;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > LIFETIME_MOMENT_LIMITS.cacheEntries
      || !Number.isInteger(maxPending) || maxPending < 1 || maxPending > LIFETIME_MOMENT_LIMITS.pending) throw new RangeError('Invalid lifetime cache limits');
  if (calculationFingerprint !== null && !/^[a-f0-9]{64}$/.test(calculationFingerprint)) throw new RangeError('Invalid calculation fingerprint');
  const metadata = calculationFingerprint && lifetimeFile.cacheIdentity
    ? Object.freeze({ ...lifetimeFile.metadata, calculationVersion: calculationFingerprint, cacheVersion: createHash('sha256')
      .update(`lifetime-moment-v${LIFETIME_EXACT_VERSION}\0${lifetimeFile.cacheIdentity}\0${calculationFingerprint}`).digest('hex') })
    : lifetimeFile.metadata;
  const completed = new Map(), reads = new Map(), exact = new Map(), readQueue = [];
  let activeReads = 0;
  function remember(utc, value) {
    completed.delete(utc); completed.set(utc, value);
    while (completed.size > capacity) completed.delete(completed.keys().next().value);
    return value;
  }
  function drainReads() {
    while (activeReads < LIFETIME_MOMENT_LIMITS.readConcurrency && readQueue.length) {
      const job = readQueue.shift(), { index, utc, resolve, reject } = job;
      job.started = true; activeReads++;
      Promise.resolve().then(() => lifetimeFile.getPoint(index)).then(point => {
        if (point?.index !== index || point?.utc !== utc || !validLongitudes(point?.longitudes)) throw unavailable();
        const design = validatedDesign(point.design, utc);
        return remember(utc, Object.freeze({ index, utc, longitudes: Object.freeze([...point.longitudes]), design }));
      }).catch(error => { throw error instanceof LifetimeError ? error : unavailable(); })
        .finally(() => { reads.delete(index); activeReads--; drainReads(); })
        .then(resolve, reject);
    }
  }
  function consumeRead(job, signal) {
    return consumeJob(job, signal, abandoned => {
      if (abandoned.started) return; // A small file read completes and remains reusable.
      const index = readQueue.indexOf(abandoned); if (index >= 0) readQueue.splice(index, 1);
      reads.delete(abandoned.index); abandoned.reject(aborted());
    });
  }
  async function getMoment(index, { signal } = {}) {
    if (signal?.aborted) throw aborted();
    if (!Number.isSafeInteger(index) || index < 0 || index >= metadata?.samples) throw invalidIndex();
    const utc = momentUtc(new Date(Date.parse(metadata.startUtc) + index * metadata.stepSeconds * 1000).toISOString());
    if (completed.has(utc)) return remember(utc, completed.get(utc));
    if (reads.has(index)) return consumeRead(reads.get(index), signal);
    // Queue small prepared reads separately; scalar admission never rejects a
    // normal read burst. Bound retained requests as well as active file reads.
    if (reads.size >= LIFETIME_MOMENT_LIMITS.pendingReads) throw busy();
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const job = { index, utc, promise, resolve, reject, started: false };
    reads.set(index, job); readQueue.push(job);
    const result = consumeRead(job, signal); drainReads(); return result;
  }
  async function getUtcMoment(value, { signal } = {}) {
    if (signal?.aborted) throw aborted();
    const utc = momentUtc(value), milliseconds = Date.parse(utc), start = Date.parse(metadata.startUtc);
    if (milliseconds < start || milliseconds >= Date.parse(metadata.endExclusiveUtc)) {
      throw new LifetimeError('date_out_of_range', 'Выберите момент в пределах шкалы.', 422);
    }
    const index = (milliseconds - start) / (metadata.stepSeconds * 1000);
    if (Number.isInteger(index)) return getMoment(index, { signal });
    if (completed.has(utc)) return remember(utc, completed.get(utc));
    if (exact.has(utc)) return consumeExact(exact.get(utc), signal);
    if (exact.size >= maxPending) throw busy();
    if (typeof calculate !== 'function') throw unavailable();
    const job = { controller: new AbortController(), promise: null };
    job.promise = Promise.resolve().then(async () => {
      const point = await calculate({ mode: 'transit_moment', utc }, { signal: job.controller.signal });
      if (job.controller.signal.aborted) throw aborted();
      if (point?.error === 'busy') throw busy();
      if (point?.error || point?.utc !== utc || point?.engine !== metadata.engine || !validLongitudes(point?.longitudes)) throw unavailable();
      const design = validatedDesign(point.design, utc, metadata.engine);
      return remember(utc, Object.freeze({ utc, longitudes: Object.freeze([...point.longitudes]), design }));
    }).catch(error => { throw error instanceof LifetimeError || error?.name === 'AbortError' ? error : unavailable(); })
      .finally(() => { if (exact.get(utc) === job) exact.delete(utc); });
    exact.set(utc, job);
    return consumeExact(job, signal);
  }
  function consumeExact(job, signal) {
    return consumeJob(job, signal, abandoned => {
      abandoned.controller.abort();
      for (const [key, value] of exact) if (value === abandoned) exact.delete(key);
    });
  }
  return { metadata, getMoment, getUtcMoment };
}

function epoch(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) throw unavailable();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value.replace('Z', '.000Z')) throw unavailable();
  return milliseconds;
}

function validateMetadata(input) {
  if (input?.version !== LIFETIME_FILE_VERSION || input?.format !== LIFETIME_FILE_FORMAT) {
    throw new LifetimeError('lifetime_unavailable', 'Нужен полный файл летописи версии 3. Подготовьте его заново.');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || input.version !== LIFETIME_FILE_VERSION || input.format !== LIFETIME_FILE_FORMAT
    || !Array.isArray(input.columns) || input.columns.length !== LIFETIME_FIELDS.length
    || input.columns.some((planet, index) => planet !== LIFETIME_FIELDS[index])
    || !Number.isSafeInteger(input.sampleCount) || input.sampleCount < 1
    || input.stepSeconds !== LIFETIME_STEP_SECONDS || input.flags !== 258
    || typeof input.engine !== 'string' || !/^Swiss Ephemeris \d+(?:\.\d+){1,3}$/.test(input.engine)
    || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)) throw unavailable();
  const start = epoch(input.startUtc), end = epoch(input.endExclusiveUtc);
  const bytes = input.sampleCount * LIFETIME_POINT_BYTES;
  if (!Number.isSafeInteger(bytes) || input.bytes !== bytes
    || start < Date.UTC(1801, 0, 1) || end > Date.UTC(2400, 0, 1)
    || end - start !== input.sampleCount * LIFETIME_STEP_SECONDS * 1000) throw unavailable();
  return { start, bytes, sha256: input.sha256, metadata: Object.freeze({ startUtc: input.startUtc, endExclusiveUtc: input.endExclusiveUtc,
    stepSeconds: LIFETIME_STEP_SECONDS, samples: input.sampleCount, planets: LIFETIME_PLANETS, engine: input.engine }) };
}

async function verifyDigest(handle, bytes, expected) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(Math.min(bytes, 1024 * 1024));
  let position = 0;
  while (position < bytes) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, bytes - position), position);
    if (!bytesRead) throw unavailable();
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (hash.digest('hex') !== expected) throw unavailable();
}

// The large file stays on disk. One positional read returns each full moment.
export async function createLifetimeFile({ file, metadataFile, root = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  if (!file && !metadataFile) return null;
  let handle;
  try {
    if (typeof file !== 'string' || !file || typeof metadataFile !== 'string' || !metadataFile) throw unavailable();
    const info = await fs.stat(metadataFile);
    if (!info.isFile() || info.size > MAX_METADATA_BYTES) throw unavailable();
    const input = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
    const validated = validateMetadata(input);
    if (input.provenance?.version !== '1'
        || typeof input.provenance.calculationFingerprint !== 'string'
        || input.provenance.calculationFingerprint !== await lifetimeFileFingerprint(root)) throw unavailable();
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== validated.bytes) throw unavailable();
    // Verify every byte once with bounded memory before accepting requests.
    await verifyDigest(handle, validated.bytes, validated.sha256);
    const { metadata, start } = validated;
    const cacheIdentity = createHash('sha256').update(JSON.stringify([
      LIFETIME_FILE_VERSION, LIFETIME_FILE_FORMAT, validated.sha256, metadata,
    ])).digest('hex');
    const pending = new Set();
    let accepting = true, closing;

    async function readPoint(index) {
      const bytes = Buffer.allocUnsafe(LIFETIME_POINT_BYTES);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, index * LIFETIME_POINT_BYTES);
      if (bytesRead !== bytes.length) throw unavailable();
      const values = LIFETIME_FIELDS.map((_, column) => bytes.readDoubleLE(column * 8));
      if (!values.every(validMomentValue)) throw unavailable();
      const utc = new Date(start + index * LIFETIME_STEP_SECONDS * 1000).toISOString().replace('.000Z', 'Z');
      const design = validatedDesign({ utc,
        designUtc: new Date(values[DESIGN_UNIX_SECONDS_COLUMN] * 1000).toISOString().replace('.000Z', 'Z'),
        designArcResidualDegrees: values[DESIGN_RESIDUAL_COLUMN],
        longitudes: values.slice(DESIGN_COLUMN, DESIGN_UNIX_SECONDS_COLUMN),
      }, utc);
      return { index, utc, longitudes: values.slice(PERSONALITY_COLUMN, DESIGN_COLUMN), design };
    }

    return {
      metadata,
      cacheIdentity,
      provenanceVerified: true,
      getPoint(index) {
        if (!accepting) return Promise.reject(unavailable());
        if (!Number.isSafeInteger(index) || index < 0 || index >= metadata.samples) return Promise.reject(invalidIndex());
        const result = readPoint(index);
        pending.add(result);
        result.then(() => pending.delete(result), () => pending.delete(result));
        return result;
      },
      close() {
        if (!closing) {
          accepting = false;
          closing = Promise.allSettled([...pending]).then(() => handle.close());
        }
        return closing;
      },
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error?.code === 'ENOENT' && [file, metadataFile].includes(error.path))
      throw new LifetimeError('lifetime_preparing', 'Создаём летопись');
    throw error instanceof LifetimeError ? error : unavailable();
  }
}
