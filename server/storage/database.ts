import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

export interface Database {
  connection: DatabaseSync;
  transaction<T>(run: () => T): T;
  close(): void;
}

/** The physical database is shared; services own the meaning of their records. */
export function openDatabase(filename: string): Database {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const connection = new DatabaseSync(filename, { timeout: 5000 });
  try {
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    connection.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON;');
  } catch (error) { connection.close(); throw error; }
  let depth = 0;
  return {
    connection,
    transaction<T>(run: () => T): T {
      const savepoint = `forma_${depth++}`;
      const outer = depth === 1;
      try {
        connection.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
        try {
          const result = run();
          if (result && typeof (result as { then?: unknown }).then === 'function') {
            throw new TypeError('Database transactions must be synchronous');
          }
          connection.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`);
          return result;
        } catch (error) {
          connection.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
          throw error;
        }
      } finally { depth--; }
    },
    close() { connection.close(); },
  };
}
