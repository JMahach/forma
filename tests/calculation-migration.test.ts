import {encodeNatalDay} from '../server/packets/encode.ts';
import {natalDayFixture} from './fixtures/natal-day.ts';
function readable(value:Awaited<ReturnType<ReturnType<typeof createLegacyCalculationSource>['next']>>) {assert.ok(value.status==='ok');return value;}
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { LEGACY_CALCULATION_SOURCES, createLegacyCalculationSource, describeLegacyCalculation } from '../src/data/calculation-migration.ts';

const natal=LEGACY_CALCULATION_SOURCES.find(source=>source.family==='natal')!;
const returns=LEGACY_CALCULATION_SOURCES.find(source=>source.family==='returns')!;
const transit=LEGACY_CALCULATION_SOURCES.find(source=>source.family==='transit')!;
const version='a'.repeat(64), tick=()=>new Promise(setImmediate);
function open(factory:IDBFactory,name:string,version:number,upgrade?:(db:IDBDatabase)=>void):Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    const request=factory.open(name,version);
    request.onupgradeneeded=()=>upgrade?.(request.result);
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}
function write(db:IDBDatabase,store:string,value:unknown,key?:IDBValidKey) {
  return new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(store,'readwrite');
    if(key===undefined)tx.objectStore(store).put(value);else tx.objectStore(store).put(value,key);
    tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error);
  });
}

test('upgrading a legacy source preserves its packets, adds missing stores, and fences old code only after commit',async t=>{
  const indexedDB=new IDBFactory();
  const old=await open(indexedDB,natal.legacyDatabaseName,2,db=>{
    db.createObjectStore('packets',{keyPath:'key'});db.createObjectStore('unrelated',{keyPath:'key'});
  });
  await write(old,'packets',{key:'a',bytes:new Uint8Array([1,2,3]).buffer});
  await write(old,'unrelated',{key:'keep',value:'untouched'});
  old.onversionchange=()=>old.close();
  const source=createLegacyCalculationSource(natal,{indexedDB});t.after(()=>source.close());
  assert.deepEqual(await source.next('packets'),{status:'ok',entry:{key:'a',value:{key:'a',bytes:new Uint8Array([1,2,3]).buffer}}});
  assert.deepEqual(await source.next('metadata'),{status:'ok',entry:null});
  await assert.rejects(open(indexedDB,natal.legacyDatabaseName,2),{name:'VersionError'});
  const current=await open(indexedDB,natal.legacyDatabaseName,3);t.after(()=>current.close());
  assert.equal(current.objectStoreNames.contains('unrelated'),true);
  const retained=await new Promise(resolve=>{const request=current.transaction('unrelated').objectStore('unrelated').get('keep');request.onsuccess=()=>resolve(request.result);});
  assert.deepEqual(retained,{key:'keep',value:'untouched'});
  assert.deepEqual(await source.get('unrelated','keep'),{status:'unavailable'});
  assert.equal(await source.remove('unrelated','keep'),false);
});

test('cursor checkpoints survive restart and deletion without reading an entire source',async t=>{
  const indexedDB=new IDBFactory(),old=await open(indexedDB,natal.legacyDatabaseName,2,db=>db.createObjectStore('packets',{keyPath:'key'}));
  for(const key of ['a','b','c'])await write(old,'packets',{key,bytes:new Uint8Array([key.charCodeAt(0)]).buffer});
  old.close();
  t.mock.method(IDBObjectStore.prototype,'getAll',()=>{throw new Error('Payload scans are forbidden');});
  let source=createLegacyCalculationSource(natal,{indexedDB});
  assert.equal(readable(await source.next('packets')).entry?.key,'a');
  assert.equal(await source.remove('packets','a'),true);source.close();
  source=createLegacyCalculationSource(natal,{indexedDB});t.after(()=>source.close());
  assert.equal(readable(await source.next('packets','a')).entry?.key,'b');
  assert.equal(readable(await source.next('packets','b')).entry?.key,'c');
  assert.deepEqual(await source.next('packets','c'),{status:'ok',entry:null});
  assert.deepEqual(await source.get('packets','a'),{status:'ok',entry:null});
  assert.equal(readable(await source.get('packets','b')).entry?.key,'b');
});

test('a blocked upgrade reports unavailable, retains the source, and resumes after the old connection leaves',async t=>{
  const indexedDB=new IDBFactory(),old=await open(indexedDB,natal.legacyDatabaseName,2,db=>db.createObjectStore('packets',{keyPath:'key'}));
  await write(old,'packets',{key:'a',bytes:new ArrayBuffer(7)});
  const source=createLegacyCalculationSource(natal,{indexedDB,timeoutMs:50});t.after(()=>{old.close();source.close();});
  assert.deepEqual(await source.get('packets','a'),{status:'unavailable'});
  assert.equal(old.version,2);
  old.close();
  let result=await source.get('packets','a');
  for(let i=0;i<20&&result.status==='unavailable';i++){await tick();result=await source.get('packets','a');}
  assert.deepEqual(result,{status:'ok',entry:{key:'a',value:{key:'a',bytes:new ArrayBuffer(7)}}});
});

