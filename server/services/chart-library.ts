import { consumeJob, type SharedJob } from '../runtime/job-consumers.ts';
import type { AccountChartBirth, AccountChart, PublicAccountChart, AccountChartPage } from '../../shared/chart-record-contract.ts';
import { ChartRecordError, type ChartRecordAccess } from './chart-records.ts';

interface LibraryOptions {
  calculationVersion: string;
  prepareBirth(input: unknown, options: {signal: AbortSignal}): Promise<AccountChartBirth>;
}
interface RefreshJob extends SharedJob<AccountChartBirth> { controller: AbortController }
/** One runtime owns unfinished calculations; every read keeps its own authorised access. */
export function createChartLibrary({calculationVersion,prepareBirth}: LibraryOptions) {
  const pending = new Map<string, RefreshJob>();
  function prepare(input: unknown, signal: AbortSignal): Promise<AccountChartBirth> {
    signal.throwIfAborted();
    const key = JSON.stringify([calculationVersion,input]);
    let job = pending.get(key);
    if (!job) {
      const controller = new AbortController();
      const created: RefreshJob = {controller, promise: Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return prepareBirth(input,{signal:controller.signal});
      }).finally(() => {if (pending.get(key) === created) pending.delete(key);})};
      pending.set(key,created); job = created;
    }
    return consumeJob(job,signal,abandoned => {
      if (pending.get(key) === abandoned) pending.delete(key);
      abandoned.controller.abort();
    });
  }
  async function current<T extends AccountChart | PublicAccountChart>(records: ChartRecordAccess, read:()=>T|null, options:{signal:AbortSignal}):Promise<T|null> {
    for(let attempt=0;attempt<3;attempt++) {
      options.signal.throwIfAborted();
      const chart=read();
      if(!chart || chart.calculationVersion===calculationVersion) return chart;
      const input=chart.source==='transit' ? {source:'transit',utc:chart.utc}
        : {source:'calculated',date:chart.birthDate,time:chart.birthTime,cityId:chart.cityId,
          ...(chart.city?.name ? {cityName:chart.city.name}:{}),fold:chart.fold};
      const birth=await prepare(input,options.signal);
      options.signal.throwIfAborted();
      // The comparison and update are atomic. Read again to recheck access and
      // include any name/note edit or deletion that happened during calculation.
      records.refreshBirth(chart.id,chart,birth);
    }
    options.signal.throwIfAborted();
    const chart=read();
    if(!chart || chart.calculationVersion===calculationVersion) return chart;
    throw new ChartRecordError('chart_unavailable');
  }
  const own=(records:ChartRecordAccess,id:string,expectedAccountId:string,options:{signal:AbortSignal})=>
    current(records,()=>records.getOwn(id,expectedAccountId),options);
  return {
    own,
    public:(records:ChartRecordAccess,id:string,options:{signal:AbortSignal})=>current(records,()=>records.getPublic(id),options),
    async page(records:ChartRecordAccess,input:Parameters<ChartRecordAccess['page']>[0],options:{signal:AbortSignal}):Promise<AccountChartPage> {
      options.signal.throwIfAborted();
      const page=records.page(input);
      return {charts:page.charts.map(chart=>({...chart,calculationCurrent:chart.calculationVersion===calculationVersion})),
        nextCursor:page.nextCursor,calculationVersion};

    },
  };
}
