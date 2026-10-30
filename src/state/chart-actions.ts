import {isLibraryCatalogMarker} from '../../shared/library-catalog-contract.ts';
import type { AccountChart, ChartWriteIntent, ChartWriteOutcome } from '../../shared/chart-record-contract.ts';
import { chartOutcomeTarget } from '../../shared/chart-record-contract.ts';
import type { SavedChart } from '../../shared/chart-types.ts';
import type { ChartClient, ChartBirthInput, ChartReceipt, ChartReply, ChartPatchInput } from '../data/chart-client.ts';
import type { AccountLibrary, LibrarySession } from './account-library.ts';
import type { CheckpointResult } from './view-checkpoint.ts';
import { createRandomId, chartSaveSourceKey, type ChartSaveSource } from '../domain/chart-record.ts';
import { createAbortError, shareRequest, type SharedRequest } from '../runtime/shared-request.ts';

export type ChartActionResult =
  | {kind: 'unknown'; intent: ChartWriteIntent; error?: unknown}
  | {kind: 'settled'; receipt: ChartReceipt<ChartWriteOutcome>; chart: AccountChart | null; active: boolean; readError?: unknown};
export interface SaveSourceOptions {
  signal:AbortSignal;
  isCurrent:()=>boolean;
  intent?:ChartWriteIntent;
  onIntent?:(intent:ChartWriteIntent|null)=>void;
}
interface Options {
  client: Pick<ChartClient, 'create' | 'update' | 'remove' | 'addFromSource' | 'outcome'>;
  library: Pick<AccountLibrary,'open'|'forget'> & Partial<Pick<AccountLibrary,'prepareAcceptance'>>;
  getSession: () => LibrarySession | null;
  // Optional transport override. The default sends source input and the server
  // calculation receipt; browser activation numbers never cross this boundary.
  saveReady?: (input:ChartWriteIntent & {chart:SavedChart},signal?:AbortSignal)=>Promise<ChartReceipt<ChartWriteOutcome>>;
  newId?: () => string; initialPending?: readonly ChartWriteIntent[];
  prepareWrite?: (intent:ChartWriteIntent,session:LibrarySession,signal:AbortSignal)=>Promise<CheckpointResult>;
  onPending?: (pending: readonly ChartWriteIntent[]) => void;
}
type CreateInput = {name: string; note: string; birth: ChartBirthInput};
const failed = (code: string) => Object.assign(new Error(code), {code});
const birthRefusals = new Set(['invalid_request', 'invalid_utc', 'invalid_date', 'invalid_time',
  'unsupported_date', 'invalid_timezone', 'nonexistent_time', 'ambiguous_time', 'city_required']);
function refusedBeforeWrite(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const {status, code} = error as {status?: number; code?: unknown};
  if (typeof code !== 'string') return false;
  return status === undefined && (code === 'invalid_request' || code === 'account_changed')
    || status === 400 && code === 'invalid_request'
    || status === 422 && birthRefusals.has(code);
}

