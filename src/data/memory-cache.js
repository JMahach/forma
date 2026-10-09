// One byte budget for reusable calculation data in a tab. Active views retain
// their inputs; eviction removes only the cache's ownership of inactive data.
export const TAB_CACHE_BYTES = 64 * 1024 * 1024;

// Account retained data, not the browser's entire JavaScript heap. Typed-array
// backing buffers are counted once even when several columns share a buffer.
export function estimateBytes(value, seen = new Set()) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number' || typeof value === 'bigint') return 8;
  if (typeof value === 'boolean') return 4;
  if (typeof value !== 'object' || seen.has(value)) return 0;
  seen.add(value);
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return 32 + estimateBytes(value.buffer, seen);
  let bytes = 32;
  for (const [key, item] of Object.entries(value)) bytes += key.length * 2 + 8 + estimateBytes(item, seen);
  return bytes;
}

export function createMemoryCache({ maxBytes = TAB_CACHE_BYTES } = {}) {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new RangeError('Invalid tab cache budget');
  const entries = new Map(), retained = new Map();
  let bytes = 0;
  function remove(key) {
    const entry = entries.get(key);
    if (entry) { bytes -= entry.bytes; entries.delete(key); }
  }
  function evict() {
    for (const key of entries.keys()) {
      if (bytes <= maxBytes) break;
      if (!retained.has(key)) remove(key);
    }
  }
  const api = {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key); entries.set(key, entry);
      return entry.value;
    },
    put(key, value, size = estimateBytes(value)) {
      if (!Number.isFinite(size) || size < 0) throw new RangeError('Invalid cached data size');
      remove(key);
      entries.set(key, { value, bytes: size }); bytes += size; evict();
      return value;
    },
    delete: remove,
    retain(key, value, size) {
      retained.set(key, (retained.get(key) || 0) + 1);
      api.put(key, value, size);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = retained.get(key) - 1;
        if (count) retained.set(key, count); else retained.delete(key);
        evict();
      };
    },
    get bytes() { return bytes; }, get size() { return entries.size; },
  };
  return api;
}
