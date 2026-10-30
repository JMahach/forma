import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createAccountLibraryStore,type LibraryLease } from '../src/data/account-library-store.ts';
import { createAccountLibrary } from '../src/state/account-library.ts';
import { accountChart, chartId } from './helpers/account-chart.ts';
import type { ChartClient } from '../src/data/chart-client.ts';

const session = {accountId: '1', sessionId: 'first-session'};
const noNetwork = async (): Promise<never> => { throw new Error('offline data must not request a server'); };
function client(rows = [accountChart()]): Pick<ChartClient, 'catalog' | 'confirmCatalog' | 'own'> {
  let marker=1,signature=JSON.stringify(rows);
  const current=()=>{const next=JSON.stringify(rows);if(next!==signature){marker++;signature=next;}return String(marker);};
  const entry=(chart:ReturnType<typeof accountChart>)=>{const {id,revision,name,source,birthDate,birthTime}=chart;
    return {id,revision,name,source,birthDate,birthTime,packages:{card:{kind:'card' as const,sourceKey:JSON.stringify([id,revision])},day:null,majorReturns:null}};};
  return {
    async catalog({expectedAccountId,knownMarker}) {const marker=current();return knownMarker===marker
      ?{kind:'unchanged',accountId:expectedAccountId,marker}
      :{kind:'page',accountId:expectedAccountId,marker,entries:rows.filter(row=>row.accountId===expectedAccountId).map(entry),nextCursor:null};},
    async confirmCatalog({expectedAccountId,marker}) {return {kind:marker===current()?'confirmed':'restart',accountId:expectedAccountId,marker:current()};},
    async own({chartId: id}) {const chart=rows.find(row=>row.id===id);if(!chart)throw Object.assign(new Error(),{code:'not_found',details:{catalogMarker:current()}});
      return {chart,catalogMarker:current()};},
  };
}
// These scenarios need already acquired numerical fixtures. A catalogue refresh
// alone intentionally does not perform that acquisition anymore.
async function acceptFixtureCards(library:ReturnType<typeof createAccountLibrary>,marker='1') {
  for(const entry of library.entries) {
    const chart=accountChart(Number.parseInt(entry.id,16),library.accountId!,entry.revision);
    await library.prepareAcceptance()(entry.id,{...chart,name:entry.name},marker);
  }
}
async function placeUnderQuota(storage:ReturnType<typeof createAccountLibraryStore>,lease:LibraryLease,incoming=accountChart(3),victims=1) {
 const put=IDBObjectStore.prototype.put,remove=IDBObjectStore.prototype.delete,removed=new WeakMap<IDBTransaction,number>();
 IDBObjectStore.prototype.delete=function(key){if(this.name==='charts')removed.set(this.transaction,(removed.get(this.transaction)??0)+1);return remove.call(this,key);};
 IDBObjectStore.prototype.put=function(value,...args){
  if(this.name==='charts' && value.id===incoming.id && (removed.get(this.transaction)??0)<victims)throw new DOMException('full','QuotaExceededError');
  return put.call(this,value,...args);
 };
 try {assert.equal(await storage.touch(lease,incoming.id,incoming),true);}
 finally {IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.delete=remove;}
}
test('prepared acceptance cannot read or accept for a retired session, including retained offline data',async()=>{
  for(const transition of ['logout','session','account','close','guest']) {
    const storage=createAccountLibraryStore({indexedDB:new IDBFactory()}), source=client();
    let reads=0, online=true;const own=source.own;
    source.own=(...args)=>{reads++;return own(...args);};
    const library=createAccountLibrary({storage,client:source,online:()=>online});
    try {
      if(transition!=='guest'){await library.connect(session);await library.load();}
      const accept=library.prepareAcceptance();
      if(transition==='logout')await library.connect(null);
      if(transition==='session')await library.connect({...session,sessionId:'next'});
      if(transition==='account')await library.connect({accountId:'2',sessionId:'other'});
      if(transition==='close'){online=false;library.close();}
      await assert.rejects(accept(chartId(1),accountChart()),{code:'account_changed'},transition);
      assert.equal(reads,0,transition);
    } finally {library.close();}
  }
});
test('offline restore keeps the downloaded library after expiry without asking the server', async () => {
  const storage = createAccountLibraryStore({indexedDB: new IDBFactory()});
  const active = await storage.activate('1'); assert.equal(active.status, 'stored');
  await storage.put(active.lease, [accountChart()]);
  const library = createAccountLibrary({storage, client: {catalog:noNetwork,confirmCatalog:noNetwork,own:noNetwork}, online: () => false});
  try {
    await library.restore(); await library.connect(null);
    assert.equal(library.charts.length, 1);
    assert.equal((await library.open(chartId(1))).note, 'Личная заметка');
  } finally { library.close(); }
});

