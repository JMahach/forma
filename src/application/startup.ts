import {fromPromise,setup,type SnapshotFrom} from 'xstate';

import type {NavigationPort,NavigationSnapshot,StartupPorts,StartupEvent} from './ports.ts';
export interface StartupRuntime {
  ready():Promise<void>;project():void;route(snapshot:NavigationSnapshot):Promise<void>;
}
type Result='ready'|'failed'|'interrupted';

async function attempt(step:()=>Promise<boolean|void>|boolean|void,ports:StartupPorts,current:()=>boolean) {
  try{return await step()!==false;}
  catch{if(current())ports.report();return false;}
}
async function restore(ports:StartupPorts,runtime:StartupRuntime,navigation:NavigationPort|undefined,initial:NavigationSnapshot|undefined,signal:AbortSignal):Promise<Result> {
  const current=()=>!signal.aborted && !ports.view.interrupted && (!initial || navigation!.isCurrent(initial));
  await runtime.ready();
  if(!current())return 'interrupted';
  runtime.project();
  if(initial)await runtime.route(initial);
  if(!current())return 'interrupted';
  const selected=ports.view.savedSelection;
  if(initial?.route?.kind!=='chart' && selected && ports.library.get(selected)){
    try{await ports.library.open(selected,signal);}catch{/* Only an accepted local record may be restored. */}
  }
  if(!current())return 'interrupted';
  const restored=await attempt(()=>ports.view.restore(signal),ports,current);
  if(!current())return 'interrupted';
  const resumed=await attempt(()=>ports.view.resume(),ports,current);
  if(!current())return 'interrupted';
  const draft=ports.form.pending;ports.form.clearPending();
  if(draft && !ports.form.opened)ports.form.restore(draft);
  ports.view.flush();
  return restored && resumed?'ready':'failed';
}

/** The state owns the sequence and its lifetime; existing owners restore values. */
export function createStartupMachine(ports:StartupPorts,runtime:StartupRuntime,navigation?:NavigationPort) {
  const initial=navigation?.snapshot;
  return setup({
    types:{events:{} as StartupEvent},
    actors:{restore:fromPromise(({signal})=>restore(ports,runtime,navigation,initial,signal))},
  }).createMachine({
    id: 'startup',
    initial: 'restoring',
    on: {Stop: '.stopped', StartupInterrupted: '.interrupted'},
    states: {
      restoring: {
        invoke: {
          src: 'restore',
          onDone: [
            {guard: ({event}) => event.output === 'ready', target: 'ready'},
            {guard: ({event}) => event.output === 'failed', target: 'failed'},
            {target: 'interrupted'},
          ],
          onError: {target: 'failed', actions: () => ports.report()},
        },
      },
      ready: {},
      failed: {},
      interrupted: {},
      stopped: {on: {StartupInterrupted: {}}},
    },
  });
}
export function startupView(snapshot:SnapshotFrom<ReturnType<typeof createStartupMachine>>) {
  // Settled means the attempt ended, not that every value was restored.
  return {settled:snapshot.matches('ready') || snapshot.matches('failed') || snapshot.matches('interrupted'),
    failed:snapshot.matches('failed')};
}
