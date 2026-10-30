import { createCalculationFailureReporter, type CalculationFailureReport } from './calculation-failure.ts';
import type { NatalDay } from '../packets/encode.ts';
import type { DayPacket } from '../packets/compression.ts';
import type { ComputeQueue, QueueOptions } from '../runtime/compute-queue.ts';
import type { JsonWorkerOptions } from '../runtime/json-worker.ts';
import type { SharedJob } from '../runtime/job-consumers.ts';
import type {NatalDaySource,PackagePlacement} from '../../shared/library-package-contract.ts';

interface NatalWork extends SharedJob<DayPacket> {
  key: string;
  priority:number;
  date: string;
  timezone: string;
  controller: AbortController;
  resolve: (packet: DayPacket) => void;
  reject: (reason: unknown) => void;
  finished:Promise<void>;
  finish:()=>void;
}
interface GenerateNatalOptions extends QueueOptions {
  report?: CalculationFailureReport;
  root: string;
  date: string;
  timezone: string;
  spawnWorker?: JsonWorkerOptions['spawnWorker'];
  computeQueue?: ComputeQueue;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
interface NatalDayOptions {
  packages?:{readDay(source:NatalDaySource):DayPacket|null;putDay(source:NatalDaySource,packet:DayPacket):PackagePlacement};
  packDay?: (day:NatalDay)=>Promise<DayPacket>;
  report?: CalculationFailureReport;
  root?: string;
  computeQueue?: ComputeQueue;
  generateDay?: (date: string, timezone: string, options: QueueOptions) => Promise<NatalDay>;
  now?: () => number;
  capacity?: number;
  ttlMs?: number;
  maxQueued?: number;
}
export type NatalDays = ReturnType<typeof createNatalDays>;

import { consumeJob } from '../runtime/job-consumers.ts';
import { encodeNatalDayColumn, encodeNatalDay } from '../packets/encode.ts';
import { runJsonWorker } from '../runtime/json-worker.ts';
import { encodePredictedDay, compressDayPacket } from '../packets/compression.ts';
import { SUPPORTED_START, SUPPORTED_END_EXCLUSIVE } from '../../shared/date-limits.ts';

export class NatalDayError extends Error {
  declare code: string;
  declare status: number;
  declare retryAfter: number | null;

