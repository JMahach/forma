import { assign, enqueueActions, fromCallback, fromPromise, sendTo, setup, type ActorRefFrom, type SnapshotFrom } from 'xstate';
import {prepareRoute,chartDestination,showChart,routeForChart,publishRoute} from './route.ts';
import { createAccountBoundaryMachine } from './account-boundary.ts';
import { createStartupMachine,startupView,type StartupRuntime } from './startup.ts';
import { createPublicRefreshMachine,publicRefreshCheck } from './public-refresh.ts';
import {createWriteContinuationMachine,writeContinuationView} from './write-continuation.ts';
import {createBackgroundWork,type BackgroundTask} from './background-work.ts';
import {createLibraryFill} from './library-fill.ts';
import {createLibraryLocalAudit} from './library-local-audit.ts';
import type { ApplicationEvent, ApplicationRuntimePorts as ApplicationPorts, RouteRequest, NavigationPort } from './ports.ts';

type Event = ApplicationEvent | {type: 'Start'} | {type: 'Stop'} | {type:'AccountBoundaryStarted';reset:boolean}
 | {type:'xstate.snapshot.account';snapshot:SnapshotFrom<ReturnType<typeof createAccountBoundaryMachine>>}
 | {type:'xstate.snapshot.startup';snapshot:SnapshotFrom<ReturnType<typeof createStartupMachine>>}
 | {type:'xstate.snapshot.write';snapshot:SnapshotFrom<ReturnType<typeof createWriteContinuationMachine>>}
 | {type:'EnvironmentObserved';connected:boolean;resumed:boolean}
 | {type:'CheckRestored'} | {type:'CheckUpdateReady'} | {type:'CheckAccountReady'};

function routeChanged(request:RouteRequest|null,event:Event,navigation?:NavigationPort) {
  return event.type==='RouteRequested' && !!event.snapshot.route
    && !!navigation?.isCurrent(event.snapshot) && request?.snapshot!==event.snapshot;
}


interface CoreActor {
 getSnapshot():{context:{request:RouteRequest|null};matches(value:'running'|{running:{destination:'preparing'|'failed'}}):boolean;children:{
  account?:ActorRefFrom<ReturnType<typeof createAccountBoundaryMachine>>;
  startup?:ActorRefFrom<ReturnType<typeof createStartupMachine>>;
  write?:ActorRefFrom<ReturnType<typeof createWriteContinuationMachine>>;
  publicRefresh?:ActorRefFrom<ReturnType<typeof createPublicRefreshMachine>>;
 }};
 send(event:Event):void;
}
function readWrite(actor:CoreActor){const child=actor.getSnapshot().children.write;return child?writeContinuationView(child.getSnapshot()):{source:null,busy:false,recovering:false,waitingForLogin:false};}
function readStartup(actor:CoreActor){const child=actor.getSnapshot().children.startup;return child?startupView(child.getSnapshot()):{restored:false,failed:false};}
function projectLibrary(actor:CoreActor,ports:ApplicationPorts) {
  if(!actor.getSnapshot().matches('running'))return;
  const port=ports.libraryProjection;if(!port)return;
  const {library,sources,selection}=port,write=readWrite(actor);
  const source=write.source && selection.record===write.source?write.source:null;
  if(sources.projectLibrary(library.charts,library.storageAvailable,library.readyIds,library.entries,{accountId:library.accountId,source})===false)return;
  port.form.refresh();port.view.library();
  if(!readStartup(actor).restored || source || selection.selectedId==='current-transit')return;
  if(sources.get(selection.selectedId)){selection.refreshRecord(port.view.changeChart);return;}
  if(port.view.isChartScreen())actor.send({type:'ChartSelected',id:'current-transit',replace:true});
  else port.view.changeChart('current-transit');
}
function presentFormResult(actor:CoreActor,ports:ApplicationPorts,id:string,metadataOnly=false) {
  if(!actor.getSnapshot().matches('running'))return;
  const port=ports.libraryProjection,route=ports.route;if(!port || !route)return;
  const replace=ports.navigation?.snapshot.route?.kind==='temporary-chart';
  if(id!==port.selection.selectedId)actor.send({type:'ChartSelected',id,replace});
  else {
    if(metadataOnly)port.selection.refreshRecord(port.view.changeChart);else port.view.changeChart(id);
    route.view.workspace('chart');
    actor.send({type:'RoutePublished',route:routeForChart(route,id),replace});
  }
  port.view.checkpoint();
}

