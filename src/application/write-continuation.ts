import {assign,fromPromise,raise,setup,type SnapshotFrom} from 'xstate';
import type {AccountChart,ChartWriteIntent,PublicAccountChart} from '../../shared/chart-record-contract.ts';
import type {SavedChart} from '../../shared/chart-types.ts';
import type {ChartActions,ChartSaveAction,ChartActionResult,ChartSaveResult} from '../state/chart-actions.ts';
import type {LibrarySession} from '../state/account-library.ts';

export type TemporaryWriteBinding=ChartWriteIntent & {sourceId:string};
export interface WriteContinuationPorts {
  actions:Pick<ChartActions,'prepareSave'|'recover'|'pending'>;
  online():boolean;
  getSession():LibrarySession|null;
  ready():Promise<void>;
  source():SavedChart|null;
  temporary():SavedChart|null;
  hasOwn(id:string):boolean;
  binding():TemporaryWriteBinding|null;
  bind(value:TemporaryWriteBinding|null):void;
  retire(source:SavedChart):void;
  public(id:string,signal?:AbortSignal):Promise<PublicAccountChart>;
  acceptPublic(chart:PublicAccountChart):void;
  clearPublic(id:string):boolean;
  view:{
    signIn():void;
    select(id:string):void;
    /** The library has accepted and synchronously projected the record before this call. */
    adopt(chart:AccountChart,source:SavedChart,follow:boolean):void;
    deleted(id:string):void;
    changed():void;
    checkpoint():void;
    report(kind:'unconfirmed'|'unavailable'|'failed',error?:unknown):void;
  };
}
export type WriteEvent=
  | {type:'SaveRequested';source:SavedChart}
  | {type:'ResumeWrite'} | {type:'CancelWrite'} | {type:'RecoverWrites'} | {type:'Stop'}
  | {type:'SourcesReconciled';sources:SavedChart[]};
interface WriteWork {source:SavedChart;temporary:SavedChart|null;action:ChartSaveAction}
type SaveStatus='done'|'waiting'|'unresolved';

function prepare(ports:WriteContinuationPorts,source:SavedChart):WriteWork {
  const publicSource=source as SavedChart & {revision?:number};
  const temporary=ports.temporary()===source?source:null;
  const binding=temporary && ports.binding()?.sourceId===source.id?ports.binding():null;
  const action=ports.actions.prepareSave(typeof publicSource.revision==='number'
    ?{kind:'shared',chart:{...publicSource,revision:publicSource.revision}}:{kind:'temporary',chart:source},
    ()=>ports.source()===source,{
      intent:binding??undefined,
      onIntent(intent){
        if(ports.temporary()!==source)return;
        ports.bind(intent?{...intent,sourceId:source.id}:null);
        if(!intent)ports.view.checkpoint();
      },
    });
  return {source,temporary,action};
}
function adopt(ports:WriteContinuationPorts,chart:AccountChart,source:SavedChart,follow:boolean) {
  if(!('revision' in source)){ports.bind(null);ports.retire(source);}
  ports.view.adopt(chart,source,follow);
  ports.view.checkpoint();
}
async function rejected(ports:WriteContinuationPorts,work:WriteWork,code:string,signal:AbortSignal) {
  if(ports.binding()?.sourceId===work.source.id)ports.bind(null);
  if(code==='source_changed') {
    const fresh=await ports.public(work.source.id,signal);if(signal.aborted)return;
    ports.acceptPublic(fresh);ports.view.select(fresh.id);
  } else if(code==='not_found')ports.view.select('current-transit');
  else ports.view.report('failed');
  ports.view.checkpoint();
}
async function finishSave(ports:WriteContinuationPorts,work:WriteWork,result:ChartSaveResult,signal:AbortSignal):Promise<SaveStatus> {
  if(result.kind==='sign-in'){ports.view.signIn();return 'waiting';}
  if(result.kind==='unknown'){ports.view.report('unconfirmed');return 'unresolved';}
  if(result.kind!=='settled' || !result.active)return 'done';
  // Recovery may already have retired this same source while both callers
  // shared the outcome read. It owns the identity change in that case.
  if(work.temporary && ports.temporary()!==work.temporary)return 'done';
  if(result.receipt.outcome.kind==='rejected') {
    await rejected(ports,work,result.receipt.outcome.code,signal);return 'done';
  }
  if(!result.chart){ports.view.report('unavailable');return 'unresolved';}
  adopt(ports,result.chart,work.source,true);return 'done';
}
async function save(ports:WriteContinuationPorts,work:WriteWork,signal:AbortSignal):Promise<SaveStatus> {
  try {
    await ports.ready();if(signal.aborted)return 'done';
    const result=await work.action.run();if(signal.aborted)return 'done';
    return await finishSave(ports,work,result,signal);
  }catch(error){if(!signal.aborted)ports.view.report('failed',error);return 'unresolved';}
}
function recoveryIntents(ports:WriteContinuationPorts,binding:TemporaryWriteBinding|null) {
  const pending=[...ports.actions.pending];
  if(binding && !pending.some(intent=>intent.operationId===binding.operationId && intent.expectedAccountId===binding.expectedAccountId))
    pending.push({operationId:binding.operationId,expectedAccountId:binding.expectedAccountId});
  return pending;
}
function stillBound(ports:WriteContinuationPorts,binding:TemporaryWriteBinding|null,source:SavedChart|null,intent:ChartWriteIntent) {
  return binding && ports.binding()===binding && binding.operationId===intent.operationId
    && binding.expectedAccountId===intent.expectedAccountId && ports.temporary()===source;
}
function reconcileBinding(ports:WriteContinuationPorts,source:SavedChart|null,result:Extract<ChartActionResult,{kind:'settled'}>):boolean {
  const outcome=result.receipt.outcome;
  if(outcome.kind==='rejected' || outcome.kind==='deleted' || outcome.kind==='absent') {
    ports.bind(null);ports.view.checkpoint();
  } else if(result.chart && source) {
    adopt(ports,result.chart,source,false);return true;
  }
  return false;
}
function discardDeletedPublic(ports:WriteContinuationPorts,outcome:Extract<ChartActionResult,{kind:'settled'}>['receipt']['outcome']) {
  if((outcome.kind==='deleted' || outcome.kind==='absent') && ports.clearPublic(outcome.chartId)) {
    ports.view.deleted(outcome.chartId);ports.view.checkpoint();
  }
}
async function recover(ports:WriteContinuationPorts,signal:AbortSignal):Promise<SavedChart[]> {
  const access=ports.getSession();if(!ports.online() || !access)return [];
  const binding=ports.binding(),source=ports.temporary(),reconciled:SavedChart[]=[];
  for(const intent of recoveryIntents(ports,binding)) {
    if(signal.aborted)return reconciled;
    if(intent.expectedAccountId!==access.accountId)continue;
    try {
      const result=await ports.actions.recover(intent,signal);
      if(signal.aborted || result.kind!=='settled' || !result.active)continue;
      discardDeletedPublic(ports,result.receipt.outcome);
      if(stillBound(ports,binding,source,intent) && reconcileBinding(ports,source,result))reconciled.push(source!);
    }catch { /* A later explicit/reconnect lookup can resolve an unknown pointer; never resend. */ }
  }
  return reconciled;
}

