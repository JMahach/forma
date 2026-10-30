import {assign,fromPromise,raise,setup,type SnapshotFrom} from 'xstate';
import type {AccountChart,ChartWriteIntent,PublicAccountChart} from '../../shared/chart-record-contract.ts';
import type {SavedChart} from '../../shared/chart-types.ts';
import type {ChartActions,ChartActionResult} from '../state/chart-actions.ts';
import {chartSaveSourceKey,type ChartSaveSource} from '../domain/chart-record.ts';
import type {LibrarySession} from '../state/account-library.ts';

export type TemporaryWriteBinding=ChartWriteIntent & {sourceId:string};
export interface WriteContinuationPorts {
  actions:Pick<ChartActions,'saveSource'|'recover'|'pending'>;
  online():boolean;
  getSession():LibrarySession|null;
  ready():Promise<void>;
  selection:{readonly record:SavedChart|null;readonly selectedId:string;adopt(id:string,expectedId:string):boolean};
  temporary():SavedChart|null;
  hasOwn(id:string):boolean;
  initialBinding?:TemporaryWriteBinding|null;
  retire(source:SavedChart):void;
  public(id:string,signal?:AbortSignal):Promise<PublicAccountChart>;
  acceptPublic(chart:PublicAccountChart):void;
  clearPublic(id:string):boolean;
  view:{
    signIn():void;
    select(id:string):void;
    isChartScreen():boolean;
    showChart():void;
    publishChart(id:string):void;
    changeChart(id:string):void;
    refresh():void;
    changed():void;
    checkpoint():void;
    report(kind:'unconfirmed'|'unavailable'|'failed',error?:unknown):void;
  };
}
export type WriteEvent=
  | {type:'SaveRequested';source:SavedChart}
  | {type:'ResumeWrite'} | {type:'CancelWrite'} | {type:'RecoverWrites'} | {type:'Stop'} | {type:'ClearTemporaryWrite'};
type WriteInternalEvent=WriteEvent | {type:'SourcesReconciled';sources:SavedChart[]}
  | {type:'WriteBindingChanged';binding:TemporaryWriteBinding|null};
interface WriteWork {source:SavedChart;temporary:SavedChart|null;request:ChartSaveSource;key:string;session:LibrarySession|null}
type SaveStatus='done'|'waiting'|'unresolved';
interface WriteContext {work:WriteWork|null;binding:TemporaryWriteBinding|null}
interface BindingAccess {binding():TemporaryWriteBinding|null;bind(value:TemporaryWriteBinding|null):void}
function bindings(owner:{getSnapshot():{context:WriteContext};send(event:WriteInternalEvent):void}):BindingAccess {
  return {binding:()=>owner.getSnapshot().context.binding,bind:binding=>owner.send({type:'WriteBindingChanged',binding})};
}

