import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBIndex, IDBObjectStore } from 'fake-indexeddb';
import { createTransitDayCache } from '../src/data/transit-day-cache.ts';
import { createCalculationCache } from '../src/data/calculation-cache.ts';
import { LEGACY_CALCULATION_SOURCES } from '../src/data/calculation-migration.ts';
import { createMemoryCache } from '../src/data/memory-cache.ts';
const version='a'.repeat(64),other='b'.repeat(64),start=Date.parse('2026-10-09T00:00:00Z');
function day(offset=0) {
  const ms=start+offset*86400000,date=new Date(ms).toISOString().slice(0,10);
  return {version:'2',calculationVersion:version,date,startUtc:`${date}T00:00:00Z`,samples:1440,stepSeconds:60,
    engine:'test',ephemeris:'test',timezoneDatabase:'test',nodeModel:'true',zodiac:'tropical-geocentric-apparent',
    columns:Array.from({length:24},(_,c)=>Float64Array.from({length:1440},(_,i)=>c<22?(c+i/100)%360:c===22?ms/1000-88*86400+i*60:1e-10))};
}
function cache(t,options={}) {const value=createTransitDayCache(options);t.after(()=>value.close());return value;}
function owner(t,indexedDB=new IDBFactory(),options={}) {
  const value=createCalculationCache({indexedDB,now:()=>start,...options});t.after(()=>value.close());return value;
}
const windowFor=(offsets=[0])=>({version,dates:offsets.map(offset=>day(offset).date),expiresAt:start+86400000});
async function seedLegacy(indexedDB,name,rows) {
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(name,1);
    request.onupgradeneeded=()=>{request.result.createObjectStore('packets',{keyPath:'key'});request.result.createObjectStore('catalogue',{keyPath:'key'});request.result.createObjectStore('settings');};
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  await new Promise((resolve,reject)=>{const tx=db.transaction('packets','readwrite');for(const row of rows)tx.objectStore('packets').put(row);
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
}
function packet(value) {
  const numbers=new Float64Array(24*1440);value.columns.forEach((column,c)=>numbers.set(column,c*1440));
  return {key:`${version}:${value.date}`,day:numbers,meta:Object.fromEntries(['engine','ephemeris','timezoneDatabase','nodeModel','zodiac'].map(key=>[key,value[key]]))};
}

test('a current full day survives reload and coverage precedes reading its numbers',async t=>{
  const indexedDB=new IDBFactory(),shared=owner(t,indexedDB);await shared.setTransitWindow(windowFor());
  const first=cache(t,{cache:shared}),value=day();first.putDay(value);await first.flush();
  assert.equal(first.peekDay(value.date,version),value);
  const second=cache(t,{cache:owner(t,indexedDB)});await second.prepare(version);
  assert.equal(second.hasMinute(start+751*60000,version),true);assert.equal(second.peekDay(value.date,version),null);
  const loaded=await second.getDay(value.date,version);assert.deepEqual(loaded,value);
  assert.equal(loaded.columns[0].buffer,loaded.columns[23].buffer);
  assert.equal(await second.getDay(value.date,other),null);assert.equal(second.hasMinute(start+1000,version),false);
  await first.close();assert.ok(await shared.get('transit',`${version}:${value.date}`),'closing an adapter keeps its shared owner alive');
});

test('without a confirmed window full days are RAM only',async t=>{
  const indexedDB=new IDBFactory(),shared=owner(t,indexedDB),memory=createMemoryCache({maxBytes:300000}),value=day();
  const first=cache(t,{indexedDB,cache:shared,memory});await first.prepare(version);first.putDay(value);await first.flush();
  assert.equal(first.peekDay(value.date,version),value);
  memory.put('other',new Uint8Array(300000));assert.equal(first.hasMinute(start,version),false);
  assert.equal(await first.getDay(value.date,version),null);assert.deepEqual(await shared.catalogue('transit'),[]);
});

test('the confirmed one or two dates replace the disk window at local midnight',async t=>{
  const indexedDB=new IDBFactory(),shared=owner(t,indexedDB),secondOwner=owner(t,indexedDB);
  const firstWindow=await shared.setTransitWindow(windowFor([0,1]));
  const writer=cache(t,{cache:shared}),reader=cache(t,{cache:secondOwner,memory:createMemoryCache({maxBytes:0})});
  for(let i=0;i<3;i++){writer.putDay(day(i));await writer.flush();}
  await reader.prepare(version);
  assert.equal(reader.hasMinute(start,version),true);assert.equal(reader.hasMinute(start+86400000,version),true);
  assert.equal(reader.hasMinute(start+2*86400000,version),false);
  await secondOwner.setTransitWindow({...windowFor([1,2]),expiresAt:start+2*86400000},{expectedRevision:firstWindow.revision});
  writer.putDay(day(2));await writer.flush();await reader.prepare(version);
  assert.equal(reader.hasMinute(start,version),false);assert.equal(reader.hasMinute(start+86400000,version),true);
  assert.equal(reader.hasMinute(start+2*86400000,version),true);
  assert.equal(await reader.getDay(day().date,version),null);
  assert.equal(writer.peekDay(day().date,version)?.date,day().date,'older days may remain in bounded RAM');
});

test('deleting a day in another tab invalidates saved coverage without reloading',async t=>{
  const indexedDB=new IDBFactory(),shared=owner(t,indexedDB),otherOwner=owner(t,indexedDB);await shared.setTransitWindow(windowFor());
  const writer=cache(t,{cache:shared}),reader=cache(t,{cache:otherOwner});writer.putDay(day());await writer.flush();
  await reader.prepare(version);assert.equal(reader.hasMinute(start,version),true);
  await shared.remove('transit',`${version}:${day().date}`);
  assert.equal(reader.hasMinute(start,version),false);await reader.prepare(version);
  assert.equal(reader.hasMinute(start,version),false);
});

test('a delayed coverage snapshot cannot restore a concurrently removed day',async t=>{
  const shared=owner(t);await shared.setTransitWindow(windowFor());const writer=cache(t,{cache:shared});writer.putDay(day());await writer.flush();
  let release,scanned;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>scanned=resolve);
  const original=shared.catalogue.bind(shared);let first=true;
  t.mock.method(shared,'catalogue',async kind=>{const rows=await original(kind);if(first){first=false;scanned();await gate;}return rows;});
  const reader=cache(t,{cache:shared}),pending=reader.prepare(version);await started;
  await shared.remove('transit',`${version}:${day().date}`);release();await pending;
  assert.equal(reader.hasMinute(start,version),false);
});

test('custom legacy storage migrates full days and discards obsolete sparse packets',async t=>{
  const indexedDB=new IDBFactory(),databaseName='custom-moments';
  await seedLegacy(indexedDB,databaseName,[packet(day()),{key:`${version}:${day(1).date}`,offsets:new Uint32Array([0]),values:new Float64Array(24)}]);
  const legacySources=LEGACY_CALCULATION_SOURCES.map(source=>source.family==='transit'?{...source,databaseName}:source);
  const shared=owner(t,indexedDB,{legacySources});await shared.setTransitWindow({...windowFor([0,1]),expiresAt:Date.now()+86400000});
  // Exercise the adapter's own owner and custom legacy-name mapping.
  const first=cache(t,{indexedDB,databaseName});await first.prepare(version);
  assert.equal(first.hasMinute(start,version),true);assert.deepEqual(await first.getDay(day().date,version),day());
  assert.equal(await first.getDay(day(1).date,version),null);
  assert.equal((await shared.status()).legacyBytes,0);
});

test('quota failure retains usable RAM but does not advertise disk coverage after eviction',async t=>{
  const shared=owner(t),memory=createMemoryCache({maxBytes:300000});await shared.setTransitWindow(windowFor());
  const first=cache(t,{cache:shared,memory});await first.prepare(version);
  const original=IDBObjectStore.prototype.put;
  t.mock.method(IDBObjectStore.prototype,'put',function(...args){if(args[0]?.value?.day instanceof Float64Array)throw new DOMException('Full','QuotaExceededError');return original.apply(this,args);});
  first.putDay(day());await first.flush();assert.equal(first.hasMinute(start,version),true);
  memory.put('other',new Uint8Array(300000));assert.equal(first.hasMinute(start,version),false);
  assert.equal(await first.getDay(day().date,version),null);
});

test('active days retain shared RAM ownership and release under pressure',async t=>{
  const memory=createMemoryCache({maxBytes:300000}),first=cache(t,{indexedDB:null,memory}),value=day(),release=first.retainDay(value);
  memory.put('other-a',new Uint8Array(100000));assert.equal(first.peekDay(value.date,version),value);assert.equal(memory.get('other-a'),null);
  release();memory.put('other-b',new Uint8Array(300000));assert.equal(first.peekDay(value.date,version),null);
});

test('an aborted catalogue transaction publishes no partial coverage and can retry',async t=>{
  const shared=owner(t);await shared.setTransitWindow(windowFor());const writer=cache(t,{cache:shared});writer.putDay(day());await writer.flush();
  const original=IDBIndex.prototype.openCursor;
  const mock=t.mock.method(IDBIndex.prototype,'openCursor',function(...args){const request=original.apply(this,args);
    if(this.name==='kind')request.addEventListener('success',()=>{if(request.result===null)this.objectStore.transaction.abort();});return request;});
  const reader=cache(t,{cache:shared});await reader.prepare(version);assert.equal(reader.hasMinute(start,version),false);
  mock.mock.restore();await reader.prepare(version);assert.equal(reader.hasMinute(start,version),true);
});

test('coverage recovers after unavailable open without constructing another adapter',async t=>{
  const native=new IDBFactory(),shared=owner(t,native);await shared.setTransitWindow({...windowFor(),expiresAt:Date.now()+86400000});
  const writer=cache(t,{cache:shared});writer.putDay(day());await writer.flush();
  let enabled=false;
  const indexedDB={open(...args){if(!enabled)throw Error('Denied');return native.open(...args);},cmp(...args){return native.cmp(...args);}};
  const reader=cache(t,{indexedDB});await reader.prepare(version);assert.equal(reader.hasMinute(start,version),false);
  enabled=true;await reader.prepare(version);assert.equal(reader.hasMinute(start,version),true);
});

test('fresh overlapping data wins an older disk read even with no spare RAM',async t=>{
  const shared=owner(t);await shared.setTransitWindow(windowFor());
  let release;const gate=new Promise(resolve=>release=resolve),original=shared.get.bind(shared);
  t.mock.method(shared,'get',async(...args)=>{const snapshot=await original(...args);await gate;return snapshot;});
  const first=cache(t,{cache:shared,memory:createMemoryCache({maxBytes:0})}),value=day();
  await first.prepare(version);const pending=first.getDay(value.date,version);first.putDay(value);await first.flush();release();
  assert.equal(await pending,value);
});

test('RAM hits touch the common LRU and coalesce concurrent touches',async t=>{
  const shared=owner(t);await shared.setTransitWindow(windowFor());const first=cache(t,{cache:shared}),value=day();
  first.putDay(value);await first.flush();const original=shared.touch.bind(shared),calls=[];
  t.mock.method(shared,'touch',(...args)=>{calls.push(args);return original(...args);});
  for(let i=0;i<10;i++)assert.equal(first.peekDay(value.date,version),value);
  assert.deepEqual(calls,[['transit',`${version}:${value.date}`]]);
});
