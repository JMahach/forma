import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore, IDBCursor } from 'fake-indexeddb';
import { createCalculationCache } from '../src/data/calculation-cache.ts';
function open(factory:IDBFactory,name:string,version:number,stores:string[]=[]) {
  return new Promise<IDBDatabase>((resolve,reject)=>{const request=factory.open(name,version);
    request.onupgradeneeded=()=>{for(const store of stores)request.result.createObjectStore(store,{keyPath:'key'});};
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
}
async function seed(factory:IDBFactory,name:string,version:number,values:Record<string,unknown[]>) {
  const db=await open(factory,name,version,Object.keys(values));
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction(Object.keys(values),'readwrite');
    for(const [store,rows]of Object.entries(values))for(const row of rows)tx.objectStore(store).put(row);
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});db.close();
}
async function records(factory:IDBFactory,name:string,version:number,store:string) {
  const db=await open(factory,name,version);try{return await new Promise<any[]>((resolve,reject)=>{
    const request=db.transaction(store).objectStore(store).getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
  finally{db.close();}
}

test('one atomic LRU budget spans calculation kinds and connections',async t=>{
  const indexedDB=new IDBFactory();
  const a=createCalculationCache({indexedDB,maxBytes:9000}),b=createCalculationCache({indexedDB,maxBytes:9000});
  t.after(()=>{a.close();b.close();});
  assert.equal(await a.put('natal','first',new ArrayBuffer(1500)),true);
  assert.equal(await b.put('return-charts','second',new ArrayBuffer(1500)),true);
  assert.ok(await b.get('natal','first'));
  assert.equal(await a.put('return-events','third',new ArrayBuffer(1500)),true);
  assert.ok(await a.get('natal','first'));assert.equal(await b.get('return-charts','second'),null);
  assert.ok(await b.get('return-events','third'));
  assert.ok((await a.status()).accountedBytes<=9000);
});

test('simultaneous tabs cannot each spend the same remaining capacity',async t=>{
  const indexedDB=new IDBFactory();
  const tabs=Array.from({length:3},()=>createCalculationCache({indexedDB,maxBytes:9000}));
  t.after(()=>tabs.forEach(cache=>cache.close()));
  assert.deepEqual(await Promise.all(tabs.map((cache,i)=>cache.put('natal',String(i),new ArrayBuffer(1500)))),[true,true,true]);
  const values=await Promise.all(tabs.map((cache,i)=>cache.get('natal',String(i))));
  assert.equal(values.filter(Boolean).length,2);
  for(const cache of tabs)assert.ok((await cache.status()).accountedBytes<=9000);
});

test('current transit days are protected and a stale same-version window cannot restore yesterday',async t=>{
  const indexedDB=new IDBFactory(),version='a'.repeat(64),now=Date.parse('2026-10-26T12:00:00Z');
  const a=createCalculationCache({indexedDB,maxBytes:9000,now:()=>now});
  const b=createCalculationCache({indexedDB,maxBytes:9000,now:()=>now});t.after(()=>{a.close();b.close();});
  const first=await a.setTransitWindow({version,dates:['2026-10-26'],expiresAt:now+86400000});
  assert.equal(first.status,'applied');
  assert.equal(await a.put('transit',`${version}:2026-10-26`,new ArrayBuffer(1500),{version,date:'2026-10-26'}),true);
  await b.put('natal','a',new ArrayBuffer(1500));await b.put('return-charts','b',new ArrayBuffer(1500));
  assert.ok(await a.get('transit',`${version}:2026-10-26`));assert.equal(await a.get('natal','a'),null);
  const next=await a.setTransitWindow({version,dates:['2026-10-27'],expiresAt:now+2*86400000},{expectedRevision:first.revision});
  assert.equal(next.status,'applied');
  assert.equal((await b.setTransitWindow({version,dates:['2026-10-26'],expiresAt:now+86400000},
    {expectedRevision:first.revision})).status,'stale');
  assert.equal(await a.get('transit',`${version}:2026-10-26`),null);
});

test('only explicit confirmed-version transitions remove old data; a stale tab cannot reverse them',async t=>{
  const indexedDB=new IDBFactory(),first='a'.repeat(64),second='b'.repeat(64);
  const a=createCalculationCache({indexedDB}),b=createCalculationCache({indexedDB});t.after(()=>{a.close();b.close();});
  await a.put('natal','old',new ArrayBuffer(100),{version:first});
  await b.status();assert.ok(await b.get('natal','old'),'ordinary setup does not declare its hash current');
  assert.equal((await a.confirmVersions({natal:first})).status,'applied');
  assert.equal((await a.confirmVersions({natal:second},{previous:{natal:first}})).status,'applied');
  assert.equal(await a.get('natal','old'),null);
  assert.equal((await b.confirmVersions({natal:first})).status,'stale');
  assert.equal((await b.confirmVersions({natal:first},{previous:{natal:first}})).status,'stale');
  assert.equal(await b.put('natal','late-old',new ArrayBuffer(100),{version:first}),null);
  assert.equal(await a.put('natal','new',new ArrayBuffer(100),{version:second}),true);
});

test('window version guards are checked atomically even for an otherwise identical window',async t=>{
  const indexedDB=new IDBFactory(),old='a'.repeat(64),next='b'.repeat(64),now=Date.now();
  const cache=createCalculationCache({indexedDB});t.after(()=>cache.close());
  await cache.confirmVersions({natal:old,returns:old});
  const window={version:old,dates:['2026-10-26'],expiresAt:now+86400000};
  const first=await cache.setTransitWindow(window,{expectedVersions:{natal:old,returns:old}});
  await cache.confirmVersions({natal:next,returns:next},{previous:{natal:old,returns:old}});
  assert.equal((await cache.setTransitWindow(window,{expectedRevision:first.revision,expectedVersions:{natal:old,returns:old}})).status,'stale');
  assert.equal((await cache.setTransitWindow({...window,version:next},
    {expectedRevision:first.revision,previousVersion:old,expectedVersions:{natal:next,returns:next}})).status,'applied');
});

test('clearing personal calculations leaves transit and fences an older writer',async t=>{
  const indexedDB=new IDBFactory(),version='a'.repeat(64),now=Date.parse('2026-10-26T12:00:00Z');
  const old=createCalculationCache({indexedDB,now:()=>now}),other=createCalculationCache({indexedDB,now:()=>now});
  t.after(()=>{old.close();other.close();});
  await old.setTransitWindow({version,dates:['2026-10-26'],expiresAt:now+86400000});
  await old.put('transit',`${version}:2026-10-26`,new ArrayBuffer(100),{version,date:'2026-10-26'});
  await old.put('natal','birth',new ArrayBuffer(100));await old.put('return-events','dates',{events:[]});
  await other.clearPersonal();
  assert.equal(await old.get('natal','birth'),null);assert.equal(await old.put('natal','late',new ArrayBuffer(100)),null);
  assert.ok(await old.get('transit',`${version}:2026-10-26`));
});

test('migration preserves usable legacy packets, counts copies until removal, and fences old schema writers',async t=>{
  const indexedDB=new IDBFactory(),key='natal-day:'+'a'.repeat(64)+':1:2000-01-01:city';
  await seed(indexedDB,'bodygraph-chart-days',2,{packets:[{key,bytes:Uint8Array.of(11,22,33).buffer}],metadata:[]});
  const cache=createCalculationCache({indexedDB});t.after(()=>cache.close());
  assert.equal((await cache.status()).phase,'scanning');
  assert.deepEqual(new Uint8Array((await cache.get<ArrayBuffer>('natal',key))!),Uint8Array.of(11,22,33));
  assert.deepEqual(await records(indexedDB,'bodygraph-chart-days',3,'packets'),[]);
  await assert.rejects(open(indexedDB,'bodygraph-chart-days',2),{name:'VersionError'});
  const status=await cache.status();assert.equal(status.phase,'ready');assert.equal(status.legacyBytes,0);
  const metadata=await records(indexedDB,'forma-calculation-cache',2,'catalogue');
  assert.equal(metadata.length,1);assert.equal(Object.hasOwn(metadata[0],'value'),false);
  assert.equal((await records(indexedDB,'forma-calculation-cache',2,'payloads')).length,1);
});

for(const failure of ['before-source-delete','before-ledger-release'] as const)test(`migration resumes ${failure} without losing or double-counting the surviving payload`,async t=>{
  const indexedDB=new IDBFactory(),key='legacy';
  await seed(indexedDB,'bodygraph-chart-days',2,{packets:[{key,bytes:new ArrayBuffer(1500)}],metadata:[]});
  let cache=createCalculationCache({indexedDB,maxBytes:12000});const original=IDBObjectStore.prototype.delete;
  try {
    IDBObjectStore.prototype.delete=function(key) {
      if(failure==='before-source-delete' && this.transaction.db.name==='bodygraph-chart-days' && this.name==='packets'
        || failure==='before-ledger-release' && this.transaction.db.name==='forma-calculation-cache' && this.name==='catalogue'
          && String(key).startsWith('["legacy"'))throw new Error('Interrupted migration');
      return original.call(this,key);
    };
    assert.equal(await cache.get('natal',key),null);
    const status=await cache.status();assert.equal(status.phase,'migrating');assert.ok(status.legacyBytes!>0);
    assert.ok(status.accountedBytes!>=3000);assert.ok(status.accountedBytes!<=12000);
  } finally {IDBObjectStore.prototype.delete=original;cache.close();}
  cache=createCalculationCache({indexedDB,maxBytes:12000});t.after(()=>cache.close());
  assert.equal((await cache.get<ArrayBuffer>('natal',key))!.byteLength,1500);
  assert.equal((await cache.status()).legacyBytes,0);
  assert.equal((await records(indexedDB,'forma-calculation-cache',2,'payloads')).length,1);
});

test('concurrent migration of an already oversized legacy cache evicts the least recently used calculations',async t=>{
  const indexedDB=new IDBFactory();
  await seed(indexedDB,'bodygraph-chart-days',2,{packets:Array.from({length:8},(_,i)=>({key:`day-${i}`,bytes:new ArrayBuffer(1500),accessedAt:i+1})),metadata:[]});
  const a=createCalculationCache({indexedDB,maxBytes:9000}),b=createCalculationCache({indexedDB,maxBytes:9000});
  t.after(()=>{a.close();b.close();});
  await Promise.all([a.get('natal','day-7'),b.get('natal','day-7')]);
  assert.ok(await a.get('natal','day-7'));assert.equal(await b.get('natal','day-0'),null);
  for(const cache of [a,b]){const status=await cache.status();assert.ok(['ready','migrating'].includes(status.phase));assert.ok(status.accountedBytes!<=9000);}
});

test('migration keeps a usable legacy packet when only its temporary duplicate would exceed the budget',async t=>{
  const indexedDB=new IDBFactory();
  await seed(indexedDB,'bodygraph-chart-days',2,{packets:[{key:'large',bytes:new ArrayBuffer(3000)}],metadata:[]});
  const cache=createCalculationCache({indexedDB,maxBytes:9000});t.after(()=>cache.close());
  assert.equal((await cache.get<ArrayBuffer>('natal','large'))?.byteLength,3000);
  const payloads=await records(indexedDB,'bodygraph-chart-days',3,'packets');
  const moved=await records(indexedDB,'forma-calculation-cache',2,'payloads');
  assert.equal(payloads.length+moved.length,1,'a fitting final payload must not be discarded for temporary copy space');
  const status=await cache.status();assert.ok(status.accountedBytes!<=9000);
  assert.equal(status.phase,'migrating');assert.ok(status.legacyBytes!>0);
  assert.equal(await cache.put('return-charts','new',new ArrayBuffer(3000)),true,'a deferred copy cannot block subsequent writes');
  assert.equal(await cache.get('natal','large'),null,'ordinary legacy records remain subject to the common LRU');
  assert.ok(await cache.get('return-charts','new'));
  assert.equal((await cache.status()).phase,'ready');
});

for(const concurrent of [false,true])test(`replacing then deleting a legacy-backed key never resurrects its previous payload (${concurrent?'concurrent tabs':'sequential'})`,async t=>{
  const indexedDB=new IDBFactory();
  await seed(indexedDB,'bodygraph-chart-days',2,{packets:[{key:'same',bytes:new Uint8Array(3000).fill(1).buffer}],metadata:[]});
  const a=createCalculationCache({indexedDB,maxBytes:9000}),b=createCalculationCache({indexedDB,maxBytes:9000});t.after(()=>{a.close();b.close();});
  assert.equal((await a.get<ArrayBuffer>('natal','same'))?.byteLength,3000);
  const changed=a.put('natal','same',new Uint8Array(100).fill(2).buffer);
  if(!concurrent)await changed;
  await Promise.all([changed,b.remove('natal','same')]);
  const result=await a.get<ArrayBuffer>('natal','same');
  assert.ok(result===null || concurrent && result.byteLength===100 && new Uint8Array(result)[0]===2);
});

test('an owner whose initial open failed cannot adopt a later logout epoch',async t=>{
  const native=new IDBFactory();let denied=true;
  const factory={open(...args:Parameters<IDBFactory['open']>){if(denied)throw new Error('Denied');return native.open(...args);},cmp:native.cmp.bind(native)} as IDBFactory;
  const old=createCalculationCache({indexedDB:factory});t.after(()=>old.close());
  assert.equal((await old.status()).phase,'unavailable');denied=false;
  const fresh=createCalculationCache({indexedDB:factory});t.after(()=>fresh.close());
  await fresh.clearPersonal();
  assert.equal(await old.put('natal','late',new ArrayBuffer(100)),null);
});

test('the personal epoch also fences catalogue metadata',async t=>{
  const indexedDB=new IDBFactory(),old=createCalculationCache({indexedDB});t.after(()=>old.close());
  await old.status();await old.clearPersonal();
  const fresh=createCalculationCache({indexedDB});t.after(()=>fresh.close());
  await fresh.put('natal','new-personal-day',new ArrayBuffer(100));
  assert.equal(await old.catalogue('natal'),null);
});

test('clearPersonal reports pending physical cleanup when legacy deletion fails',async t=>{
  const indexedDB=new IDBFactory();
  await seed(indexedDB,'bodygraph-chart-days',2,{packets:[{key:'private',bytes:new ArrayBuffer(100)}],metadata:[]});
  const cache=createCalculationCache({indexedDB});t.after(()=>cache.close());
  const original=IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete=function(key){if(this.transaction.db.name==='bodygraph-chart-days')throw new Error('Unavailable');return original.call(this,key);};
  try {const result=await cache.clearPersonal();assert.equal(result?.status,'pending');}
  finally{IDBObjectStore.prototype.delete=original;}
  assert.equal((await cache.clearPersonal())?.status,'cleared');
  assert.deepEqual(await records(indexedDB,'bodygraph-chart-days',3,'packets'),[]);
});

test('an earlier timer follows a window extended by a tab that then closes',async t=>{
  const indexedDB=new IDBFactory(),version='a'.repeat(64),start=Date.now();
  const a=createCalculationCache({indexedDB}),b=createCalculationCache({indexedDB});t.after(()=>{a.close();b.close();});
  const first=await a.setTransitWindow({version,dates:['2026-10-26'],expiresAt:start+120});
  await b.setTransitWindow({version,dates:['2026-10-26'],expiresAt:start+260},{expectedRevision:first!.revision});
  await a.put('transit','today',new ArrayBuffer(100),{version,date:'2026-10-26'});b.close();
  await new Promise(resolve=>setTimeout(resolve,340));
  assert.deepEqual(await records(indexedDB,'forma-calculation-cache',2,'payloads'),[]);
});

test('reopening after transit expiry removes saved numbers without requiring a new write',async t=>{
  const indexedDB=new IDBFactory(),version='a'.repeat(64);let now=Date.parse('2026-10-26T12:00:00Z');
  const before=createCalculationCache({indexedDB,now:()=>now});
  await before.setTransitWindow({version,dates:['2026-10-26'],expiresAt:now+1000});
  await before.put('transit','today',new ArrayBuffer(100),{version,date:'2026-10-26'});before.close();now+=2000;
  const after=createCalculationCache({indexedDB,now:()=>now});t.after(()=>after.close());await after.status();
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(await records(indexedDB,'forma-calculation-cache',2,'payloads'),[]);
});


test('legacy import visits metadata linearly instead of rescanning the catalogue for every record',async()=>{
  const counts:number[]=[];
  for(const count of [32,64]) {
    const indexedDB=new IDBFactory();
    await seed(indexedDB,'bodygraph-chart-days',2,{packets:Array.from({length:count},(_,i)=>({key:'day-'+String(i).padStart(4,'0'),bytes:new ArrayBuffer(1500)})),metadata:[]});
    let steps=0;const next=IDBCursor.prototype.continue;
    IDBCursor.prototype.continue=function(key?:IDBValidKey){
      const source=this.source,store='objectStore' in source?source.objectStore:source;
      if(store.transaction.db.name==='forma-calculation-cache' && store.name==='catalogue')steps++;
      return key===undefined?next.call(this):next.call(this,key);
    };
    const cache=createCalculationCache({indexedDB});
    try {
      assert.equal((await cache.get<ArrayBuffer>('natal','day-0000'))?.byteLength,1500);
      assert.equal((await cache.status()).phase,'ready');counts.push(steps);
      assert.equal((await cache.catalogue('natal'))!.length,count);
    } finally {cache.close();IDBCursor.prototype.continue=next;}
  }
  assert.ok(counts[1]!<=counts[0]!*2.5+10,'doubling records must not quadruple metadata work: '+counts.join(', '));
  assert.ok(counts[1]!<=64*8,'bounded metadata passes: '+counts[1]);
});

test('version one cache upgrades its indexes without clearing payloads, budget or source checkpoints',async t=>{
  const sourceFactory=new IDBFactory(),source=createCalculationCache({indexedDB:sourceFactory,legacySources:[]});
  await source.put('natal','kept',Uint8Array.of(1,7,9));const before=await source.status();
  const stores=['payloads','catalogue','control'],saved=await Promise.all(stores.map(store=>records(sourceFactory,'forma-calculation-cache',2,store)));
  source.close();
  const indexedDB=new IDBFactory();
  const old=await new Promise<IDBDatabase>((resolve,reject)=>{
    const req=indexedDB.open('forma-calculation-cache',1);
    req.onupgradeneeded=()=>{
      req.result.createObjectStore('payloads',{keyPath:'id'});
      const catalogue=req.result.createObjectStore('catalogue',{keyPath:'id'});
      for(const name of ['kind','lru','location'])catalogue.createIndex(name,name);
      req.result.createObjectStore('control',{keyPath:'key'});
    };
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });
  await new Promise<void>((resolve,reject)=>{
    const tx=old.transaction(stores,'readwrite');
    stores.forEach((store,index)=>saved[index]!.forEach(row=>tx.objectStore(store).put(row)));
    tx.objectStore('control').put({key:'upgrade-probe',checkpoint:'preserved'});
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
  });old.close();
  const cache=createCalculationCache({indexedDB,legacySources:[]});t.after(()=>cache.close());
  assert.deepEqual(await cache.get('natal','kept'),Uint8Array.of(1,7,9));
  const after=await cache.status();assert.equal(after.accountedBytes,before.accountedBytes);assert.equal(after.legacyBytes,0);
  assert.ok((await records(indexedDB,'forma-calculation-cache',2,'control')).some(row=>row.key==='upgrade-probe' && row.checkpoint==='preserved'));
  const db=await open(indexedDB,'forma-calculation-cache',2);
  try {assert.deepEqual(Array.from(db.objectStoreNames),['catalogue','control','payloads']);
    assert.ok(db.transaction('catalogue').objectStore('catalogue').indexNames.contains('stage'));}
  finally {db.close();}
});

test('migration removes an evicting row before copying an earlier valid row',async t=>{
  const indexedDB=new IDBFactory();
  await seed(indexedDB,'bodygraph-chart-days',2,{packets:[{key:'a-valid',bytes:new ArrayBuffer(32)},{key:'z-invalid',unusable:true}],metadata:[]});
  const events:string[]=[],put=IDBObjectStore.prototype.put,remove=IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.put=function(value:unknown,key?:IDBValidKey){
    if(this.transaction.db.name==='forma-calculation-cache' && this.name==='payloads')events.push('copy');
    return key===undefined?put.call(this,value):put.call(this,value,key);
  };
  IDBObjectStore.prototype.delete=function(key:IDBValidKey|IDBKeyRange){
    if(this.transaction.db.name==='bodygraph-chart-days' && this.name==='packets')events.push('delete:'+String(key));
    return remove.call(this,key);
  };
  const cache=createCalculationCache({indexedDB});t.after(()=>cache.close());
  try {assert.equal((await cache.get<ArrayBuffer>('natal','a-valid'))!.byteLength,32);}
  finally {IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.delete=remove;}
  assert.ok(events.indexOf('delete:z-invalid')>=0);assert.ok(events.indexOf('delete:z-invalid')<events.indexOf('copy'));
});

test('a transit window expiring during migration is pruned before the next copy',async t=>{
  const indexedDB=new IDBFactory(),version='a'.repeat(64);let now=Date.parse('2026-10-26T12:00:00Z');const expires=now+100000;
  await seed(indexedDB,'bodygraph-chart-days',2,{packets:[{key:'a',bytes:new ArrayBuffer(32)},{key:'b',bytes:new ArrayBuffer(32)}],metadata:[]});
  const transitKey=version+':2026-10-26';
  await seed(indexedDB,'forma-moments',2,{packets:[{key:transitKey,day:new Float64Array(24*1440)}],catalogue:[],settings:[]});
  const cache=createCalculationCache({indexedDB,now:()=>now});t.after(()=>cache.close());
  await cache.setTransitWindow({version,dates:['2026-10-26'],expiresAt:expires});
  const events:string[]=[],remove=IDBObjectStore.prototype.delete,put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.delete=function(key:IDBValidKey|IDBKeyRange){
    if(this.transaction.db.name==='bodygraph-chart-days' && this.name==='packets' && key==='a')now=expires;
    if(this.transaction.db.name==='forma-moments' && this.name==='packets')events.push('expired');
    return remove.call(this,key);
  };
  IDBObjectStore.prototype.put=function(value:unknown,key?:IDBValidKey){
    if(this.transaction.db.name==='forma-calculation-cache' && this.name==='payloads' && (value as {id:string}).id==='["natal","b"]')events.push('copy-b');
    return key===undefined?put.call(this,value):put.call(this,value,key);
  };
  try {assert.equal((await cache.get<ArrayBuffer>('natal','a'))?.byteLength,32);}
  finally {IDBObjectStore.prototype.delete=remove;IDBObjectStore.prototype.put=put;}
  assert.ok(events.indexOf('expired')>=0);assert.ok(events.indexOf('expired')<events.indexOf('copy-b'));
  assert.equal(await cache.get('transit',transitKey),null);assert.equal((await cache.status()).phase,'ready');
});


test('a full device still serves saved calculations when updating their access metadata fails',async t=>{
  const indexedDB=new IDBFactory(),cache=createCalculationCache({indexedDB,legacySources:[]});t.after(()=>cache.close());
  const value=new Uint8Array([3,1,4]);await cache.put('natal','saved',value);
  const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value:unknown,key?:IDBValidKey){
    if(this.transaction.db.name==='forma-calculation-cache' && this.name==='catalogue')throw new DOMException('full','QuotaExceededError');
    return key===undefined?original.call(this,value):original.call(this,value,key);
  };
  try{assert.deepEqual(await cache.get('natal','saved'),value);}
  finally{IDBObjectStore.prototype.put=original;}
  assert.equal((await cache.catalogue('natal'))!.length,1);
});

test('physical quota during migration leaves the original day readable and resumes after space returns',async t=>{
  const indexedDB=new IDBFactory(),value=new Uint8Array([2,7,1,8]).buffer;
  await seed(indexedDB,'bodygraph-chart-days',2,{packets:[{key:'saved',bytes:value}],metadata:[]});
  const cache=createCalculationCache({indexedDB});t.after(()=>cache.close());
  const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value:unknown,key?:IDBValidKey){
    if(this.transaction.db.name==='forma-calculation-cache' && this.name==='payloads')throw new DOMException('full','QuotaExceededError');
    return key===undefined?original.call(this,value):original.call(this,value,key);
  };
  try{
    assert.deepEqual(await cache.get('natal','saved'),value);
    assert.equal((await cache.status()).phase,'migrating');
    assert.equal((await records(indexedDB,'bodygraph-chart-days',3,'packets')).length,1);
  }finally{IDBObjectStore.prototype.put=original;}
  assert.deepEqual(await cache.get('natal','saved'),value);
  assert.equal((await cache.status()).phase,'ready');
  assert.deepEqual(await records(indexedDB,'bodygraph-chart-days',3,'packets'),[]);
});


test('a saved birth day opens through the real client without network when access bookkeeping hits quota',async t=>{
  const [{createNatalDayClient},{createBinaryCache},{encodeNatalDay},{natalDayFixture,personalChartFixture}]=await Promise.all([
    import('../src/data/natal-day-client.ts'),import('../src/data/binary-cache.ts'),
    import('../server/packets/encode.ts'),import('./fixtures/natal-day.ts')]);
  const indexedDB=new IDBFactory(),version='a'.repeat(64),chart=personalChartFixture();
  const cache=createCalculationCache({indexedDB,legacySources:[]}),binary=createBinaryCache({cache});
  t.after(()=>{binary.close();cache.close();});
  const bytes=encodeNatalDay({...natalDayFixture(),calculationVersion:version}).buffer;
  await binary.put(`natal-day:${version}:1:${chart.birthDate}:${chart.cityId}`,bytes);
  let networkCalls=0;
  const client=createNatalDayClient({calculationVersion:version,persistentCache:binary,
    fetch:async()=>{networkCalls++;throw new Error('Network unavailable');}});
  const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value:unknown,key?:IDBValidKey){
    if(this.transaction.db.name==='forma-calculation-cache' && this.name==='catalogue')throw new DOMException('full','QuotaExceededError');
    return key===undefined?original.call(this,value):original.call(this,value,key);
  };
  try{
    const day=await client.getDay(chart);
    assert.equal(day.calculationVersion,version);assert.equal(day.date,chart.birthDate);assert.equal(networkCalls,0);
  }finally{IDBObjectStore.prototype.put=original;}
});
