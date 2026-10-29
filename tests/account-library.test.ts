import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import {createStoragePressure} from '../src/data/storage-pressure.ts';
import { createAccountLibraryStore } from '../src/data/account-library-store.ts';
import { createAccountLibrary } from '../src/state/account-library.ts';
import { accountChart, chartId } from './helpers/account-chart.ts';
import type { ChartClient } from '../src/data/chart-client.ts';

const session = {accountId: '1', sessionId: 'first-session'};
const noNetwork = async (): Promise<never> => { throw new Error('offline data must not request a server'); };
function client(rows = [accountChart()]): Pick<ChartClient, 'list' | 'own'> {
  return {
    async list() { return {charts: rows.map(chart => ({...chart})), nextCursor: null }; },
    async own({chartId: id}) { const chart = rows.find(row => row.id === id); if (!chart) throw Object.assign(new Error(), {code: 'not_found'}); return chart; },
  };
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
  const library = createAccountLibrary({storage, client: {list: noNetwork, own: noNetwork}, online: () => false});
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
    await changing; await library.load();
    assert.deepEqual(library.charts.map(chart => chart.accountId), ['2']);
    await library.connect(null); assert.equal(library.charts.length, 1);
  } finally { library.close(); }
});

test('a late page after logout cannot repopulate memory or IndexedDB', async () => {
  const storage = createAccountLibraryStore({indexedDB: new IDBFactory()});
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const source = client(); const original = source.list;
  source.list = async (...args) => { await gate; return original(...args); };
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
    const pending = library.open(chartId(1)), refused = assert.rejects(pending, {code: 'account_changed'});
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
    return id === chartId(1) ? accountChart(1) : accountChart(2);
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
    await library.connect(session); await library.load();
    let calls = 0;
    source.own = async () => { calls++; return accountChart(); };
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
  const library = createAccountLibrary({storage, client: {list: noNetwork, own: noNetwork}, online: () => false});
  try {
    await library.restore(); assert.deepEqual(await library.open(chartId(1)), accountChart());
    assert.equal(library.charts[0]!.note, 'Личная заметка');
  } finally { library.close(); }
});

test('an older late open cannot return numbers older than the working record', async () => {
  const storage = createAccountLibraryStore({indexedDB: new IDBFactory()});
  let release!: () => void, count = 0; const gate = new Promise<void>(resolve => { release = resolve; });
  const source = client();
  source.own = async () => { if (++count === 1) { await gate; return accountChart(1, '1', 2); } return accountChart(1, '1', 3); };
  const library = createAccountLibrary({storage, client: source, online: () => true});
  try {
    await library.connect(session);
    const old = library.open(chartId(1)); await library.open(chartId(1)); release();
    assert.equal((await old).revision, 3); assert.equal(library.get(chartId(1))!.revision, 3);
  } finally { library.close(); }
});

test('a failed background download is not repeated in the same page lifetime', async () => {
  let calls = 0; const source = client(), list = source.list;
  source.list = async (...args) => { calls++; return list(...args); };
  const library = createAccountLibrary({storage: createAccountLibraryStore({indexedDB: null}), client: source, online: () => true});
  try {
    await library.connect(session); await library.load(); await library.load();
    assert.equal(calls, 1); assert.equal(library.charts.length, 1);
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
    await library.connect(session); await library.load();
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
    await library.connect(session); await library.load();
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
    await library.connect(session); await library.load();
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
    await library.connect(session); await library.load();
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


test('a background page saved after quota relief stops downloading until a new page lifetime',async t=>{
  const indexedDB=new IDBFactory(),pressure=createStoragePressure({locks:null});
  const storage=createAccountLibraryStore({indexedDB,pressure});
  const active=await storage.activate('1');assert.equal(active.status,'stored');if(active.status!=='stored')return;
  await storage.put(active.lease,[accountChart(1)]);
  let full=true,calls=0;
  pressure.setSources({diagnostics:async()=>{full=false;return 'released';}});
  const source=client();
  source.list=async()=>({charts:[{...accountChart(++calls+1)}],nextCursor:calls===1?'next':null});
  const library=createAccountLibrary({storage,client:source,online:()=>true});
  t.after(()=>library.close());await library.connect(session);
  const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value:unknown,key?:IDBValidKey){
    if(full && this.name==='charts')throw new DOMException('full','QuotaExceededError');
    return key===undefined?original.call(this,value):original.call(this,value,key);
  };
  try{await library.load();await library.load();}finally{IDBObjectStore.prototype.put=original;}
  assert.equal(calls,1,'quota recovery may retain this page but must not churn through the rest of the library');
  assert.deepEqual((await storage.read())!.charts.map(c=>c.id),[chartId(1),chartId(2)]);
  assert.equal(library.storageAvailable,true);
});

test('only a displayed chart changes library LRU; refreshing the full list does not',async t=>{
  let clock=0;
  const storage=createAccountLibraryStore({indexedDB:new IDBFactory(),now:()=>++clock});
  const library=createAccountLibrary({storage,client:client([accountChart(1),accountChart(2)]),online:()=>true});
  t.after(()=>library.close());await library.connect(session);await library.load();
  await library.markOpened(chartId(1));
  await library.load();
  assert.equal(await storage.evictForSpace(0),'released');
  assert.deepEqual((await storage.read())!.charts.map(c=>c.id),[chartId(1)]);
});


test('reload permission checks durable ownership and revision, including another tab eviction',async()=>{
 const indexedDB=new IDBFactory(),storage=createAccountLibraryStore({indexedDB}),other=createAccountLibraryStore({indexedDB});
 const row=accountChart(),library=createAccountLibrary({storage,client:client([row]),online:()=>true});
 try{
  await library.connect(session);await library.load();assert.equal(await library.canRestore(row.id),true);
  await other.read();await other.evictForSpace(0);
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
  await library.connect(session);await library.load();
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
    await library.connect(session); await library.load();
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
    assert.equal(await storage.evictForSpace(0), 'released');
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
 source.list=async({expectedAccountId})=>({charts:[{...accountChart(expectedAccountId==='1'?1:2,expectedAccountId),calculationCurrent:true}],nextCursor:null,calculationVersion:'current'});
 const library=createAccountLibrary({storage,client:source,calculationVersion:'current',online:()=>true});
 try{
  await library.connect(session);await library.load();
  const result=await library.clear();assert.equal(result.status,'unavailable');assert.equal(result.accountId,'1');
  assert.deepEqual(library.charts,[]);
  await library.connect({accountId:'2',sessionId:'second-session'});await library.load();
  unavailable=false;assert.equal(await library.retryClear(result.accountId!), 'stale');
  assert.deepEqual((await stored.read())!.charts.map(chart=>chart.accountId),['2']);
  assert.equal(library.accountId,'2');
 }finally{library.close();}
});
