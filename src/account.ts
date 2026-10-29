import type { SavedAccountView } from './data/view-store.ts';
import { createAccountClient } from './data/account-client.ts';
import { createTelegramLogin } from './data/telegram-login.ts';
import { createAccountLogoutStore } from './data/account-logout-store.ts';
import { getConnectionMode, subscribeConnection } from './data/http-transport.ts';
import { createAccountSession, type AccountNotice } from './state/account-session.ts';
import { attachAccountView } from './views/account.ts';

/** Explicit browser composition: the real account is the default adapter. */
export function attachAccount({ page, saved = null, onChange = () => {}, loadingOnly = false }: {
  page: HTMLElement; saved?: SavedAccountView | null; onChange?: () => void; loadingOnly?: boolean;
}) {
  const document = page.ownerDocument, window = document.defaultView!;
  let channel: BroadcastChannel | null = null;
  try { channel = new window.BroadcastChannel('forma-account'); } catch { /* Storage and server still guard resumed tabs. */ }
  const noticeListeners = new Set<(notice: AccountNotice) => void>();
  const deliver = (notice: AccountNotice) => { for (const listener of noticeListeners) listener(notice); };
  const logoutStore = createAccountLogoutStore();
  const client = createAccountClient();
  const telegram = createTelegramLogin({ window, now: client.now });
  const session = createAccountSession({ client, telegram, logoutStore,
    connection: getConnectionMode, saved, notify: notice => { deliver(notice); channel?.postMessage(notice); } });
  const real = session.flow;
  let visible = !page.hidden;
  page.dataset.accountStudy = ''; page.dataset.accountAccent = 'graphite'; page.inert = loadingOnly;
  const view = attachAccountView({ page, flow: real, offline: () => getConnectionMode() === 'offline', telegram: !loadingOnly, onInputChange: onChange });
  const save = real.subscribe(onChange);
  const stopConnection = subscribeConnection(() => { if (!loadingOnly) void session.connectionChanged(); });
  const timer = window.setInterval(() => real.tick(), 1000);
  if (channel) channel.onmessage = event => {
    const value = event.data as Partial<AccountNotice> | null;
    if (loadingOnly) { if (value?.kind === 'logout') real.choose('guest'); return; }
    if (value?.kind === 'logout' && Array.isArray(value.ids) && value.ids.every(id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id))) {
      deliver({kind: 'logout', ids: value.ids});
      void session.receive({ kind: 'logout', ids: value.ids });
    } else if (value?.kind === 'changed' && typeof value.id === 'string' && /^[a-f0-9]{32}$/.test(value.id)) {
      void session.receive({ kind: 'changed', id: value.id });
    }
  };
  function resume() { if (!loadingOnly && !document.hidden) void session.refresh(); }
  // Page suspension preserves the form; leaving the account section closes it.
  function suspend() { real.cancel(); }
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('pagehide', suspend);
  const account = {
    ready: loadingOnly ? Promise.resolve() : session.refresh(),
    get snapshot() { const snapshot=real.snapshot, focus=view.inputFocus; return snapshot && {...snapshot,...(focus ? {focus} : {})}; },
    restoreInputFocus(focus = saved?.focus) { return view.restoreInputFocus(focus); },
    getSession: session.getSession,
    subscribeSession: session.subscribeSession,
    subscribeNotices(listener: (notice: AccountNotice) => void) { noticeListeners.add(listener); return () => { noticeListeners.delete(listener); }; },
    async canRestoreLibrary() { try { return !loadingOnly && (await logoutStore.list()).length === 0; } catch { return false; } },
    setVisible(value: boolean) {
      if (visible && !value) real.close();
      visible = value;
      if (value) view.render();
    },
    destroy() {
      noticeListeners.clear();
      window.clearInterval(timer); stopConnection(); save(); view.destroy(); session.destroy(); telegram.destroy(); channel?.close();
      document.removeEventListener('visibilitychange', resume); window.removeEventListener('pagehide', suspend);
    },
  };
  return account;
}
export type AccountWorkspace = ReturnType<typeof attachAccount>;
