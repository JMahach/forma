import type {ChartRecord} from '../../shared/chart-types.ts';
import {canonicalChartId} from '../../shared/chart-record-contract.ts';
import {eligibleCycleChart,lifeTimelineForChart} from './cycles.ts';
import {canExploreNatalDay} from './chart-data.ts';

/** A loading hint has no numbers and never proves that a record exists or can be used. */
export interface ChartPresentationHint {id:string;kind:'natal'|'saved-transit';utc:string;dayAvailable:boolean}
export function normalizeChartHint(input:unknown):ChartPresentationHint|null {
 const value=input as Partial<ChartPresentationHint>|null;
 if(!value || typeof value.id!=='string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id) || value.id==='current-transit'
   || value.kind!=='natal' && value.kind!=='saved-transit' || typeof value.dayAvailable!=='boolean'
   || typeof value.utc!=='string' || !lifeTimelineForChart({utc:value.utc}))return null;
 return {id:canonicalChartId(value.id),kind:value.kind,utc:value.utc,dayAvailable:value.kind==='natal' && value.dayAvailable};
}
export function chartPresentationHint(chart:Partial<ChartRecord>|null|undefined):ChartPresentationHint|null {
 if(!chart || !eligibleCycleChart(chart) && chart.source!=='transit')return null;
 return normalizeChartHint({id:chart.id,kind:chart.source==='calculated'?'natal':'saved-transit',utc:chart.utc,dayAvailable:canExploreNatalDay(chart)});
}
export function chartPresentation(selectedId:string,record:Partial<ChartRecord>|null|undefined,hint?:ChartPresentationHint|null) {
 const isTransit=selectedId==='current-transit';
 const presentation=isTransit?null:record?chartPresentationHint(record):hint?.id===selectedId?hint:null;
 return {isTransit,personalAvailable:presentation?.kind==='natal',dayAvailable:presentation?.dayAvailable??false,utc:presentation?.utc??null};
}