test('a new account replaces the working library and expiry alone retains its downloaded cards', async () => {
  const storage = createAccountLibraryStore({indexedDB: new IDBFactory()});
  const library = createAccountLibrary({storage, client: client([accountChart(2, '2')]), online: () => true});
  try {
    const first = await storage.activate('1'); assert.equal(first.status, 'stored'); await storage.put(first.lease, [accountChart()]);
    await library.restore();
    const changing = library.connect({accountId: '2', sessionId: 'second'});
    assert.equal(library.charts.length, 0);
    await changing; await library.load();await acceptFixtureCards(library);
    assert.deepEqual(library.charts.map(chart => chart.accountId), ['2']);
    await library.connect(null); assert.equal(library.charts.length, 1);
  } finally { library.close(); }
});

test('a late page after logout cannot repopulate memory or IndexedDB', async () => {
  const storage = createAccountLibraryStore({indexedDB: new IDBFactory()});
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const source = client(); const original = source.catalog;
  source.catalog = async (...args) => { await gate; return original(...args); };
  const library = createAccountLibrary({storage, client: source, online: () => true});
  try {
    await library.connect(session);
    const pending = library.load(); const refused = assert.rejects(pending, {code: 'account_changed'});
    await library.clear(); release(); await refused;
    assert.deepEqual(library.charts, []); assert.deepEqual((await storage.read())!.charts, []);
  } finally { library.close(); }
});

test('a deletion from another tab invalidates a pending card response', async () => {
  const indexedDB = new IDBFactory(), storage = createAccountLibraryStore({indexedDB}), other = createAccountLibraryStore({indexedDB});
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const source = client(), original = source.own;
  source.own = async (...args) => { await gate; return original(...args); };
  const library = createAccountLibrary({storage, client: source, online: () => true});
  try {
    await library.connect(session); await library.load();
    const pending = library.open(chartId(1)), refused = assert.rejects(pending, {code: 'library_changed'});
    const snapshot = await other.read(); await other.remove(snapshot!.lease!, chartId(1));
    release(); await refused;
    assert.deepEqual(library.charts, []); assert.deepEqual((await storage.read())!.charts, []);
  } finally { library.close(); other.close(); }
});

test('cancelling one open aborts its request without cancelling another open or accepting a late response', async () => {
  const storage = createAccountLibraryStore({indexedDB: new IDBFactory()}), source = client();
  const signals: AbortSignal[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  source.own = async ({chartId: id}, signal) => {
    signals.push(signal!);
    await gate; // Also exercise a transport which delivers a response after abort.
    return {chart:id===chartId(1)?accountChart(1):accountChart(2),catalogMarker:'1'};
  };
  const library = createAccountLibrary({storage, client:source, online:()=>true});
  try {
    await library.connect(session);
    const cancelled = new AbortController();
    const first = library.open(chartId(1), cancelled.signal), second = library.open(chartId(2));
    const refused = assert.rejects(first, {name:'AbortError'});
    cancelled.abort();
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, false);
    release(); await refused;
    assert.equal((await second).id, chartId(2));
    assert.deepEqual(library.charts.map(chart => chart.id), [chartId(2)]);
    assert.deepEqual((await storage.read())!.charts.map(chart => chart.id), [chartId(2)]);
  } finally { release(); library.close(); }
});

