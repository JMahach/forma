export type BinaryCache = ReturnType<typeof createBinaryCache>;
import { createCalculationCache, type CalculationCache } from './calculation-cache.ts';
import { describeLegacyCalculation, LEGACY_CALCULATION_SOURCES } from './calculation-migration.ts';

// Completed days have no expiry; the common calculation owner handles migration,
// byte accounting and LRU together with transit days and basic returns.
export function createBinaryCache({ databaseName = 'bodygraph-chart-days', indexedDB: databaseFactory, timeoutMs = 500, cache }: {
  databaseName?: string; indexedDB?: IDBFactory | null; timeoutMs?: number; cache?: CalculationCache;
} = {}) {
  const sources=LEGACY_CALCULATION_SOURCES.map(source=>source.family==='natal'?{...source,databaseName}:source);
  const source=sources.find(source=>source.family==='natal')!;
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
      const description=describeLegacyCalculation(source,'packets',key,{key,bytes})!;
      return owner.put('natal',key,bytes,description);
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
