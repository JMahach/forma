// Stand-only transport for reviewing forms. Never sends mail, opens Telegram,
// creates a real session or changes the user's stored charts.
import type { AccountRequest, AccountReply, AccountScreen, AccountIdentity } from '../state/account-flow.ts';
import { standConnection } from './stand-connection.ts';
const previewIdentity: AccountIdentity = { email: 'anna@example.com', telegramHandle: '@username' };
export function accountPreviewIdentity(screen: AccountScreen): AccountIdentity | null {
  return screen === 'guest' || screen === 'error' ? null : {
    ...previewIdentity, telegramHandle: screen === 'unlinked' ? null : previewIdentity.telegramHandle,
  };
}
export type AccountScenario = 'normal' | 'new-telegram' | 'code-expired' | 'attempt-expired' | 'rate-limit' | 'send-failed' | 'delivery-failed' | 'verify-failed' | 'telegram-conflict';
export function createAccountAdapter({ scenario = () => 'normal', now = Date.now, delay = 650 }: { scenario?: () => AccountScenario; now?: () => number; delay?: number } = {}) {
  let serial = 0;
  return async (request: AccountRequest, signal: AbortSignal): Promise<AccountReply> => {
    await new Promise<void>((resolve, reject) => {
      const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(new DOMException('Cancelled', 'AbortError')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, delay);
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
    });
    if (standConnection.current !== 'online') throw { code: standConnection.current === 'offline' ? 'offline' : 'server_unavailable' };
    const selected = scenario(), { operation } = request;
    if (operation === 'begin') return {};
    if (operation === 'retry') return { screen: 'linked', identity: accountPreviewIdentity('linked')! };
    if (operation === 'telegram') {
      if (selected === 'telegram-conflict') throw { code: 'telegram_conflict' };
      return selected === 'new-telegram' && request.screen !== 'unlinked' ? { needsEmail: true } : { screen: 'linked', identity: {...previewIdentity, email: request.email || previewIdentity.email} };
    }
    if (selected === 'rate-limit') throw { code: 'auth_rate_limited' };
    if (operation === 'send' || operation === 'resend') {
      if (selected === 'send-failed') throw { code: 'code_send_failed' };
      if (selected === 'delivery-failed') throw { code: 'code_delivery_failed' };
      const expiresAt = request.attempt?.expiresAt ?? now() + 30 * 60_000;
      return { attempt: { id: request.attempt?.id ?? `stand-attempt-${++serial}`, expiresAt: selected === 'attempt-expired' ? now() : expiresAt,
        codeExpiresAt: selected === 'code-expired' ? now() : Math.min(expiresAt, now() + 10 * 60_000), resendAt: selected === 'code-expired' || selected === 'attempt-expired' ? now() : now() + 60_000 } };
    }
    if (selected === 'verify-failed') throw { code: 'code_verify_failed' };
    if (request.code !== '123456') throw { code: 'code_invalid' };
    return { screen: request.telegramPending ? 'linked' : 'unlinked', identity: { email: request.email, telegramHandle: request.telegramPending ? previewIdentity.telegramHandle : null } };
  };
}
