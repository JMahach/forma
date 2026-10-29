import type { AccountChart, PublicAccountChart, ChartWriteIntent, ChartWriteOutcome } from '../../shared/chart-record-contract.ts';
import type { CalculationRequest, SavedChart } from '../../shared/chart-types.ts';
import type { ChartClient, ChartBirthInput, ChartReceipt, ChartPatchInput } from '../data/chart-client.ts';
import type { ChartCalculation } from '../domain/chart-record.ts';
import type { LibrarySession } from './account-library.ts';
import { createChartId } from '../domain/chart-record.ts';
import { shareRequest, type SharedRequest } from '../runtime/shared-request.ts';

export type ChartActionResult =
  | {kind: 'temporary'; chart: SavedChart}
  | {kind: 'unknown'; intent: ChartWriteIntent; error?: unknown}
  | {kind: 'settled'; receipt: ChartReceipt<ChartWriteOutcome>; chart: AccountChart | null; active: boolean; readError?: unknown};
export type ChartSaveSource = {kind:'temporary';chart:SavedChart} | {kind:'shared';chart:Pick<PublicAccountChart,'id'|'revision'> & Partial<SavedChart>};
export type ChartSaveResult = ChartActionResult | {kind:'sign-in'|'inactive'};
export interface ChartSaveAction {
  readonly waitingForLogin:boolean;
  run(signal?:AbortSignal):Promise<ChartSaveResult>;
  cancel():void;
}
interface Options {
  client: Pick<ChartClient, 'create' | 'update' | 'remove' | 'addFromSource' | 'outcome'>;
  library: {open(id: string): Promise<AccountChart>; forget(id: string): Promise<void>};
  getSession: () => LibrarySession | null;
  calculate(input: CalculationRequest, signal: AbortSignal): Promise<ChartCalculation>;
  // Optional transport override. The default sends source input and the server
  // calculation receipt; browser activation numbers never cross this boundary.
  saveReady?: (input:ChartWriteIntent & {chart:SavedChart},signal?:AbortSignal)=>Promise<ChartReceipt<ChartWriteOutcome>>;
  newId?: () => string; initialPending?: readonly ChartWriteIntent[];
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
export function createChartActions({client, library, getSession, calculate, saveReady, newId = createChartId, initialPending = [], onPending = () => {}}: Options) {
  const pending = new Map<string, ChartWriteIntent>();
  const saveChecks=new Map<string,{intent:ChartWriteIntent;session:LibrarySession}>();
  const recoveries=new Map<string,SharedRequest<ChartActionResult,{live:()=>boolean}>>();
  let generation=0,saving:{key:string;live:()=>boolean;action:ChartSaveAction}|null=null;
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
  async function settle(receipt: ChartReceipt<ChartWriteOutcome>, seen: LibrarySession, live:()=>boolean=()=>true): Promise<ChartActionResult> {
    forget(receipt);
    if (!same(seen) || !live()) return {kind: 'settled', receipt, chart: null, active: false};
    let chart: AccountChart | null = null, readError: unknown;
    try {
      if (receipt.outcome.kind === 'deleted' || receipt.outcome.kind === 'absent') await library.forget(receipt.outcome.chartId);
      else if (receipt.outcome.kind !== 'rejected' || receipt.outcome.code === 'note_conflict' || receipt.outcome.code === 'duplicate_chart') {
        chart = await library.open(receipt.outcome.chartId);
      }
    } catch (error) { readError = error; }
    const active = same(seen) && live();
    return {kind: 'settled', receipt, chart: active ? chart : null, active, ...(!active || readError === undefined ? {} : {readError})};
  }
  async function write(send: (intent: ChartWriteIntent) => Promise<ChartReceipt<ChartWriteOutcome>>, signal?: AbortSignal, isCurrent:()=>boolean=()=>true, onIntent?:(intent:ChartWriteIntent,session:LibrarySession)=>void): Promise<ChartActionResult> {
    signal?.throwIfAborted();
    const ownedGeneration=generation;
    const seen = access(), intent = {operationId: newId(), expectedAccountId: seen.accountId};
    const live=()=>ownedGeneration===generation && !signal?.aborted && isCurrent();
    pending.set(key(intent), intent); onIntent?.(intent,seen); publish();
    let receipt: ChartReceipt<ChartWriteOutcome>;
    try { receipt = await send(intent); }
    catch (error) {
      // A gateway/server failure can arrive after commit. Only a typed refusal
      // known to precede the write makes the recovery pointer unnecessary.
      if (refusedBeforeWrite(error)) {
        forget(intent); throw same(seen) && live() ? error : failed('account_changed');
      }
      return {kind: 'unknown', intent, ...(same(seen) && live() ? {error} : {})};
    }
    return settle(receipt, seen,live);
  }
  async function recover(intent: ChartWriteIntent, signal?: AbortSignal,isCurrent:()=>boolean=()=>true): Promise<ChartActionResult> {
    signal?.throwIfAborted();
    const seen = access();
    if (intent.expectedAccountId !== seen.accountId) throw failed('account_changed');
    const ownedGeneration=generation;
    const live=()=>ownedGeneration===generation && !signal?.aborted && isCurrent();
    const recoveryKey=ownedGeneration+':'+seen.sessionId+':'+key(intent);
    const result=await shareRequest(recoveries,recoveryKey,async (request):Promise<ChartActionResult>=>{
      const receipt = await client.outcome(intent, request.controller.signal);
      if (receipt.outcome.kind === 'unknown') return {kind: 'unknown', intent: {...intent}};
      return settle({...receipt, outcome: receipt.outcome}, seen,
        ()=>!request.controller.signal.aborted && [...request.consumers].some(consumer=>consumer.live()));
    },{signal,consumer:{live}});
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
  function selectionKey(source:ChartSaveSource) {
    const chart=source.chart;
    return JSON.stringify([source.kind,chart.id,chart.name,chart.source,chart.utc,chart.timezone,
      chart.birthDate,chart.birthTime,chart.cityId,chart.fold,'calculationVersion' in chart?chart.calculationVersion:null,
      source.kind==='shared'?source.chart.revision:source.chart.note]);
  }
  // One explicit page-local action. Only its recovery pointer is persisted;
  // closing login, navigation and source replacement cancel this continuation.
  function prepareSave(source:ChartSaveSource,isCurrent:()=>boolean=()=>true,
    recovery:{intent?:ChartWriteIntent;onIntent?:(intent:ChartWriteIntent|null)=>void}={}):ChartSaveAction {
    const selectedKey=selectionKey(source);
    if(saving?.key===selectedKey && saving.live())return saving.action;
    saving?.action.cancel();
    const ownedGeneration=generation,controller=new AbortController();
    let seen=getSession(),cancelled=false,waiting=false,external:AbortSignal|undefined;
    seen=seen?{...seen}:null;
    let work:Promise<ChartSaveResult>|null=null,intent:ChartWriteIntent|null=recovery.intent?{operationId:recovery.intent.operationId,expectedAccountId:recovery.intent.expectedAccountId}:null,completed:ChartActionResult|null=null;
    const live=()=>{
      try{return !cancelled && ownedGeneration===generation && selectionKey(source)===selectedKey
        && isCurrent() && (!seen || same(seen));}catch{return false;}
    };
    function cancel(){cancelled=true;waiting=false;controller.abort();external?.removeEventListener('abort',cancel);if(saving?.action===action)saving=null;}
    const action:ChartSaveAction={
      get waitingForLogin(){return waiting && live();},cancel,
      run(signal){
        if(signal?.aborted)cancel();
        if(!live()){cancel();return Promise.resolve({kind:'inactive'});}
        if(!external && signal){external=signal;external.addEventListener('abort',cancel,{once:true});}
        if(work)return work;
        if(completed)return Promise.resolve(completed);
        const current=getSession();
        if(!current){waiting=true;return Promise.resolve({kind:'sign-in'});}
        seen??={...current};waiting=false;
        if(intent && intent.expectedAccountId!==current.accountId){cancel();return Promise.resolve({kind:'inactive'});}
        const previous=saveChecks.get(selectedKey);
        if(!intent && previous && same(previous.session))intent=previous.intent;
        const remember=(value:ChartWriteIntent,session:LibrarySession)=>{intent=value;saveChecks.set(selectedKey,{intent:value,session});recovery.onIntent?.(value);};
        work=(async()=>{
          let result:ChartActionResult;
          if(intent)result=await recover(intent,controller.signal,live);
          else if(source.kind==='shared')result=await write(value=>client.addFromSource({...value,
            sourceId:source.chart.id,seenRevision:source.chart.revision},controller.signal),controller.signal,live,remember);
          else {
            const chart=source.chart;
            const birth:ChartBirthInput=chart.source==='transit'?{source:'transit',utc:chart.utc!}
              :{source:'calculated',date:chart.birthDate,time:chart.birthTime,cityId:String(chart.cityId??chart.city?.id??''),
                ...(chart.fold===0 || chart.fold===1?{fold:chart.fold}:{})};
            if(chart.source!=='transit' && chart.source!=='calculated')throw failed('invalid_request');
            result=await write(value=>saveReady?saveReady({...value,chart},controller.signal)
              :client.create({...value,name:chart.name,note:chart.note,birth,
                ...(chart.calculationReceipt?{calculationReceipt:chart.calculationReceipt}:{})},controller.signal),controller.signal,live,remember);
          }
          if(result.kind==='settled' && result.active && (result.chart || result.receipt.outcome.kind==='rejected')) {
            const previous=saveChecks.get(selectedKey);
            if(previous?.intent.operationId===result.receipt.operationId && previous.intent.expectedAccountId===result.receipt.expectedAccountId)saveChecks.delete(selectedKey);
          }
          if(result.kind==='unknown')intent=result.intent;
          else if(result.kind==='settled' && result.active && !result.chart && result.receipt.outcome.kind!=='rejected')
            intent={operationId:result.receipt.operationId,expectedAccountId:result.receipt.expectedAccountId};
          else {completed=result;external?.removeEventListener('abort',cancel);}
          return result;
        })().catch(error=>{
          if(refusedBeforeWrite(error) && intent){
            const previous=saveChecks.get(selectedKey);
            if(previous?.intent.operationId===intent.operationId && previous.intent.expectedAccountId===intent.expectedAccountId)saveChecks.delete(selectedKey);
            intent=null;recovery.onIntent?.(null);
          }
          throw error;
        }).finally(()=>{work=null;});
        return work;
      },
    };
    saving={key:selectedKey,live,action};return action;
  }
  return {
    isCheckingRemoval(chartId: string) { return Boolean(removals.get(removalKey(chartId))?.intent); },
    get pending(): readonly ChartWriteIntent[] { return [...pending.values()].map(value => ({...value})); },
    clear() {
      saving?.action.cancel();saving=null;generation++;
      for(const request of recoveries.values())request.controller.abort();
      recoveries.clear();removals.clear();saveChecks.clear();pending.clear();publish();
    },
    prepareSave,
    async create(input: CreateInput, signal = new AbortController().signal): Promise<ChartActionResult> {
      signal.throwIfAborted();
      if (getSession()) return write(intent => client.create({...intent, ...input}, signal), signal);
      const birth = input.birth;
      const request: CalculationRequest = birth.source === 'transit' ? {mode: 'transit', utc: birth.utc}
        : {mode: 'natal', name: input.name, date: birth.date, time: birth.time, cityId: String(birth.cityId),
          ...(birth.cityName === undefined ? {} : {cityName: birth.cityName}),
          ...(birth.fold === undefined ? {} : {fold: birth.fold})};
      const chart = await calculate(request, signal);
      signal.throwIfAborted();
      const now = new Date().toISOString();
      return {kind: 'temporary', chart: {...chart, id: newId(), name: input.name, note: input.note, createdAt: now, updatedAt: now}};
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
