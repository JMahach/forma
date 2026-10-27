import type { SavedAccountView } from '../data/view-store.ts';
import type { AccountSession, ConfirmedAccount, EmailAttempt } from '../../shared/account-contract.ts';
import type { AccountClient } from '../data/account-client.ts';
import type { TelegramLogin, TelegramPopup } from '../data/telegram-login.ts';

// The flow owns continuation; transport owns cookies and the server owns access.
export type AccountScreen = 'linked' | 'unlinked' | 'guest' | 'expired' | 'error';
export type AccountOperation = 'begin' | 'send' | 'verify' | 'resend' | 'telegram' | 'retry';
export interface AccountIdentity { id?: string; email: string; telegramHandle: string | null }
export type AccountAttempt = EmailAttempt;
export interface AccountRequest { operation: AccountOperation; email: string; code: string; attempt: AccountAttempt | null; screen: AccountScreen; telegramPending: boolean; recover?: boolean; resume?: SavedAccountView | null; context?: { accountId?: string; sessionId: string }; popup?: TelegramPopup; onAttempt?: (attempt: AccountAttempt, stage: 'telegram' | 'verifying') => void }
export interface AccountReply { screen?: AccountScreen; identity?: AccountIdentity; session?: AccountSession; attempt?: AccountAttempt; needsEmail?: boolean; restart?: boolean; step?: 'email' | 'code' | 'telegram'; telegramPending?: boolean; verificationPending?: boolean; attemptEmail?: string; issue?: AccountIssue }
export interface AccountIssue { code: string; field?: 'email' | 'code' }
export interface AccountState {
  identity: AccountIdentity | null; session: AccountSession | null;
  screen: AccountScreen; step: 'account' | 'email' | 'code' | 'telegram'; email: string; code: string;
  busy: AccountOperation | null; issue: AccountIssue | null; attempt: AccountAttempt | null;
  attemptEmail: string; telegramPending: boolean; resendSeconds: number; verificationPending: boolean;
}
export type AccountFlow = ReturnType<typeof createAccountFlow>;
interface Options {
  telegram?: Pick<TelegramLogin, 'reserve'>;
  saved?: SavedAccountView | null;
  initial?: AccountScreen; identity?: AccountIdentity | null; connection: () => 'online' | 'offline' | 'server'; now?: () => number;
  request: (request: AccountRequest, signal: AbortSignal) => Promise<AccountReply>;
  onClose?: (attemptId: string) => Promise<void>;
  onLogout?: (contextIds: readonly string[]) => Promise<void>;
}
const fieldFor = (code: string): 'email' | 'code' | undefined => code.startsWith('email_') ? 'email' : ['code_required', 'code_invalid', 'code_expired'].includes(code) ? 'code' : undefined;
const connectionIssue = (code: string) => ['offline', 'server_unavailable', 'connection_failed'].includes(code);
const emailKey = (email: string) => email.trim().normalize('NFC').toLowerCase();

