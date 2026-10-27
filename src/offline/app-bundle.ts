import { readAppRoute } from '../../shared/app-routes.ts';
import { normalizeAppMetadata } from '../../shared/app-metadata.ts';
import { OFFLINE_ASSET, OFFLINE_VERSION, validateOfflineManifest, type OfflineManifest, type OfflineFile, type OfflineStatus } from '../../shared/offline-contract.ts';

type BundleCache = Pick<Cache,'match'|'put'>;
export interface BundleCaches {
 keys(): Promise<string[]>;
 has(name:string): Promise<boolean>;
 delete(name:string): Promise<boolean>;
 open(name:string): Promise<BundleCache>;
}
const PREFIX='forma:app:';
const COMPLETE='/__forma_offline_complete__';
interface Completion { version:string; previous:string[] }
const versionFromName=(name:string)=>name.startsWith(PREFIX)?/^([a-f0-9]{64}):[a-f0-9]{32}$/.exec(name.slice(PREFIX.length))?.[1]??null:null;
async function bytesWithin(response:Response,limit:number):Promise<Uint8Array<ArrayBuffer>> {
 const reader=response.body?.getReader();if(!reader)return new Uint8Array(0);
 const chunks:Uint8Array[]=[];let size=0;
 try{
  for(;;){const {value,done}=await reader.read();if(done)break;
   size+=value.length;if(size>limit)throw new Error('Offline response exceeds expected size');chunks.push(value);
  }
 }catch(error){await reader.cancel().catch(()=>{});throw error;}
 finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}return bytes;
}
async function digest(bytes:Uint8Array<ArrayBuffer>) {
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
}

async function verifiedBytes(response:Response,file:OfflineFile):Promise<Uint8Array<ArrayBuffer>> {
 const bytes=await bytesWithin(response,file.bytes+(file.url==='/index.html'?512:0));
 const checked=file.url==='/index.html'?new TextEncoder().encode(normalizeAppMetadata(new TextDecoder('utf-8',{fatal:true}).decode(bytes))):bytes;
 if(checked.byteLength!==file.bytes||await digest(checked)!==file.sha256)throw new Error('Offline integrity mismatch');
 return bytes;
}

/** A complete version has its marker written last. Fetches never write to this store.
 * The later tab-restoration coordinator alone approves activation and retirement. */
