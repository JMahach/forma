import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createAccountLibraryStore,type LibraryLease } from '../src/data/account-library-store.ts';
import { createAccountLibrary } from '../src/state/account-library.ts';
import { accountChart, accountNatalChart, chartId } from './helpers/account-chart.ts';
import type { ChartClient } from '../src/data/chart-client.ts';
import type {LibraryCatalogEntry} from '../shared/library-catalog-contract.ts';

const session = {accountId: '1', sessionId: 'first-session'};
const noNetwork = async (): Promise<never> => { throw new Error('offline data must not request a server'); };
function recordEntry(chart=accountChart()):LibraryCatalogEntry {
 const {id,revision,name,source,birthDate,birthTime}=chart;
 return {id,revision,name,source,birthDate,birthTime,packages:{card:{kind:'card',sourceKey:JSON.stringify([id,revision])},day:null,majorReturns:null}};
}
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
 const put=IDBObjectStore.prototype.put,remove=IDBObjectStore.prototype.delete,tracker={removed:0};
 IDBObjectStore.prototype.delete=function(key){if(this.name==='charts')this.transaction.addEventListener('complete',()=>{tracker.removed++;});return remove.call(this,key);};
 IDBObjectStore.prototype.put=function(value,...args){
  if(this.name==='charts' && value.id===incoming.id && tracker.removed<victims)throw new DOMException('full','QuotaExceededError');
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
  const rows=[accountChart()],storage = createAccountLibraryStore({indexedDB:new IDBFactory()}), source = client(rows);
  const library = createAccountLibrary({storage, client:source, online:()=>true});
  try {
    await library.connect(session); await library.load();await acceptFixtureCards(library);
    let calls = 0;
    source.own = async () => { calls++; return {chart:accountChart(),catalogMarker:'1'}; };
    await assert.rejects(library.open(chartId(1), AbortSignal.abort()), {name:'AbortError'});
    assert.equal(calls, 0);
    rows[0]=accountChart(1,'1',2);
    await library.load();
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
    await library.connect(session); await library.load();
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
  assert.ok(remaining.length<=50,'committed cleanup must satisfy the available capacity');
  assert.ok(remaining.includes(chartId(101)),'the requested whole card was stored');
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
  await storage.put(active.lease,[accountChart()]);await library.connect(session);await library.load();
  const put=storage.put;storage.put=async()=>({status:'unavailable'});
  try{await library.open(newer.id);}finally{storage.put=put;}
  assert.equal(library.get(newer.id)?.revision,2);assert.equal(await library.canRestore(newer.id),false);
  await storage.put((await storage.read())!.lease!,[newer]);assert.equal(await library.canRestore(newer.id),true);
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
  let notices = 0, observations = 0, reads = 0;
  const source = client(rows), own = source.own;
  source.own = async (...args) => { reads++; return structuredClone(await own(...args)); };
  const library = createAccountLibrary({storage, client: source, online: () => true, notify: () => { notices++; }});
  library.subscribe(() => { observations++; });
  try {
    await library.connect(session); await library.load();await acceptFixtureCards(library);
    const first = library.charts, untouched = first[1];
    const before = observations, notified = notices;
    await library.open(chartId(1));
    assert.equal(reads, 0, 'a ready local card does not request its server copy');
    assert.equal(library.charts, first, 'opening a ready local card retains the working list');
    assert.equal(observations, before, 'unchanged data does not wake local observers');
    assert.equal(notices, notified, 'unchanged durable data does not wake other tabs');
    await library.refreshLocal();
    assert.equal(library.charts, first, 'IndexedDB clones of the same revisions reuse working records');
    assert.equal(observations, before);
    for (let repeat = 0; repeat < 10; repeat++) await library.load();
    assert.equal(notices, notified, 'identical pages do not publish durable changes');
    await placeUnderQuota(storage,(await storage.read())!.lease!);
    for(const projection of [undefined,accountChart(1)]) {
      rows[0] = {...rows[0]!, revision: rows[0]!.revision+1, noteRevision: rows[0]!.noteRevision+1, note: 'Confirmed note'};
      await library.prepareAcceptance()(chartId(1),projection);
      assert.equal(library.get(chartId(1))!.revision,rows[0]!.revision,'a missing projection or marker requires a fresh result before any catalogue refresh');
    }
    assert.ok(observations > before && notices > notified, 're-admitting an evicted row wakes observers');
    rows[0] = {...rows[0]!, revision: 4, noteRevision: 4, note: 'Updated note'};
    await library.load();
    await library.open(chartId(1));
    assert.equal(reads, 3, 'incomplete receipts and a newer catalogue each need one card fetch');
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

test('a stored background card publishes once without another read, put or HTTP and retains its full catalogue',async t=>{
 const storage=createAccountLibraryStore({indexedDB:new IDBFactory()}),source=client(),notices:unknown[]=[];
 const library=createAccountLibrary({storage,client:source,online:()=>true,notify:value=>notices.push(value)});t.after(()=>library.close());
 await library.connect(session);await library.load();const base=(await storage.readCatalog())!,chart=accountChart();
 assert.equal((await storage.put(base.lease,[chart],'1')).status,'stored');let updates=0;library.subscribe(()=>updates++);updates=0;notices.length=0;
 t.mock.method(storage,'put',()=>assert.fail('already stored'));t.mock.method(storage,'read',()=>assert.fail('already acquired'));
 t.mock.method(IDBObjectStore.prototype,'get',()=>assert.fail('acceptance must do no IDB read'));
 t.mock.method(IDBObjectStore.prototype,'put',()=>assert.fail('acceptance must do no IDB write'));
 for(const name of ['catalog','confirmCatalog','own'] as const)t.mock.method(source,name,noNetwork);
 assert.equal(library.acceptStored?.(chart,'1',base.lease,session.sessionId),true);
 assert.equal(library.get(chart.id),chart);assert.equal(library.isReady(chart.id),true);assert.equal(updates,1);assert.equal(notices.length,1);
 assert.equal(library.completeCatalog?.marker,'1');assert.equal(library.completeCatalog?.entries.length,1);
 assert.equal(library.acceptStored(structuredClone(chart),'1',base.lease,session.sessionId),true);
 assert.equal(updates,1);assert.equal(notices.length,1);
 const permission=library.workingLease!;permission.generation='external mutation';assert.deepEqual(library.workingLease,base.lease);
 await library.connect(null);assert.equal(library.workingLease,null);library.close();assert.equal(library.completeCatalog,null);
});

test('stored acceptance rejects stale session, account, lease, marker and revision without publishing',async t=>{
 const storage=createAccountLibraryStore({indexedDB:new IDBFactory()}),chart=accountChart(1,'1',2);
 const library=createAccountLibrary({storage,client:client([chart]),online:()=>true});t.after(()=>library.close());
 await library.connect(session);await library.load();const lease=(await storage.readCatalog())!.lease;
 assert.equal(library.acceptStored?.(chart,'1',lease,session.sessionId),true);let updates=0;library.subscribe(()=>updates++);updates=0;
 const cases=[{chart,marker:'1',lease,sessionId:'old'}, {chart:{...chart,accountId:'2'},marker:'1',lease,sessionId:session.sessionId},
  {chart,marker:'1',lease:{...lease,generation:'old'},sessionId:session.sessionId},
  {chart,marker:'0',lease,sessionId:session.sessionId}, {chart,marker:'invalid',lease,sessionId:session.sessionId},
  {chart:accountChart(),marker:'1',lease,sessionId:session.sessionId}];
 for(const value of cases)assert.equal(library.acceptStored(value.chart,value.marker,value.lease,value.sessionId),false);
 assert.equal(updates,0);assert.equal(library.get(chart.id),chart);
 await library.connect({...session,sessionId:'renewed'});assert.equal(library.acceptStored(chart,'1',lease,session.sessionId),false);
 await library.connect({accountId:'2',sessionId:'other'});assert.equal(library.acceptStored(chart,'1',lease,'other'),false);
 library.close();assert.equal(library.workingLease,null);assert.equal(library.acceptStored(chart,'1',lease,'other'),false);
});

test('a durable peer record reads only its addressed card and never echoes or rewrites it',async t=>{
 const indexedDB=new IDBFactory(),storage=createAccountLibraryStore({indexedDB}),other=createAccountLibraryStore({indexedDB});t.after(()=>other.close());
 const library=createAccountLibrary({storage,client:client(),online:()=>true,notify:()=>assert.fail('no echo')});t.after(()=>library.close());
 await library.connect(session);const lease=(await other.readCatalog())!.lease,chart=accountChart();await other.put(lease,[chart],'1');
 let full=0,cardReads=0,catalogReads=0,updates=0;const read=storage.read,readCard=storage.maintenance.readCard,readCatalog=storage.readCatalog;
 t.mock.method(storage,'read',()=>{full++;return read();});
 t.mock.method(storage,'readCatalog',()=>{catalogReads++;return readCatalog();});
 t.mock.method(storage.maintenance,'readCard',(...args:Parameters<typeof readCard>)=>{cardReads++;assert.equal(args[1],chart.id);return readCard(...args);});
 t.mock.method(storage,'put',()=>assert.fail('peer already stored'));library.subscribe(()=>updates++);updates=0;
 const get=IDBObjectStore.prototype.get,ids:(IDBValidKey|IDBKeyRange)[]=[];
 t.mock.method(IDBObjectStore.prototype,'get',function(this:IDBObjectStore,key:IDBValidKey|IDBKeyRange){if(this.name==='charts')ids.push(key);return get.call(this,key);});
 t.mock.method(IDBObjectStore.prototype,'getAll',()=>assert.fail('no complete numeric read'));
 await library.receive({kind:'record',...session,durable:true,marker:'1',entry:recordEntry(chart)});
 assert.equal(library.get(chart.id)?.note,chart.note);assert.equal(full,0);assert.equal(cardReads,1);assert.equal(catalogReads,1);assert.equal(updates,1);
 assert.deepEqual(ids,[chart.id]);
 await library.receive({kind:'record',...session,durable:true,marker:'1',entry:recordEntry(chart)});assert.equal(updates,1);
});

test('a complete catalogue is invalidated by a new or changed stored observation, including ordinary acceptance',async t=>{
 for(const kind of ['new','revision','marker','ordinary'] as const){
  const storage=createAccountLibraryStore({indexedDB:new IDBFactory()}),library=createAccountLibrary({storage,client:client(),online:()=>true});t.after(()=>library.close());
  await library.connect(session);await library.load();assert.equal(library.completeCatalog?.marker,'1');
  const chart=kind==='new'?accountChart(2):accountChart(1,'1',kind==='revision'?2:1),marker=kind==='marker'?'2':'1';
  if(kind==='ordinary')await library.prepareAcceptance()(chart.id,{...chart,revision:2},marker);
  else assert.equal(library.acceptStored(chart,marker,(await storage.readCatalog())!.lease,session.sessionId),true);
  assert.equal(library.completeCatalog,null,kind);assert.equal(library.get(chart.id)?.id,chart.id);
 }
});

test('a peer card read delayed across catalogue replacement cannot restore the absent record',async t=>{
 const indexedDB=new IDBFactory(),storage=createAccountLibraryStore({indexedDB}),other=createAccountLibraryStore({indexedDB});t.after(()=>other.close());
 const rows=[accountChart()],library=createAccountLibrary({storage,client:client(rows),online:()=>true});t.after(()=>library.close());
 await library.connect(session);await library.load();await other.put((await other.readCatalog())!.lease,rows,'1');
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{started=resolve;});
 const readCard=storage.maintenance.readCard;t.mock.method(storage.maintenance,'readCard',async(...args:Parameters<typeof readCard>)=>{const chart=await readCard(...args);started();await gate;return chart;});
 const receiving=library.receive({kind:'record',...session,durable:true,marker:'1',entry:recordEntry()});
 // On the old full-read implementation no addressed read begins.
 const startedRead=await Promise.race([began.then(()=>true),receiving.then(()=>false)]);assert.equal(startedRead,true);
 rows.length=0;await library.load();release();await receiving;
 assert.equal(library.get(chartId(1)),undefined);assert.deepEqual(library.completeCatalog?.entries,[]);
});

test('a peer deletion between metadata and card reads cannot publish a record under the retired lease',async t=>{
 const indexedDB=new IDBFactory(),storage=createAccountLibraryStore({indexedDB}),other=createAccountLibraryStore({indexedDB});t.after(()=>other.close());
 const library=createAccountLibrary({storage,client:client(),online:()=>true});t.after(()=>library.close());await library.connect(session);
 const chart=accountChart(),base=(await other.readCatalog())!;await other.put(base.lease,[chart],'1');
 const readCatalog=storage.readCatalog;t.mock.method(storage,'readCatalog',async()=>{const value=await readCatalog();await other.remove(base.lease,chart.id,'2');return value;});
 await library.receive({kind:'record',...session,durable:true,marker:'1',entry:recordEntry(chart)});
 assert.equal(library.has(chart.id),false);assert.equal(library.get(chart.id),undefined);
});

test('stored acceptance is fenced while a same-account deletion is waiting to commit',async t=>{
 const storage=createAccountLibraryStore({indexedDB:new IDBFactory()}),library=createAccountLibrary({storage,client:client(),online:()=>true});t.after(()=>library.close());
 await library.connect(session);await library.load();const lease=(await storage.readCatalog())!.lease;
 assert.equal(library.acceptStored(accountChart(),'1',lease,session.sessionId),true);
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{started=resolve;});
 const remove=storage.remove;t.mock.method(storage,'remove',async(...args:Parameters<typeof remove>)=>{started();await gate;return remove(...args);});
 const removing=library.forget(chartId(1),'2','deleted');await began;
 assert.equal(library.acceptStored(accountChart(),'2',lease,session.sessionId),false);assert.equal(library.has(chartId(1)),false);
 release();await removing;
});

test('stored acceptance cannot use an older revision than a full light catalogue even without a RAM record',async t=>{
 const storage=createAccountLibraryStore({indexedDB:new IDBFactory()}),library=createAccountLibrary({storage,client:client([accountChart(1,'1',3)]),online:()=>true});t.after(()=>library.close());
 await library.connect(session);await library.load();const lease=(await storage.readCatalog())!.lease;
 assert.equal(library.acceptStored(accountChart(1,'1',2),'1',lease,session.sessionId),false);
 assert.equal(library.get(chartId(1)),undefined);assert.equal(library.completeCatalog?.entries[0].revision,3);
});

test('a stored catalogue behind the minimum marker never authorizes background completeness',async t=>{
 const storage=createAccountLibraryStore({indexedDB:new IDBFactory()}),source=client();
 const first=createAccountLibrary({storage,client:source,online:()=>true});await first.connect(session);await first.load();
 const lease=(await storage.readCatalog())!.lease;await storage.put(lease,[accountChart(2)],'2');
 const library=createAccountLibrary({storage,client:source,online:()=>true});t.after(()=>{first.close();library.close();});await library.connect(session);
 assert.equal(library.completeCatalog,null);assert.equal(library.get(chartId(2))?.id,chartId(2));
});

for(const transition of ['session','account','close'] as const)test('a delayed peer card cannot cross a retired '+transition,async t=>{
 const storage=createAccountLibraryStore({indexedDB:new IDBFactory()}),library=createAccountLibrary({storage,client:client(),online:()=>true});t.after(()=>library.close());
 await library.connect(session);const lease=(await storage.readCatalog())!.lease;await storage.put(lease,[accountChart()],'1');
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{started=resolve;});
 const read=storage.maintenance.readCard;t.mock.method(storage.maintenance,'readCard',async(...args:Parameters<typeof read>)=>{const card=await read(...args);started();await gate;return card;});
 const receiving=library.receive({kind:'record',...session,durable:true,marker:'1',entry:recordEntry()}),rejected=assert.rejects(receiving,{code:'account_changed'});await began;
 if(transition==='close')library.close();else await library.connect(transition==='session'?{...session,sessionId:'next'}:{accountId:'2',sessionId:'other'});
 let updates=0;library.subscribe(()=>updates++);updates=0;release();await rejected;assert.equal(updates,0);
 if(transition==='account')assert.equal(library.get(chartId(1)),undefined);
});

