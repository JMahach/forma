import test from 'node:test';
import assert from 'node:assert/strict';
import { attachOfflineWorker, type OfflineWorkerScope, type OfflineWorkerEvents } from '../src/offline/service-worker.ts';
import type { OfflineTabRequest } from '../shared/offline-contract.ts';
import { createAppBundle } from '../src/offline/app-bundle.ts';

function fixture(){
 const listeners:Partial<{[K in keyof OfflineWorkerEvents]:(event:OfflineWorkerEvents[K])=>void}>={};
 const calls:string[]=[],responses:{accepted:boolean}[]=[],pending:Promise<unknown>[]=[];
 const version='a'.repeat(64);
 let ready=true,readFailure=false;
 const bundle:ReturnType<typeof createAppBundle>={
  async install(){calls.push('install');},
  async status(){return {version,ready};},
  async activate(){calls.push('activate');if(!ready)throw new Error('incomplete');},
  handles(request){return !new URL(request.url).pathname.startsWith('/api/');},
  async match(){if(readFailure)throw new Error('cache unavailable');return new Response('cached shell');},
  async retireApprovedVersion(current,old){calls.push('retire:'+current+':'+old);return true;},
 };
 const tabMessages:{id:string;message:OfflineTabRequest}[]=[];
 const tabs=new Map<string,{id:string;type:string;url:string;ready:boolean;loadedVersion:string;silent:boolean;
  onProbe?:()=>void;postMessage(message:OfflineTabRequest,ports:Transferable[]):void}>();
 function addTab(id:string,options:{ready?:boolean;loadedVersion?:string;silent?:boolean;onProbe?:()=>void}={}) {
  const tab={id,type:'window',url:'https://forma.test/account',ready:true,loadedVersion:version,silent:false,...options,
   postMessage(message:OfflineTabRequest,ports:Transferable[]){
    tabMessages.push({id,message});
    if(message.action==='cancel-tab-update'||tab.silent)return;
    tab.onProbe?.();
    (ports[0] as MessagePort).postMessage({type:'forma-offline-tab',requestId:message.requestId,
     version:message.version,ready:tab.ready,loadedVersion:tab.loadedVersion});
   }};
  tabs.set(id,tab);return tab;
 }
 addTab('known');
 const scope:OfflineWorkerScope={
  location:{origin:'https://forma.test'},
  addEventListener(type,listener){listeners[type]=listener as never;},
  async fetch(){calls.push('network');return new Response('network');},
  async skipWaiting(){calls.push('skipWaiting');},
  clients:{async get(id){return tabs.get(id);},async matchAll(){return [...tabs.values()];}},
 };
 attachOfflineWorker(scope,bundle,{probeTimeoutMs:25});
 const waitUntil=(promise:Promise<unknown>)=>{pending.push(promise);};
 const send=async(data:unknown,sourceId='known')=>{
  listeners.message!({data,source:{id:sourceId},ports:[{postMessage:value=>responses.push(value)}],waitUntil});
  await Promise.all(pending.splice(0));
 };
 return {listeners,calls,responses,send,version,waitUntil,pending,tabs,addTab,tabMessages,scope,setReady:(v:boolean)=>ready=v,setReadFailure:(v:boolean)=>readFailure=v};
}
test('install and activation never force takeover or retire a bundle',async()=>{
 const f=fixture();f.listeners.install!({waitUntil:f.waitUntil});await Promise.all(f.pending);
 f.listeners.activate!({waitUntil:f.waitUntil});await Promise.all(f.pending);
 assert.deepEqual(f.calls,['install','activate']);
});
test('only an identified local client with the exact ready version can request activation',async()=>{
 const f=fixture();
 await f.send({type:'forma-offline',action:'activate-approved-version',version:'b'.repeat(64)});
 await f.send({type:'forma-offline',action:'activate-approved-version',version:f.version},'unknown');
 assert.deepEqual(f.calls,[]);
 f.setReady(false);await f.send({type:'forma-offline',action:'activate-approved-version',version:f.version});
 assert.deepEqual(f.calls,[]);
 f.setReady(true);await f.send({type:'forma-offline',action:'activate-approved-version',version:f.version});
 assert.deepEqual(f.calls,['activate','skipWaiting']);
});
test('status and explicit retirement reply over the supplied port without reload or claim',async()=>{
 const f=fixture();
 await f.send({type:'forma-offline',action:'status'});
 assert.deepEqual(f.responses[0],{type:'forma-offline',action:'status',version:f.version,ready:true,accepted:true});
 await f.send({type:'forma-offline',action:'retire-approved-version',version:f.version,previousVersion:'b'.repeat(64)});
 assert.deepEqual(f.calls,['retire:'+f.version+':'+'b'.repeat(64)]);
});
test('private requests stay outside respondWith; public reads use cached response',async()=>{
 const f=fixture();const responses:Promise<Response>[]=[];
 const respondWith=(value:Promise<Response>)=>{responses.push(value);};
 f.listeners.fetch!({request:new Request('https://forma.test/api/charts'),respondWith});
 assert.equal(responses.length,0);
 f.listeners.fetch!({request:new Request('https://forma.test/account'),respondWith});
 assert.equal(await (await responses[0]).text(),'cached shell');assert.deepEqual(f.calls,[]);
});

