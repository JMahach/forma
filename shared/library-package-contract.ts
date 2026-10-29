/** The date and IANA zone define a whole natal day, independently of card metadata. */
export interface NatalDaySource {date:string;timezone:string}
export const natalDaySourceKey=({date,timezone}:NatalDaySource)=>JSON.stringify([date,timezone]);

export type PackagePlacement='stored'|'no-op'|'stale';
