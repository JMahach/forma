import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LIFETIME_PLANETS, LIFETIME_STEP_SECONDS, LIFETIME_ARCHIVE_VERSION, LIFETIME_ARCHIVE_FORMAT, LIFETIME_PROVENANCE_INPUTS } from '../../shared/lifetime-format.js';

const MAX_METADATA_BYTES = 16_384;

async function inputFingerprint(root, names) {
  const hash = createHash('sha256');
  async function add(name) {
    const file = path.join(root, name), info = await fs.stat(file);
    if (info.isDirectory()) {
      const children = await fs.readdir(file);
      children.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (const child of children) await add(`${name}/${child}`);
    } else {
      const bytes = await fs.readFile(file);
      hash.update(`${name}\0${bytes.length}\0`).update(bytes);
    }
  }
  for (const name of names) await add(name);
  return hash.digest('hex');
}

export function lifetimeArchiveFingerprint(root) {
  return inputFingerprint(root, LIFETIME_PROVENANCE_INPUTS);
}

// Hash calculation inputs once at startup. UI releases keep the same URLs;
// changed ephemerides, exact-search rules or moment contracts cannot reuse them.
export function lifetimeCalculationFingerprint(root) {
  return inputFingerprint(root, ['server/python/astronomy.py', 'server/python/civil_time.py', 'server/python/errors.py',
    'server/python/calculator.py', 'server/python/design_worker.py', 'requirements.txt',
    'shared/lifetime-format.js', 'server/services/lifetime.mjs', 'data/ephe']);
}

export class LifetimeError extends Error {
  constructor(code, message, status = 503) {
    super(message); this.code = code; this.status = status;
  }
}
const unavailable = () => new LifetimeError('lifetime_unavailable', 'Данные шкалы лет недоступны.');
const invalidIndex = () => new LifetimeError('invalid_index', 'Выберите момент в пределах шкалы.', 400);
const designUnavailable = () => new LifetimeError('lifetime_unavailable', 'Не удалось рассчитать Дизайн. Повторите попытку.');
const busy = () => new LifetimeError('busy', 'Подождите завершения текущего расчёта и повторите попытку.');

export const LIFETIME_MOMENT_LIMITS = Object.freeze({ cacheEntries: 1024, pending: 4 });

