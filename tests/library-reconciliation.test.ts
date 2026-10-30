import test from 'node:test';
import type {ChartReply} from '../src/data/chart-client.ts';
import assert from 'node:assert/strict';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {createAccountLibraryStore} from '../src/data/account-library-store.ts';
import {accountChart} from './helpers/account-chart.ts';
import {cardSourceKey} from '../shared/library-package-contract.ts';
import type {LibraryCatalogEntry} from '../shared/library-catalog-contract.ts';
import {createAccountLibrary} from '../src/state/account-library.ts';

function entry(card=accountChart()):LibraryCatalogEntry {
 const {id,revision,name,source,birthDate,birthTime}=card;
 return {id,revision,name,source,birthDate,birthTime,packages:{card:{kind:'card',sourceKey:cardSourceKey(card)},day:null,majorReturns:null}};
}
async function fixture(t:test.TestContext){
 const indexedDB=new IDBFactory(),store=createAccountLibraryStore({indexedDB}),other=createAccountLibraryStore({indexedDB});
 t.after(()=>{store.close();other.close();});
 const active=await store.activate('1');if(active.status!=='stored')throw Error('owner');
 await store.put(active.lease,[accountChart(),accountChart(2)]);
 return {indexedDB,store,other,lease:active.lease};
}
test('only a complete catalogue transaction removes absent cards and persists its matching marker',async t=>{
 const {store,other}=await fixture(t),base=await store.readCatalog();assert.ok(base);
 const catalog={accountId:'1',marker:'3',entries:[entry()]};
 const result=await store.putCatalog(base,catalog);assert.equal(result.status,'stored');
 assert.deepEqual((await other.read())!.charts.map(row=>row.id),[accountChart().id]);
 const saved=await other.readCatalog();assert.deepEqual(saved?.catalog,catalog);
 assert.ok(saved);let writes=0;const put=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(...args){writes++;return put.apply(this,args);};
 try{assert.equal((await store.putCatalog(saved,catalog)).status,'stored');}finally{IDBObjectStore.prototype.put=put;}
 assert.equal(writes,0,'repeat of a confirmed catalogue writes nothing');
 assert.equal((await store.putCatalog(saved,{...catalog,marker:'2',entries:[]})).status,'superseded');
 assert.equal((await store.putCatalog(base,{...catalog,marker:'2',entries:[]})).status,'stale');
 assert.deepEqual((await other.readCatalog())?.catalog,catalog);
 const removal=await store.remove(saved.lease,accountChart(99).id,'3');assert.equal(removal.status,'stored');
 const partial=await store.readCatalog();assert.ok(partial);assert.equal(partial.catalog,null);
 await store.putCatalog(partial,catalog);
 assert.deepEqual((await other.readCatalog())?.catalog,catalog,'a fresh full confirmation repairs partial proof even at the same marker');
});
test('a newer local card or owner invalidates an older empty catalogue without deleting anything',async t=>{
 const {store,other,lease}=await fixture(t),base=await store.readCatalog();assert.ok(base);
 await other.put(lease,[accountChart(3)]);
 assert.equal((await store.putCatalog(base,{accountId:'1',marker:'2',entries:[]})).status,'superseded');
 assert.equal((await store.read())!.charts.length,3);assert.equal((await store.readCatalog())?.catalog,null);
 await store.activate('2');await store.activate('1');
 assert.equal((await store.putCatalog(base,{accountId:'1',marker:'2',entries:[]})).status,'stale');
});
test('catalogue quota abort restores removed cards and the prior catalogue together',async t=>{
 const {store}=await fixture(t),base=await store.readCatalog();assert.ok(base);
 const prior={accountId:'1',marker:'2',entries:[entry(),entry(accountChart(2))]};
 assert.equal((await store.putCatalog(base,prior)).status,'stored');
 const next=await store.readCatalog();assert.ok(next);const put=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(value,...args){if(this.name==='context' && value.key==='catalog')throw new DOMException('full','QuotaExceededError');return put.call(this,value,...args);};
 try{assert.equal((await store.putCatalog(next,{accountId:'1',marker:'3',entries:[]})).status,'unavailable');}finally{IDBObjectStore.prototype.put=put;}
 assert.equal((await store.read())!.charts.length,2);assert.deepEqual((await store.readCatalog())?.catalog,prior);
});

