import type { CycleInput, CycleEvent, CycleEventsResult, CycleChartResult, CycleResult } from '../../shared/cycles-format.ts';
import type { ReturnStorage } from './return-storage.ts';
import type { MemoryCache } from './memory-cache.ts';
import type { SharedRequest } from './shared-request.ts';
type CycleAction = 'events' | 'chart';
export type CachedCycleChart = CycleChartResult & { event?: CycleEvent };
type ClientCycleResult = CycleResult & { event?: CycleEvent };
interface CyclesClientOptions {
  request?: (url: string, options: RequestInit) => Promise<unknown>;
  memory?: MemoryCache;
  timeoutMs?: number;
  cacheVersion?: string | null;
  returnStorage?: ReturnStorage | null;
}
export type CyclesClient = ReturnType<typeof createCyclesClient>;

import { requestJSON } from './api-client.ts';
import { validCycleResult, validCycleEvent } from '../../shared/cycles-format.ts';
import { LIFE_SPAN_YEARS } from '../../shared/date-limits.ts';
import { createReturnStorage } from './return-storage.ts';
import { DEFAULT_CYCLE_BODIES } from '../domain/cycles.ts';
import { createMemoryCache } from './memory-cache.ts';
import { createAbortError, shareRequest } from './shared-request.ts';

// Default body dates and every opened exact chart persist on the device. All
// reusable results share the tab byte budget; controllers pin active inputs.
export function createCyclesClient({ request = requestJSON, memory = createMemoryCache(), timeoutMs = 60_000,
  cacheVersion, returnStorage }: CyclesClientOptions = {}) {
  const reads = new Map<string, SharedRequest<unknown>>(), pending = new Map<string, SharedRequest<ClientCycleResult>>();
  const version = typeof cacheVersion === 'string' && /^[a-f0-9]{64}$/.test(cacheVersion) ? cacheVersion : null;
  const device = version ? returnStorage === undefined ? createReturnStorage() : returnStorage : null;
  const normalized = (action: CycleAction, input: CycleInput): CycleInput => action === 'events'
    ? { birthUtc: input.birthUtc, body: input.body, fromAge: input.fromAge ?? 0, toAge: input.toAge ?? LIFE_SPAN_YEARS }
    : { birthUtc: input.birthUtc, body: input.body, eventUtc: input.eventUtc, timezone: input.timezone ?? 'UTC' };
  const identity = (action: CycleAction, input: CycleInput) => JSON.stringify([action, version, ...Object.values(normalized(action, input))]);
  const eventFields = ['id', 'body', 'utc', 'age', 'cycle', 'pass', 'cycleId', 'direction'] as const;
  const confirmsEvent = (event: CycleEvent | null | undefined, input: CycleInput): event is CycleEvent => validCycleEvent(event, input) && event!.utc === input.eventUtc;
  async function get(action: CycleAction, input: CycleInput, signal?: AbortSignal, { event, cacheOnly = false }: { event?: CycleEvent | null; cacheOnly?: boolean } = {}): Promise<ClientCycleResult | null> {
    if (signal?.aborted) throw createAbortError();
    if (cacheOnly && !version) return null;
    // Copy before the optional device read so callers cannot mutate identity.
    input = normalized(action, input);
    const key = identity(action, input);
    const memoryKey = `return-${action}:${key}`;
    const persistent = device && (action === 'chart' || DEFAULT_CYCLE_BODIES.includes(input.body));
    const confirmed = action === 'chart' && confirmsEvent(event, input)
      ? Object.fromEntries(eventFields.map(field => [field, event[field]])) as unknown as CycleEvent : null;
    const usable = (data: ClientCycleResult | null): data is ClientCycleResult => !!data && (!cacheOnly || confirmsEvent(data.event, input));
    const accept = (data: ClientCycleResult, { save = false, remember = true } = {}) => {
      const enrich = confirmed && eventFields.some(field => confirmed[field] !== data.event?.[field]);
      const result = enrich ? { ...data, event: confirmed } : data;
      if (remember || enrich) memory.put(memoryKey, result);
      if (persistent && (save || enrich)) Promise.resolve().then(() => action === 'events'
        ? device!.putEvents(key, input, result as CycleEventsResult) : device!.putChart(key, result)).catch(() => {});
      return result;
    };
    const remembered = memory.get<ClientCycleResult>(memoryKey);
    if (usable(remembered)) return accept(remembered, { remember: false });
    // A different tab may have finished this key while our network request
    // still waits. Read ready device data before joining that pending request.
    if (persistent) {
      const read = action === 'events' ? 'getEvents' : 'getChart';
      const remove = action === 'events' ? 'removeEvents' : 'removeChart';
      const preceding = pending.get(key);
      const data = await shareRequest(reads, key, async () => {
        try { return await device![read](key); } catch { return null; }
      }, { signal });
      if (signal?.aborted) throw createAbortError();
      if (data) {
        if (validCycleResult(action, data, input)) {
          if (usable(data)) return accept(data);
        } else Promise.resolve().then(() => device![remove](key)).catch(() => {});
      }
      // Another owner may have filled common RAM while this device snapshot
      // was still pending. A late miss never overrides ready shared data.
      const latest = memory.get<ClientCycleResult>(memoryKey);
      if (usable(latest)) return accept(latest, { remember: false });
      // Keep the preceding request until this read settles even when its result
      // was too large to stay in the idle memory budget.
      if (!cacheOnly && preceding && pending.get(key) !== preceding && !preceding.controller.signal.aborted) {
        const completed = await preceding.promise.catch(() => null);
        if (signal?.aborted) throw createAbortError();
        if (completed) return accept(completed);
      }
    }
    if (cacheOnly) return null;
    return shareRequest(pending, key, async ({ controller }) => {
      if (controller.signal.aborted) throw createAbortError();
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        const data = await request(`/api/cycles/${action}`, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json',
          ...(version ? { 'X-Forma-Cycles-Version': version } : {}) }, body: JSON.stringify(input), signal: controller.signal });
        if (controller.signal.aborted) throw createAbortError();
        if (!validCycleResult(action, data, input)) throw new Error('Сервер вернул неполные данные цикла.');
        return accept(data, { save: true });
      } catch (error) {
        if ((error as Error).name === 'AbortError' && timedOut) throw new Error('Расчёт не успел завершиться. Попробуйте ещё раз.');
        throw error;
      } finally { clearTimeout(timeout); }
    }, { signal });
  }
  return { events: (input: CycleInput, signal?: AbortSignal) => get('events', input, signal) as Promise<CycleEventsResult>,
    chart: (input: CycleInput, signal?: AbortSignal, options?: { event?: CycleEvent | null }) => get('chart', input, signal, options) as Promise<CachedCycleChart>,
    // A confirmed cached chart carries its own current-revision event label.
    // This never joins numerical requests or asks for the body's dates.
    readChart: (input: CycleInput, { signal }: { signal?: AbortSignal } = {}) => get('chart', input, signal, { cacheOnly: true }) as Promise<CachedCycleChart | null>,
    retainChart: (input: CycleInput, data: CachedCycleChart) => memory.retain(`return-chart:${identity('chart', input)}`, data),
    retainEvents: (input: CycleInput, data: CycleEventsResult) => memory.retain(`return-events:${identity('events', input)}`, data) };
}
