import type {AccountChart} from './chart-record-contract.ts';
import type {MainReturnBody} from './chart-return-contract.ts';
import type {PackageRef,MajorReturnsPackage} from './library-package-contract.ts';

/** Decimal account catalogue counter. It does not identify a calculation engine or algorithm. */
export type LibraryCatalogMarker=string;
export const isLibraryCatalogMarker=(value:unknown):value is LibraryCatalogMarker=>typeof value==='string'
  && /^(?:0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value)<=9_223_372_036_854_775_807n;
type CardRef=Extract<PackageRef,{kind:'card'}>;
type DayRef=Extract<PackageRef,{kind:'day'}>;
type ReturnsRef=Extract<PackageRef,{kind:'major-returns'}>;

/** Navigation metadata and server availability; neither numerical payloads nor device offline readiness. */
export interface LibraryCatalogEntry extends Pick<AccountChart,'id'|'revision'|'name'|'source'|'birthDate'|'birthTime'> {
  packages:{
    card:CardRef;
    day:{ref:DayRef;ready:boolean}|null;
    majorReturns:{sourceKey:string;readyFamilies:MainReturnBody[]}|null;
  };
}
interface CatalogState {accountId:string;marker:LibraryCatalogMarker}
export interface LibraryCatalogPage extends CatalogState {
  kind:'page';entries:LibraryCatalogEntry[];nextCursor:string|null;
}
export type LibraryCatalogReply=
  | LibraryCatalogPage
  | CatalogState & {kind:'unchanged'|'restart'};
export type LibraryCatalogConfirmation=CatalogState & {kind:'confirmed'|'restart'};
export type LibraryMajorReturnsReply=
  | {kind:'ready';ref:ReturnsRef;payload:MajorReturnsPackage}
  | {kind:'not-ready';ref:ReturnsRef};
