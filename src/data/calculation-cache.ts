import { migrateCalculationCache } from './calculation-cache-transition.ts';
import type { StoragePressure, StorageRelief } from './storage-pressure.ts';
import { createIndexedDatabase } from './indexed-db.ts';
import { estimateBytes } from './memory-cache.ts';
import { createLegacyCalculationSource, describeLegacyCalculation, LEGACY_CALCULATION_SOURCES,
  type CalculationKind, type LegacyCalculationSource } from './calculation-migration.ts';

export const CALCULATION_CACHE_BYTES=256_000_000;
const CONTROL_BYTES=4096;
export interface TransitWindow {dates:readonly string[];expiresAt:number}
interface WindowRecord extends TransitWindow {revision:number}
interface State {key:'budget';phase:'scanning'|'migrating'|'ready';accountedBytes:number;legacyBytes:number;
  clock:number;personalEpoch:number;revision:number;window:WindowRecord|null}
interface SourceState {key:string;definition:LegacyCalculationSource;storeIndex:number;after?:IDBValidKey;
  scanned:boolean;finished:boolean;personalEpoch:number}
interface Catalogue {id:string;kind:CalculationKind|null;key:string;date?:string;
  bytes:number;lru:number;location:'data'|'legacy';family:'natal'|'returns'|'transit';personalEpoch:number;
  source?:string;store?:string;sourceKey?:IDBValidKey;legacyBytes?:number;stage?:'pending'|'copied'|'evicting'}
interface Options {indexedDB?:IDBFactory|null;timeoutMs?:number;maxBytes?:number;now?:()=>number;
  databaseName?:string;legacySources?:readonly LegacyCalculationSource[];pressure?:StoragePressure}
export type CalculationCache=ReturnType<typeof createCalculationCache>;
const identity=(kind:CalculationKind,key:string)=>JSON.stringify([kind,key]);
const family=(kind:CalculationKind)=>kind==='natal'?'natal':kind==='transit'?'transit':'returns';
const request=<T>(value:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{
  value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);
});
async function* rows(source:IDBObjectStore|IDBIndex,key?:IDBValidKey):AsyncGenerator<IDBCursorWithValue> {
  const opened=source.openCursor(key);let cursor=await request(opened);
  while(cursor){yield cursor;const next=request(opened);cursor.continue();cursor=await next;}
}
function encodedKey(key:IDBValidKey):unknown {
  if(typeof key==='string' || typeof key==='number')return [typeof key,key];
  if(key instanceof Date)return ['date',key.getTime()];
  if(Array.isArray(key))return ['array',key.map(encodedKey)];
  const bytes=key instanceof ArrayBuffer?new Uint8Array(key):new Uint8Array(key.buffer,key.byteOffset,key.byteLength);
  return ['bytes',Array.from(bytes)];
}
interface CacheChange {transitUnchanged:true}
type ChangeListener=(change?:CacheChange)=>void;
function readChange(value:unknown):CacheChange|undefined {
  if(value && typeof value==='object' && !Array.isArray(value)
    && 'changed' in value && value.changed===true
    && 'transitUnchanged' in value && value.transitUnchanged===true)return {transitUnchanged:true};
  return undefined;
}
const localChanges=new WeakMap<IDBFactory,Map<string,Set<ChangeListener>>>();

