import { createCalculationFailureReporter, type CalculationFailureReport } from './calculation-failure.ts';
import type { CycleInput, CycleResult, CycleEventsResult, CycleChartResult } from '../../shared/cycles-format.ts';
import type { ComputeQueue } from '../runtime/compute-queue.ts';
import type { JsonWorkerOptions } from '../runtime/json-worker.ts';
import type { SharedJob } from '../runtime/job-consumers.ts';

type CycleAction = 'events' | 'chart';
export interface CycleRequest extends CycleInput { action: CycleAction }
interface CycleWork extends SharedJob<CycleResult> {
  key: string;
  priority:number;
  controller: AbortController;
  started: boolean;
  resolve: (value: CycleResult) => void;
  reject: (reason: unknown) => void;
  work: Promise<void> | null;
}
interface GenerateCycleOptions {
  report?: CalculationFailureReport;
  root: string;
  input: CycleRequest;
  spawnWorker?: JsonWorkerOptions['spawnWorker'];
  computeQueue?: ComputeQueue;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
interface CycleOptions {
  report?: CalculationFailureReport;
  root?: string;
  computeQueue?: ComputeQueue;
  generate?: (input: CycleRequest, options: { signal?: AbortSignal }) => Promise<unknown>;
  limits?: Partial<Record<keyof typeof CYCLE_LIMITS, number>>;
}
export type Cycles = ReturnType<typeof createCycles>;

import { SUPPORTED_START, SUPPORTED_END_EXCLUSIVE, LIFE_SPAN_YEARS } from '../../shared/date-limits.ts';
import { createComputeQueue } from '../runtime/compute-queue.ts';
import { consumeJob } from '../runtime/job-consumers.ts';
import { runJsonWorker } from '../runtime/json-worker.ts';
import { cycleUtcMilliseconds as parseCycleUtc, validCycleResult } from '../../shared/cycles-format.ts';
import {RETURN_FAMILIES} from '../../shared/library-package-contract.ts';

export const CYCLE_BODIES:readonly string[] = RETURN_FAMILIES;
export const CYCLE_LIMITS = Object.freeze({ concurrency: 2, maxQueued: 12 });
const YEAR_MS = 365.2425 * 86400000;

export class CycleError extends Error {
  declare code: string;
  declare status: number;
  declare retryAfter: number | null;
  declare details: Record<string, unknown>;

