// Optional device-local packet cache. Payloads and their small LRU records share
// one transaction; reading or pruning never rewrites other binary packets.
export function createBinaryCache({
  databaseName,
  indexedDB: databaseFactory, capacity = 4, maxBytes = 8 * 1024 * 1024,
  maxAgeMs = 30 * 24 * 60 * 60 * 1000, timeoutMs = 500, now = () => Date.now(),
} = {}) {
  const limit = Math.max(1, Math.floor(capacity));
  let database = null, opening = null;

  function open() {
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    let request;
    try {
      const indexedDB = databaseFactory === undefined ? globalThis.indexedDB : databaseFactory;
      if (!indexedDB) return Promise.resolve(null);
      request = indexedDB.open(databaseName, 2);
    } catch { return Promise.resolve(null); }
    opening = new Promise(resolve => {
      let done = false;
      const finish = value => {
        if (done) return;
        done = true; clearTimeout(deadline); resolve(value);
      };
      const deadline = setTimeout(() => finish(null), timeoutMs);
      request.onupgradeneeded = () => {
        if (done) { request.transaction.abort(); return; }
        const db = request.result;
        if (!db.objectStoreNames.contains('packets')) db.createObjectStore('packets', { keyPath: 'key' });
        db.createObjectStore('metadata', { keyPath: 'key' });
        // One-time migration runs inside the version upgrade transaction.
        // Keep original payloads and creation times, including their expiry.
        const metadata = request.transaction.objectStore('metadata');
        const cursor = request.transaction.objectStore('packets').openCursor();
        cursor.onsuccess = () => {
          if (!cursor.result) return;
          const { key, bytes, createdAt, accessedAt } = cursor.result.value;
          metadata.put({ key, size: bytes?.byteLength, createdAt, accessedAt });
          cursor.result.continue();
        };
      };
      request.onsuccess = () => {
        opening = null;
        if (done) { request.result.close(); return; }
        database = request.result;
        database.onversionchange = () => { database?.close(); database = null; };
        finish(database);
      };
      request.onerror = () => { opening = null; finish(null); };
      // A blocked/timed-out open cannot be cancelled. Keep its resolved miss
      // until success/error so repeated cache misses cannot pile up requests.
      request.onblocked = () => finish(null);
    });
    return opening;
  }

  async function transaction(operation) {
    const db = await open();
    if (!db) return null;
    return new Promise(resolve => {
      let tx, value = null, done = false;
      const finish = result => {
        if (done) return;
        done = true; clearTimeout(deadline); resolve(result);
      };
      const deadline = setTimeout(() => {
        finish(null);
        try { tx?.abort(); } catch { /* It may have completed at the deadline. */ }
      }, timeoutMs);
      try {
        tx = db.transaction(['packets', 'metadata'], 'readwrite');
        tx.oncomplete = () => finish(value);
        tx.onerror = tx.onabort = () => finish(null);
        operation(tx.objectStore('packets'), tx.objectStore('metadata'), result => { value = result; });
      } catch {
        try { tx?.abort(); } catch { /* Optional storage cannot block loading. */ }
        finish(null);
      }
    });
  }

  const valid = (entry, timestamp) => entry && Number.isSafeInteger(entry.size) && entry.size >= 0
    && entry.size <= maxBytes && Number.isFinite(entry.createdAt) && Number.isFinite(entry.accessedAt)
    && timestamp - entry.createdAt <= maxAgeMs;
  const remove = (packets, metadata, key) => { packets.delete(key); metadata.delete(key); };

  return {
    get(key) {
      return transaction((packets, metadata, result) => {
        const request = metadata.get(key);
        request.onsuccess = () => {
          const entry = request.result, timestamp = now();
          if (!valid(entry, timestamp)) { remove(packets, metadata, key); return; }
          const payload = packets.get(key);
          payload.onsuccess = () => {
            const bytes = payload.result?.bytes;
            if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== entry.size) { remove(packets, metadata, key); return; }
            metadata.put({ ...entry, accessedAt: timestamp });
            result(bytes);
          };
        };
      });
    },
    async put(key, bytes) {
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > maxBytes) return;
      return transaction((packets, metadata) => {
        const timestamp = now();
        packets.put({ key, bytes });
        metadata.put({ key, size: bytes.byteLength, accessedAt: timestamp, createdAt: timestamp });
        const request = metadata.getAll();
        request.onsuccess = () => {
          const entries = request.result.sort((a, b) => b.accessedAt - a.accessedAt || Number(b.key === key) - Number(a.key === key));
          let retained = 0, usedBytes = 0;
          for (const entry of entries) {
            if (!valid(entry, timestamp) || retained >= limit || usedBytes + entry.size > maxBytes) remove(packets, metadata, entry.key);
            else { retained += 1; usedBytes += entry.size; }
          }
        };
      });
    },
    remove(key) { return transaction((packets, metadata) => remove(packets, metadata, key)); },
  };
}
