import {createLocalDayTimeline} from '../domain/day-timeline.ts';
import {createAccountLibraryStore} from './account-library-store.ts';
import { createCalculationCache, type CalculationCache, type TransitWindow } from './calculation-cache.ts';
import { createMemoryCache, type MemoryCache } from './memory-cache.ts';
import { createNatalDayStorage } from './natal-day-storage.ts';
import { createReturnStorage } from './return-storage.ts';
import { createTransitDayCache } from './transit-day-cache.ts';
import { createTransitDayClient } from './transit-day-client.ts';
import { createNatalDayClient, type NatalDayClient } from './natal-day-client.ts';
import { createCyclesClient, type CyclesClient } from './cycles-client.ts';
import { createAbortError } from '../runtime/shared-request.ts';
import type { ObserveClientAction } from '../../shared/client-report-contract.ts';
import type { NatalDay } from '../../shared/day-packets/natal-format.ts';

type Options = {
  observe?:ObserveClientAction;
  cacheOptions?: Parameters<typeof createCalculationCache>[0];
  libraryOptions?:Parameters<typeof createAccountLibraryStore>[0];
  memory?: MemoryCache;
  transit?: Omit<NonNullable<Parameters<typeof createTransitDayClient>[0]>, 'memory'|'days'>;
  natal?: Omit<NonNullable<Parameters<typeof createNatalDayClient>[0]>, 'memory'|'persistentCache'|'library'>;
  cycles?: Omit<NonNullable<Parameters<typeof createCyclesClient>[0]>, 'memory'|'returnStorage'|'library'>;
};
export type TransitWindowUpdate={status:'applied';revision:number}|{status:'stale'|'unavailable'|'invalid'|'cancelled'};
export interface PersonalCalculationCleanup {
  status:'cleared'|'pending'|'unavailable';
  generation:number;
  epoch?:number;
}
export type CalculationClients = ReturnType<typeof createCalculationClients>;

// A revoked port does not retain a namespace or a list of formerly used keys.
// In-flight clients may still hold this object, but can no longer mutate RAM.
function privateMemory(memory:MemoryCache) {
  let open=true;
  const port:MemoryCache={
    get<T>(key:PropertyKey){return open?memory.get<T>(key):null;},
    peek<T>(key:PropertyKey){return open?memory.peek<T>(key):null;},
    put<T>(key:PropertyKey,value:T,size?:number){return open?memory.put(key,value,size):value;},
    delete(key:PropertyKey){if(open)memory.delete(key);},
    keys(prefix:string){return open?memory.keys(prefix):[];},
    retain<T>(key:PropertyKey,value:T,size?:number){return open?memory.retain(key,value,size):()=>{};},
    clearExcept(prefix:string){if(open)memory.clearExcept(prefix);},
    get bytes(){return open?memory.bytes:0;},get size(){return open?memory.size:0;},
  };
  return {port,close(){open=false;}};
}