test('a durable full catalogue notice remains usable when local storage is unavailable',async t=>{
 const library=createAccountLibrary({storage:createAccountLibraryStore({indexedDB:null}),client:{catalog:noNetwork,confirmCatalog:noNetwork,own:noNetwork},online:()=>true});t.after(()=>library.close());
 await library.connect(session);
 await library.receive({kind:'catalog',...session,durable:true,catalog:{accountId:'1',marker:'2',entries:[recordEntry()]}});
 assert.equal(library.has(chartId(1)),true);assert.equal(library.completeCatalog?.marker,'2');assert.equal(library.workingLease,null);
});

test('peer package readiness may advance without changing the card revision',async t=>{
 const storage=createAccountLibraryStore({indexedDB:new IDBFactory()}),library=createAccountLibrary({storage,client:client(),online:()=>true});t.after(()=>library.close());await library.connect(session);
 const chart=accountNatalChart(),entry={...recordEntry(chart),packages:{card:{kind:'card' as const,sourceKey:JSON.stringify([chart.id,1])},
  day:{ref:{kind:'day' as const,sourceKey:JSON.stringify([chart.birthDate,chart.timezone])},ready:false},majorReturns:{sourceKey:JSON.stringify([chart.utc,chart.timezone]),readyFamilies:[]}}};
 await library.receive({kind:'catalog',...session,durable:false,catalog:{accountId:'1',marker:'1',entries:[entry]}});
 await library.receive({kind:'record',...session,durable:false,marker:'2',entry:{...entry,packages:{...entry.packages,day:{...entry.packages.day,ready:true}}}});
 assert.equal(library.entries[0].packages.day?.ready,true);assert.equal(library.completeCatalog,null);
});