/** The same user action owns verify and confirm. A stale action never confirms. */
export function createAccountServerRequest(client: AccountClient): Options['request'] {
  const reply = (value: ConfirmedAccount): AccountReply => ({ screen: value.account.telegramLinked ? 'linked' : 'unlinked', identity: value.account, session: value.session });
  return async (request, signal) => {
    const active = () => { if (signal.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError'); };
    const progressReply = (progress: Awaited<ReturnType<AccountClient['progress']>>): AccountReply => ({
      attempt: progress,
      step: progress.stage === 'telegram' || progress.stage === 'verified' && !progress.codeExpiresAt ? 'telegram'
        : progress.stage === 'email' ? 'email' : request.resume?.step === 'email' && progress.stage === 'code' ? 'email' : 'code',
      attemptEmail: request.resume?.attemptEmail,
      telegramPending: progress.stage === 'email' || request.resume?.telegramPending || request.telegramPending,
      verificationPending: progress.stage === 'verified',
    });
    active();
    if (request.operation === 'begin') return {};
    if (request.operation === 'retry') {
      const current = await client.current(signal);
      if (current) {
        // A valid old attempt is not evidence that it belongs in this newly
        // confirmed context. Notices only trigger reads; server identity wins.
        const changed = request.context && (current.session.id !== request.context.sessionId
          || request.context.accountId !== undefined && current.account.id !== request.context.accountId);
        if (changed || !request.resume?.attemptId || current.session.id === request.resume.attemptId) return reply(current);
      }
      if (request.resume) {
        if (!request.resume.attemptId) return { step: request.resume.step };
        try {
          const progress = await client.progress(request.resume.attemptId, signal);
          return {...(current ? reply(current) : {}), ...progressReply(progress)};
        } catch (error) {
          if (['attempt_expired', 'account_changed'].includes((error as { code?: string })?.code ?? '')) {
            return current ? reply(current) : { step: 'email', issue: { code: 'attempt_expired' } };
          }
          throw error;
        }
      }
      return { screen: request.screen === 'linked' || request.screen === 'unlinked' || request.screen === 'expired' ? 'expired' : 'guest' };
    }
    if (request.operation === 'telegram') {
      let attemptId = request.attempt?.id;
      if (attemptId) {
        const current = await client.current(signal);
        if (current?.session.id === attemptId) return reply(current);
        const progress = await client.progress(attemptId, signal);
        if (progress.stage === 'verified') {
          if (!progress.canConfirm) return {restart: true, step: 'telegram'};
          active(); return reply(await client.confirm(attemptId, signal));
        }
        if (progress.stage === 'email' || progress.stage === 'code' && request.telegramPending) return progressReply(progress);
        if (progress.stage === 'code') {
          // Choosing a different provider abandons an unverified email attempt.
          // A verified Telegram/email continuation always retains its original ID.
          await client.cancel(attemptId, signal); active(); attemptId = undefined;
        }
      }
      if (!request.popup) throw {code: 'telegram_unavailable'};
      const started = await client.startTelegram(attemptId, signal); active();
      const attempt = {...started.attempt, codeExpiresAt: 0, resendAt: 0};
      request.onAttempt?.(attempt, 'telegram');
      const token = await request.popup.authenticate(started); active();
      request.onAttempt?.(attempt, 'verifying');
      const verified = await client.verifyTelegram(attempt.id, token, signal); active();
      if (verified.needsEmail) return {needsEmail: true, attempt, telegramPending: true};
      return reply(await client.confirm(attempt.id, signal));
    }
    if (request.operation === 'send') return { attempt: await client.start(request.email, request.attempt?.id, signal) };
    if (!request.attempt) throw { code: 'attempt_expired' };
    const id = request.attempt.id;
    if (request.operation === 'resend') return { attempt: await client.resend(id, signal) };
    if (request.operation !== 'verify') throw { code: 'account_unavailable' };
    async function recover() {
      const current = await client.current(signal);
      if (current?.session.id === id) return reply(current);
      const progress = await client.progress(id, signal);
      if (progress.stage === 'verified') {
        if (!progress.canConfirm) return { restart: true };
        active(); return reply(await client.confirm(id, signal));
      }
      return null;
    }
    if (request.recover) {
      const result = await recover(); if (result) return result;
    }
    if (!/^\d{6}$/.test(request.code)) throw { code: 'code_invalid' };
    try { await client.verify(id, request.code, signal); }
    catch (error) {
      if (['code_used', 'attempt_expired'].includes((error as { code?: string })?.code ?? '')) {
        const result = await recover(); if (result) return result;
      }
      throw error;
    }
    active(); return reply(await client.confirm(id, signal));
  };
}

export function createAccountFlow({ telegram, saved = null, initial = 'guest', identity = null, connection, request, now = Date.now,
  onClose = async () => {}, onLogout = async () => {} }: Options) {
  let state: AccountState = { screen: initial, identity, session: null, step: saved?.step ?? 'account', email: saved?.email ?? identity?.email ?? '', code: '', busy: null, issue: null, attempt: null, attemptEmail: saved?.attemptEmail ?? '', telegramPending: saved?.telegramPending ?? false, resendSeconds: 0, verificationPending: saved?.verificationPending ?? false };
  let resume = saved;
  let controller: AbortController | null = null, generation = 0;
  // Observed server permissions for this open flow, never a locally granted quota.
  const sendPauses = new Map<string, number>();
  const seconds = () => Math.max(0, Math.ceil(((sendPauses.get(emailKey(state.email)) ?? 0) - now()) / 1000));
  const listeners = new Set<(state: Readonly<AccountState>) => void>();
  const emit = () => { for (const listener of listeners) listener(state); };
  const patch = (next: Partial<AccountState>) => { state = { ...state, ...next }; state.resendSeconds = seconds(); emit(); };
  function abort() { generation++; controller?.abort(); controller = null; }
  function issue(code: string) { patch({ issue: { code, field: fieldFor(code) } }); }
  function expired() {
    if (!state.attempt) return false;
    if (now() >= state.attempt.expiresAt) { issue('attempt_expired'); return true; }
    return false;
  }
  async function run(operation: AccountOperation) {
    if (state.busy) return;
    if (connection() === 'offline') { issue('offline'); return; }
    const current = new AbortController(); controller = current; generation++;
    const email = state.email.trim();
    patch({ busy: operation, issue: null, ...(operation === 'telegram' && telegram ? {step: 'telegram' as const} : {}) });
    let popup: TelegramPopup | undefined;
    try {
      if (operation === 'telegram') popup = telegram?.reserve(current.signal, () => { if (controller === current) cancel(); });
      const result = await request({ operation, email, code: state.code, attempt: state.attempt, screen: state.screen, telegramPending: state.telegramPending, recover: state.verificationPending, resume: operation === 'retry' ? snapshot() : resume,
        ...(state.session ? {context: {accountId: state.identity?.id, sessionId: state.session.id}} : {}),
        ...(popup ? {popup} : {}), onAttempt: (attempt, stage) => {
          if (controller !== current || current.signal.aborted) return;
          resume = null; patch({attempt, step: 'telegram', verificationPending: stage === 'verifying'});
        } }, current.signal);
      if (controller !== current || current.signal.aborted) return;
      if (operation === 'retry') resume = null;
      if (result.screen && !result.attempt) {
        const identity = result.screen === 'expired' ? state.identity : result.identity ?? null;
        patch({ screen: result.screen, identity, session: result.session ?? null, email: identity?.email ?? state.email, step: 'account', code: '', attempt: null, attemptEmail: '', telegramPending: false, verificationPending: false });
      } else if (result.needsEmail) patch({ step: 'email', telegramPending: true, attempt: result.attempt ?? state.attempt, verificationPending: false });
      else if (result.attempt) {
        sendPauses.set(emailKey(result.attemptEmail ?? email), result.attempt.resendAt);
        patch({ ...(result.screen ? {screen: result.screen, identity: result.identity ?? null, session: result.session ?? null} : {}), telegramPending: result.telegramPending ?? state.telegramPending, step: result.step ?? 'code', email: operation === 'retry' && result.step === 'email' ? state.email : email, code: operation === 'retry' ? state.code : '', attempt: result.attempt, attemptEmail: result.attemptEmail ?? email, verificationPending: result.verificationPending ?? false });
      } else if (result.step && !result.restart) {
        patch({ step: result.step, attempt: null, code: '', telegramPending: false, verificationPending: false, issue: result.issue ?? null });
      } else if (result.restart) {
        const id = state.attempt?.id;
        if (id) void onClose(id).catch(() => {});
        patch({ step: result.step ?? 'email', code: '', attempt: null, telegramPending: false, verificationPending: false, issue: { code: 'code_verify_failed' } });
      } else if (operation === 'begin') patch({ step: 'email' });
      else issue('invalid_response');
    } catch (error) {
      if (controller !== current || current.signal.aborted || (error as Error)?.name === 'AbortError') return;
      const problem = error as { code?: string; retryAt?: number }, code = problem?.code || 'server_unavailable';
      if ((operation === 'send' || operation === 'resend') && Number.isFinite(problem.retryAt)) sendPauses.set(emailKey(email), problem.retryAt!);
      patch({ issue: { code, field: fieldFor(code) }, verificationPending: state.verificationPending || operation === 'verify' && connectionIssue(code) });
    } finally {
      popup?.close();
      if (controller === current) { controller = null; patch({ busy: null }); }
    }
  }
  function cancel() { const verifying = state.busy === 'verify'; abort(); patch({ busy: null, issue: null, verificationPending: state.verificationPending || verifying }); }
  function close() {
    const id = state.attempt?.id ?? resume?.attemptId; resume = null; abort();
    patch({ step: 'account', code: '', attempt: null, telegramPending: false, busy: null, issue: null, verificationPending: false });
    if (id) void onClose(id).catch(() => {});
  }
  function choose(screen: AccountScreen, identity: AccountIdentity | null = null) {
    resume = null; abort(); patch({ screen, identity, session: null, step: 'account', email: identity?.email ?? '', code: '', attempt: null, telegramPending: false, busy: null, issue: null, verificationPending: false });
  }
  function snapshot(): SavedAccountView | null {
    return state.step === 'account' ? null : { email: state.email, attemptEmail: state.attemptEmail,
      attemptId: state.attempt?.id ?? resume?.attemptId ?? null, step: state.step,
      verificationPending: state.verificationPending || state.busy === 'verify', ...(state.telegramPending ? {telegramPending: true} : {}) };
  }
  return {
    get snapshot(): SavedAccountView | null { return snapshot(); },
    get state(): Readonly<AccountState> { return state; },
    subscribe(listener: (state: Readonly<AccountState>) => void) { listeners.add(listener); listener(state); return () => { listeners.delete(listener); }; },
    choose, close, cancel,
    async logout(contextIds?: readonly string[]) {
      const ownIds = [state.session?.id, state.attempt?.id, resume?.attemptId].filter((id): id is string => !!id);
      const ids = [...new Set(contextIds ?? ownIds)];
      const affectsSession = !!state.session && ids.includes(state.session.id);
      const attemptId = state.attempt?.id ?? resume?.attemptId;
      const affectsAttempt = !!attemptId && ids.includes(attemptId);
      if (!contextIds) { sendPauses.clear(); choose('guest'); }
      else if (affectsAttempt) {
        resume = null; abort();
        patch({ step: 'account', attempt: null, code: '', busy: null, issue: null, verificationPending: false,
          ...(affectsSession ? { screen: 'guest', identity: null, session: null, email: '' } : {}) });
      } else if (affectsSession) {
        // An already newer form has its own context and retains its input.
        if (state.step === 'account') { abort(); patch({ busy: null, issue: null, email: '' }); }
        patch({ screen: 'guest', identity: null, session: null });
      }
      const current = generation;
      try { await onLogout(ids); }
      catch { if (generation === current && (!contextIds || affectsSession || affectsAttempt)) issue('account_unavailable'); }
    },
    back() {
      const dead = state.issue?.code === 'attempt_expired'; abort();
      patch({ step: state.step === 'telegram' ? 'telegram' : 'email', code: '', ...(dead ? { attempt: null, telegramPending: false } : {}), busy: null, issue: null, verificationPending: false });
    },
    input(field: 'email' | 'code', value: string) {
      if (state.busy) return;
      state = { ...state, [field]: field === 'code' ? value.replace(/\D/g, '').slice(0, 6) : value };
      if (state.issue?.field === field && state.issue.code !== 'code_expired') patch({ issue: null });
      else patch({});
    },
    begin: () => run('begin'), retry: () => run('retry'), telegram: () => run('telegram'),
    async submit() {
      if (state.busy) return;
      if (resume) { await run('retry'); return; }
      if (state.step === 'telegram') {
        if (expired()) return;
        await run('telegram');
      } else if (state.step === 'email') {
        if (!state.email.trim()) { issue('email_required'); return; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.email.trim())) { issue('email_invalid'); return; }
        if (seconds() > 0) return;
        await run('send');
      } else if (state.step === 'code') {
        if (!state.verificationPending) {
          if (expired()) return;
          if (state.attempt && now() >= state.attempt.codeExpiresAt) { issue('code_expired'); return; }
          if (!/^\d{6}$/.test(state.code)) { issue('code_invalid'); return; }
        }
        await run('verify');
      }
    },
    async resend() {
      if (state.busy || state.step !== 'code' || !state.attempt || expired() || seconds() > 0) return;
      await run('resend');
    },
    connectionChanged() {
      if (state.busy && connection() !== 'online') {
        const verifying = state.busy === 'verify'; abort();
        patch({ busy: null, issue: { code: connection() === 'offline' ? 'offline' : 'server_unavailable' }, verificationPending: state.verificationPending || verifying });
      } else if (state.issue && connectionIssue(state.issue.code)) patch({ issue: connection() === 'online' ? null : { code: connection() === 'offline' ? 'offline' : 'server_unavailable' } });
      else emit();
    },
    tick() {
      if (state.busy) return;
      const code = state.attempt && !state.verificationPending ? now() >= state.attempt.expiresAt ? 'attempt_expired' : state.step === 'code' && state.attempt.codeExpiresAt > 0 && now() >= state.attempt.codeExpiresAt ? 'code_expired' : null : null;
      if (seconds() !== state.resendSeconds || (code && code !== state.issue?.code)) patch({ ...(code ? { issue: { code, field: fieldFor(code) } } : {}) });
    },
    destroy() { abort(); listeners.clear(); },
  };
}
