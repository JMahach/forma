import {MAX_RETURN_PROOF_LENGTH,type PreparedReturn} from '../../shared/chart-return-contract.ts';
import {LIFE_SPAN_YEARS} from '../../shared/date-limits.ts';
import type { CycleInput, CycleEvent, CycleEventsResult } from '../../shared/cycles-format.ts';
export type ReturnStorage = ReturnType<typeof createReturnStorage>;

import { createCalculationCache, type CalculationCache } from './calculation-cache.ts';
import { cycleAge } from '../../shared/cycles-format.ts';
import { DEFAULT_CYCLE_BODIES } from '../domain/cycles.ts';

export function normalizeReturnInput(action:'events'|'chart',input:CycleInput):CycleInput {
  return action==='events'?{birthUtc:input.birthUtc,body:input.body,fromAge:input.fromAge??0,toAge:input.toAge??LIFE_SPAN_YEARS}
    :{birthUtc:input.birthUtc,body:input.body,eventUtc:input.eventUtc,timezone:input.timezone??'UTC'};
}
export const returnStorageKey=(action:'events'|'chart',input:CycleInput)=>JSON.stringify([action,...Object.values(normalizeReturnInput(action,input))]);

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

// Read legacy basic dates for migration, but never create new standalone lists.
// Newly opened basic charts still participate in the common persistent LRU.
export function createReturnStorage({ indexedDB: factory, timeoutMs = 500, cache }: {
  indexedDB?: IDBFactory | null; timeoutMs?: number; cache?: CalculationCache;
} = {}) {
  const owner=cache??createCalculationCache({indexedDB:factory,timeoutMs});
  let closed=false;
  return {
    async getEvents(key: string,{observeOnly=false}:{observeOnly?:boolean}={}):Promise<PreparedReturn<CycleEventsResult>|null> {
      if(closed)return null;
      const record=await owner.get<{body:string;birthUtc:string;range:CycleEventsResult['range'];
        events:Pick<CycleEvent,'utc'|'cycle'|'pass'|'direction'>[];proof?:unknown}>('return-events',key,{observeOnly});
      if(!record || !DEFAULT_CYCLE_BODIES.includes(record.body) || !Array.isArray(record.events))return null;
      try {
        return {range:record.range,...proofField(record.proof),events:record.events.map(({utc,cycle,pass,direction})=>({
          utc,cycle,pass,direction,body:record.body,id:`${record.body}:${utc}`,cycleId:`${record.body}:${cycle}`,
          age:cycleAge(utc,record.birthUtc),
        }))};
      } catch{return null;}
    },
    removeEvents(key: string) { return closed?Promise.resolve(null):owner.remove('return-events',key); },
    async getChart(key: string,{observeOnly=false}:{observeOnly?:boolean}={}):Promise<unknown|null> {
      if(closed)return null;
      const data=await owner.get<unknown>('return-charts',key,{observeOnly});
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
