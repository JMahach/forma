import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseJournalEvent, type JournalEvent } from './events.ts';
import { canonicalJSON, JOURNAL_POLICY } from './policy.ts';

const MiB = 1024 * 1024, pageBytes = 4096, applicationId = 0x464d4246;
export const MAIL_BUFFER_LIMITS = Object.freeze({
  reservedBytes: 8 * MiB, databaseBytes: 2 * MiB, rollbackBytes: 3 * MiB,
  // macOS allocates ahead of file length: reserve 2 MiB for at most 1 MiB of SQLite pages.
  databasePages: MiB / pageBytes,
  // Covers the entire bounded pager plus serialized batches, strings and temporary copies.
  ownedBytesReserved: 3 * MiB, maxBatchBytes: 128 * 1024,
  maxEventBytes: 2048, maxRecords: 2048, batchSize: 32,
});
export type MailBufferedResult = {status: 'buffered'} | {status: 'invalid' | 'conflict' | 'full' | 'retryable'};
const terminal = new Set(['mail_handed_off','mail_rejected','mail_expired','mail_outcome_unknown']);
const hash = (payload: string) => createHash('sha256').update(payload).digest('hex');
interface Pending { eventId: string; payload: string; hash: string; occurredAt: number }

/** Temporary delivery responsibility, not final journal acceptance. One owner/connection, no shared WAL. */
export function openMailBuffer({filename: requestedFilename, now = Date.now}: {filename: string; now?: () => number}) {
  const limits = MAIL_BUFFER_LIMITS, directory = path.dirname(path.resolve(requestedFilename));
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const directoryInfo = fs.lstatSync(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.mode & 0o077) throw new Error('Mail buffer directory must be private');
  const filename = path.join(fs.realpathSync(directory), path.basename(requestedFilename));
  let closed = false;
  let lastBatch: {occurredAt: number; eventId: string} | undefined;
  const fileBytes = (suffix: string) => {
    try {
      const info = fs.lstatSync(filename + suffix);
      if (!info.isFile() || info.mode & 0o077) throw new Error('Mail buffer files must be private regular files');
      return Math.max(info.size, info.blocks * 512);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  };
  function physicalUsage() {
    const databaseBytes = fileBytes(''), rollbackBytes = fileBytes('-journal');
    if (fileBytes('-wal') || fileBytes('-shm')) throw new Error('Mail buffer must not use WAL');
    if (databaseBytes > limits.databaseBytes || rollbackBytes > limits.rollbackBytes) throw new Error('Mail buffer files exceed their reservation');
    return {databaseBytes, rollbackBytes, diskBytes: databaseBytes + rollbackBytes,
      ownedBytesReserved: limits.ownedBytesReserved, reservedBytes: limits.reservedBytes};
  }
  physicalUsage();
  try { const fd = fs.openSync(filename, 'wx', 0o600); fs.closeSync(fd); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const directoryFd = fs.openSync(directory, 'r');
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(filename, {timeout: 0});
    const existingId = Number(database.prepare('PRAGMA application_id').get()!.application_id);
    const pages = Number(database.prepare('PRAGMA page_count').get()!.page_count);
    if (existingId !== applicationId && (existingId !== 0 || pages !== 0)) throw new Error('Not a mail delivery buffer');
    if (pages && Number(database.prepare('PRAGMA page_size').get()!.page_size) !== pageBytes) throw new Error('Unsupported mail buffer page size');
    // No ATTACH, savepoints, VACUUM or spilling: a rollback contains each original page at most once.
    // EXTRA supplies the strongest rollback durability; sync the directory explicitly as well.
    // EXCLUSIVE retains its journal, so journal_size_limit=0 removes old private pages after commit.
    database.exec(`PRAGMA page_size=${pageBytes}; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA;
      PRAGMA fullfsync=ON; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_size_limit=0; PRAGMA cache_spill=OFF;
      PRAGMA cache_size=${limits.databasePages}; PRAGMA mmap_size=0;
      PRAGMA temp_store=MEMORY; PRAGMA secure_delete=ON; PRAGMA auto_vacuum=NONE;
      PRAGMA max_page_count=${limits.databasePages};
      PRAGMA application_id=${applicationId};
      CREATE TABLE IF NOT EXISTS pending (
        eventId TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${limits.maxEventBytes}),
        hash TEXT NOT NULL, occurredAt INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS pending_age ON pending(occurredAt,eventId);`);
    if (database.prepare('PRAGMA journal_mode').get()!.journal_mode !== 'delete'
      || database.prepare('PRAGMA synchronous').get()!.synchronous !== 3
      || Number(database.prepare('PRAGMA max_page_count').get()!.max_page_count) !== limits.databasePages) {
      throw new Error('Mail buffer durability or size policy unavailable');
    }
    fs.fsyncSync(directoryFd); physicalUsage();
  } catch (error) { database!?.close(); fs.closeSync(directoryFd); throw error; }
  function clock() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8.64e15) throw new Error('Invalid mail buffer clock');
    return value;
  }
  function transaction<T>(run: () => T): T {
    if (closed) throw new Error('Mail buffer is closed');
    physicalUsage();
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      physicalUsage();
      database.exec('COMMIT');
      fs.fsyncSync(directoryFd);
      return result;
    } catch (error) {
      // SQLITE_FULL may have rolled back itself. A failed commit is never acknowledged.
      try { database.exec('ROLLBACK'); } catch { /* Already rolled back or committed. */ }
      throw error;
    }
  }
  function encode(input: JournalEvent): Pending | null {
    const event = parseJournalEvent(input);
    if (!event || !terminal.has(event.event)) return null;
    const payload = canonicalJSON({...event});
    if (Buffer.byteLength(payload) > limits.maxEventBytes) return null;
    return {eventId: event.eventId, payload, hash: hash(payload), occurredAt: event.occurredAt};
  }
  const api = {
    stage(input: JournalEvent): MailBufferedResult {
      if (closed) return {status: 'retryable'};
      try {
        const value = encode(input), time = clock();
        if (!value || value.occurredAt > time || value.occurredAt <= time - JOURNAL_POLICY.retentionMs) return {status: 'invalid'};
        return transaction((): MailBufferedResult => {
          database.prepare('DELETE FROM pending WHERE occurredAt <= ?').run(time - JOURNAL_POLICY.retentionMs);
          const existing = database.prepare('SELECT hash,payload FROM pending WHERE eventId=?').get(value.eventId);
          if (existing) return {status: existing.hash === value.hash && existing.payload === value.payload ? 'buffered' : 'conflict'};
          const count = Number(database.prepare('SELECT count(*) AS n FROM pending').get()!.n);
          if (count >= limits.maxRecords) return {status: 'full'};
          database.prepare('INSERT INTO pending(eventId,payload,hash,occurredAt) VALUES (?,?,?,?)')
            .run(value.eventId, value.payload, value.hash, value.occurredAt);
          return {status: 'buffered'};
        });
      } catch (error) { return {status: (error as {errcode?: number}).errcode === 13 ? 'full' : 'retryable'}; }
    },
    batch(): JournalEvent[] {
      if (closed) return [];
      api.maintain();
      const following = lastBatch ? database.prepare(`SELECT eventId,payload,hash,occurredAt FROM pending
        WHERE (occurredAt,eventId)>(?,?) ORDER BY occurredAt,eventId LIMIT ?`)
        .all(lastBatch.occurredAt,lastBatch.eventId,limits.batchSize) : [];
      const rows = (following.length ? following : database.prepare('SELECT eventId,payload,hash,occurredAt FROM pending ORDER BY occurredAt,eventId LIMIT ?')
        .all(limits.batchSize)) as unknown as Pending[];
      let bytes = 0;
      const result = rows.map(row => {
        bytes += Buffer.byteLength(row.payload);
        if (bytes > limits.maxBatchBytes || hash(row.payload) !== row.hash) throw new Error('Invalid mail buffer payload');
        const event = parseJournalEvent(JSON.parse(row.payload));
        if (!event || !terminal.has(event.event) || event.eventId !== row.eventId || event.occurredAt !== row.occurredAt) {
          throw new Error('Invalid mail buffer event');
        }
        return event;
      });
      const last = rows.at(-1);
      lastBatch = last && {occurredAt: last.occurredAt, eventId: last.eventId};
      return result;
    },
    acknowledge(input: JournalEvent): boolean {
      if (closed) return false;
      try {
        const value = encode(input);
        return !!value && transaction(() => database.prepare('DELETE FROM pending WHERE eventId=? AND hash=? AND payload=? AND occurredAt=?')
          .run(value.eventId,value.hash,value.payload,value.occurredAt).changes === 1);
      } catch { return false; }
    },
    maintain() {
      if (closed) throw new Error('Mail buffer is closed');
      physicalUsage();
      const cutoff = clock() - JOURNAL_POLICY.retentionMs;
      // The single connection owner cannot gain an expired row between this read and deletion.
      if (!database.prepare('SELECT 1 FROM pending WHERE occurredAt <= ? LIMIT 1').get(cutoff)) return 0;
      return transaction(() => database.prepare('DELETE FROM pending WHERE occurredAt <= ?').run(cutoff).changes);
    },
    usage() {
      return {...physicalUsage(), records: closed ? 0 : Number(database.prepare('SELECT count(*) AS n FROM pending').get()!.n)};
    },
    close() { if (closed) return; closed = true; try { database.close(); } finally { fs.closeSync(directoryFd); } },
  };
  return api;
}
