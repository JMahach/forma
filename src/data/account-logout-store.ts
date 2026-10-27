import { createIndexedDatabase } from './indexed-db.ts';

/** The accepted logout exception: public context IDs only, until server acknowledgment. */
export function createAccountLogoutStore({ indexedDB, databaseName = 'forma-account' }: { indexedDB?: IDBFactory | null; databaseName?: string } = {}) {
  const database = createIndexedDatabase({ indexedDB, databaseName, version: 1, stores: ['pending-logout'],
    upgrade(db) { if (!db.objectStoreNames.contains('pending-logout')) db.createObjectStore('pending-logout', { keyPath: 'id' }); } });
  const pending = new Set<string>();
  const failed = () => Object.assign(new Error('account_storage_unavailable'), { code: 'account_storage_unavailable' });
  return {
    async list(): Promise<string[]> {
      const stored = await database.transaction<string[]>('readonly', (tx, result) => {
        const request = tx.objectStore('pending-logout').getAllKeys();
        request.onsuccess = () => result(request.result.filter((id): id is string => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)));
      });
      if (!stored) throw failed();
      return [...new Set([...stored, ...pending])].sort();
    },
    async add(ids: readonly string[]) {
      if (ids.some(id => !/^[a-f0-9]{32}$/.test(id))) throw failed();
      for (const id of ids) pending.add(id);
      if (!pending.size) return;
      const saved = await database.transaction<boolean>('readwrite', (tx, result) => {
        for (const id of pending) tx.objectStore('pending-logout').put({ id });
        result(true);
      });
      if (!saved) throw failed();
    },
    async remove(id: string) {
      const removed = await database.transaction<boolean>('readwrite', (tx, result) => {
        tx.objectStore('pending-logout').delete(id); result(true);
      });
      if (!removed) throw failed();
      pending.delete(id);
    },
    close: () => database.close(),
  };
}
export type AccountLogoutStore = ReturnType<typeof createAccountLogoutStore>;