test('a retained marker with missing or damaged catalogue cannot stand in for the complete list',async t=>{
 const {store,indexedDB}=await fixture(t),base=await store.readCatalog();assert.ok(base);
 const valid={accountId:'1',marker:'2',entries:[entry(),entry(accountChart(2))]};await store.putCatalog(base,valid);
 const open=indexedDB.open('forma-account-library'),db=await new Promise<IDBDatabase>(resolve=>{open.onsuccess=()=>resolve(open.result);});t.after(()=>db.close());
 await new Promise<void>(resolve=>{const tx=db.transaction('context','readwrite');tx.objectStore('context').put({key:'catalog',accountId:'1',marker:'999',entries:[{id:'broken'}]});tx.oncomplete=()=>resolve();});
 const broken=await store.readCatalog();assert.ok(broken);assert.equal(broken.catalog,null);assert.equal((await store.read())!.charts.length,2);
 assert.equal((await store.putCatalog(broken,valid)).status,'stored');assert.deepEqual((await store.readCatalog())?.catalog,valid);
 await store.clear((await store.readCatalog())!.lease);assert.equal(await store.readCatalog(),null);
 await store.activate('1');assert.equal((await store.readCatalog())?.catalog,null,'same-account sign-in does not revive a retired catalogue');
});

test('the working library accepts fifteen light rows independently of heavy storage and never fetches their numbers',async t=>{
 const rows=Array.from({length:15},(_,index)=>entry(accountChart(index+1)));let calls=0;
 const client={catalog:async()=>{calls++;return {kind:'page' as const,accountId:'1',marker:'15',entries:rows,nextCursor:null};},
  confirmCatalog:async()=>({kind:'confirmed' as const,accountId:'1',marker:'15'}),
  own:async()=>assert.fail('catalogue acceptance must not fetch full cards')};
 const library=createAccountLibrary({storage:createAccountLibraryStore({indexedDB:null}),client,online:()=>true});t.after(()=>library.close());
 await library.connect({accountId:'1',sessionId:'one'});await library.load();
 assert.deepEqual(library.entries,rows);assert.deepEqual(library.charts,[]);assert.equal(library.has(rows[14]!.id),true);
 assert.equal(library.storageAvailable,false);assert.equal(calls,1);
});

test('an own confirmed write while an empty catalogue is awaiting confirmation survives in RAM and on disk',async t=>{
 const {store}=await fixture(t);let finish!:()=>void,started!:()=>void;
 const gate=new Promise<void>(resolve=>{finish=resolve;}),began=new Promise<void>(resolve=>{started=resolve;});
 const client={catalog:async()=>({kind:'page' as const,accountId:'1',marker:'0',entries:[],nextCursor:null}),
  confirmCatalog:async()=>{started();await gate;return {kind:'confirmed' as const,accountId:'1',marker:'0'};},
  own:async()=>assert.fail('ready write already contains its record')};
 const library=createAccountLibrary({storage:store,client,online:()=>true});t.after(()=>library.close());
 await library.connect({accountId:'1',sessionId:'one'});const pending=library.load();await began;
 await library.prepareAcceptance()(accountChart(3).id,accountChart(3),'1');finish();await pending;
 assert.equal(library.charts.length,3);assert.equal((await store.read())!.charts.length,3);
 assert.equal((await store.readCatalog())?.catalog,null);
});

