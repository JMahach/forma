import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCache, estimateBytes, TAB_CACHE_BYTES } from '../src/data/memory-cache.ts';

test('one byte budget evicts the least recently used data across kinds', () => {
  for(const access of ['peek','get','retain'] as const){
    const cache = createMemoryCache({ maxBytes: 10 });
    cache.put('transit:a', 'a', 4); cache.put('natal:b', 'b', 4);
    if(access==='retain')cache.retain('transit:a','a')();
    else assert.equal(cache[access]('transit:a'), 'a');
    cache.put('return:c', 'c', 4);
    if(access==='peek'){
      assert.equal(cache.get('transit:a'),null,'observation must not protect the oldest entry');
      assert.equal(cache.get('natal:b'),'b');
    }else{
      assert.equal(cache.get('natal:b'), null); assert.equal(cache.get('transit:a'), 'a');
    }
    assert.equal(cache.bytes, 8); assert.equal(cache.peek('missing'),null);
  }
  assert.equal(TAB_CACHE_BYTES, 64 * 1024 * 1024);
});

test('active data survives pressure and becomes evictable after every owner releases it', () => {
  const cache = createMemoryCache({ maxBytes: 5 });
  const release = cache.retain('day', 'day', 4), also = cache.retain('day', 'day', 4);
  cache.put('other', 'other', 4); assert.equal(cache.get('day'), 'day');
  release(); release(); cache.put('other', 'other', 4); assert.equal(cache.get('day'), 'day');
  also(); cache.put('other', 'other', 4); assert.equal(cache.get('day'), null);
  assert.equal(cache.bytes, 4);
});

test('replacement, deletion and shared buffers preserve correct byte accounting', () => {
  const cache = createMemoryCache({ maxBytes: 12 });
  cache.put('a', {}, 7); cache.put('a', {}, 3); assert.equal(cache.bytes, 3);
  cache.delete('a'); assert.equal(cache.bytes, 0);
  const buffer = new ArrayBuffer(100);
  assert.equal(estimateBytes([new Uint8Array(buffer), new Uint8Array(buffer)]), 216);
  cache.put('too large', 'value', 13); assert.equal(cache.size, 0);
  const measured=createMemoryCache();let scans=0;
  const value={get payload(){scans++;return 'day';}};
  measured.put('day',value);const initialBytes=measured.bytes;
  assert.equal(scans,1);
  const release=measured.retain('day',value);
  assert.equal(scans,1,'retaining the same object must reuse its accounted size');
  assert.equal(measured.bytes,initialBytes);
  const resized=measured.retain('day',value,7),again=measured.retain('day',value);
  assert.equal(scans,1);assert.equal(measured.bytes,7,'explicit size replaces the old accounting');
  const replacement={payload:'different'};
  const replace=measured.retain('day',replacement);
  assert.equal(measured.bytes,estimateBytes(replacement),'a different object needs its own estimate');
  release();resized();again();replace();

});

test('clearExcept preserves only matching string entries and their active ownership',()=>{
  const cache=createMemoryCache({maxBytes:32}),releaseTransit=cache.retain('transit-day:today','today',4);
  const releaseNatal=cache.retain('natal:birth','birth',4);
  cache.put('transit-days:other','other',4);cache.put(Symbol('transit-day:symbol'),'symbol',4);cache.put(7,'number',4);
  cache.clearExcept('transit-day:');
  assert.equal(cache.size,1);assert.equal(cache.bytes,4);assert.equal(cache.get('transit-day:today'),'today');
  assert.equal(cache.get('natal:birth'),null);assert.equal(cache.get(7),null);
  releaseNatal();cache.put('pressure','pressure',32);
  assert.equal(cache.get('transit-day:today'),'today');assert.equal(cache.get('pressure'),null);
  releaseTransit();cache.put('pressure','pressure',32);
  assert.equal(cache.get('transit-day:today'),null);assert.equal(cache.bytes,32);
});

test('a late release before clear cannot release new ownership of the same key',()=>{
  const cache=createMemoryCache({maxBytes:5}),oldRelease=cache.retain('natal:birth','old',4);
  cache.clearExcept('transit-day:');assert.equal(cache.bytes,0);
  const newRelease=cache.retain('natal:birth','new',4);
  oldRelease();oldRelease();cache.put('pressure','pressure',4);
  assert.equal(cache.get('natal:birth'),'new');assert.equal(cache.get('pressure'),null);
  newRelease();cache.put('pressure','pressure',4);
  assert.equal(cache.get('natal:birth'),null);assert.equal(cache.get('pressure'),'pressure');assert.equal(cache.bytes,4);
});

test('clearExcept also forgets retention tokens whose payload was already deleted',()=>{
  const cache=createMemoryCache({maxBytes:5}),oldRelease=cache.retain('natal:birth','old',4);
  cache.delete('natal:birth');cache.clearExcept('transit-day:');
  cache.put('natal:birth','replacement',4);oldRelease();cache.put('pressure','pressure',4);
  assert.equal(cache.get('natal:birth'),null);assert.equal(cache.get('pressure'),'pressure');assert.equal(cache.bytes,4);
});
