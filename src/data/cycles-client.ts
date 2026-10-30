import {createReturnFamilyClient,type CycleOwner} from './return-family-client.ts';
import type {AccountLibraryStore} from './account-library-store.ts';
import {isMainReturnBody} from '../../shared/chart-return-contract.ts';
export type {CycleOwner} from './return-family-client.ts';
import {MAX_RETURN_PROOF_LENGTH} from '../../shared/chart-return-contract.ts';
import type { CycleInput, CycleEvent, CycleEventsResult, CycleChartResult, CycleResult } from '../../shared/cycles-format.ts';
import type { ReturnStorage } from './return-storage.ts';
import type { MemoryCache } from './memory-cache.ts';
import type { SharedRequest } from '../runtime/shared-request.ts';
type CycleAction = 'events' | 'chart';
interface CycleOptions { event?: CycleEvent | null; owner?: CycleOwner | null; cacheOnly?: boolean; preserve?: boolean; opened?:boolean }
export type CachedCycleChart = CycleChartResult & { event?: CycleEvent; proof?: string };
type ClientCycleResult = CycleResult & { event?: CycleEvent; proof?: string };
interface CyclesClientOptions {
  request?: (url: string, options: RequestInit) => Promise<unknown>;
  memory?: MemoryCache;
  timeoutMs?: number;
  returnStorage?: ReturnStorage | null;
  library?:Pick<AccountLibraryStore,'capture'|'readPackage'|'putPackage'|'touchPackage'>;
}
export type CyclesClient = ReturnType<typeof createCyclesClient>;

import { requestJSON } from './api-client.ts';
import { validCycleResult, validCycleEvent, cycleUtcDifference } from '../../shared/cycles-format.ts';
import { createReturnStorage,normalizeReturnInput as normalized,returnStorageKey as identity } from './return-storage.ts';
import { DEFAULT_CYCLE_BODIES } from '../domain/cycles.ts';
import { createMemoryCache } from './memory-cache.ts';
import { createAbortError, shareRequest } from '../runtime/shared-request.ts';

