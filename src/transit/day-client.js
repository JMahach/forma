import { TRANSIT_DAY_VERSION, decodeTransitDay } from './day-packet.js';

// Coalesce requests and retain only nearby UTC days. Browser HTTP caching also
// reuses these versioned, immutable packets across page loads.
export function createTransitDayClient({ fetch: fetchDay = globalThis.fetch, decode = decodeTransitDay, capacity = 4, timeoutMs = 20_000 } = {}) {
  const cache = new Map(), pending = new Map();
  async function getDay(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Некорректная дата транзита.');
    if (cache.has(date)) {
      const value = cache.get(date);
      cache.delete(date); cache.set(date, value);
      return value;
    }
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
      while (cache.size > capacity) cache.delete(cache.keys().next().value);
      return day;
    })();
    pending.set(date, request);
    try { return await request; }
    finally { clearTimeout(deadline); pending.delete(date); }
  }
  return { getDay };
}
