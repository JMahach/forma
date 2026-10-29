import {isMainReturnBody} from './chart-return-contract.ts';

/** The date and IANA zone define a whole natal day, independently of card metadata. */
export interface NatalDaySource {date:string;timezone:string}
export const natalDaySourceKey=({date,timezone}:NatalDaySource)=>JSON.stringify([date,timezone]);

export type PackagePlacement='stored'|'no-op'|'stale';

/** Server date lists cover every family; only five families have durable full calculations. */
export const RETURN_FAMILIES=Object.freeze(['sun','moon','north_node','mercury','venus','mars','jupiter','saturn',
  'uranus','uranus_opposition','neptune','pluto','chiron'] as const);
export type ReturnFamily=typeof RETURN_FAMILIES[number];
export const isReturnFamily=(value:unknown):value is ReturnFamily=>typeof value==='string'
  && (RETURN_FAMILIES as readonly string[]).includes(value);
export const canStoreServerReturn=(action:'events'|'chart',body:unknown):body is ReturnFamily=>
  action==='events'?isReturnFamily(body):action==='chart' && isMainReturnBody(body);
