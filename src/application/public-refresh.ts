import {assign,fromPromise,setup} from 'xstate';
import type {PublicAccountChart} from '../../shared/chart-record-contract.ts';
import type {LibrarySession} from '../state/account-library.ts';
import type {CheckAuthority,CheckTarget} from '../domain/background-check.ts';
import type {CheckResult} from './background-work.ts';
import {validatePublicAccountChart} from '../domain/account-chart.ts';

export interface PublicRefreshPorts {
 sources:{readonly publicChart:PublicAccountChart|null;acceptPublic(chart:PublicAccountChart):unknown;clearPublic(id:string):unknown};
 session:{readonly selectedId:string;refreshRecord(change:(id:string)=>void):unknown};
 library:{has(id:string):boolean;get(id:string):unknown};
 getSession():LibrarySession|null;
 read(id:string,signal:AbortSignal):Promise<PublicAccountChart>;
 id():string;
 view:{isChartScreen():boolean;selectTransit():void;changeChart(id:string):void;refresh():void;checkpoint():void};
}
export type PublicRefreshEvent={type:'RefreshPublicSource';authority?:CheckAuthority;completed?:(result:CheckResult)=>void}
 | {type:'CancelPublicRefresh'} | {type:'PublicRefreshChanged'}
 | {type:'PublicSourceRead';source:PublicAccountChart;checkedAt:number;receivedAt:number}
 | {type:'PublicSourceObserved';source:PublicAccountChart;access:LibrarySession|null;data:unknown};
interface RefreshRequest {source:PublicAccountChart;access:LibrarySession|null;authority?:CheckAuthority;completed?:(result:CheckResult)=>void}
interface PublicCheck {source:PublicAccountChart;access:LibrarySession|null;target:CheckTarget}
interface Reply {result:CheckResult;next?:PublicAccountChart;missing?:boolean}
interface FreshRead {source:PublicAccountChart;access:LibrarySession|null;checkedAt:number;receivedAt:number}
interface Context {request:RefreshRequest|null;check:PublicCheck|null;reply:Reply|null;fresh:FreshRead|null}
const cancelled=():Reply=>({result:{outcome:{kind:'cancelled'}}});
const sameAccess=(a:LibrarySession|null,b:LibrarySession|null)=>a?.accountId===b?.accountId && a?.sessionId===b?.sessionId;
function isCurrent(ports:PublicRefreshPorts,{source,access}:Pick<RefreshRequest,'source'|'access'>,signal?:AbortSignal) {
 return !signal?.aborted && ports.sources.publicChart===source && sameAccess(ports.getSession(),access);
}
function tracking(ports:PublicRefreshPorts,previous:PublicCheck|null):PublicCheck|null {
 const source=ports.sources.publicChart,access=ports.getSession();
 if(!source || source.id!==ports.session.selectedId || ports.library.has(source.id))return null;
 if(previous?.source===source && sameAccess(previous.access,access))return previous;
 return {source,access,target:{key:`public:${source.id}`,scope:{kind:'public',chartId:source.id},instance:ports.id()}};
}
async function canAccept(ports:PublicRefreshPorts,request:RefreshRequest,signal:AbortSignal) {
 if(request.authority && !await request.authority.current())return false;
 return isCurrent(ports,request,signal);
}
async function refresh(ports:PublicRefreshPorts,request:RefreshRequest,fresh:FreshRead|null,signal:AbortSignal):Promise<Reply> {
 signal=request.authority?AbortSignal.any([signal,request.authority.signal]):signal;
 try {
  if(fresh && request.authority && request.authority.permit.startedAt>=fresh.receivedAt
   && request.authority.permit.startedAt-fresh.receivedAt<2000) {
   return await canAccept(ports,request,signal)?{result:{outcome:{kind:'success',checkedAt:fresh.checkedAt},data:{chart:request.source}}}:cancelled();
  }
  const next=await ports.read(request.source.id,signal);
  if(!await canAccept(ports,request,signal))return cancelled();
  return {next,result:{outcome:{kind:'success'},data:{chart:next}}};
 }catch(error){
  if(!await canAccept(ports,request,signal))return cancelled();
  if((error as {code?:string})?.code==='not_found')return {missing:true,result:{outcome:{kind:'success'},data:{missing:request.source.id,revision:request.source.revision}}};
  return {result:{outcome:{kind:'failed',retryAfterMs:(error as {retryAfterMs?:number})?.retryAfterMs}}};
 }
}
function peerReply(event:Extract<PublicRefreshEvent,{type:'PublicSourceObserved'}>):Reply {
 const data=event.data as {chart?:unknown;missing?:unknown;revision?:unknown}|null;
 if(data?.missing===event.source.id && typeof data.revision==='number' && Number.isSafeInteger(data.revision) && data.revision>=event.source.revision)
  return {missing:true,result:{outcome:{kind:'success'}}};
 try {
  const next=validatePublicAccountChart(data?.chart);
  if(next.id===event.source.id && next.revision>=event.source.revision)return {next,result:{outcome:{kind:'success'}}};
 }catch{/* A peer is a transport boundary, never a trusted chart parser. */}
 return cancelled();
}
function accept(ports:PublicRefreshPorts,check:PublicCheck|null,request:Pick<RefreshRequest,'source'|'access'> & Partial<Pick<RefreshRequest,'authority'>>,reply:Reply) {
 if(!isCurrent(ports,request,request.authority?.signal))return {reply:cancelled()};
 if(reply.next){
  ports.sources.acceptPublic(reply.next);
  // Advance the same check before view effects can publish another background change.
  return {reply,fresh:null,check:check?.source===request.source?{...check,source:ports.sources.publicChart!}:check};
 }
 if(reply.missing){ports.sources.clearPublic(request.source.id);return {reply,check:null,fresh:null};}
 return {reply};
}
function present(ports:PublicRefreshPorts,request:Pick<RefreshRequest,'source'>|null,reply:Reply|null) {
 if(!request || !reply || (!reply.next && !reply.missing))return;
 const selected=ports.session.selectedId===request.source.id && !ports.library.get(request.source.id);
 if(reply.next){if(selected)ports.session.refreshRecord(ports.view.changeChart);else ports.view.refresh();}
 else if(selected){if(ports.view.isChartScreen())ports.view.selectTransit();else ports.view.changeChart('current-transit');}
 else ports.view.refresh();
 ports.view.checkpoint();
}

