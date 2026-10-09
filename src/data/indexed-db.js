// Connection and transaction lifetime for optional browser storage. Each
// repository owns its schema and retention rules; storage failure is a miss.
export function createIndexedDatabase({ databaseName, version, stores, upgrade,
  indexedDB: factory, timeoutMs = 1000 }) {
  let database = null, opening = null, closed = false;
  function open() {
    if (closed) return Promise.resolve(null);
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    let request;
    try {
      const indexedDB = factory === undefined ? globalThis.indexedDB : factory;
      if (!indexedDB) return Promise.resolve(null);
      request = indexedDB.open(databaseName, version);
    } catch { return Promise.resolve(null); }
    opening = new Promise(resolve => {
      let done = false;
      const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => finish(null), timeoutMs);
      request.onupgradeneeded = () => {
        if (done || closed) { request.transaction.abort(); return; }
        try { upgrade(request.result, request.transaction); }
        catch { request.transaction.abort(); finish(null); }
      };
      request.onsuccess = () => {
        opening = null;
        const db = request.result;
        if (done || closed) { db.close(); return; }
        database = db;
        const forget = () => { if (database === db) database = null; };
        db.onclose = forget;
        db.onversionchange = () => { db.close(); forget(); };
        finish(db);
      };
      request.onerror = () => { opening = null; finish(null); };
      // The browser cannot cancel open(). Keep a settled miss until its native
      // request ends, so retries cannot accumulate blocked connections.
      request.onblocked = () => finish(null);
    });
    return opening;
  }
  return {
    async transaction(mode, action) {
      const db = await open(); if (!db || closed) return null;
      return new Promise(resolve => {
        let tx, value = null, done = false;
        const finish = result => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
        const timer = setTimeout(() => { finish(null); try { tx?.abort(); } catch {} }, timeoutMs);
        try {
          tx = db.transaction(stores, mode);
          tx.oncomplete = () => finish(value); tx.onerror = tx.onabort = () => finish(null);
          action(tx, result => { value = result; });
        } catch { try { tx?.abort(); } catch {} finish(null); }
      });
    },
    close() { closed = true; database?.close(); database = null; },
  };
}