// Only default body dates and opened charts persist on the device. Other bodies
// stay in shared tab memory; controllers pin active inputs within its byte budget.
export function createCyclesClient({ request = requestJSON, memory = createMemoryCache(), timeoutMs = 60_000,
  returnStorage,library }: CyclesClientOptions = {}) {
  const lifetime = new AbortController(), attachments = new Map<string, SharedRequest<unknown>>();
  const preservations = new Map<string, SharedRequest<void>>();
  const reads = new Map<string, SharedRequest<unknown>>(), pending = new Map<string, SharedRequest<ClientCycleResult>>();
  const device = returnStorage === undefined ? createReturnStorage() : returnStorage;
  const families=createReturnFamilyClient({library,memory,request,timeoutMs,legacy:device});
  const eventFields = ['id', 'body', 'utc', 'age', 'cycle', 'pass', 'cycleId', 'direction'] as const;
  const confirmsEvent = (event: CycleEvent | null | undefined, input: CycleInput): event is CycleEvent => validCycleEvent(event, input) && event!.utc === input.eventUtc;
  async function preserveReadyWork(action: CycleAction, input: CycleInput, data: ClientCycleResult, owner: CycleOwner, signal: AbortSignal, alreadyStored = false): Promise<void> {
    if (signal.aborted || !DEFAULT_CYCLE_BODIES.includes(input.body)) return;
    const writes: Promise<unknown>[] = [];
    if (!alreadyStored && typeof data.proof === 'string' && data.proof.length > 0 && data.proof.length <= MAX_RETURN_PROOF_LENGTH) {
      const target = {chartId:owner.chartId,expectedAccountId:owner.expectedAccountId}, proof = data.proof;
      const key = JSON.stringify([action, target, input, proof]);
      writes.push(shareRequest(attachments,key,async ({controller}) => {
        const timer=setTimeout(()=>controller.abort(),timeoutMs);
        try {
          const reply = await request(`/api/charts/${encodeURIComponent(target.chartId)}/returns/accept`, {
            method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({expectedAccountId:target.expectedAccountId,action,input,result:data,proof}),signal:controller.signal,
          });
          if (!reply || typeof reply !== 'object' || !('accepted' in reply) || reply.accepted !== true) throw new Error('Invalid return attachment');
        } finally {clearTimeout(timer);}
      },{signal}));
    }
    // Only already opened full charts are read here. Missing ones never enter the numerical queue.
    if (action === 'events') writes.push((async () => {
      const events = (data as CycleEventsResult).events;
      const candidates = await preparedChartInputs(input, {signal});
      for (const exact of candidates) {
        if (signal.aborted) return;
        // Lists are validated in ascending UTC order. Find only the few stored
        // destinations instead of reading every possible astronomical event.
        let low = 0, high = events.length;
        while (low < high) { const mid = (low + high) >>> 1;
          if (cycleUtcDifference(events[mid].utc, exact.eventUtc) < 0) low = mid + 1; else high = mid;
        }
        if (events[low]?.utc !== exact.eventUtc) continue;
        const ready=await get('chart',exact,signal,{cacheOnly:true,preserve:false});
        if(ready)await preserveReady('chart',exact,ready,owner,signal);
      }
    })());
    await Promise.allSettled(writes);
  }
  function preserveReady(action: CycleAction, input: CycleInput, data: ClientCycleResult, owner: CycleOwner, signal: AbortSignal, alreadyStored = false): Promise<void> {
    const key=JSON.stringify([action,owner.chartId,owner.expectedAccountId,input,data.proof,alreadyStored]);
    return shareRequest(preservations,key,({controller})=>preserveReadyWork(action,input,data,owner,controller.signal,alreadyStored),{signal});
  }
  async function preparedChartInputs(input: {birthUtc:string;body?:string;timezone?:string}, {signal}:{signal?:AbortSignal}={}):Promise<CycleInput[]> {
    if(lifetime.signal.aborted || signal?.aborted)throw createAbortError();
    const prefix='return-chart:',keys=new Set(memory.keys(prefix).map(key=>key.slice(prefix.length)));
    const stored=await device?.chartKeys?.();
    if(lifetime.signal.aborted || signal?.aborted)throw createAbortError();
    for(const key of stored??[])keys.add(key);
    // A chart can arrive while the catalogue transaction is pending.
    for(const key of memory.keys(prefix))keys.add(key.slice(prefix.length));
    const found:CycleInput[]=[];
    for(const key of keys)try {
      const parts:unknown=JSON.parse(key);
      if(!Array.isArray(parts) || parts.length!==5 || parts[0]!=='chart'
        || parts[1]!==input.birthUtc || input.body && parts[2]!==input.body || typeof parts[2]!=='string'
        || typeof parts[3]!=='string' || !Number.isFinite(Date.parse(parts[3])) || parts[4] !== (input.timezone??'UTC'))continue;
      found.push({birthUtc:input.birthUtc,body:parts[2],eventUtc:parts[3],timezone:parts[4]});
    } catch { /* A malformed catalogue identity is not a candidate. */ }
    return found;
  }
  async function get(action: CycleAction, input: CycleInput, signal?: AbortSignal, { event, owner, cacheOnly = false, preserve = true,opened = !cacheOnly && action==='chart' }: CycleOptions = {}): Promise<ClientCycleResult | null> {
    signal = signal ? AbortSignal.any([signal,lifetime.signal]) : lifetime.signal;
    if (signal.aborted) throw createAbortError();
    // Copy before the optional device read so callers cannot mutate identity.
    const sourceTimezone = input.timezone ?? 'UTC';
    input = normalized(action, input);
    const key = identity(action, input);
    const memoryKey = `return-${action}:${key}`;
    const own = owner && (action==='events' || DEFAULT_CYCLE_BODIES.includes(input.body))
      ? {chartId: owner.chartId, expectedAccountId: owner.expectedAccountId,record:owner.record} : null;
    // Numerical reuse is common; a request that persists a result belongs to one card.
    const requestKey = own ? JSON.stringify([key, own.chartId, own.expectedAccountId, sourceTimezone]) : key;
    const persistent = device && DEFAULT_CYCLE_BODIES.includes(input.body);
    const saveIndividual=persistent && !(library && owner);
    const confirmed = action === 'chart' && confirmsEvent(event, input)
      ? Object.fromEntries(eventFields.map(field => [field, event[field]])) as unknown as CycleEvent : null;
    const usable = (data: ClientCycleResult | null): data is ClientCycleResult => !!data && (!cacheOnly || action === 'events' || confirmsEvent(data.event, input));
    const accept = (data: ClientCycleResult, { save = false, remember = true } = {}) => {
      const enrich = confirmed && eventFields.some(field => confirmed[field] !== data.event?.[field]);
      const result = enrich ? { ...data, event: confirmed } : data;
      if (remember || enrich) memory.put(memoryKey, result);
      if (saveIndividual && (save || enrich)) Promise.resolve().then(() => action === 'events'
        ? device!.putEvents(key, input, result as CycleEventsResult) : device!.putChart(key, result)).catch(() => {});
      if (own && preserve) void preserveReady(action,{...input,timezone:sourceTimezone},result,own,signal!,save).catch(()=>{});
      return result;
    };
    const reuse=(data:ClientCycleResult)=>{
      if(persistent)Promise.resolve().then(()=>action==='events'?device!.touchEvents?.(key):device!.touchChart?.(key)).catch(()=>{});
      return accept(data,{remember:false});
    };
    const remembered = memory.get<ClientCycleResult>(memoryKey);
    if(cacheOnly && library && owner && !isMainReturnBody(input.body))return null;
    if (usable(remembered) && !(cacheOnly && library && owner)) return reuse(remembered);
    if(library && own && isMainReturnBody(input.body)) {
      const packet=await families.read({...input,timezone:sourceTimezone},own,{signal,durable:cacheOnly,opened});
      if(packet) {
        if(action==='events' && validCycleResult('events',packet.dates,input))return packet.dates;
        const index=packet.dates.events.findIndex(event=>event.utc===input.eventUtc);
        if(index>=0)return {...packet.charts[index],event:packet.dates.events[index]};
      }
      if(cacheOnly)return null;
    }
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
        const data = await request(url, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(own ? {...input, timezone: sourceTimezone, expectedAccountId: own.expectedAccountId} : input), signal: controller.signal });
        if (controller.signal.aborted) throw createAbortError();
        if (!validCycleResult(action, data, input)) throw new Error('Сервер вернул неполные данные цикла.');
        return accept(data, { save: true });
      } catch (error) {
        if ((error as Error).name === 'AbortError' && timedOut) throw Object.assign(new Error('Расчёт не успел завершиться. Попробуйте ещё раз.'), {code:'server_unavailable'});
        throw error;
      } finally { clearTimeout(timeout); }
    }, { signal });
  }
  return {
    receiveFamily:(input:CycleInput,owner:CycleOwner,{signal}:{signal?:AbortSignal}={})=>
      families.receive(input,owner,{signal:signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal}),
    readFamily:(input:CycleInput,owner:CycleOwner,{signal,opened=false}:{signal?:AbortSignal;opened?:boolean}={})=>
      families.read(input,owner,{signal:signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal,opened,durable:true}),
    fetchFamily:(input:CycleInput,owner:CycleOwner,{signal}:{signal?:AbortSignal}={})=>
      families.fetch(input,owner,{signal:signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal}),
    preparedChartInputs, events: (input: CycleInput, signal?: AbortSignal, options?: Pick<CycleOptions, 'owner'>) => get('events', input, signal, options) as Promise<CycleEventsResult>,
    readEvents: (input: CycleInput, { signal,owner }: { signal?: AbortSignal;owner?:CycleOwner|null } = {}) => get('events', input, signal, { cacheOnly: true,owner }) as Promise<CycleEventsResult | null>,
    chart: (input: CycleInput, signal?: AbortSignal, options?: Omit<CycleOptions, 'cacheOnly'>) => get('chart', input, signal, options) as Promise<CachedCycleChart>,
    // A confirmed cached chart carries its own exact event label.
    // This never joins numerical requests or asks for the body's dates.
    readChart: (input: CycleInput, { signal,owner,opened=false }: { signal?: AbortSignal;owner?:CycleOwner|null;opened?:boolean } = {}) => get('chart', input, signal, { cacheOnly: true,owner,opened }) as Promise<CachedCycleChart | null>,
    retainChart: (input: CycleInput, data: CachedCycleChart) => memory.retain(`return-chart:${identity('chart', input)}`, data),
    retainEvents: (input: CycleInput, data: CycleEventsResult) => memory.retain(`return-events:${identity('events', input)}`, data),
    async syncPrepared(input: CycleInput, owner: CycleOwner, signal?: AbortSignal) {
      const active=signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal;
      const action=input.eventUtc===undefined?'events':'chart';
      const request={...normalized(action,input),timezone:input.timezone??'UTC'},destination={...owner};
      const data=await get(action,request,active,{cacheOnly:true,preserve:false});
      if(data)await preserveReady(action,request,data,destination,active);
    },
    close() {lifetime.abort();if(returnStorage===undefined)device?.close();},
  };
}
