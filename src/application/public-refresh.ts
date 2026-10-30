import {assign,fromPromise,setup} from 'xstate';
import type {PublicAccountChart} from '../../shared/chart-record-contract.ts';
import type {LibrarySession} from '../state/account-library.ts';
import type {CheckAuthority} from '../domain/background-check.ts';
import type {CheckResult} from './background-work.ts';
import {validatePublicAccountChart} from '../domain/account-chart.ts';

export interface PublicRefreshPorts {
  source():PublicAccountChart|null;
  getSession():LibrarySession|null;
  available():boolean;
  read(id:string,signal:AbortSignal):Promise<PublicAccountChart>;
  accept(previous:PublicAccountChart,next:PublicAccountChart):void;
  missing(previous:PublicAccountChart):void;
}
export type PublicRefreshEvent={type:'RefreshPublicSource';authority?:CheckAuthority;completed?:(result:CheckResult)=>void}
 | {type:'CancelPublicRefresh'} | {type:'PublicSourceObserved';source:PublicAccountChart;access:LibrarySession|null;data:unknown};
interface RefreshRequest {source:PublicAccountChart;access:LibrarySession|null;authority?:CheckAuthority;completed?:(result:CheckResult)=>void}

function isCurrent(ports:PublicRefreshPorts,{source,access}:RefreshRequest,signal:AbortSignal) {
  if(signal.aborted || ports.source()!==source)return false;
  const session=ports.getSession();
  if(!access)return session===null;
  return session?.accountId===access.accountId && session.sessionId===access.sessionId;
}
async function refresh(ports:PublicRefreshPorts,request:RefreshRequest,signal:AbortSignal) {
  const {source}=request;
  signal=request.authority?AbortSignal.any([signal,request.authority.signal]):signal;
  try {
    const next=await ports.read(source.id,signal);
    if(!await canAccept(ports,request,signal))return cancelled();
    ports.accept(source,next);return {outcome:{kind:'success' as const},data:{chart:next}};
  } catch(error) {
    if(!await canAccept(ports,request,signal))return cancelled();
    return failedRead(ports,source,error);
  }
}
const cancelled=():CheckResult=>({outcome:{kind:'cancelled'}});
async function canAccept(ports:PublicRefreshPorts,request:RefreshRequest,signal:AbortSignal) {
 if(request.authority && !await request.authority.current())return false;
 return isCurrent(ports,request,signal);
}
function failedRead(ports:PublicRefreshPorts,source:PublicAccountChart,error:unknown):CheckResult {
 if((error as {code?:string})?.code==='not_found'){
  ports.missing(source);return {outcome:{kind:'success'},data:{missing:source.id,revision:source.revision}};
 }
 return {outcome:{kind:'failed',retryAfterMs:(error as {retryAfterMs?:number})?.retryAfterMs}};
}
function observe(ports:PublicRefreshPorts,event:Extract<PublicRefreshEvent,{type:'PublicSourceObserved'}>) {
 if(!ports.available() || !isCurrent(ports,event,new AbortController().signal))return;
 const data=event.data as {chart?:unknown;missing?:unknown;revision?:unknown}|null;
 if(publicAbsence(data,event.source)){ports.missing(event.source);return;}
 try{
  const chart=validatePublicAccountChart(data?.chart);
  if(chart.id===event.source.id && chart.revision>=event.source.revision)ports.accept(event.source,chart);
 }catch{/* A peer is a transport boundary, never a trusted chart parser. */}
}
function publicAbsence(data:{missing?:unknown;revision?:unknown}|null,source:PublicAccountChart){
 return data?.missing===source.id && typeof data.revision==='number' && Number.isSafeInteger(data.revision) && data.revision>=source.revision;
}

/** A workspace has no ownership over this read: only source, account and runtime do. */
export function createPublicRefreshMachine(ports:PublicRefreshPorts) {
  return setup({
    types: {
      context: {} as {request: RefreshRequest | null},
      events: {} as PublicRefreshEvent,
    },
    actors: {
      read: fromPromise(({input, signal}: {input: RefreshRequest; signal: AbortSignal}) =>
        refresh(ports, input, signal)),
    },
    guards: {available: () => !!ports.source() && ports.available()},
    actions: {
      capture: assign({request: ({event}) => ({source: ports.source()!, access: ports.getSession(),...(event.type==='RefreshPublicSource'?event:{})})}),
      clear: assign({request:null}),
      cancel:({context})=>context.request?.completed?.(cancelled()),
      observed:({event})=>{if(event.type==='PublicSourceObserved')observe(ports,event);},
      declined:({event})=>{if(event.type==='RefreshPublicSource')event.completed?.({outcome:{kind:'cancelled'}});},
    },
  }).createMachine({
    id: 'public-refresh',
    initial: 'idle',
    context: {request: null},
    on:{PublicSourceObserved:{actions:'observed'}},
    states: {
      idle: {
        on: {RefreshPublicSource: [{guard: 'available', target: 'reading', actions: 'capture'},{actions:'declined'}]},
      },
      reading: {
        on: {CancelPublicRefresh: {target: 'idle', actions: ['cancel','clear']},RefreshPublicSource:{actions:'declined'}},
        invoke: {
          src: 'read',
          input: ({context}) => context.request!,
          onDone: {target: 'idle', actions: [({context,event})=>context.request?.completed?.(event.output),'clear']},
          onError: {target: 'idle', actions: ['cancel','clear']},
        },
      },
    },
  });
}
