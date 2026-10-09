import { createIndexedDatabase } from './indexed-db.js';

// Completed days remain on this device until the browser or user removes them.
// Keep the existing schema, including legacy metadata, without scanning or
// rewriting old packets when a day is read or a new one is added.
export function createBinaryCache({ databaseName, indexedDB: databaseFactory, timeoutMs = 500 } = {}) {
  const database = createIndexedDatabase({ indexedDB: databaseFactory, databaseName, timeoutMs,
    version: 2, stores: ['packets', 'metadata'],
    upgrade(db) {
      for (const name of ['packets', 'metadata']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' });
      }
    },
  });
  return {
    get(key) {
      return database.transaction('readonly', (tx, result) => {
        const request = tx.objectStore('packets').get(key);
        request.onsuccess = () => {
          const bytes = request.result?.bytes;
          if (bytes instanceof ArrayBuffer) result(bytes);
        };
      });
    },
    put(key, bytes) {
      if (!(bytes instanceof ArrayBuffer)) return Promise.resolve(null);
      return database.transaction('readwrite', tx => tx.objectStore('packets').put({ key, bytes }));
    },
    remove(key) {
      return database.transaction('readwrite', tx => {
        tx.objectStore('packets').delete(key);
        tx.objectStore('metadata').delete(key);
      });
    },
  };
}