function designUtc(value) {
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

function validatedDesign(point, utc, source) {
  if (point?.error === 'busy') throw busy();
  const moment = Date.parse(point?.designUtc), selected = Date.parse(utc);
  if (point?.error || typeof source !== 'string' || point?.engine !== source
      || point?.utc !== utc || !Number.isFinite(moment)
      || moment >= selected || moment < selected - 110 * 86_400_000
      || !Number.isFinite(point?.designArcResidualDegrees) || point.designArcResidualDegrees < 0 || point.designArcResidualDegrees > 1e-7
      || !validLongitudes(point?.longitudes)) throw designUnavailable();
  return Object.freeze({ utc, designUtc: point.designUtc, designArcResidualDegrees: point.designArcResidualDegrees,
    longitudes: Object.freeze([...point.longitudes]) });
}

// This cache belongs to one process and its fixed calculator/ephemeris inputs.
// Deploying new calculation rules creates a new service; nothing survives restart.
// Duplicate callers share work, while distinct pending moments remain bounded.
export function createLifetimeMoments({ archive, calculate, capacity = LIFETIME_MOMENT_LIMITS.cacheEntries,
  maxPending = LIFETIME_MOMENT_LIMITS.pending, calculationFingerprint = null } = {}) {
  if (!archive) return null;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > LIFETIME_MOMENT_LIMITS.cacheEntries
      || !Number.isInteger(maxPending) || maxPending < 1 || maxPending > LIFETIME_MOMENT_LIMITS.pending) throw new RangeError('Invalid lifetime cache limits');
  if (calculationFingerprint !== null && !/^[a-f0-9]{64}$/.test(calculationFingerprint)) throw new RangeError('Invalid calculation fingerprint');
  const metadata = calculationFingerprint && archive.cacheIdentity
    ? Object.freeze({ ...archive.metadata, cacheVersion: createHash('sha256')
      .update(`lifetime-moment-v1\0${archive.cacheIdentity}\0${calculationFingerprint}`).digest('hex') })
    : archive.metadata;
  const completed = new Map(), designs = new Map(), moments = new Map(), exact = new Map();
  function remember(utc, value) {
    completed.delete(utc); completed.set(utc, value);
    while (completed.size > capacity) completed.delete(completed.keys().next().value);
    return value;
  }
  async function getDesign(value) {
    const utc = designUtc(value);
    if (completed.has(utc)) return remember(utc, completed.get(utc)).design;
    if (designs.has(utc)) return designs.get(utc);
    if (designs.size + exact.size >= maxPending) throw busy();
    if (typeof calculate !== 'function') throw designUnavailable();
    const request = Promise.resolve().then(() => calculate({ mode: 'transit_design', utc }))
      .then(point => remember(utc, { design: validatedDesign(point, utc, archive.metadata?.source) }).design)
      .catch(error => { throw error instanceof LifetimeError ? error : designUnavailable(); })
      .finally(() => { designs.delete(utc); });
    designs.set(utc, request);
    return request;
  }
  async function getMoment(index) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= metadata?.samples) throw invalidIndex();
    const utc = designUtc(new Date(Date.parse(metadata.startUtc) + index * metadata.stepSeconds * 1000).toISOString());
    const cached = completed.get(utc);
    if (cached?.moment) return remember(utc, cached).moment;
    if (moments.has(index)) return moments.get(index);
    if (moments.size + exact.size >= maxPending) throw busy();
    const request = Promise.allSettled([Promise.resolve().then(() => archive.getPoint(index)), getDesign(utc)])
      .then(results => {
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
        const [point, design] = results.map(result => result.value);
        if (point?.index !== index || point?.utc !== utc || !validLongitudes(point?.longitudes)) throw unavailable();
        const moment = Object.freeze({ index, utc, longitudes: Object.freeze([...point.longitudes]), design });
        return remember(utc, { design, moment }).moment;
      }).finally(() => { moments.delete(index); });
    moments.set(index, request);
    return request;
  }
  async function getUtcMoment(value) {
    const utc = designUtc(value), milliseconds = Date.parse(utc), start = Date.parse(metadata.startUtc);
    if (milliseconds < start || milliseconds >= Date.parse(metadata.endExclusiveUtc)) {
      throw new LifetimeError('date_out_of_range', 'Выберите момент в пределах шкалы.', 422);
    }
    const index = (milliseconds - start) / (metadata.stepSeconds * 1000);
    if (Number.isInteger(index)) return getMoment(index);
    const cached = completed.get(utc);
    if (cached?.moment) return remember(utc, cached).moment;
    if (exact.has(utc)) return exact.get(utc);
    if (moments.size + exact.size >= maxPending
        || designs.size + exact.size >= maxPending) throw busy();
    if (typeof calculate !== 'function') throw unavailable();
    // Off-grid UTC computes both sides in one scalar worker under the common pool.
    // Grid moments already returned through getMoment and its existing Design path.
    const request = Promise.resolve().then(async () => {
      const point = await calculate({ mode: 'transit_moment', utc });
      if (point?.error === 'busy') throw busy();
      if (point?.error || point?.utc !== utc || point?.engine !== metadata.source || !validLongitudes(point?.longitudes)) throw unavailable();
      const design = validatedDesign(point.design, utc, metadata.source);
      const moment = Object.freeze({ utc, longitudes: Object.freeze([...point.longitudes]), design });
      return remember(utc, { design, moment }).moment;
    }).catch(error => { throw error instanceof LifetimeError ? error : unavailable(); })
      .finally(() => { exact.delete(utc); });
    exact.set(utc, request);
    return request;
  }
  return { metadata, getMoment, getUtcMoment, getDesign };
}

function epoch(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) throw unavailable();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value.replace('Z', '.000Z')) throw unavailable();
  return milliseconds;
}

function validateMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || input.version !== LIFETIME_ARCHIVE_VERSION || input.format !== LIFETIME_ARCHIVE_FORMAT
    || !Array.isArray(input.columns) || input.columns.length !== LIFETIME_PLANETS.length
    || input.columns.some((planet, index) => planet !== LIFETIME_PLANETS[index])
    || !Number.isSafeInteger(input.sampleCount) || input.sampleCount < 1
    || input.stepSeconds !== LIFETIME_STEP_SECONDS || input.flags !== 258
    || typeof input.engine !== 'string' || !/^Swiss Ephemeris \d+(?:\.\d+){1,3}$/.test(input.engine)
    || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)) throw unavailable();
  const start = epoch(input.startUtc), end = epoch(input.endExclusiveUtc);
  const bytes = input.sampleCount * LIFETIME_PLANETS.length * 8;
  if (!Number.isSafeInteger(bytes) || input.bytes !== bytes
    || start < Date.UTC(1801, 0, 1) || end > Date.UTC(2400, 0, 1)
    || end - start !== input.sampleCount * LIFETIME_STEP_SECONDS * 1000) throw unavailable();
  return { start, bytes, sha256: input.sha256, metadata: Object.freeze({ startUtc: input.startUtc, endExclusiveUtc: input.endExclusiveUtc,
    stepSeconds: LIFETIME_STEP_SECONDS, samples: input.sampleCount, planets: LIFETIME_PLANETS, source: input.engine }) };
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

// The large corpus stays on disk. Each point reads only the stored Float64s;
// explicit offsets keep concurrent requests independent of the file cursor.
export async function createLifetimeArchive({ file, metadataFile, root = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  if (!file && !metadataFile) return null;
  let handle;
  try {
    if (typeof file !== 'string' || !file || typeof metadataFile !== 'string' || !metadataFile) throw unavailable();
    const info = await fs.stat(metadataFile);
    if (!info.isFile() || info.size > MAX_METADATA_BYTES) throw unavailable();
    const input = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
    const validated = validateMetadata(input);
    // Absence is legacy, not proof of the current generator. A new declared
    // provenance must match before old Personality meets current Design.
    const provenanceVerified = input.provenance !== undefined;
    if (provenanceVerified && (input.provenance?.version !== '1'
        || typeof input.provenance.calculationFingerprint !== 'string'
        || input.provenance.calculationFingerprint !== await lifetimeArchiveFingerprint(root))) throw unavailable();
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== validated.bytes) throw unavailable();
    // Verify the prepared corpus once, with bounded memory, before accepting
    // requests. Point reads remain one small positional read per stored planet.
    await verifyDigest(handle, validated.bytes, validated.sha256);
    const { metadata, start } = validated;
    const cacheIdentity = createHash('sha256').update(JSON.stringify([
      LIFETIME_ARCHIVE_VERSION, LIFETIME_ARCHIVE_FORMAT, validated.sha256, metadata,
    ])).digest('hex');
    const pending = new Set();
    let accepting = true, closing;

    async function readPoint(index) {
      const reads = await Promise.allSettled(LIFETIME_PLANETS.map(async (_, column) => {
        const bytes = Buffer.alloc(8);
        const { bytesRead } = await handle.read(bytes, 0, 8, (column * metadata.samples + index) * 8);
        if (bytesRead !== 8) throw unavailable();
        const value = bytes.readDoubleLE(0);
        if (!Number.isFinite(value) || value < 0 || value >= 360) throw unavailable();
        return value;
      }));
      if (reads.some(read => read.status !== 'fulfilled')) throw unavailable();
      return { index, utc: new Date(start + index * LIFETIME_STEP_SECONDS * 1000).toISOString().replace('.000Z', 'Z'),
        longitudes: reads.map(read => read.value) };
    }

    return {
      metadata,
      cacheIdentity,
      provenanceVerified,
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
  } catch {
    if (handle) await handle.close().catch(() => {});
    throw unavailable();
  }
}
