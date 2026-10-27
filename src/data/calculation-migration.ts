import { createIndexedDatabase } from './indexed-db.ts';
import { DEFAULT_CYCLE_BODIES } from '../domain/cycles.ts';

export type CalculationKind='natal'|'transit'|'return-events'|'return-charts';
export interface LegacyCalculationSource {id:string;databaseName:string;version:number;stores:string[];family:'natal'|'returns'|'transit'}
export interface LegacyCalculationEntry {key:IDBValidKey;value:unknown}
export type LegacyCalculationRead={status:'ok';entry:LegacyCalculationEntry|null}|{status:'unavailable'};
export interface LegacyCalculationDescription {kind:CalculationKind;key:string;value:unknown;version?:string;date?:string}
interface LegacySourceOptions {indexedDB?:IDBFactory|null;timeoutMs?:number}

export const LEGACY_CALCULATION_SOURCES:LegacyCalculationSource[]=[
  {id:'natal',databaseName:'bodygraph-chart-days',version:3,stores:['packets','metadata'],family:'natal'},
  {id:'returns',databaseName:'bodygraph-return-events',version:3,stores:['events','charts'],family:'returns'},
  {id:'transit',databaseName:'forma-moments',version:2,stores:['packets','catalogue','settings'],family:'transit'},
];

/** Read/delete ports for the migration owner. An empty source is known only after a successful transaction. */
export function createLegacyCalculationSource(source:LegacyCalculationSource,options:LegacySourceOptions={}) {
  const stores=[...source.stores];
  const database=createIndexedDatabase({databaseName:source.databaseName,version:source.version,
    stores,indexedDB:options.indexedDB,timeoutMs:options.timeoutMs,
    upgrade(db) {
      for(const store of stores)if(!db.objectStoreNames.contains(store)) {
        if(store==='settings')db.createObjectStore(store);
        else db.createObjectStore(store,{keyPath:'key'});
      }
    },
  });
  const unavailable:LegacyCalculationRead={status:'unavailable'};
  return {
    async next(store:string,after?:IDBValidKey):Promise<LegacyCalculationRead> {
      if(!stores.includes(store))return unavailable;
      return await database.transaction<LegacyCalculationRead>('readonly',(tx,result)=>{
        const objectStore=tx.objectStore(store),request=objectStore.openKeyCursor();
        request.onsuccess=()=>{
          const cursor=request.result;
          if(!cursor){result({status:'ok',entry:null});return;}
          try {
            if(after!==undefined) {
              const factory=options.indexedDB===undefined?globalThis.indexedDB:options.indexedDB;
              const order=factory!.cmp(cursor.key,after);
              if(order<0){cursor.continue(after);return;}
              if(order===0){cursor.continue();return;}
            }
            // Seek through keys only; exactly one selected payload is cloned for the caller.
            const key=cursor.primaryKey,value=objectStore.get(key);
            value.onsuccess=()=>result({status:'ok',entry:{key,value:value.result}});
          } catch {tx.abort();}
        };
      })??unavailable;
    },
    async get(store:string,key:IDBValidKey):Promise<LegacyCalculationRead> {
      if(!stores.includes(store))return unavailable;
      return await database.transaction<LegacyCalculationRead>('readonly',(tx,result)=>{
        const objectStore=tx.objectStore(store),request=objectStore.getKey(key);
        request.onsuccess=()=>{
          const found=request.result;
          if(found===undefined){result({status:'ok',entry:null});return;}
          const value=objectStore.get(found);
          value.onsuccess=()=>result({status:'ok',entry:{key:found,value:value.result}});
        };
      })??unavailable;
    },
    async remove(store:string,key:IDBValidKey):Promise<boolean> {
      if(!stores.includes(store))return false;
      return await database.transaction<boolean>('readwrite',(tx,result)=>{
        tx.objectStore(store).delete(key);result(true);
      })===true;
    },
    close:database.close,
  };
}

const record=(value:unknown):Record<string,unknown>|null=>value!==null && typeof value==='object' && !Array.isArray(value)
  ?value as Record<string,unknown>:null;
const revision=(value:unknown):value is string=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const basicBody=(value:unknown):value is string=>typeof value==='string' && DEFAULT_CYCLE_BODIES.includes(value);
function returnIdentity(key:string,action:'events'|'chart') {
  let value:unknown;
  try{value=JSON.parse(key);}catch{return null;}
  if(!Array.isArray(value) || value[0]!==action)return null;
  return {body:value[3] as unknown,...(revision(value[1])?{version:value[1]}:{})};
}

/** Classifies legacy payloads for storage policy; numerical validity remains with each calculation's checker. */
export function describeLegacyCalculation(source:LegacyCalculationSource,store:string,key:IDBValidKey,value:unknown):LegacyCalculationDescription|null {
  const row=record(value);
  if(typeof key!=='string' || !row)return null;
  if(source.family==='natal' && store==='packets' && row.bytes instanceof ArrayBuffer) {
    const identity=/^natal-day:([a-f0-9]{64}):[^:]+:(\d{4}-\d{2}-\d{2}):/.exec(key);
    return {kind:'natal',key,value:row.bytes,...(identity?{version:identity[1],date:identity[2]}:{})};
  }
  if(source.family==='transit' && store==='packets' && row.day instanceof Float64Array && row.day.length===24*1440) {
    const identity=/^([a-f0-9]{64}):(\d{4}-\d{2}-\d{2})$/.exec(key);
    return identity?{kind:'transit',key,value,version:identity[1],date:identity[2]}:null;
  }
  if(source.family!=='returns')return null;
  if(store==='events' && basicBody(row.body)) {
    const identity=returnIdentity(key,'events');
    return {kind:'return-events',key,value,...(identity?.version?{version:identity.version}:{})};
  }
  if(store==='charts') {
    const data=record(row.data),identity=returnIdentity(key,'chart'),storedBody=record(data?.event)?.body;
    const body=identity?.body??storedBody;
    if(!data || !basicBody(body) || storedBody!==undefined && storedBody!==body)return null;
    return {kind:'return-charts',key,value:row.data,...(identity?.version?{version:identity.version}:{})};
  }
  return null;
}
