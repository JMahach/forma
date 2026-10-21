interface IndexedDatabaseOptions {
  databaseName: string;
  version: number;
  stores: string[];
  upgrade: (database: IDBDatabase, transaction: IDBTransaction) => void;
  indexedDB?: IDBFactory | null;
  timeoutMs?: number;
}

// Connection and transaction lifetime for optional browser storage. Each
// repository owns its schema and retention rules; storage failure is a miss.
export function createIndexedDatabase({ databaseName, version, stores, upgrade,
  indexedDB: factory, timeoutMs = 1000 }: IndexedDatabaseOptions) {
  let database: IDBDatabase | null = null, opening: Promise<IDBDatabase | null> | null = null, closed = false;
  function open(): Promise<IDBDatabase | null> {
    if (closed) return Promise.resolve(null);
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    let request: IDBOpenDBRequest;
    try {
      const indexedDB = factory === undefined ? globalThis.indexedDB : factory;
      if (!indexedDB) return Promise.resolve(null);
      request = indexedDB.open(databaseName, version);
    } catch { return Promise.resolve(null); }
    opening = new Promise<IDBDatabase | null>(resolve => {
      let done = false;
      const finish = (value: IDBDatabase | null) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => finish(null), timeoutMs);
      request.onupgradeneeded = () => {
        if (done || closed) { request.transaction!.abort(); return; }
        try { upgrade(request.result, request.transaction!); }
        catch { request.transaction!.abort(); finish(null); }
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
    async transaction<T = unknown>(mode: IDBTransactionMode, action: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T | null> {
      const db = await open(); if (!db || closed) return null;
      return new Promise<T | null>(resolve => {
        let tx: IDBTransaction | undefined, value: T | null = null, done = false;
        const finish = (result: T | null) => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
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