test('cancelled opens do no work and cannot apply a late deletion or cached fallback', async () => {
  const storage = createAccountLibraryStore({indexedDB:new IDBFactory()}), source = client();
  const library = createAccountLibrary({storage, client:source, online:()=>true});
  try {
    await library.connect(session); await library.load();await acceptFixtureCards(library);
    let calls = 0;
    source.own = async () => { calls++; return {chart:accountChart(),catalogMarker:'1'}; };
    await assert.rejects(library.open(chartId(1), AbortSignal.abort()), {name:'AbortError'});
    assert.equal(calls, 0);
    for (const code of ['not_found', 'connection_failed']) {
      const cancelled = new AbortController();
      source.own = async () => { cancelled.abort(); throw Object.assign(new Error(code), {code}); };
      await assert.rejects(library.open(chartId(1), cancelled.signal), {name:'AbortError'});
      assert.equal(library.get(chartId(1))!.id, chartId(1));
      assert.equal((await storage.read())!.charts[0].id, chartId(1));
    }
  } finally { library.close(); }
});

test('a server card remains usable in memory if local storage is unavailable', async () => {
  const library = createAccountLibrary({storage: createAccountLibraryStore({indexedDB: null}), client: client(), online: () => true});
  try {
    await library.connect(session); const chart = await library.open(chartId(1));
    assert.equal(chart.id, chartId(1)); assert.equal(library.charts.length, 1); assert.equal(library.storageAvailable, false);
  } finally { library.close(); }
});

test('a stored ready calculation remains usable offline without a calculation marker', async () => {
  const storage = createAccountLibraryStore({indexedDB: new IDBFactory()});
  const active = await storage.activate('1'); assert.equal(active.status, 'stored'); await storage.put(active.lease, [accountChart()]);
  const library = createAccountLibrary({storage, client: {catalog:noNetwork,confirmCatalog:noNetwork,own:noNetwork}, online: () => false});
  try {
    await library.restore(); assert.deepEqual(await library.open(chartId(1)), accountChart());
    assert.equal(library.charts[0]!.note, 'Личная заметка');
  } finally { library.close(); }
});

test('an older late open cannot return numbers older than the working record', async () => {
  const storage = createAccountLibraryStore({indexedDB: new IDBFactory()});
  let release!: () => void, count = 0; const gate = new Promise<void>(resolve => { release = resolve; });
  const source = client();
  source.own = async () => { if (++count === 1) { await gate; return {chart:accountChart(1,'1',2),catalogMarker:'1'}; } return {chart:accountChart(1,'1',3),catalogMarker:'1'}; };
  const library = createAccountLibrary({storage, client: source, online: () => true});
  try {
    await library.connect(session);
    const old = library.open(chartId(1)); await library.open(chartId(1)); release();
    assert.equal((await old).revision, 3); assert.equal(library.get(chartId(1))!.revision, 3);
  } finally { library.close(); }
});

test('unavailable numeric storage does not stop subsequent light catalogue refreshes', async () => {
  let calls = 0; const source = client(), list = source.catalog;
  source.catalog = async (...args) => { calls++; return list(...args); };
  const library = createAccountLibrary({storage: createAccountLibraryStore({indexedDB: null}), client: source, online: () => true});
  try {
    await library.connect(session); await library.load(); await library.load();
    assert.equal(calls, 2); assert.equal(library.entries.length, 1);assert.equal(library.charts.length,0);
  } finally { library.close(); }
});

test('reading an older local copy cannot roll back a confirmed card kept in memory after a storage failure', async () => {
  const storage = createAccountLibraryStore({indexedDB: new IDBFactory()});
  const first = await storage.activate('1'); assert.equal(first.status, 'stored');
  await storage.put(first.lease, [accountChart()]);
  const library = createAccountLibrary({storage, client: client([accountChart(1, '1', 2)]), online: () => true});
  try {
    await library.connect(session);
    const put = storage.put;
    storage.put = async () => ({status: 'unavailable'});
    await library.open(chartId(1)); storage.put = put;
    await library.refreshLocal();
    assert.equal(library.get(chartId(1))!.revision, 2);
  } finally { library.close(); }
});


test('logout clears the account even while its first activation has not returned a lease', async () => {
  const storage = createAccountLibraryStore({indexedDB: new IDBFactory()});
  const old = await storage.activate('1'); assert.equal(old.status, 'stored'); await storage.put(old.lease, [accountChart()]);
  const library = createAccountLibrary({storage, client: client(), online: () => true});
  try {
    const connecting = library.connect(session), refused = assert.rejects(connecting, {code: 'account_changed'});
    await library.clear(); await refused;
    assert.deepEqual((await storage.read())!.charts, []);
    await library.restore(); assert.deepEqual(library.charts, []);
  } finally {library.close();}
});

