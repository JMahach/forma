export type MemoryCache = ReturnType<typeof createMemoryCache>;
// One byte budget for reusable calculation data in a tab. Active views retain
// their inputs; eviction removes only the cache's ownership of inactive data.
export const TAB_CACHE_BYTES = 64 * 1024 * 1024;

// Account retained data, not the browser's entire JavaScript heap. Typed-array
// backing buffers are counted once even when several columns share a buffer.
export function estimateBytes(value: unknown, seen = new Set<object>()): number {
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
  const entries = new Map<PropertyKey, { value: unknown; bytes: number }>(), retained = new Map<PropertyKey, {count:number}>();
  let bytes = 0;
  function remove(key: PropertyKey) {
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
    get<T = unknown>(key: PropertyKey): T | null {
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key); entries.set(key, entry);
      return entry.value as T;
    },
    put<T>(key: PropertyKey, value: T, size = estimateBytes(value)) {
      if (!Number.isFinite(size) || size < 0) throw new RangeError('Invalid cached data size');
      remove(key);
      entries.set(key, { value, bytes: size }); bytes += size; evict();
      return value;
    },
    delete: remove,
    clearExcept(prefix:string) {
      const keep=(key:PropertyKey)=>typeof key==='string' && key.startsWith(prefix);
      for(const key of entries.keys())if(!keep(key))remove(key);
      for(const key of retained.keys())if(!keep(key))retained.delete(key);
    },
    retain<T>(key: PropertyKey, value: T, size?: number) {
      const ownership=retained.get(key)??{count:0};ownership.count++;
      retained.set(key,ownership);
      api.put(key, value, size);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // A clear can give the same key a new owner before this release arrives.
        if(retained.get(key)!==ownership)return;
        if(--ownership.count===0)retained.delete(key);
        evict();
      };
    },
    get bytes() { return bytes; }, get size() { return entries.size; },
  };
  return api;
}
