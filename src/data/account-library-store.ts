import type { StoragePressure, StorageRelief } from './storage-pressure.ts';
import type { AccountChart } from '../../shared/chart-record-contract.ts';
import { createRandomId } from '../domain/chart-record.ts';
import { validateAccountChart } from '../domain/account-chart.ts';
import { createIndexedDatabase } from './indexed-db.ts';
import { upgradeAccountLibrary } from './account-library-schema.ts';

export interface LibraryLease { accountId: string; generation: string }
export interface LibrarySnapshot { lease: LibraryLease | null; charts: AccountChart[] }
export type LibraryStoreResult = {status: 'stored'; lease: LibraryLease; pressure?:true; changed?:boolean} | {status:'partial';lease:LibraryLease;changed?:boolean} | {status: 'stale' | 'unavailable'};
interface Options { indexedDB?: IDBFactory | null; databaseName?: string;now?:()=>number;pressure?:StoragePressure }
const ownerId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function lease(value: unknown): LibraryLease | null {
  if (!object(value) || !ownerId(value.accountId) || typeof value.generation !== 'string' || !value.generation) return null;
  return {accountId: value.accountId, generation: value.generation};
}
const same = (current: unknown, seen: LibraryLease) => {
  const value = lease(current); return !!value && value.accountId === seen.accountId && value.generation === seen.generation;
};
const unavailable = (): LibraryStoreResult => ({status: 'unavailable'});

function leastUsedCard(keys:IDBValidKey[],usage:{id:string;openedAt:number}[],exclude:readonly string[]) {
  const opened=new Map(usage.filter(row=>Number.isFinite(row.openedAt) && row.openedAt>0).map(row=>[row.id,row.openedAt]));
  const protectedIds=new Set(exclude);
  let selected:IDBValidKey|null=null,earliest=Infinity;
  // IndexedDB keys provide a stable tie-break for cards never opened.
  for(const key of keys) {
    if(protectedIds.has(String(key)))continue;
    const at=opened.get(String(key))??0;
    if(at<earliest){selected=key;earliest=at;}
  }
  return selected;
}