test('late complete snapshots cannot erase a newer RAM write, and peer notices do no HTTP or numeric transfer',async t=>{
 const notices:unknown[]=[],session={accountId:'1',sessionId:'one'};
 const noRead=async():Promise<never>=>assert.fail('a receiving tab must not fetch');
 const library=createAccountLibrary({storage:createAccountLibraryStore({indexedDB:null}),
  client:{catalog:noRead,confirmCatalog:noRead,own:noRead},online:()=>true,notify:value=>notices.push(value)});
 t.after(()=>library.close());await library.connect(session);
 const incoming=(marker:string,entries:LibraryCatalogEntry[])=>({kind:'catalog',...session,durable:false,catalog:{accountId:'1',marker,entries}});
 await library.receive(incoming('10',[]));
 await library.prepareAcceptance()(accountChart().id,accountChart(),'11');
 assert.equal(notices.length,1);assert.equal(JSON.stringify(notices).includes('activations'),false);
 await library.receive(incoming('10',[]));assert.equal(library.charts.length,1);
 await library.receive({...incoming('12',[]),sessionId:'retired'});assert.equal(library.charts.length,1);
 await library.receive(incoming('12',[entry()]));
 await library.receive(incoming('11',[]));assert.equal(library.charts.length,1);
 let updates=0;library.subscribe(()=>updates++);updates=0;
 await library.receive(incoming('12',[entry()]));assert.equal(updates,0,'same marker and rows are a no-op');
 await library.receive(incoming('13',[]));assert.equal(library.charts.length,0);assert.equal(library.entries.length,0);
 await library.receive({kind:'record',...session,durable:false,marker:'12',entry:entry()});assert.equal(library.has(accountChart().id),false);
 await library.receive({...incoming('14',[entry()]),accountId:'2'});assert.equal(library.entries.length,0);
 await library.connect({accountId:'2',sessionId:'two'});await library.connect({...session,sessionId:'new'});
 await library.receive(incoming('99',[entry()]));assert.equal(library.entries.length,0,'A to B to A rejects retired session delivery');
});

test('a receiving tab lists fifteen new rows, preserves ready numbers until the new revision arrives, and never paints light rows',async t=>{
 const session={accountId:'1',sessionId:'one'},storage=createAccountLibraryStore({indexedDB:null});
 let online=true;const noRead=async():Promise<never>=>assert.fail('peer data does not schedule own reads');
 const library=createAccountLibrary({storage,client:{catalog:noRead,confirmCatalog:noRead,own:noRead},online:()=>online});
 t.after(()=>library.close());await library.connect(session);
 await library.prepareAcceptance()(accountChart().id,accountChart(),'1');
 const entries=Array.from({length:15},(_,i)=>entry({...accountChart(i+1),revision:2,name:'Renamed '+i}));
 await library.receive({kind:'catalog',...session,durable:false,catalog:{accountId:'1',marker:'2',entries}});
 assert.equal(library.entries.length,15);assert.equal(library.charts.length,1);assert.equal(library.get(accountChart().id)?.revision,1);
 assert.equal(library.isReady(accountChart().id),false);assert.deepEqual(library.readyIds,[]);online=false;
 await assert.rejects(library.open(accountChart().id),{code:'offline'});
});

test('a saved floor blocks an old peer snapshot even when its local read starts after the newer write',async t=>{
 const {store}=await fixture(t),base=await store.readCatalog();assert.ok(base);
 await store.put(base.lease,[accountChart(3)],'11');
 const current=await store.readCatalog();assert.ok(current);
 assert.equal((await store.putCatalog(current,{accountId:'1',marker:'10',entries:[]})).status,'superseded');
 assert.equal((await store.read())!.charts.length,3);
});

test('deleting one light row preserves its unloaded neighbours but invalidates unchanged proof',async t=>{
 const {store}=await fixture(t),base=await store.readCatalog();assert.ok(base);
 const catalog={accountId:'1',marker:'5',entries:Array.from({length:15},(_,i)=>entry(accountChart(i+1)))};
 const saved=await store.putCatalog(base,catalog);assert.equal(saved.status,'stored');if(saved.status!=='stored')return;
 await store.remove(saved.lease,accountChart().id,'6');
 const snapshot=await store.read();assert.equal(snapshot?.catalog?.entries.length,14);assert.equal(snapshot?.catalogComplete,false);
 assert.equal((await store.readCatalog())?.catalog,null,'a partial list must not authorize knownMarker');
 assert.equal(snapshot?.minimumMarker,'6');
});

