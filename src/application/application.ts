import { createActor, waitFor, type ActorRefFrom, type SnapshotFrom } from 'xstate';
import type {EnvironmentChange} from './background-work.ts';
import {routeForChart} from './route.ts';
import type {AppRoute} from '../../shared/app-routes.ts';
import {createApplicationMachine,applicationRestored,applicationUpdateReady,applicationAccountReady} from './application-machine.ts';
import { createUpdatePreparation } from './update.ts';
import { startupView } from './startup.ts';
import { writeContinuationView, type TemporaryWriteBinding } from './write-continuation.ts';
import type { SavedChart } from '../../shared/chart-types.ts';
import type {CheckAuthority} from '../domain/background-check.ts';
import type {CheckResult} from './background-work.ts';
import type { ApplicationEvent, ApplicationPorts as ApplicationOptions, ApplicationRuntimePorts as ApplicationPorts, ApplicationView, NavigationSnapshot, AccountAccess,AccountBoundaryResult,AccountJournal } from './ports.ts';


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
function readAccount(actor:ApplicationActor) {
  const state=actor.getSnapshot().children.account?.getSnapshot();
  return {status:state?.value??'stopped',access:state?.context.access??null,request:state?.context.request??null};
}
async function requestSession(actor:ApplicationActor,access:AccountAccess|null):Promise<AccountBoundaryResult> {
  if(!actor.getSnapshot().matches('running'))return {status:'stopped'};
  actor.send({type:'SessionChanged',access});
  const account=actor.getSnapshot().children.account;
  if(!account)return {status:'ready'};
  const request=account.getSnapshot().context.request;
  try{await waitFor(account,state=>state.context.request!==request || !state.matches('preparing'));}
  catch{if(!actor.getSnapshot().matches('running'))return {status:'stopped'};return {status:'failed'};}
  if(!actor.getSnapshot().matches('running'))return {status:'stopped'};
  const state=account.getSnapshot();
  return {status:state.context.request!==request?'superseded':state.matches('ready')?'ready':'failed'};
}
async function restoreAccount(ports:ApplicationPorts) {
  if(!ports.account)return;
  try{await ports.account.library.restore();}
  catch(error){if((error as {code?:string})?.code!=='account_changed')throw error;}
  await ports.account.ready;
}
async function awaitSources(actor:ApplicationActor,sources:Promise<void>) {
  const controller=new AbortController();
  try {
    await Promise.race([sources,waitFor(actor,state=>!state.matches('running'),{signal:controller.signal}).then(()=>{
      throw Object.assign(new Error('Application stopped'),{code:'account_changed'});
    })]);
  }finally{controller.abort();}
}

function whenBackgroundIdle(actor:ApplicationActor,ports:ApplicationPorts,signal?:AbortSignal) {
  const {background,libraryFill,libraryAudit,write}=actor.getSnapshot().children;
  if(!background && !libraryFill && !libraryAudit && !write)return;
  return Promise.all([background?new Promise<void>(complete=>background.send({type:'BackgroundIdle',complete,signal})):undefined,
    libraryFill?new Promise<void>(complete=>libraryFill.send({type:'FillIdle',complete,signal})):undefined,
    libraryAudit?new Promise<void>(complete=>libraryAudit.send({type:'AuditIdle',complete,signal})):undefined,
    write?waitFor(write,state=>!writeContinuationView(state).recovering,{signal}):undefined,
    ports.write?.actions.whenIdle?.(signal)]).then(()=>{});
}
function readWrite(actor:ApplicationActor,initialBinding:TemporaryWriteBinding|null=null) {
  const write=actor.getSnapshot().children.write;
  return write?writeContinuationView(write.getSnapshot()):{source:null,busy:false,recovering:false,waitingForLogin:false,binding:actor.getSnapshot().matches('created')?initialBinding:null};
}
function readStartup(actor:ApplicationActor) {
  const startup=actor.getSnapshot().children.startup;
  return startup?startupView(startup.getSnapshot()):{restored:false,failed:false};
}
function connectInputs(actor:ApplicationActor,ports:ApplicationPorts) {
  const subscriptions:(()=>void)[]=[];
  if(ports.navigation)subscriptions.push(ports.navigation.subscribe((snapshot, origin) => {
    if (origin !== 'publication') actor.send({type: 'RouteRequested', snapshot});
  }));
  if(ports.account) {
    subscriptions.push(ports.account.subscribeSession(access=>actor.send({type:'SessionChanged',access})));
    subscriptions.push(ports.account.subscribeLogout(ids=>actor.send({type:'LogoutObserved',ids})));
  }
  return subscriptions;
}

function stopRuntime(actor:ApplicationActor) {
  const {startup,write,publicRefresh}=actor.getSnapshot().children;
  startup?.send({type:'Stop'});write?.send({type:'Stop'});publicRefresh?.send({type:'CancelPublicRefresh'});actor.send({type:'Stop'});
}

async function destinationSettled(actor:ApplicationActor) {
  const request=actor.getSnapshot().context.request;
  await waitFor(actor,state=>!state.matches({running:{destination:'preparing'}})
    || (request?.selection?state.context.request?.selection!==request.selection:state.context.request?.snapshot!==request?.snapshot));
}

