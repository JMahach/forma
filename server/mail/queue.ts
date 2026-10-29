import type { Database } from '../storage/database.ts';
import { createMailStorage } from '../storage/mail-queue.ts';
import type { CodeMail, CodeMailQueue } from './code-mail.ts';
import type { PostfixQueue, PostfixEntry } from './postfix.ts';
import { renderCodeMessage } from './code-message.ts';
import { MAIL_POLICY as policy } from './policy.ts';

export interface MailEvent {
  event: string; codeId?: string; contextId?: string; eventId?: string; occurredAt?: number;
  recipient?: string; reason?: string;
}
/** True acknowledges final durable journal acceptance, never merely an attempted write. */
export type MailTerminalHandoff = (event: MailEvent) => {status: 'buffered' | 'unavailable'}
  | Promise<{status: 'buffered' | 'unavailable'}>;
export type MailEventReport = (event: MailEvent) => void | boolean | Promise<void | boolean>;

/** Serialises queue mutations; account policy remains the authority on code validity. */
export function createCodeMailQueue({ database, postfix, isCurrent, now = Date.now, report = () => {}, handoffTerminal }: {
  database: Database; postfix: PostfixQueue; isCurrent: (codeId: string) => boolean;
  now?: () => number; report?: MailEventReport; handoffTerminal?: MailTerminalHandoff;
}) {
  const storage = createMailStorage(database, policy);
  let tail: Promise<unknown> = Promise.resolve(), closed = false, timer: NodeJS.Timeout | undefined;
  let draining: Promise<void> | undefined;
  let queuedMaintenance: Promise<PostfixEntry[]> | undefined;
  let lastReported: { completedAt: number; id: string } | undefined;
  const emit = async (event: MailEvent) => { try { return await report(event) === true; } catch { return false; } };
  function serial<T>(run: () => Promise<T>, maintenance = false): Promise<T> {
    if (closed) return Promise.reject(new Error('Mail queue is closed'));
    // A command is an ordering boundary: a later tick must observe it.
    if (!maintenance) queuedMaintenance = undefined;
    const task = tail.then(run); tail = task.catch(() => {}); return task;
  }
  async function attempt(entry: PostfixEntry) {
    if (!entry.codeId || entry.discardAt <= now() || !isCurrent(entry.codeId)) return;
    if (!storage.claimAttempt(entry.codeId, now())) return;
    try { await postfix.send(entry); }
    catch { void emit({ event: 'mail_attempt_failed', codeId: entry.codeId, ...(entry.contextId ? { contextId: entry.contextId } : {}) }); }
  }
  async function reconcile() {
    storage.maintain(now());
    const entries = await postfix.list(), rows = new Map(storage.rows().map(row => [row.id, row]));
    const retained: PostfixEntry[] = [], seen = new Set<string>();
    for (const entry of entries) {
      // Malformed/foreign mail is never sent; the privileged expiry guard removes it.
      if (!entry.codeId) { retained.push(entry); continue; }
      const row = rows.get(entry.codeId);
      if (!row || row.contextId !== entry.contextId || row.discardAt <= now() || entry.discardAt <= now()
        || entry.discardAt > row.discardAt || !isCurrent(row.id) || seen.has(row.id)
        || row.queueId !== null && row.queueId !== entry.queueId) {
        await postfix.remove(entry); continue;
      }
      seen.add(row.id); storage.bind(row.id, entry.queueId); retained.push(entry);
      await attempt(entry);
    }
    // A postqueue snapshot can omit a file. Absence neither proves delivery nor permits resubmission.
    for (const row of rows.values()) {
      if (!seen.has(row.id)) {
        storage.completeUnknownBefore(row.id, now() - policy.cleanupMs, now());
      }
    }
    return retained;
  }
  const api = {
    enqueue(mail: CodeMail) {
      return serial(async () => {
        const entries = await reconcile();
        if (mail.discardAt <= now() || !isCurrent(mail.id)) throw new Error('Code mail is no longer current');
        const bytes = await renderCodeMessage(mail), rows = storage.rows();
        const known = new Set(entries.flatMap(entry => entry.codeId ? [entry.codeId] : []));
        const pending = rows.filter(row => row.outcome === null && !known.has(row.id));
        const size = entries.reduce((total, entry) => total + entry.messageBytes, 0)
          + pending.reduce((total, row) => total + row.reservedBytes, 0);
        if (entries.length + pending.length >= policy.maxMessages || size + bytes.length > policy.maxBytes
          || !storage.reserve({ id: mail.id, contextId: mail.contextId, recipient: mail.email, reservedBytes: bytes.length,
            createdAt: mail.createdAt, discardAt: mail.discardAt })) throw new Error('Mail queue is full');
        // If SMTP loses its final acknowledgement, keep the reservation and reconcile by code ID.
        // Never persist a second body or automatically submit the same body again.
        const queueId = await postfix.submit(mail, bytes);
        storage.bind(mail.id, queueId);
        const entry: PostfixEntry = { queueId, codeId: mail.id, contextId: mail.contextId,
          discardAt: mail.discardAt, arrivedAt: now(), state: 'hold', messageBytes: bytes.length };
        if (mail.discardAt <= now() || !isCurrent(mail.id)) {
          await postfix.remove(entry); storage.remove(mail.id); throw new Error('Code mail expired during submission');
        }
        void emit({ event: 'mail_queued', codeId: mail.id, contextId: mail.contextId, recipient: mail.email, occurredAt: now() });
        await attempt(entry);
      });
    },
    cancel(id: string) {
      return serial(async () => {
        const entries = await postfix.list();
        for (const entry of entries) if (entry.codeId === id) await postfix.remove(entry);
        // Preserve the small reservation until reconciliation can expire an omitted/in-flight file.
      });
    },
    tick() {
      if (closed) return Promise.reject(new Error('Mail queue is closed'));
      if (queuedMaintenance) return queuedMaintenance;
      const task = serial(async () => {
        // A running pass may have one successor, never an unbounded timer backlog.
        if (queuedMaintenance === task) queuedMaintenance = undefined;
        return reconcile();
      }, true);
      queuedMaintenance = task;
      return task;
    },
    drain(): Promise<void> {
      if (closed) return Promise.resolve();
      if (draining) return draining;
      draining = (async () => {
        storage.maintain(now());
        for (const row of storage.completed(lastReported)) {
          if (closed) return;
          const event: MailEvent = { event: `mail_${row.outcome}`, codeId: row.id, contextId: row.contextId,
            eventId: `mail:${row.id}:${row.outcome}`, occurredAt: row.completedAt!,
            ...(row.recipient !== null ? { recipient: row.recipient } : {}),
            ...(row.reason !== null ? { reason: row.reason } : {}) };
          let transferred = false;
          if (handoffTerminal) {
            try { transferred = (await handoffTerminal(event)).status === 'buffered'; } catch { /* Keep pending metadata. */ }
          } else transferred = await emit(event);
          // Shutdown may close the shared DB while an external writer is still pending.
          if (closed) return;
          if (transferred) storage.acknowledgeCompleted(row);
          lastReported = { completedAt: row.completedAt!, id: row.id };
        }
      })().finally(() => { draining = undefined; });
      return draining;
    },
    start() {
      if (timer || closed) return;
      const tick = () => {
        void api.tick().catch(() => { void emit({ event: 'mail_queue_unavailable' }); })
          .finally(() => { void api.drain().catch(() => {}); });
      };
      tick(); timer = setInterval(tick, policy.cleanupMs / 4); timer.unref();
    },
    async close() { if (timer) clearInterval(timer); closed = true; await tail; postfix.close(); },
  } satisfies CodeMailQueue & { tick(): Promise<PostfixEntry[]>; drain(): Promise<void>; start(): void; close(): Promise<void> };
  return api;
}
