import { createActor, waitFor, type ActorRefFrom, type SnapshotFrom } from 'xstate';
import { createApplicationMachine } from './application-machine.ts';
import { writeContinuationView } from './write-continuation.ts';
import type { SavedChart } from '../../shared/chart-types.ts';
import type { ApplicationEvent, ApplicationPorts, ApplicationView, NavigationSnapshot, AccountAccess } from './ports.ts';


function applicationView(snapshot: SnapshotFrom<ReturnType<typeof createApplicationMachine>>): ApplicationView {
  const value = snapshot.value;
  return {lifecycle: typeof value === 'string' ? value : 'running',
    destination: typeof value === 'string' ? 'idle' : value.running.destination,
    request: snapshot.context.request};
}

type ApplicationActor=ActorRefFrom<ReturnType<typeof createApplicationMachine>>;
function subscribeView(actor:ApplicationActor,listener:(view:ApplicationView)=>void) {
  let previous=applicationView(actor.getSnapshot());
  const subscription=actor.subscribe(()=>{
    const next=applicationView(actor.getSnapshot());
    if(next.lifecycle===previous.lifecycle && next.destination===previous.destination && next.request===previous.request)return;
    previous=next;listener(next);
  });
  return ()=>subscription.unsubscribe();
}
async function accountReady(actor:ApplicationActor) {
  const account=actor.getSnapshot().children.account;
  if(!account)return;
  await waitFor(account,state=>!state.matches('preparing')).catch(error=>{
    if(actor.getSnapshot().status!=='done')throw error;
  });
}

export function createApplication(ports: ApplicationPorts) {
  const subscriptions:(()=>void)[]=[];
  const machine = createApplicationMachine(ports, () => {
    for(const stop of subscriptions.splice(0))stop();
    ports.account?.stop();
  });
  const actor = createActor(machine);
  const readView = () => applicationView(actor.getSnapshot());
  const readWrite=()=>{
    const write=actor.getSnapshot().children.write;
    return write?writeContinuationView(write.getSnapshot()):{source:null,busy:false,waitingForLogin:false};
  };
  actor.start();
  return {
    get view() { return readView(); },
    get write() {return readWrite();},
    start() {
      if (!actor.getSnapshot().matches('created')) return;
      actor.send({type: 'Start'});
      const write=actor.getSnapshot().children.write;
      if(write){
        let previous=readWrite();
        const subscription=write.subscribe(()=>{
          const next=readWrite();
          if(next.source===previous.source && next.busy===previous.busy && next.waitingForLogin===previous.waitingForLogin)return;
          previous=next;ports.write!.view.changed();
        });
        subscriptions.push(()=>subscription.unsubscribe());
      }
      if(ports.navigation)subscriptions.push(ports.navigation.subscribe((snapshot, origin) => {
        if (origin !== 'publication') actor.send({type: 'RouteRequested', snapshot});
      }));
      if(ports.account) {
        subscriptions.push(ports.account.subscribeSession(access=>actor.send({type:'SessionChanged',access})));
        subscriptions.push(ports.account.subscribeLogout(ids=>actor.send({type:'LogoutObserved',ids})));
      }
    },
    send(event: ApplicationEvent) { actor.send(event); },
    subscribe(listener:(view:ApplicationView)=>void) {return subscribeView(actor,listener);},
    // Transitional handoff for the existing startup restorer; P06 moves its order into the machine.
    async requestRoute(snapshot: NavigationSnapshot, initial = false) {
      actor.send({type: 'RouteRequested', snapshot, initial});
      const request = actor.getSnapshot().context.request;
      await waitFor(actor, state => state.context.request?.snapshot !== request?.snapshot || !state.matches({running: {destination: 'preparing'}}));
    },
    async requestSession(access:AccountAccess|null) {
      actor.send({type:'SessionChanged',access});
      await accountReady(actor);
    },
    async requestSave(source:SavedChart) {
      actor.send({type:'SaveRequested',source});
      const write=actor.getSnapshot().children.write;
      if(write)await waitFor(write,state=>!writeContinuationView(state).busy);
    },
    async stop() { actor.getSnapshot().children.write?.send({type:'Stop'});actor.send({type: 'Stop'}); },
  };
}

export type Application = ReturnType<typeof createApplication>;