/** Writes are explicit once. Pending pointers contain no command or chart and permit only outcome reads. */
export function createChartActions({client, library, getSession, saveReady, newId = createRandomId, initialPending = [],
  prepareWrite, onPending = () => {}}: Options) {
  const pending = new Map<string, ChartWriteIntent>();
  const saveChecks=new Map<string,{intent:ChartWriteIntent;session:LibrarySession}>();
  const recoveries=new Map<string,SharedRequest<ChartActionResult,{live:()=>boolean}>>();
  let generation=0;
  let activeEffects=0;
  const idle=new Set<()=>void>();
  // Track actual effects, including settlement after the last consumer leaves.
  async function track<T>(work:()=>Promise<T>):Promise<T> {
    activeEffects++;
    try{return await work();}
    finally{if(--activeEffects===0){const waiting=[...idle];idle.clear();for(const complete of waiting)complete();}}
  }
  function whenIdle(signal?:AbortSignal):Promise<void> {
    if(signal?.aborted)return Promise.reject(createAbortError());
    if(!activeEffects)return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const complete=()=>{signal?.removeEventListener('abort',cancel);resolve();};
      const cancel=()=>{idle.delete(complete);signal?.removeEventListener('abort',cancel);reject(createAbortError());};
      idle.add(complete);signal?.addEventListener('abort',cancel,{once:true});
    });
  }
  // Only the open page associates a deletion with its recovery pointer. No
  // command payload, queued write or deletion tombstone is persisted here.
  const removals = new Map<string, {intent?: ChartWriteIntent; work?: Promise<ChartActionResult>}>();
  const key = (intent: ChartWriteIntent) => intent.expectedAccountId + ':' + intent.operationId;
  for (const intent of initialPending) pending.set(key(intent), {...intent});
  const publish = () => onPending([...pending.values()].map(value => ({...value})));
  function forget(intent: ChartWriteIntent) { if (pending.delete(key(intent))) publish(); }
  function same(seen: LibrarySession) {
    const current = getSession(); return current?.accountId === seen.accountId && current.sessionId === seen.sessionId;
  }
  function access() { const current = getSession(); if (!current) throw failed('auth_required'); return {...current}; }
  const prepareAcceptance=()=>library.prepareAcceptance?.()??((id:string)=>library.open(id));
  async function applyObservation(reply:ChartReply<ChartWriteOutcome>,accept:ReturnType<typeof prepareAcceptance>):Promise<AccountChart|null> {
    const {outcome,catalogMarker}=reply;
    if(reply.chart)return accept(reply.chart.id,reply.chart,catalogMarker);
    const absent=outcome.kind==='deleted' || outcome.kind==='absent' || outcome.kind==='rejected' && outcome.code==='not_found';
    if(absent && isLibraryCatalogMarker(catalogMarker)){
      try{await library.forget(outcome.chartId,catalogMarker,outcome.kind==='deleted'?'deleted':'absence');return null;}
      catch(error){if((error as {code?:string}).code!=='library_changed')throw error;}
    }
    if(!absent && !chartOutcomeTarget(outcome))return null;
    try{return await accept(outcome.chartId);}
    catch(error){if(absent && (error as {code?:string}).code==='not_found'
      && isLibraryCatalogMarker((error as {details?:{catalogMarker?:unknown}}).details?.catalogMarker))return null;throw error;}
  }
  async function settle(reply: ChartReply<ChartWriteOutcome>, seen: LibrarySession, live:()=>boolean,
    accept:ReturnType<typeof prepareAcceptance>,acceptCurrent:()=>boolean): Promise<ChartActionResult> {
    const receipt={operationId:reply.operationId,expectedAccountId:reply.expectedAccountId,outcome:reply.outcome};
    forget(receipt);
    // Leaving a screen revokes navigation, not an already committed record.
    // Account/owner retirement independently revokes library acceptance.
    if (!same(seen) || !acceptCurrent()) return {kind: 'settled', receipt, chart: null, active: false};
    let chart: AccountChart | null = null, readError: unknown;
    try {
      chart=await applyObservation(reply,accept);
    } catch (error) { readError = error; }
    const active = same(seen) && live();
    return {kind: 'settled', receipt, chart: active ? chart : null, active, ...(!active || readError === undefined ? {} : {readError})};
  }
  function write(send: (intent: ChartWriteIntent) => Promise<ChartReceipt<ChartWriteOutcome>>, signal = new AbortController().signal, isCurrent:()=>boolean=()=>true, onIntent?:(intent:ChartWriteIntent|null,session:LibrarySession)=>void): Promise<ChartActionResult> {
    return track(async()=>{
      signal.throwIfAborted();
      const ownedGeneration=generation;
      const seen = access(), intent = {operationId: newId(), expectedAccountId: seen.accountId};
      const live=()=>ownedGeneration===generation && !signal.aborted && isCurrent();
      pending.set(key(intent), intent);
      try {
        onIntent?.(intent,seen);
        // Preparation owns the new pointer's persistence. Other changes publish
        // below; a standalone owner without a checkpoint has only its RAM pointer.
        const checkpoint=prepareWrite?await prepareWrite(intent,seen,signal):(publish(),{kind:'memory-only' as const});
        signal.throwIfAborted();
        if(!same(seen) || !live())throw failed('account_changed');
        if(checkpoint.kind==='failed')throw Object.assign(failed('checkpoint_failed'),{cause:checkpoint.cause});
      }catch(error){
        // Nothing reached the server: this pointer must never become outcome recovery.
        forget(intent);onIntent?.(null,seen);throw error;
      }
      const accept=prepareAcceptance();
      let receipt: ChartReply<ChartWriteOutcome>;
      try { receipt = await send(intent); }
      catch (error) {
        // A gateway/server failure can arrive after commit. Only a typed refusal
        // known to precede the write makes the recovery pointer unnecessary.
        if (refusedBeforeWrite(error)) {
          forget(intent); throw same(seen) && live() ? error : failed('account_changed');
        }
        return {kind: 'unknown', intent, ...(same(seen) && live() ? {error} : {})};
      }
      return settle(receipt, seen,live,accept,()=>ownedGeneration===generation);
    });
  }
  async function recover(intent: ChartWriteIntent, signal?: AbortSignal,isCurrent:()=>boolean=()=>true): Promise<ChartActionResult> {
    signal?.throwIfAborted();
    const seen = access();
    if (intent.expectedAccountId !== seen.accountId) throw failed('account_changed');
    const ownedGeneration=generation;
    const live=()=>ownedGeneration===generation && !signal?.aborted && isCurrent();
    const recoveryKey=ownedGeneration+':'+seen.sessionId+':'+key(intent);
    const result=await shareRequest(recoveries,recoveryKey,request=>track(async():Promise<ChartActionResult>=>{
      const accept=prepareAcceptance();
      const receipt = await client.outcome(intent, request.controller.signal);
      if (receipt.outcome.kind === 'unknown') return {kind: 'unknown', intent: {...intent}};
      return settle({...receipt, outcome: receipt.outcome}, seen,
        ()=>!request.controller.signal.aborted && [...request.consumers].some(consumer=>consumer.live()),accept,()=>ownedGeneration===generation);
    }),{signal,consumer:{live}});
    if(result.kind==='settled' && (!same(seen) || !live())) {
      const {readError: _error,...settled}=result;
      return {...settled,chart:null,active:false};
    }
    return result;
  }
  function removalKey(chartId: string) { return getSession()?.accountId + ':' + chartId; }
  function remove(chartId: string, signal?: AbortSignal): Promise<ChartActionResult> {
    signal?.throwIfAborted();
    const seen = access(), id = removalKey(chartId);
    let entry = removals.get(id);
    if (entry?.work) return entry.work;
    if (!entry) { entry = {}; removals.set(id, entry); }
    const owned = entry;
    const work = (async () => {
      let result: ChartActionResult;
      try { result = owned.intent ? await recover(owned.intent, signal)
        : await write(intent => client.remove({...intent, chartId}, signal), signal); }
      catch (error) {
        if (!owned.intent) throw error;
        result = {kind: 'unknown', intent: owned.intent, ...(same(seen) ? {error} : {})};
      }
      if (removals.get(id) === owned) {
        if (result.kind === 'unknown') owned.intent = result.intent;
        else if (result.kind === 'settled' && result.receipt.outcome.kind !== 'rejected') {
          owned.intent = {operationId: result.receipt.operationId, expectedAccountId: result.receipt.expectedAccountId};
        } else removals.delete(id);
      }
      return result;
    })();
    owned.work = work;
    void work.finally(() => {
      if (removals.get(id) !== owned) return;
      owned.work = undefined;
      if (!owned.intent) removals.delete(id);
    }).catch(() => {});
    return work;
  }
  async function saveSource(source:ChartSaveSource,{signal,isCurrent,intent:restored,onIntent}:SaveSourceOptions):Promise<ChartActionResult> {
    signal.throwIfAborted();
    const seen=access(),sourceKey=chartSaveSourceKey(source),previous=saveChecks.get(sourceKey);
    let intent=restored??(previous && same(previous.session)?previous.intent:undefined);
    if(intent && intent.expectedAccountId!==seen.accountId)throw failed('account_changed');
    const remember=(value:ChartWriteIntent|null,session:LibrarySession)=>{
      if(value){intent=value;saveChecks.set(sourceKey,{intent:value,session});onIntent?.(value);}
      else if(saveChecks.get(sourceKey)?.intent===intent){saveChecks.delete(sourceKey);onIntent?.(null);intent=undefined;}
    };
    try {
      const result=intent?await recover(intent,signal,isCurrent)
        :await write(value=>sendSource(source,value,signal),signal,isCurrent,remember);
      if(result.kind==='settled' && result.active && (result.chart || result.receipt.outcome.kind==='rejected')) {
        const owned=saveChecks.get(sourceKey)?.intent;
        if(owned?.operationId===result.receipt.operationId && owned.expectedAccountId===result.receipt.expectedAccountId)saveChecks.delete(sourceKey);
      }
      return result;
    }catch(error){
      if(refusedBeforeWrite(error) && intent && saveChecks.get(sourceKey)?.intent===intent){
        saveChecks.delete(sourceKey);onIntent?.(null);
      }
      throw error;
    }
  }
  function sendSource(source:ChartSaveSource,intent:ChartWriteIntent,signal:AbortSignal) {
    if(source.kind==='shared')return client.addFromSource({...intent,sourceId:source.chart.id,seenRevision:source.chart.revision},signal);
    const chart=source.chart;
    if(chart.source!=='transit' && chart.source!=='calculated')throw failed('invalid_request');
    if(saveReady)return saveReady({...intent,chart},signal);
    const birth:ChartBirthInput=chart.source==='transit'?{source:'transit',utc:chart.utc!}
      :{source:'calculated',date:chart.birthDate,time:chart.birthTime,cityId:String(chart.cityId??chart.city?.id??''),
        ...(chart.fold===0 || chart.fold===1?{fold:chart.fold}:{})};
    return client.create({...intent,name:chart.name,note:chart.note,birth,
      ...(chart.calculationReceipt?{calculationReceipt:chart.calculationReceipt}:{})},signal);
  }
  return {
    whenIdle,
    isCheckingRemoval(chartId: string) { return Boolean(removals.get(removalKey(chartId))?.intent); },
    get pending(): readonly ChartWriteIntent[] { return [...pending.values()].map(value => ({...value})); },
    clear() {
      generation++;
      for(const request of recoveries.values())request.controller.abort();
      recoveries.clear();removals.clear();saveChecks.clear();pending.clear();publish();
    },
    saveSource,
    create(input: CreateInput, signal?:AbortSignal):Promise<ChartActionResult> {
      return write(intent=>client.create({...intent,...input},signal),signal);
    },
    update(input: Omit<ChartPatchInput, keyof ChartWriteIntent>, signal?: AbortSignal) {
      return write(intent => client.update({...intent, ...input}, signal), signal);
    },
    remove,
    addFromSource(sourceId: string, seenRevision: number, signal?: AbortSignal) {
      return write(intent => client.addFromSource({...intent, sourceId, seenRevision}, signal), signal);
    },
    recover,
  };
}
export type ChartActions = ReturnType<typeof createChartActions>;
