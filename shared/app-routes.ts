import { isChartIdentifier, canonicalChartId } from './chart-record-contract.ts';
export type AppRoute={kind:'transit'|'temporary-chart'|'account'|'charts'|'library'}|{kind:'chart';id:string};
const pages:Record<string,AppRoute['kind']>={'/':'transit','/chart':'temporary-chart','/account':'account','/charts':'charts','/library':'library'};
/** Paths choose a page, never grant access or imply a successful chart lookup. */
export function readAppRoute(pathname:unknown):AppRoute|null {
 if(typeof pathname!=='string')return null;
 if(Object.hasOwn(pages,pathname))return {kind:pages[pathname]} as AppRoute;
 if(!pathname.startsWith('/chart/'))return null;
 const id=pathname.slice('/chart/'.length);
 return isChartIdentifier(id)?{kind:'chart',id:canonicalChartId(id)}:null;
}
export function appRoutePath(route:AppRoute):string {
 if(route.kind==='chart'){
  if(!isChartIdentifier(route.id))throw new TypeError('invalid_chart');
  return '/chart/'+canonicalChartId(route.id);
 }
 const entry=Object.entries(pages).find(([,kind])=>kind===route.kind);
 if(!entry)throw new TypeError('invalid_route');
 return entry[0];
}
