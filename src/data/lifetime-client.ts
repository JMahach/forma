import { fetchResource, responseError } from './http-transport.ts';
type LifetimeResponse = Pick<Response, 'ok' | 'json'> & Partial<Pick<Response, 'status'>>;
import type { LifetimeMetadata } from '../../shared/lifetime-format.ts';
import type { ChartRecord } from '../../shared/chart-types.ts';
import type { NatalDay, NatalTimeline } from '../../shared/day-packets/natal-format.ts';
import type { TransitDay } from '../../shared/day-packets/transit-format.ts';
import type { TransitDayClient } from './transit-day-client.ts';
import type { TransitDayCache } from './transit-day-cache.ts';
import type { NatalDayClient } from './natal-day-client.ts';
import type { SharedRequest } from './shared-request.ts';
interface LifetimeClientOptions {
  fetch?: (url: string, options: RequestInit & { signal: AbortSignal }) => LifetimeResponse | PromiseLike<LifetimeResponse>;
  timeoutMs?: number;
  dayClient?: TransitDayClient | null;
  days?: TransitDayCache;
  natalDayClient?: NatalDayClient | null;
  getPersonalRecord?: () => Partial<ChartRecord> | null;
}
type DaySample = { day: NatalDay; index: number; natal: true } | { day: TransitDay; index: number; natal?: false };
export type LifetimeClient = ReturnType<typeof createLifetimeClient>;

import { validateLifetimeMetadata, validateLifetimeMoment, lifetimeExactChartAt } from '../domain/lifetime.ts';
import { transitSampleAt, transitChartAt } from '../domain/transit-day.ts';
import { natalDayMinute, natalDayIndexAt, natalDayNearestIndex, natalDaySampleAt } from '../domain/natal-day.ts';
import { NATAL_DAY_VERSION } from '../../shared/day-packets/natal-format.ts';
import { LIFETIME_EXACT_VERSION } from '../../shared/lifetime-exact-format.ts';
import { TRANSIT_DAY_VERSION } from '../../shared/day-packets/transit-format.ts';
import { createTransitDayCache } from './transit-day-cache.ts';
import { createAbortError, shareRequest } from './shared-request.ts';

