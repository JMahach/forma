import { NATAL_DAY_VERSION } from '../../shared/day-packets/natal-format.js';
import { decodeNatalDay } from '../../shared/day-packets/decode.js';
import { createBinaryCache } from './binary-cache.js';
import { createMemoryCache } from './memory-cache.js';
import { createAbortError, shareRequest } from './shared-request.js';

const compatibleTimezone = (day, timezone) => !timezone || day.timezone === timezone;

export function createNatalDayClient({
  fetch: fetchDay = globalThis.fetch, decode = decodeNatalDay,
  persistentCache = createBinaryCache({ databaseName: 'bodygraph-chart-days' }),
  memory = createMemoryCache(), calculationVersion = null, timeoutMs = 60_000,
} = {}) {
  const revision = /^[a-f0-9]{64}$/.test(calculationVersion ?? '') ? calculationVersion : null;
  const pending = new Map(), reads = new Map(), dayKeys = new WeakMap();
  function remember(key, day) {
    dayKeys.set(day, revision ? key : Symbol('natal-day'));
    if (revision) memory.put(key, day);
    return day;
  }
  function retainDay(day) {
    const key = dayKeys.get(day);
    if (key === undefined) return () => {};
    const release = memory.retain(key, day);
    return () => { release(); if (!revision) memory.delete(key); };
  }
  function forget(key) {
    memory.delete(key);
    Promise.resolve().then(() => revision && persistentCache?.remove(key)).catch(() => {});
  }

  function identity(chart) {
    const birthDate = chart?.birthDate, cityId = String(chart?.cityId ?? chart?.city?.id ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate || '') || !cityId) return null;
    return { birthDate, cityId, timezone: chart?.timezone, key: `natal-day:${revision}:${NATAL_DAY_VERSION}:${birthDate}:${cityId}` };
  }
  function validate(bytes, birthDate) {
    const day = decode(bytes);
    if (day.date !== birthDate) throw new Error('Сервер вернул расчёт другого дня.');
    if (revision && day.calculationVersion !== revision) throw new Error('Версия расчёта дня рождения изменилась. Обновите страницу.');
    return day;
  }
  function peekDay(chart) {
    const input = identity(chart);
    const day = revision && input ? memory.get(input.key) : null;
    return day && compatibleTimezone(day, input.timezone) ? day : null;
  }
  // Reading prepared birth-day numbers never joins a calculation request.
  // A lifetime view may reuse these bytes without opening the natal-day tool.
  async function readDay(chart, { signal } = {}) {
    if (signal?.aborted) throw createAbortError();
    const input = identity(chart);
    if (!revision || !input) return null;
    const hot = peekDay(chart); if (hot) return hot;
    const day = await shareRequest(reads, input.key, async ({ controller }) => {
      let bytes;
      try { bytes = await persistentCache?.get(input.key); } catch { return null; }
      if (controller.signal.aborted) throw createAbortError();
      if (!bytes) return null;
      try { return validate(bytes, input.birthDate); } catch { return null; }
    }, { signal });
    if (signal?.aborted) throw createAbortError();
    const ready = memory.get(input.key);
    if (ready && compatibleTimezone(ready, input.timezone)) return remember(input.key, ready);
    return day && compatibleTimezone(day, input.timezone) ? remember(input.key, day) : null;
  }

  async function getDay(chart, { signal } = {}) {
    const input = identity(chart);
    if (!input) throw new Error('Для просмотра дня нужны дата и город рождения.');
    const { birthDate, cityId, timezone, key } = input;
    if (signal?.aborted) throw createAbortError();
    const forChart = day => {
      if (!compatibleTimezone(day, timezone)) throw new Error('Часовой пояс расчёта не совпадает с картой.');
      return day;
    };
    const cached = revision && memory.get(key), skipDisk = cached && !compatibleTimezone(cached, timezone);
    if (cached && !skipDisk) return remember(key, cached);
    if (skipDisk) forget(key);
    return forChart(await shareRequest(pending, key, async ({ controller, consumers }) => {
      let bytes;
      try { if (revision && !skipDisk) bytes = await persistentCache?.get(key); } catch { /* Local storage is optional. */ }
      if (controller.signal.aborted) throw createAbortError();
      const ready = revision && memory.get(key);
      if (ready && [...consumers].every(consumer => compatibleTimezone(ready, consumer.timezone))) return remember(key, ready);
      if (bytes) {
        try {
          const day = validate(bytes, birthDate);
          // A cached packet must suit every current consumer. Otherwise only
          // the server can resolve which saved timezone still matches this city.
          if ([...consumers].every(consumer => compatibleTimezone(day, consumer.timezone))) return remember(key, day);
        } catch { /* Invalid cached bytes can be replaced by a fresh response. */ }
        forget(key);
      }
      let timedOut = false;
      const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        const response = await fetchDay('/api/chart/day', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
          body: JSON.stringify({ birthDate, cityId, v: NATAL_DAY_VERSION, ...(revision ? { r: revision } : {}) }), signal: controller.signal,
        });
        if (!response.ok) {
          let error;
          try { error = await response.json(); } catch { /* Proxies may return empty errors. */ }
          throw new Error(error?.message || 'Не удалось загрузить день рождения. Попробуйте ещё раз.');
        }
        bytes = await response.arrayBuffer();
        if (controller.signal.aborted) throw createAbortError();
        const day = validate(bytes, birthDate);
        // One stale caller must not reject a valid shared result for another.
        // Incompatible callers still fail independently below; without a
        // compatible consumer, the fresh packet is never retained.
        if ([...consumers].some(consumer => compatibleTimezone(day, consumer.timezone))) {
          Promise.resolve().then(() => revision && persistentCache?.put(key, bytes)).catch(() => {});
          remember(key, day);
        }
        return day;
      } catch (error) {
        if (timedOut) throw new Error('День рождения не успел загрузиться. Повторите попытку.');
        if (controller.signal.aborted || error.name === 'AbortError') throw createAbortError();
        if (error instanceof TypeError) throw new Error('Не удалось загрузить день рождения. Проверьте соединение.');
        throw error;
      } finally { clearTimeout(deadline); }
    }, { signal, consumer: { timezone } }));
  }
  return { getDay, peekDay, readDay, retainDay };
}
