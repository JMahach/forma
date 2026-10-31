import type { TransitDay } from '../../shared/day-packets/transit-format.ts';
import type { MemoryCache } from './memory-cache.ts';
import type { CalculationCache } from './calculation-cache.ts';
interface TransitCacheOptions { indexedDB?: IDBFactory | null; legacyDatabaseName?: string; memory?: MemoryCache; timeoutMs?: number; cache?: CalculationCache }
interface StoredTransitDay { key: string; day: Float64Array; meta: Pick<TransitDay, 'engine' | 'ephemeris' | 'timezoneDatabase' | 'nodeModel' | 'zodiac'> }
export type TransitDayCache = ReturnType<typeof createTransitDayCache>;

import { createCalculationCache } from './calculation-cache.ts';
import { LEGACY_CALCULATION_SOURCES } from './calculation-migration.ts';
import { createMemoryCache } from './memory-cache.ts';
import { TRANSIT_DAY_VERSION } from '../../shared/day-packets/transit-format.ts';
import { MOMENT_COLUMN_COUNT, validMomentValue } from '../../shared/day-packets/moment-columns.ts';
import { SUPPORTED_START, SUPPORTED_END_EXCLUSIVE } from '../../shared/date-limits.ts';

const DAY_MS = 86400000, SAMPLES = 1440;
const memoryKey = (key: string) => `transit-day:${key}`;
const metadataKeys = ['engine', 'ephemeris', 'timezoneDatabase', 'nodeModel', 'zodiac'] as const;
const dayIndex = (milliseconds: number) => Math.floor((milliseconds - SUPPORTED_START) / DAY_MS);

