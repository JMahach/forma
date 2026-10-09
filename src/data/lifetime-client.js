import { validateLifetimeMetadata, validateLifetimeMoment, lifetimeChartAt, lifetimeExactChartAt } from '../domain/lifetime.js';
import { transitSampleAt, transitChartAt } from '../domain/transit-day.js';
import { natalDayMinute, natalDayIndexAt, natalDayNearestIndex, natalDaySampleAt } from '../domain/natal-day.js';
import { NATAL_DAY_VERSION } from '../../shared/day-packets/natal-format.js';
import { LIFETIME_EXACT_VERSION } from '../../shared/lifetime-exact-format.js';
import { TRANSIT_DAY_VERSION } from '../../shared/day-packets/transit-format.js';
import { createTransitDayCache } from './transit-day-cache.js';
import { createAbortError, shareRequest } from './shared-request.js';

// Only completed days are reusable. A point or exact minute belongs to its
// current view; independent visits use the server again without HTTP storage.
export function createLifetimeClient({ fetch: fetchPoint = globalThis.fetch, timeoutMs = 20_000, dayClient = null,
  days = dayClient?.days || createTransitDayCache(), natalDayClient = null, getPersonalChart = () => null,
} = {}) {
  const pending = new Map();
  // Only the selected natal's small timeline survives RAM eviction. Numeric
  // columns remain owned by the shared day cache, with no history of sources.
  let metadata = null, natalPreparation = null;
  function shared(key, url, validate, signal) {
    return shareRequest(pending, key, ({ controller }) => {
      let timedOut = false;
      const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      return Promise.resolve().then(async () => {
        try {
          const response = await fetchPoint(url, { signal: controller.signal, cache: 'no-store' });
          if (!response.ok) {
            let failure;
            try { failure = await response.json(); } catch { /* Local server errors may have no JSON body. */ }
            throw Object.assign(new Error(failure?.message || 'Не удалось загрузить летопись.'), { code: failure?.error });
          }
          const value = await response.json();
          if (controller.signal.aborted) throw createAbortError();
          return validate(value);
        } catch (error) {
          if (timedOut) throw new Error('Летопись не успела загрузиться. Повторите попытку.');
          if (controller.signal.aborted || error?.name === 'AbortError') throw createAbortError();
          if (error instanceof TypeError) throw new Error('Не удалось загрузить летопись. Проверьте соединение.');
          throw error;
        } finally { clearTimeout(deadline); }
      });
    }, { signal });
  }
  async function getMeta({ signal, refreshNatalDay = false } = {}) {
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
  function validMoment(milliseconds, meta = metadata) {
    return meta && Number.isSafeInteger(milliseconds)
      && milliseconds >= Date.parse(meta.startUtc) && milliseconds < Date.parse(meta.endExclusiveUtc);
  }
  const validMinute = (milliseconds, meta = metadata) => validMoment(milliseconds, meta) && milliseconds % 60000 === 0;
  const dateAt = milliseconds => new Date(milliseconds).toISOString().slice(0, 10);
  function minuteAt(milliseconds, day, meta = metadata) {
    if (!validMinute(milliseconds, meta) || day?.version !== TRANSIT_DAY_VERSION || day.stepSeconds !== 60
        || day.samples !== 1440 || day.date !== dateAt(milliseconds) || day.startUtc !== `${day.date}T00:00:00Z`
        || !meta.calculationVersion || day.calculationVersion !== meta.calculationVersion || day.engine !== meta.engine
        || day.nodeModel !== 'true' || day.zodiac !== 'tropical-geocentric-apparent') return null;
    const index = (milliseconds - Date.parse(day.startUtc)) / 60000;
    return Number.isInteger(index) && index >= 0 && index < day.samples ? { day, index } : null;
  }
  function compatibleNatalDay(day, meta) {
    return meta && day?.version === NATAL_DAY_VERSION && day.stepSeconds === 60
      && meta.calculationVersion && day.calculationVersion === meta.calculationVersion && day.engine === meta.engine
      && day.nodeModel === 'true' && day.zodiac === 'tropical-geocentric-apparent';
  }
  function activeNatalPreparation(meta = metadata) {
    return natalPreparation && natalPreparation.original === getPersonalChart() && natalPreparation.meta === meta ? natalPreparation : null;
  }
  const timelineOf = day => ({ samples: day.samples, segments: day.segments });
  async function prepareNatalDay(meta, signal, refresh) {
    const original = getPersonalChart();
    if (!original || !natalDayClient) { natalPreparation = null; return; }
    const context = !refresh && activeNatalPreparation(meta) || (natalPreparation = { original, meta, ready: false, timeline: null });
    if (context.ready) return;
    const day = await natalDayClient.readDay(original, { signal });
    if (metadata !== meta || signal?.aborted) throw createAbortError();
    if (activeNatalPreparation(meta) === context) {
      context.ready = true;
      context.timeline = compatibleNatalDay(day, meta) ? timelineOf(day) : null;
    }
  }
  function natalDay(meta = metadata) {
    const original = getPersonalChart(), day = original && natalDayClient?.peekDay(original);
    if (!compatibleNatalDay(day, meta)) return null;
    const context = activeNatalPreparation(meta);
    if (context) context.timeline = timelineOf(day);
    return day;
  }
  function natalTimeline(meta = metadata) { return natalDay(meta) || activeNatalPreparation(meta)?.timeline || null; }
  function hasNatalMinute(milliseconds, meta = metadata) {
    const timeline = validMoment(milliseconds, meta) && natalTimeline(meta);
    return Boolean(timeline && Date.parse(natalDayMinute(timeline, natalDayIndexAt(timeline, milliseconds)).utc) === milliseconds);
  }
  function natalSample(milliseconds, meta = metadata, day = natalDay(meta)) {
    if (!validMoment(milliseconds, meta) || !compatibleNatalDay(day, meta)) return null;
    const index = natalDayIndexAt(day, milliseconds);
    return Date.parse(natalDayMinute(day, index).utc) === milliseconds ? { day, index, natal: true } : null;
  }
  const sampleAt = sample => sample.natal ? natalDaySampleAt(sample.day, sample.index) : transitSampleAt(sample.day, sample.index);
  const chartAt = (sample, meta = metadata) => sample.natal
    ? lifetimeExactChartAt({ ...sampleAt(sample), version: LIFETIME_EXACT_VERSION }, meta, Date.parse(natalDayMinute(sample.day, sample.index).utc))
    : transitChartAt(sample.day, sample.index);
  function nearestMinute(milliseconds, bounds = {}, round = Math.round) {
    const day = natalTimeline(); if (!day || !validMoment(milliseconds)) return null;
    const index = natalDayNearestIndex(day, milliseconds, { ...bounds, round });
    return index === null ? null : Date.parse(natalDayMinute(day, index).utc);
  }
  function adjacentMinute(milliseconds, direction) {
    const day = natalTimeline(); if (!day || !validMoment(milliseconds) || !direction) return null;
    let index = natalDayIndexAt(day, milliseconds);
    const utc = Date.parse(natalDayMinute(day, index).utc);
    if (direction > 0 && utc <= milliseconds) index++;
    if (direction < 0 && utc >= milliseconds) index--;
    return index >= 0 && index < day.samples ? Date.parse(natalDayMinute(day, index).utc) : null;
  }
  function cachedMinute(milliseconds, meta = metadata) {
    const natal = natalSample(milliseconds, meta); if (natal) return natal;
    if (!validMinute(milliseconds, meta) || !meta.calculationVersion) return null;
    const date = dateAt(milliseconds);
    return minuteAt(milliseconds, dayClient?.peekDay?.(date) || days.peekDay(date, meta.calculationVersion), meta);
  }
  async function readSample(milliseconds, meta, signal) {
    if (!validMoment(milliseconds, meta) || !meta.calculationVersion) return null;
    const hot = cachedMinute(milliseconds, meta); if (hot) return hot;
    const original = getPersonalChart();
    if (original && natalDayClient && hasNatalMinute(milliseconds, meta)) {
      const day = await natalDayClient.readDay(original, { signal });
      if (metadata !== meta || signal?.aborted) throw createAbortError();
      const natal = original === getPersonalChart() ? natalSample(milliseconds, meta, day) : null;
      if (natal) return natal;
      const context = activeNatalPreparation(meta);
      if (context?.original === original) context.timeline = null;
    }
    if (!validMinute(milliseconds, meta)) return null;
    // This owner reads existing RAM/IDB only. Never call dayClient.getDay here:
    // one selected minute must not trigger calculation of an entire day.
    const day = await days.getDay(dateAt(milliseconds), meta.calculationVersion);
    if (metadata !== meta || signal?.aborted) throw createAbortError();
    return minuteAt(milliseconds, day, meta);
  }
  function peekMinute(milliseconds) {
    const sample = cachedMinute(milliseconds);
    return sample ? chartAt(sample) : null;
  }
  function hasMinute(milliseconds) {
    return Boolean(hasNatalMinute(milliseconds) || cachedMinute(milliseconds) || validMinute(milliseconds)
      && metadata.calculationVersion && days.hasMinute(milliseconds, metadata.calculationVersion));
  }
  async function readMinute(milliseconds, { signal } = {}) {
    if (signal?.aborted) throw createAbortError();
    const sample = await readSample(milliseconds, metadata, signal);
    return sample ? chartAt(sample) : null;
  }
  async function getMinute(milliseconds, { signal } = {}) {
    const meta = await getMeta({ signal });
    if (!validMoment(milliseconds, meta)) throw new Error('Некорректная минута летописи.');
    const index = (milliseconds - Date.parse(meta.startUtc)) / (meta.stepSeconds * 1000);
    if (Number.isInteger(index)) return lifetimeChartAt(meta, await getPoint(index, { signal }));
    const cached = await readMinute(milliseconds, { signal });
    if (metadata !== meta || signal?.aborted) throw createAbortError();
    if (cached) return cached;
    const utc = new Date(milliseconds).toISOString().replace('.000Z', 'Z');
    const version = meta.cacheVersion ? `&v=${encodeURIComponent(meta.cacheVersion)}` : '';
    return shared(`utc:${utc}`, `/api/lifetime/moment?utc=${encodeURIComponent(utc)}${version}`, value => {
      if (metadata !== meta) throw createAbortError();
      return lifetimeExactChartAt(value, meta, milliseconds);
    }, signal);
  }
  async function getPoint(index, { signal } = {}) {
    const meta = await getMeta({ signal });
    if (!Number.isInteger(index) || index < 0 || index >= meta.samples) throw new Error('Некорректный момент летописи.');
    const milliseconds = Date.parse(meta.startUtc) + index * meta.stepSeconds * 1000;
    const sample = await readSample(milliseconds, meta, signal);
    if (metadata !== meta || signal?.aborted) throw createAbortError();
    if (sample) return validateLifetimeMoment({ ...sampleAt(sample), index }, meta, index);
    const version = meta.cacheVersion ? `&v=${encodeURIComponent(meta.cacheVersion)}` : '';
    return shared(index, `/api/lifetime?index=${index}${version}`, value => {
      if (metadata !== meta) throw createAbortError();
      return validateLifetimeMoment(value, meta, index);
    }, signal);
  }
  return { getMeta, getPoint, peekMinute, hasMinute, nearestMinute, adjacentMinute, readMinute, peekMoment: peekMinute, getMinute, invalidateMetadata };
}
