import { assign, fromPromise, sendTo, setup } from 'xstate';
import { prepareRoute } from './route.ts';
import { createAccountBoundaryMachine } from './account-boundary.ts';
import { createStartupMachine } from './startup.ts';
import { createPublicRefreshMachine } from './public-refresh.ts';
import { createWriteContinuationMachine } from './write-continuation.ts';
import type { ApplicationEvent, ApplicationPorts, RouteRequest, NavigationPort } from './ports.ts';

type Event = ApplicationEvent | {type: 'Start'} | {type: 'Stop'} | {type:'AccountBoundaryStarted'};

function routeChanged(request:RouteRequest|null,event:Event,navigation?:NavigationPort) {
  return event.type==='RouteRequested' && !!event.snapshot.route
    && !!navigation?.isCurrent(event.snapshot) && request?.snapshot!==event.snapshot;
}

export function createApplicationMachine(ports: ApplicationPorts, disconnect: () => void) {
  const runtimeId = ports.runtimeId;
  let processId = 0;
  return setup({
    types: {children: {} as {account:'account'; route:'route'; write:'write'; publicRefresh:'publicRefresh'; startup:'startup'}, context: {} as {request: RouteRequest | null}, events: {} as Event},
    actors: {startup:createStartupMachine(ports.startup!),publicRefresh:createPublicRefreshMachine(ports.publicRefresh!),account:createAccountBoundaryMachine(ports.account!,runtimeId),write:createWriteContinuationMachine(ports.write!),route: fromPromise(({input, signal}: {input: RouteRequest; signal: AbortSignal}) => prepareRoute(ports, input, signal))},
    guards: {
      changed: ({context,event})=>routeChanged(context.request,event,ports.navigation),
    },
    actions: {
      requested: assign({request: ({event}) => {
        if (event.type !== 'RouteRequested') return null;
        return {snapshot: event.snapshot, initial: event.initial ?? false, runtimeId, processId: ++processId};
      }}),
      retried: assign({request: ({context,event}) => context.request
        ? {...context.request, initial: event.type==='RetryRoute'?false:context.request.initial, processId: ++processId} : null}),
      published: ({event}) => {
        if (event.type === 'RoutePublished') ports.navigation?.navigate(event.route, {replace: event.replace, origin: 'publication'});
      },
      clear: assign({request: null}),
      disconnect,
    },
  }).createMachine({
    id: 'application', initial: 'created', context: {request: null},
    states: {
      created: {on: {Start: 'running', Stop: 'stopping'}},
      running: {
        initial: 'destination',
        invoke: [...(ports.account ? [{id:'account',src:'account'} as const] : []),...(ports.write?[{id:'write',src:'write'} as const]:[]),...(ports.publicRefresh?[{id:'publicRefresh',src:'publicRefresh'} as const]:[]),...(ports.startup?[{id:'startup',src:'startup'} as const]:[])],
        on: {
          Stop: '#application.stopping',
          StartupInterrupted:{guard:()=>!!ports.startup,actions:sendTo('startup',({event})=>event)},
          RefreshPublicSource:{guard:()=>!!ports.publicRefresh,actions:sendTo('publicRefresh',({event})=>event)},
          CancelPublicRefresh:{guard:()=>!!ports.publicRefresh,actions:sendTo('publicRefresh',({event})=>event)},
          SessionChanged: {guard:()=>!!ports.account,actions:sendTo('account',({event})=>event)},
          LogoutObserved: {guard:()=>!!ports.account,actions:sendTo('account',({event})=>event)},
          RetryAccountBoundary: {guard:()=>!!ports.account,actions:sendTo('account',({event})=>event)},
          SaveRequested:{guard:()=>!!ports.write,actions:sendTo('write',({event})=>event)},
          ResumeWrite:{guard:()=>!!ports.write,actions:sendTo('write',({event})=>event)},
          CancelWrite:{guard:()=>!!ports.write,actions:sendTo('write',({event})=>event)},
          RecoverWrites:{guard:()=>!!ports.write,actions:sendTo('write',({event})=>event)},
        },
        states: {
          destination: {
            initial: 'idle',
            on: {
              RouteRequested: {guard: 'changed', target: '.preparing', reenter: true, actions: 'requested'},
              RoutePublished: {target: '.idle', actions: ['clear', 'published']},
            },
            states: {
              idle: {},
              preparing: {
                on:{AccountBoundaryStarted:{target:'preparing',reenter:true,actions:'retried'}},
                invoke: {
                  id: 'route', src: 'route', input: ({context}) => context.request!,
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
