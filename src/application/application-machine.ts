import { assign, fromPromise, setup } from 'xstate';
import { prepareRoute } from './route.ts';
import type { ApplicationEvent, ApplicationPorts, RouteRequest } from './ports.ts';

type Event = ApplicationEvent | {type: 'Start'} | {type: 'Stop'};

export function createApplicationMachine(ports: ApplicationPorts, disconnect: () => void) {
  const runtimeId = crypto.randomUUID();
  let processId = 0;
  return setup({
    types: {context: {} as {request: RouteRequest | null}, events: {} as Event},
    actors: {route: fromPromise(({input, signal}: {input: RouteRequest; signal: AbortSignal}) => prepareRoute(ports, input, signal))},
    guards: {
      changed: ({context, event}) => event.type === 'RouteRequested' && !!event.snapshot.route
        && ports.navigation.isCurrent(event.snapshot) && context.request?.snapshot !== event.snapshot,
    },
    actions: {
      requested: assign({request: ({event}) => {
        if (event.type !== 'RouteRequested') return null;
        return {snapshot: event.snapshot, initial: event.initial ?? false, runtimeId, processId: ++processId};
      }}),
      retried: assign({request: ({context}) => context.request
        ? {...context.request, initial: false, processId: ++processId} : null}),
      published: ({event}) => {
        if (event.type === 'RoutePublished') ports.navigation.navigate(event.route, {replace: event.replace, origin: 'publication'});
      },
      clear: assign({request: null}),
      disconnect,
    },
  }).createMachine({
    id: 'application', initial: 'created', context: {request: null},
    states: {
      created: {on: {Start: 'running', Stop: 'stopping'}},
      running: {
        initial: 'idle',
        on: {
          Stop: '#application.stopping',
          RouteRequested: {guard: 'changed', target: '.preparing', reenter: true, actions: 'requested'},
          RoutePublished: {target: '.idle', actions: ['clear', 'published']},
        },
        states: {
          idle: {},
          preparing: {
            invoke: {
              src: 'route', input: ({context}) => context.request!,
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
      stopping: {entry: ['disconnect', 'clear'], always: 'stopped'},
      stopped: {type: 'final'},
    },
  });
}
