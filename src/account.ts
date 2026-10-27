import type { SavedAccountView } from './data/view-store.ts';
import type { AccountFlow } from './state/account-flow.ts';
import { createAccountClient } from './data/account-client.ts';
import { createTelegramLogin } from './data/telegram-login.ts';
import { createAccountLogoutStore } from './data/account-logout-store.ts';
import { getConnectionMode, subscribeConnection } from './data/http-transport.ts';
import { createAccountSession, type AccountNotice } from './state/account-session.ts';
import { createAccountFlow } from './state/account-flow.ts';
import { attachAccountView, connectAccountPreview, type AccountPreviewAdapter } from './views/account.ts';

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
  let demo: AccountFlow | null = null, view: ReturnType<typeof attachAccountView>, visible = !page.hidden;
  page.dataset.accountStudy = ''; page.dataset.accountAccent = 'graphite'; page.inert = loadingOnly;
  const active = () => demo ?? real;
  const render = () => attachAccountView({ page, flow: active(), offline: () => getConnectionMode() === 'offline', telegram: Boolean(demo) || !loadingOnly, onInputChange: onChange });
  view = render();
  const save = real.subscribe(onChange);
  const stopConnection = subscribeConnection(() => { if (!loadingOnly) void session.connectionChanged(); demo?.connectionChanged(); });
  const timer = window.setInterval(() => active().tick(), 1000);
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
  function suspend() { real.cancel(); demo?.cancel(); }
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('pagehide', suspend);
  const account = {
    ready: loadingOnly ? Promise.resolve() : session.refresh(),
    get snapshot() { const snapshot=real.snapshot, focus=demo ? null : view.inputFocus; return snapshot && {...snapshot,...(focus ? {focus} : {})}; },
    restoreInputFocus(focus = saved?.focus) { return !demo && view.restoreInputFocus(focus); },
    getSession() {
      const state = real.state;
      return state.identity?.id && state.session ? {accountId: state.identity.id, sessionId: state.session.id, ...(state.session.diagnosticProof?{diagnosticProof:state.session.diagnosticProof}:{})} : null;
    },
    subscribeSession(listener: () => void) { return real.subscribe(listener); },
    subscribeNotices(listener: (notice: AccountNotice) => void) { noticeListeners.add(listener); return () => { noticeListeners.delete(listener); }; },
    async canRestoreLibrary() { try { return !loadingOnly && (await logoutStore.list()).length === 0; } catch { return false; } },
    setVisible(value: boolean) {
      if (visible && !value) active().close();
      visible = value;
      if (value) view.render();
    },
    preview(adapter: AccountPreviewAdapter | null) {
      real.cancel(); view.destroy(); demo?.destroy();
      demo = adapter ? createAccountFlow({ initial: adapter.screen, identity: adapter.identity,
        request: adapter.request, connection: getConnectionMode }) : null;
      view = render();
      if (!demo && !loadingOnly) void session.refresh();
      return demo;
    },
    cancelPreview() { demo?.cancel(); },
    destroy() {
      disconnectPreview(); noticeListeners.clear();
      window.clearInterval(timer); stopConnection(); save(); view.destroy(); demo?.destroy(); session.destroy(); telegram.destroy(); channel?.close();
      document.removeEventListener('visibilitychange', resume); window.removeEventListener('pagehide', suspend);
    },
  };
  const disconnectPreview = connectAccountPreview({ preview: account.preview, cancelPreview: account.cancelPreview });
  return account;
}
export type AccountWorkspace = ReturnType<typeof attachAccount>;