function saveRequest(source:SavedChart):ChartSaveSource {
  const publicSource=source as SavedChart & {revision?:number};
  return typeof publicSource.revision==='number'
    ?{kind:'shared',chart:{...publicSource,revision:publicSource.revision}}:{kind:'temporary',chart:source};
}
function prepare(ports:WriteContinuationPorts,source:SavedChart):WriteWork {
  const request=saveRequest(source),session=ports.getSession();
  return {source,request,key:chartSaveSourceKey(request),temporary:ports.temporary()===source?source:null,
    session:session?{...session}:null};
}
function current(ports:WriteContinuationPorts,work:WriteWork) {
  const session=ports.getSession();
  return ports.selection.record===work.source && chartSaveSourceKey(saveRequest(work.source))===work.key
    && (!work.session || session?.accountId===work.session.accountId && session.sessionId===work.session.sessionId);
}
function adopt(ports:WriteContinuationPorts,binding:BindingAccess,chart:AccountChart,source:SavedChart,follow:boolean) {
  if(!('revision' in source)){binding.bind(null);ports.retire(source);}
  const selected=ports.selection.record===source;
  // Library acceptance/projecting precedes this identity change; never read it again.
  if(selected && ports.selection.adopt(chart.id,source.id)) {
    if(follow)ports.view.showChart();
    if(ports.view.isChartScreen())ports.view.publishChart(chart.id);
  } else if(follow)ports.view.select(chart.id);
  else if(selected)ports.view.changeChart(chart.id);
  if(!follow)ports.view.refresh();
  ports.view.checkpoint();
}
async function rejected(ports:WriteContinuationPorts,binding:BindingAccess,work:WriteWork,code:string,signal:AbortSignal) {
  if(binding.binding()?.sourceId===work.source.id)binding.bind(null);
  if(code==='source_changed') {
    const fresh=await ports.public(work.source.id,signal);if(signal.aborted || !current(ports,work))return;
    ports.acceptPublic(fresh);ports.view.select(fresh.id);
  } else if(code==='not_found')ports.view.select('current-transit');
  else ports.view.report('failed');
  ports.view.checkpoint();
}
async function finishSave(ports:WriteContinuationPorts,binding:BindingAccess,work:WriteWork,result:ChartActionResult,signal:AbortSignal):Promise<SaveStatus> {
  if(result.kind==='unknown'){ports.view.report('unconfirmed');return 'unresolved';}
  if(!result.active)return 'done';
  // Recovery may already have retired this same source while both callers
  // shared the outcome read. It owns the identity change in that case.
  if(work.temporary && ports.temporary()!==work.temporary)return 'done';
  if(result.receipt.outcome.kind==='rejected') {
    await rejected(ports,binding,work,result.receipt.outcome.code,signal);return 'done';
  }
  if(!result.chart){ports.view.report('unavailable');return 'unresolved';}
  adopt(ports,binding,result.chart,work.source,true);return 'done';
}
function bindIntent(ports:WriteContinuationPorts,binding:BindingAccess,source:SavedChart,intent:ChartWriteIntent|null) {
  if(ports.temporary()!==source)return;
  binding.bind(intent?{...intent,sourceId:source.id}:null);
  if(!intent)ports.view.checkpoint();
}
async function save(ports:WriteContinuationPorts,binding:BindingAccess,work:WriteWork,signal:AbortSignal):Promise<SaveStatus> {
  const live=()=>!signal.aborted && current(ports,work);
  try {
    await ports.ready();
    if(!live())return 'done';
    const session=ports.getSession();if(!session)return 'waiting';
    work={...work,session:work.session??{...session}};
    const bound=binding.binding();
    const intent=work.temporary && bound?.sourceId===work.source.id?bound:undefined;
    const result=await ports.actions.saveSource(work.request,{signal,isCurrent:live,intent,
      onIntent:intent=>bindIntent(ports,binding,work.source,intent),
    });
    if(!live())return 'done';
    return await finishSave(ports,binding,work,result,signal);
  }catch(error){if(live())ports.view.report('failed',error);return 'unresolved';}
}
function recoveryIntents(ports:WriteContinuationPorts,binding:TemporaryWriteBinding|null) {
  const pending=[...ports.actions.pending];
  if(binding && !pending.some(intent=>intent.operationId===binding.operationId && intent.expectedAccountId===binding.expectedAccountId))
    pending.push({operationId:binding.operationId,expectedAccountId:binding.expectedAccountId});
  return pending;
}
function stillBound(ports:WriteContinuationPorts,access:BindingAccess,binding:TemporaryWriteBinding|null,source:SavedChart|null,intent:ChartWriteIntent) {
  return binding && access.binding()===binding && binding.operationId===intent.operationId
    && binding.expectedAccountId===intent.expectedAccountId && ports.temporary()===source;
}
function reconcileBinding(ports:WriteContinuationPorts,binding:BindingAccess,source:SavedChart|null,result:Extract<ChartActionResult,{kind:'settled'}>):boolean {
  const outcome=result.receipt.outcome;
  if(outcome.kind==='rejected' || outcome.kind==='deleted' || outcome.kind==='absent') {
    binding.bind(null);ports.view.checkpoint();
  } else if(result.chart && source) {
    adopt(ports,binding,result.chart,source,false);return true;
  }
  return false;
}
function discardDeletedPublic(ports:WriteContinuationPorts,result:Extract<ChartActionResult,{kind:'settled'}>) {
  if(result.chart || result.readError)return;
  const outcome=result.receipt.outcome;
  if((outcome.kind==='deleted' || outcome.kind==='absent') && ports.clearPublic(outcome.chartId)) {
    if(ports.selection.selectedId===outcome.chartId && !ports.hasOwn(outcome.chartId)) {
      if(ports.view.isChartScreen())ports.view.select('current-transit');
      else ports.view.changeChart('current-transit');
    }
    ports.view.checkpoint();
  }
}
async function recover(ports:WriteContinuationPorts,accessor:BindingAccess,signal:AbortSignal):Promise<SavedChart[]> {
  const access=ports.getSession();if(!ports.online() || !access)return [];
  const binding=accessor.binding(),source=ports.temporary(),reconciled:SavedChart[]=[];
  for(const intent of recoveryIntents(ports,binding)) {
    if(signal.aborted)return reconciled;
    if(intent.expectedAccountId!==access.accountId)continue;
    try {
      const result=await ports.actions.recover(intent,signal);
      if(signal.aborted || result.kind!=='settled' || !result.active)continue;
      discardDeletedPublic(ports,result);
      if(stillBound(ports,accessor,binding,source,intent) && reconcileBinding(ports,accessor,source,result))reconciled.push(source!);
    }catch { /* A later explicit/reconnect lookup can resolve an unknown pointer; never resend. */ }
  }
  return reconciled;
}

