export type BinaryCache = ReturnType<typeof createBinaryCache>;
import { createIndexedDatabase } from './indexed-db.ts';

// Completed days remain on this device until the browser or user removes them.
// Keep the existing schema, including legacy metadata, without scanning or
// rewriting old packets when a day is read or a new one is added.
export function createBinaryCache({ databaseName, indexedDB: databaseFactory, timeoutMs = 500 }: { databaseName?: string; indexedDB?: IDBFactory | null; timeoutMs?: number } = {}) {
  const database = createIndexedDatabase({ indexedDB: databaseFactory, databaseName: databaseName!, timeoutMs,
    version: 2, stores: ['packets', 'metadata'],
    upgrade(db) {
      for (const name of ['packets', 'metadata']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' });
      }
    },
  });
  return {
    get(key: string) {
      return database.transaction<ArrayBuffer>('readonly', (tx, result) => {
        const request = tx.objectStore('packets').get(key);
        request.onsuccess = () => {
          const bytes = request.result?.bytes;
          if (bytes instanceof ArrayBuffer) result(bytes);
        };
      });
    },
    put(key: string, bytes: ArrayBuffer) {
      if (!(bytes instanceof ArrayBuffer)) return Promise.resolve(null);
      return database.transaction('readwrite', tx => tx.objectStore('packets').put({ key, bytes }));
    },
    remove(key: string) {
      return database.transaction('readwrite', tx => {
        tx.objectStore('packets').delete(key);
        tx.objectStore('metadata').delete(key);
      });
    },
  };
}
