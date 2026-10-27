import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createAccountLibraryStore } from '../src/data/account-library-store.ts';
import { accountChart, chartId } from './helpers/account-chart.ts';

test('an unused account library is empty without importing legacy localStorage', async () => {
  const store = createAccountLibraryStore({indexedDB: new IDBFactory()});
  try { assert.deepEqual(await store.read(), {lease: null, charts: []}); } finally { store.close(); }
});

test('a confirmed account library survives reopening and ignores older revisions', async () => {
  const indexedDB = new IDBFactory();
  const first = createAccountLibraryStore({indexedDB});
  const active = await first.activate('1'); assert.equal(active.status, 'stored');
  const newer = {...accountChart(1, '1', 3), note: 'Confirmed', noteRevision: 2};
  assert.equal((await first.put(active.lease, [newer])).status, 'stored');
  await first.put(active.lease, [accountChart()]);
  first.close();
  const second = createAccountLibraryStore({indexedDB});
  try {
    const read = await second.read();
    assert.equal(read!.charts[0]!.revision, 3); assert.equal(read!.charts[0]!.note, 'Confirmed');
    assert.deepEqual(read!.lease, active.lease);
  } finally { second.close(); }
});

test('switching account atomically clears its old rows and rejects a delayed write from another tab', async () => {
  const indexedDB = new IDBFactory(), a = createAccountLibraryStore({indexedDB}), b = createAccountLibraryStore({indexedDB});
  try {
    const old = await a.activate('1'); assert.equal(old.status, 'stored');
    await a.put(old.lease, [accountChart()]);
    const next = await b.activate('2'); assert.equal(next.status, 'stored');
    assert.equal((await a.put(old.lease, [accountChart(2)])).status, 'stale');
    await b.put(next.lease, [accountChart(3, '2')]);
    assert.deepEqual((await a.read())!.charts.map(c => c.accountId), ['2']);
    assert.equal(await a.clear(old.lease), 'stale');
    assert.equal((await b.read())!.charts.length, 1);
  } finally { a.close(); b.close(); }
});

test('confirmed deletion invalidates pending snapshots without permanent deletion markers', async () => {
  const store = createAccountLibraryStore({indexedDB: new IDBFactory()});
  try {
    const active = await store.activate('1'); assert.equal(active.status, 'stored');
    await store.put(active.lease, [accountChart()]);
    const deleted = await store.remove(active.lease, chartId(1)); assert.equal(deleted.status, 'stored');
    assert.notEqual(deleted.lease.generation, active.lease.generation);
    assert.equal((await store.put(active.lease, [accountChart(1, '1', 9)])).status, 'stale');
    assert.deepEqual((await store.read())!.charts, []);
    assert.equal((await store.put(deleted.lease, [accountChart(2)])).status, 'stored');
    assert.deepEqual((await store.read())!.charts.map(c => c.id), [chartId(2)]);
  } finally { store.close(); }
});

test('logout blocks old writes even after the same account is activated again', async () => {
  const store = createAccountLibraryStore({indexedDB: new IDBFactory()});
  try {
    const old = await store.activate('1'); assert.equal(old.status, 'stored');
    await store.put(old.lease, [accountChart()]);
    assert.equal(await store.clear(old.lease), 'cleared');
    assert.deepEqual(await store.read(), {lease: null, charts: []});
    const next = await store.activate('1'); assert.equal(next.status, 'stored');
    assert.notEqual(next.lease.generation, old.lease.generation);
    assert.equal((await store.put(old.lease, [accountChart()])).status, 'stale');
  } finally { store.close(); }
});

test('invalid or foreign rows cannot partially commit a batch', async () => {
  const store = createAccountLibraryStore({indexedDB: new IDBFactory()});
  try {
    const active = await store.activate('1'); assert.equal(active.status, 'stored');
    for (const bad of [accountChart(2, '2'), {...accountChart(2), activations: {personality: [], design: []}}]) {
      await assert.rejects(store.put(active.lease, [accountChart(), bad]), /invalid_chart/);
      assert.deepEqual((await store.read())!.charts, []);
    }
  } finally { store.close(); }
});

test('unavailable storage is not reported as a saved library', async () => {
  const store = createAccountLibraryStore({indexedDB: null});
  assert.equal(await store.read(), null);
  assert.deepEqual(await store.activate('1'), {status: 'unavailable'});
  store.close();
});

test('the old browser library shortens existing keys without duplicating cards or losing notes',async()=>{
 const indexedDB=new IDBFactory(),databaseName='short-ids',id='123456789012345678901234567890123456789';
 const row={...accountChart(1),id,_accessedAt:42};
 await new Promise<void>((resolve,reject)=>{
   const opening=indexedDB.open(databaseName,2);
   opening.onupgradeneeded=()=>{
     const charts=opening.result.createObjectStore('charts',{keyPath:'id'});charts.createIndex('accessed','_accessedAt');charts.put(row);
     opening.result.createObjectStore('context',{keyPath:'key'}).put({key:'owner',accountId:'1',generation:'before'});
   };
   opening.onsuccess=()=>{opening.result.close();resolve();};opening.onerror=()=>reject(opening.error);
 });
 const store=createAccountLibraryStore({indexedDB,databaseName});
 try {
   const read=await store.read();assert.equal(read?.charts.length,1);
   assert.equal(read?.charts[0].id,id.slice(0,10));assert.equal(read?.charts[0].note,row.note);
   assert.deepEqual(read?.lease,{accountId:'1',generation:'before'});
 }finally{store.close();}
 const keys=await new Promise<IDBValidKey[]>((resolve,reject)=>{const opening=indexedDB.open(databaseName);
   opening.onsuccess=()=>{const tx=opening.result.transaction('charts');const keys=tx.objectStore('charts').getAllKeys();
     tx.oncomplete=()=>{opening.result.close();resolve(keys.result);};tx.onerror=()=>reject(tx.error);};opening.onerror=()=>reject(opening.error);});
 assert.deepEqual(keys,[id.slice(0,10)]);
});
