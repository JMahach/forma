import { reportServerFailure, type ServerFailureReport } from '../journal/report.ts';
import type { FileHandle } from 'node:fs/promises';
import type { LifetimeMetadata, LifetimeFileMetadata } from '../../shared/lifetime-format.ts';
import type { NumericMoment, DesignMoment } from '../../shared/day-packets/moment-columns.ts';
import type { SharedJob } from '../runtime/job-consumers.ts';

interface LifetimeReader {
  metadata: LifetimeMetadata;
  cacheIdentity?: string;
  provenanceVerified?: boolean;
  getPoint: (index: number) => Promise<NumericMoment>;
  close: () => Promise<void>;
}
interface MomentOptions { signal?: AbortSignal }
interface ReadWork extends SharedJob<NumericMoment> {
  index: number;
  utc: string;
  started: boolean;
  resolve: (point: NumericMoment) => void;
  reject: (reason: unknown) => void;
}
interface LifetimeServiceOptions { report?: ServerFailureReport; root?: string; file?: string; calculationVersion?: string | null }
interface LifetimeMomentOptions {
  lifetimeFile?: LifetimeReader | null;
  calculationFingerprint?: string | null;
}
interface LifetimeFileOptions { report?: ServerFailureReport; file?: string; metadataFile?: string; root?: string }
type Moments = NonNullable<ReturnType<typeof createLifetimeMoments>>;
export type LifetimeService = ReturnType<typeof createLifetimeService>;

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LIFETIME_PLANETS, LIFETIME_STEP_SECONDS, LIFETIME_FILE_VERSION, LIFETIME_FILE_FORMAT, LIFETIME_PROVENANCE_INPUTS, LIFETIME_FIELDS, LIFETIME_POINT_BYTES } from '../../shared/lifetime-format.ts';

import { PERSONALITY_COLUMN, DESIGN_COLUMN, DESIGN_UNIX_SECONDS_COLUMN, DESIGN_RESIDUAL_COLUMN, validMomentValue } from '../../shared/day-packets/moment-columns.ts';

import { LIFETIME_EXACT_VERSION } from '../../shared/lifetime-exact-format.ts';
import { consumeJob, aborted } from '../runtime/job-consumers.ts';
import { inputFingerprint, calculationVersion } from '../runtime/calculation-version.ts';
import { SUPPORTED_START, SUPPORTED_END_EXCLUSIVE } from '../../shared/date-limits.ts';
import { lifetimeProvenanceMatches } from './lifetime-compatibility.ts';

const MAX_METADATA_BYTES = 16_384;

export function lifetimeFileFingerprint(root: string) {
  return inputFingerprint(root, LIFETIME_PROVENANCE_INPUTS);
}

// One owner opens the completed file on demand. A later request can find it
// after preparation; ready requests share one verified file and pending reads.
export function createLifetimeService({ report, root = fileURLToPath(new URL('../../', import.meta.url)),
  file = path.join(root, '.cache/lifetime/lifetime-1801-2400.f64le'), calculationVersion: version = null }: LifetimeServiceOptions = {}) {
  let source: LifetimeReader | null = null, moments: Moments | null = null, opening: Promise<Moments> | null = null, closing: Promise<void> | null = null, closed = false;
  function ready() {
    if (closed) return Promise.reject(unavailable());
    if (moments) return Promise.resolve(moments);
    if (!opening) opening = (async () => {
      const opened = await createLifetimeFile({ file, metadataFile: file.replace(/\.f64le$/, '.metadata.json'), root, report });
      try {
        const calculationFingerprint = version || await calculationVersion(root);
        if (closed) throw unavailable();
        moments = createLifetimeMoments({ lifetimeFile: opened, calculationFingerprint })!;
        source = opened;
        return moments;
      } catch (error) { await opened.close(); throw error; }
    })().finally(() => { opening = null; });
    return opening;
  }
  return {
    async getMetadata() { return (await ready()).metadata; },
    async getMoment(index: number, options?: MomentOptions) { return (await ready()).getMoment(index, options); },
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
  declare code: string;
  declare status: number;

  constructor(code: string, message: string, status = 503) {
    super(message); this.code = code; this.status = status;
  }
}
const unavailable = () => new LifetimeError('lifetime_unavailable', 'Данные летописи недоступны.');
const invalidIndex = () => new LifetimeError('invalid_index', 'Выберите момент в пределах шкалы.', 400);
const designUnavailable = () => new LifetimeError('lifetime_unavailable', 'Не удалось рассчитать Дизайн. Повторите попытку.');
const busy = () => new LifetimeError('busy', 'Подождите завершения текущего расчёта и повторите попытку.');

export const LIFETIME_MOMENT_LIMITS = Object.freeze({ readConcurrency: 4, pendingReads: 1024 });

function momentUtc(value: unknown) {
  const milliseconds = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds) || ![new Date(milliseconds).toISOString(), new Date(milliseconds).toISOString().replace('.000Z', 'Z')].includes(value as string)) {
    throw new LifetimeError('invalid_utc', 'Нужен корректный момент UTC.', 400);
  }
  if (milliseconds < SUPPORTED_START || milliseconds >= SUPPORTED_END_EXCLUSIVE) {
    throw new LifetimeError('unsupported_date', 'Доступны даты с 1801 по 2399 год.', 422);
  }
  return new Date(milliseconds).toISOString().replace('.000Z', 'Z');
}

