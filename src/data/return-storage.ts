import {MAX_RETURN_PROOF_LENGTH,type PreparedReturn} from '../../shared/chart-return-contract.ts';
import type { CycleInput, CycleEvent, CycleEventsResult } from '../../shared/cycles-format.ts';
export type ReturnStorage = ReturnType<typeof createReturnStorage>;

import { createCalculationCache, type CalculationCache } from './calculation-cache.ts';
import { describeLegacyCalculation, LEGACY_CALCULATION_SOURCES } from './calculation-migration.ts';
import { cycleAge } from '../../shared/cycles-format.ts';
import { DEFAULT_CYCLE_BODIES } from '../domain/cycles.ts';

const proofField=(value:unknown)=>typeof value==='string' && value.length>0 && value.length<=MAX_RETURN_PROOF_LENGTH ? {proof:value} : {};

// Only basic return dates and charts participate in the shared persistent LRU.
// Other return bodies remain in the caller's bounded memory cache.
export function createReturnStorage({ indexedDB: factory, timeoutMs = 500, cache }: {
  indexedDB?: IDBFactory | null; timeoutMs?: number; cache?: CalculationCache;
} = {}) {
  const owner=cache??createCalculationCache({indexedDB:factory,timeoutMs});
  const source=LEGACY_CALCULATION_SOURCES.find(source=>source.family==='returns')!;
  let closed=false;
  return {
    async getEvents(key: string):Promise<PreparedReturn<CycleEventsResult>|null> {
      if(closed)return null;
      const record=await owner.get<{body:string;birthUtc:string;range:CycleEventsResult['range'];
        events:Pick<CycleEvent,'utc'|'cycle'|'pass'|'direction'>[];proof?:unknown}>('return-events',key);
      if(!record || !DEFAULT_CYCLE_BODIES.includes(record.body) || !Array.isArray(record.events))return null;
      try {
        return {range:record.range,...proofField(record.proof),events:record.events.map(({utc,cycle,pass,direction})=>({
          utc,cycle,pass,direction,body:record.body,id:`${record.body}:${utc}`,cycleId:`${record.body}:${cycle}`,
          age:cycleAge(utc,record.birthUtc),
        }))};
      } catch{return null;}
    },
    putEvents(key: string, input: CycleInput, data: PreparedReturn<CycleEventsResult>) {
      if(closed || !DEFAULT_CYCLE_BODIES.includes(input.body))return Promise.resolve(null);
      const record={key,birthUtc:input.birthUtc,body:input.body,range:data.range,...proofField(data.proof),
        events:data.events.map(({utc,cycle,pass,direction})=>({utc,cycle,pass,direction}))};
      const description=describeLegacyCalculation(source,'events',key,record)!;
      return owner.put('return-events',key,record,description);
    },
    removeEvents(key: string) { return closed?Promise.resolve(null):owner.remove('return-events',key); },
    touchEvents(key:string) { return closed?Promise.resolve(null):owner.touch('return-events',key); },
    async getChart(key: string):Promise<unknown|null> {
      if(closed)return null;
      const data=await owner.get<unknown>('return-charts',key);
      return describeLegacyCalculation(source,'charts',key,{key,data})?.value??null;
    },
    async chartKeys():Promise<string[]|null> {
      if(closed)return null;
      return (await owner.catalogue('return-charts'))?.map(row=>row.key)??null;
    },
    putChart(key: string, data: unknown) {
      if(closed)return Promise.resolve(null);
      const description=describeLegacyCalculation(source,'charts',key,{key,data});
      return description?owner.put('return-charts',key,data,description):Promise.resolve(null);
    },
    removeChart(key: string) { return closed?Promise.resolve(null):owner.remove('return-charts',key); },
    touchChart(key:string) { return closed?Promise.resolve(null):owner.touch('return-charts',key); },
    close() { closed=true;if(!cache)owner.close(); },
  };
}
