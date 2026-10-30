import {createReturnReceipts} from './services/return-receipt.ts';
import type { ServerFailureReport } from './journal/report.ts';
import type { Database } from './storage/database.ts';
import type { Accounts } from './services/accounts.ts';
import type { CityCatalog } from './services/cities.ts';
import type { Calculator } from './services/calculate.ts';
import type { Cycles } from './services/cycles.ts';
import { createChartReturns } from './services/chart-returns.ts';
import { createChartRecords } from './services/chart-records.ts';
import { createChartCalculation } from './services/chart-calculation.ts';
import { createCalculationReceipts } from './services/calculation-receipt.ts';
import { createChartHandler } from './http/charts.ts';
import {createLibraryPreparation} from './services/library-preparation.ts';
import type {NatalDays} from './services/natal-days.ts';

/** Shares the account database and calculator; owns neither their lifetime nor a second copy. */
export function createChartRuntime({report,database,accounts,cities,calculate,cycles,origins,now=Date.now,onInvalidResult,key,onPreparationFailure}: {
  report?: ServerFailureReport;
  database: Database;
  key?:Uint8Array;
  accounts: Accounts;
  cities: CityCatalog;
  calculate: Calculator;
  cycles?: Pick<Cycles,'events'|'chart'>;
  origins: string[];
  now?:()=>number;
  onInvalidResult?:()=>unknown;
  onPreparationFailure?:(stage:'prepare'|'schedule')=>unknown;
}) {
  const records=createChartRecords({database,authorize:()=>null,now});
  const receipts=key?createCalculationReceipts({key}):undefined;
  const prepareBirth=createChartCalculation({cities,calculate,onInvalidResult,receipts});
  const returnReceipts=key ? createReturnReceipts({key}) : undefined;
  const returns = cycles ? createChartReturns({cycles,receipts:returnReceipts}) : undefined;
  const handler=createChartHandler({report,records,accounts,prepareBirth,returns,issueReturnReceipt:returnReceipts?.issue,origins,now});
  let preparation:ReturnType<typeof createLibraryPreparation>|undefined,closed=false;
  return {handler,packages:records.packages,cleanup:records.cleanup,issueCalculationReceipt:receipts?.issue,issueReturnReceipt:returnReceipts?.issue,
    startPreparation(natalDays:Pick<NatalDays,'get'>) {
      if(closed || !returns)return Promise.resolve();
      preparation??=createLibraryPreparation({records,returns,natalDays,now,onFailure:onPreparationFailure});
      return preparation.start();
    },
    async close() {closed=true;await preparation?.close();},
  };
}
