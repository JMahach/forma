import { TRANSIT_DAY_VERSION } from '../../shared/day-packets/transit-format.js';
import { decodeTransitDay } from '../../shared/day-packets/decode.js';
import { createMomentCache } from './moment-cache.js';
import { createAbortError, shareRequest } from './shared-request.js';

// Day is a transport adapter. The common moment cache owns every saved number.
export function createTransitDayClient({ fetch: fetchDay = globalThis.fetch, decode = decodeTransitDay,
  calculationVersion = null, timeoutMs = 20_000, initialDate = null,
  moments = createMomentCache(),
} = {}) {
  const pending = new Map();
  const peekDay = date => calculationVersion ? moments.peekDay(date, calculationVersion) : null;
  async function getDay(date, { signal } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Некорректная дата транзита.');
    if (signal?.aborted) throw createAbortError();
    const remembered = peekDay(date); if (remembered) return remembered;
    return shareRequest(pending, date, async ({ controller }) => {
      if (calculationVersion) {
        const saved = await moments.getDay(date, calculationVersion);
        if (controller.signal.aborted) throw createAbortError();
        if (saved) return saved;
      }
      let timedOut = false;
      const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        let response;
        try {
          response = await fetchDay(`/api/transit/day?date=${encodeURIComponent(date)}&v=${TRANSIT_DAY_VERSION}${calculationVersion ? `&r=${calculationVersion}` : ''}`, { signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted && !timedOut) throw createAbortError();
          throw new Error(timedOut ? 'Транзит дня не успел загрузиться. Повторите попытку.' : 'Не удалось загрузить транзит дня. Проверьте соединение.');
        }
        if (!response.ok) {
          let failure; try { failure = await response.json(); } catch {}
          throw Object.assign(new Error(failure?.message || 'Не удалось загрузить транзит дня. Попробуйте ещё раз.'), { code: failure?.error });
        }
        const day = decode(await response.arrayBuffer());
        if (controller.signal.aborted) throw createAbortError();
        if (day.date !== date) throw new Error('Сервер вернул транзит другого дня.');
        if (calculationVersion && day.calculationVersion !== calculationVersion) throw Object.assign(new Error('Версия дневного транзита не поддерживается.'), { code: 'unsupported_version' });
        calculationVersion ||= day.calculationVersion;
        if (!calculationVersion) return day; // Unknown numeric revisions cannot enter the shared cache.
        moments.putDay(day);
        return moments.peekDay(date, calculationVersion) || day;
      } finally { clearTimeout(deadline); }
    }, { signal });
  }
  // Preserve an early failure until the live view takes ownership of its retry.
  let initial = initialDate ? getDay(initialDate) : null;
  initial?.catch(() => {});
  return { moments, peekDay, retainDay: day => day.calculationVersion ? moments.retainDay(day) : () => {},
    getDay(date, options) {
      if (initial && date === initialDate) { const started = initial; initial = null; return started; }
      return getDay(date, options);
    } };
}