/** Account library only: no calculation-cache quota, legacy migration, command queue or tombstones. */
export function createAccountLibraryStore({indexedDB, databaseName = 'forma-account-library',now=Date.now,pressure}: Options = {}) {
  const database = createIndexedDatabase({databaseName, version: 5, stores: ['charts', 'context', 'usage'], indexedDB,
    upgrade:upgradeAccountLibrary});
  let admitted:LibraryLease|null|undefined;
  return {
    async read(): Promise<LibrarySnapshot | null> {
      const snapshot=await database.transaction<LibrarySnapshot>('readonly', (tx, result) => {
        const context = tx.objectStore('context').get('owner');
        context.onsuccess = () => {
          if (!context.result || context.result.accountId === null) { result({lease: null, charts: []}); return; }
          const current = lease(context.result); if (!current) return;
          const rows = tx.objectStore('charts').getAll();
          rows.onsuccess = () => {
            const charts: AccountChart[] = [];
            for (const raw of rows.result) {
              try { charts.push(validateAccountChart(raw, current.accountId)); }
              catch { /* Do not publish or delete an invalid stored row. A server refresh may replace it. */ }
            }
            result({lease: current, charts});
          };
        };
      });
      if(snapshot && (admitted===undefined || admitted?.accountId===snapshot.lease?.accountId))admitted=snapshot.lease;
      return snapshot;
    },
    async activate(accountId: string): Promise<LibraryStoreResult> {
      if (!ownerId(accountId)) throw new TypeError('invalid_account');
      const saved=await database.transaction<LibraryStoreResult>('readwrite', (tx, result) => {
        const contexts = tx.objectStore('context'), request = contexts.get('owner');
        request.onsuccess = () => {
          const current = lease(request.result);
          if (current?.accountId === accountId) { result({status: 'stored', lease: current}); return; }
          if (request.result && request.result.accountId !== null && !current) return;
          const next = {accountId, generation: createRandomId()};
          tx.objectStore('charts').clear();
          tx.objectStore('usage').clear();
          contexts.put({key: 'owner', ...next});
          result({status: 'stored', lease: next});
        };
      }) ?? unavailable();
      if(saved.status==='stored')admitted=saved.lease;return saved;
    },
    async put(seen:LibraryLease,values:readonly AccountChart[]):Promise<LibraryStoreResult> {
      // A late quota must not acquire cleanup permission from a new account.
      const isCurrent=pressure?.capture();
      const charts=values.map(value=>validateAccountChart(value,seen.accountId));
      const write=(batch:readonly AccountChart[])=>database.transactionResult<LibraryStoreResult>('readwrite',(tx,result,fail)=>{
        const request=tx.objectStore('context').get('owner');request.onsuccess=()=>{
          if(!same(request.result,seen)){result({status:'stale'});return;}
          const rows=tx.objectStore('charts');
          const outcome:LibraryStoreResult & {status:'stored'}={status:'stored',lease:{...seen},changed:false};
          for(const chart of batch){const prior=rows.get(chart.id);prior.onsuccess=()=>{
            try{
              let current:AccountChart|null=null;try{current=validateAccountChart(prior.result,seen.accountId);}catch{}
              if(!current || current.revision<chart.revision){
                // Acquisition never creates or changes a real-use mark.
                rows.put(chart);
                outcome.changed=true;
              }
            }catch(error){fail(error);}
          };}
          result(outcome);
        };
      });
      const first=await write(charts);
      if(first.status!=='quota')return first.status==='complete'?first.value??unavailable():unavailable();
      if(isCurrent && !isCurrent())return {status:'stale'};
      // One hundred cards need not fit atomically to preserve one usable card.
      // Keep the leading saved subset; never cycle through the whole library
      // evicting cards that this same background page just downloaded.
      let stored=0,changed=false;
      for(const chart of charts){
        let result=await write([chart]),recovered=false;
        if(result.status==='quota'){
          if(isCurrent && !isCurrent())return {status:'stale'};
          if(stored)return {status:'partial',lease:{...seen},changed};
          if(pressure){result=await pressure.write(()=>write([chart]),{chartIds:[chart.id]});recovered=true;}
        }
        if(result.status!=='complete'||!result.value)return stored?{status:'partial',lease:{...seen},changed}:unavailable();
        if(result.value.status!=='stored')return result.value;
        changed ||= result.value.changed!==false;
        stored++;
        if(recovered)return stored===charts.length?{...result.value,changed,pressure:true}:{status:'partial',lease:{...seen},changed};
      }
      return {status:'stored',lease:{...seen},changed,pressure:true};
    },
    // A working RAM record and an open database do not prove a reload can restore it.
    async canRestore(seen:LibraryLease,expected:AccountChart):Promise<boolean> {
      return await database.transaction<boolean>('readonly',(tx,result)=>{
        const owner=tx.objectStore('context').get('owner');owner.onsuccess=()=>{
          if(!same(owner.result,seen) || expected.accountId!==seen.accountId){result(false);return;}
          const record=tx.objectStore('charts').get(expected.id);record.onsuccess=()=>{
            try {
              const saved=validateAccountChart(record.result,seen.accountId);
              result(saved.revision>=expected.revision && saved.noteRevision>=expected.noteRevision);
            } catch {result(false);}
          };
        };
      })===true;
    },
    async touch(seen:LibraryLease,chartId:string):Promise<boolean> {
      return await database.transaction<boolean>('readwrite',(tx,result,fail)=>{
        const owner=tx.objectStore('context').get('owner');owner.onsuccess=()=>{
          if(!same(owner.result,seen)){result(false);return;}
          const read=tx.objectStore('charts').getKey(chartId);read.onsuccess=()=>{
            if(!read.result){result(false);return;}
            try{tx.objectStore('usage').put({id:chartId,openedAt:now()});result(true);}catch(error){fail(error);}
          };
        };
      })===true;
    },
    async evictForSpace(keep:number,exclude:readonly string[]=[],isCurrent:()=>boolean=()=>true):Promise<StorageRelief> {
      if(!Number.isSafeInteger(keep)||keep<0)throw new RangeError('Invalid library minimum');
      return await database.transaction<StorageRelief>('readwrite',(tx,result)=>{
        const owner=tx.objectStore('context').get('owner');owner.onsuccess=()=>{
          if(!isCurrent() || admitted===undefined || (admitted? !same(owner.result,admitted):lease(owner.result)!==null)){result('unavailable');return;}
          const rows=tx.objectStore('charts'),keys=rows.getAllKeys(),usage=tx.objectStore('usage').getAll();
          usage.onsuccess=()=>{
            if(keys.result.length<=keep){result('empty');return;}
            const victim=leastUsedCard(keys.result,usage.result,exclude);
            if(victim===null){result('empty');return;}
            if(!isCurrent()){result('unavailable');return;}
            rows.delete(victim);result('released');
          };
        };
      })??'unavailable';
    },
    async remove(seen: LibraryLease, chartId: string): Promise<LibraryStoreResult> {
      const saved=await database.transaction<LibraryStoreResult>('readwrite', (tx, result) => {
        const contexts = tx.objectStore('context'), request = contexts.get('owner');
        request.onsuccess = () => {
          if (!same(request.result, seen)) { result({status: 'stale'}); return; }
          const next = {...seen, generation: createRandomId()};
          tx.objectStore('charts').delete(chartId);
          tx.objectStore('usage').delete(chartId);
          contexts.put({key: 'owner', ...next});
          result({status: 'stored', lease: next});
        };
      }) ?? unavailable();
      if(saved.status==='stored' && admitted && same(admitted,seen))admitted=saved.lease;
      return saved;
    },
    async clear(seen: LibraryLease): Promise<'cleared' | 'stale' | 'unavailable'> {
      const cleared=await database.transaction<'cleared' | 'stale'>('readwrite', (tx, result) => {
        const contexts = tx.objectStore('context'), request = contexts.get('owner');
        request.onsuccess = () => {
          if (!same(request.result, seen)) { result('stale'); return; }
          tx.objectStore('charts').clear();
          tx.objectStore('usage').clear();
          contexts.put({key: 'owner', accountId: null, generation: createRandomId()});
          result('cleared');
        };
      }) ?? 'unavailable';
      if(cleared==='cleared' && admitted && same(admitted,seen))admitted=null;
      return cleared;
    },
    // Explicit logout targets the account, including an activation still in
    // flight or a generation advanced by a deletion in another tab.
    async clearAccount(accountId: string): Promise<'cleared' | 'stale' | 'unavailable'> {
      if (!ownerId(accountId)) throw new TypeError('invalid_account');
      const cleared=await database.transaction<'cleared' | 'stale'>('readwrite', (tx, result) => {
        const contexts = tx.objectStore('context'), request = contexts.get('owner');
        request.onsuccess = () => {
          if (request.result?.accountId !== accountId) {result('stale'); return;}
          tx.objectStore('charts').clear();
          tx.objectStore('usage').clear();
          contexts.put({key: 'owner', accountId: null, generation: createRandomId()});
          result('cleared');
        };
      }) ?? 'unavailable';
      if(cleared==='cleared' && admitted?.accountId===accountId)admitted=null;
      return cleared;
    },
    close: database.close,
  };
}
export type AccountLibraryStore = ReturnType<typeof createAccountLibraryStore>;
