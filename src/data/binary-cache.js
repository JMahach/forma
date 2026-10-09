import { createIndexedDatabase } from './indexed-db.js';

// Optional device-local packet cache. Payloads and their small LRU records share
// one transaction; reading or pruning never rewrites other binary packets.
export function createBinaryCache({
  databaseName,
  indexedDB: databaseFactory, capacity = 4, maxBytes = 8 * 1024 * 1024,
  maxAgeMs = 30 * 24 * 60 * 60 * 1000, timeoutMs = 500, now = () => Date.now(),
} = {}) {
  const limit = Math.max(1, Math.floor(capacity));
  const database = createIndexedDatabase({ indexedDB: databaseFactory, databaseName, timeoutMs,
    version: 2, stores: ['packets', 'metadata'],
    upgrade(db, tx) {
      if (!db.objectStoreNames.contains('packets')) db.createObjectStore('packets', { keyPath: 'key' });
      db.createObjectStore('metadata', { keyPath: 'key' });
      // The schema upgrade retains the existing payloads and their expiry.
      const metadata = tx.objectStore('metadata');
      const cursor = tx.objectStore('packets').openCursor();
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        const { key, bytes, createdAt, accessedAt } = cursor.result.value;
        metadata.put({ key, size: bytes?.byteLength, createdAt, accessedAt });
        cursor.result.continue();
      };
    },
  });
  const transaction = operation => database.transaction('readwrite', (tx, result) =>
    operation(tx.objectStore('packets'), tx.objectStore('metadata'), result));

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