/** One physical transaction owns payload, LRU, byte accounting and eviction across every tab. */
export function createCalculationCache({indexedDB:factory,timeoutMs=1000,maxBytes=CALCULATION_CACHE_BYTES,
  now=Date.now,databaseName='forma-calculation-cache',legacySources=LEGACY_CALCULATION_SOURCES,pressure}:Options={}) {
  if(!Number.isSafeInteger(maxBytes) || maxBytes<CONTROL_BYTES || maxBytes>CALCULATION_CACHE_BYTES)throw new RangeError('Invalid calculation budget');
  if(legacySources.length>3 || new Set(legacySources.map(source=>source.id)).size!==legacySources.length)throw new RangeError('Invalid legacy sources');
  const database=createIndexedDatabase({indexedDB:factory,databaseName,version:3,timeoutMs,
    stores:['payloads','catalogue','control'],upgrade(db,tx,oldVersion){
      if(!db.objectStoreNames.contains('payloads'))db.createObjectStore('payloads',{keyPath:'id'});
      const catalogue=db.objectStoreNames.contains('catalogue')?tx.objectStore('catalogue'):db.createObjectStore('catalogue',{keyPath:'id'});
      for(const name of ['lru','kind','location','stage'])if(!catalogue.indexNames.contains(name))catalogue.createIndex(name,name);
      if(!db.objectStoreNames.contains('control'))db.createObjectStore('control',{keyPath:'key'});
      if(oldVersion>0)migrateCalculationCache(tx);
    }});
  const sources=new Map(legacySources.map(source=>[source.id,createLegacyCalculationSource(source,{indexedDB:factory,timeoutMs})]));
  let closed=false,epoch:number|undefined,working:Promise<boolean>|null=null,setupWork:Promise<boolean|null>|null=null,expiration:ReturnType<typeof setTimeout>|undefined;
  const listeners=new Set<ChangeListener>(),actualFactory=factory===undefined?globalThis.indexedDB:factory;
  let peers:Set<ChangeListener>|undefined;
  if(actualFactory){
    if(!localChanges.has(actualFactory))localChanges.set(actualFactory,new Map());
    const names=localChanges.get(actualFactory)!;
    if(!names.has(databaseName))names.set(databaseName,new Set());peers=names.get(databaseName)!;
  }
  const channel=typeof window!=='undefined' && typeof BroadcastChannel!=='undefined'?new BroadcastChannel(databaseName):null;
  const notify:ChangeListener=change=>{
    if(!change?.transitUnchanged)void atomic(async tx=>(await state(tx))?.window??null,'readonly').then(schedule);
    for(const listener of listeners)try{listener(change);}catch{}};peers?.add(notify);
  if(channel)channel.onmessage=event=>notify(readChange(event.data));
  const publish=(change?:CacheChange)=>{for(const notifyPeer of peers??[])notifyPeer(change);channel?.postMessage({changed:true,...change});};
  function atomicResult<T>(action:(tx:IDBTransaction)=>Promise<T>,mode:IDBTransactionMode='readwrite') {
    return database.transactionResult<T>(mode,(tx,result,fail)=>{
      if(closed){fail();return;}
      // Await only this transaction's own requests.
      void action(tx).then(result,fail);
    });
  }
  async function atomic<T>(action:(tx:IDBTransaction)=>Promise<T>,mode:IDBTransactionMode='readwrite'):Promise<T|null> {
    const result=await atomicResult(action,mode);return result.status==='complete'?result.value:null;
  }
  const state=(tx:IDBTransaction)=>request(tx.objectStore('control').get('budget')) as Promise<State|undefined>;
  const save=(tx:IDBTransaction,value:State)=>tx.objectStore('control').put(value);
  function remove(tx:IDBTransaction,meta:Catalogue,value:State) {
    tx.objectStore('catalogue').delete(meta.id);if(meta.location==='data')tx.objectStore('payloads').delete(meta.id);
    value.accountedBytes-=meta.bytes;value.legacyBytes-=meta.legacyBytes??0;value.revision++;
  }
  function eligible(meta:Pick<Catalogue,'family'|'date'|'personalEpoch'>,value:State,allowUnconfirmed=false) {
    if(meta.family!=='transit')return meta.personalEpoch===value.personalEpoch;
    const current=value.window;
    return current?current.expiresAt>now() && current.dates.includes(meta.date??''):allowUnconfirmed;
  }
  const protectedDay=(meta:Catalogue,value:State)=>meta.family==='transit' && eligible(meta,value);
  function storedMeta(kind:CalculationKind,key:string,payload:unknown,info:{date?:string},value:State,lru?:number):Catalogue {
    const meta:Catalogue={id:identity(kind,key),kind,key,date:info.date,bytes:0,lru:lru??Math.max(now(),value.clock+1),
      location:'data',family:family(kind),personalEpoch:value.personalEpoch};
    meta.bytes=estimateBytes({id:meta.id,value:payload})+estimateBytes(meta);return meta;
  }
  async function prune(tx:IDBTransaction,value:State) {
    for await(const cursor of rows(tx.objectStore('catalogue'))) {
      const meta=cursor.value as Catalogue;if(eligible(meta,value,true))continue;
      if(meta.location==='data')remove(tx,meta,value);else{meta.stage='evicting';cursor.update(meta);}
    }
  }
  async function fit(tx:IDBTransaction,value:State,extra:number,exclude?:string):Promise<true|Catalogue|false> {
    if(value.accountedBytes+extra<=maxBytes)return true;
    for await(const cursor of rows(tx.objectStore('catalogue').index('lru'))) {
      if(value.accountedBytes+extra<=maxBytes)return true;
      const meta=cursor.value as Catalogue;if(meta.id===exclude || protectedDay(meta,value))continue;
      if(meta.location==='legacy'){meta.stage='evicting';cursor.update(meta);save(tx,value);return meta;}
      remove(tx,meta,value);
    }
    return value.accountedBytes+extra<=maxBytes;
  }
  function setup():Promise<boolean|null> {
    if(setupWork)return setupWork;
    setupWork=atomic(async tx=>{
    let value=await state(tx);
    if(!value){value={key:'budget',phase:'scanning',accountedBytes:CONTROL_BYTES,legacyBytes:0,clock:0,
      personalEpoch:0,revision:0,window:null};save(tx,value);}
    for(const definition of legacySources) {
      const key=`source:${definition.id}`,old=await request(tx.objectStore('control').get(key)) as SourceState|undefined;
      if(old && JSON.stringify(old.definition)!==JSON.stringify(definition))throw new Error('Legacy source identity changed');
      if(!old)tx.objectStore('control').put({key,definition,storeIndex:0,scanned:false,finished:false,personalEpoch:value.personalEpoch} satisfies SourceState);
    }
      return {epoch:value.personalEpoch,window:value.window};
    }).then(result=>{if(!result){setupWork=null;
      // Without an initial epoch we cannot establish whether a response predates
      // a logout in another tab. Recovery needs a new personal-cache owner.
      if(epoch===undefined)epoch=-1;return null;
    }
      if(epoch===undefined)epoch=result.epoch;schedule(result.window,true);return true;
    });
    return setupWork;
  }
  void setup();
  async function dropLegacy(meta:Catalogue) {
    if(!await sources.get(meta.source!)!.remove(meta.store!,meta.sourceKey!))throw new Error('Legacy deletion unavailable');
    if(!await atomic(async tx=>{
      const value=(await state(tx))!,current=await request(tx.objectStore('catalogue').get(meta.id)) as Catalogue|undefined;
      if(current)remove(tx,current,value);save(tx,value);return true;
    }))throw new Error('Legacy accounting unavailable');
  }
  async function migrate() {
    if(!await setup())return false;
    try {
      for(const definition of legacySources) {
        const key=`source:${definition.id}`,source=sources.get(definition.id)!;
        for(;;) {
          const snapshot=await atomic(tx=>request(tx.objectStore('control').get(key)) as Promise<SourceState>);
          if(!snapshot)throw new Error('Migration state unavailable');if(snapshot.scanned)break;
          const store=definition.stores[snapshot.storeIndex],entry=await source.next(store,snapshot.after);
          if(entry.status!=='ok')throw new Error('Legacy source unavailable');
          const committed=await atomic(async tx=>{
            const value=(await state(tx))!,current=await request(tx.objectStore('control').get(key)) as SourceState;
            if(current.scanned || current.storeIndex!==snapshot.storeIndex
              || JSON.stringify(current.after===undefined?null:encodedKey(current.after))!==JSON.stringify(snapshot.after===undefined?null:encodedKey(snapshot.after)))return true;
            if(entry.entry) {
              const item=entry.entry,description=describeLegacyCalculation(definition,store,item.key,item.value);
              const id=JSON.stringify(['legacy',definition.id,store,encodedKey(item.key)]);
              if(!await request(tx.objectStore('catalogue').get(id))) {
                const oldAccess=(item.value as {accessedAt?:unknown}|null)?.accessedAt;
                const lru=typeof oldAccess==='number' && Number.isFinite(oldAccess)?Math.max(0,Math.min(now(),oldAccess)):0;
                const meta:Catalogue={id,kind:description?.kind??null,key:description?.key??'',date:description?.date,
                  bytes:0,lru,location:'legacy',family:definition.family,personalEpoch:current.personalEpoch,
                  source:definition.id,store,sourceKey:item.key,legacyBytes:estimateBytes(item.value)+estimateBytes(item.key),
                  stage:description && (definition.family==='transit' || current.personalEpoch===value.personalEpoch)?'pending':'evicting'};
                meta.bytes=meta.legacyBytes!+estimateBytes(meta);value.accountedBytes+=meta.bytes;value.legacyBytes+=meta.legacyBytes!;
                value.clock=Math.max(value.clock,lru);tx.objectStore('catalogue').put(meta);
              }
              current.after=item.key;
            } else{current.storeIndex++;delete current.after;current.scanned=current.storeIndex===definition.stores.length;}
            tx.objectStore('control').put(current);save(tx,value);return true;
          });if(!committed)throw new Error('Migration checkpoint unavailable');
        }
      }
      const expiredWindow=(value:State)=>value.window && value.window.expiresAt<=now()?value.window.expiresAt:null;
      const initialized=await atomic(async tx=>{
        const value=(await state(tx))!,expiredAt=expiredWindow(value);
        if(value.phase!=='ready')value.phase='migrating';
        await prune(tx,value);save(tx,value);return {expiredAt};
      });if(!initialized)throw new Error('Migration preparation unavailable');
      let prunedExpiry=initialized.expiredAt;
      for(;;) {
        const next=await atomic(async tx=>{
          const value=(await state(tx))!,expiredAt=expiredWindow(value);
          // Scanning is complete. Rule changes already prune in their own
          // transaction; only elapsed time can invalidate another row here.
          if(expiredAt!==null && expiredAt!==prunedExpiry)await prune(tx,value);
          const catalogue=tx.objectStore('catalogue');
          const meta=(await request(catalogue.index('stage').get('evicting'))
            ?? await request(catalogue.index('location').get('legacy'))) as Catalogue|undefined;
          save(tx,value);return {meta,expiredAt};
        });if(!next)throw new Error('Migration index unavailable');
        prunedExpiry=next.expiredAt;
        const meta=next.meta;if(!meta)break;
        if(meta.stage==='evicting' || !meta.kind){await dropLegacy(meta);continue;}
        const definition=legacySources.find(source=>source.id===meta.source)!,source=sources.get(meta.source!)!;
        const original=await source.get(meta.store!,meta.sourceKey!);
        if(original.status!=='ok')throw new Error('Legacy read unavailable');
        const description=original.entry?describeLegacyCalculation(definition,meta.store!,meta.sourceKey!,original.entry.value):null;
        if(!description){await dropLegacy(meta);continue;}
        const copying=await atomicResult(async tx=>{
          const value=(await state(tx))!,current=await request(tx.objectStore('catalogue').get(meta.id)) as Catalogue|undefined;
          if(!current)return {copied:true};
          if(current.stage==='evicting' || !eligible(current,value,true))return {discard:current};
          const target=storedMeta(description.kind,description.key,description.value,description,value,current.lru);
          if(await request(tx.objectStore('catalogue').get(target.id)))return {copied:true};
          const space=await fit(tx,value,0);save(tx,value);
          if(space!==true){if(space===false)throw new Error('Protected calculations exceed budget');return {discard:space};}
          if(target.bytes+CONTROL_BYTES>maxBytes && !protectedDay(current,value))return {discard:current};
          // Keep the fenced source and its ledger when the final record fits
          // but a durable source+destination copy does not. Reads and subsequent
          // writes still use the same catalogue/LRU while migration is pending.
          if(value.accountedBytes+target.bytes>maxBytes)return {deferred:true};
          tx.objectStore('payloads').put({id:target.id,value:description.value});tx.objectStore('catalogue').put(target);
          current.stage='copied';tx.objectStore('catalogue').put(current);
          value.accountedBytes+=target.bytes;value.revision++;save(tx,value);return {copied:true};
        });
        // A physical quota can reject the temporary duplicate even within our
        // own budget. Keep the accounted source readable; retry on later use.
        if(copying.status==='quota')return await atomic(async tx=>{
          const value=await state(tx);return !!value && value.phase==='migrating' && value.accountedBytes<=maxBytes;
        },'readonly')===true;
        const copied=copying.status==='complete'?copying.value:null;
        if(!copied)throw new Error('Migration copy unavailable');
        if(copied.discard){await dropLegacy(copied.discard);continue;}
        if(copied.deferred)return true;
        await dropLegacy(meta);
      }
      const completed=await atomic(async tx=>{
        const value=(await state(tx))!;await prune(tx,value);
        if(await request(tx.objectStore('catalogue').index('location').count('legacy')))return false;
        if(await fit(tx,value,0)!==true)throw new Error('Protected calculations exceed budget');
        value.phase='ready';save(tx,value);
        for(const definition of legacySources){const key=`source:${definition.id}`,source=await request(tx.objectStore('control').get(key)) as SourceState;
          if(!source.scanned)return false;source.finished=true;tx.objectStore('control').put(source);}
        return true;
      });if(completed)publish();return completed===true;
    } catch{return false;}
  }
  function ready() {
    if(closed)return Promise.resolve(false);
    if(!working)working=(async()=>{
      if(!await setup())return false;
      const current=await atomic(async tx=>(await state(tx))!.phase==='ready','readonly');return current===true || await migrate();
    })().finally(()=>working=null);
    return working;
  }
  const allowed=(kind:CalculationKind,value:State)=>kind==='transit' || epoch===value.personalEpoch;
  async function find(tx:IDBTransaction,kind:CalculationKind,key:string,value:State) {
    const direct=await request(tx.objectStore('catalogue').get(identity(kind,key))) as Catalogue|undefined;
    if(direct)return direct;
    if(!value.legacyBytes)return undefined;
    for await(const cursor of rows(tx.objectStore('catalogue').index('kind'),kind)){
      const meta=cursor.value as Catalogue;if(meta.key===key && meta.stage==='pending')return meta;
    }
    return undefined;
  }
  async function retireLegacy(tx:IDBTransaction,kind:CalculationKind,key:string,value:State) {
    const retired:Catalogue[]=[];
    if(!value.legacyBytes)return retired;
    for await(const cursor of rows(tx.objectStore('catalogue').index('kind'),kind)){
      const meta=cursor.value as Catalogue;
      if(meta.key!==key || meta.location!=='legacy')continue;
      meta.stage='evicting';cursor.update(meta);retired.push(meta);
    }
    return retired;
  }
  async function read<T>(kind:CalculationKind,key:string,{touchOnly=false,observeOnly=false}={}):Promise<T|boolean|null> {
    // Construction establishes the owner's epoch. Observation never advances
    // migration or refreshes recency; genuine use still enters through ready().
    if(!await (observeOnly?setup():ready()))return null;
    const lookup=async(tx:IDBTransaction,updateAccess:boolean)=>{
      const value=(await state(tx))!;if(value.phase==='scanning' || !allowed(kind,value))return null;
      const meta=await find(tx,kind,key,value);
      if(!meta || !eligible(meta,value))return null;
      if(updateAccess){
        meta.lru=value.clock=Math.max(now(),value.clock+1);tx.objectStore('catalogue').put(meta);save(tx,value);
      }
      if(touchOnly)return {value:true};
      if(meta.location==='legacy')return {legacy:meta};
      const data=await request(tx.objectStore('payloads').get(meta.id));return {value:data?.value as T??null};
    };
    // Transit retention is determined by the current window, never by recency.
    const updateAccess=!observeOnly && kind!=='transit';
    const accessed=await atomicResult(tx=>lookup(tx,updateAccess),updateAccess?'readwrite':'readonly');
    // Failed bookkeeping must not hide a saved calculation. Re-read the live
    // window and owner in the fallback transaction; never reuse a stale value.
    const found=accessed.status==='complete'?accessed.value
      :accessed.status==='quota' && !touchOnly?await atomic(tx=>lookup(tx,false),'readonly'):null;
    if(!found)return null;if(!found.legacy)return found.value??null;
    const meta=found.legacy,source=sources.get(meta.source!)!,definition=legacySources.find(source=>source.id===meta.source)!;
    const item=await source.get(meta.store!,meta.sourceKey!);
    if(item.status!=='ok' || !item.entry)return null;
    const description=describeLegacyCalculation(definition,meta.store!,meta.sourceKey!,item.entry.value);
    if(!description)return null;
    return atomic(async tx=>{
      const value=(await state(tx))!,current=await request(tx.objectStore('catalogue').get(meta.id)) as Catalogue|undefined;
      return current?.stage==='pending' && allowed(kind,value) && eligible(current,value)?description.value as T:null;
    },'readonly');
  }
  async function expire() {
    if(!await setup() || closed)return;
    const result=await atomic(async tx=>{const value=(await state(tx))!,previous=value.revision;
      if(value.window && value.window.expiresAt<=now())await prune(tx,value);save(tx,value);
      return {changed:value.revision!==previous,window:value.window};});
    if(result)schedule(result.window);
    if(result?.changed)publish();
    if(await atomic(async tx=>(await state(tx))!.phase!=='ready'))await migrate();
  }
  function schedule(window:WindowRecord|null,includeExpired=false) {
    clearTimeout(expiration);
    if(!closed && window && (includeExpired || window.expiresAt>now()))expiration=setTimeout(()=>void expire(),Math.max(0,Math.min(2**31-1,window.expiresAt-now())));
    (expiration as unknown as {unref?():void}|undefined)?.unref?.();
  }
  return {
    async get<T=unknown>(kind:CalculationKind,key:string,options:{observeOnly?:boolean}={}):Promise<T|null>{return await read<T>(kind,key,options) as T|null;},
    async touch(kind:CalculationKind,key:string){return await read(kind,key,{touchOnly:true}) as boolean|null;},
    // Admission probes do not consume a payload or update its LRU. The current
    // epoch and transit window are rechecked in this transaction.
    async has(kind:CalculationKind,key:string) {
      if(!await ready())return null;
      return atomic(async tx=>{const value=(await state(tx))!;if(!allowed(kind,value))return null;
        const meta=await find(tx,kind,key,value);
        return Boolean(meta && (meta.location==='data' || meta.stage==='pending') && eligible(meta,value));
      },'readonly');
    },
    async put(kind:CalculationKind,key:string,payload:unknown,info:{date?:string}={}):Promise<boolean|null> {
      let snapshot:unknown;try{snapshot=structuredClone(payload);}catch{return null;}
      if(!await ready())return null;
      for(;;){const write=()=>atomicResult(async tx=>{
        const value=(await state(tx))!;if(value.phase==='scanning' || !allowed(kind,value))return null;
        const meta=storedMeta(kind,key,snapshot,info,value);if(!eligible(meta,value) || meta.bytes+CONTROL_BYTES>maxBytes)return null;
        const old=await request(tx.objectStore('catalogue').get(meta.id)) as Catalogue|undefined;
        const expired=!!value.window && value.window.expiresAt<=now(),extra=meta.bytes-(old?.bytes??0);
        // Certify only ordinary private writes with no pruning or eviction.
        // Migration, pressure and elapsed windows keep the broad notification.
        const transitUnchanged=kind!=='transit' && value.phase==='ready'
          && !expired && value.accountedBytes+extra<=maxBytes;
        if(expired)await prune(tx,value);
        const space=await fit(tx,value,extra,meta.id);save(tx,value);
        if(space!==true)return space?{discard:space}:null;
        if(old)remove(tx,old,value);
        const retired=await retireLegacy(tx,kind,key,value);
        tx.objectStore('payloads').put({id:meta.id,value:snapshot});tx.objectStore('catalogue').put(meta);
        value.accountedBytes+=meta.bytes;value.clock=meta.lru;value.revision++;save(tx,value);return {saved:true,retired,transitUnchanged};
      });
        const result=pressure?await pressure.write(write,{calculation:{kind,key}}):await write();
        const committed=result.status==='complete'?result.value:null;
        if(committed?.discard){try{await dropLegacy(committed.discard);}catch{return null;}continue;}
        if(committed?.saved){
          for(const meta of committed.retired??[])try{await dropLegacy(meta);}catch{/* Counted, invisible cleanup remains resumable. */}
          publish(committed.transitUnchanged?{transitUnchanged:true}:undefined);return true;
        }return null;
      }
    },
    async evictForSpace(kind:'natal'|'return-charts',keep:number,exclude?:string,isCurrent:()=>boolean=()=>true):Promise<StorageRelief> {
      if(!Number.isSafeInteger(keep)||keep<0||!['natal','return-charts'].includes(kind))throw new RangeError('Invalid relief category');
      if(!await setup())return 'unavailable';
      const removed=await atomic(async tx=>{
        const value=(await state(tx))!;if(value.phase==='scanning'||epoch!==value.personalEpoch||!isCurrent())return null;
        // The steady state reads only metadata, stopping at the first LRU victim.
        if(!value.legacyBytes){
          if(await request(tx.objectStore('catalogue').index('kind').count(kind))<=keep)return {empty:true};
          for await(const cursor of rows(tx.objectStore('catalogue').index('lru'))){
            const meta=cursor.value as Catalogue;if(meta.kind!==kind || meta.key===exclude)continue;
            if(!isCurrent())return null;
            remove(tx,meta,value);save(tx,value);return {legacy:[] as Catalogue[]};
          }
          return {empty:true};
        }
        const entries:Catalogue[]=[];
        for await(const cursor of rows(tx.objectStore('catalogue').index('kind'),kind))entries.push(cursor.value as Catalogue);
        const pending=entries.filter(meta=>meta.stage==='evicting');
        if(pending.length)return {legacy:pending};
        const usable=entries.filter(meta=>meta.location==='data'||meta.stage==='pending');
        if(new Set(usable.map(meta=>meta.key)).size<=keep)return {empty:true};
        if(!isCurrent())return null;
        const oldest=usable.filter(meta=>meta.key!==exclude).sort((a,b)=>a.lru-b.lru||a.id.localeCompare(b.id))[0];
        if(!oldest)return {empty:true};
        const legacy:Catalogue[]=[];
        for(const meta of entries.filter(row=>row.key===oldest.key)){
          if(meta.location==='data')remove(tx,meta,value);
          else {meta.stage='evicting';tx.objectStore('catalogue').put(meta);legacy.push(meta);}
        }
        save(tx,value);return {legacy};
      });
      if(!removed)return 'unavailable';if('empty' in removed)return 'empty';
      try{for(const meta of removed.legacy)await dropLegacy(meta);}catch{return 'unavailable';}
      publish();return 'released';
    },
    async remove(kind:CalculationKind,key:string) {
      if(!await ready())return null;
      const result=await atomic(async tx=>{const value=(await state(tx))!;if(!allowed(kind,value))return null;
        const meta=await request(tx.objectStore('catalogue').get(identity(kind,key))) as Catalogue|undefined;
        if(meta)remove(tx,meta,value);
        const retired=await retireLegacy(tx,kind,key,value),changed=Boolean(meta || retired.length);
        if(changed)save(tx,value);return {retired,changed};});
      for(const meta of result?.retired??[])try{await dropLegacy(meta);}catch{return null;}
      if(result?.changed)publish();return result?true:null;
    },
    async catalogue(kind:CalculationKind) {
      if(!await ready())return null;
      return atomic(async tx=>{const value=(await state(tx))!;if(!allowed(kind,value))return null;const found:{key:string;date?:string}[]=[];
        for await(const cursor of rows(tx.objectStore('catalogue').index('kind'),kind)){
          const meta=cursor.value as Catalogue;if((meta.location==='data' || meta.stage==='pending') && eligible(meta,value))found.push({key:meta.key,date:meta.date});}
        return found;},'readonly');
    },
    async setTransitWindow(window:TransitWindow,{expectedRevision}:{expectedRevision?:number}={}) {
      if(!await setup() || window.dates.length<1 || window.dates.length>2
        || new Set(window.dates).size!==window.dates.length || window.dates.some(date=>!/^\d{4}-\d{2}-\d{2}$/.test(date))
        || !Number.isSafeInteger(window.expiresAt) || window.expiresAt<=now())return {status:'invalid' as const};
      let changed=false;
      const result=await atomic(async tx=>{const value=(await state(tx))!,current=value.window;
        if(current && current.expiresAt===window.expiresAt && JSON.stringify(current.dates)===JSON.stringify(window.dates))return {status:'applied' as const,revision:current.revision};
        if(current && current.revision!==expectedRevision)return {status:'stale' as const};
        value.window={...window,dates:[...window.dates],revision:(current?.revision??0)+1};await prune(tx,value);value.revision++;save(tx,value);changed=true;
        return {status:'applied' as const,revision:value.window.revision};});
      if(result?.status==='applied'){schedule({...window,revision:result.revision});if(changed)publish();}return result;
    },
    async clearPersonal() {
      if(!await setup())return null;
      const result=await atomic(async tx=>{const value=(await state(tx))!;value.personalEpoch++;await prune(tx,value);save(tx,value);return value.personalEpoch;});
      if(result===null)return null;
      publish();const completed=await migrate();
      const remaining=completed?await atomic(async tx=>{
        for await(const cursor of rows(tx.objectStore('catalogue').index('location'),'legacy'))if((cursor.value as Catalogue).family!=='transit')return true;
        return false;
      }):true;
      return {epoch:result,status:remaining===false?'cleared' as const:'pending' as const};
    },
    async status() {
      if(!await setup())return {phase:'unavailable' as const,accountedBytes:null,legacyBytes:null};
      return await atomic(async tx=>{const value=(await state(tx))!;return {...value,maxBytes};},'readonly')
        ??{phase:'unavailable' as const,accountedBytes:null,legacyBytes:null};
    },
    subscribe(listener:ChangeListener){listeners.add(listener);return()=>listeners.delete(listener);},
    close(){if(closed)return;closed=true;clearTimeout(expiration);peers?.delete(notify);channel?.close();listeners.clear();
      for(const source of sources.values())source.close();database.close();},
  };
}