const validLongitudes = (values: unknown): values is number[] => Array.isArray(values) && values.length === LIFETIME_PLANETS.length
  && values.every(value => Number.isFinite(value) && value >= 0 && value < 360);

function validatedDesign(value: unknown, utc: string): DesignMoment {
  const point = value as DesignMoment & { error?: string };
  const moment = Date.parse(point?.designUtc), selected = Date.parse(utc);
  if (point?.error
      || point?.utc !== utc || !Number.isFinite(moment)
      || moment >= selected || moment < selected - 110 * 86_400_000
      || !Number.isFinite(point?.designArcResidualDegrees) || point.designArcResidualDegrees < 0 || point.designArcResidualDegrees > 1e-7
      || !validLongitudes(point?.longitudes)) { throw designUnavailable(); }
  return Object.freeze({ utc, designUtc: point.designUtc, designArcResidualDegrees: point.designArcResidualDegrees,
    longitudes: Object.freeze([...point.longitudes]) });
}

// Only pending reads are shared. Completed numbers remain in the prepared file,
// not in a second server cache; a later independent visit reads them again.
export function createLifetimeMoments({ lifetimeFile, calculationFingerprint = null }: LifetimeMomentOptions = {}) {
  if (!lifetimeFile) return null;
  if (calculationFingerprint !== null && !/^[a-f0-9]{64}$/.test(calculationFingerprint)) throw new RangeError('Invalid calculation fingerprint');
  const metadata = calculationFingerprint && lifetimeFile.cacheIdentity
    ? Object.freeze({ ...lifetimeFile.metadata, calculationVersion: calculationFingerprint, cacheVersion: createHash('sha256')
      .update(`lifetime-moment-v${LIFETIME_EXACT_VERSION}\0${lifetimeFile.cacheIdentity}\0${calculationFingerprint}`).digest('hex') })
    : lifetimeFile.metadata;
  const reads = new Map<number, ReadWork>(), readQueue: ReadWork[] = [];
  let activeReads = 0;
  function drainReads() {
    while (activeReads < LIFETIME_MOMENT_LIMITS.readConcurrency && readQueue.length) {
      const job = readQueue.shift()!, { index, utc, resolve, reject } = job;
      job.started = true; activeReads++;
      Promise.resolve().then(() => lifetimeFile!.getPoint(index)).then(point => {
        if (point?.index !== index || point?.utc !== utc || !validLongitudes(point?.longitudes)) throw unavailable();
        const design = validatedDesign(point.design, utc);
        return Object.freeze({ index, utc, longitudes: Object.freeze([...point.longitudes]), design });
      }).catch(error => { throw error instanceof LifetimeError ? error : unavailable(); })
        .finally(() => { reads.delete(index); activeReads--; drainReads(); })
        .then(resolve, reject);
    }
  }
  function consumeRead(job: ReadWork, signal?: AbortSignal) {
    return consumeJob(job, signal, abandoned => {
      if (abandoned.started) return; // A small positional read completes for any remaining consumers.
      const index = readQueue.indexOf(abandoned); if (index >= 0) readQueue.splice(index, 1);
      reads.delete(abandoned.index); abandoned.reject(aborted());
    });
  }
  async function getMoment(index: number, { signal }: MomentOptions = {}): Promise<NumericMoment> {
    if (signal?.aborted) throw aborted();
    if (!Number.isSafeInteger(index) || index < 0 || index >= metadata?.samples) throw invalidIndex();
    const utc = momentUtc(new Date(Date.parse(metadata.startUtc) + index * metadata.stepSeconds * 1000).toISOString());
    if (reads.has(index)) return consumeRead(reads.get(index)!, signal);
    // Bound retained requests as well as active positional file reads.
    if (reads.size >= LIFETIME_MOMENT_LIMITS.pendingReads) throw busy();
    let resolve!: (point: NumericMoment) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<NumericMoment>((yes, no) => { resolve = yes; reject = no; });
    const job = { index, utc, promise, resolve, reject, started: false };
    reads.set(index, job); readQueue.push(job);
    const result = consumeRead(job, signal); drainReads(); return result;
  }
  return { metadata, getMoment };
}

