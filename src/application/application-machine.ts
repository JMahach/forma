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
 | {type:'EnvironmentObserved';connected:boolean;resumed:boolean};

type AccountSnapshot=SnapshotFrom<ReturnType<typeof createAccountBoundaryMachine>>;
interface ApplicationContext {
 request:RouteRequest|null;
 processId:number;
 // Notification filters only. Admission always reads the current child states.
 observedAccount:Pick<AccountSnapshot,'value'> & {request:AccountSnapshot['context']['request']} | null;
 observedStartup:ReturnType<typeof startupView>|null;
 observedWrite:Pick<ReturnType<typeof writeContinuationView>,'source'|'busy'|'recovering'|'waitingForLogin'>|null;
}

function routeChanged(request:RouteRequest|null,event:Event,navigation?:NavigationPort) {
  return event.type==='RouteRequested' && !!event.snapshot.route
    && !!navigation?.isCurrent(event.snapshot) && request?.snapshot!==event.snapshot;
}


interface CoreSnapshot {
 context:{request:RouteRequest|null};matches(value:'running'|{running:{destination:'preparing'|'failed'}}):boolean;children:{
  account?:ActorRefFrom<ReturnType<typeof createAccountBoundaryMachine>>;
  startup?:ActorRefFrom<ReturnType<typeof createStartupMachine>>;
  write?:ActorRefFrom<ReturnType<typeof createWriteContinuationMachine>>;
  publicRefresh?:ActorRefFrom<ReturnType<typeof createPublicRefreshMachine>>;
 };
}
interface CoreActor {
 getSnapshot():CoreSnapshot;
 send(event:Event):void;
}
function readWrite(actor:CoreActor){const child=actor.getSnapshot().children.write;return child?writeContinuationView(child.getSnapshot()):{source:null,busy:false,recovering:false,waitingForLogin:false};}
function readStartup(actor:CoreActor){const child=actor.getSnapshot().children.startup;return child?startupView(child.getSnapshot()):{settled:false,failed:false};}
function projectLibrary(actor:CoreActor,ports:ApplicationPorts) {
  if(!actor.getSnapshot().matches('running'))return;
  const port=ports.libraryProjection;if(!port)return;
  const {library,sources,selection}=port,write=readWrite(actor);
  const source=write.source && selection.record===write.source?write.source:null;
  if(sources.projectLibrary(library.charts,library.storageAvailable,library.readyIds,library.entries,{accountId:library.accountId,source})===false)return;
  port.form.refresh();port.view.library();
  if(!readStartup(actor).settled || source || selection.selectedId==='current-transit')return;
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

export function applicationRestored(snapshot:CoreSnapshot,ports:ApplicationPorts) {
  const child=snapshot.children.startup,startup=child?startupView(child.getSnapshot()):{settled:false,failed:false};
  return snapshot.matches('running') && startup.settled && !startup.failed
    && (!ports.account || snapshot.children.account?.getSnapshot().matches('ready')===true)
    && !snapshot.matches({running:{destination:'preparing'}}) && (!snapshot.matches({running:{destination:'failed'}}) || !!snapshot.context.request?.selection) && ports.update?.restored()===true;
}

export function applicationUpdateReady(snapshot:CoreSnapshot,ports:ApplicationPorts) {
  const write=snapshot.children.write;
  return applicationRestored(snapshot,ports) && (!write || !writeContinuationView(write.getSnapshot()).busy)
    && ports.update?.ready()===true;
}

export function applicationAccountReady(snapshot:CoreSnapshot,ports:ApplicationPorts) {
  const account=snapshot.children.account?.getSnapshot();
  return snapshot.matches('running') && (!ports.account || account?.matches('ready')===true
    && JSON.stringify(account.context.access)===JSON.stringify(ports.account.getSession()));
}

export function createApplicationMachine(ports: ApplicationPorts, disconnect: () => void,sources:()=>Promise<void>,ready:()=>Promise<void>|void,startup:StartupRuntime,preparingUpdate:()=>boolean,runtime:()=>CoreActor) {
  const runtimeId = ports.runtimeId;
  // The owning Application provides its actor lazily, after construction.
  // Actions use self; only callback owners need this runtime connection.
  const accountReady=()=>!ports.account || runtime().getSnapshot().children.account?.getSnapshot().matches('ready')===true;
  const background=ports.background?createBackgroundWork(ports.background,{
    state(){const actor=runtime(),snapshot=actor.getSnapshot(),write=readWrite(actor);return {running:snapshot.matches('running'),startupSettled:!ports.startup || readStartup(actor).settled,
      accountReady:accountReady(),opening:snapshot.matches({running:{destination:'preparing'}}),writing:write.busy && !write.waitingForLogin,preparingUpdate:preparingUpdate()};},
    publicTask():BackgroundTask|null {
      const child=runtime().getSnapshot().children.publicRefresh;if(!child)return null;
      child.send({type:'PublicRefreshChanged'});const check=publicRefreshCheck(child.getSnapshot());if(!check)return null;
      return {target:check.target,run:authority=>new Promise(resolve=>child.send({type:'RefreshPublicSource',authority,completed:resolve})),
        receive:data=>child.send({type:'PublicSourceObserved',source:check.source,access:check.access,data})};
    },
    changed(){runtime().send({type:'FillChanged'});runtime().send({type:'AuditChanged'});},
    wake(at,reason){runtime().send({type:'FillWake',at,reason});if(reason!=='use' && reason!=='space')runtime().send({type:'AuditWake',at});},
    environmentChanged(facts){runtime().send({type:'EnvironmentObserved',...facts});},
  }):undefined;
  const publicRefreshAllowed=()=>!preparingUpdate() && !readWrite(runtime()).source && (!ports.startup || readStartup(runtime()).settled)
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
      context: {} as ApplicationContext,
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
      changed: ({context,event})=>!!ports.route && routeChanged(context.request,event,ports.navigation),
    },
    actions: {
      backgroundChanged:enqueueActions(({self,enqueue})=>{
        if(!self.getSnapshot().matches('running'))return;
        if(ports.background)enqueue.sendTo('background',{type:'BackgroundChanged'});
        if(ports.libraryFill)enqueue.sendTo('libraryFill',{type:'FillChanged'});
        if(ports.libraryAudit)enqueue.sendTo('libraryAudit',{type:'AuditChanged'});
      }),
      // Recheck admission after account/startup changes or an environment fact.
      // The parent diagram shows this action; these cross-region conditions live
      // here instead of adding states for every combination of child states.
      coordinate:enqueueActions(({enqueue})=>{
        enqueue('resumeWaitingWrite');enqueue('recoverReadyWrites');
        enqueue('backgroundChanged');enqueue('wakeLibrary');
      }),
      resumeWaitingWrite:enqueueActions(({self,enqueue})=>{
        const account=self.getSnapshot().children.account?.getSnapshot();
        if(ports.write && account?.matches('ready') && account.context.access && readWrite(self).waitingForLogin)
          enqueue.sendTo('write',{type:'ResumeWrite'});
      }),
      recoverReadyWrites:enqueueActions(({self,event,enqueue})=>{
        const account=self.getSnapshot().children.account?.getSnapshot();
        if(ports.write && account?.matches('ready') && account.context.access && readStartup(self).settled
          && (event.type!=='EnvironmentObserved' || event.resumed) && !preparingUpdate())
          enqueue.sendTo('write',{type:'RecoverWrites'});
      }),
      wakeLibrary:enqueueActions(({self,event,enqueue})=>{
        const clock=ports.background?.clock??ports.libraryFill?.clock??ports.libraryAudit?.clock;
        const account=self.getSnapshot().children.account?.getSnapshot();
        if(clock && readStartup(self).settled && account?.matches('ready') && (event.type!=='EnvironmentObserved' || event.resumed)){
          const at=clock.now();
          if(ports.libraryFill)enqueue.sendTo('libraryFill',{type:'FillWake',at,reason:'lifecycle'});
          if(ports.libraryAudit)enqueue.sendTo('libraryAudit',{type:'AuditWake',at});
        }
      }),
      accountChanged:enqueueActions(({context,event,enqueue})=>{
        if(event.type!=='xstate.snapshot.account')return;
        const next=event.snapshot,previous=context.observedAccount;
        if(next.value===previous?.value && next.context.request===previous?.request)return;
        enqueue.assign({observedAccount:{value:next.value,request:next.context.request}});
        if(!next.context.request)return;
        ports.account!.changed();enqueue('coordinate');
      }),
      startupChanged:enqueueActions(({context,event,enqueue})=>{
        if(event.type!=='xstate.snapshot.startup' || event.snapshot.matches('stopped'))return;
        const next=startupView(event.snapshot),previous=context.observedStartup;
        if(next.settled===previous?.settled && next.failed===previous?.failed)return;
        enqueue.assign({observedStartup:next});
        if(!previous)return;
        ports.startup!.changed();enqueue('coordinate');
      }),
      writeChanged:enqueueActions(({context,event,enqueue})=>{
        if(event.type!=='xstate.snapshot.write')return;
        const {source,busy,recovering,waitingForLogin}=writeContinuationView(event.snapshot);
        const next={source,busy,recovering,waitingForLogin},previous=context.observedWrite;
        if(next.source===previous?.source && next.busy===previous?.busy && next.recovering===previous?.recovering && next.waitingForLogin===previous?.waitingForLogin)return;
        enqueue.assign({observedWrite:next});
        if(!previous)return;
        ports.write!.view.changed();enqueue('backgroundChanged');
      }),
      environmentObserved:enqueueActions(({event,enqueue})=>{
        if(event.type!=='EnvironmentObserved')return;
        if(event.connected && ports.account && !preparingUpdate())enqueue.sendTo('account',{type:'RetryAccountBoundary'});
        enqueue('coordinate');
      }),
      libraryChanged:({self})=>projectLibrary(self,ports),
      formSaved:({self,event})=>{if(event.type==='FormSaved')presentFormResult(self,ports,event.id,event.metadataOnly);},
      requested: assign(({context,event}) => {
        if(event.type!=='RouteRequested')return {request:null};
        const processId=context.processId+1;
        return {processId,request:{snapshot:event.snapshot,initial:event.initial??false,runtimeId,processId}};
      }),
      retried: assign(({context,event}) => {
        if(!context.request)return {};
        const processId=context.processId+1;
        return {processId,request:{...context.request,initial:event.type==='RetryRoute'?false:context.request.initial,processId}};
      }),
      chosen:assign(({context,event})=>{
        if(event.type!=='OpenChartRequested')return {request:null};
        const processId=context.processId+1;
        return {processId,request:{
          snapshot:ports.navigation?.snapshot??{route:null,revision:0},initial:false,runtimeId,processId,
          selection:{id:event.id,edit:event.edit},
        }};
      }),
      cancelWrite:enqueueActions(({enqueue})=>{if(ports.write)enqueue.sendTo('write',{type:'CancelWrite'});}),
      cancelPublic:enqueueActions(({enqueue})=>{if(ports.publicRefresh)enqueue.sendTo('publicRefresh',{type:'CancelPublicRefresh'});}),
      cancelOpening:enqueueActions(({context,enqueue})=>{
        if(!context.request || !ports.route)return;
        const route=context.request.selection?routeForChart(ports.route,context.request.selection.id):context.request.snapshot.route!;
        if(chartDestination(route))enqueue('cancelPublic');
        if(!context.request.initial)enqueue('cancelWrite');
      }),
      cancelPublished:enqueueActions(({event,enqueue})=>{if(event.type==='RoutePublished' && chartDestination(event.route))enqueue('cancelPublic');}),
      cancelDepartingWrite:enqueueActions(({self,event,enqueue})=>{
        if(event.type==='WorkspaceRequested' && !(event.screen==='account' && readWrite(self).waitingForLogin))enqueue('cancelWrite');
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
    initial: 'created',
    context:()=>({request:null,processId:0,observedAccount:null,observedStartup:null,observedWrite:null}),
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