test('an old absence receipt cannot erase the current chart accompanying its server observation',async t=>{
 const {createChartClient}=await import('../src/data/chart-client.ts'),{createChartActions}=await import('../src/state/chart-actions.ts');
 const session={accountId:'1',sessionId:'one'},chart=accountChart();let reads=0;
 const client=createChartClient({getSession:()=>session,fetch:async()=>{reads++;return new Response(JSON.stringify({kind:'absent',chartId:chart.id,catalogMarker:'2',chart}));}});
 const library=createAccountLibrary({client,storage:createAccountLibraryStore({indexedDB:null}),online:()=>true});t.after(()=>library.close());await library.connect(session);
 const actions=createChartActions({client,library,getSession:()=>session});
 const result=await actions.recover({operationId:'a'.repeat(32),expectedAccountId:'1'});
 assert.equal(result.kind,'settled');if(result.kind!=='settled')return;
 assert.equal(result.receipt.outcome.kind,'absent');assert.equal(library.get(chart.id)?.id,chart.id);assert.equal(reads,1);
});

test('a durable catalogue notice cannot roll back a newer complete catalogue already in the shared database',async t=>{
 const {store}=await fixture(t),noRead=async():Promise<never>=>assert.fail('peer never fetches');
 const library=createAccountLibrary({storage:store,client:{catalog:noRead,confirmCatalog:noRead,own:noRead},online:()=>true});t.after(()=>library.close());
 const session={accountId:'1',sessionId:'one'};await library.connect(session);
 const base=await store.readCatalog();assert.ok(base);await store.putCatalog(base,{accountId:'1',marker:'20',entries:[entry(),entry(accountChart(2))]});
 await library.receive({kind:'catalog',...session,durable:true,catalog:{accountId:'1',marker:'10',entries:[]}});
 assert.equal(library.charts.length,2);
 await store.activate('2');
 await library.receive({kind:'catalog',...session,durable:true,catalog:{accountId:'1',marker:'30',entries:[]}});
 assert.equal(library.charts.length,2,'a peer notice cannot use the other account now held by storage');
});

test('placing a RAM-only card after quota recovery retains its observed catalogue floor',async t=>{
 const {store}=await fixture(t),session={accountId:'1',sessionId:'one'},chart=accountChart(3);
 const noRead=async():Promise<never>=>assert.fail('opening a retained RAM source needs no HTTP');
 const library=createAccountLibrary({storage:store,client:{catalog:noRead,confirmCatalog:noRead,own:noRead},online:()=>true});t.after(()=>library.close());await library.connect(session);
 const put=store.put;store.put=async()=>({status:'unavailable'});
 try{await library.prepareAcceptance()(chart.id,chart,'11');}finally{store.put=put;}
 await library.markOpened(chart.id);
 const base=await store.readCatalog();assert.ok(base);assert.equal(base.minimumMarker,'11');
 assert.equal((await store.putCatalog(base,{accountId:'1',marker:'10',entries:[]})).status,'superseded');
});

test('durable light notices reuse the shared complete record, preserve neighbours and never echo or fetch',async t=>{
 const indexedDB=new IDBFactory(),session={accountId:'1',sessionId:'one'},messages:unknown[]=[],noRead=async():Promise<never>=>assert.fail('no receiver HTTP');
 const client={catalog:noRead,confirmCatalog:noRead,own:noRead};
 const a=createAccountLibrary({storage:createAccountLibraryStore({indexedDB}),client,online:()=>true,notify:value=>messages.push(value)});
 const b=createAccountLibrary({storage:createAccountLibraryStore({indexedDB}),client,online:()=>true,notify:()=>assert.fail('no echo')});
 t.after(()=>{a.close();b.close();});await a.connect(session);await b.connect(session);
 const chart=accountChart();await a.prepareAcceptance()(chart.id,chart,'1');await b.receive(messages.shift());
 assert.equal(b.get(chart.id)?.note,chart.note);
 const updated={...chart,revision:2,noteRevision:2,note:'new'};
 await a.prepareAcceptance()(chart.id,updated,'2');await b.receive(messages.shift());assert.equal(b.get(chart.id)?.note,'new');
 await a.forget(chart.id,'3');await b.receive(messages.shift());assert.equal(b.has(chart.id),false);
 const malformed=[null,7,{kind:'other'}, {kind:'record',...session,durable:true,marker:'x',entry:entry()},
  {kind:'record',...session,durable:true,marker:'4',entry:{}}, {kind:'removed',...session,durable:true,marker:'4',chartId:'bad'},
  {kind:'catalog',...session,durable:'yes',catalog:{}},{kind:'catalog',...session,durable:false,catalog:{accountId:'1',marker:'4',entries:{}}}];
 for(const value of malformed)await b.receive(value);
 assert.equal(b.entries.length,0);assert.equal(messages.length,0);
});