function epoch(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) throw unavailable();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value.replace('Z', '.000Z')) throw unavailable();
  return milliseconds;
}

function validateMetadata(value: unknown) {
  const input = value as LifetimeFileMetadata;
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
    || start < SUPPORTED_START || end > SUPPORTED_END_EXCLUSIVE
    || end - start !== input.sampleCount * LIFETIME_STEP_SECONDS * 1000) throw unavailable();
  return { start, bytes, sha256: input.sha256, metadata: Object.freeze({ startUtc: input.startUtc, endExclusiveUtc: input.endExclusiveUtc,
    stepSeconds: LIFETIME_STEP_SECONDS, samples: input.sampleCount, planets: LIFETIME_PLANETS, engine: input.engine }) };
}

async function verifyDigest(handle: FileHandle, bytes: number, expected: string) {
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
export function createLifetimeFile(options: LifetimeFileOptions & { file: string; metadataFile: string }): Promise<LifetimeReader>;
export function createLifetimeFile(options?: LifetimeFileOptions): Promise<LifetimeReader | null>;
export async function createLifetimeFile({ file, metadataFile, report, root = fileURLToPath(new URL('../../', import.meta.url)) }: LifetimeFileOptions = {}): Promise<LifetimeReader | null> {
  if (!file && !metadataFile) return null;
  let handle: FileHandle | undefined;
  try {
    if (typeof file !== 'string' || !file || typeof metadataFile !== 'string' || !metadataFile) throw unavailable();
    const info = await fs.stat(metadataFile);
    if (!info.isFile() || info.size > MAX_METADATA_BYTES) throw unavailable();
    const input = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
    const validated = validateMetadata(input);
    if (!lifetimeProvenanceMatches(input, await lifetimeFileFingerprint(root))) throw unavailable();
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== validated.bytes) throw unavailable();
    // Verify every byte once with bounded memory before accepting requests.
    await verifyDigest(handle, validated.bytes, validated.sha256);
    const { metadata, start } = validated;
    const cacheIdentity = createHash('sha256').update(JSON.stringify([
      LIFETIME_FILE_VERSION, LIFETIME_FILE_FORMAT, validated.sha256, metadata,
    ])).digest('hex');
    const pending = new Set<Promise<NumericMoment>>();
    let accepting = true, closing: Promise<void> | undefined;

    async function readPoint(index: number) {
      const bytes = Buffer.allocUnsafe(LIFETIME_POINT_BYTES);
      const { bytesRead } = await handle!.read(bytes, 0, bytes.length, index * LIFETIME_POINT_BYTES);
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
      getPoint(index: number) {
        if (!accepting) return Promise.reject(unavailable());
        if (!Number.isSafeInteger(index) || index < 0 || index >= metadata.samples) return Promise.reject(invalidIndex());
        const result = readPoint(index).catch(error => {
          reportServerFailure(report,{event:'prepared_data_failed',component:'lifetime',reason:'read'});
          throw error instanceof LifetimeError ? error : unavailable();
        });
        pending.add(result);
        result.then(() => pending.delete(result), () => pending.delete(result));
        return result;
      },
      close() {
        if (!closing) {
          accepting = false;
          closing = Promise.allSettled([...pending]).then(() => handle!.close());
        }
        return closing;
      },
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' && [file, metadataFile].includes((error as NodeJS.ErrnoException).path))
      throw new LifetimeError('lifetime_preparing', 'Создаём летопись');
    reportServerFailure(report,{event:'prepared_data_failed',component:'lifetime',reason:'open'});
    throw error instanceof LifetimeError ? error : unavailable();
  }
}
