import { createAppBundle, type BundleCaches } from './app-bundle.ts';
import { readAppRoute } from '../../shared/app-routes.ts';
import { OFFLINE_VERSION, type OfflineCommand, type OfflineManifest, type OfflineTabRequest, type OfflineTabReply } from '../../shared/offline-contract.ts';

interface LifetimeEvent { waitUntil(value:Promise<unknown>):void }
export interface OfflineWorkerEvents {
 install:LifetimeEvent;activate:LifetimeEvent;
 fetch:{request:Request;respondWith(response:Promise<Response>):void};
 message:LifetimeEvent & {data:unknown;source:{id:string}|null;ports:readonly Pick<MessagePort,'postMessage'>[]};
}
interface OfflineWindowClient {
 id:string;type:string;url:string;postMessage(message:OfflineTabRequest,transfer:Transferable[]):void;
}
export interface OfflineWorkerScope {
 location:{origin:string};
 addEventListener<K extends keyof OfflineWorkerEvents>(type:K,listener:(event:OfflineWorkerEvents[K])=>void):void;
 fetch:typeof globalThis.fetch;
 skipWaiting():Promise<void>;
 clients:{get(id:string):Promise<OfflineWindowClient|undefined>;
  matchAll(options:{type:'window';includeUncontrolled:true}):Promise<OfflineWindowClient[]>};
}
function command(value:unknown):OfflineCommand|null {
 if(!value||typeof value!=='object')return null;
 const data=value as Partial<OfflineCommand>&{version?:unknown;previousVersion?:unknown};
 if(data.type!=='forma-offline')return null;
 if(data.action==='status')return {type:data.type,action:data.action};
 if(typeof data.version!=='string'||!OFFLINE_VERSION.test(data.version))return null;
 if(data.action==='activate-approved-version')return {type:data.type,action:data.action,version:data.version};
 if(data.action==='retire-approved-version'&&typeof data.previousVersion==='string'&&OFFLINE_VERSION.test(data.previousVersion)){
  return {type:data.type,action:data.action,version:data.version,previousVersion:data.previousVersion};
 }
 return null;
}
/** Browser lifecycle only. The coordinator decides when tab snapshots permit a transition. */
export function attachOfflineWorker(scope:OfflineWorkerScope,bundle:ReturnType<typeof createAppBundle>,
 {probeTimeoutMs=5000}:{probeTimeoutMs?:number}={}):void {
 if(!Number.isFinite(probeTimeoutMs)||probeTimeoutMs<=0||probeTimeoutMs>5000)throw new RangeError('Invalid tab-check timeout');
 let checking=false;
 async function appTabs(){
  return (await scope.clients.matchAll({type:'window',includeUncontrolled:true})).filter(client=>{
   try {const url=new URL(client.url);return client.type==='window'&&url.origin===scope.location.origin
    &&(url.pathname==='/index.html'||readAppRoute(url.pathname)!==null);}catch{return false;}
  });
 }
 function ask(client:OfflineWindowClient,message:OfflineTabRequest):Promise<boolean>{
  return new Promise(resolve=>{
   const channel=new MessageChannel();let done=false;
   const finish=(ready:boolean)=>{if(done)return;done=true;clearTimeout(timer);
    channel.port1.close();channel.port2.close();resolve(ready);};
   const timer=setTimeout(()=>finish(false),probeTimeoutMs);
   channel.port1.onmessage=event=>{
    const reply=event.data as Partial<OfflineTabReply>|null;
    finish(!!reply&&reply.type==='forma-offline-tab'&&reply.requestId===message.requestId
     &&reply.version===message.version&&reply.ready===true
     &&(message.action!=='verify-restored-tab'||reply.loadedVersion===message.version));
   };
   channel.port1.onmessageerror=()=>finish(false);
   try{client.postMessage(message,[channel.port2]);}catch{finish(false);}
  });
 }
 async function checkedTransition(request:Exclude<OfflineCommand,{action:'status'}>,sourceId:string):Promise<boolean>{
  if(checking)return false;checking=true;
  const preparing=request.action==='activate-approved-version',requestId=crypto.randomUUID();
  const message:OfflineTabRequest={type:'forma-offline-tab',action:preparing?'prepare-tab':'verify-restored-tab',
   version:request.version,requestId};
  let targets:OfflineWindowClient[]=[],accepted=false;
  try{
   targets=await appTabs();if(!targets.some(client=>client.id===sourceId))return false;
   const replies=await Promise.all(targets.map(async client=>({id:client.id,ready:await ask(client,message)})));
   const ready=new Set(replies.filter(reply=>reply.ready).map(reply=>reply.id));
   const allCurrentReady=async()=>{
    const current=await appTabs();return current.some(client=>client.id===sourceId)&&current.every(client=>ready.has(client.id));
   };
   // Closed tabs no longer need restoration. New, sleeping and unprepared tabs
   // cannot be assumed safe from another tab's answer or from a timeout.
   if(!await allCurrentReady())return false;
   if(preparing){
    await bundle.activate();if(!await allCurrentReady())return false;
    await scope.skipWaiting();accepted=true;
   }else accepted=await bundle.retireApprovedVersion(request.version,request.previousVersion);
   return accepted;
  }finally{
   if(preparing&&!accepted)for(const client of targets){
    try{client.postMessage({...message,action:'cancel-tab-update'},[]);}catch{}
   }
   checking=false;
  }
 }
 scope.addEventListener('install',event=>event.waitUntil(bundle.install()));
 scope.addEventListener('activate',event=>event.waitUntil(bundle.activate()));
 scope.addEventListener('fetch',event=>{
  if(bundle.handles(event.request))event.respondWith(bundle.match(event.request).then(cached=>cached??scope.fetch(event.request),()=>scope.fetch(event.request)));
 });
 scope.addEventListener('message',event=>{
  const request=command(event.data);if(!request||!event.source?.id)return;
  const sourceId=event.source.id;
  event.waitUntil((async()=>{
   const client=await scope.clients.get(sourceId);
   if(!client||client.type!=='window'||new URL(client.url).origin!==scope.location.origin)return;
   const status=await bundle.status();let accepted=false;
   if(request.action==='status')accepted=true;
   else if(request.version===status.version&&status.ready){
    accepted=await checkedTransition(request,sourceId);
   }
   event.ports[0]?.postMessage({type:'forma-offline',action:request.action,...status,accepted});
  })().catch(()=>{
   event.ports[0]?.postMessage({type:'forma-offline',action:request.action,accepted:false});
  }));
 });
}

declare const __FORMA_OFFLINE_MANIFEST__:OfflineManifest;
// The build supplies the closed public manifest; source imports used by model
// tests have no side effects and cannot accidentally register a development worker.
if(typeof __FORMA_OFFLINE_MANIFEST__!=='undefined'){
 const scope=globalThis as unknown as OfflineWorkerScope & {caches:BundleCaches};
 attachOfflineWorker(scope,createAppBundle({manifest:__FORMA_OFFLINE_MANIFEST__,
  origin:scope.location.origin,caches:scope.caches,fetch:scope.fetch.bind(scope)}));
}
