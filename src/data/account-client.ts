import type { AuthAttemptProgress, ConfirmedAccount, EmailAttempt, TelegramStart, TelegramVerificationResult } from '../../shared/account-contract.ts';
import { parseDiagnosticProof } from '../../shared/account-contract.ts';
import { ConnectionError, fetchResource, responseError } from './http-transport.ts';

interface AccountClientOptions { fetch?: typeof globalThis.fetch; now?: () => number }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const context = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const invalid = () => responseError(200, { error: 'invalid_response' }, 'invalid_response');
function active(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
}
function attempt(value: unknown): EmailAttempt {
  if (!object(value) || !context(value.id) || !timestamp(value.expiresAt) || !timestamp(value.codeExpiresAt)
    || !timestamp(value.resendAt) || value.codeExpiresAt > value.expiresAt) throw invalid();
  return { id: value.id, expiresAt: value.expiresAt, codeExpiresAt: value.codeExpiresAt, resendAt: value.resendAt };
}
function telegramStart(value: Record<string, unknown>): TelegramStart {
  const { attempt: current, telegram } = value;
  if (!object(current) || !context(current.id) || !timestamp(current.expiresAt) || !object(telegram)
    || typeof telegram.clientId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(telegram.clientId)
    || typeof telegram.nonce !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(telegram.nonce)
    || !Array.isArray(telegram.scope) || telegram.scope.length !== 1 || telegram.scope[0] !== 'profile') throw invalid();
  return { attempt: { id: current.id, expiresAt: current.expiresAt },
    telegram: { clientId: telegram.clientId, nonce: telegram.nonce, scope: ['profile'] } };
}
function confirmed(value: unknown): ConfirmedAccount {
  if (!object(value) || !object(value.account) || !object(value.session)) throw invalid();
  const { account, session } = value;
  if (typeof account.id !== 'string' || !account.id || typeof account.email !== 'string' || !account.email
    || typeof account.telegramLinked !== 'boolean'
    || (account.telegramHandle !== null && typeof account.telegramHandle !== 'string')
    || !context(session.id) || !timestamp(session.expiresAt)) throw invalid();
  const origin=session.diagnosticProof===undefined?null:parseDiagnosticProof(session.diagnosticProof);
  if(session.diagnosticProof!==undefined && (!origin || origin.accountId!==account.id || origin.sessionId!==session.id))throw invalid();
  return { account: { id: account.id, email: account.email, telegramLinked: account.telegramLinked, telegramHandle: account.telegramHandle },
    session: { id: session.id, expiresAt: session.expiresAt, ...(origin?{diagnosticProof:session.diagnosticProof as string}:{}) } };
}

/** Same-origin HTTP only. Cookies stay HttpOnly; requests are never retried here. */
export function createAccountClient({ fetch: send = fetchResource, now = Date.now }: AccountClientOptions = {}) {
  let clockOffset = 0;
  async function request(path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    active(signal);
    let response: Response;
    try {
      response = await send(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch (error) {
      active(signal);
      if (object(error) && typeof error.code === 'string') throw error;
      throw new ConnectionError('connection_failed');
    }
    active(signal);
    const date = response.headers.get('date'), serverTime = date ? Date.parse(date) : NaN;
    if (Number.isFinite(serverTime)) clockOffset = serverTime - now();
    let payload: unknown;
    try { payload = await response.json(); } catch (error) {
      active(signal);
      if (error instanceof TypeError) throw new ConnectionError('connection_failed');
      if (object(error) && typeof error.code === 'string') throw error;
      throw invalid();
    }
    active(signal);
    if (!response.ok) {
      const error = responseError(response.status, payload, 'account_unavailable');
      throw Object.assign(error, object(payload) && timestamp(payload.retryAt) ? { retryAt: payload.retryAt } : {});
    }
    if (!object(payload)) throw invalid();
    return payload;
  }
  async function issued(path: string, body: Record<string, unknown>, signal?: AbortSignal) {
    const value = await request(path, body, signal);
    if (value.delivery !== 'queued') throw invalid();
    return attempt(value.attempt);
  }
  return {
    now: () => now() + clockOffset,
    async current(signal?: AbortSignal): Promise<ConfirmedAccount | null> {
      const value = await request('/api/account', undefined, signal);
      return value.account === null && value.session === null ? null : confirmed(value);
    },
    start(email: string, replaceId?: string, signal?: AbortSignal) {
      return issued('/api/auth/email/start', { email, ...(replaceId ? { replaceId } : {}) }, signal);
    },
    resend(attemptId: string, signal?: AbortSignal) { return issued('/api/auth/email/resend', { attemptId }, signal); },
    async startTelegram(replaceId?: string, signal?: AbortSignal): Promise<TelegramStart> {
      const value = telegramStart(await request('/api/auth/telegram/start', { ...(replaceId ? { replaceId } : {}) }, signal));
      if (replaceId && value.attempt.id !== replaceId) throw invalid();
      return value;
    },
    async verifyTelegram(attemptId: string, idToken: string, signal?: AbortSignal): Promise<TelegramVerificationResult> {
      const value = await request('/api/auth/telegram/verify', { attemptId, idToken }, signal);
      if (!context(value.attemptId) || value.attemptId !== attemptId) throw invalid();
      if (value.needsEmail === true && value.needsConfirmation === false)
        return { attemptId, needsEmail: true, needsConfirmation: false };
      if (value.needsEmail === false && value.needsConfirmation === true)
        return { attemptId, needsEmail: false, needsConfirmation: true };
      throw invalid();
    },
    async progress(id: string, signal?: AbortSignal): Promise<AuthAttemptProgress> {
      const value = await request(`/api/auth/attempt?id=${encodeURIComponent(id)}`, undefined, signal);
      const { stage, canConfirm } = value;
      if (!context(value.id) || value.id !== id || !timestamp(value.expiresAt)
        || (stage !== 'telegram' && stage !== 'email' && stage !== 'code' && stage !== 'verified')
        || typeof canConfirm !== 'boolean' || (canConfirm && stage !== 'verified')) throw invalid();
      // Telegram can reach confirmation without ever issuing an email code.
      const withoutCode = value.codeExpiresAt === 0 && value.resendAt === 0;
      if ((stage === 'telegram' || stage === 'email') && !withoutCode || stage === 'code' && withoutCode) throw invalid();
      const current = withoutCode ? { id: value.id, expiresAt: value.expiresAt, codeExpiresAt: 0, resendAt: 0 } : attempt(value);
      return { ...current, stage, canConfirm };
    },
    async verify(attemptId: string, code: string, signal?: AbortSignal) {
      const value = await request('/api/auth/email/verify', { attemptId, code }, signal);
      if (value.attemptId !== attemptId || value.needsConfirmation !== true) throw invalid();
    },
    async confirm(attemptId: string, signal?: AbortSignal) {
      const value = confirmed(await request('/api/auth/confirm', { attemptId }, signal));
      if (value.session.id !== attemptId) throw invalid();
      return value;
    },
    async cancel(attemptId: string, signal?: AbortSignal) {
      const value = await request('/api/auth/cancel', { attemptId }, signal);
      if (value.closed !== true || value.contextId !== attemptId) throw invalid();
    },
    async logout(sessionId: string, signal?: AbortSignal) {
      const value = await request('/api/auth/logout', { sessionId }, signal);
      if (value.closed !== true || value.contextId !== sessionId) throw invalid();
    },
  };
}
export type AccountClient = ReturnType<typeof createAccountClient>;
