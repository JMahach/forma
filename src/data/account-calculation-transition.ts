import { migrateCalculationMetadata } from '../../shared/calculation-storage-transition.ts';

/** Run inside the account database's schema upgrade, never alongside old
 * writers. The caller owns versionchange/blocked; abort preserves old data. */
export function migrateAccountCalculations(transaction:IDBTransaction) {
  const request = transaction.objectStore('charts').openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    try {
      const migrated = migrateCalculationMetadata(cursor.value);
      if (migrated !== cursor.value) cursor.update(migrated);
      cursor.continue();
    } catch { transaction.abort(); }
  };
}
