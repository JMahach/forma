import { readAppRoute,appRoutePath,type AppRoute } from '../../../shared/app-routes.ts';
import type { NavigationOrigin, NavigationSnapshot } from '../../application/ports.ts';
interface Options {
 location:Pick<Location,'pathname'>;
 history:Pick<History,'pushState'|'replaceState'>;
 events:Pick<EventTarget,'addEventListener'|'removeEventListener'>;
}
/** Owns browser location only. Data, permission, restoration and rendering stay with their owners. */
export function createNavigation({location,history,events}:Options) {
 let destroyed=false,revision=0,snapshot:NavigationSnapshot=makeSnapshot();
 const listeners=new Set<(snapshot:NavigationSnapshot,origin:NavigationOrigin)=>void>();
 function makeSnapshot():NavigationSnapshot {
  const route=readAppRoute(location.pathname);
  return Object.freeze({route:route?Object.freeze(route):null,revision});
 }
 function changed(origin:NavigationOrigin='external'){
  if(destroyed)return;
  revision++;snapshot=makeSnapshot();
  for(const listener of listeners)listener(snapshot,origin);
 }
 const popped=()=>changed();
 events.addEventListener('popstate',popped);
 return {
  get snapshot(){return snapshot;},
  isCurrent(value:NavigationSnapshot){return !destroyed && value===snapshot;},
  navigate(route:AppRoute,{replace=false,origin='external'}:{replace?:boolean;origin?:NavigationOrigin}={}):boolean {
   if(destroyed)return false;
   const pathname=appRoutePath(route);
   if(location.pathname===pathname)return false;
   // URL/history contain only the route. Chart payloads and private drafts never enter history state.
   if(replace)history.replaceState(null,'',pathname);else history.pushState(null,'',pathname);
   changed(origin);return true;
  },
  subscribe(listener:(snapshot:NavigationSnapshot,origin:NavigationOrigin)=>void){
   if(destroyed)return()=>{};
   listeners.add(listener);return()=>listeners.delete(listener);
  },
  destroy(){destroyed=true;listeners.clear();events.removeEventListener('popstate',popped);},
 };
}

export type Navigation = ReturnType<typeof createNavigation>;
