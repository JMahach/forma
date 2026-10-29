import {isMainReturnBody,mainReturnRange,normalizeMainReturn,type ReturnReceiptReader,type PreparedReturnSubmission} from '../../shared/chart-return-contract.ts';
import {validCycleResult,cycleAge,type CycleInput,type CycleEventsResult,type CycleChartResult} from '../../shared/cycles-format.ts';
import {ChartRecordError,type ChartRecordAccess,type ChartReturnQuery} from './chart-records.ts';
import type {AccountChart} from '../../shared/chart-record-contract.ts';

export interface ChartReturnCalculator {
  events(input:CycleInput,options:{signal:AbortSignal}):Promise<CycleEventsResult>;
  chart(input:CycleInput,options:{signal:AbortSignal}):Promise<CycleChartResult>;
}
type ReadOptions={signal:AbortSignal};

/** Linked main returns of an owned natal. Computation and unfinished sharing stay with cycles. */
export function createChartReturns({records,cycles,calculationVersion,cyclesVersion,receipts}:{
  records:ChartRecordAccess;cycles:ChartReturnCalculator;calculationVersion:string;cyclesVersion:string;receipts?:ReturnReceiptReader;
}) {
  records.configureReturns({calculationVersion,cyclesVersion});
  function source(access:ChartRecordAccess,id:string,accountId:string,input:CycleInput,{signal}:ReadOptions) {
    signal.throwIfAborted();
    const chart=access.getOwn(id,accountId);
    if(!chart)throw new ChartRecordError('not_found');
    if(chart.calculationVersion!==calculationVersion || input.birthUtc!==chart.utc
      || (input.timezone??'UTC')!==(chart.timezone||'UTC'))throw new ChartRecordError('source_changed');
    if(chart.source!=='calculated' || !isMainReturnBody(input.body))throw new ChartRecordError('invalid_chart');
    const range=mainReturnRange(chart.utc);
    if(!range || (input.fromAge!==undefined && input.fromAge!==range.fromAge)
      || (input.toAge!==undefined && input.toAge!==range.toAge))throw new ChartRecordError('invalid_chart');
    return {chart,body:input.body,range};
  }
  function query(chart:AccountChart,input:CycleInput,action:ChartReturnQuery['action']):ChartReturnQuery {
    return {chartId:chart.id,expectedAccountId:chart.accountId,birth:chart,cyclesVersion,action,input};
  }
  async function dates(access:ChartRecordAccess,context:ReturnType<typeof source>,options:ReadOptions):Promise<CycleEventsResult> {
    options.signal.throwIfAborted();
    const input={birthUtc:context.chart.utc,body:context.body,...context.range};
    const target=query(context.chart,input,'events'),stored=access.readReturn(target);
    if(validCycleResult('events',stored,input))return stored as CycleEventsResult;
    const result=await cycles.events({...input},options);
    options.signal.throwIfAborted();
    if(!validCycleResult('events',result,input) || result.events.length>2000)throw new ChartRecordError('chart_unavailable');
    access.saveReturn(target,result);
    return result;
  }
  return {
    async accept(access:ChartRecordAccess,id:string,expectedAccountId:string,packet:PreparedReturnSubmission,options:ReadOptions):Promise<{accepted:true}> {
      const context=source(access,id,expectedAccountId,packet.input,options);
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
    },
    async events(access:ChartRecordAccess,id:string,expectedAccountId:string,input:CycleInput,options:ReadOptions):Promise<CycleEventsResult> {
      const context=source(access,id,expectedAccountId,input,options);
      const result=await dates(access,context,options);
      options.signal.throwIfAborted();
      access.assertReturnCurrent(query(context.chart,{birthUtc:context.chart.utc,body:context.body,...context.range},'events'));
      return result;
    },
    async chart(access:ChartRecordAccess,id:string,expectedAccountId:string,input:CycleInput,options:ReadOptions):Promise<CycleChartResult> {
      const context=source(access,id,expectedAccountId,input,options),eventUtc=input.eventUtc;
      const age=cycleAge(eventUtc,context.chart.utc);
      if(typeof eventUtc!=='string' || !Number.isFinite(age) || age<=0 || age>context.range.toAge)throw new ChartRecordError('invalid_chart');
      const request={birthUtc:context.chart.utc,body:context.body,eventUtc,timezone:context.chart.timezone||'UTC'};
      const target=query(context.chart,request,'chart'),stored=access.readReturn(target);
      // An accepted signed chart remains ready even if its dates were never requested here.
      if(validCycleResult('chart',stored,request))return stored as CycleChartResult;
      const events=await dates(access,context,options);
      options.signal.throwIfAborted();
      access.assertReturnCurrent(target);
      // Without a trusted ready result, an arbitrary moment cannot become a saved main return.
      if(!events.events.some(event=>event.utc===eventUtc))throw new ChartRecordError('invalid_chart');
      const result=await cycles.chart({...request},options);
      options.signal.throwIfAborted();
      if(!validCycleResult('chart',result,request))throw new ChartRecordError('chart_unavailable');
      access.saveReturn(target,result);
      return result;
    },
  };
}
export type ChartReturns=ReturnType<typeof createChartReturns>;
