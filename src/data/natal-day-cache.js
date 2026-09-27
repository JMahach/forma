// Optional device-local packet cache. A denied, full or stalled database never
// prevents a day from loading. Records contain date/city keys and binary data,
// without chart names, notes or saved-chart identifiers.
export function createChartDayCache({
  indexedDB: databaseFactory, capacity = 4, maxBytes = 8 * 1024 * 1024,
  maxAgeMs = 30 * 24 * 60 * 60 * 1000, timeoutMs = 500, now = () => Date.now(),
} = {}) {
  const limit = Math.max(1, Math.floor(capacity));
  let database = null, opening = null;

  function bounded(operation, fallback = null) {
    return new Promise(resolve => {
      let done = false;
      const finish = value => {
        if (done) return;
        done = true; clearTimeout(timer); resolve(value);
      };
      const timer = setTimeout(() => finish(fallback), timeoutMs);
      Promise.resolve().then(operation).then(finish, () => finish(fallback));
    });
  }

  function open() {
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    opening = bounded(() => new Promise(resolve => {
      const indexedDB = databaseFactory === undefined ? globalThis.indexedDB : databaseFactory;
      if (!indexedDB) { resolve(null); return; }
      const request = indexedDB.open('bodygraph-chart-days', 1);
      let expired = false;
      const deadline = setTimeout(() => { expired = true; resolve(null); }, timeoutMs);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('packets')) request.result.createObjectStore('packets', { keyPath: 'key' });
      };
      request.onsuccess = () => {
        clearTimeout(deadline);
        if (expired) { request.result.close(); return; }
        database = request.result;
        database.onversionchange = () => { database?.close(); database = null; opening = null; };
        resolve(database);
      };
      request.onerror = request.onblocked = () => { expired = true; clearTimeout(deadline); resolve(null); };
    }));
    return opening;
  }

  async function transaction(mode, operation) {
    const db = await open();
    if (!db) return null;
    return bounded(() => new Promise(resolve => {
      const tx = db.transaction('packets', mode);
      let value = null;
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => resolve(null);
      operation(tx.objectStore('packets'), result => { value = result; });
    }));
  }

  return {
    async get(key) {
      return transaction('readwrite', (store, result) => {
        const request = store.get(key);
        request.onsuccess = () => {
          const entry = request.result;
          if (!entry) return;
          if (!(entry.bytes instanceof ArrayBuffer) || entry.bytes.byteLength > maxBytes || now() - entry.createdAt > maxAgeMs) {
            store.delete(key); return;
          }
          store.put({ ...entry, accessedAt: now() });
          result(entry.bytes);
        };
      });
    },
    async put(key, bytes) {
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > maxBytes) return;
      return transaction('readwrite', store => {
        const timestamp = now();
        store.put({ key, bytes, accessedAt: timestamp, createdAt: timestamp });
        const request = store.getAll();
        request.onsuccess = () => {
          const entries = request.result.sort((a, b) => b.accessedAt - a.accessedAt || Number(b.key === key) - Number(a.key === key));
          let retained = 0, usedBytes = 0;
          for (const entry of entries) {
            const size = entry.bytes?.byteLength;
            if (!Number.isFinite(size) || timestamp - entry.createdAt > maxAgeMs || retained >= limit || usedBytes + size > maxBytes) store.delete(entry.key);
            else { retained += 1; usedBytes += size; }
          }
        };
      });
    },
    remove(key) { return transaction('readwrite', store => store.delete(key)); },
  };
}
