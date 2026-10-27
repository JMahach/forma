import type { TelegramLogin } from '../data/telegram-login.ts';
import type { AccountClient } from '../data/account-client.ts';
import type { AccountLogoutStore } from '../data/account-logout-store.ts';
import type { SavedAccountView } from '../data/view-store.ts';
import type { ConnectionMode } from '../data/http-transport.ts';
import { createAccountFlow, createAccountServerRequest } from './account-flow.ts';

export type AccountNotice = { kind: 'logout'; ids: string[] } | { kind: 'changed'; id: string };
interface Options {
  telegram?: Pick<TelegramLogin, 'reserve'>;
  client: AccountClient; logoutStore: AccountLogoutStore; connection: () => ConnectionMode;
  saved?: SavedAccountView | null; notify?: (notice: AccountNotice) => void;
}
/** Account lifetime only. Chart/library owners receive changes at composition. */
export function createAccountSession({ telegram, client, logoutStore, connection, saved = null, notify = () => {} }: Options) {
  const revoked = new Set<string>();
  let flushing: Promise<void> | null = null, receiving = false, acceptedId: string | null = null;
  async function flush() {
    if (connection() !== 'online') return;
    if (flushing) return flushing;
    flushing = (async () => {
      for (const id of await logoutStore.list()) {
        revoked.add(id);
        await client.logout(id);
        await logoutStore.remove(id);
      }
    })();
    try { await flushing; } finally { flushing = null; }
  }
  const request = createAccountServerRequest(client);
  const flow = createAccountFlow({ telegram, saved, connection, now: client.now,
    async request(input, signal) {
      await flush();
      if (signal.aborted) throw signal.reason;
      const result = await request(input, signal);
      if (result.session && (revoked.has(result.session.id) || (await logoutStore.list()).includes(result.session.id))) {
        return { screen: 'guest' };
      }
      return result;
    },
    onClose: async id => { await client.cancel(id); },
    async onLogout(ids) {
      for (const id of ids) revoked.add(id);
      if (!receiving) notify({ kind: 'logout', ids: [...ids] });
      await logoutStore.add(ids);
      await flush();
    },
  });
  flow.subscribe(state => {
    const id = state.session?.id ?? null;
    if (id && id !== acceptedId && !receiving) notify({ kind: 'changed', id });
    acceptedId = id;
  });
  return {
    flow,
    async receive(notice: AccountNotice) {
      if (notice.kind === 'logout') {
        for (const id of notice.ids) revoked.add(id);
        receiving = true;
        try { await flow.logout(notice.ids); } finally { receiving = false; }
      } else if (notice.id !== flow.state.session?.id) {
        receiving = true;
        // A cross-tab account change supersedes a pending login. Otherwise the
        // flow's busy guard drops the read and leaves the previous owner visible.
        flow.cancel();
        try { await flow.retry(); } finally { receiving = false; }
      }
    },
    async connectionChanged() {
      flow.connectionChanged();
      // Only a previously requested logout can be replayed on reconnect.
      try { await flush(); } catch { /* The durable IDs remain pending. */ }
    },
    refresh: () => flow.retry(),
    destroy() { flow.destroy(); logoutStore.close(); },
  };
}
