import { fetchResource, responseError } from './http-transport.ts';
type DayResponse = Pick<Response, 'ok' | 'json' | 'arrayBuffer'> & Partial<Pick<Response,'status'>>;
import type { ChartRecord } from '../../shared/chart-types.ts';
import type { NatalDay } from '../../shared/day-packets/natal-format.ts';
import type { BinaryCache } from './binary-cache.ts';
import type { MemoryCache } from './memory-cache.ts';
import type { SharedRequest } from '../runtime/shared-request.ts';
type BirthDayIdentity = Partial<Pick<ChartRecord, 'birthDate' | 'cityId' | 'city' | 'timezone'>>;
interface NatalClientOptions {
  fetch?: (url: string, options: RequestInit & { signal: AbortSignal }) => DayResponse | PromiseLike<DayResponse>;
  decode?: (bytes: ArrayBuffer) => NatalDay;
  persistentCache?: BinaryCache | null;
  memory?: MemoryCache;
  calculationVersion?: string | null;
  timeoutMs?: number;
}
export type NatalDayClient = ReturnType<typeof createNatalDayClient>;

import { NATAL_DAY_VERSION } from '../../shared/day-packets/natal-format.ts';
import { decodeNatalDay } from '../../shared/day-packets/decode.ts';
import { createBinaryCache } from './binary-cache.ts';
import { createMemoryCache } from './memory-cache.ts';
import { createAbortError, shareRequest } from '../runtime/shared-request.ts';

const compatibleTimezone = (day: NatalDay, timezone: string | undefined) => !timezone || day.timezone === timezone;

