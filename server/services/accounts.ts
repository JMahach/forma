import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Database } from '../storage/database.ts';
import { createAccountStorage, type AttemptRecord, type SessionRecord } from '../storage/accounts.ts';
import { createAccountLimits } from './account-limits.ts';
import { ACCOUNT_POLICY as policy } from './account-policy.ts';
import { MAIL_POLICY } from '../mail/policy.ts';
import type { CodeMail, CodeMailQueue } from '../mail/code-mail.ts';
import type { TelegramProvider } from './telegram-provider.ts';
import { TelegramProviderError } from './telegram-provider.ts';
import { TelegramIdentityError } from './telegram-identity.ts';
import { parseDiagnosticProof } from '../../shared/account-contract.ts';
import type { AuthAttemptProgress, ConfirmedAccount, EmailAttempt, TelegramStart, TelegramVerificationResult } from '../../shared/account-contract.ts';

export interface AccountCredentials { bindings: Record<string, string>; sessions: Record<string, string> }
export class AccountError extends Error {
  code: string; status: number; retryAt: number | undefined;
  constructor(code: string, status = 400, retryAt?: number) {
    super(code); this.name = 'AccountError'; this.code = code; this.status = status; this.retryAt = retryAt;
  }
}
export interface AccountGrant { id: string; secret: string; expiresAt: number }
// Transport backpressure: no new queue or persisted login-attempt policy.
const MAX_TELEGRAM_VERIFICATIONS = 16;
const secret = () => randomBytes(32).toString('base64url');
const identifier = () => randomBytes(16).toString('hex');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function matches(value: string | undefined, expected: string | null) {
  return !!value && !!expected && value.length <= 128
    && timingSafeEqual(Buffer.from(hash(value), 'hex'), Buffer.from(expected, 'hex'));
}
function normalizeEmail(value: unknown) {
  if (typeof value !== 'string') throw new AccountError('email_invalid');
  const email = value.trim().normalize('NFC').toLowerCase();
  if (email.length > 254 || !/^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+\.[^\s@<>\x00-\x1f\x7f]+$/u.test(email)) {
    throw new AccountError('email_invalid');
  }
  return email;
}
const summary = (row: AttemptRecord): EmailAttempt => ({ id: row.id, expiresAt: row.expiresAt,
  codeExpiresAt: row.codeExpiresAt, resendAt: row.resendAt });

