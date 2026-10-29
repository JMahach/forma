import {fromPromise,setup,type SnapshotFrom} from 'xstate';

export interface StartupPorts {
  ready():Promise<void>;
  route():Promise<void>;
  current():boolean;
  restore(signal:AbortSignal):Promise<boolean>;
  resume():Promise<boolean|void>|boolean|void;
  commit():void;
  report():void;
  changed():void;
}
export type StartupEvent={type:'StartupInterrupted'}|{type:'Stop'};
type Result='ready'|'failed'|'interrupted';

async function attempt(step:()=>Promise<boolean|void>|boolean|void,ports:StartupPorts,current:()=>boolean) {
  try{return await step()!==false;}
  catch{if(current())ports.report();return false;}
}
async function restore(ports:StartupPorts,signal:AbortSignal):Promise<Result> {
  const current=()=>!signal.aborted && ports.current();
  await ports.ready();
  if(!current())return 'interrupted';
  await ports.route();
  if(!current())return 'interrupted';
  const restored=await attempt(()=>ports.restore(signal),ports,current);
  if(!current())return 'interrupted';
  const resumed=await attempt(ports.resume,ports,current);
  if(!current())return 'interrupted';
  ports.commit();
  return restored && resumed?'ready':'failed';
}

/** The state owns the sequence and its lifetime; existing owners restore values. */
export function createStartupMachine(ports:StartupPorts) {
  return setup({
    types:{events:{} as StartupEvent},
    actors:{restore:fromPromise(({signal})=>restore(ports,signal))},
  }).createMachine({
    id:'startup',initial:'restoring',
    on:{Stop:'.stopped',StartupInterrupted:'.interrupted'},
    states:{
      restoring:{invoke:{src:'restore',onDone:[
        {guard:({event})=>event.output==='ready',target:'ready'},
        {guard:({event})=>event.output==='failed',target:'failed'},
        {target:'interrupted'},
      ],onError:{target:'failed',actions:()=>ports.report()}}},
      ready:{},failed:{},interrupted:{},stopped:{on:{StartupInterrupted:{}}},
    },
  });
}
export function startupView(snapshot:SnapshotFrom<ReturnType<typeof createStartupMachine>>) {
  return {restored:snapshot.matches('ready') || snapshot.matches('failed') || snapshot.matches('interrupted'),
    failed:snapshot.matches('failed')};
}
