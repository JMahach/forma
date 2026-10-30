import type {AppRoute} from '../../shared/app-routes.ts';
import type {ApplicationRuntimePorts as ApplicationPorts,NavigationPort,RoutePort,RouteRequest} from './ports.ts';

export const chartDestination=(route:AppRoute)=>route.kind==='chart' || route.kind==='temporary-chart' || route.kind==='transit';
export function routeForChart(port:RoutePort,id:string):AppRoute {
  const chart=port.sources.get(id);
  return id==='current-transit'?{kind:'transit'}
    :port.library.get(id) || chart && 'revision' in chart?{kind:'chart',id}:{kind:'temporary-chart'};
}
export function showChart(port:RoutePort,id:string,keepMenuOpen=false) {
  port.view.workspace('chart',keepMenuOpen);port.view.select(id);
  if(port.session.selectedId===id && port.library.get(id))port.view.markOpened(id);
  port.view.resetCamera();
}
export function publishRoute(port:RoutePort,navigation:NavigationPort|undefined,route:AppRoute,replace=false) {
  if(!navigation)return;
  port.view.interrupt();navigation.navigate(route,{replace,origin:'publication'});
}
const unavailable=(error:unknown)=>['offline','connection_failed','server_unavailable'].includes((error as {code?:string})?.code??'');
async function readPublicChart(port:RoutePort,id:string,signal:AbortSignal,current:()=>boolean) {
  const cached=port.sources.publicChart?.id===id?port.sources.publicChart:null;
  if(!port.online() && cached){port.sources.acceptPublic(cached);return;}
  let chart;const checkedAt=port.now();
  try{chart=await port.readPublic(id,signal);}
  catch(error){
    if(cached && unavailable(error)){
      if(current())port.sources.acceptPublic(cached);return;
    }
    throw error;
  }
  if(!current())return;
  port.sources.acceptPublic(chart);port.view.publicRead(checkedAt,port.now());
}
async function missing(ports:ApplicationPorts,request:RouteRequest,signal:AbortSignal) {
  const port=ports.route!,route=request.snapshot.route!;
  if(route.kind!=='chart')return;
  port.sources.clearPublic(route.id);showChart(port,'current-transit');
  publishRoute(port,ports.navigation,{kind:'transit'},true);port.view.checkpoint();
  if(!request.initial)return;
  port.view.settled();
  const redirected=ports.navigation!.snapshot,ready=await port.view.firstTransit();
  if(!signal.aborted && ports.navigation!.isCurrent(redirected))port.view.transitReady(ready!==false);
}

function localSelection(port:RoutePort,id:string) {
  return id==='current-transit' || id===port.sources.temporaryChart?.id || port.sources.charts.some(chart=>chart.id===id);
}
async function loadOpening(port:RoutePort,id:string,signal:AbortSignal,current:()=>boolean,ready:()=>Promise<void>|void) {
  const pending=ready();if(pending)await pending;
  if(!current())return false;
  if(port.library.has(id))await port.library.open(id,signal);else await readPublicChart(port,id,signal,current);
  return current();
}
function prepareOpening(port:RoutePort,request:RouteRequest,signal:AbortSignal,current:()=>boolean,ready:()=>Promise<void>|void):boolean|Promise<boolean> {
  if(request.selection){
    const id=request.selection.id;
    return port.library.has(id)?loadOpening(port,id,signal,current,ready):localSelection(port,id);
  }
  const route=request.snapshot.route!;
  return route.kind==='chart'?loadOpening(port,route.id,signal,current,ready):true;
}
function applyOpening(ports:ApplicationPorts,request:RouteRequest) {
  const port=ports.route!,selection=request.selection;
  if(selection){
    if(selection.edit)port.view.edit(selection.id);
    else {showChart(port,selection.id,selection.keepMenuOpen);publishRoute(port,ports.navigation,routeForChart(port,selection.id));}
    return;
  }
  const route=request.snapshot.route!;
  if(request.initial || !chartDestination(route))return;
  const id=route.kind==='chart'?route.id:route.kind==='temporary-chart'?port.sources.temporaryChart?.id??'current-transit':'current-transit';
  showChart(port,id);
}
function observeOpening(port:RoutePort,request:RouteRequest,signal:AbortSignal) {
  const observation=request.selection || request.snapshot.route?.kind==='chart'
    ?port.observe(request.selection?'storage_read':'request'):null;
  let disposed=false;
  const dispose=()=>{if(!disposed){disposed=true;observation?.finish();}};
  signal.addEventListener('abort',dispose,{once:true});
  return {failed:(error:unknown)=>observation?.failed(error),finish(){signal.removeEventListener('abort',dispose);dispose();}};
}
async function failedOpening(ports:ApplicationPorts,request:RouteRequest,signal:AbortSignal,error:unknown) {
  ports.route!.view.report(error);
  if(!request.selection && request.snapshot.route?.kind==='chart' && (error as {code?:string})?.code==='not_found'){
    await missing(ports,request,signal);return 'redirected';
  }
  return 'failed';
}

function currentOpening(ports:ApplicationPorts,request:RouteRequest,signal:AbortSignal) {
  return !signal.aborted && (!!request.selection || ports.navigation!.isCurrent(request.snapshot));
}

/** The same opening policy runs with browser or non-DOM effects. */
export async function prepareRoute(ports:ApplicationPorts,request:RouteRequest,signal:AbortSignal,ready:()=>Promise<void>|void) {
  const current=()=>currentOpening(ports,request,signal);
  if(!current())return 'cancelled';
  const port=ports.route!,observation=observeOpening(port,request,signal);
  try {
    const prepared=prepareOpening(port,request,signal,current,ready);
    const available=typeof prepared==='boolean'?prepared:await prepared;
    if(!available || !current())return 'cancelled';
    applyOpening(ports,request);return 'ready';
  }catch(error){
    if(!current())return 'cancelled';
    observation.failed(error);return await failedOpening(ports,request,signal,error);
  }finally{
    try{if(current() && !request.initial)port.view.settled();}finally{observation.finish();}
  }
}
