import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createBinaryCache } from '../src/data/binary-cache.ts';
import { createCalculationCache } from '../src/data/calculation-cache.ts';

const tick=()=>new Promise(setImmediate);
function open(factory:IDBFactory,name:string,version:number,upgrade?:(db:IDBDatabase)=>void):Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    const request=factory.open(name,version);request.onupgradeneeded=()=>upgrade?.(request.result);
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}
function seed(db:IDBDatabase,records:unknown[]) {
  return new Promise<void>((resolve,reject)=>{
    const tx=db.transaction('packets','readwrite');records.forEach(record=>tx.objectStore('packets').put(record));
    tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error);
  });
}

test('binary adapters use the injected common budget and preserve the most recently touched day',async t=>{
  const indexedDB=new IDBFactory(),owner=createCalculationCache({indexedDB,maxBytes:11000});
  const cache=createBinaryCache({cache:owner});t.after(()=>{cache.close();owner.close();});
  await cache.put('a',new ArrayBuffer(2400));await cache.put('b',new ArrayBuffer(2400));
  assert.equal((await cache.get('a'))?.byteLength,2400);
  await cache.touch('a');await cache.put('c',new ArrayBuffer(2400));
  assert.equal(await cache.get('b'),null);
  assert.equal((await cache.get('a'))?.byteLength,2400);
  assert.equal((await cache.get('c'))?.byteLength,2400);
});

test('reading or touching a binary day updates usage without rewriting its payload',async t=>{
  const owner=createCalculationCache({indexedDB:new IDBFactory()}),cache=createBinaryCache({cache:owner});
  t.after(()=>{cache.close();owner.close();});await cache.put('day',new ArrayBuffer(100));
  const original=IDBObjectStore.prototype.put;let payloadWrites=0;
  t.mock.method(IDBObjectStore.prototype,'put',function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['put']>){
    const value=args[0] as Record<string,unknown>;
    if(value?.value instanceof ArrayBuffer || value?.bytes instanceof ArrayBuffer)payloadWrites++;
    return original.apply(this,args);
  });
  assert.equal((await cache.get('day'))?.byteLength,100);await cache.touch('day');
  assert.equal(payloadWrites,0);
});

test('removal survives a new connection and closing one adapter does not close its injected owner',async t=>{
  const indexedDB=new IDBFactory(),owner=createCalculationCache({indexedDB}),first=createBinaryCache({cache:owner});
  await first.put('a',new ArrayBuffer(30));await first.put('b',new ArrayBuffer(40));await first.remove('b');first.close();
  assert.equal((await owner.get<ArrayBuffer>('natal','a'))?.byteLength,30);owner.close();
  const reload=createBinaryCache({indexedDB});t.after(()=>reload.close());
  assert.equal((await reload.get('a'))?.byteLength,30);assert.equal(await reload.get('b'),null);
});

test('custom legacy packet databases migrate intact bytes without inventing expiry from old timestamps',async t=>{
  const indexedDB=new IDBFactory(),legacy=await open(indexedDB,'custom-natal-days',2,db=>db.createObjectStore('packets',{keyPath:'key'}));
  await seed(legacy,[{key:'old',bytes:new ArrayBuffer(15),createdAt:0,accessedAt:0},{key:'bad',bytes:'not binary'}]);legacy.close();
  const cache=createBinaryCache({databaseName:'custom-natal-days',indexedDB});t.after(()=>cache.close());
  assert.equal((await cache.get('old'))?.byteLength,15);assert.equal(await cache.get('bad'),null);
  await assert.rejects(open(indexedDB,'custom-natal-days',2),{name:'VersionError'});
  await cache.put('bad','not binary' as unknown as ArrayBuffer);assert.equal(await cache.get('bad'),null);
});

test('blocked migration stays optional and retries after the old connection releases its fence',async t=>{
  const indexedDB=new IDBFactory(),legacy=await open(indexedDB,'bodygraph-chart-days',2,db=>db.createObjectStore('packets',{keyPath:'key'}));
  await seed(legacy,[{key:'saved',bytes:new ArrayBuffer(20)}]);
  const cache=createBinaryCache({indexedDB,timeoutMs:50});t.after(()=>{legacy.close();cache.close();});
  assert.equal(await cache.get('saved'),null);legacy.close();
  let ready=await cache.get('saved');
  for(let i=0;i<30&&!ready;i++){await tick();ready=await cache.get('saved');}
  assert.equal(ready?.byteLength,20);
});

test('denied or missing IndexedDB remains a miss and invalid binary values are never admitted',async t=>{
  for(const indexedDB of [null,{open(){throw new Error('Denied');}} as unknown as IDBFactory]) {
    const cache=createBinaryCache({indexedDB});t.after(()=>cache.close());
    assert.equal(await cache.get('missing'),null);await cache.put('new',new ArrayBuffer(10));await cache.remove('new');
    assert.equal(await cache.get('new'),null);
  }
  const owner=createCalculationCache({indexedDB:new IDBFactory()}),cache=createBinaryCache({cache:owner});
  t.after(()=>{cache.close();owner.close();});
  await owner.put('natal','wrong','not an ArrayBuffer');assert.equal(await cache.get('wrong'),null);
});