test('logout clears the same account after another tab has advanced its generation', async () => {
  const indexedDB = new IDBFactory(), storage = createAccountLibraryStore({indexedDB}), other = createAccountLibraryStore({indexedDB});
  const library = createAccountLibrary({storage, client: client([accountChart(), accountChart(2)]), online: () => true});
  try {
    await library.connect(session); await library.load();
    const old = await other.read(); await other.remove(old!.lease!, chartId(1));
    await library.clear(); assert.deepEqual((await other.read())!.charts, []);
  } finally {library.close(); other.close();}
});

test('a stale account logout cannot erase the other account currently held by storage', async () => {
  const indexedDB = new IDBFactory(), storage = createAccountLibraryStore({indexedDB}), other = createAccountLibraryStore({indexedDB});
  const library = createAccountLibrary({storage, client: client(), online: () => true});
  try {
    await library.connect(session); await library.load();
    const next = await other.activate('2'); assert.equal(next.status, 'stored'); await other.put(next.lease, [accountChart(2, '2')]);
    await library.clear(); assert.deepEqual((await other.read())!.charts.map(chart => chart.accountId), ['2']);
  } finally {library.close(); other.close();}
});


test('logout during initial cache reading also clears the account before any lease is restored', async () => {
  const storage = createAccountLibraryStore({indexedDB: new IDBFactory()});
  const old = await storage.activate('1'); assert.equal(old.status, 'stored'); await storage.put(old.lease, [accountChart()]);
  const library = createAccountLibrary({storage, client: client(), online: () => false});
  try {
    const restoring = library.restore(), refused = assert.rejects(restoring, {code: 'account_changed'});
    await Promise.resolve(); await library.clear(); await refused;
    assert.equal((await storage.read())!.charts.length, 0);
  } finally {library.close();}
});


test('concurrent confirmed deletions both leave memory and IndexedDB without dropping another chart', async () => {
  const storage = createAccountLibraryStore({indexedDB: new IDBFactory()});
  const library = createAccountLibrary({storage, client: client([accountChart(1), accountChart(2), accountChart(3)]), online: () => true});
  try {
    await library.connect(session); await library.load();await acceptFixtureCards(library);
    const outcomes = await Promise.allSettled([library.forget(chartId(1)), library.forget(chartId(2))]);
    assert.deepEqual((await storage.read())!.charts.map(chart => chart.id), [chartId(3)]);
    assert.deepEqual(library.charts.map(chart => chart.id), [chartId(3)]);
    assert.ok(outcomes.every(result => result.status === 'fulfilled'));
  } finally { library.close(); }
});

test('a confirmed deletion renews a stale same-account lease and removes only its target', async () => {
  const indexedDB = new IDBFactory(), storage = createAccountLibraryStore({indexedDB}), other = createAccountLibraryStore({indexedDB});
  const library = createAccountLibrary({storage, client: client([accountChart(1), accountChart(2), accountChart(3)]), online: () => true});
  try {
    await library.connect(session); await library.load();await acceptFixtureCards(library);
    const before = await other.read(); await other.remove(before!.lease!, chartId(1));
    await library.forget(chartId(2));
    assert.deepEqual((await storage.read())!.charts.map(chart => chart.id), [chartId(3)]);
    assert.deepEqual(library.charts.map(chart => chart.id), [chartId(3)]);
  } finally { library.close(); other.close(); }
});

test('a confirmed deletion cannot adopt the different account now held by IndexedDB', async () => {
  const indexedDB = new IDBFactory(), storage = createAccountLibraryStore({indexedDB}), other = createAccountLibraryStore({indexedDB});
  const library = createAccountLibrary({storage, client: client(), online: () => true});
  try {
    await library.connect(session); await library.load();await acceptFixtureCards(library);
    const next = await other.activate('2'); assert.equal(next.status, 'stored');
    await other.put(next.lease, [accountChart(1, '2')]);
    await library.forget(chartId(1)).catch(error => { assert.equal(error.code, 'account_changed'); });
    assert.deepEqual((await other.read())!.charts.map(chart => [chart.id, chart.accountId]), [[chartId(1), '2']]);
    assert.deepEqual(library.charts, []); assert.equal(library.accountId, null);
  } finally { library.close(); other.close(); }
});