test('a later peer marker cannot downgrade a newer light row when its numerical card is absent',async t=>{
 const library=createAccountLibrary({storage:createAccountLibraryStore({indexedDB:null}),client:client(),online:()=>true});t.after(()=>library.close());await library.connect(session);
 await library.receive({kind:'catalog',...session,durable:false,catalog:{accountId:'1',marker:'1',entries:[recordEntry(accountChart(1,'1',3))]}});
 await library.receive({kind:'record',...session,durable:false,marker:'2',entry:recordEntry()});
 assert.equal(library.entries[0].revision,3);assert.equal(library.get(chartId(1)),undefined);
});

test('a delayed peer numeric read cannot undo a newer RAM-only catalogue with the same local lease',async t=>{
 const storage=createAccountLibraryStore({indexedDB:new IDBFactory()}),library=createAccountLibrary({storage,client:client(),online:()=>true});t.after(()=>library.close());await library.connect(session);
 const lease=(await storage.readCatalog())!.lease;await storage.put(lease,[accountChart()],'1');
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{started=resolve;});
 const read=storage.maintenance.readCard;t.mock.method(storage.maintenance,'readCard',async(...args:Parameters<typeof read>)=>{const chart=await read(...args);started();await gate;return chart;});
 const receiving=library.receive({kind:'record',...session,durable:true,marker:'1',entry:recordEntry()});await began;
 await library.receive({kind:'catalog',...session,durable:false,catalog:{accountId:'1',marker:'2',entries:[]}});release();await receiving;
 assert.equal(library.get(chartId(1)),undefined);assert.deepEqual(library.completeCatalog?.entries,[]);
});

