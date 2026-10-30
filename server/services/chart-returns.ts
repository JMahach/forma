import {mainReturnRange,isMainReturnBody,normalizeMainReturn,type ReturnReceiptReader,type PreparedReturnSubmission} from '../../shared/chart-return-contract.ts';
import {validCycleResult,cycleAge,type CycleInput,type CycleEventsResult,type CycleChartResult} from '../../shared/cycles-format.ts';
import {ChartRecordError,type ChartRecordAccess,type ChartReturnQuery} from './chart-records.ts';
import type {AccountChart} from '../../shared/chart-record-contract.ts';
import {canStoreServerReturn,returnSourceKey,validMajorReturnsPackage,type PackageRef,type MajorReturnsPackage} from '../../shared/library-package-contract.ts';

export interface ChartReturnCalculator {
  events(input:CycleInput,options:{signal:AbortSignal;priority?:number}):Promise<CycleEventsResult>;
  chart(input:CycleInput,options:{signal:AbortSignal;priority?:number}):Promise<CycleChartResult>;
}
type ReadOptions={signal:AbortSignal;priority?:number};

function requestedLifetimeRange(birthUtc:string,input:CycleInput) {
  const range=mainReturnRange(birthUtc);
  if(!range || (input.fromAge!==undefined && input.fromAge!==range.fromAge)
    || (input.toAge!==undefined && input.toAge!==range.toAge))throw new ChartRecordError('invalid_chart');
  return range;
}
function source(access:ChartRecordAccess,id:string,accountId:string,input:CycleInput,{signal}:ReadOptions,action:'events'|'chart') {
  signal.throwIfAborted();
  const chart=access.getOwn(id,accountId);
  if(!chart)throw new ChartRecordError('not_found');
  if(input.birthUtc!==chart.utc
    || (input.timezone??'UTC')!==(chart.timezone||'UTC'))throw new ChartRecordError('source_changed');
  if(chart.source!=='calculated' || !canStoreServerReturn(action,input.body))throw new ChartRecordError('invalid_chart');
  return {chart,body:input.body,range:requestedLifetimeRange(chart.utc,input)};
}
function query(chart:AccountChart,input:CycleInput,action:ChartReturnQuery['action']):ChartReturnQuery {
  return {chartId:chart.id,expectedAccountId:chart.accountId,birth:chart,action,input};
}
function reuse(access:ChartRecordAccess,target:ChartReturnQuery) {
  const value=access.readRelatedReturn(target),{input,action}=target;
  if(!validCycleResult(action,value,input))return null;
  if(action==='events') {
    const dates=value as CycleEventsResult;
    if(dates.events.length>2000)return null;
    const result={range:{...dates.range},events:dates.events.map(({utc,cycle,pass,direction})=>({utc,cycle,pass,direction,
      id:`${input.body}:${utc}`,body:input.body,age:cycleAge(utc,input.birthUtc),cycleId:`${input.body}:${cycle}`}))};
    access.saveReturn(target,result);return result;
  }
  const normalized=normalizeMainReturn(action,input,value);
  if(!normalized)return null;
  // A donor's personal fields must never travel with shared numerical work.
  const {birthPlace:_place,...chart}=(normalized.result as CycleChartResult).chart as CycleChartResult['chart'] & {birthPlace?:string};
  const result={chart};access.saveReturn(target,result);return result;
}
async function dates(cycles:ChartReturnCalculator,access:ChartRecordAccess,context:ReturnType<typeof source>,options:ReadOptions):Promise<CycleEventsResult> {
  options.signal.throwIfAborted();
  const input={birthUtc:context.chart.utc,body:context.body,...context.range};
  const target=query(context.chart,input,'events'),stored=access.readReturn(target);
  if(validCycleResult('events',stored,input))return stored as CycleEventsResult;
  const shared=reuse(access,target);if(shared)return shared as CycleEventsResult;
  const result=await cycles.events({...input},options);
  options.signal.throwIfAborted();
  if(!validCycleResult('events',result,input) || result.events.length>2000)throw new ChartRecordError('chart_unavailable');
  access.saveReturn(target,result);
  return result;
}

