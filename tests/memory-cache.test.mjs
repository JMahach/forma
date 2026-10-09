import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCache, estimateBytes, TAB_CACHE_BYTES } from '../src/data/memory-cache.js';

test('one byte budget evicts the least recently used data across kinds', () => {
  const cache = createMemoryCache({ maxBytes: 10 });
  cache.put('transit:a', 'a', 4); cache.put('natal:b', 'b', 4);
  assert.equal(cache.get('transit:a'), 'a');
  cache.put('return:c', 'c', 4);
  assert.equal(cache.get('natal:b'), null); assert.equal(cache.get('transit:a'), 'a');
  assert.equal(cache.bytes, 8); assert.equal(TAB_CACHE_BYTES, 64 * 1024 * 1024);
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
});
