import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewStore, VIEW_STORAGE_KEY, type SavedView, type ViewStorageFailure } from '../src/data/view-store.ts';
import { parseClientContextStep } from '../shared/client-report-contract.ts';

const snapshot: SavedView = { version: 1, selectedId: 'current-transit', mandala: false,
  camera: null, lifetime: null, transit: null, natalDay: null, planets: null };
function memory(raw: string | null = null) {
  const records = new Map<string, string>(raw === null ? [] : [[VIEW_STORAGE_KEY, raw]]);
  return { records, getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value); },
    removeItem: (key: string) => { records.delete(key); } };
}
const privateError = () => new Error('private@example.test; private note and chart contents');

test('failed storage access and reads emit safe facts independently from the one visible warning', () => {
  for (const at of ['access', 'read'] as const) {
    const facts: ViewStorageFailure[] = [], warnings: string[] = [];
    const storage = memory();
    if (at === 'read') storage.getItem = () => { throw privateError(); };
    const store = createViewStore({ getStorage: () => { if (at === 'access') throw privateError(); return storage; },
      onStorageFailure: fact => { facts.push(fact); }, onStorageError: text => { warnings.push(text); } });
    assert.equal(store.read(), null); assert.equal(store.read(), null);
    assert.deepEqual(facts, Array.from({ length: 2 }, () => ({ stage: 'storage_read', reason: 'storage_unavailable' })));
    assert.deepEqual(warnings, ['Не удалось сохранить положение страницы. Проверьте хранилище браузера.']);
    for (const fact of facts) assert.deepEqual(parseClientContextStep(fact), fact);
    assert.doesNotMatch(JSON.stringify(facts), /private|example|note|chart/);
  }
});

test('malformed JSON emits corrupt_data without changing storage or showing a new message', () => {
  const raw = '{"email":"private@example.test","note":"private note"';
  const storage = memory(raw), facts: ViewStorageFailure[] = [], warnings: string[] = [];
  const store = createViewStore({ getStorage: () => storage, onStorageFailure: fact => { facts.push(fact); },
    onStorageError: text => { warnings.push(text); } });
  assert.equal(store.read(), null);
  assert.deepEqual(facts, [{ stage: 'validate', reason: 'corrupt_data' }]);
  assert.deepEqual(parseClientContextStep(facts[0]), facts[0]);
  assert.equal(storage.records.get(VIEW_STORAGE_KEY), raw);
  assert.deepEqual(warnings, []);
  assert.equal(store.write(snapshot), true);
  assert.deepEqual(store.read(), snapshot);
  assert.equal(facts.length, 1, 'success adds no diagnostic event');
});

test('empty, missing, cleared and compatible old snapshots remain normal outcomes', () => {
  const facts: ViewStorageFailure[] = [];
  for (const raw of [null, '', 'null', '[]', '{"version":8}']) {
    const store = createViewStore({ getStorage: () => memory(raw), onStorageFailure: fact => { facts.push(fact); } });
    assert.equal(store.read(), null);
  }
  const old = { ...snapshot, lifetime: { opened: true, mode: 'archive', fromDate: '2020-01-01', toDate: '2021-01-01', requestedUtc: 1590000000000 } };
  const storage = memory(JSON.stringify(old));
  const store = createViewStore({ getStorage: () => storage, onStorageFailure: fact => { facts.push(fact); } });
  assert.equal(store.read()?.lifetime?.mode, 'lifetime');
  assert.equal(store.write(snapshot), true); assert.equal(store.write(snapshot), true);
  assert.equal(store.clear(), true); assert.equal(store.read(), null);
  assert.deepEqual(facts, []);
});

test('a failed write reports commit and keeps the unsaved in-memory snapshot', () => {
  const storage = memory(JSON.stringify(snapshot)), facts: ViewStorageFailure[] = [];
  let fail = true;
  const store = createViewStore({ getStorage: () => ({ ...storage, setItem(key, value) {
    if (fail) throw privateError(); storage.setItem(key, value);
  } }), onStorageFailure: fact => { facts.push(fact); } });
  assert.deepEqual(store.read(), snapshot);
  const next = { ...snapshot, mandala: true };
  assert.equal(store.write(next), false);
  assert.deepEqual(store.read(), next, 'an unsuccessful write cannot revive the older disk state');
  assert.deepEqual(facts, [{ stage: 'commit', reason: 'storage_unavailable' }]);
  assert.equal(storage.records.get(VIEW_STORAGE_KEY), JSON.stringify(snapshot));
  fail = false; assert.equal(store.write(next), true);
  assert.equal(facts.length, 1);
  assert.deepEqual(createViewStore({ getStorage: () => storage }).read(), next);
});

test('failure while checking an unchanged stored snapshot is a read failure, not a commit', () => {
  const storage = memory(), facts: ViewStorageFailure[] = [];
  const store = createViewStore({ getStorage: () => storage, onStorageFailure: fact => { facts.push(fact); } });
  assert.equal(store.write(snapshot), true);
  storage.getItem = () => { throw privateError(); };
  assert.equal(store.write(snapshot), false);
  assert.deepEqual(store.read(), snapshot);
  assert.deepEqual(facts, [{ stage: 'storage_read', reason: 'storage_unavailable' }]);
});

