import {setImmediate as yieldTurn} from 'node:timers/promises';
import {MAIN_RETURN_BODIES,isMainReturnBody} from '../../shared/chart-return-contract.ts';
import {RETURN_FAMILIES} from '../../shared/library-package-contract.ts';
import type {CycleEventsResult} from '../../shared/cycles-format.ts';
import {preparationSource,type LibraryPreparation} from '../storage/library-preparation.ts';
import type {createChartRecords} from './chart-records.ts';
import type {createChartReturns} from './chart-returns.ts';
import type {NatalDays} from './natal-days.ts';

interface PreparationOptions {
  records:ReturnType<typeof createChartRecords>;
  returns:ReturnType<typeof createChartReturns>;
  natalDays:Pick<NatalDays,'get'>;
  now?:()=>number;
  onFailure?:(stage:'prepare'|'schedule')=>unknown;
}
const retryDelay=(attempts:number)=>Math.min(3_600_000,60_000*2**Math.min(attempts,6));

async function prepare(task:LibraryPreparation,signal:AbortSignal,{records,returns,natalDays}:PreparationOptions) {
  // Ownership comes from the committed job, not the lifetime of a browser session.
  const access=records.withAuthorization(()=>({accountId:task.accountId})),chart=access.getOwn(task.chartId);
  if(!chart || chart.source!=='calculated' || preparationSource(chart)!==task.sourceKey)return;
  const options={signal,priority:-1},input={birthUtc:chart.utc,timezone:chart.timezone||'UTC'};
  await natalDays.get(chart.birthDate,input.timezone,options);
  signal.throwIfAborted();
  const primary=new Map<string,CycleEventsResult>();
  for(const body of RETURN_FAMILIES) {
    const dates=await returns.events(access,chart.id,chart.accountId,{...input,body},options);
    if(isMainReturnBody(body))primary.set(body,dates);
  }
  for(const body of MAIN_RETURN_BODIES)for(const event of primary.get(body)!.events) {
    await returns.chart(access,chart.id,chart.accountId,{...input,body,eventUtc:event.utc},options);
  }
}

/** One resumable background consumer of the existing calculation owners. No per-account workers. */
class LibraryPreparationOwner {
  private options:PreparationOptions;
  private now:()=>number;
  private started=false;
  private closed=false;
  private running:Promise<void>|undefined;
  private timer:NodeJS.Timeout|undefined;
  private active:{task:LibraryPreparation;controller:AbortController}|undefined;
  private unsubscribe:()=>void;
  constructor(options:PreparationOptions) {
    this.options=options;this.now=options.now??Date.now;
    this.unsubscribe=options.records.subscribePreparation(notice=>{
      if(this.active?.task.chartId===notice.chartId)this.active.controller.abort();
      if(notice.kind==='queued')void this.wake();
    });
  }
  private report(stage:'prepare'|'schedule') {
    try {void Promise.resolve(this.options.onFailure?.(stage)).catch(()=>{});}catch { /* Reporting cannot change durable progress. */ }
  }
  private later(delay:number) {
    if(this.closed)return;
    this.timer=setTimeout(()=>{this.timer=undefined;void this.wake();},delay);this.timer.unref();
  }
  private schedule() {
    if(this.closed)return;
    try {
      const due=this.options.records.preparation.nextDue();
      if(due!==null)this.later(Math.max(0,Math.min(3_600_000,due-this.now())));
    } catch {this.report('schedule');this.later(60_000);}
  }
  private async runTask(task:LibraryPreparation) {
    const controller=new AbortController();this.active={task,controller};
    try {
      await prepare(task,controller.signal,this.options);
      if(!controller.signal.aborted)this.options.records.preparation.complete(task);
    } catch {
      if(!controller.signal.aborted) {
        this.options.records.preparation.postpone(task,this.now()+retryDelay(task.attempts));this.report('prepare');
      }
    } finally {this.active=undefined;}
  }
  private async drain() {
    while(!this.closed) {
      const task=this.options.records.preparation.next(this.now());if(!task)return;
      await this.runTask(task);
      // Ready records can complete without I/O. Let live requests arrive between destinations.
      await yieldTurn();
    }
  }
  wake():Promise<void> {
    if(!this.started || this.closed)return Promise.resolve();
    clearTimeout(this.timer);this.timer=undefined;
    if(this.running)return this.running;
    this.running=yieldTurn().then(()=>this.drain()).catch(()=>{this.report('schedule');this.later(60_000);}).finally(()=>{
      this.running=undefined;if(!this.timer)this.schedule();
    });
    return this.running;
  }
  start() {this.started=true;return this.wake();}
  async close() {
    this.closed=true;this.unsubscribe();clearTimeout(this.timer);this.timer=undefined;this.active?.controller.abort();
    await this.running;
  }
}
export function createLibraryPreparation(options:PreparationOptions) {return new LibraryPreparationOwner(options);}
