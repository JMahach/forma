import { OFFLINE_VERSION, type OfflineCommand, type OfflineStatus, type OfflineTabReply, type OfflineTabRequest } from '../../shared/offline-contract.ts';

interface PageOwner { prepare():boolean|Promise<boolean>; restored():boolean; subscribe?(listener:()=>void):()=>void }
type Reply={type:'forma-offline';action:OfflineCommand['action'];accepted:boolean}&Partial<OfflineStatus>&{previousVersions?:string[]};
interface Options {
 registration:ServiceWorkerRegistration;serviceWorker:ServiceWorkerContainer;loadedVersion:string;
 owner:PageOwner;hold:()=>()=>void;reload:()=>void;
 events?:EventTarget;visibility?:EventTarget&{hidden:boolean};timeoutMs?:number;
}
/** Only tab coordination lives here. The application owns its snapshot and
 * restoration; worker ownership never stands in for the code actually loaded. */
export function attachOfflinePage({registration,serviceWorker,loadedVersion,owner,hold,reload,
 events=window,visibility=document,timeoutMs=7000}:Options) {
 if(!OFFLINE_VERSION.test(loadedVersion))throw new TypeError('Missing loaded release identity');
 let disposed=false,reloading=false,deferred=false,checking:Promise<void>|null=null,checkAgain=false;
 type Preparation={requestId:string;version:string;worker:ServiceWorker;release:()=>void;timer:ReturnType<typeof setTimeout>};
 let prepared:Preparation|null=null,refreshing:Promise<void>|null=null;
 let reloadRelease:(()=>void)|null=null,reloadTimer:ReturnType<typeof setTimeout>|null=null;
 function releaseReload(){if(reloadTimer!==null)clearTimeout(reloadTimer);reloadTimer=null;reloadRelease?.();reloadRelease=null;}
 function navigationHidden(){releasePreparation();releaseReload();}
 function navigationShown(){releaseReload();reloading=false;void check();}
 const pending=new Set<()=>void>(),observedWorkers=new Set<ServiceWorker>(),askingWorkers=new Map<ServiceWorker,number>();
 function releasePreparation(){if(!prepared)return;const old=prepared;prepared=null;clearTimeout(old.timer);old.release();observeWorkers();}
 function known(worker:ServiceWorker|null){return !!worker&&[registration.waiting,registration.active,serviceWorker.controller].includes(worker);}
 function ask(worker:ServiceWorker,data:OfflineCommand):Promise<Reply|null>{
  return new Promise(resolve=>{
   askingWorkers.set(worker,(askingWorkers.get(worker)??0)+1);observeWorkers();
   const channel=new MessageChannel();let done=false;
   const finish=(value:Reply|null)=>{if(done)return;done=true;clearTimeout(timer);pending.delete(cancel);
    channel.port1.close();channel.port2.close();
    const waiting=askingWorkers.get(worker)!-1;if(waiting)askingWorkers.set(worker,waiting);else askingWorkers.delete(worker);
    observeWorkers();resolve(value);};
   const cancel=()=>finish(null),timer=setTimeout(cancel,timeoutMs);pending.add(cancel);
   channel.port1.onmessage=event=>{
    const reply=event.data as Reply|null;
    finish(reply?.type==='forma-offline'&&reply.action===data.action?reply:null);
   };
   channel.port1.onmessageerror=cancel;
   try{worker.postMessage(data,[channel.port2]);}catch{cancel();}
  });
 }
 function onMessage(raw:Event){
  const event=raw as MessageEvent,request=event.data as Partial<OfflineTabRequest>|null,worker=event.source as ServiceWorker|null;
  if(disposed||!known(worker)||request?.type!=='forma-offline-tab'
   ||typeof request.version!=='string'||!OFFLINE_VERSION.test(request.version)
   ||typeof request.requestId!=='string'||request.requestId.length>128)return;
  if(request.action==='cancel-tab-update'){
   if(prepared?.worker===worker&&prepared.requestId===request.requestId&&prepared.version===request.version)releasePreparation();return;
  }
  const port=event.ports[0];if(!port)return;
  const reply=(ready:boolean)=>{
   const value:OfflineTabReply={type:'forma-offline-tab',version:request.version!,requestId:request.requestId!,ready,loadedVersion};
   // The receiver closes the exchange after delivery. Closing this transferred
   // sender immediately can discard its queued reply in WebKit.
   try{port.postMessage(value);}catch{}
  };
  if(request.action==='verify-restored-tab'){reply(!disposed&&loadedVersion===request.version&&owner.restored());return;}
  if(request.action!=='prepare-tab')return;
  releasePreparation();
  const token:Preparation={requestId:request.requestId,version:request.version,worker:worker!,release:hold(),
   timer:setTimeout(()=>{if(prepared===token)releasePreparation();},Math.max(timeoutMs*2,10000))};
  prepared=token;
  void Promise.resolve().then(()=>owner.prepare()).then(ok=>{
   const ready=ok===true&&!disposed&&prepared===token;
   if(!ready&&prepared===token){deferred=true;releasePreparation();}reply(ready);
  },()=>{deferred=true;if(prepared===token)releasePreparation();reply(false);});
 }
 async function inspect(){
  if(disposed||reloading)return;
  const active=serviceWorker.controller??registration.active;
  const status=active?await ask(active,{type:'forma-offline',action:'status'}):null;
  if(disposed||reloading)return;
  if(status?.ready&&typeof status.version==='string'&&OFFLINE_VERSION.test(status.version)&&status.version!==loadedVersion){
   // Recheck persistence immediately before reload: data may have finished
   // loading between the earlier preparation and controllerchange.
   const release=hold();let navigating=false;
   try{
    if(await owner.prepare()&&!disposed&&active===(serviceWorker.controller??registration.active)){
     deferred=false;reloading=true;reloadRelease=release;
     // reload() only starts navigation. Keep the snapshot intact until the
     // document leaves; recover if the browser cancels that navigation.
     reloadTimer=setTimeout(()=>{releaseReload();reloading=false;deferred=true;},Math.max(timeoutMs*2,10000));
     reload();navigating=true;
    }else deferred=true;
   }catch{releaseReload();reloading=false;deferred=true;}
   finally{releasePreparation();if(!navigating)release();}
   return;
  }
  if(!owner.restored()){deferred=true;return;}
  const waiting=registration.waiting;
  if(waiting){
   const update=await ask(waiting,{type:'forma-offline',action:'status'});
   if(!disposed&&waiting===registration.waiting&&update?.ready&&typeof update.version==='string'&&OFFLINE_VERSION.test(update.version)){
    deferred=true;
    const activation=await ask(waiting,{type:'forma-offline',action:'activate-approved-version',version:update.version});
    deferred=activation?.accepted!==true;
    // Worker state/controller changes trigger another check; an approval alone
    // is not proof that the browser activated that worker.
   }
   return;
  }
  if(active&&status?.ready&&status.version===loadedVersion&&Array.isArray(status.previousVersions)){
   for(const previousVersion of new Set(status.previousVersions)){
    if(disposed||!owner.restored()||!OFFLINE_VERSION.test(previousVersion))return;
    await ask(active,{type:'forma-offline',action:'retire-approved-version',version:loadedVersion,previousVersion});
   }
  }
 }
 function check():Promise<void>{
  if(disposed)return Promise.resolve();
  observeWorkers();
  if(checking)return checking;
  checking=inspect().catch(()=>{}).finally(()=>{checking=null;if(checkAgain&&!disposed){checkAgain=false;void check();}});
  return checking;
 }
 const wake=()=>{if(checking)checkAgain=true;else void check();};
 function refresh(signal?:AbortSignal):Promise<void>{
  if(disposed || signal?.aborted)return Promise.resolve();
  wake();
  // Checking a known worker does not discover a release on the server.
  // The application background child is the only caller that discovers releases.
  if(!refreshing)refreshing=Promise.resolve().then(async()=>{if(!disposed && !signal?.aborted)await registration.update();}).finally(()=>{refreshing=null;if(!disposed)wake();});
  return refreshing;
 }
 // The state owner wakes a refused transition after an operation/restore or
 // durable input save. Preparing that very snapshot must not trigger a loop.
 const stopOwner=owner.subscribe?.(()=>{if(deferred&&!prepared&&!reloading&&!disposed)wake();});
 function observeWorkers(){
  if(disposed)return;
  // An uncontrolled page may already have a waiting/active worker at attach.
  // Its activation need not produce controllerchange for this page.
  const current=new Set([registration.installing,registration.waiting,registration.active,serviceWorker.controller,prepared?.worker,...askingWorkers.keys()]);
  for(const worker of observedWorkers)if(!current.has(worker)){worker.removeEventListener('statechange',wake);observedWorkers.delete(worker);}
  for(const worker of current){
   if(!worker||observedWorkers.has(worker))continue;
   observedWorkers.add(worker);worker.addEventListener('statechange',wake);
  }
 }
 serviceWorker.addEventListener('message',onMessage);
 serviceWorker.addEventListener('controllerchange',wake);
 registration.addEventListener('updatefound',observeWorkers);observeWorkers();
 events.addEventListener('pageshow',navigationShown);events.addEventListener('pagehide',navigationHidden);
 return {check,refresh,dispose(){
  disposed=true;stopOwner?.();releasePreparation();releaseReload();for(const cancel of pending)cancel();
  serviceWorker.removeEventListener('message',onMessage);serviceWorker.removeEventListener('controllerchange',wake);
  registration.removeEventListener('updatefound',observeWorkers);
  for(const worker of observedWorkers)worker.removeEventListener('statechange',wake);observedWorkers.clear();
  events.removeEventListener('pageshow',navigationShown);events.removeEventListener('pagehide',navigationHidden);
 }};
}

/** Preserve the snapshot while the short worker handshake runs, without
 * disabling/replacing controls or moving focus away from the current field. */
export function holdOfflineInput(target:EventTarget):()=>void {
 const names=['pointerdown','touchstart','click','keydown','beforeinput','submit','wheel'];
 const stop=(event:Event)=>{event.preventDefault();event.stopImmediatePropagation();};
 for(const name of names)target.addEventListener(name,stop,{capture:true,passive:false});
 return()=>{for(const name of names)target.removeEventListener(name,stop,true);};
}