test('local command observations arriving out of order preserve confirmed deletion and current records',async t=>{
 const {createChartActions}=await import('../src/state/chart-actions.ts');
 const session={accountId:'1',sessionId:'one'},x=accountChart(),y=accountChart(2),intent={operationId:'b'.repeat(32),expectedAccountId:'1'};
 for(const scenario of ['deleted-other','newer-record','catalog-absence','catalog-unseen','old-absence','same-record'] as const){
  let reads=0;const latest={...x,revision:3};
  const client={create:async()=>assert.fail('no command'),update:async()=>assert.fail('no command'),remove:async()=>assert.fail('no command'),addFromSource:async()=>assert.fail('no command'),catalog:async()=>assert.fail('no catalogue request'),confirmCatalog:async()=>assert.fail('no confirm'),
   own:async()=>{reads++;if(scenario.startsWith('catalog-') || scenario==='same-record')throw Object.assign(Error('not_found'),{code:'not_found',details:{catalogMarker:'3'}});return {chart:latest,catalogMarker:'3'};},
   outcome:async():Promise<ChartReply>=>({...intent,catalogMarker:'2',outcome:{kind:scenario==='deleted-other'?'deleted':scenario==='old-absence'?'absent':'updated',chartId:x.id,revision:1},
    ...(['deleted-other','old-absence'].includes(scenario)?{}:{chart:x})})};
  const library=createAccountLibrary({client,storage:createAccountLibraryStore({indexedDB:null}),online:()=>true});t.after(()=>library.close());await library.connect(session);
  if(scenario!=='catalog-unseen')await library.prepareAcceptance()(x.id,x,'1');
  if(scenario==='deleted-other' || scenario==='same-record')await library.prepareAcceptance()(y.id,y,'3');
  else if(scenario.startsWith('catalog-'))await library.receive({kind:'catalog',...session,durable:false,catalog:{accountId:'1',marker:'3',entries:[]}});
  else await library.prepareAcceptance()(x.id,latest,'3');
  const actions=createChartActions({client,library,getSession:()=>session});
  const result=await actions.recover(intent);assert.equal(result.kind,'settled',scenario);if(result.kind!=='settled')continue;
  if(scenario==='deleted-other'){assert.equal(result.readError,undefined);assert.equal(library.has(x.id),false);assert.equal(library.has(y.id),true);}
  else if(scenario.startsWith('catalog-') || scenario==='same-record')assert.equal(library.has(x.id),false,scenario);
  else assert.equal(result.chart?.revision,3,scenario);
  assert.equal(reads,scenario.startsWith('catalog-')||scenario==='old-absence'||scenario==='same-record'?1:0,scenario);
 }
});

test('a complete catalogue fences a late record even when that deleted ID was never stored locally',async t=>{
 const {store,other,lease}=await fixture(t),base=await store.readCatalog();assert.ok(base);
 await store.putCatalog(base,{accountId:'1',marker:'3',entries:[entry(),entry(accountChart(2))]});
 const late=await other.put(lease,[accountChart(3)],'2');assert.equal(late.status,'stale');
 assert.deepEqual((await store.read())!.charts.map(row=>row.id),[accountChart().id,accountChart(2).id]);
});