/** Account policy owns verification; mail transport and HTTP receive narrow capabilities. */
export function createAccounts({ database, key, mail, telegram, signal, now = Date.now,
  report = () => {} }: { database: Database; key: Uint8Array; mail: CodeMailQueue; now?: () => number;
    telegram?: TelegramProvider; signal?: AbortSignal;
    report?: (event: { event: string; contextId: string; accountId?: string; occurredAt: number }) => void | boolean | Promise<void | boolean> }) {
  const storage = createAccountStorage(database);
  const verifying = new Set<string>();
  const limits = createAccountLimits(database, key);
  const diagnosticSignature = (accountId: string, sessionId: string) => createHmac('sha256', key)
    .update('forma:diagnostic-origin:v1\0').update(`v1.${accountId}.${sessionId}`).digest();
  const codeHash = (id: string, code: string) => createHmac('sha256', key).update(`${id}\0${code}`).digest('hex');
  const emit = (event: string, contextId: string, accountId?: string) => {
    try { void Promise.resolve(report({ event, contextId, occurredAt: now(), ...(accountId ? { accountId } : {}) })).catch(() => {}); } catch { /* Diagnostics never controls access. */ }
  };
  const cancelMail = async (id: string | null, contextId: string) => {
    if (!id) return;
    try { await mail.cancel(id); } catch { emit('mail_cancel_failed', contextId); }
  };
  function ownsAttempt(row: AttemptRecord, credentials: AccountCredentials) {
    return matches(credentials.bindings[row.id], row.bindingHash) || matches(credentials.sessions[row.id], row.sessionHash);
  }
  function ownsSession(row: SessionRecord, credentials: AccountCredentials, time: number) {
    return matches(credentials.sessions[row.id], row.secretHash)
      || (row.bindingExpiresAt > time && matches(credentials.bindings[row.id], row.bindingHash));
  }
  function getAttempt(id: string, credentials: AccountCredentials, time: number) {
    const row = storage.attempt(id);
    if (!row || row.expiresAt <= time) throw new AccountError('attempt_expired', 410);
    if (!ownsAttempt(row, credentials)) throw new AccountError('auth_required', 401);
    return row;
  }
  function knownSessions(credentials: AccountCredentials, time: number) {
    const ids = new Set([...Object.keys(credentials.sessions), ...Object.keys(credentials.bindings)]);
    const found: SessionRecord[] = [];
    for (const id of ids) {
      const row = storage.session(id);
      if (row && row.expiresAt > time && ownsSession(row, credentials, time)) found.push(row);
    }
    return found;
  }
  function baseline(credentials: AccountCredentials, time: number) {
    const rows = knownSessions(credentials, time);
    if (rows.length > 1) throw new AccountError('account_changed', 409);
    return rows[0]?.id ?? null;
  }
  function ensureBaseline(row: AttemptRecord, credentials: AccountCredentials, time: number) {
    if (row.previousSessionId !== baseline(credentials, time)) throw new AccountError('account_changed', 409);
  }
  function ensureLinkSession(row: AttemptRecord, credentials: AccountCredentials, time: number) {
    ensureBaseline(row, credentials, time);
    if (row.targetAccountId === null) return;
    const session = row.previousSessionId && storage.session(row.previousSessionId);
    if (!session || session.expiresAt <= time || session.accountId !== row.targetAccountId
      || !matches(credentials.sessions[session.id], session.secretHash)) throw new AccountError('account_changed', 409);
  }
  function newAttempt(email: string | null, binding: string, credentials: AccountCredentials, time: number): AttemptRecord {
    return { id: identifier(), email, bindingHash: hash(binding), createdAt: time, expiresAt: time + policy.attemptMs,
      previousSessionId: baseline(credentials, time), codeId: null, codeHash: null, codeExpiresAt: 0,
      resendAt: 0, mailExpiresAt: 0, sessionHash: null, telegramNonce: null, telegramId: null,
      telegramHandle: null, targetAccountId: null };
  }
  function grant(row: AttemptRecord, time: number): AccountGrant {
    const token = secret(); row.sessionHash = hash(token); row.codeHash = null; storage.saveAttempt(row);
    return { id: row.id, secret: token, expiresAt: time + policy.sessionMs };
  }
  function assertTelegramEmail(row: AttemptRecord) {
    if (row.telegramNonce) throw new AccountError('telegram_required', 409);
    if (row.targetAccountId !== null) throw new AccountError('telegram_used', 409);
  }
  function view(row: SessionRecord): ConfirmedAccount {
    const account = storage.account(row.accountId);
    return { account: { id: String(account.id), email: account.email, telegramHandle: account.telegramHandle, telegramLinked: account.telegramId !== null },
      session: { id: row.id, expiresAt: row.expiresAt,
        diagnosticProof: `v1.${row.accountId}.${row.id}.${diagnosticSignature(String(row.accountId), row.id).toString('base64url')}` } };
  }
  function prepareCode(row: AttemptRecord, time: number) {
    if (!row.email) throw new AccountError('email_required', 409);
    const code = randomInt(1_000_000).toString().padStart(6, '0');
    row.codeId = identifier(); row.codeHash = codeHash(row.id, code);
    row.codeExpiresAt = Math.min(time + policy.codeMs, row.expiresAt);
    row.resendAt = time + policy.resendMs;
    row.mailExpiresAt = Math.min(time + MAIL_POLICY.lifetimeMs, row.codeExpiresAt);
    row.sessionHash = null;
    storage.saveAttempt(row);
    return { id: row.codeId, contextId: row.id, email: row.email, code,
      createdAt: time, discardAt: row.mailExpiresAt } satisfies CodeMail;
  }
  async function enqueue(value: CodeMail) {
    try { await mail.enqueue(value); }
    catch {
      const row = storage.attempt(value.contextId);
      if (row?.codeId === value.id) { row.codeHash = null; storage.saveAttempt(row); }
      await cancelMail(value.id, value.contextId);
      emit('mail_enqueue_failed', value.contextId);
      throw new AccountError('code_send_failed', 503);
    }
    if (!storage.mailIsCurrent(value.id, now())) await cancelMail(value.id, value.contextId);
  }
  function cleanup() {
    database.transaction(() => { const time = now(); storage.cleanup(time); limits.cleanup(time); });
  }
  cleanup();
  return {
    startTelegram({ credentials, replaceId }: { credentials: AccountCredentials; replaceId?: string }): TelegramStart & { binding: AccountGrant } {
      if (!telegram || signal?.aborted) throw new AccountError('telegram_unavailable', 503);
      return database.transaction(() => {
        const time = now(), binding = secret();
        const previous = replaceId ? getAttempt(replaceId, credentials, time) : undefined;
        if (previous) {
          ensureLinkSession(previous, credentials, time);
          if (!previous.telegramNonce || previous.sessionHash) throw new AccountError('telegram_used', 409);
        }
        const row = previous ?? newAttempt(null, binding, credentials, time);
        if (!previous) {
          const session = row.previousSessionId && storage.session(row.previousSessionId);
          if (session && matches(credentials.sessions[session.id], session.secretHash)) row.targetAccountId = session.accountId;
          row.telegramNonce = secret(); storage.saveAttempt(row);
        }
        return { attempt: { id: row.id, expiresAt: row.expiresAt },
          telegram: { clientId: telegram.clientId, nonce: row.telegramNonce!, scope: ['profile'] as ['profile'] },
          binding: { id: row.id, secret: previous ? credentials.bindings[row.id]! : binding, expiresAt: row.expiresAt } };
      });
    },
    async verifyTelegram(id: string, token: unknown, credentials: AccountCredentials, options: { signal?: AbortSignal } = {}): Promise<TelegramVerificationResult & {grant?: AccountGrant}> {
      const activeSignal = signal && options.signal ? AbortSignal.any([signal, options.signal]) : signal ?? options.signal;
      if (activeSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!telegram) throw new AccountError('telegram_unavailable', 503);
      const before = getAttempt(id, credentials, now());
      ensureLinkSession(before, credentials, now());
      if (!before.telegramNonce || before.telegramId || before.sessionHash) throw new AccountError('telegram_used', 409);
      if (verifying.has(id) || verifying.size >= MAX_TELEGRAM_VERIFICATIONS) throw new AccountError('telegram_unavailable', 503);
      verifying.add(id);
      try {
        const identity = await telegram.verify(token, { nonce: before.telegramNonce, createdAt: before.createdAt,
          expiresAt: before.expiresAt }, { signal: activeSignal });
        if (activeSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return database.transaction(() => {
          const time = now(), row = getAttempt(id, credentials, time);
          ensureLinkSession(row, credentials, time);
          if (!row.telegramNonce || row.telegramNonce !== before.telegramNonce || row.telegramId || row.sessionHash) {
            throw new AccountError('telegram_used', 409);
          }
          if (identity.expiresAt <= time) throw new AccountError('telegram_invalid');
          const existing = storage.accountByTelegram(identity.userId);
          const target = row.targetAccountId === null ? undefined : storage.account(row.targetAccountId);
          if (target && (existing && existing.id !== target.id || target.telegramId && target.telegramId !== identity.userId)) {
            throw new AccountError('telegram_conflict', 409);
          }
          row.telegramNonce = null; row.telegramId = identity.userId; row.telegramHandle = identity.username;
          const account = target ?? existing;
          if (account) {
            row.email = account.email;
            return { attemptId: id, needsEmail: false, needsConfirmation: true, grant: grant(row, time) };
          }
          storage.saveAttempt(row);
          return { attemptId: id, needsEmail: true, needsConfirmation: false, grant: undefined };
        });
      } catch (error) {
        if (error instanceof TelegramProviderError) throw new AccountError(error.code, 503);
        if (error instanceof TelegramIdentityError) throw new AccountError(error.code);
        throw error;
      } finally { verifying.delete(id); }
    },
    async start({ email: input, ip, credentials, replaceId }: {
      email: unknown; ip: string; credentials: AccountCredentials; replaceId?: string;
    }) {
      const email = normalizeEmail(input), binding = secret();
      let oldMail: string | null = null;
      const result = database.transaction(() => {
        const time = now();
        const previous = replaceId ? getAttempt(replaceId, credentials, time) : undefined;
        const reuse = previous && (previous.email === email || previous.telegramId !== null);
        if (previous) {
          if (previous.sessionHash) throw new AccountError('code_used', 409);
          ensureLinkSession(previous, credentials, time); assertTelegramEmail(previous);
        }
        const pause = limits.reserveEmail(email, ip, time);
        if (pause) throw new AccountError('auth_rate_limited', 429, pause.retryAt);
        const row = reuse ? previous : newAttempt(email, binding, credentials, time);
        row.email = email;
        oldMail = previous?.codeId ?? null;
        const pending = prepareCode(row, time);
        if (previous && !reuse) storage.deleteAttempt(previous.id);
        return { row, pending, binding: reuse ? credentials.bindings[row.id]! : binding };
      });
      await cancelMail(oldMail, replaceId ?? result.row.id);
      await enqueue(result.pending);
      return { attempt: summary(result.row), binding: { id: result.row.id, secret: result.binding, expiresAt: result.row.expiresAt } };
    },
    async resend(id: string, ip: string, credentials: AccountCredentials) {
      const result = database.transaction(() => {
        const time = now();
        const row = getAttempt(id, credentials, time);
        if (row.sessionHash) throw new AccountError('code_used', 409);
        ensureBaseline(row, credentials, time);
        assertTelegramEmail(row);
        if (!row.email) throw new AccountError('email_required', 409);
        const pause = limits.reserveEmail(row.email, ip, time);
        if (pause) throw new AccountError('auth_rate_limited', 429, pause.retryAt);
        const oldMail = row.codeId;
        return { pending: prepareCode(row, time), row, oldMail };
      });
      await cancelMail(result.oldMail, id); await enqueue(result.pending);
      return summary(result.row);
    },
    verify(id: string, code: unknown, credentials: AccountCredentials): AccountGrant {
      let oldMail: string | null = null;
      const result = database.transaction(() => {
        const time = now();
        const row = getAttempt(id, credentials, time);
        ensureBaseline(row, credentials, time);
        if (row.sessionHash) throw new AccountError('code_used', 409);
        assertTelegramEmail(row);
        if (!row.email) throw new AccountError('email_required', 409);
        const pause = limits.verificationPause(row.email, time);
        if (pause) throw new AccountError('auth_rate_limited', 429, pause.retryAt);
        if (!row.codeHash || row.codeExpiresAt <= time) throw new AccountError('code_expired', 410);
        const correct = typeof code === 'string' && /^\d{6}$/.test(code)
          && timingSafeEqual(Buffer.from(codeHash(id, code), 'hex'), Buffer.from(row.codeHash, 'hex'));
        if (!correct) {
          const blocked = limits.recordWrongCode(row.email, time);
          return new AccountError(blocked ? 'auth_rate_limited' : 'code_invalid', blocked ? 429 : 400, blocked?.retryAt);
        }
        oldMail = row.codeId;
        return grant(row, time);
      });
      if (result instanceof AccountError) throw result;
      void cancelMail(oldMail, id);
      return result;
    },
    confirm(id: string, credentials: AccountCredentials) {
      const pendingMail: { id: string | null; contextId: string }[] = [];
      let completed = false;
      const result = database.transaction(() => {
        const time = now();
        const existing = storage.session(id);
        if (existing && existing.expiresAt > time && matches(credentials.sessions[id], existing.secretHash)) return view(existing);
        const row = getAttempt(id, credentials, time);
        if (!matches(credentials.sessions[id], row.sessionHash)) throw new AccountError('auth_required', 401);
        ensureLinkSession(row, credentials, time);
        if (!row.email) throw new AccountError('email_required', 409);
        const account = row.targetAccountId === null ? storage.ensureAccount(row.email) : storage.account(row.targetAccountId);
        if (row.telegramId) {
          const linked = storage.accountByTelegram(row.telegramId);
          if (linked && linked.id !== account.id || account.telegramId && account.telegramId !== row.telegramId
            || !storage.linkTelegram(account.id, row.telegramId, row.telegramHandle)) throw new AccountError('telegram_conflict', 409);
        }
        const session: SessionRecord = { id, accountId: account.id, secretHash: row.sessionHash!, createdAt: time,
          expiresAt: time + policy.sessionMs, bindingHash: row.bindingHash, bindingExpiresAt: row.expiresAt };
        const contexts = new Set([...Object.keys(credentials.bindings), ...Object.keys(credentials.sessions)]);
        for (const contextId of contexts) {
          if (contextId === id) continue;
          const otherAttempt = storage.attempt(contextId);
          if (otherAttempt && ownsAttempt(otherAttempt, credentials)) {
            pendingMail.push({ id: otherAttempt.codeId, contextId }); storage.deleteAttempt(contextId);
          }
          const otherSession = storage.session(contextId);
          if (otherSession && ownsSession(otherSession, credentials, time)) storage.deleteSession(contextId);
        }
        storage.saveSession(session); storage.deleteAttempt(id); completed = true;
        return view(session);
      });
      for (const value of pendingMail) void cancelMail(value.id, value.contextId);
      if (completed) emit('auth_login', id, result.account.id);
      return result;
    },
    /** Origin of an untrusted client report, not an access grant or proof the event happened.
     * The existing diagnostic queue record owns its lifetime. No session is retained
     * after expiry; a final exit delivery may still arrive after session deletion. */
    diagnosticOwner(credentials: AccountCredentials, diagnosticProof?: unknown): string | null {
      if (diagnosticProof !== undefined) {
        const proof = parseDiagnosticProof(diagnosticProof);
        if (!proof || !Number.isSafeInteger(Number(proof.accountId))) return null;
        const actual = Buffer.from(proof.signature, 'base64url');
        const expected = diagnosticSignature(proof.accountId, proof.sessionId);
        if (actual.length !== expected.length || actual.toString('base64url') !== proof.signature
          || !timingSafeEqual(actual, expected) || !storage.account(Number(proof.accountId))) return null;
        return proof.accountId;
      }
      const rows = knownSessions(credentials, now()).filter(row => matches(credentials.sessions[row.id], row.secretHash));
      return rows.length === 1 ? String(rows[0]!.accountId) : null;
    },
    current(credentials: AccountCredentials, {renew=true}:{renew?:boolean} = {}) {
      return database.transaction(() => {
        const time = now();
        const rows = knownSessions(credentials, time).filter(row => matches(credentials.sessions[row.id], row.secretHash));
        if (rows.length > 1) throw new AccountError('account_changed', 409);
        const row = rows[0]; if (!row) return null;
        if(renew) {
          row.expiresAt = time + policy.sessionMs;
          storage.touchSession(row.id, row.expiresAt);
        }
        return view(row);
      });
    },
    progress(id: string, credentials: AccountCredentials): AuthAttemptProgress {
      const row = getAttempt(id, credentials, now());
      return { ...summary(row), stage: row.sessionHash ? 'verified' as const : row.telegramNonce ? 'telegram' as const
        : row.email ? 'code' as const : 'email' as const,
        canConfirm: matches(credentials.sessions[id], row.sessionHash) };
    },
    async cancel(id: string, credentials: AccountCredentials) {
      const row = storage.attempt(id);
      if (!row) return;
      if (row.expiresAt > now() && !ownsAttempt(row, credentials)) throw new AccountError('auth_required', 401);
      storage.deleteAttempt(id); await cancelMail(row.codeId, id);
    },
    async logout(id: string, credentials: AccountCredentials) {
      const result = database.transaction(() => {
        const time = now();
        const attempt = storage.attempt(id), session = storage.session(id);
        if (attempt && attempt.expiresAt > time && !ownsAttempt(attempt, credentials)) throw new AccountError('auth_required', 401);
        if (session && session.expiresAt > time && !ownsSession(session, credentials, time)) throw new AccountError('auth_required', 401);
        storage.deleteAttempt(id); storage.deleteSession(id);
        return { mailId: attempt?.codeId ?? null, accountId: session && session.expiresAt > time ? String(session.accountId) : null };
      });
      await cancelMail(result.mailId, id);
      if (result.accountId) emit('auth_logout', id, result.accountId);
    },
    isMailCurrent(id: string) { return storage.mailIsCurrent(id, now()); },
    discardedCredentials(credentials: AccountCredentials) {
      const time = now(), discarded: { kind: 'binding' | 'session'; id: string }[] = [];
      for (const [id, value] of Object.entries(credentials.bindings)) {
        const attempt = storage.attempt(id);
        if (!attempt || attempt.expiresAt <= time || !matches(value, attempt.bindingHash)) discarded.push({ kind: 'binding', id });
      }
      for (const [id, value] of Object.entries(credentials.sessions)) {
        const session = storage.session(id), attempt = storage.attempt(id);
        const valid = (session && session.expiresAt > time && matches(value, session.secretHash))
          || (attempt && attempt.expiresAt > time && matches(value, attempt.sessionHash));
        if (!valid) discarded.push({ kind: 'session', id });
      }
      return discarded;
    },
    cleanup,
  };
}
export type Accounts = ReturnType<typeof createAccounts>;
