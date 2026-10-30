import {assign,fromPromise,sendParent,setup} from 'xstate';
import type {AccountAccess,AccountBoundaryRequest,AccountBoundaryWork,AccountEvent,AccountPort,AccountJournal,AccountBoundaryOperations,AccountCleanupResult} from './ports.ts';
function foreignDraft(draft:AccountBoundaryOperations['form']['snapshot'],accountId:string) {
  return draft?.accountId!=null && draft.accountId!==accountId;
}
function resetContinuation(ports:AccountBoundaryOperations,access:AccountAccess|null) {
  const form=ports.form;
  if(!access || foreignDraft(form.pending,access.accountId))form.clearPending();
  ports.binding.clear();ports.writes.clear();ports.editing.reset();ports.selection.cancel();
  if(!access){form.discardInput();form.close();return ports.checkpoint.clearPersonal();}
  if(form.opened && (!form.snapshot || foreignDraft(form.snapshot,access.accountId)))form.close();
  return true;
}

function resetsPersonal(request:AccountBoundaryRequest,previous:string|null,ports:AccountBoundaryOperations) {
  if(request.logoutIds)return true;
  const access=request.access;
  return !!access && (previous!==null && previous!==access.accountId
    || ports.writes.pending.some(intent=>intent.expectedAccountId!==access.accountId)
    || ports.binding.accountId!==null && ports.binding.accountId!==access.accountId);
}
const cleanupUnavailable=()=>Object.assign(new Error('Account cleanup is not complete'),{code:'storage_unavailable'});
function requireCleanup(result:AccountCleanupResult|null|undefined) {
  if(result && result.status!=='cleared')throw cleanupUnavailable();
}

/** The account actor owns this work; retries resume failed cleanup without resetting a new generation. */
class AccountCleanup implements AccountBoundaryWork {
  readonly ready:Promise<void>;
  readonly reset:boolean;
  private ports:AccountBoundaryOperations;
  private connecting:Promise<void>;
  private cleared:Awaited<ReturnType<AccountBoundaryOperations['library']['clear']>>|null=null;
  private snapshotReady=true;
  constructor(request:AccountBoundaryRequest,ports:AccountBoundaryOperations) {
    this.ports=ports;
    const previous=ports.library.accountId;
    // Fence old readers synchronously, before any asynchronous continuation.
    const clearing=request.logoutIds?ports.library.clear():null;
    this.connecting=request.logoutIds?Promise.resolve():ports.library.connect(request.access);
    ports.closeDelete();
    const reset=this.reset=resetsPersonal(request,previous,ports);
    const cleanup=reset?ports.calculations?.resetPersonal():ports.calculations?.retryPersonalCleanup();
    if(reset)this.snapshotReady=resetContinuation(ports,request.logoutIds?null:request.access);
    this.ready=this.finish(clearing,cleanup);
  }
  private async finish(clearing:Promise<NonNullable<AccountCleanup['cleared']>>|null,cleanup:Promise<AccountCleanupResult|null>|undefined) {
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
    if(!this.snapshotReady)this.snapshotReady=this.ports.checkpoint.flush();
    if(!this.snapshotReady)throw cleanupUnavailable();
  }
}

export function createAccountBoundaryWork(request:AccountBoundaryRequest,ports:AccountBoundaryOperations):AccountBoundaryWork {
  return new AccountCleanup(request,ports);
}

interface Context {
  access: AccountAccess|null|undefined;
  lastAccess: AccountAccess|null;
  request: AccountBoundaryRequest|null;
  work: AccountBoundaryWork|null;
  journal:AccountJournal|null;
  departedIds:readonly string[]|null;
}
const accessKey=(access:AccountAccess|null|undefined)=>JSON.stringify(access);
function setJournalAccount(journal:AccountJournal,access:AccountAccess|null|undefined) {
  journal.setAccount(access?.accountId??null,access?.sessionId,access?.diagnosticProof);
}
function observeJournal(context:Context,request:AccountBoundaryRequest) {
  const next=request.access,previous=context.lastAccess;
  const departed=request.logoutIds??(previous && next && previous.accountId!==next.accountId?[previous.sessionId]:null);
  if(context.journal){
    setJournalAccount(context.journal,next);
    if(request.logoutIds)context.journal.leave(request.logoutIds);
    return null;
  }
  return departed?[...new Set([...(context.departedIds??[]),...departed])]:context.departedIds;
}
function attachJournal(context:Context,journal:AccountJournal) {
  const prior=context.lastAccess,current=context.access;
  if(prior)journal.setAccount(prior.accountId,prior.sessionId,prior.diagnosticProof);
  if(context.departedIds)journal.leave(context.departedIds);
  if(!prior || current?.accountId!==prior.accountId || context.departedIds)
    setJournalAccount(journal,current);
}


function ownLogout(context:Context,event:AccountEvent) {
  return event.type==='LogoutObserved'
    && (!context.lastAccess || event.ids.includes(context.lastAccess.sessionId))
    && !context.request?.logoutIds?.every(id=>event.ids.includes(id));
}

export function createAccountBoundaryMachine(port:AccountPort,runtimeId:string,sources:()=>Promise<void>) {
  let generation=0;
  return setup({
    types:{context:{} as Context,events:{} as AccountEvent},
    actors:{finish:fromPromise(async({input}:{input:AccountBoundaryWork})=>{await input.ready;await sources();})},
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
        return {access, lastAccess: access ?? context.lastAccess, request, work:createAccountBoundaryWork(request,port),departedIds:observeJournal(context,request)};
      }),
      retry:assign({work:({context})=>({reset:context.work!.reset,ready:context.work!.retry(),retry:context.work!.retry.bind(context.work)})}),
      attach:assign(({context,event})=>{
        if(event.type!=='JournalAttached' || context.journal===event.journal)return {};
        attachJournal(context,event.journal);return {journal:event.journal,departedIds:null};
      }),
      release:assign({work:null}),
    },
  }).createMachine({
    initial: 'unconnected',
    context: {access: undefined, lastAccess: null, request: null, work: null,journal:port?.journal??null,departedIds:null},
    on: {
      JournalAttached:{actions:'attach'},
      SessionChanged: {
        guard: 'changed',
        target: '.preparing',
        actions: ['begin', sendParent(({context})=>({type:'AccountBoundaryStarted',reset:context.work!.reset}))],
      },
      LogoutObserved: {
        guard: 'ownLogout',
        target: '.preparing',
        actions: ['begin', sendParent(({context})=>({type:'AccountBoundaryStarted',reset:context.work!.reset}))],
      },
    },
    states: {
      unconnected: {},
      preparing: {
        invoke: {
          src: 'finish',
          input: ({context}) => context.work!,
          onDone: {target: 'ready', actions:'release'},
          onError: 'failed',
        },
      },
      ready: {},
      failed: {on: {RetryAccountBoundary: {target: 'preparing', actions: 'retry'}}},
    },
  });
}