/** Source identity, freshness and acceptance belong to this owner in every environment. */
export function createPublicRefreshMachine(ports:PublicRefreshPorts,admitted:()=>boolean) {
 return setup({
  types:{context:{} as Context,events:{} as PublicRefreshEvent},
  actors:{read:fromPromise(({input,signal}:{input:{request:RefreshRequest;fresh:FreshRead|null};signal:AbortSignal})=>refresh(ports,input.request,input.fresh,signal))},
  guards:{available:()=>admitted() && !!ports.sources.publicChart && ports.sources.publicChart.id===ports.session.selectedId && !ports.library.get(ports.session.selectedId)},
  actions:{
   track:assign(({context})=>({check:tracking(ports,context.check),fresh:context.fresh?.source===ports.sources.publicChart?context.fresh:null})),
   fresh:assign({fresh:({context,event})=>event.type==='PublicSourceRead' && ports.sources.publicChart===event.source?{source:event.source,access:ports.getSession(),checkedAt:event.checkedAt,receivedAt:event.receivedAt}:context.fresh}),
   capture:assign({request:({event})=>({source:ports.sources.publicChart!,access:ports.getSession(),...(event.type==='RefreshPublicSource'?event:{})})}),
   clear:assign({request:null,reply:null}),
   cancel:({context})=>context.request?.completed?.(cancelled().result),
   observed:assign(({context,event})=>event.type==='PublicSourceObserved' && admitted()
    ?accept(ports,context.check,event,peerReply(event)):{reply:cancelled()}),
   present:({context,event})=>present(ports,event.type==='PublicSourceObserved'?event:context.request,context.reply),
   declined:({event})=>{if(event.type==='RefreshPublicSource')event.completed?.(cancelled().result);},
  },
 }).createMachine({
  id:'public-refresh',initial:'idle',context:{request:null,check:null,reply:null,fresh:null},
  on:{PublicRefreshChanged:{actions:'track'},PublicSourceRead:{actions:'fresh'},PublicSourceObserved:{actions:['observed','present']}},
  states:{
   idle:{on:{RefreshPublicSource:[{guard:'available',target:'reading',actions:['track','capture']},{actions:'declined'}]}},
   reading:{on:{CancelPublicRefresh:{target:'idle',actions:['cancel','clear']},RefreshPublicSource:{actions:'declined'}},
    invoke:{src:'read',input:({context})=>({request:context.request!,fresh:context.fresh?.source===context.request!.source && sameAccess(context.fresh.access,context.request!.access)?context.fresh:null}),
     onDone:{target:'idle',actions:[assign(({context,event})=>accept(ports,context.check,context.request!,event.output)),'present',
      ({context})=>context.request?.completed?.(context.reply!.result),'clear']},
     onError:{target:'idle',actions:['cancel','clear']}}},
  },
 });
}
export function publicRefreshCheck(snapshot:{context:Context}) {return snapshot.context.check;}