test('a peer record with a different stored revision cannot mark the older notice as ready',async t=>{
 const storage=createAccountLibraryStore({indexedDB:new IDBFactory()}),library=createAccountLibrary({storage,client:client(),online:()=>true});t.after(()=>library.close());await library.connect(session);
 await storage.put((await storage.readCatalog())!.lease,[accountChart(1,'1',2)],'1');
 await library.receive({kind:'record',...session,durable:true,marker:'1',entry:recordEntry()});
 assert.equal(library.has(chartId(1)),false);assert.equal(library.get(chartId(1)),undefined);
});

test('a known foreign disk owner rejects peer records without reading its numerical library',async t=>{
 const indexedDB=new IDBFactory(),storage=createAccountLibraryStore({indexedDB}),other=createAccountLibraryStore({indexedDB});t.after(()=>other.close());
 const library=createAccountLibrary({storage,client:client(),online:()=>true});t.after(()=>library.close());await library.connect(session);
 await other.activate('2');t.mock.method(storage,'read',()=>assert.fail('known foreign owner requires no full read'));
 await library.receive({kind:'record',...session,durable:true,marker:'1',entry:recordEntry()});
 assert.equal(library.accountId,null);assert.equal(library.workingLease,null);assert.equal(library.has(chartId(1)),false);
});

