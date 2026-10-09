import { validateLifetimeMetadata, validateLifetimeMoment, lifetimeChartAt, lifetimeExactChartAt } from '../domain/lifetime.js';
import { transitSampleAt, transitChartAt } from '../domain/transit-day.js';
import { TRANSIT_DAY_VERSION } from '../../shared/day-packets/transit-format.js';
import { createMomentCache } from './moment-cache.js';
import { createAbortError, shareRequest } from './shared-request.js';

// The adapter knows the lifetime protocol. One shared cache owns all numeric
// samples; projected charts are small, immutable views made only when visited.
export function createLifetimeClient({ fetch: fetchPoint = globalThis.fetch, timeoutMs = 20_000, dayClient = null,
  moments = dayClient?.moments || createMomentCache(),
} = {}) {
  const pending = new Map(), projections = new WeakMap();
  let metadata = null;
  const numericVersion = () => metadata?.calculationVersion;
  function remember(point, meta) { if (metadata !== meta) throw createAbortError(); if (meta.calculationVersion) moments.putMoment(point, meta); return point; }
  function pointAt(sample, index, meta = metadata) {
    if (!sample) return null;
    let entry = projections.get(sample);
    if (!entry || entry.meta !== meta || entry.index !== index) {
      entry = { meta, index, point: validateLifetimeMoment({ ...sample, index }, meta, index) };
      projections.set(sample, entry);
    }
    return entry.point;
  }
  function chartAt(sample, milliseconds, meta = metadata) {
    if (!sample) return null;
    const index = (milliseconds - Date.parse(meta.startUtc)) / (meta.stepSeconds * 1000);
    if (Number.isInteger(index)) return lifetimeChartAt(meta, pointAt(sample, index, meta));
    let entry = projections.get(sample);
    if (!entry || entry.meta !== meta) { entry = { meta }; projections.set(sample, entry); }
    return entry.chart ||= lifetimeExactChartAt({ ...sample, version: '1' }, meta, milliseconds);
  }
  function shared(key, url, validate, signal, cache = 'no-store') {
    return shareRequest(pending, key, ({ controller }) => {
      let timedOut = false;
      const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      return Promise.resolve().then(async () => {
        try {
          const response = await fetchPoint(url, { signal: controller.signal, cache });
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
        } finally {
          clearTimeout(deadline);
        }
      });
    }, { signal });
  }
  async function getMeta({ signal } = {}) {
    if (signal?.aborted) throw createAbortError();
    const value = metadata || await shared('meta', '/api/lifetime/meta', value => (metadata = validateLifetimeMetadata(value)), signal);
    await moments.ready;
    if (metadata !== value || signal?.aborted) throw createAbortError();
    return value;
  }
  function invalidateMetadata(expected = metadata) {
    if (metadata !== expected) return;
    metadata = null;
    for (const request of pending.values()) request.controller.abort();
    pending.clear();
  }
  function validMinute(milliseconds) {
    return metadata && Number.isSafeInteger(milliseconds) && milliseconds % 60000 === 0
      && milliseconds >= Date.parse(metadata.startUtc) && milliseconds < Date.parse(metadata.endExclusiveUtc);
  }
  function minuteAt(milliseconds, day) {
    if (!validMinute(milliseconds) || day?.version !== TRANSIT_DAY_VERSION || day.stepSeconds !== 60
        || !metadata.calculationVersion || day.calculationVersion !== metadata.calculationVersion
        || day.engine !== metadata.engine
        || day.nodeModel !== 'true' || day.zodiac !== 'tropical-geocentric-apparent') return null;
    const index = (milliseconds - Date.parse(day.startUtc)) / 60000;
    return Number.isInteger(index) && index >= 0 && index < day.samples ? { day, index } : null;
  }
  function cachedMinute(milliseconds) {
    if (!validMinute(milliseconds)) return null;
    return minuteAt(milliseconds, dayClient?.peekDay(new Date(milliseconds).toISOString().slice(0, 10)));
  }
  function peekMinute(milliseconds) {
    if (!validMinute(milliseconds)) return null;
    // Existing display packets retain their view identity; all other moments
    // use immutable projections of the same shared numeric owner.
    const sample = cachedMinute(milliseconds);
    if (sample) return transitChartAt(sample.day, sample.index);
    return numericVersion() ? chartAt(moments.peekMoment(milliseconds, numericVersion()), milliseconds) : null;
  }
  function hasMinute(milliseconds) {
    return Boolean(validMinute(milliseconds) && (cachedMinute(milliseconds) || numericVersion() && moments.hasMinute(milliseconds, numericVersion())));
  }
  function peekMoment(milliseconds) {
    if (!metadata || !Number.isSafeInteger(milliseconds) || milliseconds < Date.parse(metadata.startUtc)
        || milliseconds >= Date.parse(metadata.endExclusiveUtc)) return null;
    return peekMinute(milliseconds) || (numericVersion() ? chartAt(moments.peekMoment(milliseconds, numericVersion()), milliseconds) : null);
  }
  async function readMinute(milliseconds, { signal } = {}) {
    if (signal?.aborted) throw createAbortError();
    if (!validMinute(milliseconds)) return null;
    const cached = peekMinute(milliseconds); if (cached) return cached;
    const meta = metadata;
    const sample = meta.calculationVersion ? await moments.readMoment(milliseconds, meta.calculationVersion) : null;
    if (metadata !== meta || signal?.aborted) throw createAbortError();
    return chartAt(sample, milliseconds);
  }
  // Only restoration requests a missing exact minute. Ordinary scrubs keep
  // ready Day minutes and lifetime points; no path loads a whole day for one UTC.
  async function getMinute(milliseconds, { signal } = {}) {
    const meta = await getMeta({ signal });
    if (signal?.aborted) throw createAbortError();
    if (!validMinute(milliseconds)) throw new Error('Некорректная минута летописи.');
    const cached = await readMinute(milliseconds, { signal });
    if (cached) return cached;
    const index = (milliseconds - Date.parse(meta.startUtc)) / (meta.stepSeconds * 1000);
    if (Number.isInteger(index)) return lifetimeChartAt(meta, await getPoint(index, { signal }));
    const utc = new Date(milliseconds).toISOString().replace('.000Z', 'Z'), key = `utc:${utc}`;
    const version = meta.cacheVersion ? `&v=${encodeURIComponent(meta.cacheVersion)}` : '';
    return shared(key, `/api/lifetime/moment?utc=${encodeURIComponent(utc)}${version}`,
      value => { const chart = lifetimeExactChartAt(value, meta, milliseconds); remember(value, meta); return chartAt(moments.peekMoment(milliseconds, meta.calculationVersion), milliseconds, meta) || chart; }, signal, version ? 'default' : 'no-store');
  }
  async function getPoint(index, { signal } = {}) {
    const meta = await getMeta({ signal });
    if (!Number.isInteger(index) || index < 0 || index >= meta.samples) throw new Error('Некорректный момент летописи.');
    if (signal?.aborted) throw createAbortError();
    const milliseconds = Date.parse(meta.startUtc) + index * meta.stepSeconds * 1000;
    const sample = cachedMinute(milliseconds);
    // Only an exact sample from the same engine/contract can replace transport.
    // A miss never fetches a whole day for a distant lifetime moment.
    if (sample) {
      return pointAt(transitSampleAt(sample.day, sample.index), index);
    }
    const stored = meta.calculationVersion ? await moments.readMoment(milliseconds, meta.calculationVersion) : null;
    if (metadata !== meta || signal?.aborted) throw createAbortError();
    if (stored) return pointAt(stored, index, meta);
    // Metadata selects the current immutable calculation revision. Let the
    // existing browser HTTP cache retain visited points across reloads, just
    // like day packets; errors and unversioned servers remain uncached.
    const version = meta.cacheVersion ? `&v=${encodeURIComponent(meta.cacheVersion)}` : '';
    return shared(index, `/api/lifetime?index=${index}${version}`,
      value => { const point = validateLifetimeMoment(value, meta, index); remember(point, meta); return pointAt(moments.peekMoment(milliseconds, meta.calculationVersion) || point, index, meta); }, signal, version ? 'default' : 'no-store');
  }
  return { getMeta, getPoint, peekMinute, hasMinute, readMinute, peekMoment, getMinute, invalidateMetadata };
}
