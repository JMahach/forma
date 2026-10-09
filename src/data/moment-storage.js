import { mergePackets, packetCatalogue, validPacket } from './moment-packet.js';

// Persistence owns atomic merge and disk eviction. Reads are readonly; small
// usage records are touched in batches without rewriting numeric payloads.
export function createMomentStorage({ indexedDB = globalThis.indexedDB, databaseName = 'forma-moments',
  maxBytes = 256 * 1024 * 1024, catalogueEntries = 8192, timeoutMs = 1000, now = Date.now } = {}) {
  let database = null, opening = null, closed = false;
  function open() {
    if (closed || !indexedDB) return Promise.resolve(null);
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    opening = new Promise(resolve => {
      let request, done = false;
      const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => finish(null), timeoutMs);
      try { request = indexedDB.open(databaseName, 1); } catch { finish(null); return; }
      request.onupgradeneeded = () => {
        if (done || closed) { request.transaction.abort(); return; }
        const db = request.result;
        db.createObjectStore('packets', { keyPath: 'key' });
        const catalogue = db.createObjectStore('catalogue', { keyPath: 'key' });
        catalogue.createIndex('accessedAt', 'accessedAt');
        catalogue.createIndex('full', 'full');
        db.createObjectStore('settings');
      };
      request.onsuccess = () => {
        if (done || closed) { request.result.close(); return; }
        database = request.result;
        database.onversionchange = () => { database.close(); database = null; opening = null; };
        finish(database);
      };
      request.onerror = () => { opening = null; finish(null); };
      request.onblocked = () => finish(null);
    });
    return opening;
  }
  async function transaction(mode, action) {
    const db = await open(); if (!db) return null;
    return new Promise(resolve => {
      let tx, value = null, done = false;
      const finish = result => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
      const timer = setTimeout(() => { finish(null); try { tx?.abort(); } catch {} }, timeoutMs);
      try {
        tx = db.transaction(['packets', 'catalogue', 'settings'], mode);
        tx.oncomplete = () => finish(value); tx.onerror = tx.onabort = () => finish(null);
        action(tx, result => { value = result; });
      } catch { try { tx?.abort(); } catch {} finish(null); }
    });
  }
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
    close() { closed = true; database?.close(); database = null; },
  };
}
