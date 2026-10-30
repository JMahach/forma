import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {createAccountLibraryStore} from '../src/data/account-library-store.ts';
import {createAccountLibrary} from '../src/state/account-library.ts';
import type {CheckAuthority,CheckPermit} from '../src/domain/background-check.ts';
import type {LibraryCatalogPage} from '../shared/library-catalog-contract.ts';
import {accountChart} from './helpers/account-chart.ts';

const permit:CheckPermit={key:'library:1',token:'run-a',owner:'tab-a',startedAt:100,expiresAt:200,sessionId:'session-a'};
const empty={accountId:'1',marker:'2',entries:[]};
const page={kind:'page' as const,...empty,nextCursor:null};
function gate<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
async function fixture(t:test.TestContext) {
 let time=150;const storage=createAccountLibraryStore({indexedDB:new IDBFactory(),now:()=>time});
 t.after(()=>storage.close());const active=await storage.activate('1');assert.equal(active.status,'stored');
 if(active.status!=='stored')throw Error('setup');await storage.put(active.lease,[accountChart()]);
 const controller=new AbortController();
 const authority:CheckAuthority={permit:{...permit},signal:controller.signal,current:async()=>true};
 async function install(next:CheckPermit=permit){await storage.background.update(value=>{
  value.checks[next.key]={target:{key:next.key,scope:{kind:'library',accountId:'1'},sessionId:next.sessionId},
   lastAttemptAt:100,lastSuccessAt:null,nextDueAt:3600100,retryNotBefore:0,permit:{...next}};
 });}
 await install();
 return {storage,controller,authority,install,now:(value:number)=>{time=value;}};
}
async function libraryFixture(t:test.TestContext,catalog:()=>Promise<LibraryCatalogPage>=async()=>page) {
 const setup=await fixture(t);let notices=0;
 const library=createAccountLibrary({storage:setup.storage,online:()=>true,notify:()=>{notices++;},
  client:{catalog,confirmCatalog:async()=>({kind:'confirmed',accountId:'1',marker:'2'}),
   own:async()=>({chart:accountChart(2),catalogMarker:'3'})}});
 t.after(()=>library.close());await library.connect({accountId:'1',sessionId:'session-a'});
 return {...setup,library,notices:()=>notices};
}
test('a retired or expired permit cannot remove cards even with an unchanged library lease',async t=>{
 const {storage,authority,install,now}=await fixture(t),base=await storage.readCatalog();assert.ok(base);
 for(const changed of [{...permit,token:'run-b'},{...permit,owner:'tab-b'},{...permit,sessionId:'session-b'}]){
  await install(changed);assert.equal((await storage.putCatalog(base,empty,authority)).status,'superseded');
 }
 await install();now(200);
 for(const [stored,seen]of [[200,300],[300,200]]){
  await install({...permit,expiresAt:stored!});authority.permit.expiresAt=seen!;
  assert.equal((await storage.putCatalog(base,empty,authority)).status,'superseded');
 }
 assert.equal((await storage.read())!.charts.length,1);assert.equal((await storage.readCatalog())!.catalog,null);
});
test('a missing or completed permission cannot authorize catalogue acceptance',async t=>{
 const {storage,authority}=await fixture(t),base=await storage.readCatalog();assert.ok(base);
 await storage.background.update(control=>{delete control.checks[permit.key]!.permit;});
 assert.equal((await storage.putCatalog(base,empty,authority)).status,'superseded');
 await storage.background.update(control=>{delete control.checks[permit.key];});
 assert.equal((await storage.putCatalog(base,empty,authority)).status,'superseded');
 assert.equal((await storage.read())!.charts.length,1);
 const unavailable=createAccountLibraryStore({indexedDB:null});t.after(()=>unavailable.close());
 assert.equal((await unavailable.putCatalog(base,empty)).status,'unavailable');
});
test('abort inside a catalogue transaction rolls back removal and the catalogue together',async t=>{
 const {storage,authority,controller}=await fixture(t),base=await storage.readCatalog();assert.ok(base);
 const put=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(value,...args){const result=put.call(this,value,...args);
  if(this.name==='context' && value.key==='catalog')controller.abort();return result;};
 try{assert.notEqual((await storage.putCatalog(base,empty,authority)).status,'stored');}
 finally{IDBObjectStore.prototype.put=put;}
 assert.equal((await storage.read())!.charts.length,1);assert.equal((await storage.readCatalog())!.catalog,null);
});
test('hide before a delayed response prevents both RAM and disk acceptance without cancelling a user operation',async t=>{
 const began=gate<void>(),answer=gate<typeof page>();
 const {library,storage,authority,controller,notices}=await libraryFixture(t,()=>{began.resolve();return answer.promise;});
 const pending=library.load(authority);const outcome=pending.then(()=>null,error=>error);await began.promise;
 const userAccept=library.prepareAcceptance();controller.abort();answer.resolve(page);await outcome;
 assert.equal(library.charts.length,1);assert.equal((await storage.read())!.charts.length,1);assert.equal(notices(),0);
 await userAccept(accountChart(2).id,accountChart(2),'3');assert.equal(library.charts.length,2);
});
test('handoff while HTTP is pending cannot publish the former owners catalogue',async t=>{
 const began=gate<void>(),answer=gate<typeof page>();
 const {library,storage,authority,install,notices}=await libraryFixture(t,()=>{began.resolve();return answer.promise;});
 const pending=library.load(authority);const outcome=pending.then(()=>null,error=>error);await began.promise;
 await install({...permit,token:'run-b',owner:'tab-b'});
 let numericReads=0;const get=IDBObjectStore.prototype.getAll;
 IDBObjectStore.prototype.getAll=function(...args){if(this.name==='charts')numericReads++;return get.apply(this,args);};
 try{answer.resolve(page);await outcome;}finally{IDBObjectStore.prototype.getAll=get;}
 assert.equal(numericReads,0,'a superseded background request must not reload the full numerical library');
 assert.equal(library.charts.length,1);assert.equal((await storage.read())!.charts.length,1);assert.equal(notices(),0);
});
test('an authority rejected before loading does not start a server request',async t=>{
 let requests=0;const {library,authority}=await libraryFixture(t,async()=>{requests++;return page;});
 authority.current=async()=>false;
 await library.load(authority).catch(()=>{});assert.equal(requests,0);assert.equal(library.charts.length,1);
});
for(const retired of [false,true])test(`catalogue quota keeps RAM acceptance only for a live authority (${retired?'retired':'valid'})`,async t=>{
 const {library,storage,authority,notices}=await libraryFixture(t);let current=true;
 authority.current=async()=>current;
 const put=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(value,...args){
  if(this.name==='context' && value.key==='catalog'){if(retired)current=false;throw new DOMException('full','QuotaExceededError');}
  return put.call(this,value,...args);
 };
 try{await library.load(authority).catch(()=>{});}finally{IDBObjectStore.prototype.put=put;}
 assert.equal(library.charts.length,retired?1:0);assert.equal(notices(),retired?0:1);
 assert.equal((await storage.read())!.charts.length,1,'quota always rolls back deletion');
});
test('a new permit starts its own load instead of joining an aborted promise',async t=>{
 const began=gate<void>(),newBegan=gate<void>(),answer=gate<typeof page>();let requests=0;
 const {library,authority,controller,install}=await libraryFixture(t,()=>{requests++;if(requests===1){began.resolve();return answer.promise;}newBegan.resolve();return Promise.resolve(page);});
 const old=library.load(authority).catch(()=>{});await began.promise;controller.abort();
 const next={...permit,token:'run-b'};await install(next);
 const newer=library.load({...authority,permit:next,signal:new AbortController().signal});
 // Releasing the old transport later must not turn the new call into a join.
 let timer:ReturnType<typeof setTimeout>|undefined;
 const started=await Promise.race([newBegan.promise.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),500);})]);
 clearTimeout(timer);answer.resolve(page);await Promise.all([old,newer]);assert.equal(started,true);assert.equal(library.charts.length,0);
});
test('expiry while reading the removal set is supersession, never quota-like RAM fallback',async t=>{
 const {library,storage,authority,now,notices}=await libraryFixture(t),get=IDBObjectStore.prototype.getAllKeys;
 IDBObjectStore.prototype.getAllKeys=function(...args){const read=get.apply(this,args);
  if(this.name==='charts')read.addEventListener('success',()=>now(200));return read;};
 try{await library.load(authority).catch(()=>{});}finally{IDBObjectStore.prototype.getAllKeys=get;}
 assert.equal(library.charts.length,1);assert.equal((await storage.read())!.charts.length,1);assert.equal(notices(),0);
});
test('losing authority after a page prevents requesting another catalogue page',async t=>{
 let current=true,requests=0;const {library,authority}=await libraryFixture(t,async()=>{
  requests++;current=false;return {...page,nextCursor:requests===1?accountChart().id:null};
 });
 authority.current=async()=>current;await library.load(authority).catch(()=>{});
 assert.equal(requests,1);assert.equal(library.charts.length,1);
});
test('concurrent loads of the same live permit share one request and one acceptance',async t=>{
 const began=gate<void>(),answer=gate<typeof page>();let requests=0;
 const {library,authority,notices}=await libraryFixture(t,()=>{requests++;began.resolve();return answer.promise;});
 const first=library.load(authority);await began.promise;
 const second=library.load({...authority,permit:{...authority.permit}});answer.resolve(page);
 assert.deepEqual(await first,{status:'complete',durable:true});assert.deepEqual(await second,{status:'complete',durable:true});
 assert.equal(requests,1);assert.equal(notices(),1);
});
test('different permissions sharing a lifecycle signal do not share an old request',async t=>{
 const began=gate<void>(),newBegan=gate<void>(),answer=gate<LibraryCatalogPage>();let requests=0;
 const {library,authority,install}=await libraryFixture(t,()=>{requests++;if(requests===1){began.resolve();return answer.promise;}newBegan.resolve();return Promise.resolve(page);});
 const old=library.load(authority).catch(()=>{});await began.promise;
 const next={...permit,token:'run-b'};await install(next);const newer=library.load({...authority,permit:next});
 let timer:ReturnType<typeof setTimeout>|undefined;
 const started=await Promise.race([newBegan.promise.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),500);})]);
 clearTimeout(timer);answer.resolve(page);await Promise.all([old,newer]);assert.equal(started,true);
});
test('a foreground catalogue request remains independent of a cancelled background request',async t=>{
 const began=gate<void>(),newBegan=gate<void>(),answer=gate<LibraryCatalogPage>();let requests=0;
 const {library,authority,controller}=await libraryFixture(t,()=>{requests++;if(requests===1)began.resolve();else newBegan.resolve();return answer.promise;});
 const foreground=library.load();await began.promise;
 const background=library.load(authority).catch(()=>{});
 let timer:ReturnType<typeof setTimeout>|undefined;
 const started=await Promise.race([newBegan.promise.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),500);})]);
 clearTimeout(timer);controller.abort();answer.resolve(page);
 assert.deepEqual(await foreground,{status:'complete',durable:true});await background;assert.equal(started,true);assert.equal(library.charts.length,0);
});
test('no account, offline or closed libraries cannot start a background request',async t=>{
 for(const mode of ['account','offline','closed']){
  const {storage,authority}=await fixture(t);let requests=0;
  const library=createAccountLibrary({storage,online:()=>mode!=='offline',client:{
   catalog:async()=>{requests++;return page;},confirmCatalog:async()=>({kind:'confirmed',accountId:'1',marker:'2'}),own:async()=>assert.fail('unexpected own')
  }});t.after(()=>library.close());
  if(mode!=='account')await library.connect({accountId:'1',sessionId:'session-a'});if(mode==='closed')library.close();
  assert.deepEqual(await library.load(authority),{status:'inactive'});assert.equal(requests,0);
 }
});