/** One page-local continuation, alongside read-only recovery. No command queue or persisted payload. */
export function createWriteContinuationMachine(ports:WriteContinuationPorts) {
  return setup({
    types: {
      context: {} as {work: WriteWork | null},
      events: {} as WriteEvent,
    },
    actors: {
      save: fromPromise<SaveStatus, WriteWork>(({input, signal}) => save(ports, input, signal)),
      recover: fromPromise<SavedChart[]>(({signal}) => recover(ports, signal)),
    },
    actions: {
      choose: assign({
        work: ({context, event}) => {
          if (event.type !== 'SaveRequested' || context.work?.source === event.source) return context.work;
          context.work?.action.cancel();
          return prepare(ports, event.source);
        },
      }),
      clear: assign({
        work: ({context}) => {
          context.work?.action.cancel();
          return null;
        },
      }),
      reconciled: raise((_, params: {sources: SavedChart[]}): WriteEvent =>
        ({type: 'SourcesReconciled', sources: params.sources})),
    },
  }).createMachine({
    id: 'write-continuation',
    context: {work: null},
    initial: 'running',
    states: {
      running: {
        type: 'parallel',
        on: {Stop: {target: 'stopped', actions: 'clear'}},
        states: {
          save: {
            id: 'write-save',
            initial: 'idle',
            on: {
              SaveRequested: {
                guard: ({event}) => ports.online() && !ports.hasOwn(event.source.id),
                target: '.working',
                reenter: true,
                actions: 'choose',
              },
              CancelWrite: {target: '.idle', actions: 'clear'},
              SourcesReconciled: {
                guard: ({context, event}) => !!context.work && event.sources.includes(context.work.source),
                target: '.idle',
                actions: 'clear',
              },
            },
            states: {
              idle: {},
              working: {
                on: {
                  SaveRequested: [
                    {
                      guard: ({context, event}) => context.work?.source !== event.source
                        && ports.online() && !ports.hasOwn(event.source.id),
                      target: 'working',
                      reenter: true,
                      actions: 'choose',
                    },
                    {},
                  ],
                },
                invoke: {
                  src: 'save',
                  input: ({context}) => context.work!,
                  onDone: [
                    {guard: ({event}) => event.output === 'waiting', target: 'waiting'},
                    {guard: ({event}) => event.output === 'unresolved', target: 'unresolved'},
                    {target: 'idle', actions: 'clear'},
                  ],
                  onError: {target: 'unresolved'},
                },
              },
              waiting: {on: {ResumeWrite: 'working'}},
              unresolved: {},
            },
          },
          recovery: {
            initial: 'idle',
            states: {
              idle: {on: {RecoverWrites: 'reading'}},
              reading: {
                invoke: {
                  src: 'recover',
                  onDone: {
                    target: 'idle',
                    actions: {type: 'reconciled', params: ({event}) => ({sources: event.output})},
                  },
                  onError: 'idle',
                },
              },
            },
          },
        },
      },
      stopped: {type: 'final'},
    },
  });
}
export function writeContinuationView(snapshot:SnapshotFrom<ReturnType<typeof createWriteContinuationMachine>>) {
  const work=snapshot.context.work;
  return {source:work?.source??null,busy:snapshot.matches({running:{save:'working'}}),
    waitingForLogin:work?.action.waitingForLogin??false};
}
