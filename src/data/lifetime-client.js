import { validateLifetimeMetadata, validateLifetimeMoment, lifetimeChartAt, lifetimeExactChartAt } from '../domain/lifetime.js';
import { transitSampleAt, transitChartAt } from '../domain/transit-day.js';
import { TRANSIT_DAY_VERSION } from '../../shared/day-packets/transit-format.js';

const aborted = () => new DOMException('Загрузка отменена.', 'AbortError');

// Only visited points live in browser memory. Concurrent consumers of the same
// point share transport; cancelling one must not cancel another consumer.
export function createLifetimeClient({ fetch: fetchPoint = globalThis.fetch, capacity = 256, timeoutMs = 20_000, dayClient = null } = {}) {
  const memory = new Map(), pending = new Map();
  const limit = Math.min(256, Math.max(1, Number.isFinite(capacity) ? Math.floor(capacity) : 256));
  let metadata = null;
  function remember(index, point) {
    memory.delete(index); memory.set(index, point);
    while (memory.size > limit) memory.delete(memory.keys().next().value);
    return point;
  }
  function shared(key, url, validate, signal, cache = 'no-store') {
    if (signal?.aborted) return Promise.reject(aborted());
    let request = pending.get(key);
    if (!request) {
      const controller = new AbortController();
      request = { controller, consumers: new Set(), promise: null };
      const owned = request;
      let timedOut = false;
      const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      request.promise = Promise.resolve().then(async () => {
        try {
          const response = await fetchPoint(url, { signal: controller.signal, cache });
          if (!response.ok) {
            let failure;
            try { failure = await response.json(); } catch { /* Local server errors may have no JSON body. */ }
            throw new Error(failure?.message || 'Не удалось загрузить шкалу лет.');
          }
          const value = await response.json();
          if (controller.signal.aborted) throw aborted();
          return validate(value);
        } catch (error) {
          if (timedOut) throw new Error('Шкала лет не успела загрузиться. Повторите попытку.');
          if (controller.signal.aborted || error?.name === 'AbortError') throw aborted();
          if (error instanceof TypeError) throw new Error('Не удалось загрузить шкалу лет. Проверьте соединение.');
          throw error;
        } finally {
          clearTimeout(deadline);
          if (pending.get(key) === owned) pending.delete(key);
        }
      });
      pending.set(key, request);
    }
    return new Promise((resolve, reject) => {
      const consumer = {};
      request.consumers.add(consumer);
      const release = () => { signal?.removeEventListener('abort', cancel); request.consumers.delete(consumer); };
      const cancel = () => {
        release(); reject(aborted());
        if (!request.consumers.size) {
          request.controller.abort();
          if (pending.get(key) === request) pending.delete(key);
        }
      };
      signal?.addEventListener('abort', cancel, { once: true });
      request.promise.then(value => { release(); resolve(value); }, error => { release(); reject(error); });
      if (signal?.aborted) cancel();
    });
  }
  async function getMeta({ signal } = {}) {
    if (signal?.aborted) throw aborted();
    if (metadata) return metadata;
    return shared('meta', '/api/lifetime/meta', value => (metadata = validateLifetimeMetadata(value)), signal);
  }
  function validMinute(milliseconds) {
    return metadata && Number.isSafeInteger(milliseconds) && milliseconds % 60000 === 0
      && milliseconds >= Date.parse(metadata.startUtc) && milliseconds < Date.parse(metadata.endExclusiveUtc);
  }
  function minuteAt(milliseconds, day) {
    if (!validMinute(milliseconds) || day?.version !== TRANSIT_DAY_VERSION || day.stepSeconds !== 60
        || day.engine !== (metadata.engine || metadata.source)
        || day.nodeModel !== 'true' || day.zodiac !== 'tropical-geocentric-apparent') return null;
    const index = (milliseconds - Date.parse(day.startUtc)) / 60000;
    return Number.isInteger(index) && index >= 0 && index < day.samples ? { day, index } : null;
  }
  function cachedMinute(milliseconds) {
    if (!validMinute(milliseconds)) return null;
    return minuteAt(milliseconds, dayClient?.peekDay(new Date(milliseconds).toISOString().slice(0, 10)));
  }
  function peekMinute(milliseconds) {
    const sample = cachedMinute(milliseconds);
    return sample ? transitChartAt(sample.day, sample.index) : null;
  }
  // Only restoration requests a missing exact minute. Ordinary scrubs keep
  // ready Day minutes and archive points; no path loads a whole day for one UTC.
  async function getMinute(milliseconds, { signal } = {}) {
    const meta = await getMeta({ signal });
    if (signal?.aborted) throw aborted();
    if (!validMinute(milliseconds)) throw new Error('Некорректная минута шкалы лет.');
    const cached = peekMinute(milliseconds);
    if (cached) return cached;
    const index = (milliseconds - Date.parse(meta.startUtc)) / (meta.stepSeconds * 1000);
    if (Number.isInteger(index)) return lifetimeChartAt(meta, await getPoint(index, { signal }));
    const utc = new Date(milliseconds).toISOString().replace('.000Z', 'Z'), key = `utc:${utc}`;
    if (memory.has(key)) return remember(key, memory.get(key));
    const version = meta.cacheVersion ? `&v=${encodeURIComponent(meta.cacheVersion)}` : '';
    return shared(key, `/api/lifetime/moment?utc=${encodeURIComponent(utc)}${version}`,
      value => remember(key, lifetimeExactChartAt(value, meta, milliseconds)), signal, version ? 'default' : 'no-store');
  }
  async function getPoint(index, { signal } = {}) {
    const meta = await getMeta({ signal });
    if (!Number.isInteger(index) || index < 0 || index >= meta.samples) throw new Error('Некорректный момент шкалы лет.');
    if (signal?.aborted) throw aborted();
    if (memory.has(index)) return remember(index, memory.get(index));
    const milliseconds = Date.parse(meta.startUtc) + index * meta.stepSeconds * 1000;
    const sample = cachedMinute(milliseconds);
    // Only an exact sample from the same engine/contract can replace transport.
    // A miss never fetches a whole day for a distant archive moment.
    if (sample) {
      return remember(index, validateLifetimeMoment({ index, ...transitSampleAt(sample.day, sample.index) }, meta, index));
    }
    // Metadata selects the current immutable calculation revision. Let the
    // existing browser HTTP cache retain visited points across reloads, just
    // like day packets; errors and unversioned servers remain uncached.
    const version = meta.cacheVersion ? `&v=${encodeURIComponent(meta.cacheVersion)}` : '';
    return shared(index, `/api/lifetime?index=${index}${version}`,
      value => remember(index, validateLifetimeMoment(value, meta, index)), signal, version ? 'default' : 'no-store');
  }
  return { getMeta, getPoint, peekMinute, getMinute };
}