/** One page-local continuation, alongside read-only recovery. No command queue or persisted payload. */
export function createWriteContinuationMachine(ports:WriteContinuationPorts) {
  return setup({
    types: {
      context: {} as WriteContext,
      events: {} as WriteInternalEvent,
    },
    actors: {
      signIn: fromPromise(async({signal})=>{
        // Publish waiting before navigation observes whether it may cancel Save.
        await Promise.resolve();if(!signal.aborted)ports.view.signIn();
      }),
      save: fromPromise<SaveStatus, {work:WriteWork;binding:BindingAccess}>(({input, signal}) => save(ports, input.binding, input.work, signal)),
      recover: fromPromise<SavedChart[],BindingAccess>(({input,signal}) => recover(ports, input, signal)),
    },
    actions: {
      choose: assign({
        work: ({context, event}) => {
          if (event.type !== 'SaveRequested' || context.work?.source === event.source) return context.work;
          return prepare(ports, event.source);
        },
      }),
      clear: assign({
        work: ({context}) => {
          return null;
        },
      }),
      reconciled: raise((_, params: {sources: SavedChart[]}): WriteInternalEvent =>
        ({type: 'SourcesReconciled', sources: params.sources})),
    },
  }).createMachine({
    id: 'write-continuation',
    context: ()=>({work:null,binding:ports?.initialBinding??null}),
    initial: 'running',
    states: {
      running: {
        type: 'parallel',
        on: {Stop: {target: 'stopped', actions: 'clear'},ClearTemporaryWrite:{actions:assign({binding:null})},WriteBindingChanged:{actions:assign({binding:({event})=>event.binding})}},
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
                  input: ({context,self}) => ({work:context.work!,binding:bindings(self)}),
                  onDone: [
                    {guard: ({event}) => event.output === 'waiting', target: 'waiting'},
                    {guard: ({event}) => event.output === 'unresolved', target: 'unresolved'},
                    {target: 'idle', actions: 'clear'},
                  ],
                  onError: {target: 'unresolved'},
                },
              },
              waiting: {invoke:{src:'signIn'},on: {ResumeWrite: 'working'}},
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
                  input:({self})=>bindings(self),
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
  return {source:work?.source??null,binding:snapshot.context.binding,busy:snapshot.matches({running:{save:'working'}}),
    waitingForLogin:snapshot.matches({running:{save:'waiting'}})};
}
