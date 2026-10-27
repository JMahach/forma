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

/** Shares the account database and calculator; owns neither their lifetime nor a second copy. */
export function createChartRuntime({report,database,accounts,cities,calculate,calculationVersion,cycles,origins,now=Date.now,onInvalidResult,key}: {
  report?: ServerFailureReport;
  database: Database;
  key?:Uint8Array;
  accounts: Accounts;
  cities: CityCatalog;
  calculate: Calculator;
  calculationVersion: string;
  cycles?: Pick<Cycles,'events'|'chart'|'cacheVersion'>;
  origins: string[];
  now?:()=>number;
  onInvalidResult?:()=>unknown;
}) {
  const records=createChartRecords({database,authorize:()=>null,now});
  const receipts=key?createCalculationReceipts({key,calculationVersion}):undefined;
  const prepareBirth=createChartCalculation({cities,calculate,calculationVersion,onInvalidResult,receipts});
  const returnReceipts=key && cycles?.cacheVersion ? createReturnReceipts({key,cyclesVersion:cycles.cacheVersion}) : undefined;
  const returns = cycles?.cacheVersion ? createChartReturns({records,cycles,calculationVersion,cyclesVersion:cycles.cacheVersion,receipts:returnReceipts}) : undefined;
  const handler=createChartHandler({report,records,accounts,prepareBirth,calculationVersion,returns,cyclesVersion:cycles?.cacheVersion ?? undefined,issueReturnReceipt:returnReceipts?.issue,origins,now});
  return {handler,cleanup:records.cleanup,issueCalculationReceipt:receipts?.issue,issueReturnReceipt:returnReceipts?.issue};
}