/** One early owner of calculation clients, local transit storage and account cleanup. */
export function createCalculationClients({cacheOptions,libraryOptions,memory=createMemoryCache(),transit:transitOptions,
  natal:natalOptions,cycles:cyclesOptions,observe}:Options={}) {
  const cache=createCalculationCache(cacheOptions);
  const library=createAccountLibraryStore({indexedDB:cacheOptions?.indexedDB,pressure:cacheOptions?.pressure,...libraryOptions});
  const days=createTransitDayCache({cache,memory});
  const transit=createTransitDayClient({...transitOptions,days,memory});
  let closed=false,nextGeneration=0,cleanupTail:Promise<unknown>=Promise.resolve();

  let today:ReturnType<typeof createLocalDayTimeline>|null=null;
  let preparingToday:{target:ReturnType<typeof createLocalDayTimeline>;work:Promise<TransitWindowUpdate>}|null=null;
  function syncTodayTransitWindow(timeZone:string,now:number,refresh=false) {
    if(closed)return;
    const sameDay=(value:typeof today)=>value && now<value.endUtc && now>=value.startUtc && value.timeZone===timeZone;
    if(!refresh && sameDay(preparingToday?.target??null))return preparingToday!.work;
    if(!refresh && !preparingToday && sameDay(today))return;
    const target=createLocalDayTimeline(now,timeZone);
    const request={target,work:syncTransitWindow({dates:target.packetDates,expiresAt:target.endUtc}).then(result=>{
      if(preparingToday===request){
        preparingToday=null;
        if(result.status==='applied')today=target;
      }
      return result;
    })};
    preparingToday=request;
    return request.work;
  }
  let windowSequence=0,windowTail:Promise<unknown>=Promise.resolve();
  function syncTransitWindow(window:TransitWindow):Promise<TransitWindowUpdate> {
    // Only a completed daily preparation may suppress a later ordinary call.
    today=null;
    const target={dates:[...window.dates],expiresAt:window.expiresAt},sequence=++windowSequence;
    const observation=observe?.({action:'data_read',component:'storage'});
    const stopped=():TransitWindowUpdate|null=>closed?{status:'cancelled'}:sequence!==windowSequence?{status:'stale'}:null;
    const unavailable=()=>{void observation?.reportFailure({stage:'commit',reason:'storage_unavailable'});return {status:'unavailable' as const};};
    const work=windowTail.then(async():Promise<TransitWindowUpdate>=>{
      const superseded=stopped();if(superseded)return superseded;
      // Read inside the queue, after the preceding window committed.
      const before=await cache.status(),interrupted=stopped();if(interrupted)return interrupted;
      if(!('window' in before))return unavailable();
      const result=await cache.setTransitWindow(target,{expectedRevision:before.window?.revision});
      const afterWrite=stopped();if(afterWrite)return afterWrite;
      if(!result)return unavailable();
      if(result.status!=='applied'){
        if(result.status==='invalid')void observation?.reportFailure({stage:'commit',reason:'invalid_request'});
        return result;
      }
      // An early fetch can finish before the first local window is known.
      for(const date of target.dates){const day=transit.peekDay(date);if(day)days.putDay(day,{ifMissing:true});}
      await days.flush();return stopped()??result;
    }).catch((error):TransitWindowUpdate=>{
      const interrupted=stopped();if(interrupted)return interrupted;
      void observation?.reportError(error,{stage:'commit'});return {status:'unavailable'};
    }).finally(()=>observation?.finishSuccess());
    windowTail=work;return work;
  }

  function clients(port:MemoryCache,persistent:CalculationCache|null,ownsCache=false) {
    const binary=persistent?createNatalDayStorage({cache:persistent}):null;
    const returns=persistent?createReturnStorage({cache:persistent}):null;
    const cycles=createCyclesClient({...cyclesOptions,memory:port,returnStorage:returns,library});
    return {
      natal:createNatalDayClient({...natalOptions,memory:port,persistentCache:binary,library}),
      cycles,
      evictForSpace:(kind:'natal'|'return-charts',keep:number,exclude?:string,isCurrent?:()=>boolean)=>persistent?.evictForSpace(kind,keep,exclude,isCurrent)??Promise.resolve('unavailable' as const),
      close(){cycles.close();binary?.close();returns?.close();if(ownsCache)persistent?.close();},
    };
  }
  function generation(persistent:CalculationCache|null) {
    const privateCache=privateMemory(memory),initialClients=clients(privateCache.port,persistent);
    return {id:nextGeneration++,closed:false,abort:new AbortController(),memory:privateCache,
      clients:initialClients,initialClients,cleanup:null as Promise<PersonalCalculationCleanup>|null,
      result:null as PersonalCalculationCleanup|null};
  }
  type Generation=ReturnType<typeof generation>;
  let current=generation(cache);
  const natalOwners=new WeakMap<NatalDay,{generation:Generation;client:NatalDayClient}>();
  const cycleOwners=new WeakMap<object,{generation:Generation;client:CyclesClient}>();
  function revoke(value:Generation) {
    value.closed=true;value.memory.close();value.clients.close();
    if(value.initialClients!==value.clients)value.initialClients.close();
    value.abort.abort();
  }
  function run<T>(value:Generation,caller:AbortSignal|undefined,call:(signal:AbortSignal)=>Promise<T>):Promise<T> {
    if(closed || value.closed || caller?.aborted)return Promise.reject(createAbortError());
    const controller=new AbortController();
    return new Promise<T>((resolve,reject)=>{
      const cancel=()=>{controller.abort();finish();reject(createAbortError());};
      const finish=()=>{caller?.removeEventListener('abort',cancel);value.abort.signal.removeEventListener('abort',cancel);};
      caller?.addEventListener('abort',cancel,{once:true});value.abort.signal.addEventListener('abort',cancel,{once:true});
      let work:Promise<T>;try{work=call(controller.signal);}catch(error){finish();reject(error);return;}
      Promise.resolve(work).then(result=>{
        finish();if(controller.signal.aborted || value.closed)reject(createAbortError());else resolve(result);
      },error=>{finish();reject(error);});
      if(caller?.aborted || value.closed)cancel();
    });
  }
  function rememberNatal(day:NatalDay|null,value:Generation,client:NatalDayClient,signal?:AbortSignal) {
    if(value.closed || signal?.aborted)throw createAbortError();
    if(day && natalOwners.get(day)?.generation!==value)natalOwners.set(day,{generation:value,client});
    return day;
  }
  function rememberCycle<T extends object|null>(data:T,value:Generation,client:CyclesClient,signal?:AbortSignal):T {
    if(value.closed || signal?.aborted)throw createAbortError();
    if(data && cycleOwners.get(data)?.generation!==value)cycleOwners.set(data,{generation:value,client});return data;
  }

  // Each call captures both generation and client. Promoting RAM-only service
  // after durable cleanup never changes the port of an already running call.
  const natal:NatalDayClient={
    readStoredDay(input,options){const value=current,client=value.clients.natal;
      return run(value,options?.signal,signal=>client.readStoredDay(input,{signal,opened:options?.opened,observeOnly:options?.observeOnly})).then(day=>rememberNatal(day,value,client,options?.signal));},
    getDay(input,options){const value=current,client=value.clients.natal;
      return run(value,options?.signal,signal=>client.getDay(input,{signal})).then(day=>{rememberNatal(day,value,client,options?.signal);return day;});},
    readLocalDay(input,options){const value=current,client=value.clients.natal;
      return run(value,options?.signal,signal=>client.readLocalDay(input,{signal})).then(day=>rememberNatal(day,value,client,options?.signal));},
    peekDay(input){if(closed)return null;const value=current,client=value.clients.natal;return rememberNatal(client.peekDay(input),value,client);},
    retainDay(day){const owner=natalOwners.get(day);return owner && !owner.generation.closed?owner.client.retainDay(day):()=>{};},
    markDayUsed(input,day){const owner=natalOwners.get(day);if(owner && !owner.generation.closed)owner.client.markDayUsed(input,day);},
  };
  const cycles:CyclesClient={
    receiveFamily(input,owner,options){const value=current,client=value.clients.cycles;
      return run(value,options?.signal,signal=>client.receiveFamily(input,owner,{signal}));},
    readFamily(input,owner,options){const value=current,client=value.clients.cycles;
      return run(value,options?.signal,signal=>client.readFamily(input,owner,{signal,opened:options?.opened,observeOnly:options?.observeOnly}));},
    fetchFamily(input,owner,options){const value=current,client=value.clients.cycles;
      return run(value,options?.signal,signal=>client.fetchFamily(input,owner,{signal}));},
    preparedChartInputs(input,options){const value=current,client=value.clients.cycles;
      return run(value,options?.signal,signal=>client.preparedChartInputs(input,{signal}));},
    close(){current.clients.cycles.close();},
    syncPrepared(input,owner,signal){const value=current,client=value.clients.cycles;
      return run(value,signal,signal=>client.syncPrepared(input,owner,signal));},
    events(input,signal,options){const value=current,client=value.clients.cycles;
      return run(value,signal,signal=>client.events(input,signal,options)).then(data=>rememberCycle(data,value,client,signal));},
    readEvents(input,options){const value=current,client=value.clients.cycles;
      return run(value,options?.signal,signal=>client.readEvents(input,{signal,owner:options?.owner})).then(data=>rememberCycle(data,value,client,options?.signal));},
    chart(input,signal,options){const value=current,client=value.clients.cycles;
      return run(value,signal,signal=>client.chart(input,signal,options)).then(data=>rememberCycle(data,value,client,signal));},
    readChart(input,options){const value=current,client=value.clients.cycles;
      return run(value,options?.signal,signal=>client.readChart(input,{signal,owner:options?.owner,opened:options?.opened})).then(data=>rememberCycle(data,value,client,options?.signal));},
    retainChart(input,data){const owner=cycleOwners.get(data);return owner && !owner.generation.closed?owner.client.retainChart(input,data):()=>{};},
    retainEvents(input,data){const owner=cycleOwners.get(data);return owner && !owner.generation.closed?owner.client.retainEvents(input,data):()=>{};},
  };
  function cleanup(value:Generation):Promise<PersonalCalculationCleanup> {
    if(value.cleanup)return value.cleanup;
    if(value.result?.status==='cleared')return Promise.resolve(value.result);
    const work=cleanupTail.then(async():Promise<PersonalCalculationCleanup>=>{
      const result=await cache.clearPersonal();
      if(!result)return {status:'unavailable',generation:value.id};
      if(result.status==='pending')return {...result,generation:value.id};
      if(closed || value.closed || current!==value)return {...result,generation:value.id};
      const fresh=createCalculationCache(cacheOptions),snapshot=await fresh.status();
      if(snapshot.phase==='unavailable' || !('personalEpoch' in snapshot) || snapshot.personalEpoch!==result.epoch){
        fresh.close();return {status:'unavailable',generation:value.id,epoch:result.epoch};
      }
      if(closed || value.closed || current!==value){fresh.close();return {...result,generation:value.id};}
      // One successful promotion per generation. Existing RAM work keeps its original
      // port; both ports are revoked together on the next real logout or close.
      value.clients=clients(value.memory.port,fresh,true);
      return {...result,generation:value.id};
    }).catch(():PersonalCalculationCleanup=>({status:'unavailable',generation:value.id}));
    cleanupTail=work;
    value.cleanup=work.then(result=>{value.result=result;return result;}).finally(()=>{value.cleanup=null;});
    return value.cleanup;
  }
  return {
    transit,natal,cycles,memory,library,
    status:()=>cache.status(),
    evictForSpace:(kind:'natal'|'return-charts',keep:number,exclude?:string,isCurrent?:()=>boolean)=>current.clients.evictForSpace(kind,keep,exclude,isCurrent),
    syncTransitWindow,syncTodayTransitWindow,
    resetPersonal(){
      cacheOptions?.pressure?.invalidate();
      if(closed)return Promise.resolve({status:'unavailable' as const,generation:current.id});
      revoke(current);memory.clearExcept('transit-day:');current=generation(null);
      return cleanup(current);
    },
    retryPersonalCleanup(){
      if(current.id===0)return Promise.resolve(null); // No previous reset to retry.
      return closed?Promise.resolve({status:'unavailable' as const,generation:current.id}):cleanup(current);
    },
    async close(){if(closed)return;closed=true;revoke(current);memory.clearExcept('transit-day:');await days.close();cache.close();library.close();},
  };
}