export function createNatalDayClient({
  fetch: fetchDay = fetchResource, decode = decodeNatalDay,
  persistentCache = createBinaryCache({ databaseName: 'bodygraph-chart-days' }),
  memory = createMemoryCache(), calculationVersion = null, timeoutMs = 60_000,
}: NatalClientOptions = {}) {
  const revision = /^[a-f0-9]{64}$/.test(calculationVersion ?? '') ? calculationVersion : null;
  const pending = new Map<string, SharedRequest<NatalDay, { timezone: string | undefined }>>();
  const reads = new Map<string, SharedRequest<NatalDay | null>>(), dayKeys = new WeakMap<NatalDay, string | symbol>();
  const touches = new Map<string, Promise<unknown>>();
  function touch(key:string) {
    if(!revision || touches.has(key))return;
    const work=Promise.resolve().then(()=>persistentCache?.touch?.(key)).catch(()=>{})
      .finally(()=>{if(touches.get(key)===work)touches.delete(key);});
    touches.set(key,work);
  }
  function remember(key: string, day: NatalDay) {
    dayKeys.set(day, revision ? key : Symbol('natal-day'));
    if (revision) {memory.put(key, day);touch(key);}
    return day;
  }
  function retainDay(day: NatalDay) {
    const key = dayKeys.get(day);
    if (key === undefined) return () => {};
    const release = memory.retain(key, day);
    return () => { release(); if (!revision) memory.delete(key); };
  }
  function forget(key: string) {
    memory.delete(key);
    Promise.resolve().then(() => revision ? persistentCache?.remove(key) : null).catch(() => {});
  }

  function identity(chart: BirthDayIdentity | null | undefined) {
    const birthDate = chart?.birthDate, cityId = String(chart?.cityId ?? chart?.city?.id ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate || '') || !cityId) return null;
    return { birthDate: birthDate!, cityId, timezone: chart?.timezone, key: `natal-day:${revision}:${NATAL_DAY_VERSION}:${birthDate}:${cityId}` };
  }
  function validate(bytes: ArrayBuffer, birthDate: string) {
    let day:NatalDay;
    try{day=decode(bytes);}catch(error){
      if(error instanceof Error && !('code' in error))Object.assign(error,{code:'invalid_response'});
      throw error;
    }
    if (day.date !== birthDate) throw Object.assign(new Error('Сервер вернул расчёт другого дня.'),{code:'invalid_response'});
    if (revision && day.calculationVersion !== revision) throw Object.assign(new Error('Версия расчёта дня рождения изменилась. Обновите страницу.'),{code:'unsupported_version'});
    return day;
  }
  function peekDay(chart: BirthDayIdentity | null | undefined) {
    const input = identity(chart);
    const day = revision && input ? memory.get<NatalDay>(input.key) : null;
    if(day && compatibleTimezone(day,input!.timezone)){touch(input!.key);return day;}
    return null;
  }
  // Reading prepared birth-day numbers never joins a calculation request.
  // A lifetime view may reuse these bytes without opening the natal-day tool.
  async function readDay(chart: BirthDayIdentity | null | undefined, { signal }: { signal?: AbortSignal } = {}) {
    if (signal?.aborted) throw createAbortError();
    const input = identity(chart);
    if (!revision || !input) return null;
    const hot = peekDay(chart); if (hot) return hot;
    const day = await shareRequest(reads, input.key, async ({ controller }) => {
      let bytes: ArrayBuffer | null | undefined;
      try { bytes = await persistentCache?.get(input.key); } catch { return null; }
      if (controller.signal.aborted) throw createAbortError();
      if (!bytes) return null;
      try { return validate(bytes, input.birthDate); } catch { return null; }
    }, { signal });
    if (signal?.aborted) throw createAbortError();
    const ready = memory.get<NatalDay>(input.key);
    if (ready && compatibleTimezone(ready, input.timezone)) return remember(input.key, ready);
    return day && compatibleTimezone(day, input!.timezone) ? remember(input.key, day) : null;
  }

  async function getDay(chart: BirthDayIdentity | null | undefined, { signal }: { signal?: AbortSignal } = {}) {
    const input = identity(chart);
    if (!input) throw Object.assign(new Error('Для просмотра дня нужны дата и город рождения.'),{code:'invalid_request'});
    const { birthDate, cityId, timezone, key } = input;
    if (signal?.aborted) throw createAbortError();
    const forChart = (day: NatalDay) => {
      if (!compatibleTimezone(day, timezone)) throw Object.assign(new Error('Часовой пояс расчёта не совпадает с картой.'),{code:'invalid_response'});
      return day;
    };
    const cached = revision && memory.get<NatalDay>(key), skipDisk = cached && !compatibleTimezone(cached, timezone);
    if (cached && !skipDisk) return remember(key, cached);
    if (skipDisk) forget(key);
    return forChart(await shareRequest(pending, key, async ({ controller, consumers }) => {
      let bytes: ArrayBuffer | null | undefined;
      try { if (revision && !skipDisk) bytes = await persistentCache?.get(key); } catch { /* Local storage is optional. */ }
      if (controller.signal.aborted) throw createAbortError();
      const ready = revision && memory.get<NatalDay>(key);
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
          throw responseError(response.status,error,'Не удалось загрузить день рождения. Попробуйте ещё раз.');
        }
        bytes = await response.arrayBuffer();
        if (controller.signal.aborted) throw createAbortError();
        const day = validate(bytes, birthDate);
        // One stale caller must not reject a valid shared result for another.
        // Incompatible callers still fail independently below; without a
        // compatible consumer, the fresh packet is never retained.
        if ([...consumers].some(consumer => compatibleTimezone(day, consumer.timezone))) {
          Promise.resolve().then(() => revision ? persistentCache?.put(key, bytes!) : null).catch(() => {});
          remember(key, day);
        }
        return day;
      } catch (error) {
        if (timedOut) throw Object.assign(new Error('День рождения не успел загрузиться. Повторите попытку.'),{code:'timeout'});
        if (controller.signal.aborted || (error as Error).name === 'AbortError') throw createAbortError();
        if (error instanceof TypeError) throw Object.assign(new Error('Не удалось загрузить день рождения. Проверьте соединение.'),{code:'connection_failed'});
        throw error;
      } finally { clearTimeout(deadline); }
    }, { signal, consumer: { timezone } }));
  }
  return { getDay, peekDay, readDay, retainDay };
}
