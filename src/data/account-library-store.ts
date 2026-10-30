import type { StoragePressure } from './storage-pressure.ts';
import type { AccountChart } from '../../shared/chart-record-contract.ts';
import { createRandomId } from '../domain/chart-record.ts';
import { validateAccountChart } from '../domain/account-chart.ts';
import { createIndexedDatabase } from './indexed-db.ts';
import {upgradeAccountLibrary,validLibraryAccountId as ownerId,readLibraryLease as lease,sameLibraryLease as same,type LibraryLease} from './account-library-schema.ts';
export type {LibraryLease} from './account-library-schema.ts';
export type {LibraryCatalogBase} from './library-catalog-store.ts';
import {createLibraryPackageStore,unlinkLibraryPackages,linkLibraryPackages} from './library-package-store.ts';
import { placeOpenedCard,replaceCardAfterQuota } from './account-card-placement.ts';
import {createLibraryCatalogStore,markLibraryMutation,readStoredLibraryCatalog,libraryMarker,newerLibraryMarker,type LibraryCatalogBase} from './library-catalog-store.ts';
import type {LibraryCatalogSnapshot} from '../../shared/library-catalog-contract.ts';
import {createBackgroundCheckStore} from './background-check-store.ts';
import type {CheckAuthority} from '../domain/background-check.ts';

export interface LibrarySnapshot { lease: LibraryLease | null; charts: AccountChart[];catalog?:LibraryCatalogSnapshot;catalogComplete?:boolean;minimumMarker?:string }
export type LibraryStoreResult = {status: 'stored'; lease: LibraryLease; pressure?:true; changed?:boolean} | {status:'partial';lease:LibraryLease;changed?:boolean} | {status: 'stale' | 'unavailable'};
interface Options { indexedDB?: IDBFactory | null; databaseName?: string;now?:()=>number;pressure?:StoragePressure }
const unavailable = (): LibraryStoreResult => ({status: 'unavailable'});

