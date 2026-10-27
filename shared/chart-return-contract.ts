import {validCycleResult,cycleAge,cycleUtcMilliseconds,type CycleInput,type CycleResult,type CycleEventsResult,type CycleChartResult} from './cycles-format.ts';
import type {Activation,CalculatedChart} from './chart-types.ts';
import {calendarAnniversaryUtc,SUPPORTED_START,SUPPORTED_END_EXCLUSIVE} from './date-limits.ts';

/** Only these return families belong to a saved natal card and persistent device storage. */
export const MAIN_RETURN_BODIES=Object.freeze(['north_node','saturn','uranus_opposition','chiron','uranus'] as const);
export type MainReturnBody=typeof MAIN_RETURN_BODIES[number];
export const isMainReturnBody=(value:unknown):value is MainReturnBody=>
  typeof value==='string' && (MAIN_RETURN_BODIES as readonly string[]).includes(value);

/** One calendar lifetime per natal, not an unbounded set of cached query ranges. */
export function mainReturnRange(birthUtc:string) {
  const birth=Date.parse(birthUtc);
  if(!Number.isFinite(birth) || birth<SUPPORTED_START || birth>=SUPPORTED_END_EXCLUSIVE-1)return null;
  const end=Math.min(SUPPORTED_END_EXCLUSIVE-1,calendarAnniversaryUtc(birth));
  return {fromAge:0,toAge:(end-birth)/(365.2425*86400000)};
}

export type ReturnAction='events'|'chart';
export type PreparedReturn<T extends CycleResult=CycleResult>=T & {proof?:string};
export const MAX_RETURN_PROOF_LENGTH=112;
export interface PreparedReturnSubmission {action:ReturnAction;input:CycleInput;result:unknown;proof:unknown}
export interface ReturnReceiptReader {
  read(action:ReturnAction,input:CycleInput,result:unknown,proof:unknown):CycleResult|null;
}

/** A stable, checked projection. Neither personal fields nor UI event labels cross this boundary. */
export function normalizeMainReturn(action:ReturnAction,input:CycleInput,value:unknown):{input:CycleInput;result:CycleResult}|null {
  if(!input || !isMainReturnBody(input.body) || !Number.isFinite(cycleUtcMilliseconds(input.birthUtc)))return null;
  const range=mainReturnRange(input.birthUtc);
  if(!range)return null;
  if(action==='events') {
    const request={birthUtc:input.birthUtc,body:input.body,fromAge:input.fromAge??range.fromAge,toAge:input.toAge??range.toAge};
    if(request.fromAge!==range.fromAge || request.toAge!==range.toAge || !validCycleResult(action,value,request))return null;
    const data=value as CycleEventsResult;
    if(data.events.length>2000)return null;
    // IDs, labels and age are derived again: IDB intentionally stores only these four event fields.
    const events=data.events.map(({utc,cycle,pass,direction})=>({utc,cycle,pass,direction,
      id:`${input.body}:${utc}`,body:input.body,age:cycleAge(utc,input.birthUtc),cycleId:`${input.body}:${cycle}`}));
    return {input:request,result:{range,events}};
  }
  if(action!=='chart')return null;
  const request={birthUtc:input.birthUtc,body:input.body,eventUtc:input.eventUtc,timezone:input.timezone??'UTC'};
  if(!validCycleResult(action,value,request))return null;
  const chart=(value as CycleChartResult).chart;
  if(cycleAge(chart.utc,input.birthUtc)>range.toAge || !Number.isFinite(cycleUtcMilliseconds(chart.designUtc))
    || cycleUtcMilliseconds(chart.designUtc)>=cycleUtcMilliseconds(chart.utc))return null;
  let valid=true;
  const side=(entries:readonly Activation[])=>entries.map(({planet,longitude,gate,line,...extra})=>{
    const entry:Activation={planet,longitude,gate,line};
    for(const field of ['color','tone','base','speed'] as const)if(extra[field]!==undefined) {
      if(typeof extra[field]!=='number' || !Number.isFinite(extra[field]))valid=false;
      else entry[field]=extra[field];
    }
    return entry;
  });
  const normalized:CalculatedChart={source:'calculated',utc:chart.utc,timezone:chart.timezone,designUtc:chart.designUtc,
    designArcResidualDegrees:chart.designArcResidualDegrees,personality:[...chart.personality],design:[...chart.design],
    activations:{personality:side(chart.activations.personality),design:side(chart.activations.design)}};
  const fields=chart as unknown as Record<string,unknown>;
  for(const field of ['utcOffset','engine','ephemeris','timezoneDatabase','nodeModel','zodiac','localDate','localTime',
    'birthDate','birthTime','birthPlace'] as const)if(fields[field]!==undefined) {
    if(typeof fields[field]!=='string')return null;
    Object.assign(normalized,{[field]:fields[field]});
  }
  if(chart.fold!==undefined) {
    if(chart.fold!==0 && chart.fold!==1)return null;
    normalized.fold=chart.fold;
  }
  return valid?{input:request,result:{chart:normalized}}:null;
}
