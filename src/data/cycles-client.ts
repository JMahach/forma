import {MAX_RETURN_PROOF_LENGTH} from '../../shared/chart-return-contract.ts';
import type { CycleInput, CycleEvent, CycleEventsResult, CycleChartResult, CycleResult } from '../../shared/cycles-format.ts';
import type { ReturnStorage } from './return-storage.ts';
import type { MemoryCache } from './memory-cache.ts';
import type { SharedRequest } from './shared-request.ts';
type CycleAction = 'events' | 'chart';
export interface CycleOwner { chartId: string; expectedAccountId: string }
interface CycleOptions { event?: CycleEvent | null; owner?: CycleOwner | null; cacheOnly?: boolean; preserve?: boolean }
export type CachedCycleChart = CycleChartResult & { event?: CycleEvent; proof?: string };
type ClientCycleResult = CycleResult & { event?: CycleEvent; proof?: string };
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

// Only default body dates and opened charts persist on the device. Other bodies
// stay in shared tab memory; controllers pin active inputs within its byte budget.
export function createCyclesClient({ request = requestJSON, memory = createMemoryCache(), timeoutMs = 60_000,
  cacheVersion, returnStorage }: CyclesClientOptions = {}) {
  const lifetime = new AbortController(), attachments = new Map<string, SharedRequest<unknown>>();
  const reads = new Map<string, SharedRequest<unknown>>(), pending = new Map<string, SharedRequest<ClientCycleResult>>();
  const version = typeof cacheVersion === 'string' && /^[a-f0-9]{64}$/.test(cacheVersion) ? cacheVersion : null;
  const device = version ? returnStorage === undefined ? createReturnStorage() : returnStorage : null;
  const normalized = (action: CycleAction, input: CycleInput): CycleInput => action === 'events'
    ? { birthUtc: input.birthUtc, body: input.body, fromAge: input.fromAge ?? 0, toAge: input.toAge ?? LIFE_SPAN_YEARS }
    : { birthUtc: input.birthUtc, body: input.body, eventUtc: input.eventUtc, timezone: input.timezone ?? 'UTC' };
  const identity = (action: CycleAction, input: CycleInput) => JSON.stringify([action, version, ...Object.values(normalized(action, input))]);
  const eventFields = ['id', 'body', 'utc', 'age', 'cycle', 'pass', 'cycleId', 'direction'] as const;
  const confirmsEvent = (event: CycleEvent | null | undefined, input: CycleInput): event is CycleEvent => validCycleEvent(event, input) && event!.utc === input.eventUtc;
  async function preserveReady(action: CycleAction, input: CycleInput, data: ClientCycleResult, owner: CycleOwner, signal: AbortSignal, alreadyStored = false): Promise<void> {
    if (signal.aborted || !DEFAULT_CYCLE_BODIES.includes(input.body)) return;
    const writes: Promise<unknown>[] = [];
    if (!alreadyStored && typeof data.proof === 'string' && data.proof.length > 0 && data.proof.length <= MAX_RETURN_PROOF_LENGTH) {
      const target = {...owner}, proof = data.proof;
      const key = JSON.stringify([action, target, input, proof]);
      writes.push(shareRequest(attachments,key,async ({controller}) => {
        const timer=setTimeout(()=>controller.abort(),timeoutMs);
        try {
          const reply = await request(`/api/charts/${encodeURIComponent(target.chartId)}/returns/accept`, {
            method:'POST',cache:'no-store',headers:{'Content-Type':'application/json',...(version?{'X-Forma-Cycles-Version':version}:{})},
            body:JSON.stringify({expectedAccountId:target.expectedAccountId,action,input,result:data,proof}),signal:controller.signal,
          });
          if (!reply || typeof reply !== 'object' || !('accepted' in reply) || reply.accepted !== true) throw new Error('Invalid return attachment');
        } finally {clearTimeout(timer);}
      },{signal}));
    }
    // Only already opened full charts are read here. Missing ones never enter the numerical queue.
    if (action === 'events') writes.push((async () => {
      for (const event of (data as CycleEventsResult).events) {
        if (signal.aborted) return;
        const exact={birthUtc:input.birthUtc,body:input.body,eventUtc:event.utc,timezone:input.timezone??'UTC'};
        const ready=await get('chart',exact,signal,{cacheOnly:true,preserve:false});
        if(ready)await preserveReady('chart',exact,ready,owner,signal);
      }
    })());
    await Promise.allSettled(writes);
  }
  async function get(action: CycleAction, input: CycleInput, signal?: AbortSignal, { event, owner, cacheOnly = false, preserve = true }: CycleOptions = {}): Promise<ClientCycleResult | null> {
    signal = signal ? AbortSignal.any([signal,lifetime.signal]) : lifetime.signal;
    if (signal.aborted) throw createAbortError();
    if (cacheOnly && !version) return null;
    // Copy before the optional device read so callers cannot mutate identity.
    const sourceTimezone = input.timezone ?? 'UTC';
    input = normalized(action, input);
    const key = identity(action, input);
    const memoryKey = `return-${action}:${key}`;
    const own = owner && DEFAULT_CYCLE_BODIES.includes(input.body)
      ? {chartId: owner.chartId, expectedAccountId: owner.expectedAccountId} : null;
    // Numerical reuse is common; a request that persists a result belongs to one card.
    const requestKey = own ? JSON.stringify([key, own.chartId, own.expectedAccountId, sourceTimezone]) : key;
    const persistent = device && DEFAULT_CYCLE_BODIES.includes(input.body);
    const confirmed = action === 'chart' && confirmsEvent(event, input)
      ? Object.fromEntries(eventFields.map(field => [field, event[field]])) as unknown as CycleEvent : null;
    const usable = (data: ClientCycleResult | null): data is ClientCycleResult => !!data && (!cacheOnly || action === 'events' || confirmsEvent(data.event, input));
    const accept = (data: ClientCycleResult, { save = false, remember = true } = {}) => {
      const enrich = confirmed && eventFields.some(field => confirmed[field] !== data.event?.[field]);
      const result = enrich ? { ...data, event: confirmed } : data;
      if (remember || enrich) memory.put(memoryKey, result);
      if (persistent && (save || enrich)) Promise.resolve().then(() => action === 'events'
        ? device!.putEvents(key, input, result as CycleEventsResult) : device!.putChart(key, result)).catch(() => {});
      if (own && preserve) void preserveReady(action,{...input,timezone:sourceTimezone},result,own,signal!,save).catch(()=>{});
      return result;
    };
    const reuse=(data:ClientCycleResult)=>{
      if(persistent)Promise.resolve().then(()=>action==='events'?device!.touchEvents?.(key):device!.touchChart?.(key)).catch(()=>{});
      return accept(data,{remember:false});
    };
    const remembered = memory.get<ClientCycleResult>(memoryKey);
    if (usable(remembered)) return reuse(remembered);
    // A different tab may have finished this key while our network request
    // still waits. Read ready device data before joining that pending request.
    if (persistent) {
      const read = action === 'events' ? 'getEvents' : 'getChart';
      const remove = action === 'events' ? 'removeEvents' : 'removeChart';
      const preceding = pending.get(requestKey);
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
      if (usable(latest)) return reuse(latest);
      // Keep the preceding request until this read settles even when its result
      // was too large to stay in the idle memory budget.
      if (!cacheOnly && preceding && pending.get(requestKey) !== preceding && !preceding.controller.signal.aborted) {
        const completed = await preceding.promise.catch(() => null);
        if (signal?.aborted) throw createAbortError();
        if (completed) return accept(completed);
      }
    }
    if (cacheOnly) return null;
    return shareRequest(pending, requestKey, async ({ controller }) => {
      if (controller.signal.aborted) throw createAbortError();
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        const url = own ? `/api/charts/${encodeURIComponent(own.chartId)}/returns/${action}` : `/api/cycles/${action}`;
        const data = await request(url, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json',
          ...(version ? { 'X-Forma-Cycles-Version': version } : {}) }, body: JSON.stringify(own ? {...input, timezone: sourceTimezone, expectedAccountId: own.expectedAccountId} : input), signal: controller.signal });
        if (controller.signal.aborted) throw createAbortError();
        if (!validCycleResult(action, data, input)) throw new Error('Сервер вернул неполные данные цикла.');
        return accept(data, { save: true });
      } catch (error) {
        if ((error as Error).name === 'AbortError' && timedOut) throw Object.assign(new Error('Расчёт не успел завершиться. Попробуйте ещё раз.'), {code:'server_unavailable'});
        throw error;
      } finally { clearTimeout(timeout); }
    }, { signal });
  }
  return { events: (input: CycleInput, signal?: AbortSignal, options?: Pick<CycleOptions, 'owner'>) => get('events', input, signal, options) as Promise<CycleEventsResult>,
    readEvents: (input: CycleInput, { signal }: { signal?: AbortSignal } = {}) => get('events', input, signal, { cacheOnly: true }) as Promise<CycleEventsResult | null>,
    chart: (input: CycleInput, signal?: AbortSignal, options?: Omit<CycleOptions, 'cacheOnly'>) => get('chart', input, signal, options) as Promise<CachedCycleChart>,
    // A confirmed cached chart carries its own current-revision event label.
    // This never joins numerical requests or asks for the body's dates.
    readChart: (input: CycleInput, { signal }: { signal?: AbortSignal } = {}) => get('chart', input, signal, { cacheOnly: true }) as Promise<CachedCycleChart | null>,
    retainChart: (input: CycleInput, data: CachedCycleChart) => memory.retain(`return-chart:${identity('chart', input)}`, data),
    retainEvents: (input: CycleInput, data: CycleEventsResult) => memory.retain(`return-events:${identity('events', input)}`, data),
    async syncPrepared(input: CycleInput, owner: CycleOwner, signal?: AbortSignal) {
      const active=signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal;
      const action=input.eventUtc===undefined?'events':'chart';
      const request={...normalized(action,input),timezone:input.timezone??'UTC'},destination={...owner};
      const data=await get(action,request,active,{cacheOnly:true,preserve:false});
      if(data)await preserveReady(action,request,data,destination,active);
    },
    close() {lifetime.abort();},
  };
}