export function createApplication(input: ApplicationOptions) {
  const ports:ApplicationPorts={...input,
    route:input.route && {...input.route,view:{...input.route.view,
      markOpened:id=>actor.send({type:'LibraryUsed',id}),
      publicRead(checkedAt,receivedAt){const source=ports.route!.sources.publicChart;if(source)actor.send({type:'PublicSourceRead',source,checkedAt,receivedAt});},
    }},
    write:input.write && {...input.write,ready:requireAccount,view:{...input.write.view,
      signIn:()=>actor.send({type:'WorkspaceRequested',screen:'account'}),
      select:id=>actor.send({type:'ChartSelected',id,replace:true}),
      publishChart:id=>actor.send({type:'RoutePublished',route:{kind:'chart',id},replace:true}),
    }},
    publicRefresh:input.publicRefresh && {...input.publicRefresh,view:{...input.publicRefresh.view,
      selectTransit:()=>actor.send({type:'ChartSelected',id:'current-transit',replace:true}),
    }},
  };
  const subscriptions:(()=>void)[]=[];
  let sources:Promise<void>=Promise.resolve();
  const updating=ports.update?createUpdatePreparation(ports.update,{
    ready:()=>applicationUpdateReady(actor.getSnapshot(),ports),
    changed(){actor.send({type:'BackgroundChanged'});},
    idle:signal=>whenBackgroundIdle(actor,ports,signal),
  }):null;
  const machine = createApplicationMachine(ports, () => {
    for(const stop of subscriptions.splice(0))stop();
  },()=>sources,()=>applicationAccountReady(actor.getSnapshot(),ports)?undefined:requireAccount(),
  {ready:requireAccount,project:()=>actor.send({type:'LibraryChanged'}),async route(snapshot){
    actor.send({type:'RouteRequested',snapshot,initial:true});await destinationSettled(actor);
  }},()=>updating?.active===true,()=>actor);
  const actor = createActor(machine);
  const readView = () => applicationView(actor.getSnapshot());
  async function requireAccount(){
    await awaitSources(actor,sources);
    const result=await requestSession(actor,ports.account?.getSession()??null);
    if(result.status!=='ready')throw Object.assign(new Error(`Account boundary ${result.status}`),
      {code:result.status==='failed'?'storage_unavailable':'account_changed'});
  }
  actor.start();
  return {
    get view() { return readView(); },
    get write() {return readWrite(actor,ports.write?.initialBinding);},
    get startup() {return readStartup(actor);},
    get account(){return readAccount(actor);},
    isRestored(){return applicationRestored(actor.getSnapshot(),ports);},
    prepareUpdate(signal?:AbortSignal){return updating?.prepare(signal)??false;},
    start() {
      if (!actor.getSnapshot().matches('created')) return;
      sources=restoreAccount(ports);
      actor.send({type: 'Start'});
      void sources.then(async()=>{
        if(!ports.account)return;
        const result=await requestSession(actor,ports.account.getSession());
        if(result.status==='ready' && !ports.account.library.storageAvailable)ports.account.storageUnavailable();
      }).catch(()=>{}); // Consumers receive the same failure through requireAccount.
      subscriptions.push(...connectInputs(actor,ports));
    },
    send(event: ApplicationEvent) { actor.send(event); },
    attachJournal(journal:AccountJournal){actor.send({type:'JournalAttached',journal});},
    environmentChanged(change:EnvironmentChange) {actor.send({type:'BackgroundEnvironment',change});},
    receiveLibrary(data:unknown):Promise<void> {
      if(!ports.background || !actor.getSnapshot().matches('running'))return Promise.resolve();
      return new Promise(resolve=>actor.send({type:'LibraryReceived',data,completed:resolve}));
    },
    whenBackgroundIdle:(signal?:AbortSignal)=>whenBackgroundIdle(actor,ports,signal)??Promise.resolve(),
    backgroundChanged:()=>actor.send({type:'BackgroundChanged'}),
    requireAccount,
    libraryChanged(){actor.send({type:'LibraryChanged'});},
    formSaved(id:string,{metadataOnly=false}={}){actor.send({type:'FormSaved',id,metadataOnly});},
    routeForChart:(id:string)=>routeForChart(ports.route!,id),
    publishRoute:(route:AppRoute,replace=false)=>actor.send({type:'RoutePublished',route,replace}),
    async openChart(id:string,options:Omit<Extract<ApplicationEvent,{type:'OpenChartRequested'}>,'type'|'id'>={}) {
      actor.send({type:'OpenChartRequested',id,...options});await destinationSettled(actor);
    },
    selectChart:(id:string,options:Omit<Extract<ApplicationEvent,{type:'ChartSelected'}>,'type'|'id'>={})=>actor.send({type:'ChartSelected',id,...options}),
    navigateWorkspace:(screen:Extract<ApplicationEvent,{type:'WorkspaceRequested'}>['screen'],options:Omit<Extract<ApplicationEvent,{type:'WorkspaceRequested'}>,'type'|'screen'>={})=>actor.send({type:'WorkspaceRequested',screen,...options}),
    refreshPublic(authority:CheckAuthority):Promise<CheckResult> {
      if(!ports.publicRefresh || readView().lifecycle!=='running')return Promise.resolve({outcome:{kind:'cancelled'}});
      return new Promise(resolve=>actor.send({type:'RefreshPublicSource',authority,completed:resolve}));
    },
    subscribe(listener:(view:ApplicationView)=>void) {return subscribeView(actor,listener);},
    async whenRestored() {
      const startup=actor.getSnapshot().children.startup;
      if(startup)await waitFor(startup,state=>!state.matches('restoring'));
    },
    // Startup and later navigation share the same route owner.
    async requestRoute(snapshot: NavigationSnapshot, initial = false) {
      actor.send({type: 'RouteRequested', snapshot, initial});
      await destinationSettled(actor);
    },
    requestSession:(access:AccountAccess|null)=>requestSession(actor,access),
    async requestSave(source:SavedChart) {
      actor.send({type:'SaveRequested',source});
      const write=actor.getSnapshot().children.write;
      if(write)await waitFor(write,state=>!writeContinuationView(state).busy);
    },
    async stop() {stopRuntime(actor);updating?.stop();},
  };
}

export type Application = ReturnType<typeof createApplication>;