test('a session change cancels queued deletions before they can acquire a new local lease', async () => {
  const storage = createAccountLibraryStore({indexedDB: new IDBFactory()});
  const library = createAccountLibrary({storage, client: client([accountChart(1), accountChart(2)]), online: () => true});
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const remove = storage.remove;
  let calls = 0;
  storage.remove = async (...args) => { if (++calls === 1) { entered(); await gate; } return remove(...args); };
  try {
    await library.connect(session); await library.load();await acceptFixtureCards(library);
    const first = library.forget(chartId(1)); await started;
    const second = library.forget(chartId(2));
    const completed = Promise.allSettled([first, second]);
    await library.connect({...session, sessionId: 'replacement-session'}); release();
    const outcomes = await completed;
    assert.equal(calls, 1, 'a queued old-session deletion cannot start under the new session');
    assert.ok(outcomes.every(result => result.status === 'rejected' && result.reason.code === 'account_changed'));
    assert.deepEqual((await storage.read())!.charts.map(chart => chart.id), [chartId(2)]);
  } finally { release(); library.close(); }
});


test('catalogue refresh under numeric quota performs no card writes or quota cleanup',async t=>{
 const storage=createAccountLibraryStore({indexedDB:new IDBFactory()}),source=client([accountChart(),accountChart(2)]);
 const library=createAccountLibrary({storage,client:source,online:()=>true});t.after(()=>library.close());await library.connect(session);
 const original=IDBObjectStore.prototype.put;let cardWrites=0;
 IDBObjectStore.prototype.put=function(value,...args){if(this.name==='charts'){cardWrites++;throw new DOMException('full','QuotaExceededError');}return original.call(this,value,...args);};
 try{await library.load();await library.load();}finally{IDBObjectStore.prototype.put=original;}
 assert.equal(cardWrites,0);assert.equal(library.entries.length,2);assert.equal(library.charts.length,0);
});

test('twenty opened cards outrank eighty later background downloads across tabs',async t=>{
  let clock=0;
  const indexedDB=new IDBFactory(),rows=Array.from({length:20},(_,i)=>accountChart(i+1));
  const storage=createAccountLibraryStore({indexedDB,now:()=>++clock});
  const other=createAccountLibraryStore({indexedDB,now:()=>++clock});
  const library=createAccountLibrary({storage,client:client(rows),online:()=>true});
  t.after(()=>{library.close();other.close();});await library.connect(session);await library.load();await acceptFixtureCards(library);
  for(let id=1;id<=20;id++)await library.markOpened(chartId(id));
  rows.push(...Array.from({length:80},(_,i)=>accountChart(i+21)));
  await library.load();await acceptFixtureCards(library,'2');
  assert.equal((await other.read())!.charts.length,100,'nothing is evicted while all cards fit');
  await placeUnderQuota(other,(await other.read())!.lease!,accountChart(101),51);
  const remaining=(await other.read())!.charts.map(chart=>chart.id);
  assert.equal(remaining.length,50);
  for(let id=1;id<=20;id++)assert.ok(remaining.includes(chartId(id)),`opened card ${id} survives`);
});


