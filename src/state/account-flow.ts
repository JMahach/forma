// Account interaction state. Transport owns authentication; this controller only
// accepts an explicit result of its current request. No secrets are persisted.
export type AccountScreen = 'linked' | 'unlinked' | 'guest' | 'expired' | 'error';
export type AccountOperation = 'begin' | 'send' | 'verify' | 'resend' | 'telegram' | 'retry';
export interface AccountIdentity { email: string; telegramHandle: string | null }
export interface AccountAttempt { id: string; expiresAt: number; codeExpiresAt: number; resendAt: number }
export interface AccountRequest { operation: AccountOperation; email: string; code: string; attempt: AccountAttempt | null; screen: AccountScreen; telegramPending: boolean }
export interface AccountReply { screen?: 'linked' | 'unlinked'; identity?: AccountIdentity; attempt?: AccountAttempt; needsEmail?: boolean }
export interface AccountIssue { code: string; field?: 'email' | 'code' }
export interface AccountState {
  identity: AccountIdentity | null;
  screen: AccountScreen; step: 'account' | 'email' | 'code'; email: string; code: string;
  busy: AccountOperation | null; issue: AccountIssue | null; attempt: AccountAttempt | null;
  telegramPending: boolean; resendSeconds: number;
}
export type AccountFlow = ReturnType<typeof createAccountFlow>;
interface Options {
  initial?: AccountScreen; identity?: AccountIdentity | null; connection: () => 'online' | 'offline' | 'server'; now?: () => number;
  request: (request: AccountRequest, signal: AbortSignal) => Promise<AccountReply>;
}
const fieldFor = (code: string): 'email' | 'code' | undefined => code.startsWith('email_') ? 'email' : ['code_required', 'code_invalid', 'code_expired'].includes(code) ? 'code' : undefined;
const connectionIssue = (code: string) => ['offline', 'server_unavailable', 'connection_failed'].includes(code);
export function createAccountFlow({ initial = 'guest', identity = null, connection, request, now = Date.now }: Options) {
  let state: AccountState = { screen: initial, identity, step: 'account', email: identity?.email ?? '', code: '', busy: null, issue: null, attempt: null, telegramPending: false, resendSeconds: 0 };
  let controller: AbortController | null = null;
  const listeners = new Set<(state: Readonly<AccountState>) => void>();
  const emit = () => { for (const listener of listeners) listener(state); };
  const patch = (next: Partial<AccountState>) => { state = { ...state, ...next }; emit(); };
  function abort() { controller?.abort(); controller = null; }
  function issue(code: string) { patch({ issue: { code, field: fieldFor(code) } }); }
  function expired() {
    if (!state.attempt) return false;
    if (now() >= state.attempt.expiresAt) { issue('attempt_expired'); return true; }
    return false;
  }
  async function run(operation: AccountOperation) {
    if (state.busy) return;
    if (connection() === 'offline') { issue('offline'); return; }
    const current = new AbortController(); controller = current;
    patch({ busy: operation, issue: null });
    try {
      const result = await request({ operation, email: state.email.trim(), code: state.code, attempt: state.attempt, screen: state.screen, telegramPending: state.telegramPending }, current.signal);
      if (controller !== current || current.signal.aborted) return;
      if (result.screen) {
        patch({ screen: result.screen, identity: result.identity ?? null, email: result.identity?.email ?? state.email, step: 'account', code: '', attempt: null, telegramPending: false, resendSeconds: 0 });
      } else if (result.needsEmail) patch({ step: 'email', telegramPending: true });
      else if (result.attempt) patch({ step: 'code', email: state.email.trim(), code: '', attempt: result.attempt, resendSeconds: Math.max(0, Math.ceil((result.attempt.resendAt - now()) / 1000)) });
      else if (operation === 'begin') patch({ step: 'email' });
      else issue('invalid_response');
    } catch (error) {
      if (controller !== current || current.signal.aborted || (error as Error)?.name === 'AbortError') return;
      issue((error as { code?: string })?.code || 'server_unavailable');
    } finally {
      if (controller === current) { controller = null; patch({ busy: null }); }
    }
  }
  function cancel() { abort(); patch({ busy: null, issue: null }); }
  function close() { abort(); patch({ step: 'account', code: '', attempt: null, telegramPending: false, busy: null, issue: null, resendSeconds: 0 }); }
  function choose(screen: AccountScreen, identity: AccountIdentity | null = null) {
    abort(); patch({ screen, identity, step: 'account', email: identity?.email ?? '', code: '', attempt: null, telegramPending: false, busy: null, issue: null, resendSeconds: 0 });
  }
  return {
    get state(): Readonly<AccountState> { return state; },
    subscribe(listener: (state: Readonly<AccountState>) => void) { listeners.add(listener); listener(state); return () => { listeners.delete(listener); }; },
    choose, close, cancel,
    logout() { choose('guest'); },
    back() { abort(); patch({ step: 'email', code: '', attempt: null, busy: null, issue: null, resendSeconds: 0 }); },
    input(field: 'email' | 'code', value: string) {
      if (state.busy) return;
      state = { ...state, [field]: field === 'code' ? value.replace(/\D/g, '').slice(0, 6) : value };
      // Updating input must not replace the focused DOM node on every keystroke.
      if (state.issue?.field === field && !['code_expired'].includes(state.issue.code)) patch({ issue: null });
    },
    begin: () => run('begin'), retry: () => run('retry'), telegram: () => run('telegram'),
    async submit() {
      if (state.busy) return;
      if (state.step === 'email') {
        if (!state.email.trim()) { issue('email_required'); return; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.email.trim())) { issue('email_invalid'); return; }
        await run('send');
      } else if (state.step === 'code') {
        if (expired()) return;
        if (state.attempt && now() >= state.attempt.codeExpiresAt) { issue('code_expired'); return; }
        if (!/^\d{6}$/.test(state.code)) { issue('code_invalid'); return; }
        await run('verify');
      }
    },
    async resend() {
      if (state.busy || state.step !== 'code' || !state.attempt || expired() || now() < state.attempt.resendAt) return;
      await run('resend');
    },
    connectionChanged() {
      if (state.busy && connection() !== 'online') { abort(); patch({ busy: null, issue: { code: connection() === 'offline' ? 'offline' : 'server_unavailable' } }); }
      else if (state.issue && connectionIssue(state.issue.code)) patch({ issue: connection() === 'online' ? null : {code:connection() === 'offline' ? 'offline' : 'server_unavailable'} });
      else emit();
    },
    tick() {
      if (!state.attempt || state.busy) return;
      const resendSeconds = Math.max(0, Math.ceil((state.attempt.resendAt - now()) / 1000));
      const code = now() >= state.attempt.expiresAt ? 'attempt_expired' : now() >= state.attempt.codeExpiresAt ? 'code_expired' : null;
      if (resendSeconds !== state.resendSeconds || (code && code !== state.issue?.code)) patch({ resendSeconds, ...(code ? { issue: { code, field: fieldFor(code) } } : {}) });
    },
    destroy() { abort(); listeners.clear(); },
  };
}
