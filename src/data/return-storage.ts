import {MAX_RETURN_PROOF_LENGTH,type PreparedReturn} from '../../shared/chart-return-contract.ts';
import type { CycleInput, CycleEvent, CycleEventsResult } from '../../shared/cycles-format.ts';
export type ReturnStorage = ReturnType<typeof createReturnStorage>;

import { createCalculationCache, type CalculationCache } from './calculation-cache.ts';
import { cycleAge } from '../../shared/cycles-format.ts';
import { DEFAULT_CYCLE_BODIES } from '../domain/cycles.ts';

// This gate classifies current persistent returns; numerical checks belong to the caller.
function storedChart(key:string,value:unknown):unknown|null {
  try {
    const identity:unknown=JSON.parse(key),data=value as {event?:{body?:unknown}}|null;
    if(!Array.isArray(identity) || identity.length!==5 || identity[0]!=='chart' || !DEFAULT_CYCLE_BODIES.includes(identity[2])
      || !data || typeof data!=='object' || Array.isArray(data) || data.event?.body!==undefined && data.event.body!==identity[2])return null;
    return data;
  }catch{return null;}
}

const proofField=(value:unknown)=>typeof value==='string' && value.length>0 && value.length<=MAX_RETURN_PROOF_LENGTH ? {proof:value} : {};

// Only basic return dates and charts participate in the shared persistent LRU.
// Other return bodies remain in the caller's bounded memory cache.
export function createReturnStorage({ indexedDB: factory, timeoutMs = 500, cache }: {
  indexedDB?: IDBFactory | null; timeoutMs?: number; cache?: CalculationCache;
} = {}) {
  const owner=cache??createCalculationCache({indexedDB:factory,timeoutMs});
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
      return owner.put('return-events',key,record);
    },
    removeEvents(key: string) { return closed?Promise.resolve(null):owner.remove('return-events',key); },
    touchEvents(key:string) { return closed?Promise.resolve(null):owner.touch('return-events',key); },
    async getChart(key: string):Promise<unknown|null> {
      if(closed)return null;
      const data=await owner.get<unknown>('return-charts',key);
      return storedChart(key,data);
    },
    async chartKeys():Promise<string[]|null> {
      if(closed)return null;
      return (await owner.catalogue('return-charts'))?.map(row=>row.key)??null;
    },
    putChart(key: string, data: unknown) {
      if(closed)return Promise.resolve(null);
      const value=storedChart(key,data);
      return value?owner.put('return-charts',key,value):Promise.resolve(null);
    },
    removeChart(key: string) { return closed?Promise.resolve(null):owner.remove('return-charts',key); },
    touchChart(key:string) { return closed?Promise.resolve(null):owner.touch('return-charts',key); },
    close() { closed=true;if(!cache)owner.close(); },
  };
}