test('unavailable CacheStorage falls through to the network instead of breaking the page',async()=>{
 const f=fixture();f.setReadFailure(true);const responses:Promise<Response>[]=[];
 f.listeners.fetch!({request:new Request('https://forma.test/account'),respondWith:value=>{responses.push(value);}});
 assert.equal(await (await responses[0]).text(),'network');assert.deepEqual(f.calls,['network']);
});


test('an unprepared or sleeping tab prevents takeover and releases prepared peers',async()=>{
 const f=fixture(),second=f.addTab('second',{ready:false});
 await f.send({type:'forma-offline',action:'activate-approved-version',version:f.version});
 assert.deepEqual(f.calls,[]);assert.equal(f.responses.at(-1)?.accepted,false);
 assert.ok(f.tabMessages.some(value=>value.id==='known'&&value.message.action==='cancel-tab-update'));
 second.ready=true;second.silent=true;
 await f.send({type:'forma-offline',action:'activate-approved-version',version:f.version});
 assert.deepEqual(f.calls,[]);assert.equal(f.responses.at(-1)?.accepted,false);
 second.silent=false;
 await f.send({type:'forma-offline',action:'activate-approved-version',version:f.version});
 assert.deepEqual(f.calls,['activate','skipWaiting']);
});

test('a tab that appears during preparation prevents activation until it too can preserve its state',async()=>{
 const f=fixture();f.tabs.get('known')!.onProbe=()=>{f.addTab('new',{ready:false});};
 await f.send({type:'forma-offline',action:'activate-approved-version',version:f.version});
 assert.deepEqual(f.calls,[]);assert.equal(f.responses.at(-1)?.accepted,false);
});

test('a ready reply about another attempt cannot approve takeover',async()=>{
 const f=fixture();f.tabs.get('known')!.postMessage=(message,ports)=>{
  if(message.action==='cancel-tab-update')return;
  (ports[0] as MessagePort).postMessage({type:'forma-offline-tab',requestId:crypto.randomUUID(),version:message.version,ready:true});
 };
 await f.send({type:'forma-offline',action:'activate-approved-version',version:f.version});
 assert.deepEqual(f.calls,[]);assert.equal(f.responses.at(-1)?.accepted,false);
});

test('retirement waits for every living tab to restore the actual new code, not just know its version',async()=>{
 const f=fixture(),second=f.addTab('second',{loadedVersion:'b'.repeat(64)});
 const command={type:'forma-offline',action:'retire-approved-version',version:f.version,previousVersion:'b'.repeat(64)};
 await f.send(command);assert.deepEqual(f.calls,[]);assert.equal(f.responses.at(-1)?.accepted,false);
 second.loadedVersion=f.version;second.ready=false;
 await f.send(command);assert.deepEqual(f.calls,[]);
 second.ready=true;second.silent=true;
 await f.send(command);assert.deepEqual(f.calls,[]);
 f.tabs.delete('second');
 await f.send(command);assert.deepEqual(f.calls,['retire:'+f.version+':'+'b'.repeat(64)]);
});


test('closed tabs no longer hold up a transition, while overlapping requests cannot activate twice',async()=>{
 const f=fixture();f.addTab('closed',{ready:false,onProbe:()=>{f.tabs.delete('closed');}});
 const command={type:'forma-offline',action:'activate-approved-version',version:f.version};
 await Promise.all([f.send(command),f.send(command)]);
 assert.deepEqual(f.calls,['activate','skipWaiting']);
 assert.equal(f.responses.filter(value=>value.accepted).length,1);
});

test('a failed takeover releases prepared tabs and does not poison the next attempt',async()=>{
 const f=fixture(),original=f.scope.skipWaiting;
 f.scope.skipWaiting=async()=>{throw new Error('activation unavailable');};
 const command={type:'forma-offline',action:'activate-approved-version',version:f.version};
 await f.send(command);assert.equal(f.responses.at(-1)?.accepted,false);
 const cancelled=f.tabMessages.find(value=>value.message.action==='cancel-tab-update');assert.ok(cancelled);
 const prepared=f.tabMessages.find(value=>value.message.action==='prepare-tab');
 assert.equal(cancelled.message.requestId,prepared?.message.requestId);
 f.scope.skipWaiting=original;await f.send(command);
 assert.equal(f.responses.at(-1)?.accepted,true);
});
