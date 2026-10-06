import { requestJSON } from './api-client.js';
import { validCycleResult } from '../../shared/cycles-format.js';
import { createBinaryCache } from './binary-cache.js';

// Birth details stay in POST bodies and optional device storage. Only validated
// results from the bootstrap calculation revision can survive a page reload.
export function createCyclesClient({ request = requestJSON, capacity = 40, timeoutMs = 60_000,
  cacheVersion, persistentCache } = {}) {
  const cache = new Map();
  const version = typeof cacheVersion === 'string' && /^[a-f0-9]{64}$/.test(cacheVersion) ? cacheVersion : null;
  const device = version ? persistentCache === undefined ? createBinaryCache({ databaseName: 'bodygraph-cycles',
    capacity: 40, maxBytes: 2 * 1024 * 1024, maxAgeMs: Infinity, timeoutMs: 100 }) : persistentCache : null;
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
  function remember(key, data) {
    cache.delete(key); cache.set(key, data);
    while (cache.size > capacity) cache.delete(cache.keys().next().value);
    return data;
  }
  async function get(action, input, signal) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    // Match the server's calculation identity. An event list is independent
    // of display timezone; an exact chart retains it and every UTC digit.
    const key = JSON.stringify(action === 'events'
      ? [action, input.birthUtc, input.body, input.fromAge ?? 0, input.toAge ?? 100]
      : [action, input.birthUtc, input.body, input.eventUtc, input.timezone ?? 'UTC']);
    if (cache.has(key)) {
      return remember(key, cache.get(key));
    }
    const deviceKey = `${version}:${key}`;
    if (device) {
      let bytes;
      try { bytes = await device.get(deviceKey); } catch { /* Device storage is optional. */ }
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (bytes) {
        try {
          const data = JSON.parse(decoder.decode(bytes));
          if (!validCycleResult(action, data, input)) throw new Error('Invalid cached cycle');
          return remember(key, data);
        } catch { Promise.resolve().then(() => device.remove(deviceKey)).catch(() => {}); }
      }
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, timeoutMs);
    try {
      const data = await request(`/api/cycles/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json',
        ...(version ? { 'X-Forma-Cycles-Version': version } : {}) }, body: JSON.stringify(input), signal: controller.signal });
      if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (!validCycleResult(action, data, input)) throw new Error('Сервер вернул неполные данные цикла.');
      if (device) {
        const bytes = encoder.encode(JSON.stringify(data)).buffer;
        Promise.resolve().then(() => device.put(deviceKey, bytes)).catch(() => {});
      }
      return remember(key, data);
    } catch (error) {
      if (error.name === 'AbortError' && !signal?.aborted) throw new Error('Расчёт не успел завершиться. Попробуйте меньший диапазон.');
      throw error;
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }
  return { events: (input, signal) => get('events', input, signal), chart: (input, signal) => get('chart', input, signal) };
}