test('the ambiguous metadata fallback publishes recovered numbers and peer readiness together once',async t=>{
 const storage=createAccountLibraryStore({indexedDB:new IDBFactory()}),library=createAccountLibrary({storage,client:client(),online:()=>true});t.after(()=>library.close());await library.connect(session);
 const chart=accountNatalChart(),entry={...recordEntry(chart),packages:{card:{kind:'card' as const,sourceKey:JSON.stringify([chart.id,1])},
  day:{ref:{kind:'day' as const,sourceKey:JSON.stringify([chart.birthDate,chart.timezone])},ready:false},majorReturns:{sourceKey:JSON.stringify([chart.utc,chart.timezone]),readyFamilies:[]}}};
 await storage.putCatalog((await storage.readCatalog())!,{accountId:'1',marker:'1',entries:[entry]});await library.refreshLocal();
 await storage.put((await storage.readCatalog())!.lease,[chart],'1');
 t.mock.method(storage,'readCatalog',async()=>null);let updates=0;library.subscribe(()=>updates++);updates=0;
 await library.receive({kind:'record',...session,durable:true,marker:'2',entry:{...entry,packages:{...entry.packages,day:{...entry.packages.day,ready:true}}}});
 assert.equal(library.isReady(chart.id),true);assert.equal(library.entries[0].packages.day?.ready,true);assert.equal(updates,1);
});

