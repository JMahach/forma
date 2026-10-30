import {assign,fromPromise,sendParent,setup} from 'xstate';
import type {AccountAccess,AccountBoundaryRequest,AccountBoundaryWork,AccountEvent,AccountPort} from './ports.ts';
import type {AccountLibrary} from '../state/account-library.ts';

type CleanupResult={status:'cleared'|'pending'|'unavailable'};
interface BoundaryOperations {
  library:Pick<AccountLibrary,'accountId'|'connect'|'clear'|'retryClear'>;
  calculations?:{
    resetPersonal():Promise<CleanupResult>;
    retryPersonalCleanup():Promise<CleanupResult|null>;
  };
  readonly pendingWrites:readonly {expectedAccountId:string}[];
  readonly boundAccount:string|null;
  enter():void;
  logout(ids:readonly string[]):boolean;
  switchAccount(access:AccountAccess):void;
  flushSnapshot():boolean;
  settled():void;
}

function resetsPersonal(request:AccountBoundaryRequest,previous:string|null,ports:BoundaryOperations) {
  if(request.logoutIds)return true;
  const access=request.access;
  return !!access && (previous!==null && previous!==access.accountId
    || ports.pendingWrites.some(intent=>intent.expectedAccountId!==access.accountId)
    || ports.boundAccount!==null && ports.boundAccount!==access.accountId);
}
const cleanupUnavailable=()=>Object.assign(new Error('Account cleanup is not complete'),{code:'storage_unavailable'});
function requireCleanup(result:CleanupResult|null|undefined) {
  if(result && result.status!=='cleared')throw cleanupUnavailable();
}

/** The account actor owns this work; retries resume failed cleanup without resetting a new generation. */
class AccountCleanup implements AccountBoundaryWork {
  readonly ready:Promise<void>;
  private ports:BoundaryOperations;
  private connecting:Promise<void>;
  private cleared:Awaited<ReturnType<AccountLibrary['clear']>>|null=null;
  private snapshotReady=true;
  constructor(request:AccountBoundaryRequest,ports:BoundaryOperations) {
    this.ports=ports;
    const previous=ports.library.accountId;
    // Fence old readers synchronously, before any asynchronous continuation.
    const clearing=request.logoutIds?ports.library.clear():null;
    this.connecting=request.logoutIds?Promise.resolve():ports.library.connect(request.access);
    ports.enter();
    const reset=resetsPersonal(request,previous,ports);
    const cleanup=reset?ports.calculations?.resetPersonal():ports.calculations?.retryPersonalCleanup();
    if(request.logoutIds)this.snapshotReady=ports.logout(request.logoutIds);
    else if(reset && request.access)ports.switchAccount(request.access);
    this.ready=this.finish(clearing,cleanup);
  }
  private async finish(clearing:Promise<NonNullable<AccountCleanup['cleared']>>|null,cleanup:Promise<CleanupResult|null>|undefined) {
    await this.connecting;this.cleared=await clearing;
    requireCleanup(await cleanup);
    if(this.cleared?.status==='unavailable' || !this.snapshotReady)throw cleanupUnavailable();
  }
  private async retryLibrary() {
    if(this.cleared?.status!=='unavailable')return;
    if(!this.cleared.accountId)throw cleanupUnavailable();
    this.cleared={...this.cleared,status:await this.ports.library.retryClear(this.cleared.accountId)};
    if(this.cleared.status==='unavailable')throw cleanupUnavailable();
  }
  async retry() {
    await this.connecting;await this.retryLibrary();
    requireCleanup(await this.ports.calculations?.retryPersonalCleanup());
    // Read the current tab state, never replay the snapshot from a retired boundary.
    if(!this.snapshotReady)this.snapshotReady=this.ports.flushSnapshot();
    if(!this.snapshotReady)throw cleanupUnavailable();
  }
  settled(){this.ports.settled();}
}

export function createAccountBoundaryWork(request:AccountBoundaryRequest,ports:BoundaryOperations):AccountBoundaryWork {
  const work=new AccountCleanup(request,ports);
  return {ready:work.ready,retry:work.retry.bind(work),settled:work.settled.bind(work)};
}

interface Context {
  access: AccountAccess|null|undefined;
  lastAccess: AccountAccess|null;
  request: AccountBoundaryRequest|null;
  work: AccountBoundaryWork|null;
}
const accessKey=(access:AccountAccess|null|undefined)=>JSON.stringify(access);

function ownLogout(context:Context,event:AccountEvent) {
  return event.type==='LogoutObserved'
    && (!context.lastAccess || event.ids.includes(context.lastAccess.sessionId))
    && !context.request?.logoutIds?.every(id=>event.ids.includes(id));
}

export function createAccountBoundaryMachine(port:AccountPort,runtimeId:string) {
  let generation=0;
  return setup({
    types:{context:{} as Context,events:{} as AccountEvent},
    actors:{finish:fromPromise(({input}:{input:AccountBoundaryWork})=>input.ready)},
    guards:{
      changed:({context,event})=>event.type==='SessionChanged' && accessKey(event.access)!==accessKey(context.access),
      ownLogout:({context,event})=>ownLogout(context,event),
    },
    actions:{
      begin: assign(({context, event}) => {
        const access = event.type === 'SessionChanged' ? event.access : null;
        const request: AccountBoundaryRequest = {
          runtimeId,
          generation: ++generation,
          access,
          previous: context.lastAccess,
          logoutIds: event.type === 'LogoutObserved' ? event.ids : null,
        };
        return {access, lastAccess: access ?? context.lastAccess, request, work: port.begin(request)};
      }),
      retry:assign({work:({context})=>({...context.work!,ready:context.work!.retry()})}),
      settled:({context})=>context.work!.settled(),
      release:assign({work:null}),
    },
  }).createMachine({
    initial: 'unconnected',
    context: {access: undefined, lastAccess: null, request: null, work: null},
    on: {
      SessionChanged: {
        guard: 'changed',
        target: '.preparing',
        actions: ['begin', sendParent({type: 'AccountBoundaryStarted'})],
      },
      LogoutObserved: {
        guard: 'ownLogout',
        target: '.preparing',
        actions: ['begin', sendParent({type: 'AccountBoundaryStarted'})],
      },
    },
    states: {
      unconnected: {},
      preparing: {
        invoke: {
          src: 'finish',
          input: ({context}) => context.work!,
          onDone: {target: 'ready', actions: ['settled', 'release']},
          onError: 'failed',
        },
      },
      ready: {},
      failed: {on: {RetryAccountBoundary: {target: 'preparing', actions: 'retry'}}},
    },
  });
}