/** Account library only: no calculation-cache quota, legacy migration, command queue or tombstones. */
export function createAccountLibraryStore({indexedDB, databaseName = 'forma-account-library',now=Date.now,pressure}: Options = {}) {
  const database = createIndexedDatabase({databaseName, version: 7, stores: ['charts', 'context', 'usage', 'packages', 'packageMetadata'], indexedDB,
    upgrade:upgradeAccountLibrary});
  let admitted:LibraryLease|null|undefined;
  const catalog=createLibraryCatalogStore(database,now);
  return {
    background:createBackgroundCheckStore(database),
    ...createLibraryPackageStore(database,{pressure,now}),
    readCatalog:catalog.readCatalog,
    async putCatalog(base:LibraryCatalogBase,snapshot:LibraryCatalogSnapshot,authority?:CheckAuthority) {
      const saved=await catalog.putCatalog(base,snapshot,authority);
      if(saved.status==='stored' && admitted && same(admitted,base.lease))admitted=saved.lease;
      return saved;
    },
    capture(accountId:string):LibraryLease|null {return admitted?.accountId===accountId?{...admitted}:null;},
    async read(): Promise<LibrarySnapshot | null> {
      const snapshot=await database.transaction<LibrarySnapshot>('readonly', (tx, result) => {
        const context = tx.objectStore('context').get('owner');
        context.onsuccess = () => {
          if (!context.result || context.result.accountId === null) { result({lease: null, charts: []}); return; }
          const current = lease(context.result); if (!current) return;
          const rows = tx.objectStore('charts').getAll(),catalog=tx.objectStore('context').get('catalog');
          catalog.onsuccess = () => {
            const charts: AccountChart[] = [];
            for (const raw of rows.result) {
              try { charts.push(validateAccountChart(raw, current.accountId)); }
              catch { /* Do not publish or delete an invalid stored row. A server refresh may replace it. */ }
            }
            const snapshot=readStoredLibraryCatalog(catalog.result,current.accountId);
            result({lease: current, charts,minimumMarker:libraryMarker(context.result.catalogMarker),
              ...(snapshot?{catalog:snapshot,catalogComplete:catalog.result?.complete!==false}:{})});
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
          tx.objectStore('packages').clear();
          tx.objectStore('packageMetadata').clear();
          contexts.delete('catalog');
          contexts.put({key: 'owner', ...next});
          result({status: 'stored', lease: next});
        };
      }) ?? unavailable();
      if(saved.status==='stored')admitted=saved.lease;return saved;
    },
    async put(seen:LibraryLease,values:readonly AccountChart[],marker?:string):Promise<LibraryStoreResult> {
      // A late quota must not acquire cleanup permission from a new account.
      const isCurrent=pressure?.capture();
      const charts=values.map(value=>validateAccountChart(value,seen.accountId));
      const write=(batch:readonly AccountChart[])=>database.transactionResult<LibraryStoreResult>('readwrite',(tx,result,fail)=>{
        const request=tx.objectStore('context').get('owner');request.onsuccess=()=>{
          if(!same(request.result,seen)){result({status:'stale'});return;}
          const rows=tx.objectStore('charts');
          const outcome:LibraryStoreResult & {status:'stored'}={status:'stored',lease:{...seen},changed:false};
          let remaining=batch.length;
          for(const chart of batch){const prior=rows.get(chart.id);prior.onsuccess=()=>{
            try{
              let current:AccountChart|null=null;try{current=validateAccountChart(prior.result,seen.accountId);}catch{}
              if(!current || current.revision<chart.revision){
                // Acquisition never creates or changes a real-use mark.
                if(current)unlinkLibraryPackages(tx,chart.id,chart);
                rows.put(chart);
                linkLibraryPackages(tx,chart);
                outcome.changed=true;
              }
              if(!--remaining && (outcome.changed || BigInt(libraryMarker(marker))>BigInt(libraryMarker(request.result.catalogMarker))))markLibraryMutation(tx,request.result,marker);
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
          if(pressure){result=await pressure.write(()=>write([chart]),{atomicLibrary:true});recovered=true;}
          if(result.status==='quota') {
            const replacement=await replaceCardAfterQuota({database,chart,isOwner:owner=>same(owner,seen),isCurrent:isCurrent??(()=>true),marker});
            if(replacement.saved){result={status:'complete',value:{status:'stored',lease:{...seen},changed:replacement.changed}};recovered=true;}
          }
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
    async touch(seen:LibraryLease,chartId:string,openedChart?:AccountChart,marker?:string):Promise<boolean> {
      const isCurrent=pressure?.capture()??(()=>true);
      const chart=openedChart?validateAccountChart(openedChart,seen.accountId):null,openedAt=Math.max(1,now());
      if(chart && chart.id!==chartId)throw new TypeError('invalid_chart');
      const present=await database.transaction<'stored'|'missing'|'stale'>('readwrite',(tx,result,fail)=>{
        const owner=tx.objectStore('context').get('owner');owner.onsuccess=()=>{
          if(!same(owner.result,seen)){result('stale');return;}
          const rows=tx.objectStore('charts');
          const read=chart?rows.index('recordRevision').getKey([chartId,chart.revision]):rows.getKey(chartId);
          read.onsuccess=()=>{
            if(!read.result){result('missing');return;}
            try{tx.objectStore('usage').put({id:chartId,openedAt});result('stored');}catch(error){fail(error);}
          };
        };
      });
      return present==='stored' || present==='missing' && !!chart && await placeOpenedCard({database,isOwner:owner=>same(owner,seen),isCurrent,chart,openedAt,pressure,marker});
    },
    async remove(seen: LibraryLease, chartId: string,marker?:string,proof:'absence'|'deleted'='absence'): Promise<LibraryStoreResult|{status:'superseded'}> {
      const saved=await database.transaction<LibraryStoreResult|{status:'superseded'}>('readwrite', (tx, result) => {
        const contexts = tx.objectStore('context'), request = contexts.get('owner');
        request.onsuccess = () => {
          if (!same(request.result, seen)) { result({status: 'stale'}); return; }
          if(proof==='absence' && marker!==undefined && BigInt(libraryMarker(marker))<BigInt(libraryMarker(request.result.catalogMarker))){result({status:'superseded'});return;}
          const next = {...seen, generation: createRandomId()};
          unlinkLibraryPackages(tx,chartId);
          tx.objectStore('charts').delete(chartId);
          tx.objectStore('usage').delete(chartId);
          const prior=contexts.get('catalog');prior.onsuccess=()=>{
            const saved=readStoredLibraryCatalog(prior.result,seen.accountId);
            if(saved)contexts.put({key:'catalog',...saved,complete:false,entries:saved.entries.filter(row=>row.id!==chartId)});
          };
          contexts.put({...request.result,key:'owner',...next,catalogMarker:newerLibraryMarker(request.result.catalogMarker,marker)});
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
          tx.objectStore('packages').clear();
          tx.objectStore('packageMetadata').clear();
          contexts.delete('catalog');
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
          tx.objectStore('packages').clear();
          tx.objectStore('packageMetadata').clear();
          contexts.delete('catalog');
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