function applicationRestored(actor:CoreActor,ports:ApplicationPorts) {
  const startup=readStartup(actor),snapshot=actor.getSnapshot();
  return snapshot.matches('running') && startup.restored && !startup.failed
    && (!ports.account || snapshot.children.account?.getSnapshot().matches('ready')===true)
    && !snapshot.matches({running:{destination:'preparing'}}) && (!snapshot.matches({running:{destination:'failed'}}) || !!snapshot.context.request?.selection) && ports.update?.restored()===true;
}

export function createApplicationMachine(ports: ApplicationPorts, disconnect: () => void,sources:()=>Promise<void>,ready:()=>Promise<void>|void,startup:StartupRuntime,preparingUpdate:()=>boolean) {
  const runtimeId = ports.runtimeId;
  let processId = 0;
  let root:CoreActor;
  let previousAccount:SnapshotFrom<ReturnType<typeof createAccountBoundaryMachine>>|undefined;
  let previousStartup:ReturnType<typeof startupView>|undefined;
  let previousWrite:ReturnType<typeof writeContinuationView>|undefined;
  const accountReady=()=>!ports.account || root.getSnapshot().children.account?.getSnapshot().matches('ready')===true;
  const background=ports.background?createBackgroundWork(ports.background,{
    state(){const write=readWrite(root);return {running:root.getSnapshot().matches('running'),restored:!ports.startup || readStartup(root).restored,
      accountReady:accountReady(),opening:root.getSnapshot().matches({running:{destination:'preparing'}}),writing:write.busy && !write.waitingForLogin,preparingUpdate:preparingUpdate()};},
    publicTask():BackgroundTask|null {
      const child=root.getSnapshot().children.publicRefresh;if(!child)return null;
      child.send({type:'PublicRefreshChanged'});const check=publicRefreshCheck(child.getSnapshot());if(!check)return null;
      return {target:check.target,run:authority=>new Promise(resolve=>child.send({type:'RefreshPublicSource',authority,completed:resolve})),
        receive:data=>child.send({type:'PublicSourceObserved',source:check.source,access:check.access,data})};
    },
    changed(){root.send({type:'FillChanged'});root.send({type:'AuditChanged'});},
    wake(at,reason){root.send({type:'FillWake',at,reason});if(reason!=='use' && reason!=='space')root.send({type:'AuditWake',at});},
    environmentChanged(facts){root.send({type:'EnvironmentObserved',...facts});},
  }):undefined;
  const publicRefreshAllowed=()=>!preparingUpdate() && !readWrite(root).source && (!ports.startup || readStartup(root).restored)
    && (ports.background?.environment.online()??true);
  return setup({
    types: {
      children: {} as {
        account: 'account';
        route: 'route';
        write: 'write';
        publicRefresh: 'publicRefresh';
        startup: 'startup';
        background:'background';
        libraryFill:'libraryFill';
        libraryAudit:'libraryAudit';
      },
      context: {} as {request: RouteRequest | null},
      events: {} as Event,
    },
    actors: {
      background:background?.logic??fromCallback(()=>{}),
      libraryFill:createLibraryFill({...ports.libraryFill!,scope:()=>background?.scope()??null}),
      libraryAudit:createLibraryLocalAudit({...ports.libraryAudit!,scope:()=>background?.scope()??null}),
      startup: createStartupMachine(ports.startup!,startup,ports.navigation),
      publicRefresh: createPublicRefreshMachine(ports.publicRefresh!,publicRefreshAllowed),
      account: createAccountBoundaryMachine(ports.account!, runtimeId,sources),
      write: createWriteContinuationMachine(ports.write!),
      route: fromPromise(({input, signal}: {input: RouteRequest; signal: AbortSignal}) =>
        prepareRoute(ports,input,signal,ready)),
    },
    guards: {
      restored:()=>applicationRestored(root,ports),
      updateReady:()=>applicationRestored(root,ports) && !readWrite(root).busy && ports.update!.ready(),
      accountReady:()=>accountReady() && (!ports.account || JSON.stringify(root.getSnapshot().children.account?.getSnapshot().context.access)===JSON.stringify(ports.account.getSession())),
      changed: ({context,event})=>!!ports.route && routeChanged(context.request,event,ports.navigation),
    },
    actions: {
      attach:({self})=>{root=self;},
      backgroundChanged:enqueueActions(({self,enqueue})=>{
        if(!self.getSnapshot().matches('running'))return;
        if(ports.background)enqueue.sendTo('background',{type:'BackgroundChanged'});
        if(ports.libraryFill)enqueue.sendTo('libraryFill',{type:'FillChanged'});
        if(ports.libraryAudit)enqueue.sendTo('libraryAudit',{type:'AuditChanged'});
      }),
      coordinate:enqueueActions(({self,event,enqueue})=>{
        const options=event.type==='EnvironmentObserved'?{recover:event.resumed,wake:event.resumed}:{recover:true,wake:true};
        const account=self.getSnapshot().children.account?.getSnapshot(),restored=readStartup(root).restored;
        if(account?.matches('ready') && account.context.access && ports.write){
          if(readWrite(root).waitingForLogin)enqueue.sendTo('write',{type:'ResumeWrite'});
          if(restored && options.recover && !preparingUpdate())enqueue.sendTo('write',{type:'RecoverWrites'});
        }
        enqueue('backgroundChanged');
        const clock=ports.background?.clock??ports.libraryFill?.clock??ports.libraryAudit?.clock;
        if(clock && restored && account?.matches('ready') && options.wake){
          const at=clock.now();
          if(ports.libraryFill)enqueue.sendTo('libraryFill',{type:'FillWake',at,reason:'lifecycle'});
          if(ports.libraryAudit)enqueue.sendTo('libraryAudit',{type:'AuditWake',at});
        }
      }),
      accountChanged:enqueueActions(({event,enqueue})=>{
        if(event.type!=='xstate.snapshot.account')return;
        const next=event.snapshot;
        if(!next.context.request){previousAccount=next;return;}
        if(next.value===previousAccount?.value && next.context.request===previousAccount?.context.request)return;
        previousAccount=next;ports.account!.changed();enqueue('coordinate');
      }),
      startupChanged:enqueueActions(({event,enqueue})=>{
        if(event.type!=='xstate.snapshot.startup' || event.snapshot.matches('stopped'))return;
        const next=startupView(event.snapshot);
        if(!previousStartup){previousStartup=next;return;}
        if(next.restored===previousStartup?.restored && next.failed===previousStartup?.failed)return;
        previousStartup=next;ports.startup!.changed();enqueue('coordinate');
      }),
      writeChanged:enqueueActions(({event,enqueue})=>{
        if(event.type!=='xstate.snapshot.write')return;
        const next=writeContinuationView(event.snapshot);
        if(!previousWrite){previousWrite=next;return;}
        if(next.source===previousWrite?.source && next.busy===previousWrite?.busy && next.recovering===previousWrite?.recovering && next.waitingForLogin===previousWrite?.waitingForLogin)return;
        previousWrite=next;ports.write!.view.changed();enqueue('backgroundChanged');
      }),
      environmentObserved:enqueueActions(({event,enqueue})=>{
        if(event.type!=='EnvironmentObserved')return;
        if(event.connected && ports.account && !preparingUpdate())enqueue.sendTo('account',{type:'RetryAccountBoundary'});
        enqueue('coordinate');
      }),
      libraryChanged:()=>projectLibrary(root,ports),
      formSaved:({event})=>{if(event.type==='FormSaved')presentFormResult(root,ports,event.id,event.metadataOnly);},
      requested: assign({
        request: ({event}) => {
          if (event.type !== 'RouteRequested') return null;
          return {snapshot: event.snapshot, initial: event.initial ?? false, runtimeId, processId: ++processId};
        },
      }),
      retried: assign({
        request: ({context, event}) => context.request
          ? {...context.request, initial: event.type === 'RetryRoute' ? false : context.request.initial, processId: ++processId}
          : null,
      }),
      chosen:assign({request:({event})=>event.type==='OpenChartRequested'?{
        snapshot:ports.navigation?.snapshot??{route:null,revision:0},initial:false,runtimeId,processId:++processId,
        selection:{id:event.id,edit:event.edit},
      }:null}),
      cancelWrite:enqueueActions(({enqueue})=>{if(ports.write)enqueue.sendTo('write',{type:'CancelWrite'});}),
      cancelPublic:enqueueActions(({enqueue})=>{if(ports.publicRefresh)enqueue.sendTo('publicRefresh',{type:'CancelPublicRefresh'});}),
      cancelOpening:enqueueActions(({context,enqueue})=>{
        if(!context.request || !ports.route)return;
        const route=context.request.selection?routeForChart(ports.route,context.request.selection.id):context.request.snapshot.route!;
        if(chartDestination(route))enqueue('cancelPublic');
        if(!context.request.initial)enqueue('cancelWrite');
      }),
      cancelPublished:enqueueActions(({event,enqueue})=>{if(event.type==='RoutePublished' && chartDestination(event.route))enqueue('cancelPublic');}),
      cancelDepartingWrite:enqueueActions(({event,enqueue})=>{
        if(event.type==='WorkspaceRequested' && !(event.screen==='account' && readWrite(root).waitingForLogin))enqueue('cancelWrite');
      }),
      opening:({context})=>{
        if(!context.request || !ports.route)return;
        const route=context.request.selection?routeForChart(ports.route,context.request.selection.id):context.request.snapshot.route!;
        if(!context.request.selection)ports.route.view.workspace(chartDestination(route)?'chart':route.kind as 'account'|'charts'|'knowledge');
        if(!context.request.initial){
          if(!context.request.selection)ports.route.view.interrupt();
        }
      },
      published:({event})=>{
        if(event.type!=='RoutePublished' || !ports.route)return;
        publishRoute(ports.route,ports.navigation,event.route,event.replace);
      },
      selected:({event})=>{
        if(event.type!=='ChartSelected' || !ports.route)return;
        showChart(ports.route,event.id);
        if(!event.fromRoute)publishRoute(ports.route,ports.navigation,routeForChart(ports.route,event.id),event.replace);
      },
      workspace:({event})=>{
        if(event.type!=='WorkspaceRequested' || !ports.route)return;
        ports.route.view.workspace(event.screen);
        if(!event.fromRoute)publishRoute(ports.route,ports.navigation,event.screen==='chart'
          ?routeForChart(ports.route,ports.route.session.selectedId):{kind:event.screen});
      },
      settled:()=>ports.route?.view.settled(),
      clear: assign({request: null}),
      boundary:enqueueActions(({event,enqueue})=>{
        if(event.type!=='AccountBoundaryStarted')return;
        enqueue('cancelPublic');if(event.reset)enqueue('cancelWrite');
      }),
      disconnect,
    },
  }).createMachine({
    id: 'application',
    initial: 'created',entry:'attach',
    context: {request: null},
    states: {
      created: {on: {Start: 'running', Stop: 'stopping'}},
      running: {
        initial: 'destination',
        invoke: [
          ...(ports.account ? [{id: 'account', src: 'account',onSnapshot:{actions:'accountChanged'}} as const] : []),
          ...(ports.write ? [{id: 'write', src: 'write',onSnapshot:{actions:'writeChanged'}} as const] : []),
          ...(ports.publicRefresh ? [{id: 'publicRefresh', src: 'publicRefresh'} as const] : []),
          ...(ports.startup ? [{id: 'startup', src: 'startup',onSnapshot:{actions:'startupChanged'}} as const] : []),
          ...(ports.background ? [{id:'background',src:'background'} as const]:[]),
          ...(ports.libraryFill ? [{id:'libraryFill',src:'libraryFill'} as const]:[]),
          ...(ports.libraryAudit ? [{id:'libraryAudit',src:'libraryAudit'} as const]:[]),
        ],
        on: {
          Stop: '#application.stopping',
          CheckRestored:{guard:'restored',actions:()=>{}},CheckUpdateReady:{guard:'updateReady',actions:()=>{}},CheckAccountReady:{guard:'accountReady',actions:()=>{}},
          EnvironmentObserved:{actions:'environmentObserved'},LibraryChanged:{actions:'libraryChanged'},FormSaved:{actions:'formSaved'},
          LibraryUsed:{guard:()=>!!ports.background,actions:sendTo('background',({event})=>event)},
          BackgroundIdle:{guard:()=>!!ports.background,actions:sendTo('background',({event})=>event)},
          BackgroundEnvironment:{guard:()=>!!ports.background,actions:sendTo('background',({event})=>event)},
          TransitWindowObserved:{guard:()=>!!ports.background,actions:sendTo('background',({event})=>event)},
          LibraryLocalChanged:{guard:()=>!!ports.background,actions:sendTo('background',({event})=>event)},
          LibraryReceived:{guard:()=>!!ports.background,actions:sendTo('background',({event})=>event)},
          BackgroundChanged:{actions:'backgroundChanged'},
          BackgroundActivityChanged:{guard:()=>!!ports.background,actions:sendTo('background',({event})=>event)},
          FillWake:{guard:()=>!!ports.libraryFill,actions:sendTo('libraryFill',({event})=>event)},
          FillChanged:{guard:()=>!!ports.libraryFill,actions:sendTo('libraryFill',({event})=>event)},
          AuditWake:{guard:()=>!!ports.libraryAudit,actions:sendTo('libraryAudit',({event})=>event)},
          AuditChanged:{guard:()=>!!ports.libraryAudit,actions:sendTo('libraryAudit',({event})=>event)},
          StartupInterrupted: {
            guard: () => !!ports.startup,
            actions: sendTo('startup', ({event}) => event),
          },
          RefreshPublicSource: {
            guard: () => !!ports.publicRefresh,
            actions: sendTo('publicRefresh', ({event}) => event),
          },
          PublicRefreshChanged:{guard:()=>!!ports.publicRefresh,actions:sendTo('publicRefresh',({event})=>event)},
          PublicSourceRead:{guard:()=>!!ports.publicRefresh,actions:sendTo('publicRefresh',({event})=>event)},
          PublicSourceObserved:{guard:()=>!!ports.publicRefresh,actions:sendTo('publicRefresh',({event})=>event)},
          CancelPublicRefresh: {
            guard: () => !!ports.publicRefresh,
            actions: sendTo('publicRefresh', ({event}) => event),
          },
          AccountBoundaryStarted:{actions:'boundary'},
          JournalAttached:{guard:()=>!!ports.account,actions:sendTo('account',({event})=>event)},
          SessionChanged: {
            guard: () => !!ports.account,
            actions: sendTo('account', ({event}) => event),
          },
          LogoutObserved: {
            guard: () => !!ports.account,
            actions: sendTo('account', ({event}) => event),
          },
          RetryAccountBoundary: {
            guard: () => !!ports.account && !preparingUpdate(),
            actions: sendTo('account', ({event}) => event),
          },
          SaveRequested: {
            guard: () => !!ports.write,
            actions: sendTo('write', ({event}) => event),
          },
          ResumeWrite: {
            guard: () => !!ports.write,
            actions: sendTo('write', ({event}) => event),
          },
          ClearTemporaryWrite:{guard:()=>!!ports.write,actions:sendTo('write',({event})=>event)},
          CancelWrite: {
            guard: () => !!ports.write,
            actions: sendTo('write', ({event}) => event),
          },
          RecoverWrites: {
            guard: () => !!ports.write && !preparingUpdate(),
            actions: sendTo('write', ({event}) => event),
          },
        },
        states: {
          destination: {
            initial: 'idle',
            on: {
              RouteRequested: {
                guard: 'changed',
                target: '.preparing',
                reenter: true,
                actions: 'requested',
              },
              OpenChartRequested:{guard:()=>!!ports.route,target:'.preparing',reenter:true,actions:'chosen'},
              RoutePublished: {target: '.idle', actions: ['clear','cancelPublished','published','settled']},
              ChartSelected:{target:'.idle',actions:['clear','cancelWrite','cancelPublic','selected','settled']},
              WorkspaceRequested:{target:'.idle',actions:['clear','cancelDepartingWrite','workspace','settled']},
            },
            states: {
              idle: {entry:'backgroundChanged'},
              preparing: {
                entry:['cancelOpening','opening','backgroundChanged'],
                on: {
                  AccountBoundaryStarted: {target: 'preparing', reenter: true, actions: ['boundary','retried']},
                },
                invoke: {
                  id: 'route',
                  src: 'route',
                  input: ({context}) => context.request!,
                  onDone: [
                    {guard: ({event}) => event.output === 'ready', target: 'ready'},
                    {guard: ({event}) => event.output === 'failed', target: 'failed'},
                    {target: 'idle', actions: 'clear'},
                  ],
                  onError: 'failed',
                },
              },
              ready: {entry:'backgroundChanged'},
              failed: {entry:'backgroundChanged',on: {RetryRoute: {target: 'preparing', actions: 'retried'}}},
            },
          },
        },
      },
      stopping: {entry: ['disconnect', 'clear'], always: 'stopped'},
      stopped: {type: 'final'},
    },
  });
}
