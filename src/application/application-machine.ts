import { assign, fromPromise, sendTo, setup } from 'xstate';
import {prepareRoute,chartDestination,showChart,routeForChart,publishRoute} from './route.ts';
import { createAccountBoundaryMachine } from './account-boundary.ts';
import { createStartupMachine } from './startup.ts';
import { createPublicRefreshMachine } from './public-refresh.ts';
import {createWriteContinuationMachine,writeContinuationView} from './write-continuation.ts';
import {createBackgroundWork} from './background-work.ts';
import {createLibraryFill} from './library-fill.ts';
import {createLibraryLocalAudit} from './library-local-audit.ts';
import type { ApplicationEvent, ApplicationPorts, RouteRequest, NavigationPort } from './ports.ts';

type Event = ApplicationEvent | {type: 'Start'} | {type: 'Stop'} | {type:'AccountBoundaryStarted';reset:boolean};

function routeChanged(request:RouteRequest|null,event:Event,navigation?:NavigationPort) {
  return event.type==='RouteRequested' && !!event.snapshot.route
    && !!navigation?.isCurrent(event.snapshot) && request?.snapshot!==event.snapshot;
}

export function createApplicationMachine(ports: ApplicationPorts, disconnect: () => void,sources:()=>Promise<void>,ready:()=>Promise<void>|void) {
  const runtimeId = ports.runtimeId;
  let processId = 0;
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
      background:createBackgroundWork(ports.background!),
      libraryFill:createLibraryFill(ports.libraryFill!),
      libraryAudit:createLibraryLocalAudit(ports.libraryAudit!),
      startup: createStartupMachine(ports.startup!),
      publicRefresh: createPublicRefreshMachine(ports.publicRefresh!),
      account: createAccountBoundaryMachine(ports.account!, runtimeId,sources),
      write: createWriteContinuationMachine(ports.write!),
      route: fromPromise(({input, signal}: {input: RouteRequest; signal: AbortSignal}) =>
        prepareRoute(ports,input,signal,ready)),
    },
    guards: {
      changed: ({context,event})=>!!ports.route && routeChanged(context.request,event,ports.navigation),
    },
    actions: {
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
        selection:{id:event.id,edit:event.edit,keepMenuOpen:event.keepMenuOpen},
      }:null}),
      opening:({context,self})=>{
        if(!context.request || !ports.route)return;
        const route=context.request.selection?routeForChart(ports.route,context.request.selection.id):context.request.snapshot.route!;
        if(chartDestination(route))self.getSnapshot().children.publicRefresh?.send({type:'CancelPublicRefresh'});
        if(!context.request.selection)ports.route.view.workspace(chartDestination(route)?'chart':route.kind as 'account'|'charts'|'knowledge');
        if(!context.request.initial){
          self.getSnapshot().children.write?.send({type:'CancelWrite'});
          if(!context.request.selection)ports.route.view.interrupt();
        }
      },
      published:({event,self})=>{
        if(event.type!=='RoutePublished' || !ports.route)return;
        if(chartDestination(event.route))self.getSnapshot().children.publicRefresh?.send({type:'CancelPublicRefresh'});
        publishRoute(ports.route,ports.navigation,event.route,event.replace);
      },
      selected:({event,self})=>{
        if(event.type!=='ChartSelected' || !ports.route)return;
        self.getSnapshot().children.write?.send({type:'CancelWrite'});
        self.getSnapshot().children.publicRefresh?.send({type:'CancelPublicRefresh'});
        showChart(ports.route,event.id,event.keepMenuOpen);
        if(!event.fromRoute)publishRoute(ports.route,ports.navigation,routeForChart(ports.route,event.id),event.replace);
      },
      workspace:({event,self})=>{
        if(event.type!=='WorkspaceRequested' || !ports.route)return;
        const write=self.getSnapshot().children.write;
        if(write && !(event.screen==='account' && writeContinuationView(write.getSnapshot()).waitingForLogin))write.send({type:'CancelWrite'});
        ports.route.view.workspace(event.screen,event.keepMenuOpen);
        if(!event.fromRoute)publishRoute(ports.route,ports.navigation,event.screen==='chart'
          ?routeForChart(ports.route,ports.route.session.selectedId):{kind:event.screen});
      },
      settled:()=>ports.route?.view.settled(),
      clear: assign({request: null}),
      boundary:({event,self})=>{
        if(event.type!=='AccountBoundaryStarted')return;
        self.getSnapshot().children.publicRefresh?.send({type:'CancelPublicRefresh'});
        if(event.reset)self.getSnapshot().children.write?.send({type:'CancelWrite'});
      },
      disconnect,
    },
  }).createMachine({
    id: 'application',
    initial: 'created',
    context: {request: null},
    states: {
      created: {on: {Start: 'running', Stop: 'stopping'}},
      running: {
        initial: 'destination',
        invoke: [
          ...(ports.account ? [{id: 'account', src: 'account'} as const] : []),
          ...(ports.write ? [{id: 'write', src: 'write'} as const] : []),
          ...(ports.publicRefresh ? [{id: 'publicRefresh', src: 'publicRefresh'} as const] : []),
          ...(ports.startup ? [{id: 'startup', src: 'startup'} as const] : []),
          ...(ports.background ? [{id:'background',src:'background'} as const]:[]),
          ...(ports.libraryFill ? [{id:'libraryFill',src:'libraryFill'} as const]:[]),
          ...(ports.libraryAudit ? [{id:'libraryAudit',src:'libraryAudit'} as const]:[]),
        ],
        on: {
          Stop: '#application.stopping',
          BackgroundChanged:{guard:()=>!!ports.background,actions:sendTo('background',({event})=>event)},
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
            guard: () => !!ports.account,
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
            guard: () => !!ports.write,
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
              RoutePublished: {target: '.idle', actions: ['clear', 'published', 'settled']},
              ChartSelected:{target:'.idle',actions:['clear','selected','settled']},
              WorkspaceRequested:{target:'.idle',actions:['clear','workspace','settled']},
            },
            states: {
              idle: {},
              preparing: {
                entry:'opening',
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
              ready: {},
              failed: {on: {RetryRoute: {target: 'preparing', actions: 'retried'}}},
            },
          },
        },
      },
      stopping: {entry: ['disconnect', 'clear'], always: 'stopped'},
      stopped: {type: 'final'},
    },
  });
}