// Only completed days are reusable. A point or exact minute belongs to its
// current view; independent visits use the server again without HTTP storage.
export function createLifetimeClient({ fetch: fetchPoint = fetchResource, timeoutMs = 20_000, dayClient = null,
  days = dayClient?.days || createTransitDayCache(), natalDayClient = null, getPersonalRecord = () => null,
}: LifetimeClientOptions = {}) {
  const pending = new Map<string | number, SharedRequest<unknown>>();
  // Only the selected natal's small timeline survives RAM eviction. Numeric
  // columns remain owned by the shared day cache, with no history of sources.
  let metadata: LifetimeMetadata | null = null;
  let natalPreparation: { record: Partial<ChartRecord>; meta: LifetimeMetadata; ready: boolean; timeline: NatalTimeline | null } | null = null;
  function shared<T>(key: string | number, url: string, validate: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
    return shareRequest(pending, key, ({ controller }) => {
      let timedOut = false;
      const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      return Promise.resolve().then(async () => {
        try {
          const response = await fetchPoint(url, { signal: controller.signal, cache: 'no-store' });
          if (!response.ok) {
            let failure;
            try { failure = await response.json(); } catch (error) {
              if (error instanceof TypeError || ['AbortError', 'ConnectionError'].includes((error as Error)?.name)) throw error;
              // A completed HTTP refusal can have no usable JSON body.
            }
            throw responseError(response.status, failure, 'Не удалось загрузить летопись.');
          }
          const value = await response.json();
          if (controller.signal.aborted) throw createAbortError();
          return validate(value);
        } catch (error) {
          if (timedOut) throw Object.assign(new Error('Летопись не успела загрузиться. Повторите попытку.'), {code:'server_unavailable'});
          if (controller.signal.aborted || (error as Error)?.name === 'AbortError') throw createAbortError();
          if (error instanceof TypeError) throw Object.assign(new Error('Не удалось загрузить летопись. Проверьте соединение.'), {code:'connection_failed'});
          throw error;
        } finally { clearTimeout(deadline); }
      });
    }, { signal }) as Promise<T>;
  }
  async function getMeta({ signal, refreshNatalDay = false }: { signal?: AbortSignal; refreshNatalDay?: boolean } = {}) {
    if (signal?.aborted) throw createAbortError();
    const value = metadata || await shared('meta', '/api/lifetime/meta', value => (metadata = validateLifetimeMetadata(value)), signal);
    await days.prepare(value.calculationVersion);
    await prepareNatalDay(value, signal, refreshNatalDay);
    if (metadata !== value || signal?.aborted) throw createAbortError();
    return value;
  }
  function invalidateMetadata(expected = metadata) {
    if (metadata !== expected) return;
    metadata = null; natalPreparation = null;
    for (const request of pending.values()) request.controller.abort();
    pending.clear();
  }
  function validMoment(milliseconds: number, meta = metadata): meta is LifetimeMetadata {
    return !!meta && Number.isSafeInteger(milliseconds)
      && milliseconds >= Date.parse(meta.startUtc) && milliseconds < Date.parse(meta.endExclusiveUtc);
  }
  const validMinute = (milliseconds: number, meta = metadata): meta is LifetimeMetadata => validMoment(milliseconds, meta) && milliseconds % 60000 === 0;
  const dateAt = (milliseconds: number) => new Date(milliseconds).toISOString().slice(0, 10);
  function minuteAt(milliseconds: number, day: TransitDay | null | undefined, meta = metadata) {
    if (!validMinute(milliseconds, meta) || day?.version !== TRANSIT_DAY_VERSION || day.stepSeconds !== 60
        || day.samples !== 1440 || day.date !== dateAt(milliseconds) || day.startUtc !== `${day.date}T00:00:00Z`
        || !meta.calculationVersion || day.calculationVersion !== meta.calculationVersion || day.engine !== meta.engine
        || day.nodeModel !== 'true' || day.zodiac !== 'tropical-geocentric-apparent') return null;
    const index = (milliseconds - Date.parse(day.startUtc)) / 60000;
    return Number.isInteger(index) && index >= 0 && index < day.samples ? { day, index } : null;
  }
  function compatibleNatalDay(day: NatalDay | null | undefined, meta: LifetimeMetadata | null): day is NatalDay {
    return !!(meta && day?.version === NATAL_DAY_VERSION && day.stepSeconds === 60
      && meta.calculationVersion && day.calculationVersion === meta.calculationVersion && day.engine === meta.engine
      && day.nodeModel === 'true' && day.zodiac === 'tropical-geocentric-apparent');
  }
  function activeNatalPreparation(meta = metadata) {
    return natalPreparation && natalPreparation.record === getPersonalRecord() && natalPreparation.meta === meta ? natalPreparation : null;
  }
  const timelineOf = (day: NatalDay) => ({ samples: day.samples, segments: day.segments });
  async function prepareNatalDay(meta: LifetimeMetadata, signal: AbortSignal | undefined, refresh: boolean) {
    const record = getPersonalRecord();
    if (!record || !natalDayClient) { natalPreparation = null; return; }
    const context = !refresh && activeNatalPreparation(meta) || (natalPreparation = { record, meta, ready: false, timeline: null });
    if (context.ready) return;
    const day = await natalDayClient.readDay(record, { signal });
    if (metadata !== meta || signal?.aborted) throw createAbortError();
    if (activeNatalPreparation(meta) === context) {
      context.ready = true;
      context.timeline = compatibleNatalDay(day, meta) ? timelineOf(day) : null;
    }
  }
  function natalDay(meta = metadata) {
    const record = getPersonalRecord(), day = record && natalDayClient?.peekDay(record);
    if (!compatibleNatalDay(day, meta)) return null;
    const context = activeNatalPreparation(meta);
    if (context) context.timeline = timelineOf(day);
    return day;
  }
  function natalTimeline(meta = metadata) { return natalDay(meta) || activeNatalPreparation(meta)?.timeline || null; }
  function hasNatalMinute(milliseconds: number, meta = metadata) {
    const timeline = validMoment(milliseconds, meta) && natalTimeline(meta);
    return Boolean(timeline && Date.parse(natalDayMinute(timeline, natalDayIndexAt(timeline, milliseconds)).utc) === milliseconds);
  }
  function natalSample(milliseconds: number, meta = metadata, day: NatalDay | null = natalDay(meta)) {
    if (!validMoment(milliseconds, meta) || !compatibleNatalDay(day, meta)) return null;
    const index = natalDayIndexAt(day, milliseconds);
    return Date.parse(natalDayMinute(day, index).utc) === milliseconds ? { day, index, natal: true as const } : null;
  }
  const sampleAt = (sample: DaySample) => sample.natal ? natalDaySampleAt(sample.day, sample.index) : transitSampleAt(sample.day, sample.index);
  const chartAt = (sample: DaySample, meta = metadata) => sample.natal
    ? lifetimeExactChartAt({ ...sampleAt(sample), version: LIFETIME_EXACT_VERSION }, meta!, Date.parse(natalDayMinute(sample.day, sample.index).utc))
    : transitChartAt(sample.day, sample.index);
  function nearestMinute(milliseconds: number, bounds: { min?: number; max?: number } = {}, round = Math.round) {
    const day = natalTimeline(); if (!day || !validMoment(milliseconds)) return null;
    const index = natalDayNearestIndex(day, milliseconds, { ...bounds, round });
    return index === null ? null : Date.parse(natalDayMinute(day, index).utc);
  }
  function adjacentMinute(milliseconds: number, direction: number) {
    const day = natalTimeline(); if (!day || !validMoment(milliseconds) || !direction) return null;
    let index = natalDayIndexAt(day, milliseconds);
    const utc = Date.parse(natalDayMinute(day, index).utc);
    if (direction > 0 && utc <= milliseconds) index++;
    if (direction < 0 && utc >= milliseconds) index--;
    return index >= 0 && index < day.samples ? Date.parse(natalDayMinute(day, index).utc) : null;
  }
  function cachedMinute(milliseconds: number, meta = metadata) {
    const natal = natalSample(milliseconds, meta); if (natal) return natal;
    if (!validMinute(milliseconds, meta) || !meta.calculationVersion) return null;
    const date = dateAt(milliseconds);
    return minuteAt(milliseconds, dayClient?.peekDay?.(date) || days.peekDay(date, meta.calculationVersion), meta);
  }
  async function readSample(milliseconds: number, meta: LifetimeMetadata | null, signal?: AbortSignal) {
    if (!validMoment(milliseconds, meta) || !meta.calculationVersion) return null;
    const hot = cachedMinute(milliseconds, meta); if (hot) return hot;
    const record = getPersonalRecord();
    if (record && natalDayClient && hasNatalMinute(milliseconds, meta)) {
      const day = await natalDayClient.readDay(record, { signal });
      if (metadata !== meta || signal?.aborted) throw createAbortError();
      const natal = record === getPersonalRecord() ? natalSample(milliseconds, meta, day) : null;
      if (natal) return natal;
      const context = activeNatalPreparation(meta);
      if (context?.record === record) context.timeline = null;
    }
    if (!validMinute(milliseconds, meta)) return null;
    // This owner reads existing RAM/IDB only. Never call dayClient.getDay here:
    // one selected minute must not trigger calculation of an entire day.
    const day = await days.getDay(dateAt(milliseconds), meta.calculationVersion);
    if (metadata !== meta || signal?.aborted) throw createAbortError();
    return minuteAt(milliseconds, day, meta);
  }
  function peekMinute(milliseconds: number) {
    const sample = cachedMinute(milliseconds);
    return sample ? chartAt(sample) : null;
  }
  function hasMinute(milliseconds: number) {
    return Boolean(hasNatalMinute(milliseconds) || cachedMinute(milliseconds) || validMinute(milliseconds)
      && metadata!.calculationVersion && days.hasMinute(milliseconds, metadata!.calculationVersion));
  }
  async function readMinute(milliseconds: number, { signal }: { signal?: AbortSignal } = {}) {
    if (signal?.aborted) throw createAbortError();
    const sample = await readSample(milliseconds, metadata, signal);
    return sample ? chartAt(sample) : null;
  }
  async function getPoint(index: number, { signal, checkedDay = null }: { signal?: AbortSignal; checkedDay?: { date: string; version?: string } | null } = {}) {
    const meta = await getMeta({ signal });
    if (!Number.isInteger(index) || index < 0 || index >= meta.samples) throw new Error('Некорректный момент летописи.');
    const milliseconds = Date.parse(meta.startUtc) + index * meta.stepSeconds * 1000;
    // The current command may already have checked this same day before its
    // grid fallback. Recheck RAM, but do not repeat that disk miss or carry it
    // to another date/revision or independent visit.
    const alreadyRead = meta.calculationVersion && checkedDay?.version === meta.calculationVersion && checkedDay.date === dateAt(milliseconds);
    const sample = alreadyRead ? cachedMinute(milliseconds, meta) : await readSample(milliseconds, meta, signal);
    if (metadata !== meta || signal?.aborted) throw createAbortError();
    if (sample) return validateLifetimeMoment({ ...sampleAt(sample), index }, meta, index);
    const version = meta.cacheVersion ? `&v=${encodeURIComponent(meta.cacheVersion)}` : '';
    return shared(index, `/api/lifetime?index=${index}${version}`, value => {
      if (metadata !== meta) throw createAbortError();
      return validateLifetimeMoment(value, meta, index);
    }, signal);
  }
  return { getMeta, getPoint, peekMinute, hasMinute, nearestMinute, adjacentMinute, readMinute, invalidateMetadata };
}