test('reload permission checks durable ownership and revision, including another tab eviction',async()=>{
 const indexedDB=new IDBFactory(),storage=createAccountLibraryStore({indexedDB}),other=createAccountLibraryStore({indexedDB});
 const row=accountChart(),library=createAccountLibrary({storage,client:client([row]),online:()=>true});
 try{
  await library.connect(session);await library.load();await acceptFixtureCards(library);assert.equal(await library.canRestore(row.id),true);
  await placeUnderQuota(other,(await other.read())!.lease!);
  assert.ok(library.get(row.id));assert.equal(library.storageAvailable,true);
  assert.equal(await library.canRestore(row.id),false);
  const saved=await storage.read();assert.ok(saved?.lease);await storage.put(saved.lease,[row]);
  assert.equal(await library.canRestore(row.id),true);
  await other.activate('2');assert.equal(await library.canRestore(row.id),false);
 }finally{library.close();other.close();}
});
test('a newer RAM revision cannot use an older durable copy as reload evidence',async()=>{
 const storage=createAccountLibraryStore({indexedDB:new IDBFactory()}),newer=accountChart(1,'1',2);
 const library=createAccountLibrary({storage,client:client([newer]),online:()=>true});
 try{
  const active=await storage.activate('1');assert.equal(active.status,'stored');if(active.status!=='stored')return;
  await storage.put(active.lease,[accountChart()]);await library.connect(session);
  const put=storage.put;storage.put=async()=>({status:'unavailable'});
  try{await library.open(newer.id);}finally{storage.put=put;}
  assert.equal(library.get(newer.id)?.revision,2);assert.equal(await library.canRestore(newer.id),false);
  await storage.put(active.lease,[newer]);assert.equal(await library.canRestore(newer.id),true);
 }finally{library.close();}
});
test('logout during durable verification cannot authorize the previous account reload',async()=>{
 const storage=createAccountLibraryStore({indexedDB:new IDBFactory()});
 const library=createAccountLibrary({storage,client:client(),online:()=>true});
 try{
  await library.connect(session);await library.load();await acceptFixtureCards(library);
  let finish!:(value:boolean)=>void;storage.canRestore=()=>new Promise(resolve=>{finish=resolve;});
  const checking=library.canRestore(chartId(1));await library.clear();finish(true);
  assert.equal(await checking,false);
 }finally{library.close();}
});

test('unchanged library reads retain records without notifications, while durable recovery still notifies', async () => {
  const storage = createAccountLibraryStore({indexedDB: new IDBFactory()});
  const rows = [accountChart(1), accountChart(2)];
  let notices = 0, observations = 0;
  const source = client(rows), own = source.own;
  source.own = async (...args) => structuredClone(await own(...args));
  const library = createAccountLibrary({storage, client: source, online: () => true, notify: () => { notices++; }});
  library.subscribe(() => { observations++; });
  try {
    await library.connect(session); await library.load();await acceptFixtureCards(library);
    const first = library.charts, untouched = first[1];
    const before = observations, notified = notices;
    await library.open(chartId(1));
    assert.equal(library.charts, first, 'unchanged network data must not recreate the working list');
    assert.equal(observations, before, 'unchanged data does not wake local observers');
    assert.equal(notices, notified, 'unchanged durable data does not wake other tabs');
    await library.refreshLocal();
    assert.equal(library.charts, first, 'IndexedDB clones of the same revisions reuse working records');
    assert.equal(observations, before);
    for (let repeat = 0; repeat < 10; repeat++) await library.load();
    assert.equal(notices, notified, 'identical pages do not publish durable changes');
    await placeUnderQuota(storage,(await storage.read())!.lease!);
    await library.open(chartId(1));
    assert.ok(observations > before && notices > notified, 're-admitting an evicted row wakes observers');
    rows[0] = {...rows[0]!, revision: 2, noteRevision: 2, note: 'Updated note'};
    await library.open(chartId(1));
    assert.notEqual(library.charts, first);
    assert.equal(library.charts[1], untouched, 'one changed card does not replace its neighbours');
    assert.equal(library.charts[0]!.note, 'Updated note');
    await library.clear();
    assert.deepEqual(library.charts, [], 'logout discards the previous account projection');
  } finally { library.close(); }
});

test('unavailable logout cleanup retains its exact account target and a retry preserves a newer account',async()=>{
 const stored=createAccountLibraryStore({indexedDB:new IDBFactory()});let unavailable=true;
 const storage={...stored,clearAccount:async(id:string)=>unavailable?'unavailable' as const:stored.clearAccount(id)};
 const source=client([accountChart(),accountChart(2,'2')]);
 const library=createAccountLibrary({storage,client:source,online:()=>true});
 try{
  await library.connect(session);await library.load();await acceptFixtureCards(library);
  const result=await library.clear();assert.equal(result.status,'unavailable');assert.equal(result.accountId,'1');
  assert.deepEqual(library.charts,[]);
  await library.connect({accountId:'2',sessionId:'second-session'});await library.load();await acceptFixtureCards(library);
  unavailable=false;assert.equal(await library.retryClear(result.accountId!), 'stale');
  assert.deepEqual((await stored.read())!.charts.map(chart=>chart.accountId),['2']);
  assert.equal(library.accountId,'2');
 }finally{library.close();}
});
