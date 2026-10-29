import type { Database } from './database.ts';

export interface AccountRecord { id: number; email: string; telegramHandle: string | null; telegramId: string | null }
export interface AttemptRecord {
  id: string; email: string | null; bindingHash: string; createdAt: number; expiresAt: number;
  previousSessionId: string | null; codeId: string | null; codeHash: string | null;
  codeExpiresAt: number; resendAt: number; mailExpiresAt: number;
  sessionHash: string | null;
  telegramNonce: string | null; telegramId: string | null; telegramHandle: string | null; targetAccountId: number | null;
}
export interface SessionRecord {
  id: string; accountId: number; secretHash: string; createdAt: number; expiresAt: number;
  bindingHash: string | null; bindingExpiresAt: number;
}

export function createAccountStorage(db: Database) {
  const sql = db.connection;
  const attemptColumns = `id TEXT PRIMARY KEY, email TEXT, bindingHash TEXT NOT NULL,
    createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, previousSessionId TEXT,
    codeId TEXT UNIQUE, codeHash TEXT, codeExpiresAt INTEGER NOT NULL,
    resendAt INTEGER NOT NULL, mailExpiresAt INTEGER NOT NULL, sessionHash TEXT,
    telegramNonce TEXT, telegramId TEXT, telegramHandle TEXT, targetAccountId INTEGER REFERENCES accounts(id)`;
  db.transaction(() => {
    sql.exec(`CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, telegramHandle TEXT, telegramId TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS account_attempts (${attemptColumns}) STRICT;
    CREATE TABLE IF NOT EXISTS account_sessions (
      id TEXT PRIMARY KEY, accountId INTEGER NOT NULL REFERENCES accounts(id),
      secretHash TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
      bindingHash TEXT, bindingExpiresAt INTEGER NOT NULL
    ) STRICT;`);
    if (!sql.prepare('PRAGMA table_info(accounts)').all().some(column => column.name === 'telegramId')) {
      sql.exec('ALTER TABLE accounts ADD COLUMN telegramId TEXT');
    }
    const columns = sql.prepare('PRAGMA table_info(account_attempts)').all();
    if (columns.some(column => column.name === 'email' && column.notnull === 1)) {
      // Preserve unfinished email attempts while allowing Telegram to precede the email step.
      sql.exec(`CREATE TABLE account_attempts_next (${attemptColumns}) STRICT;
        INSERT INTO account_attempts_next (id,email,bindingHash,createdAt,expiresAt,previousSessionId,
          codeId,codeHash,codeExpiresAt,resendAt,mailExpiresAt,sessionHash)
        SELECT id,email,bindingHash,createdAt,expiresAt,previousSessionId,
          codeId,codeHash,codeExpiresAt,resendAt,mailExpiresAt,sessionHash FROM account_attempts;
        DROP TABLE account_attempts;
        ALTER TABLE account_attempts_next RENAME TO account_attempts;`);
    } else {
      for (const [name, type] of [['telegramNonce','TEXT'], ['telegramId','TEXT'], ['telegramHandle','TEXT'],
        ['targetAccountId','INTEGER REFERENCES accounts(id)']] as const) {
        if (!columns.some(column => column.name === name)) sql.exec(`ALTER TABLE account_attempts ADD COLUMN ${name} ${type}`);
      }
    }
    sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS accounts_telegram ON accounts(telegramId);
      CREATE INDEX IF NOT EXISTS account_attempts_expiry ON account_attempts(expiresAt);
      CREATE INDEX IF NOT EXISTS account_sessions_expiry ON account_sessions(expiresAt);`);
  });
  const attempt = sql.prepare('SELECT * FROM account_attempts WHERE id = ?');
  const session = sql.prepare('SELECT * FROM account_sessions WHERE id = ?');
  const account = sql.prepare('SELECT * FROM accounts WHERE id = ?');
  const saveAttempt = sql.prepare(`INSERT INTO account_attempts
    (id,email,bindingHash,createdAt,expiresAt,previousSessionId,codeId,codeHash,codeExpiresAt,resendAt,mailExpiresAt,sessionHash,
      telegramNonce,telegramId,telegramHandle,targetAccountId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET email=excluded.email, codeId=excluded.codeId, codeHash=excluded.codeHash,
    codeExpiresAt=excluded.codeExpiresAt, resendAt=excluded.resendAt,
    mailExpiresAt=excluded.mailExpiresAt, sessionHash=excluded.sessionHash,
    telegramNonce=excluded.telegramNonce,telegramId=excluded.telegramId,telegramHandle=excluded.telegramHandle`);
  return {
    attempt(id: string) { return attempt.get(id) as unknown as AttemptRecord | undefined; },
    session(id: string) { return session.get(id) as unknown as SessionRecord | undefined; },
    account(id: number) { return account.get(id) as unknown as AccountRecord; },
    accountByTelegram(id: string) {
      return sql.prepare('SELECT * FROM accounts WHERE telegramId = ?').get(id) as unknown as AccountRecord | undefined;
    },
    linkTelegram(accountId: number, id: string, handle: string | null) {
      return sql.prepare(`UPDATE accounts SET telegramId = ?, telegramHandle = ?
        WHERE id = ? AND (telegramId IS NULL OR telegramId = ?)`).run(id, handle, accountId, id).changes === 1;
    },
    ensureAccount(email: string) {
      sql.prepare('INSERT INTO accounts(email) VALUES (?) ON CONFLICT(email) DO NOTHING').run(email);
      return sql.prepare('SELECT * FROM accounts WHERE email = ?').get(email) as unknown as AccountRecord;
    },
    saveAttempt(row: AttemptRecord) {
      saveAttempt.run(row.id, row.email, row.bindingHash, row.createdAt, row.expiresAt, row.previousSessionId,
        row.codeId, row.codeHash, row.codeExpiresAt, row.resendAt, row.mailExpiresAt, row.sessionHash,
        row.telegramNonce, row.telegramId, row.telegramHandle, row.targetAccountId);
    },
    saveSession(row: SessionRecord) {
      sql.prepare('INSERT INTO account_sessions VALUES (?,?,?,?,?,?,?)').run(row.id, row.accountId,
        row.secretHash, row.createdAt, row.expiresAt, row.bindingHash, row.bindingExpiresAt);
    },
    touchSession(id: string, expiresAt: number) { sql.prepare('UPDATE account_sessions SET expiresAt = ? WHERE id = ? AND expiresAt IS NOT ?').run(expiresAt, id, expiresAt); },
    deleteAttempt(id: string) { sql.prepare('DELETE FROM account_attempts WHERE id = ?').run(id); },
    deleteSession(id: string) { sql.prepare('DELETE FROM account_sessions WHERE id = ?').run(id); },
    mailIsCurrent(id: string, now: number) {
      return !!sql.prepare(`SELECT 1 FROM account_attempts WHERE codeId = ? AND codeHash IS NOT NULL
        AND sessionHash IS NULL AND mailExpiresAt > ? AND codeExpiresAt > ? AND expiresAt > ?`).get(id, now, now, now);
    },
    cleanup(now: number) {
      sql.prepare('DELETE FROM account_attempts WHERE expiresAt <= ?').run(now);
      sql.prepare('DELETE FROM account_sessions WHERE expiresAt <= ?').run(now);
      sql.prepare('UPDATE account_attempts SET codeHash = NULL WHERE codeExpiresAt <= ? AND codeHash IS NOT NULL').run(now);
      sql.prepare('UPDATE account_sessions SET bindingHash = NULL WHERE bindingExpiresAt <= ? AND bindingHash IS NOT NULL').run(now);
    },
  };
}