  constructor(code: string, message: string, status = 503, retryAfter: number | null = 5) {
    super(message); this.code = code; this.status = status; this.retryAfter = retryAfter;
  }
}
export function validateNatalDayDate(date: unknown): asserts date is string {
  const moment = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  if (!Number.isFinite(moment) || new Date(moment).toISOString().slice(0, 10) !== date || moment < SUPPORTED_START || moment >= SUPPORTED_END_EXCLUSIVE) {
    throw new NatalDayError('invalid_date', 'Нужна корректная дата рождения с 1801 по 2399 год.', 422, null);
  }
}
export function validateNatalZone(timezone: unknown): asserts timezone is string {
  if (typeof timezone !== 'string' || !timezone || timezone.length > 160 || !/^[A-Za-z0-9_+\-/]+$/.test(timezone)) {
    throw new NatalDayError('invalid_timezone', 'Некорректный часовой пояс города.', 422, null);
  }
}
export function generateNatalDay({ root, date, timezone, spawnWorker, computeQueue, signal, priority, report, timeoutMs = 30_000, maxOutputBytes = 2_000_000 }: GenerateNatalOptions) {
  validateNatalDayDate(date); validateNatalZone(timezone);
  const unavailable = () => new NatalDayError('natal_day_unavailable', 'Не удалось подготовить день рождения. Повторите попытку.');
  const failure = createCalculationFailureReporter('natal_day', report);
  const invalid = () => { if (!signal?.aborted) failure('invalid_result'); return unavailable(); };
  return runJsonWorker({
    root, script: 'natal_day.py', input: { date, timezone }, spawnWorker, computeQueue, signal, priority, timeoutMs, maxOutput: maxOutputBytes, unavailable, onFailure: failure,
    timeoutError: () => new NatalDayError('natal_day_timeout', 'День рождения не успел рассчитаться. Повторите попытку.'),
    validate(value) {
      const day = value as NatalDay & { error?: string; message?: string };
      if (!day) throw invalid();
      if (day.error) {
        const known = ['invalid_date', 'unsupported_date', 'invalid_timezone', 'nonexistent_date'].includes(day.error);
        throw known ? new NatalDayError(day.error, day.message!, 422, null) : invalid();
      }
      if (day.date !== date || day.timezone !== timezone) throw invalid();
      return day;
    },
  });
}
export function encodeNatalDayPacket(day: NatalDay) {
  return encodePredictedDay(day, encodeNatalDayColumn, encodeNatalDay);
}

// RAM remains bounded. Saved sources additionally own exact prepared packets in the account database.
const aborted=()=>new DOMException('Запрос отменён.','AbortError');
class NatalDayOwner {
  private memory=new Map<string,{packet:DayPacket;expires:number}>();
  private pending=new Map<string,NatalWork>();
  private queue:NatalWork[]=[];
  private active:NatalWork|undefined;
  private closed=false;
  private closing:Promise<void>|undefined;
  private options:Required<Pick<NatalDayOptions,'generateDay'|'packDay'|'now'|'capacity'|'ttlMs'|'maxQueued'>> & Pick<NatalDayOptions,'packages'>;
  private failure:ReturnType<typeof createCalculationFailureReporter>;
  constructor({root,computeQueue,report,packages,
    packDay=async day=>({bytes:await compressDayPacket(await encodeNatalDayPacket(day),{quality:9})}),
    generateDay=(date,timezone,options)=>generateNatalDay({root:root!,date,timezone,computeQueue,report,...options}),
    now=Date.now,capacity=10,ttlMs=600_000,maxQueued=3}:NatalDayOptions) {
    this.options={generateDay,packDay,now,capacity,ttlMs,maxQueued,packages};
    this.failure=createCalculationFailureReporter('natal_day',report);
  }
  private prune() {
    for(const [key,entry] of this.memory)if(entry.expires<=this.options.now())this.memory.delete(key);
  }
  private memoryPacket(key:string) {
    this.prune();const entry=this.memory.get(key);
    if(!entry)return null;
    this.memory.delete(key);this.memory.set(key,entry);return entry.packet;
  }
  private consume(job:NatalWork,signal?:AbortSignal,background=false) {
    const result=consumeJob(job,signal,abandoned=>{
      const index=this.queue.indexOf(abandoned);
      if(index>=0){this.queue.splice(index,1);abandoned.reject(aborted());abandoned.finish();}
      if(this.pending.get(abandoned.key)===abandoned)this.pending.delete(abandoned.key);
      abandoned.controller.abort();
    });
    return background?result.catch(async error=>{if(signal?.aborted)await job.finished;throw error;}):result;
  }
  private async pack(job:NatalWork,day:NatalDay) {
    try {
      if(day.date!==job.date || day.timezone!==job.timezone)throw Error('Unexpected natal day');
      return await this.options.packDay(day);
    } catch(error) {
      if(job.controller.signal.aborted)throw error;
      this.failure('invalid_result');throw new NatalDayError('natal_day_unavailable','Не удалось подготовить день рождения. Повторите попытку.');
    }
  }
  private async prepare(job:NatalWork) {
    // A cancelled packing can finish while a retry waits; its result still belongs to RAM.
    const ready=this.memoryPacket(job.key);
    if(ready){this.options.packages?.putDay(job,ready);return ready;}
    const day=await this.options.generateDay(job.date,job.timezone,{signal:job.controller.signal,priority:()=>job.priority});
    job.controller.signal.throwIfAborted();
    const packet=await this.pack(job,day);
    this.prune();this.memory.set(job.key,{packet,expires:this.options.now()+this.options.ttlMs});
    while(this.memory.size>this.options.capacity)this.memory.delete(this.memory.keys().next().value!);
    if(this.closed)throw aborted();
    if(!job.controller.signal.aborted)this.options.packages?.putDay(job,packet);
    return packet;
  }
  private async drain() {
    if(this.closed || this.active || !this.queue.length)return;
    this.queue.sort((a,b)=>b.priority-a.priority);
    const job=this.queue.shift()!;this.active=job;
    try {job.resolve(await this.prepare(job));}catch(error){job.reject(error);}
    finally {
      if(this.pending.get(job.key)===job)this.pending.delete(job.key);
      this.active=undefined;job.finish();void this.drain();
    }
  }
  private ready(date:string,timezone:string,key:string) {
    validateNatalDayDate(date);validateNatalZone(timezone);
    const ready=this.memoryPacket(key);
    if(ready){this.options.packages?.putDay({date,timezone},ready);return ready;}
    return this.options.packages?.readDay({date,timezone});
  }
  private enqueue(date:string,timezone:string,key:string,priority:number,signal?:AbortSignal) {
    let resolve!:(packet:DayPacket)=>void,reject!:(reason:unknown)=>void,finish!:()=>void;
    const promise=new Promise<DayPacket>((yes,no)=>{resolve=yes;reject=no;});
    const finished=new Promise<void>(resolve=>{finish=resolve;});
    const job={key,date,timezone,priority,controller:new AbortController(),resolve,reject,promise,finished,finish};
    this.pending.set(key,job);this.queue.push(job);
    const result=this.consume(job,signal,priority<0);void this.drain();return result;
  }
  get(date:string,timezone:string,{signal,priority=0}:{signal?:AbortSignal;priority?:number}={}):Promise<DayPacket> {
    if(this.closed || signal?.aborted)return Promise.reject(aborted());
    const key=`${date}@${timezone}`;
    try {const ready=this.ready(date,timezone,key);if(ready)return Promise.resolve(ready);}
    catch(error){return Promise.reject(error);}
    const existing=this.pending.get(key);
    if(existing){existing.priority=Math.max(existing.priority,priority);return this.consume(existing,signal,priority<0);}
    if(this.queue.length>=this.options.maxQueued)return Promise.reject(new NatalDayError('natal_day_busy','Подождите завершения расчёта дня рождения и повторите попытку.',503,2));
    return this.enqueue(date,timezone,key,priority,signal);
  }
  get size(){this.prune();return this.memory.size;}
  get queued(){return this.queue.length;}
  close() {
    if(!this.closing) {
      this.closed=true;
      for(const job of this.queue.splice(0)){job.controller.abort();job.reject(aborted());job.finish();}
      this.active?.controller.abort();this.pending.clear();
      this.closing=Promise.resolve(this.active?.finished).then(()=>{this.memory.clear();});
    }
    return this.closing;
  }
}
export function createNatalDays(options:NatalDayOptions={}) {
  const owner=new NatalDayOwner(options);
  return {get:(...args:Parameters<NatalDayOwner['get']>)=>owner.get(...args),close:()=>owner.close(),
    get size(){return owner.size;},get queued(){return owner.queued;}};
}