test('command result reads require a current absence marker and never hide failure behind an older local card',async t=>{
 const session={accountId:'1',sessionId:'one'},card=accountChart();
 for(const scenario of ['connection','absence','late-absence','unproven-absence','outdated-cache'] as const){
  const marker=scenario==='absence'?'4':scenario==='late-absence'?'2':undefined;
  const error=Object.assign(Error(scenario),{code:['connection','outdated-cache'].includes(scenario)?'connection_failed':'not_found',details:{catalogMarker:marker}});
  let reads=0;
  const library=createAccountLibrary({storage:createAccountLibraryStore({indexedDB:null}),online:()=>true,
   client:{catalog:async()=>assert.fail('no catalogue fetch'),confirmCatalog:async()=>assert.fail('no confirmation'),own:async()=>{reads++;throw error;}}});
  t.after(()=>library.close());await library.connect(session);await library.prepareAcceptance()(card.id,card,'3');
  if(scenario==='outdated-cache')await library.receive({kind:'record',...session,durable:false,marker:'4',entry:entry({...card,revision:2})});
  const accept=library.prepareAcceptance();
  if(scenario!=='outdated-cache'){assert.equal(await library.open(card.id),card);assert.equal(reads,0);}
  await assert.rejects(accept(card.id),{code:scenario==='late-absence'?'library_changed':error.code});
  assert.equal(reads,1);
  assert.equal(library.has(card.id),scenario!=='absence',scenario);
 }
});

const peerSession={accountId:'1',sessionId:'one'};
const peerNoRead=async():Promise<never>=>assert.fail('no HTTP in peer scenario');
const deferred=()=>{let resolve!:()=>void;return {promise:new Promise<void>(done=>{resolve=done;}),resolve};};
test('confirmed RAM absence survives a later read of the older disk snapshot after catalog quota',async t=>{
 const indexedDB=new IDBFactory(),storage=createAccountLibraryStore({indexedDB});
 const initial=await storage.activate('1');assert.equal(initial.status,'stored');if(initial.status!=='stored')return;
 const x=accountChart(),y=accountChart(2);
 await storage.put(initial.lease,[x,y],'2');
 await storage.putCatalog((await storage.readCatalog())!,{accountId:'1',marker:'2',entries:[entry(x),entry(y)]});
 const current={accountId:'1',marker:'3',entries:[entry(y)]};
 const library=createAccountLibrary({storage,online:()=>true,client:{
  catalog:async()=>({...current,kind:'page' as const,nextCursor:null}),
  confirmCatalog:async()=>({accountId:'1',marker:'3',kind:'confirmed' as const}),own:peerNoRead,
 }});t.after(()=>library.close());await library.connect(peerSession);
 const put=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(value,...args){
  if(this.name==='context' && value.key==='catalog')throw new DOMException('full','QuotaExceededError');
  return put.call(this,value,...args);
 };
 try{assert.deepEqual(await library.load(),{status:'complete',durable:false});}finally{IDBObjectStore.prototype.put=put;}
 assert.equal(library.has(x.id),false);assert.equal(library.get(x.id),undefined);
 assert.equal((await storage.read())?.charts.some(row=>row.id===x.id),true,'quota left the old disk transaction intact');
 await library.refreshLocal();
 assert.equal(library.has(x.id),false,'old IDB content must not undo the newer complete absence');
});

test('delayed observed absence cannot delete a card first created by another tab at a newer marker',async t=>{
 const indexedDB=new IDBFactory(),storage=createAccountLibraryStore({indexedDB}),other=createAccountLibraryStore({indexedDB});
 t.after(()=>other.close());
 const library=createAccountLibrary({storage,online:()=>true,client:{catalog:peerNoRead,confirmCatalog:peerNoRead,own:peerNoRead}});
 t.after(()=>library.close());await library.connect(peerSession);
 const base=(await storage.readCatalog())!,chart=accountChart(),entered=deferred(),release=deferred(),remove=storage.remove;
 storage.remove=async(...args)=>{entered.resolve();await release.promise;return remove(...args);};
 const absent=assert.rejects(library.forget(chart.id,'2','absence'),{code:'library_changed'});await entered.promise;
 assert.equal((await other.put(base.lease,[chart],'3')).status,'stored');
 assert.equal((await other.read())?.charts.length,1);
 release.resolve();await absent;
 const snapshot=await other.read();
 assert.equal(snapshot?.charts.some(row=>row.id===chart.id),true,'the M2 absence must not delete the new M3 card');
 assert.equal(library.get(chart.id)?.id,chart.id,'rejected removal restores the current local projection');
});

