import type {AccountChart} from '../../shared/chart-record-contract.ts';
import type {ChartRecord} from '../../shared/chart-types.ts';
import {natalDaySourceKey} from '../../shared/library-package-contract.ts';
import type {AccountLibraryStore} from './account-library-store.ts';
import type {LibraryLease} from './account-library-schema.ts';
export type NatalDayStorage = ReturnType<typeof createNatalDayStorage>;
import { createCalculationCache, type CalculationCache } from './calculation-cache.ts';
import { LEGACY_CALCULATION_SOURCES } from './calculation-migration.ts';

// Completed days have no expiry; the common calculation owner handles migration,
// byte accounting and LRU together with transit days and basic returns.
export function createNatalDayStorage({ legacyDatabaseName = 'bodygraph-chart-days', indexedDB: databaseFactory, timeoutMs = 500, cache }: {
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

export interface DayDisk {
 owned?:true;
 get(key:string,opened?:boolean):Promise<ArrayBuffer|null>;
 put(key:string,bytes:ArrayBuffer):Promise<unknown>;
 remove(key:string):Promise<unknown>;
 touch?:(key:string)=>Promise<unknown>;
}
type Library=Pick<AccountLibraryStore,'capture'|'readPackage'|'putPackage'>;
type Identity=Partial<Pick<ChartRecord,'id'|'birthDate'|'timezone'>> & {accountId?:string};
interface Destination {owner:LibraryLease;card:AccountChart;ref:{kind:'day';sourceKey:string}}
async function readOwnedDay(library:Library,destination:Destination,legacy:NatalDayStorage|null,key:string,opened?:boolean) {
 const {owner,card,ref}=destination,ready=await library.readPackage(owner,ref,{opened});
 if(ready instanceof ArrayBuffer)return ready;
 const bytes=await legacy?.get(key);if(!bytes)return null;
 const saved=await library.putPackage(owner,card,ref,bytes,{opened});
 if(saved==='stored' || saved==='no-op')await legacy?.remove(key);
 return saved==='invalid' || saved==='stale'?null:bytes;
}
/** Capture account authority before any asynchronous read, migration or download. */
export function captureNatalDayStorage(chart:Identity|null|undefined,library:Library|undefined,legacy:NatalDayStorage|null):DayDisk|null {
 if(!library || !chart?.accountId)return legacy;
 const owner=library.capture(chart.accountId);if(!owner)return null;
 const card={...chart} as AccountChart,ref={kind:'day' as const,sourceKey:natalDaySourceKey({date:card.birthDate,timezone:card.timezone||'UTC'})};
 return {owned:true,
  get:(key,opened)=>readOwnedDay(library,{owner,card,ref},legacy,key,opened),
  put:(_key,bytes)=>library.putPackage(owner,card,ref,bytes,{opened:true}),
  remove:()=>Promise.resolve(null),
 };
}
