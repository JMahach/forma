import {isMainReturnBody,mainReturnRange,type MainReturnBody} from './chart-return-contract.ts';
import {validCycleResult,cycleUtcMilliseconds,type CycleEventsResult,type CycleChartResult} from './cycles-format.ts';

/** The date and IANA zone define a whole natal day, independently of card metadata. */
export interface NatalDaySource {date:string;timezone:string}
export const natalDaySourceKey=({date,timezone}:NatalDaySource)=>JSON.stringify([date,timezone]);

export type PackagePlacement='stored'|'no-op'|'stale';

/** A record revision is user content; numeric packages depend only on their exact inputs. */
export type PackageRef=
  | {kind:'card';sourceKey:string}
  | {kind:'day';sourceKey:string}
  | {kind:'major-returns';sourceKey:string;family:MainReturnBody};
export const cardSourceKey=({id,revision}:{id:string;revision:number})=>JSON.stringify([id,revision]);
export interface ReturnSource {birthUtc:string;timezone:string}
export const returnSourceKey=({birthUtc,timezone}:ReturnSource)=>JSON.stringify([birthUtc,timezone]);

/** The authoritative lifetime list and every corresponding calculation form one unit. */
export interface MajorReturnsPackage {
  source:ReturnSource;family:MainReturnBody;dates:CycleEventsResult;charts:CycleChartResult[];
}
type MajorReturnsRef=Extract<PackageRef,{kind:'major-returns'}>;
function matchingReturnSource(ref:MajorReturnsRef,data:Partial<MajorReturnsPackage>|null) {
  if(!data?.source)return null;
  const source=data.source;
  return ref.kind==='major-returns' && isMainReturnBody(ref.family) && data.family===ref.family
    && typeof source.birthUtc==='string' && typeof source.timezone==='string'
    && returnSourceKey(source)===ref.sourceKey?source:null;
}
function validFamilyChart(result:unknown,eventUtc:string,source:ReturnSource,family:MainReturnBody) {
  if(!validCycleResult('chart',result,{...source,body:family,eventUtc}))return false;
  const {chart}=result as CycleChartResult;
  return chart.utc===eventUtc && Number.isFinite(cycleUtcMilliseconds(chart.designUtc))
    && cycleUtcMilliseconds(chart.designUtc)<cycleUtcMilliseconds(eventUtc);
}
function completeFamilyCharts(source:ReturnSource,family:MainReturnBody,dates:CycleEventsResult,charts:unknown[]) {
  if(dates.events.length>2000 || charts.length!==dates.events.length)return false;
  for(let index=0;index<dates.events.length;index++) {
    const event=dates.events[index];
    if(!event || !validFamilyChart(charts[index],event.utc,source,family))return false;
  }
  return true;
}
export function validMajorReturnsPackage(ref:MajorReturnsRef,value:unknown):value is MajorReturnsPackage {
  const data=value as Partial<MajorReturnsPackage>|null,source=matchingReturnSource(ref,data);
  if(!source || !data)return false;
  const range=mainReturnRange(source.birthUtc),input={...source,body:ref.family,...range};
  if(!range || !validCycleResult('events',data.dates,input) || !Array.isArray(data.charts))return false;
  return completeFamilyCharts(source,ref.family,data.dates as CycleEventsResult,data.charts);
}

/** Server date lists cover every family; only five families have durable full calculations. */
export const RETURN_FAMILIES=Object.freeze(['sun','moon','north_node','mercury','venus','mars','jupiter','saturn',
  'uranus','uranus_opposition','neptune','pluto','chiron'] as const);
export type ReturnFamily=typeof RETURN_FAMILIES[number];
export const isReturnFamily=(value:unknown):value is ReturnFamily=>typeof value==='string'
  && (RETURN_FAMILIES as readonly string[]).includes(value);
export const canStoreServerReturn=(action:'events'|'chart',body:unknown):body is ReturnFamily=>
  action==='events'?isReturnFamily(body):action==='chart' && isMainReturnBody(body);