export function createAppBundle({manifest:input,origin,caches,fetch:fetchFile}:{
 manifest:OfflineManifest;origin:string;caches:BundleCaches;fetch:typeof globalThis.fetch;
}) {
 const manifest=validateOfflineManifest(input),base=new URL(origin).origin;
 if(base!==origin)throw new TypeError('Offline origin must be canonical');
 const marker=base+COMPLETE,files=new Map(manifest.files.map(file=>[file.url,file]));
 let selectedName:string|undefined;
 let installing:Promise<void>|undefined,installed=false;
 async function completion(cacheName:string):Promise<Completion|null>{
  if(!await caches.has(cacheName))return null;
  const response=await (await caches.open(cacheName)).match(marker);if(!response)return null;
  try{
   const value:unknown=await response.json();
   if(!value || typeof value!=='object')return null;
   const row=value as Partial<Completion>;
   return row.version===versionFromName(cacheName)&&Array.isArray(row.previous)
    &&row.previous.every(v=>typeof v==='string'&&versionFromName(v)!==null&&v!==cacheName)
    ?row as Completion:null;
  }catch{return null;}
 }
 async function locate():Promise<string|null>{
  if(selectedName&&await completion(selectedName))return selectedName;
  selectedName=undefined;
  for(const key of (await caches.keys()).reverse()){
   if(versionFromName(key)===manifest.version&&await completion(key)){selectedName=key;return key;}
  }
  return null;
 }
 async function ready(){
  const name=await locate();
  if(!name||!await completion(name))return false;
  const cache=await caches.open(name);
  try{
   for(const file of manifest.files){
    const response=await cache.match(base+file.url);if(!response)return false;
    await verifiedBytes(response,file);
   }
  }catch{return false;}
  return true;
 }
 async function prepare(){
  const reusable=await ready();
  if(installed&&reusable)return;
  const source=reusable&&selectedName?await caches.open(selectedName):null;
  const previous:string[]=[];
  // Called only by the one root registration's install event. The browser
  // serializes those jobs across tabs and waits for install.waitUntil(), so a
  // partial cache from an earlier job has no live writer. Never do this in fetch
  // or activate, where a newer installation could already be running.
  for(const key of await caches.keys()){
   const version=versionFromName(key);
   if(!version)continue;
   if(await completion(key))previous.push(key);
   else await caches.delete(key);
  }
  // Cache names identify an installation, not just content: repeating a stale
  // retirement can never delete a later installation of the same content.
  const installation=[...crypto.getRandomValues(new Uint8Array(16))].map(n=>n.toString(16).padStart(2,'0')).join('');
  const name=PREFIX+manifest.version+':'+installation;
  const controller=new AbortController();
  try{
   const cache=await caches.open(name);
   let next=0;
   const download=async()=>{
    while(next<manifest.files.length&&!controller.signal.aborted){
     const file=manifest.files[next++],url=base+file.url;
     const timeout=setTimeout(()=>controller.abort(),30_000);
     try{
      const response=source?await source.match(url):await fetchFile(url,{credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal});
      if(!response)throw new Error('Reusable offline file disappeared');
      if(response.status!==200||response.redirected||response.url&&response.url!==url)throw new Error('Invalid offline response');
      const bytes=await verifiedBytes(response,file);
      // Fetch exposes decoded bytes; a constructed cached response must not claim
      // that those bytes are still a compressed network representation.
      const headers=new Headers(response.headers);headers.delete('Content-Encoding');headers.delete('Content-Length');
      await cache.put(url,new Response(bytes,{status:200,headers}));
     }catch(error){controller.abort();throw error;}
     finally{clearTimeout(timeout);}
    }
   };
   const results=await Promise.allSettled(Array.from({length:Math.min(4,manifest.files.length)},download));
   const failure=results.find((r):r is PromiseRejectedResult=>r.status==='rejected');
   if(failure)throw failure.reason;
   if(controller.signal.aborted)throw new Error('Offline download interrupted');
   await cache.put(marker,new Response(JSON.stringify({version:manifest.version,previous}),{headers:{'Content-Type':'application/json'}}));
   selectedName=name;installed=true;
  }catch(error){
   // A failed removal is retried by the next installation. The old complete
   // selection remains readable even if a partial cache could not be removed.
   await caches.delete(name).catch(()=>{});throw error;
  }
 }
 function route(request:Request):string|null {
  if(request.method!=='GET')return null;
  const url=new URL(request.url);if(url.origin!==base)return null;
  if(request.mode==='navigate'){
   if(readAppRoute(url.pathname)||url.pathname==='/index.html')return '/index.html';
   if(url.pathname==='/love'||url.pathname==='/love.html')return '/love.html';
   return null;
  }
  return !url.search&&(files.has(url.pathname)||OFFLINE_ASSET.test(url.pathname))?url.pathname:null;
 }
 return {
  install():Promise<void>{
   if(!installing)installing=prepare().finally(()=>{installing=undefined;});
   return installing;
  },
  async status():Promise<OfflineStatus>{
   const complete=await ready(),name=complete?await locate():null,own=name?await completion(name):null;
   const previous=new Set<string>();
   for(const key of own?.previous??[]){if(await caches.has(key))previous.add(versionFromName(key)!);}
   return {version:manifest.version,ready:complete,...(previous.size?{previousVersions:[...previous]}:{})};
  },
  async activate(){if(!await ready())throw new Error('Offline bundle is not complete');},
  handles(request:Request){return route(request)!==null;},
  async match(request:Request):Promise<Response|undefined>{
   const url=route(request);if(!url)return;
   const name=await locate();
   if(name&&await completion(name)){
    const response=await (await caches.open(name)).match(base+url);if(response)return response;
   }
   // A newly activated worker may still serve an older tab while its snapshot
   // is restored. Only content-versioned assets cross this boundary, never HTML.
   if(!OFFLINE_ASSET.test(url))return;
   for(const key of await caches.keys()){
    if(key===name||!versionFromName(key)||!await completion(key))continue;
    const response=await (await caches.open(key)).match(base+url);if(response)return response;
   }
  },
  async retireApprovedVersion(activeVersion:string,previousVersion:string):Promise<boolean>{
   if(activeVersion!==manifest.version||!OFFLINE_VERSION.test(previousVersion)||!await ready())return false;
   const name=await locate(),own=name?await completion(name):null;
   // The installation records its predecessors; a stale worker cannot delete
   // a version created later, even if it receives an obsolete retirement message.
   const predecessors=own?.previous.filter(key=>versionFromName(key)===previousVersion)??[];
   let removed=false;for(const key of predecessors)removed=await caches.delete(key)||removed;
   return removed;
  },
 };
}
