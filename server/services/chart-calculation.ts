import type { AccountChartBirth } from '../../shared/chart-record-contract.ts';
import type { CalculationRequest, ChartRecord, Activation } from '../../shared/chart-types.ts';
import { validChartCalculationResult } from '../../shared/calculation-result.ts';
import { SUPPORTED_START, SUPPORTED_END_EXCLUSIVE } from '../../shared/date-limits.ts';
import { utcMilliseconds } from '../../shared/utc-format.ts';
import type { CityCatalog } from './cities.ts';
import type { Calculator } from './calculate.ts';
import type { createCalculationReceipts } from './calculation-receipt.ts';

export class ChartCalculationError extends Error {
  readonly code: string;
  readonly status: number;
  readonly payload: Record<string, unknown>;
  constructor(code: string, status = 422, details: Record<string, unknown> = {}) {
    super(code); this.code = code; this.status = status; this.payload = {...details,error:code};
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChartCalculationError('invalid_request',400);
  return value as Record<string, unknown>;
}
function shortText(value: unknown, maximum: number) {
  if (typeof value !== 'string' || !value || value.length > maximum) throw new ChartCalculationError('invalid_request',400);
  return value;
}
const cleanSide = (entries: readonly Activation[]) => entries.map(({planet,longitude,gate,line}) => ({planet,longitude,gate,line}));

/** Input is source data; calculations and numerical revision always come from the server. */
export function createChartCalculation({cities, calculate, calculationVersion, onInvalidResult, receipts}: {
  cities: Pick<CityCatalog,'find'>;
  calculate: (...args: Parameters<Calculator>) => ReturnType<Calculator>;
  calculationVersion: string;
  receipts?: Pick<ReturnType<typeof createCalculationReceipts>,'read'>;
  onInvalidResult?: () => unknown;
}) {
  if (!calculationVersion) throw new TypeError('A calculation version is required');
  function invalidResult() {
    try { void Promise.resolve(onInvalidResult?.()).catch(() => {}); } catch { /* Diagnostics cannot replace the calculation result. */ }
    return new ChartCalculationError('invalid_calculation',503);
  }
  return async (input: unknown, {signal,receipt}: {signal: AbortSignal;receipt?:unknown}): Promise<AccountChartBirth> => {
    const raw = object(input), transit = raw.source === 'transit';
    if (!transit && raw.source !== 'calculated') throw new ChartCalculationError('invalid_request',400);
    const keys = transit ? ['source','utc'] : ['source','date','time','cityId','cityName','fold'];
    if (Object.keys(raw).some(key => !keys.includes(key))) throw new ChartCalculationError('invalid_request',400);
    let request: CalculationRequest;
    if (transit) {
      const utc = shortText(raw.utc, 24);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(utc)) throw new ChartCalculationError('invalid_utc');
      request = {mode:'transit',utc};
    } else {
      const date = shortText(raw.date,10), time = shortText(raw.time,5);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)
        || raw.fold !== undefined && raw.fold !== 0 && raw.fold !== 1
        || !(typeof raw.cityId === 'string' && raw.cityId.length <= 40 || typeof raw.cityId === 'number' && Number.isSafeInteger(raw.cityId))) {
        throw new ChartCalculationError('invalid_request',400);
      }
      const label = raw.cityName === undefined ? undefined : shortText(raw.cityName,160);
      const city = cities.find(raw.cityId,label);
      if (!city) throw new ChartCalculationError('city_required');
      request = {mode:'natal',name:'Карта',date,time,city,...(raw.fold === undefined ? {} : {fold:raw.fold as number})};
    }
    if (signal.aborted) throw new ChartCalculationError('cancelled',499);
    let result:Awaited<ReturnType<Calculator>>|null=null;
    if(receipt!==undefined){
      if(!receipts)throw new ChartCalculationError('invalid_request',400);
      try{result=receipts.read(receipt,request);}catch{throw new ChartCalculationError('invalid_request',400);}
    }
    result??=await calculate(request,{signal});
    if (signal.aborted) throw new ChartCalculationError('cancelled',499);
    if (result && typeof result === 'object' && 'error' in result && result.error) {
      const error = result as {error:unknown;message?:unknown;choices?:unknown};
      if (typeof error.error !== 'string' || !/^[a-z_]{1,80}$/.test(error.error)) throw invalidResult();
      const details: Record<string,unknown> = {};
      if (typeof error.message === 'string' && error.message.length <= 1000) details.message = error.message;
      if (error.error === 'ambiguous_time') {
        if (!Array.isArray(error.choices) || error.choices.length !== 2
          || error.choices.some(value => !value || typeof value !== 'object' || Array.isArray(value))) {
          throw invalidResult();
        }
        const choices = error.choices as Record<string,unknown>[];
        if (!choices.every(value => (value.fold === 0 || value.fold === 1) && Number.isFinite(utcMilliseconds(value.utc))
          && typeof value.label === 'string' && value.label.length <= 30)
          || new Set(choices.map(value => value.fold)).size !== 2) throw invalidResult();
        details.choices = choices.map(({fold,utc,label}) => ({fold,utc,label}));
      }
      throw new ChartCalculationError(error.error,['busy','engine_unavailable','timeout','calculation_failed'].includes(error.error) ? 503 : 422,details);
    }
    const chart = result && typeof result === 'object' && 'chart' in result ? result.chart as ChartRecord : null;
    const resolution = result && typeof result === 'object' && 'timeResolution' in result
      ? result.timeResolution as {ambiguous?:unknown} | null : null;
    const utc = utcMilliseconds(chart?.utc), designUtc = utcMilliseconds(chart?.designUtc);
    const source = transit ? 'transit' : 'calculated', timezone = transit ? 'UTC' : request.city!.timezone;
    if (!chart || chart.source !== source || !Number.isFinite(utc) || utc < SUPPORTED_START || utc >= SUPPORTED_END_EXCLUSIVE
      || !Number.isFinite(designUtc) || designUtc >= utc
      || !Number.isFinite(chart.designArcResidualDegrees) || chart.designArcResidualDegrees! < 0 || chart.designArcResidualDegrees! > 1e-7
      || chart.timezone !== timezone || ![0,1].includes(chart.fold!)
      || typeof resolution?.ambiguous !== 'boolean'
      || (resolution.ambiguous ? transit || request.fold === undefined || chart.fold !== request.fold : chart.fold !== 0)
      || typeof chart.utcOffset !== 'string' || !/^UTC[+−-]\d{2}:\d{2}(?::\d{2})?$/.test(chart.utcOffset)
      || !validChartCalculationResult(result)
      || (transit ? chart.utc !== request.utc : chart.birthDate !== request.date || chart.birthTime !== request.time)) {
      throw invalidResult();
    }
    for (const key of ['engine','ephemeris','timezoneDatabase','nodeModel','zodiac'] as const) {
      if (typeof chart[key] !== 'string' || !chart[key] || chart[key]!.length > 500) throw invalidResult();
    }
    if (typeof chart.verification !== 'string' || chart.verification.length > 1000) throw invalidResult();
    return {
      source, birthDate:transit ? chart.utc!.slice(0,10) : request.date!,
      birthTime:transit ? chart.utc!.slice(11,16) : request.time!, birthPlace:request.city?.name ?? '',
      utc:chart.utc!, timezone, utcOffset:chart.utcOffset, fold:chart.fold,
      designUtc:chart.designUtc, designArcResidualDegrees:chart.designArcResidualDegrees,
      personality:[...chart.personality], design:[...chart.design],
      activations:{personality:cleanSide(chart.activations!.personality),design:cleanSide(chart.activations!.design)},
      cityId:request.city?.id ?? null, city:request.city ? {...request.city} : null,
      engine:chart.engine, ephemeris:chart.ephemeris, timezoneDatabase:chart.timezoneDatabase,
      nodeModel:chart.nodeModel, zodiac:chart.zodiac, verification:chart.verification, calculationVersion,
    };
  };
}