function readPackage(access:ChartRecordAccess,id:string,expectedAccountId:string,input:CycleInput,options:ReadOptions):{ref:Extract<PackageRef,{kind:'major-returns'}>;payload:MajorReturnsPackage}|null {
  const context=source(access,id,expectedAccountId,input,options,'chart');
  if(!isMainReturnBody(context.body))throw new ChartRecordError('invalid_chart');
  const parts=access.readReturnFamily(query(context.chart,input,'chart'));
  const events=(parts.dates as Partial<CycleEventsResult>|null)?.events;
  if(!Array.isArray(events))return null;
  const origin={birthUtc:context.chart.utc,timezone:context.chart.timezone||'UTC'};
  const ref={kind:'major-returns' as const,sourceKey:returnSourceKey(origin),family:context.body};
  const payload={source:origin,family:context.body,dates:parts.dates,
    charts:events.map(event=>parts.charts.get(event?.utc))};
  return validMajorReturnsPackage(ref,payload)?{ref,payload}:null;
}

async function acceptPrepared(receipts:ReturnReceiptReader|undefined,access:ChartRecordAccess,id:string,expectedAccountId:string,packet:PreparedReturnSubmission,options:ReadOptions):Promise<{accepted:true}> {
  const context=source(access,id,expectedAccountId,packet.input,options,packet.action);
  if(!receipts || !['events','chart'].includes(packet.action))throw new ChartRecordError('invalid_chart');
  let trusted;
  try { trusted=receipts.read(packet.action,packet.input,packet.result,packet.proof); }
  catch(error) { if(error instanceof TypeError)throw new ChartRecordError('invalid_chart');throw error; }
  const prepared=normalizeMainReturn(packet.action,packet.input,trusted);
  if(!prepared)throw new ChartRecordError('invalid_chart');
  // The trusted engine has already verified the real root. Rounded input aliases
  // share its exact resolved key instead of creating multiple stored copies.
  const input=packet.action==='chart'?{...prepared.input,eventUtc:(prepared.result as CycleChartResult).chart.utc}:prepared.input;
  options.signal.throwIfAborted();
  access.saveReturn(query(context.chart,input,packet.action),prepared.result);
  return {accepted:true};
}

function requestedEvent(context:ReturnType<typeof source>,eventUtc:string|undefined) {
  const age=cycleAge(eventUtc,context.chart.utc);
  if(typeof eventUtc!=='string' || !Number.isFinite(age) || age<=0 || age>context.range.toAge)throw new ChartRecordError('invalid_chart');
  return eventUtc;
}
async function readChart(cycles:ChartReturnCalculator,access:ChartRecordAccess,id:string,expectedAccountId:string,input:CycleInput,options:ReadOptions):Promise<CycleChartResult> {
  const context=source(access,id,expectedAccountId,input,options,'chart'),eventUtc=requestedEvent(context,input.eventUtc);
  const request={birthUtc:context.chart.utc,body:context.body,eventUtc,timezone:context.chart.timezone||'UTC'};
  const target=query(context.chart,request,'chart'),stored=access.readReturn(target);
  // An accepted signed chart remains ready even if its dates were never requested here.
  if(validCycleResult('chart',stored,request))return stored as CycleChartResult;
  const shared=reuse(access,target);if(shared)return shared as CycleChartResult;
  const events=await dates(cycles,access,context,options);
  options.signal.throwIfAborted();
  access.assertReturnCurrent(target);
  // Without a trusted ready result, an arbitrary moment cannot become a saved main return.
  if(!events.events.some(event=>event.utc===eventUtc))throw new ChartRecordError('invalid_chart');
  const result=await cycles.chart({...request},options);
  options.signal.throwIfAborted();
  if(!validCycleResult('chart',result,request))throw new ChartRecordError('chart_unavailable');
  access.saveReturn(target,result);
  return result;
}

/** All date families and primary full events of an owned natal. Cycles owns unfinished computation. */
export function createChartReturns({cycles,receipts}:{
  cycles:ChartReturnCalculator;receipts?:ReturnReceiptReader;
}) {
  return {
    readPackage,
    accept(access:ChartRecordAccess,id:string,accountId:string,packet:PreparedReturnSubmission,options:ReadOptions) {
      return acceptPrepared(receipts,access,id,accountId,packet,options);
    },
    async events(access:ChartRecordAccess,id:string,accountId:string,input:CycleInput,options:ReadOptions):Promise<CycleEventsResult> {
      const context=source(access,id,accountId,input,options,'events');
      const result=await dates(cycles,access,context,options);
      options.signal.throwIfAborted();
      access.assertReturnCurrent(query(context.chart,{birthUtc:context.chart.utc,body:context.body,...context.range},'events'));
      return result;
    },
    chart(access:ChartRecordAccess,id:string,accountId:string,input:CycleInput,options:ReadOptions) {
      return readChart(cycles,access,id,accountId,input,options);
    },
  };
}
export type ChartReturns=ReturnType<typeof createChartReturns>;
