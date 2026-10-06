import { TRANSIT_DAY_VERSION } from '../../shared/day-packets/transit-format.js';
import { decodeTransitDay } from '../../shared/day-packets/decode.js';

// Coalesce requests and retain only nearby UTC days. Browser HTTP caching also
// reuses these versioned, immutable packets across page loads.
export function createTransitDayClient({ fetch: fetchDay = globalThis.fetch, decode = decodeTransitDay, capacity = 4, timeoutMs = 20_000, initialDate = null } = {}) {
  const cache = new Map(), pending = new Map(), retained = new Map();
  function prune() {
    let unused = cache.size - retained.size;
    for (const date of cache.keys()) {
      if (unused <= capacity) break;
      if (!retained.has(date)) { cache.delete(date); unused--; }
    }
  }
  // The live local day owns at most two packets. Keep those same objects in
  // the shared lookup; unrelated requests only evict the inactive LRU reserve.
  function retainDay(day) {
    cache.set(day.date, day);
    retained.set(day.date, (retained.get(day.date) || 0) + 1);
    prune();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = retained.get(day.date) - 1;
      if (count) retained.set(day.date, count);
      else retained.delete(day.date);
      prune();
    };
  }
  function peekDay(date) {
    const day = cache.get(date);
    if (day) { cache.delete(date); cache.set(date, day); }
    return day || null;
  }
  async function getDay(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Некорректная дата транзита.');
    const remembered = peekDay(date);
    if (remembered) return remembered;
    if (pending.has(date)) return pending.get(date);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    const request = (async () => {
      let response;
      try {
        response = await fetchDay(`/api/transit/day?date=${encodeURIComponent(date)}&v=${encodeURIComponent(TRANSIT_DAY_VERSION)}`, { signal: controller.signal });
      } catch (error) {
        throw new Error(error.name === 'AbortError' ? 'Транзит дня не успел загрузиться. Повторите попытку.' : 'Не удалось загрузить транзит дня. Проверьте соединение.');
      }
      if (!response.ok) {
        let error;
        try { error = await response.json(); } catch { /* Some proxies return an empty error response. */ }
        throw new Error(error?.message || 'Не удалось загрузить транзит дня. Попробуйте ещё раз.');
      }
      const day = decode(await response.arrayBuffer());
      if (day.date !== date) throw new Error('Сервер вернул транзит другого дня.');
      cache.set(date, day);
      prune();
      return day;
    })();
    pending.set(date, request);
    try { return await request; }
    finally { clearTimeout(deadline); pending.delete(date); }
  }
  // Preserve even an early failure until the live view takes ownership, so it
  // follows the same error/backoff path instead of silently issuing a retry.
  let initial = initialDate ? getDay(initialDate) : null;
  initial?.catch(() => {});
  return { peekDay, retainDay, getDay(date) {
    if (initial && date === initialDate) {
      const started = initial;
      initial = null;
      return started;
    }
    return getDay(date);
  } };
}