test('out-of-line metadata keys and undefined values are distinguishable from absent rows',async t=>{
  const indexedDB=new IDBFactory(),old=await open(indexedDB,transit.legacyDatabaseName,1,db=>db.createObjectStore('settings'));
  await write(old,'settings',undefined,'present');await write(old,'settings',false,'second');old.close();
  const source=createLegacyCalculationSource(transit,{indexedDB});t.after(()=>source.close());
  assert.deepEqual(await source.get('settings','present'),{status:'ok',entry:{key:'present',value:undefined}});
  assert.deepEqual(await source.next('settings','present'),{status:'ok',entry:{key:'second',value:false}});
  assert.deepEqual(await source.get('settings','absent'),{status:'ok',entry:null});
});

test('a checkpoint may be an absent compound key without replaying preceding payloads',async t=>{
  const indexedDB=new IDBFactory(),old=await open(indexedDB,transit.legacyDatabaseName,1,db=>db.createObjectStore('settings'));
  await write(old,'settings','first',['group',1]);await write(old,'settings','third',['group',3]);old.close();
  const source=createLegacyCalculationSource(transit,{indexedDB});t.after(()=>source.close());
  assert.deepEqual(await source.next('settings',['group',2]),{status:'ok',entry:{key:['group',3],value:'third'}});
  assert.deepEqual(await source.next('settings',['group',3]),{status:'ok',entry:null});
});

test('missing IndexedDB does not masquerade as a completed empty source or a successful removal',async()=>{
  const source=createLegacyCalculationSource(natal,{indexedDB:null});
  assert.deepEqual(await source.next('packets'),{status:'unavailable'});
  assert.deepEqual(await source.get('packets','a'),{status:'unavailable'});
  assert.equal(await source.remove('packets','a'),false);source.close();
});

test('legacy descriptions rekey ready results without calculation markers',()=>{
  const bytes=encodeNatalDay(natalDayFixture()).buffer,key=`natal-day:${version}:1:2026-09-24:city`;
  assert.deepEqual(describeLegacyCalculation(natal,'packets',key,{key,bytes}),{kind:'natal',key:'natal-day:1:2026-09-24:city',value:bytes,date:'2026-09-24'});
  assert.deepEqual(describeLegacyCalculation(natal,'packets','unversioned',{bytes}),{kind:'natal',key:'unversioned',value:bytes});
  assert.equal(describeLegacyCalculation(natal,'metadata',key,{key,bytes}),null);
  assert.equal(describeLegacyCalculation(natal,'packets',key,{bytes:'broken'}),null);
  const transitKey=`${version}:2026-10-26`,packet={key:transitKey,day:new Float64Array(24*1440),meta:{engine:'test'}};
  assert.deepEqual(describeLegacyCalculation(transit,'packets',transitKey,packet),{kind:'transit',key:'2026-10-26',value:{...packet,key:'2026-10-26'},date:'2026-10-26'});
  assert.equal(describeLegacyCalculation(transit,'packets',transitKey,{...packet,day:new Float64Array(10)}),null);
  assert.equal(describeLegacyCalculation(transit,'catalogue',transitKey,{full:1}),null);
  assert.equal(describeLegacyCalculation(transit,'settings','legacy',{}),null);
});

test('only basic return bodies migrate; chart identity can come from its structured key or stored event',()=>{
  const key=JSON.stringify(['events',version,'2000-01-01T00:00:00Z','saturn',0,100]);
  const dates={key,birthUtc:'2000-01-01T00:00:00Z',body:'saturn',range:{fromAge:0,toAge:100},events:[]};
  assert.deepEqual(describeLegacyCalculation(returns,'events',key,dates),{kind:'return-events',key:JSON.stringify(['events','2000-01-01T00:00:00Z','saturn',0,100]),value:{...dates,key:JSON.stringify(['events','2000-01-01T00:00:00Z','saturn',0,100])}});
  assert.equal(describeLegacyCalculation(returns,'events',key,{...dates,body:'moon'}),null);
  const chartKey=JSON.stringify(['chart',version,'2000-01-01T00:00:00Z','chiron','2050-01-01T00:00:00Z','UTC']);
  const data={chart:{utc:'2050-01-01T00:00:00Z'}};
  assert.deepEqual(describeLegacyCalculation(returns,'charts',chartKey,{key:chartKey,data}),{kind:'return-charts',key:JSON.stringify(['chart','2000-01-01T00:00:00Z','chiron','2050-01-01T00:00:00Z','UTC']),value:data});
  const oldData={...data,event:{body:'saturn'}};
  assert.deepEqual(describeLegacyCalculation(returns,'charts','old-chart',{data:oldData}),{kind:'return-charts',key:'old-chart',value:oldData});
  assert.equal(describeLegacyCalculation(returns,'charts','old-chart',{data}),null);
  assert.equal(describeLegacyCalculation(returns,'charts','old-chart',{data:{event:{body:'moon'}}}),null);
  assert.equal(describeLegacyCalculation(returns,'charts',chartKey,{data:{event:{body:'moon'}}}),null);
});
