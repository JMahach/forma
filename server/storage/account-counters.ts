import type { Database } from './database.ts';

export interface AccountCounter {
  key: string;
  count: number;
  started_at: number;
  expires_at: number;
  blocked_until: number;
}
export function createAccountCounters(db: Database) {
  db.connection.exec(`CREATE TABLE IF NOT EXISTS auth_counters (
    key TEXT PRIMARY KEY, count INTEGER NOT NULL, started_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, blocked_until INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS auth_counters_expiry ON auth_counters(expires_at);`);
  const select = db.connection.prepare('SELECT * FROM auth_counters WHERE key = ? AND expires_at > ?');
  const write = db.connection.prepare(`INSERT INTO auth_counters VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET count=excluded.count, started_at=excluded.started_at,
      expires_at=excluded.expires_at, blocked_until=excluded.blocked_until`);
  const cleanup = db.connection.prepare('DELETE FROM auth_counters WHERE expires_at <= ?');
  return {
    read(id: string, now: number) { return select.get(id, now) as unknown as AccountCounter | undefined; },
    save(value: AccountCounter) { write.run(value.key, value.count, value.started_at, value.expires_at, value.blocked_until); },
    cleanup(now: number) { cleanup.run(now); },
  };
}
