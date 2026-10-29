import { createActor, waitFor, type SnapshotFrom } from 'xstate';
import { createApplicationMachine } from './application-machine.ts';
import type { ApplicationEvent, ApplicationPorts, ApplicationView, NavigationSnapshot } from './ports.ts';


function applicationView(snapshot: SnapshotFrom<ReturnType<typeof createApplicationMachine>>): ApplicationView {
  const value = snapshot.value;
  return {lifecycle: typeof value === 'string' ? value : 'running',
    destination: typeof value === 'string' ? 'idle' : value.running,
    request: snapshot.context.request};
}

export function createApplication(ports: ApplicationPorts) {
  let unsubscribe: (() => void) | null = null;
  const machine = createApplicationMachine(ports, () => {unsubscribe?.(); unsubscribe = null;});
  const actor = createActor(machine);
  const readView = () => applicationView(actor.getSnapshot());
  actor.start();
  return {
    get view() { return readView(); },
    start() {
      if (!actor.getSnapshot().matches('created')) return;
      unsubscribe = ports.navigation.subscribe((snapshot, origin) => {
        if (origin !== 'publication') actor.send({type: 'RouteRequested', snapshot});
      });
      actor.send({type: 'Start'});
    },
    send(event: ApplicationEvent) { actor.send(event); },
    subscribe(listener: (view: ApplicationView) => void) {
      let previous = readView();
      const subscription = actor.subscribe(() => {
        const next = readView();
        if (next.lifecycle === previous.lifecycle && next.destination === previous.destination && next.request === previous.request) return;
        previous = next; listener(next);
      });
      return () => subscription.unsubscribe();
    },
    // Transitional handoff for the existing startup restorer; P06 moves its order into the machine.
    async requestRoute(snapshot: NavigationSnapshot, initial = false) {
      actor.send({type: 'RouteRequested', snapshot, initial});
      const request = actor.getSnapshot().context.request;
      await waitFor(actor, state => state.context.request !== request || !state.matches({running: 'preparing'}));
    },
    async stop() { actor.send({type: 'Stop'}); },
  };
}

export type Application = ReturnType<typeof createApplication>;