test('an in-flight own read at the newly accepted catalog marker still opens its confirmed card',async t=>{
 const storage=createAccountLibraryStore({indexedDB:new IDBFactory()}),card=accountChart(),entered=deferred(),release=deferred();
 const catalog={accountId:'1',marker:'3',entries:[entry(card)]};
 const library=createAccountLibrary({storage,online:()=>true,client:{
  catalog:async()=>({...catalog,kind:'page' as const,nextCursor:null}),
  confirmCatalog:async()=>({accountId:'1',marker:'3',kind:'confirmed' as const}),
  own:async()=>{entered.resolve();await release.promise;return {chart:card,catalogMarker:'3'};},
 }});t.after(()=>library.close());await library.connect(peerSession);
 const opening=library.open(card.id);await entered.promise;
 assert.deepEqual(await library.load(),{status:'complete',durable:true});
 release.resolve();
 assert.equal((await opening).id,card.id,'a current M3 read is not stale merely because M3 retired its old lease');
});

for(const boundary of ['clear','other-account'] as const)test('a durable record notice is rejected after the disk owner retires: '+boundary,async t=>{
 const indexedDB=new IDBFactory(),storage=createAccountLibraryStore({indexedDB}),other=createAccountLibraryStore({indexedDB});
 t.after(()=>other.close());
 const library=createAccountLibrary({storage,online:()=>true,client:{catalog:peerNoRead,confirmCatalog:peerNoRead,own:peerNoRead}});
 t.after(()=>library.close());await library.connect(peerSession);
 if(boundary==='clear')await other.clearAccount('1');else await other.activate('2');
 await library.receive({kind:'record',...peerSession,durable:true,marker:'2',entry:entry()});
 assert.equal(library.entries.length,0,'a notice cannot publish after its own local-read guard retired the account');
 await library.receive({kind:'record',...peerSession,durable:false,marker:'3',entry:entry()});
 assert.equal(library.entries.length,0,'subsequent queued notices cannot reacquire the retired owner');
});

test('an unrelated newer disk marker cannot revive a quota-retained absent card',async t=>{
 const indexedDB=new IDBFactory(),storage=createAccountLibraryStore({indexedDB}),other=createAccountLibraryStore({indexedDB});
 t.after(()=>other.close());const active=await storage.activate('1');if(active.status!=='stored')throw Error('owner');
 const x=accountChart(),y=accountChart(2);await storage.put(active.lease,[x,y],'2');
 await storage.putCatalog((await storage.readCatalog())!,{accountId:'1',marker:'2',entries:[entry(x),entry(y)]});
 const current={accountId:'1',marker:'3',entries:[entry(y)]};
 const library=createAccountLibrary({storage,online:()=>true,client:{catalog:async()=>({...current,kind:'page' as const,nextCursor:null}),
  confirmCatalog:async()=>({accountId:'1',marker:'3',kind:'confirmed' as const}),own:peerNoRead}});
 t.after(()=>library.close());await library.connect(peerSession);
 const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,...args){
  if(this.name==='context' && value.key==='catalog')throw new DOMException('full','QuotaExceededError');return put.call(this,value,...args);
 };
 try{assert.deepEqual(await library.load(),{status:'complete',durable:false});}finally{IDBObjectStore.prototype.put=put;}
 assert.equal(library.has(x.id),false);
 const newerY={...y,revision:2,name:'Y at M4'},base=(await other.readCatalog())!;
 assert.equal((await other.put(base.lease,[newerY],'4')).status,'stored');
 await library.receive({kind:'record',...peerSession,durable:true,marker:'4',entry:entry(newerY)});
 const disk=await other.readCatalog();
 assert.equal(library.has(x.id),false,'a newer global marker for Y is not evidence of current X');
 const z=accountChart(3);await other.put(base.lease,[z],'5');
 await library.receive({kind:'record',...peerSession,durable:true,marker:'5',entry:entry(z)});
 assert.equal(library.get(z.id)?.id,z.id,'a current positive notice may admit a newly created record after the full catalogue');
 assert.equal(library.has(x.id),false);
});
