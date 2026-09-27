import { CHART_DAY_VERSION } from '../../shared/day-packets/natal-format.js';
import { decodeChartDay } from '../../shared/day-packets/decode.js';
import { createChartDayCache } from './natal-day-cache.js';

const aborted = () => new DOMException('Загрузка отменена.', 'AbortError');

export function createChartDayClient({
  fetch: fetchDay = globalThis.fetch, decode = decodeChartDay,
  persistentCache = createChartDayCache(), capacity = 3, timeoutMs = 60_000,
} = {}) {
  const memory = new Map(), pending = new Map();
  const limit = Math.max(1, Math.floor(capacity));
  function remember(key, day) {
    memory.delete(key); memory.set(key, day);
    while (memory.size > limit) memory.delete(memory.keys().next().value);
    return day;
  }

  async function getDay(chart, { signal } = {}) {
    const birthDate = chart?.birthDate, cityId = String(chart?.cityId ?? chart?.city?.id ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate || '') || !cityId) throw new Error('Для просмотра дня нужны дата и город рождения.');
    if (signal?.aborted) throw aborted();
    const forChart = day => {
      if (chart.timezone && day.timezone !== chart.timezone) throw new Error('Часовой пояс расчёта не совпадает с картой.');
      return day;
    };
    const key = `${CHART_DAY_VERSION}:${birthDate}:${cityId}`;
    if (memory.has(key)) return forChart(remember(key, memory.get(key)));
    let request = pending.get(key);
    if (!request) {
      const controller = new AbortController();
      request = { controller, consumers: new Set(), promise: null };
      const ownedRequest = request;
      request.promise = (async () => {
        const validate = bytes => {
          const day = decode(bytes);
          if (day.date !== birthDate) throw new Error('Сервер вернул расчёт другого дня.');
          return day;
        };
        let bytes;
        try { bytes = await persistentCache?.get(key); } catch { /* Local storage is optional. */ }
        if (controller.signal.aborted) throw aborted();
        if (bytes) {
          try { return remember(key, validate(bytes)); }
          catch { Promise.resolve().then(() => persistentCache?.remove(key)).catch(() => {}); }
        }
        let timedOut = false;
        const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        try {
          const response = await fetchDay('/api/chart/day', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
            body: JSON.stringify({ birthDate, cityId, v: CHART_DAY_VERSION }), signal: controller.signal,
          });
          if (!response.ok) {
            let error;
            try { error = await response.json(); } catch { /* Proxies may return empty errors. */ }
            throw new Error(error?.message || 'Не удалось загрузить день рождения. Попробуйте ещё раз.');
          }
          bytes = await response.arrayBuffer();
          if (controller.signal.aborted) throw aborted();
          const day = validate(bytes);
          // Disk writes are best effort and never delay an interactive result.
          Promise.resolve().then(() => persistentCache?.put(key, bytes)).catch(() => {});
          return remember(key, day);
        } catch (error) {
          if (timedOut) throw new Error('День рождения не успел загрузиться. Повторите попытку.');
          if (controller.signal.aborted || error.name === 'AbortError') throw aborted();
          if (error instanceof TypeError) throw new Error('Не удалось загрузить день рождения. Проверьте соединение.');
          throw error;
        } finally { clearTimeout(deadline); }
      })().finally(() => { if (pending.get(key) === ownedRequest) pending.delete(key); });
      pending.set(key, request);
    }
    // Multiple consumers share a request; cancellation only stops transport once
    // none of them need it. Navigation still invalidates its own result at once.
    return forChart(await new Promise((resolve, reject) => {
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
    }));
  }
  return { getDay };
}