test('failed removal and null-marker fallback keep cleared memory and report only the storage failure', () => {
  for (const removal of [true, false]) {
    const storage = memory(JSON.stringify(snapshot)), facts: ViewStorageFailure[] = [];
    const denied = { getItem: storage.getItem, setItem() { throw privateError(); },
      ...(removal ? { removeItem() { throw privateError(); } } : {}) };
    const store = createViewStore({ getStorage: () => denied, onStorageFailure: fact => { facts.push(fact); } });
    assert.deepEqual(store.read(), snapshot);
    assert.equal(store.clear(), false); assert.equal(store.read(), null);
    assert.equal(storage.records.get(VIEW_STORAGE_KEY), JSON.stringify(snapshot));
    assert.deepEqual(facts, [{ stage: 'commit', reason: 'storage_unavailable' }]);
  }
});

test('exception accessors and private contents never cross or get inspected at the failure port', () => {
  let inspections = 0;
  const cause = Object.defineProperties({}, Object.fromEntries(['name', 'message', 'stack', 'code'].map(key => [key, {
    get() { inspections++; throw privateError(); },
  }])));
  const facts: ViewStorageFailure[] = [];
  const store = createViewStore({ getStorage() { throw cause; }, onStorageFailure: fact => { facts.push(fact); } });
  assert.equal(store.read(), null);
  assert.equal(inspections, 0);
  assert.deepEqual(facts, [{ stage: 'storage_read', reason: 'storage_unavailable' }]);
});

test('a throwing or rejecting failure recipient cannot change read, write or clear outcomes', async () => {
  for (const asynchronous of [false, true]) {
    const storage = memory('{'), warnings: string[] = [];
    const store = createViewStore({ getStorage: () => ({ ...storage,
      setItem() { throw privateError(); }, removeItem() { throw privateError(); } }),
      onStorageFailure() { if (asynchronous) return Promise.reject(privateError()); throw privateError(); },
      onStorageError: text => { warnings.push(text); } });
    assert.equal(store.read(), null);
    assert.equal(store.write(snapshot), false); assert.deepEqual(store.read(), snapshot);
    assert.equal(store.clear(), false); assert.equal(store.read(), null);
    assert.equal(warnings.length, 1);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
});


test('recovery requires a successful storage operation and separates consecutive failure episodes', () => {
  const storage=memory(JSON.stringify(snapshot)),events:string[]=[];let fail=true;
  const store=createViewStore({getStorage:()=>({...storage,setItem(key,value){if(fail)throw privateError();storage.setItem(key,value);}}),
    onStorageFailure:()=>{events.push('failure');},onStorageRecovery:()=>{events.push('recovery');}});
  assert.deepEqual(store.read(),snapshot);assert.deepEqual(events,[]);
  assert.equal(store.write({...snapshot,mandala:true}),false);
  assert.equal(store.write({...snapshot,mandala:true}),false);
  assert.deepEqual(store.read(),{...snapshot,mandala:true});assert.equal(store.write({}),false);
  assert.deepEqual(events,['failure','failure']);
  fail=false;assert.equal(store.write({...snapshot,mandala:true}),true);
  assert.deepEqual(store.read(),{...snapshot,mandala:true});
  assert.deepEqual(events,['failure','failure','recovery']);
  fail=true;assert.equal(store.write(snapshot),false);
  assert.deepEqual(events,['failure','failure','recovery','failure']);
});

test('corrupt data recovers only through a later successful disk read or write', () => {
  const storage=memory('{'),events:string[]=[];
  const store=createViewStore({getStorage:()=>storage,onStorageFailure:()=>{events.push('failure');},onStorageRecovery:()=>{events.push('recovery');}});
  assert.equal(store.read(),null);assert.equal(store.read(),null);assert.equal(store.write({}),false);
  assert.deepEqual(events,['failure','failure']);
  storage.records.set(VIEW_STORAGE_KEY,JSON.stringify(snapshot));assert.deepEqual(store.read(),snapshot);
  assert.deepEqual(events,['failure','failure','recovery']);
  storage.records.set(VIEW_STORAGE_KEY,'{');store.read();assert.equal(store.clear(),true);
  assert.deepEqual(events,['failure','failure','recovery','failure','recovery']);
});

test('recovery recipient failures do not change successful read, write or clear',async()=>{
 for(const asynchronous of [false,true])for(const operation of ['read','write','clear'] as const){
  const storage=memory('{');let calls=0;
  const store=createViewStore({getStorage:()=>storage,onStorageRecovery(){calls++;if(asynchronous)return Promise.reject(privateError());throw privateError();}});
  store.read();storage.records.set(VIEW_STORAGE_KEY,JSON.stringify(snapshot));
  if(operation==='read')assert.deepEqual(store.read(),snapshot);else if(operation==='write')assert.equal(store.write(snapshot),true);else assert.equal(store.clear(),true);
  assert.equal(calls,1);await new Promise<void>(resolve=>setImmediate(resolve));
 }
});