test('an addressed peer read publishes durable recovery of the same RAM card once',async t=>{
 const storage=createAccountLibraryStore({indexedDB:new IDBFactory()}),library=createAccountLibrary({storage,client:client(),online:()=>true});t.after(()=>library.close());await library.connect(session);
 const chart=accountChart(),lease=(await storage.readCatalog())!.lease,put=storage.put;
 storage.put=async()=>({status:'unavailable'});try{await library.prepareAcceptance()(chart.id,chart,'1');}finally{storage.put=put;}
 assert.equal(library.storageAvailable,false);await storage.put(lease,[chart],'1');
 let updates=0;library.subscribe(()=>updates++);updates=0;
 await library.receive({kind:'record',...session,durable:true,marker:'1',entry:recordEntry()});
 assert.equal(library.storageAvailable,true);assert.equal(library.get(chart.id),chart);assert.equal(updates,1);
 await library.receive({kind:'record',...session,durable:true,marker:'1',entry:recordEntry()});assert.equal(updates,1);
});


for(const stage of ['local','page','confirmation','authority'] as const)test(`catalog cancellation releases a pending ${stage} read and discards its late result`,async t=>{
 const storage=createAccountLibraryStore({indexedDB:new IDBFactory()}),source=client();
 let begin!:()=>void,release!:()=>void,finished=false,writes=0;
 const began=new Promise<void>(resolve=>{begin=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const library=createAccountLibrary({storage,client:source,online:()=>true});t.after(()=>{release();library.close();});
 await library.connect(session);
 const hold=async<T>(read:()=>Promise<T>)=>{begin();await gate;return read();};
 if(stage==='local'){const read=storage.readCatalog;t.mock.method(storage,'readCatalog',()=>hold(read));}
 if(stage==='page'){const read=source.catalog;t.mock.method(source,'catalog',(...args:Parameters<typeof read>)=>hold(()=>read(...args)));}
 if(stage==='confirmation'){const read=source.confirmCatalog;t.mock.method(source,'confirmCatalog',(...args:Parameters<typeof read>)=>hold(()=>read(...args)));}
 const put=storage.putCatalog;t.mock.method(storage,'putCatalog',(...args:Parameters<typeof put>)=>{writes++;return put(...args);});
 const authority=stage==='authority'?{permit:{key:'library:1',owner:'A',token:'p',sessionId:session.sessionId,startedAt:1,expiresAt:999999},
  signal:new AbortController().signal,current:()=>hold(async()=>true)}:undefined;
 const pending=library.load(authority).then(result=>{finished=true;return result;});
 await began;library.cancelCatalogReads();await new Promise(setImmediate);
 assert.equal(finished,true,'the read must settle before the transport supplies an answer');
 assert.deepEqual(await pending,{status:'cancelled'});assert.equal(writes,0);
 release();await new Promise(setImmediate);await new Promise(setImmediate);
 assert.equal(writes,0);assert.equal(library.completeCatalog,null);assert.deepEqual(library.entries,[]);
 assert.equal((await storage.readCatalog())?.catalog,null);
});

test('catalog cancellation covers every distinct run and its joined readers without invalidating ready data',async t=>{
 const rows=[accountChart()],storage=createAccountLibraryStore({indexedDB:new IDBFactory()}),source=client(rows);
 const library=createAccountLibrary({storage,client:source,online:()=>true});t.after(()=>library.close());
 await library.connect(session);await library.load();await library.open(rows[0]!.id);
 const prior=library.completeCatalog,lease=library.workingLease,card=library.get(rows[0]!.id);
 const calls:{signal:AbortSignal;release:()=>void}[]=[],read=source.catalog;
 let begin!:()=>void;const began=new Promise<void>(resolve=>{begin=resolve;});
 t.mock.method(source,'catalog',async(...args:Parameters<typeof read>)=>{
  await new Promise<void>(resolve=>{calls.push({signal:args[1]!,release:resolve});if(calls.length===2)begin();});return read(...args);
 });
 t.after(()=>{for(const call of calls)call.release();});
 const firstSignal=new AbortController().signal,secondSignal=new AbortController().signal;
 let finished=0;const observe=(work:ReturnType<typeof library.load>)=>work.then(result=>{finished++;return result;});
 const first=observe(library.load(undefined,firstSignal)),joined=observe(library.load(undefined,firstSignal)),second=observe(library.load(undefined,secondSignal));
 await began;const {cancelCatalogReads}=library;cancelCatalogReads();await new Promise(setImmediate);
 assert.equal(finished,3);assert.ok(calls.every(call=>call.signal.aborted));
 for(const result of await Promise.all([first,joined,second]))assert.deepEqual(result,{status:'cancelled'});
 assert.equal(library.completeCatalog,prior);assert.deepEqual(library.workingLease,lease);assert.equal(library.get(rows[0]!.id),card);
 rows.push(accountChart(2));for(const call of calls)call.release();await new Promise(setImmediate);await new Promise(setImmediate);
 assert.equal(library.completeCatalog,prior,'late data cannot publish or clear the next run');
 t.mock.method(source,'catalog',read);
 assert.equal((await library.load()).status,'complete');assert.equal(library.entries.length,2);
});

test('catalog cancellation waits for an entered commit and its local publication while cancelling another read',async t=>{
 const rows=[accountChart()],storage=createAccountLibraryStore({indexedDB:new IDBFactory()}),source=client(rows);
 const library=createAccountLibrary({storage,client:source,online:()=>true});t.after(()=>library.close());
 await library.connect(session);await library.load();
 const prior=library.completeCatalog;rows.push(accountChart(2));
 let entered!:()=>void,release!:()=>void,reading!:()=>void,releaseRead!:()=>void,finished=false,readFinished=false;
 const began=new Promise<void>(resolve=>{entered=resolve;}),commitGate=new Promise<void>(resolve=>{release=resolve;}),
  beganRead=new Promise<void>(resolve=>{reading=resolve;}),readGate=new Promise<void>(resolve=>{releaseRead=resolve;});
 t.after(()=>{release();releaseRead();});
 const put=storage.putCatalog;t.mock.method(storage,'putCatalog',async(...args:Parameters<typeof put>)=>{entered();await commitGate;return put(...args);});
 const commitSignal=new AbortController().signal;
 const committing=library.load(undefined,commitSignal).then(value=>{finished=true;return value;});
 await began;let joinedFinished=false;
 const joined=library.load(undefined,commitSignal).then(value=>{joinedFinished=true;return value;});
 const read=source.catalog;t.mock.method(source,'catalog',async(...args:Parameters<typeof read>)=>{reading();await readGate;return read(...args);});
 const pending=library.load(undefined,new AbortController().signal).then(result=>{readFinished=true;return result;});
 await beganRead;library.cancelCatalogReads();library.cancelCatalogReads();await new Promise(setImmediate);
 assert.equal(readFinished,true);assert.deepEqual(await pending,{status:'cancelled'});
 assert.equal(finished,false);assert.equal(joinedFinished,false);assert.equal(library.completeCatalog,prior);
 release();assert.deepEqual(await committing,{status:'complete',durable:true});assert.deepEqual(await joined,{status:'complete',durable:true});
 const saved=await storage.readCatalog();assert.deepEqual(library.completeCatalog,saved?.catalog);assert.deepEqual(library.workingLease,saved?.lease);
 assert.equal(library.entries.length,2);releaseRead();await new Promise(setImmediate);
 assert.deepEqual(library.completeCatalog,saved?.catalog);
});
