import { fetchResource } from './http-transport.ts';
type DayResponse = Pick<Response, 'ok' | 'json' | 'arrayBuffer'>;
import type { TransitDay } from '../../shared/day-packets/transit-format.ts';
import type { TransitDayCache } from './transit-day-cache.ts';
import type { MemoryCache } from './memory-cache.ts';
import type { SharedRequest } from '../runtime/shared-request.ts';
interface TransitClientOptions {
  fetch?: (url: string, options: RequestInit & { signal: AbortSignal }) => DayResponse | PromiseLike<DayResponse>;
  decode?: (bytes: ArrayBuffer) => TransitDay;
  timeoutMs?: number;
  initialDate?: string | null;
  memory?: MemoryCache;
  days?: TransitDayCache;
}
export type TransitDayClient = ReturnType<typeof createTransitDayClient>;

import { TRANSIT_DAY_VERSION } from '../../shared/day-packets/transit-format.ts';
import { decodeTransitDay } from '../../shared/day-packets/decode.ts';
import { createTransitDayCache } from './transit-day-cache.ts';
import { createMemoryCache } from './memory-cache.ts';
import { createAbortError, shareRequest } from '../runtime/shared-request.ts';

// Day is a transport adapter. The common full-day cache owns reusable numbers.
export function createTransitDayClient({ fetch: fetchDay = fetchResource, decode = decodeTransitDay,
  timeoutMs = 20_000, initialDate = null,
  memory = createMemoryCache(), days = createTransitDayCache({ memory }),
}: TransitClientOptions = {}) {
  const pending = new Map<string, SharedRequest<TransitDay>>();
  const peekDay = (date: string) => days.peekDay(date);
  /** Local first; a miss downloads and optionally stores the complete day. */
  async function getDay(date: string, { signal }: { signal?: AbortSignal } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Некорректная дата транзита.');
    if (signal?.aborted) throw createAbortError();
    const remembered = peekDay(date);
    if (remembered) {days.markDayUsed(remembered);return remembered;}
    return shareRequest(pending, date, async ({ controller }) => {
      // Actual opening prepares supported legacy data before deciding it is
      // absent. Passive reads never trigger that migration themselves.
      await days.prepare();
      if(controller.signal.aborted)throw createAbortError();
      const saved = await days.readLocalDay(date);
      if (controller.signal.aborted) throw createAbortError();
      if (saved) {days.markDayUsed(saved);return saved;}
      let timedOut = false;
      const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        let response;
        try {
          response = await fetchDay(`/api/transit/day?date=${encodeURIComponent(date)}&v=${TRANSIT_DAY_VERSION}`, { signal: controller.signal, cache: 'no-store' });
        } catch (error) {
          if (controller.signal.aborted) throw createAbortError();
          if ((error as Error).name === 'ConnectionError') throw error;
          throw Object.assign(new Error('Не удалось загрузить транзит дня. Проверьте соединение.'), {code:'connection_failed'});
        }
        if (!response.ok) {
          let failure; try { failure = await response.json(); } catch {}
          throw Object.assign(new Error(failure?.message || 'Не удалось загрузить транзит дня. Попробуйте ещё раз.'), { code: failure?.error });
        }
        const day = decode(await response.arrayBuffer());
        if (controller.signal.aborted) throw createAbortError();
        if (day.date !== date) throw new Error('Сервер вернул транзит другого дня.');
        days.putDay(day);
        return days.peekDay(date) || day;
      } catch(error) {
        // One deadline covers both the response headers and its complete body.
        if(timedOut)throw Object.assign(new Error('Транзит дня не успел загрузиться. Повторите попытку.'),{code:'server_unavailable'});
        if(controller.signal.aborted)throw createAbortError();
        throw error;
      } finally { clearTimeout(deadline); }
    }, { signal });
  }
  // Preserve an early failure until the live view takes ownership of its retry.
  const preload = new AbortController();
  let initial = initialDate ? getDay(initialDate, { signal: preload.signal }) : null;
  initial?.catch(() => {});
  return { days, memory: days.memory || memory, peekDay, retainDay: (day: TransitDay) => days.retainDay(day),
    getDay(date: string, options?: { signal?: AbortSignal }) {
      if (initial && date === initialDate) {
        const started = initial; initial = null;
        if (pending.has(date)) {
          // Join before releasing the preload so the physical request always
          // has an owner; other independent consumers keep their own waits.
          const joined = getDay(date, options); preload.abort(); return joined;
        }
        if (options?.signal?.aborted) return Promise.reject(createAbortError());
        return started; // Keep a completed early failure for the live retry policy.
      }
      return getDay(date, options);
    } };
}
