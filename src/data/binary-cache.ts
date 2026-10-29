export type BinaryCache = ReturnType<typeof createBinaryCache>;
import { createCalculationCache, type CalculationCache } from './calculation-cache.ts';
import { LEGACY_CALCULATION_SOURCES } from './calculation-migration.ts';

// Completed days have no expiry; the common calculation owner handles migration,
// byte accounting and LRU together with transit days and basic returns.
export function createBinaryCache({ legacyDatabaseName = 'bodygraph-chart-days', indexedDB: databaseFactory, timeoutMs = 500, cache }: {
  legacyDatabaseName?: string; indexedDB?: IDBFactory | null; timeoutMs?: number; cache?: CalculationCache;
} = {}) {
  const sources=LEGACY_CALCULATION_SOURCES.map(source=>source.family==='natal'?{...source,legacyDatabaseName}:source);
  const owner=cache??createCalculationCache({indexedDB:databaseFactory,timeoutMs,legacySources:sources});
  let closed=false;
  return {
    async get(key: string):Promise<ArrayBuffer|null> {
      if(closed)return null;
      const bytes=await owner.get<unknown>('natal',key);
      return bytes instanceof ArrayBuffer?bytes:null;
    },
    put(key: string, bytes: ArrayBuffer) {
      if(closed || !(bytes instanceof ArrayBuffer))return Promise.resolve(null);
      return owner.put('natal',key,bytes);
    },
    remove(key: string) {
      return closed?Promise.resolve(null):owner.remove('natal',key);
    },
    touch(key:string) {
      return closed?Promise.resolve(null):owner.touch('natal',key);
    },
    close() {
      closed=true;if(!cache)owner.close();
    },
  };
}