// The common owner admits only the confirmed current dates to persistent storage.
// Other usable days may remain in bounded RAM; coverage describes saved full days.
export function createTransitDayCache({ indexedDB, legacyDatabaseName = 'forma-moments',
  memory = createMemoryCache(), timeoutMs = 1000, cache }: TransitCacheOptions = {}) {
  const owner=cache??createCalculationCache({indexedDB,timeoutMs,
    legacySources:LEGACY_CALCULATION_SOURCES.map(source=>source.family==='transit'?{...source,legacyDatabaseName}:source)});
  const reads = new Map<string, { latest: TransitDay | null; promise: Promise<TransitDay | null> }>();
  const writes = new Map<string, { day: TransitDay; promise: Promise<boolean | null> }>();
  const coverage = new Uint8Array(Math.ceil((SUPPORTED_END_EXCLUSIVE - SUPPORTED_START) / DAY_MS));
  let observed = false, preparing: Promise<void> | null = null, prepared = false, closed = false, generation=0;
  function mark(date: string, present: boolean) {
    const index = dayIndex(Date.parse(date));
    if (index >= 0 && index < coverage.length) coverage[index] = present ? 1 : 0;
  }
  function prepare() {
    if(closed)return Promise.resolve();
    observed=true;
    if(preparing || prepared)return preparing??Promise.resolve();
    const work=(async()=>{
      while(!closed) {
        const snapshot=generation;
        const rows=await owner.catalogue('transit');
        if(closed)return;
        if(snapshot!==generation)continue;
        coverage.fill(0);
        if(rows)for(const row of rows)if(row.date)mark(row.date,true);
        prepared=rows!==null;return;
      }
    })().catch(()=>{prepared=false;}).finally(()=>{if(preparing===work)preparing=null;});
    preparing = work;
    return work;
  }
  const unsubscribe=owner.subscribe(change=>{
    if(change?.transitUnchanged)return;
    generation++;coverage.fill(0);prepared=false;
    if(observed && !closed)void prepare();
  });
  function validDay(day: TransitDay | null | undefined, date: string | undefined): day is TransitDay {
    return !!day && day.date === date
      && day.version === TRANSIT_DAY_VERSION && day.startUtc === `${date}T00:00:00Z`
      && day.samples === SAMPLES && day.stepSeconds === 60 && day.columns?.length === MOMENT_COLUMN_COUNT
      && day.columns.every((column, c) => column instanceof Float64Array && column.length === SAMPLES
        && column.every(value => validMomentValue(value, c)));
  }
  function fromPacket(packet: StoredTransitDay | null | undefined, date: string) {
    if (packet?.key !== date || !(packet.day instanceof Float64Array)
        || packet.day.length !== MOMENT_COLUMN_COUNT * SAMPLES) return null;
    const day = { ...packet.meta, date, version: TRANSIT_DAY_VERSION,
      startUtc: `${date}T00:00:00Z`, samples: SAMPLES, stepSeconds: 60,
      columns: Array.from({ length: MOMENT_COLUMN_COUNT }, (_, c) => packet.day.subarray(c * SAMPLES, (c + 1) * SAMPLES)) };
    return validDay(day, date) ? day : null;
  }
  function peekDay(date: string) {
    if(closed)return null;
    return memory.peek<TransitDay>(memoryKey(date));
  }
  /** RAM/IndexedDB only. Reading never downloads a day or rewrites its payload. */
  async function readLocalDay(date: string) {
    if(closed)return null;
    const hot = peekDay(date); if (hot) return hot;
    const key = date;
    if (writes.has(key)) return writes.get(key)!.day;
    if (!reads.has(key)) {
      const entry: { latest: TransitDay | null; promise: Promise<TransitDay | null> } = { latest: null, promise: null as unknown as Promise<TransitDay | null> };
      const snapshot=generation;
      entry.promise = owner.get<StoredTransitDay>('transit',key,{observeOnly:true}).then(packet=>fromPacket(packet,date)).catch(()=>null).then(day => {
        if(closed)return null;
        const current = peekDay(date) || entry.latest; if (current) return current;
        if(snapshot===generation)mark(date, Boolean(day));
        return day ? memory.put(memoryKey(key), day) : null;
      }).finally(() => reads.delete(key));
      reads.set(key, entry);
    }
    return reads.get(key)!.promise;
  }
  function putDay(day: TransitDay, { ifMissing = false } = {}) {
    if (closed || !validDay(day, day?.date)) return false;
    const { date } = day, key = date;
    memory.put(memoryKey(key), day);
    if (reads.has(key)) reads.get(key)!.latest = day;
    if (writes.get(key)?.day === day) return true;
    // A write is optional. Quota failure never removes the usable RAM result.
    const work = (async () => {
      if (ifMissing && await owner.has('transit', key)) return true;
      const numbers = new Float64Array(MOMENT_COLUMN_COUNT * SAMPLES);
      day.columns.forEach((column, c) => numbers.set(column, c * SAMPLES));
      return owner.put('transit',key,{key,day:numbers,
        meta:Object.fromEntries(metadataKeys.map(name=>[name,day[name]]))},{date});
    })().then(async saved=>{if(saved && observed)await prepare();return saved;}).catch(()=>null)
      .finally(() => { if (writes.get(key)?.promise === work) writes.delete(key); });
    writes.set(key, { day, promise: work });
    return true;
  }
  return {
    memory, prepare, putDay, peekDay, readLocalDay,
    markDayUsed(day:TransitDay){if(!closed)memory.get(memoryKey(day.date));},
    hasMinute(milliseconds: number) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds % 60000 || milliseconds < SUPPORTED_START || milliseconds >= SUPPORTED_END_EXCLUSIVE) return false;
      const date = new Date(milliseconds).toISOString().slice(0, 10);
      return Boolean(peekDay(date) || coverage[dayIndex(milliseconds)]);
    },
    retainDay(day: TransitDay) {
      if(closed)return ()=>{};
      return memory.retain(memoryKey(day.date),day);
    },
    async flush() { await Promise.all([...writes.values()].map(entry => entry.promise)); },
    async close() {
      closed=true;unsubscribe();coverage.fill(0);
      await Promise.all([...writes.values()].map(entry=>entry.promise));
      if(!cache)owner.close();
    },
  };
}
