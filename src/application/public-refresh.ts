import {assign,fromPromise,setup} from 'xstate';
import type {PublicAccountChart} from '../../shared/chart-record-contract.ts';
import type {LibrarySession} from '../state/account-library.ts';

export interface PublicRefreshPorts {
  source():PublicAccountChart|null;
  getSession():LibrarySession|null;
  available():boolean;
  read(id:string,signal:AbortSignal):Promise<PublicAccountChart>;
  accept(previous:PublicAccountChart,next:PublicAccountChart):void;
  missing(previous:PublicAccountChart):void;
}
export type PublicRefreshEvent={type:'RefreshPublicSource'}|{type:'CancelPublicRefresh'};
interface RefreshRequest {source:PublicAccountChart;access:LibrarySession|null}

function isCurrent(ports:PublicRefreshPorts,{source,access}:RefreshRequest,signal:AbortSignal) {
  if(signal.aborted || ports.source()!==source)return false;
  const session=ports.getSession();
  if(!access)return session===null;
  return session?.accountId===access.accountId && session.sessionId===access.sessionId;
}
async function refresh(ports:PublicRefreshPorts,request:RefreshRequest,signal:AbortSignal) {
  const {source}=request;
  try {
    const next=await ports.read(source.id,signal);
    if(isCurrent(ports,request,signal))ports.accept(source,next);
  } catch(error) {
    if(isCurrent(ports,request,signal) && (error as {code?:string})?.code==='not_found')ports.missing(source);
  }
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
      capture: assign({request: () => ({source: ports.source()!, access: ports.getSession()})}),
      clear: assign({request: null}),
    },
  }).createMachine({
    id: 'public-refresh',
    initial: 'idle',
    context: {request: null},
    states: {
      idle: {
        on: {RefreshPublicSource: {guard: 'available', target: 'reading', actions: 'capture'}},
      },
      reading: {
        on: {CancelPublicRefresh: {target: 'idle', actions: 'clear'}},
        invoke: {
          src: 'read',
          input: ({context}) => context.request!,
          onDone: {target: 'idle', actions: 'clear'},
          onError: {target: 'idle', actions: 'clear'},
        },
      },
    },
  });
}
