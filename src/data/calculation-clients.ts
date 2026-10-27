import { createCalculationCache, type CalculationCache } from './calculation-cache.ts';
import { createMemoryCache, type MemoryCache } from './memory-cache.ts';
import { createBinaryCache } from './binary-cache.ts';
import { createReturnStorage } from './return-storage.ts';
import { createTransitDayCache } from './transit-day-cache.ts';
import { createTransitDayClient } from './transit-day-client.ts';
import { createNatalDayClient, type NatalDayClient } from './natal-day-client.ts';
import { createCyclesClient, type CyclesClient } from './cycles-client.ts';
import { createAbortError } from './shared-request.ts';
import type { NatalDay } from '../../shared/day-packets/natal-format.ts';

type Options = {
  cacheOptions?: Parameters<typeof createCalculationCache>[0];
  memory?: MemoryCache;
  transit?: Omit<NonNullable<Parameters<typeof createTransitDayClient>[0]>, 'memory'|'days'>;
  natal?: Omit<NonNullable<Parameters<typeof createNatalDayClient>[0]>, 'memory'|'persistentCache'>;
  cycles?: Omit<NonNullable<Parameters<typeof createCyclesClient>[0]>, 'memory'|'returnStorage'>;
};
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
    put<T>(key:PropertyKey,value:T,size?:number){return open?memory.put(key,value,size):value;},
    delete(key:PropertyKey){if(open)memory.delete(key);},
    retain<T>(key:PropertyKey,value:T,size?:number){return open?memory.retain(key,value,size):()=>{};},
    clearExcept(prefix:string){if(open)memory.clearExcept(prefix);},
    get bytes(){return open?memory.bytes:0;},get size(){return open?memory.size:0;},
  };
  return {port,close(){open=false;}};
}

/** One early composition owner; versions and current transit dates are confirmed externally. */
export function createCalculationClients({cacheOptions,memory=createMemoryCache(),transit:transitOptions,
  natal:natalOptions,cycles:cyclesOptions}:Options={}) {
  const cache=createCalculationCache(cacheOptions);
  const days=createTransitDayCache({cache,memory});
  const transit=createTransitDayClient({...transitOptions,days,memory});
  let closed=false,nextGeneration=0,cleanupTail:Promise<unknown>=Promise.resolve();

  function clients(port:MemoryCache,persistent:CalculationCache|null,ownsCache=false) {
    const binary=persistent?createBinaryCache({cache:persistent}):null;
    const returns=persistent?createReturnStorage({cache:persistent}):null;
    const cycles=createCyclesClient({...cyclesOptions,memory:port,returnStorage:returns});
    return {
      natal:createNatalDayClient({...natalOptions,memory:port,persistentCache:binary}),
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
    getDay(input,options){const value=current,client=value.clients.natal;
      return run(value,options?.signal,signal=>client.getDay(input,{signal})).then(day=>{rememberNatal(day,value,client,options?.signal);return day;});},
    readDay(input,options){const value=current,client=value.clients.natal;
      return run(value,options?.signal,signal=>client.readDay(input,{signal})).then(day=>rememberNatal(day,value,client,options?.signal));},
    peekDay(input){if(closed)return null;const value=current,client=value.clients.natal;return rememberNatal(client.peekDay(input),value,client);},
    retainDay(day){const owner=natalOwners.get(day);return owner && !owner.generation.closed?owner.client.retainDay(day):()=>{};},
  };
  const cycles:CyclesClient={
    close(){current.clients.cycles.close();},
    syncPrepared(input,owner,signal){const value=current,client=value.clients.cycles;
      return run(value,signal,signal=>client.syncPrepared(input,owner,signal));},
    events(input,signal,options){const value=current,client=value.clients.cycles;
      return run(value,signal,signal=>client.events(input,signal,options)).then(data=>rememberCycle(data,value,client,signal));},
    chart(input,signal,options){const value=current,client=value.clients.cycles;
      return run(value,signal,signal=>client.chart(input,signal,options)).then(data=>rememberCycle(data,value,client,signal));},
    readChart(input,options){const value=current,client=value.clients.cycles;
      return run(value,options?.signal,signal=>client.readChart(input,{signal})).then(data=>rememberCycle(data,value,client,options?.signal));},
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
    transit,natal,cycles,memory,
    status:()=>cache.status(),
    evictForSpace:(kind:'natal'|'return-charts',keep:number,exclude?:string,isCurrent?:()=>boolean)=>current.clients.evictForSpace(kind,keep,exclude,isCurrent),
    confirmVersions:cache.confirmVersions,
    setTransitWindow:cache.setTransitWindow,
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
    async close(){if(closed)return;closed=true;revoke(current);memory.clearExcept('transit-day:');await days.close();cache.close();},
  };
}
