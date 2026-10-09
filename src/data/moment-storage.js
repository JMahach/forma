import { createIndexedDatabase } from './indexed-db.js';
import { mergePackets, packetCatalogue, validPacket } from './moment-packet.js';

// Persistence owns atomic merge and disk eviction. Reads are readonly; small
// usage records are touched in batches without rewriting numeric payloads.
export function createMomentStorage({ indexedDB = globalThis.indexedDB, databaseName = 'forma-moments',
  maxBytes = 256 * 1024 * 1024, catalogueEntries = 8192, timeoutMs = 1000, now = Date.now } = {}) {
  const { transaction, close } = createIndexedDatabase({ indexedDB, databaseName, timeoutMs,
    version: 1, stores: ['packets', 'catalogue', 'settings'],
    upgrade(db) {
      db.createObjectStore('packets', { keyPath: 'key' });
      const catalogue = db.createObjectStore('catalogue', { keyPath: 'key' });
      catalogue.createIndex('accessedAt', 'accessedAt');
      catalogue.createIndex('full', 'full');
      db.createObjectStore('settings');
    },
  });
  return {
    catalogue() { return transaction('readonly', (tx, result) => {
      const store = tx.objectStore('catalogue'), entries = new Map();
      const days = store.index('full').getAll(1), recent = store.index('accessedAt').openCursor(null, 'prev');
      let count = 0;
      days.onsuccess = () => { for (const entry of days.result) entries.set(entry.key, entry); result([...entries.values()]); };
      recent.onsuccess = () => {
        const cursor = recent.result;
        if (!cursor || count++ >= catalogueEntries) { result([...entries.values()]); return; }
        entries.set(cursor.value.key, cursor.value); cursor.continue();
      };
    }); },
    read(key) { return transaction('readonly', (tx, result) => {
      const read = tx.objectStore('packets').get(key);
      read.onsuccess = () => result(validPacket(read.result, key) ? read.result : null);
    }); },
    write(packets, touches = []) {
      const updated = new Set(packets.map(packet => packet.key));
      touches = touches.filter(key => !updated.has(key));
      return transaction('readwrite', (tx, result) => {
        const payload = tx.objectStore('packets'), catalogue = tx.objectStore('catalogue'), settings = tx.objectStore('settings');
        const total = settings.get('bytes'), changed = [], removed = []; let bytes = 0, remaining = packets.length + touches.length;
        function evict() {
          const cursor = catalogue.index('accessedAt').openCursor();
          cursor.onsuccess = () => {
            const item = cursor.result;
            if (bytes <= maxBytes || !item) { settings.put(bytes, 'bytes'); result({ changed, removed }); return; }
            bytes -= item.value.size; removed.push(item.value.key); payload.delete(item.value.key); item.delete(); item.continue();
          };
        }
        const complete = () => { if (--remaining === 0) evict(); };
        total.onsuccess = () => {
          bytes = Number(total.result) || 0;
          if (!remaining) { result({ changed, removed }); return; }
          for (const packet of packets) {
            const read = payload.get(packet.key), old = catalogue.get(packet.key);
            old.onsuccess = () => {
              const merged = mergePackets(validPacket(read.result, packet.key) ? read.result : null, packet);
              const entry = packetCatalogue(merged, now());
              bytes += entry.size - (old.result?.size || 0);
              payload.put(merged); catalogue.put(entry); changed.push(entry); complete();
            };
          }
          for (const key of touches) {
            const read = catalogue.get(key);
            read.onsuccess = () => { if (read.result) catalogue.put({ ...read.result, accessedAt: now() }); complete(); };
          }
        };
      });
    },
    close,
  };
}