  constructor(code: string, message: string, status = 503, retryAfter: number | null = 3, details: Record<string, unknown> = {}) {
    super(message); this.code = code; this.status = status; this.retryAfter = retryAfter; this.details = details;
  }
}
const invalid = (code: string, message: string) => new CycleError(code, message, 422, null);
export function cycleUtcMilliseconds(value: unknown) {
  const milliseconds = parseCycleUtc(value);
  if (!Number.isFinite(milliseconds)) throw invalid('invalid_datetime', 'Нужен корректный точный момент UTC с датой и временем.');
  if (milliseconds < SUPPORTED_START || milliseconds >= SUPPORTED_END_EXCLUSIVE) throw invalid('unsupported_date', 'Доступны даты с 1801 по 2399 год.');
  return milliseconds;
}

export function validateCycleRequest(value: unknown, action: string): CycleRequest {
  const input = value as CycleInput | null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CycleError('invalid_request', 'Некорректные данные циклов.', 400, null);
  const birth = cycleUtcMilliseconds(input.birthUtc);
  if (!CYCLE_BODIES.includes(input.body)) throw invalid('invalid_body', 'Неизвестный вид возврата.');
  const result = { birthUtc: input.birthUtc, body: input.body };
  if (action === 'events') {
    const fromAge = input.fromAge ?? 0, toAge = input.toAge ?? LIFE_SPAN_YEARS;
    if (![fromAge, toAge].every(value => typeof value === 'number' && Number.isFinite(value)) || fromAge < 0 || fromAge >= toAge || toAge > 300 || toAge - fromAge > 120) throw invalid('invalid_range', 'Выберите возраст от 0 до 300 лет, не больше 120 лет за один запрос.');
    if (birth + toAge * YEAR_MS >= SUPPORTED_END_EXCLUSIVE) throw invalid('unsupported_date', 'Диапазон возвратов выходит за доступные эфемериды: до конца 2399 года.');
    return { ...result, action, fromAge, toAge };
  }
  if (action === 'chart') {
    const event = cycleUtcMilliseconds(input.eventUtc), age = (event - birth) / YEAR_MS;
    if (age <= 0 || age > 300) throw invalid('invalid_event', 'Момент возврата должен быть после рождения в пределах 300 лет.');
    const timezone = input.timezone ?? 'UTC';
    if (typeof timezone !== 'string' || !timezone || timezone.length > 160 || !/^[A-Za-z0-9_+\-/]+$/.test(timezone)) throw invalid('invalid_timezone', 'Неизвестный часовой пояс.');
    return { ...result, action, eventUtc: input.eventUtc, timezone };
  }
  throw new CycleError('invalid_request', 'Неизвестный режим циклов.', 400, null);
}

function validateResult(value: unknown, input: CycleRequest, onInvalidResult: () => void): CycleResult {
  const result = value as { error?: string; message?: string; body?: string; events?: unknown[] } | null;
  const unavailable = () => { onInvalidResult(); return new CycleError('cycles_unavailable', 'Не удалось подготовить циклы. Повторите попытку.'); };
  if (!result || typeof result !== 'object') throw unavailable();
  if (result.error) {
    if (result.error === 'return_index_unavailable') throw new CycleError(result.error, result.message!);
    const known = ['invalid_datetime', 'unsupported_date', 'invalid_body', 'invalid_range', 'invalid_event', 'invalid_timezone', 'ephemeris_unavailable'].includes(result.error);
    throw known ? new CycleError(result.error, result.message!, 422, null, result.body === input.body ? { body: result.body } : {}) : unavailable();
  }
  if (input.action === 'events' && (result.events?.length ?? 0) > 2000) throw unavailable();
  if (!validCycleResult(input.action, result, input)) throw unavailable();
  return result;
}

// Worker transport returns parsed JSON; the service owns validation and error mapping
// for both this worker and injected generators, before any result reaches consumers.
export function generateCycles({ root, input, spawnWorker, computeQueue, signal, report, timeoutMs = 45_000, maxOutputBytes = 2_000_000 }: GenerateCycleOptions) {
  const request = validateCycleRequest(input, input.action);
  return runJsonWorker({ onFailure: createCalculationFailureReporter('cycles', report), root, script: 'cycles.py', input: request, spawnWorker, computeQueue, signal, timeoutMs, maxOutput: maxOutputBytes,
    unavailable: () => new CycleError('cycles_unavailable', 'Локальный движок циклов недоступен. Повторите попытку.'),
    timeoutError: () => new CycleError('cycles_timeout', 'Циклы не успели рассчитаться. Попробуйте меньший диапазон.') });
}

// Unfinished calculations have one owner. Completed results belong to their consumers.
const abortedCycle=()=>new DOMException('Запрос отменён.','AbortError');
const stoppedCycles=()=>new CycleError('cycles_unavailable','Расчёт циклов остановлен.');
class CycleOwner {
  private pending=new Map<string,CycleWork>();
  private jobs=new Set<CycleWork>();
  private queue:ComputeQueue;
  private ownQueue:boolean;
  private generate:NonNullable<CycleOptions['generate']>;
  private failure:ReturnType<typeof createCalculationFailureReporter>;
  private accepting=true;
  private closing:Promise<void>|null=null;
  constructor({root,computeQueue,report,generate=(input,options)=>generateCycles({root:root!,input,report,...options}),limits={}}:CycleOptions) {
    const {concurrency,maxQueued}={...CYCLE_LIMITS,...limits};
    this.queue=computeQueue||createComputeQueue({concurrency,maxQueued});this.ownQueue=!computeQueue;
    this.generate=generate;this.failure=createCalculationFailureReporter('cycles',report);
  }
  private consume(job:CycleWork,signal?:AbortSignal,background=false) {
    const result=consumeJob(job,signal,abandoned=>{
      if(this.pending.get(abandoned.key)===abandoned)this.pending.delete(abandoned.key);
      abandoned.controller.abort();
    });
    // Background cancellation settles the physical worker before another part starts.
    // A live HTTP consumer still leaves immediately without cancelling other consumers.
    return background?result.catch(async error=>{if(signal?.aborted)await job.work;throw error;}):result;
  }
  private launch(request:CycleRequest,job:CycleWork) {
    job.work=this.queue.run(async()=>{
      job.started=true;
      const value=await this.generate(request,{signal:job.controller.signal});
      if(job.controller.signal.aborted)throw abortedCycle();
      return validateResult(value,request,()=>this.failure('invalid_result'));
    },{signal:job.controller.signal,priority:()=>job.priority}).finally(()=>{
      if(this.pending.get(job.key)===job)this.pending.delete(job.key);
      this.jobs.delete(job);
    }).then(job.resolve,error=>{
      job.reject(!this.accepting && !job.started?stoppedCycles():error.code==='busy'
        ?new CycleError('cycles_busy','Подождите завершения расчёта циклов и повторите попытку.'):error);
    });
  }
  get(input:CycleInput,action:CycleAction,signal?:AbortSignal,priority=action==='chart'?1:0):Promise<CycleResult> {
    if(signal?.aborted)return Promise.reject(abortedCycle());
    if(!this.accepting)return Promise.reject(stoppedCycles());
    let request;
    try {request=validateCycleRequest(input,action);}catch(error){return Promise.reject(error);}
    const key=JSON.stringify(request),existing=this.pending.get(key);
    if(existing){existing.priority=Math.max(existing.priority,priority);return this.consume(existing,signal,priority<0);}
    let resolve!:(value:CycleResult)=>void,reject!:(reason:unknown)=>void;
    const promise=new Promise<CycleResult>((yes,no)=>{resolve=yes;reject=no;});
    const job:CycleWork={key,priority,controller:new AbortController(),started:false,resolve,reject,promise,work:null};
    this.pending.set(key,job);this.jobs.add(job);
    const result=this.consume(job,signal,priority<0);this.launch(request,job);return result;
  }
  close() {
    if(this.closing)return this.closing;
    this.accepting=false;
    for(const job of this.jobs)if(!job.started)job.controller.abort();
    // Live workers finish or hit their existing timeout; the server's shared queue is not owned here.
    this.closing=Promise.allSettled([...this.jobs].map(job=>job.work)).then(()=>{if(this.ownQueue)this.queue.close();});
    return this.closing;
  }
  get queued(){return [...this.jobs].filter(job=>!job.started && !job.controller.signal.aborted).length;}
  get active(){return [...this.jobs].filter(job=>job.started).length;}
}
export function createCycles(options:CycleOptions={}) {
  const owner=new CycleOwner(options);
  return {close:()=>owner.close(),
    events:(input:CycleInput,{signal,priority}:{signal?:AbortSignal;priority?:number}={})=>owner.get(input,'events',signal,priority) as Promise<CycleEventsResult>,
    chart:(input:CycleInput,{signal,priority}:{signal?:AbortSignal;priority?:number}={})=>owner.get(input,'chart',signal,priority) as Promise<CycleChartResult>,
    get queued(){return owner.queued;},get active(){return owner.active;}};
}
