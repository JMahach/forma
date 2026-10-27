import type { Database } from './database.ts';
import type { MAIL_POLICY } from '../mail/policy.ts';
import { JOURNAL_POLICY } from '../journal/policy.ts';

export interface MailReservation {
  id: string; contextId: string; recipient?: string;
  reservedBytes: number; createdAt: number; discardAt: number;
}
export interface MailQueueRecord extends Omit<MailReservation, 'recipient'> {
  recipient: string | null; queueId: string | null; lastAttemptAt: number | null;
  outcome: 'handed_off' | 'rejected' | 'expired' | 'outcome_unknown' | null;
  completedAt: number | null; reason: string | null;
}

const columns = `id TEXT PRIMARY KEY, contextId TEXT NOT NULL,
  recipient TEXT CHECK(recipient IS NULL OR length(CAST(recipient AS BLOB)) <= 1024),
  reservedBytes INTEGER NOT NULL CHECK(reservedBytes > 0), createdAt INTEGER NOT NULL,
  discardAt INTEGER NOT NULL, queueId TEXT UNIQUE, lastAttemptAt INTEGER,
  outcome TEXT CHECK(outcome IN ('handed_off','rejected','expired','outcome_unknown')),
  completedAt INTEGER, reason TEXT CHECK(reason IS NULL OR length(reason) <= 16)`;

/** Metadata only; Postfix owns the single persistent message body. */
export function createMailStorage(db: Database, policy: typeof MAIL_POLICY) {
  db.transaction(() => {
    const existing = db.connection.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mail_queue'").get();
    if (!existing) db.connection.exec(`CREATE TABLE mail_queue (${columns}) STRICT;`);
    else if (!String(existing.sql).includes("'outcome_unknown'")) {
      // SQLite cannot extend a CHECK in place. Preserve every reservation under the same write lock.
      const previous = new Set(db.connection.prepare('PRAGMA table_info(mail_queue)').all().map(row => row.name));
      const fields = ['id','contextId','recipient','reservedBytes','createdAt','discardAt','queueId','lastAttemptAt','outcome','completedAt','reason'];
      db.connection.exec(`CREATE TABLE mail_queue_next (${columns}) STRICT;
        INSERT INTO mail_queue_next (${fields.join(',')}) SELECT ${fields.map(name => previous.has(name) ? name : 'NULL').join(',')} FROM mail_queue;
        DROP TABLE mail_queue; ALTER TABLE mail_queue_next RENAME TO mail_queue;`);
    }
    db.connection.exec(`CREATE INDEX IF NOT EXISTS mail_queue_expiry ON mail_queue(discardAt);
      CREATE INDEX IF NOT EXISTS mail_queue_completed ON mail_queue(completedAt,id) WHERE outcome IS NOT NULL;
      DROP TRIGGER IF EXISTS mail_queue_terminal_bound;
      CREATE TRIGGER mail_queue_terminal_bound AFTER UPDATE OF outcome ON mail_queue
      WHEN NEW.outcome IS NOT NULL AND OLD.outcome IS NULL BEGIN
        DELETE FROM mail_queue WHERE outcome IS NOT NULL AND completedAt <= NEW.completedAt - ${JOURNAL_POLICY.retentionMs};
        DELETE FROM mail_queue WHERE id IN (
          SELECT id FROM mail_queue WHERE outcome IS NOT NULL ORDER BY completedAt DESC,id DESC LIMIT -1 OFFSET ${policy.maxPendingReports}
        );
      END;`);
  });
  return {
    maintain(now: number) {
      db.transaction(() => {
        db.connection.prepare(`DELETE FROM mail_queue WHERE outcome IS NOT NULL
          AND (completedAt IS NULL OR completedAt <= ?)`).run(now - JOURNAL_POLICY.retentionMs);
        db.connection.prepare(`DELETE FROM mail_queue WHERE id IN (
          SELECT id FROM mail_queue WHERE outcome IS NOT NULL ORDER BY completedAt DESC,id DESC LIMIT -1 OFFSET ?
        )`).run(policy.maxPendingReports);
      });
    },
    completed(after?: { completedAt: number; id: string }) {
      const rows = after
        ? db.connection.prepare(`SELECT * FROM mail_queue WHERE outcome IS NOT NULL AND (completedAt,id) > (?,?)
          ORDER BY completedAt,id LIMIT ?`).all(after.completedAt,after.id,policy.reportBatchSize)
        : [];
      return (rows.length ? rows : db.connection.prepare(`SELECT * FROM mail_queue WHERE outcome IS NOT NULL
        ORDER BY completedAt,id LIMIT ?`).all(policy.reportBatchSize)) as unknown as MailQueueRecord[];
    },
    acknowledgeCompleted(row: MailQueueRecord) {
      return db.connection.prepare('DELETE FROM mail_queue WHERE id = ? AND outcome = ? AND completedAt = ?')
        .run(row.id, row.outcome, row.completedAt).changes === 1;
    },
    reserve(row: MailReservation) {
      if (!Number.isSafeInteger(row.reservedBytes) || row.reservedBytes <= 0
        || row.discardAt <= row.createdAt || row.discardAt - row.createdAt > policy.lifetimeMs
        || row.recipient !== undefined && Buffer.byteLength(row.recipient, 'utf8') > 1024) {
        throw new TypeError('Invalid mail reservation');
      }
      return db.transaction(() => {
        const usage = db.connection.prepare('SELECT count(*) AS count, coalesce(sum(reservedBytes), 0) AS bytes FROM mail_queue WHERE outcome IS NULL').get()!;
        if (Number(usage.count) >= policy.maxMessages || Number(usage.bytes) + row.reservedBytes > policy.maxBytes) return false;
        db.connection.prepare('INSERT INTO mail_queue (id,contextId,recipient,reservedBytes,createdAt,discardAt) VALUES (?,?,?,?,?,?)').run(
          row.id, row.contextId, row.recipient ?? null, row.reservedBytes, row.createdAt, row.discardAt);
        return true;
      });
    },
    bind(id: string, queueId: string) { db.connection.prepare('UPDATE mail_queue SET queueId = ? WHERE id = ? AND outcome IS NULL').run(queueId, id); },
    completeUnknownBefore(id: string, deadline: number, completedAt: number) {
      return db.connection.prepare(`UPDATE mail_queue SET outcome='outcome_unknown', reason='outcome_unknown', completedAt=?
        WHERE id=? AND outcome IS NULL AND discardAt<=?`).run(completedAt,id,deadline).changes === 1;
    },
    remove(id: string) { db.connection.prepare('DELETE FROM mail_queue WHERE id = ?').run(id); },
    rows() { return db.connection.prepare('SELECT * FROM mail_queue WHERE outcome IS NULL ORDER BY createdAt, id').all() as unknown as MailQueueRecord[]; },
    claimAttempt(id: string, now: number) {
      return db.connection.prepare(`UPDATE mail_queue SET lastAttemptAt = ? WHERE id = ? AND discardAt > ?
        AND outcome IS NULL AND queueId IS NOT NULL AND (lastAttemptAt IS NULL OR lastAttemptAt <= ?)`)
        .run(now, id, now, now - policy.retryMs).changes === 1;
    },
  };
}
