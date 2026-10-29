import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createAccountSession, type AccountNotice } from '../src/state/account-session.ts';
import { createAccountLogoutStore } from '../src/data/account-logout-store.ts';
import type { AccountClient } from '../src/data/account-client.ts';
import type { TelegramLogin } from '../src/data/telegram-login.ts';

const id = 'a'.repeat(32), nextId = 'b'.repeat(32);
const account = { id: 'account-one', email: 'a@example.org', telegramHandle: null, telegramLinked: false };
const confirmed = (context = id) => ({ account, session: { id: context, expiresAt: 999999999 } });
function setup(telegram?: Pick<TelegramLogin, 'reserve'>) {
  const indexedDB = new IDBFactory(), pending = createAccountLogoutStore({ indexedDB });
  let mode: 'online' | 'offline' = 'online', current: ReturnType<typeof confirmed> | null = confirmed();
  const calls: string[] = [], notices: AccountNotice[] = [];
  const client = { now: () => 1000, current: async () => { calls.push('current'); return current; },
    logout: async (context: string) => { calls.push('logout:' + context); if (current?.session.id === context) current = null; },
  } as unknown as AccountClient;
  const owner = createAccountSession({ client, telegram, logoutStore: pending, connection: () => mode, notify: value => notices.push(value) });
  return { owner, pending, indexedDB, calls, notices, offline() { mode = 'offline'; }, online() { mode = 'online'; }, useNewAccount() { current = { ...confirmed(nextId), account: { ...account, id: 'account-two', email: 'b@example.org' } }; }, useNewSession() { current = confirmed(nextId); }, client };
}

test('offline logout clears the account immediately, survives reload and revokes only its old context', async () => {
  const s = setup(); await s.owner.refresh(); s.offline();
  const result = s.owner.flow.logout(); assert.equal(s.owner.flow.state.identity, null); await result;
  assert.deepEqual(await s.pending.list(), [id]);
  assert.equal(s.calls.includes('logout:' + id), false);
  s.owner.destroy(); s.useNewAccount();
  const reloadedStore = createAccountLogoutStore({ indexedDB: s.indexedDB });
  const reloaded = createAccountSession({ client: s.client, logoutStore: reloadedStore, connection: () => 'online' });
  await reloaded.refresh();
  assert.deepEqual(s.calls.slice(-2), ['logout:' + id, 'current']);
  assert.equal(reloaded.flow.state.session?.id, nextId);
  assert.deepEqual(await reloadedStore.list(), []);
  reloaded.destroy();
});

test('a logout from another tab clears this flow without broadcasting an endless echo', async () => {
  const s = setup(); await s.owner.refresh(); s.notices.length = 0; s.offline();
  await s.owner.receive({ kind: 'logout', ids: [id] });
  assert.equal(s.owner.flow.state.screen, 'guest');
  assert.deepEqual(s.notices, []);
  assert.deepEqual(await s.pending.list(), [id]);
  s.owner.destroy();
});

test('connection restoration replays logout, never resends mail or restarts login', async () => {
  const s = setup(); await s.owner.refresh(); s.offline(); await s.owner.flow.logout();
  s.calls.length = 0; s.online(); await s.owner.connectionChanged();
  assert.deepEqual(s.calls, ['logout:' + id]);
  assert.equal(s.owner.flow.state.screen, 'guest'); s.owner.destroy();
});

test('a delayed logout of OLD cannot clear or revoke the subsequently confirmed NEW session', async () => {
  const s = setup(); await s.owner.refresh();
  s.useNewAccount(); await s.owner.refresh();
  assert.equal(s.owner.flow.state.session?.id, nextId);
  s.notices.length = 0; s.calls.length = 0;
  await s.owner.receive({ kind: 'logout', ids: [id] });
  assert.equal(s.owner.flow.state.session?.id, nextId);
  assert.equal(s.calls.includes('logout:' + nextId), false);
  assert.deepEqual(s.notices, []);
  s.owner.destroy();
});

test('a delayed logout of OLD cannot clear or revoke a newer email attempt', async () => {
  const s = setup(); await s.owner.refresh();
  s.client.start = async () => ({ id: nextId, expiresAt: 1800000, codeExpiresAt: 600000, resendAt: 60000 });
  await s.owner.flow.begin(); s.owner.flow.input('email', 'new@example.org'); await s.owner.flow.submit();
  s.owner.flow.input('code', '123456'); s.notices.length = 0; s.calls.length = 0;
  await s.owner.receive({ kind: 'logout', ids: [id] });
  assert.equal(s.owner.flow.state.attempt?.id, nextId);
  assert.equal(s.owner.flow.state.step, 'code');
  assert.equal(s.owner.flow.state.code, '123456');
  assert.equal(s.owner.flow.state.identity, null);
  assert.equal(s.calls.includes('logout:' + nextId), false);
  assert.deepEqual(s.notices, []);
  s.owner.destroy();
});

test('an old login notice reads actual state without discarding a newer unfinished attempt or its input', async () => {
  const s = setup(); await s.owner.refresh();
  const attempt = { id: nextId, expiresAt: 1800000, codeExpiresAt: 600000, resendAt: 60000 };
  s.client.start = async () => attempt;
  s.client.progress = async () => ({ ...attempt, stage: 'code', canConfirm: false });
  await s.owner.flow.begin(); s.owner.flow.input('email', 'new@example.org'); await s.owner.flow.submit();
  s.owner.flow.input('code', '123456');
  await s.owner.receive({ kind: 'changed', id: 'c'.repeat(32) });
  assert.equal(s.owner.flow.state.attempt?.id, nextId);
  assert.equal(s.owner.flow.state.step, 'code');
  assert.equal(s.owner.flow.state.code, '123456');
  s.owner.destroy();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

for (const stage of ['telegram-popup', 'telegram-verify', 'email-send', 'email-verify'] as const) {
  test(`a changed account notice interrupts ${stage} and rejects its late result`, async t => {
    const entered = deferred<void>(), release = deferred<void>();
    const popup: { signal?: AbortSignal; closed: boolean } = { closed: false };
    const hold = async () => { entered.resolve(); await release.promise; };
    const telegram: Pick<TelegramLogin, 'reserve'> = {
      reserve(signal) {
        popup.signal = signal;
        return { async authenticate() { if (stage === 'telegram-popup') await hold(); return 'late.signed.token'; }, close() { popup.closed = true; } };
      },
    };
    const s = setup(telegram), attemptId = 'c'.repeat(32);
    t.after(() => { release.resolve(); s.owner.destroy(); });
    const attempt = { id: attemptId, expiresAt: 1800000, codeExpiresAt: 600000, resendAt: 60000 };
    let confirmations = 0, telegramProofs = 0;
    s.client.startTelegram = async () => ({ attempt: { id: attemptId, expiresAt: 1800000 }, telegram: { clientId: '123', nonce: 'n'.repeat(43), scope: ['profile'] } });
    s.client.verifyTelegram = async () => { telegramProofs++; if (stage === 'telegram-verify') await hold(); return { attemptId, needsEmail: false, needsConfirmation: true }; };
    s.client.start = async () => { if (stage === 'email-send') await hold(); return attempt; };
    s.client.verify = async () => { if (stage === 'email-verify') await hold(); };
    s.client.progress = async () => { throw { code: 'account_changed' }; };
    s.client.confirm = async () => { confirmations++; return { ...confirmed(), account: { ...account, telegramLinked: false } }; };
    await s.owner.refresh();
    const observedOwners: string[] = [];
    s.owner.flow.subscribe(state => { if (state.identity?.id) observedOwners.push(state.identity.id); });
    let work: Promise<void>;
    if (stage.startsWith('telegram')) work = s.owner.flow.telegram();
    else {
      await s.owner.flow.begin(); s.owner.flow.input('email', 'a@example.org');
      if (stage === 'email-verify') { await s.owner.flow.submit(); s.owner.flow.input('code', '123456'); }
      work = s.owner.flow.submit();
    }
    await entered.promise;
    s.useNewAccount(); s.calls.length = 0; s.notices.length = 0;
    try {
      await s.owner.receive({ kind: 'changed', id: nextId });
      assert.equal(s.calls.includes('current'), true, 'the other tab notice must cause an actual session read despite a busy login');
      assert.equal(s.owner.flow.state.identity?.id, 'account-two');
      assert.equal(s.owner.flow.state.session?.id, nextId);
      assert.equal(s.owner.flow.state.attempt, null);
      assert.equal(s.owner.flow.state.code, '');
      assert.equal(observedOwners.includes('account-two'), true, 'library consumers must observe the replacement owner');
      assert.deepEqual(s.notices, [], 'receiving a change must not echo it to the other tab');
    } finally { release.resolve(); await work; }
    assert.equal(s.owner.flow.state.identity?.id, 'account-two');
    assert.equal(s.owner.flow.state.session?.id, nextId);
    assert.equal(s.owner.flow.state.issue, null);
    assert.equal(confirmations, 0, 'the interrupted action must never confirm its stale account');
    if (stage.startsWith('telegram')) {
      assert.equal(popup.signal?.aborted, true);
      assert.equal(popup.closed, true);
      assert.equal(telegramProofs, stage === 'telegram-popup' ? 0 : 1);
    }
  });
}

for (const change of ['account', 'session', 'unchanged'] as const) {
  test(`a live previous attempt is retained only in its original context: ${change}`, async t => {
    const s = setup(), entered = deferred<void>(), release = deferred<void>();
    t.after(() => { release.resolve(); s.owner.destroy(); });
    const attempt = { id: 'c'.repeat(32), expiresAt: 1800000, codeExpiresAt: 600000, resendAt: 60000 };
    s.client.start = async () => attempt;
    s.client.progress = async () => ({ ...attempt, stage: 'code', canConfirm: false });
    s.client.verify = async () => { entered.resolve(); await release.promise; };
    s.client.confirm = async () => { assert.fail('the interrupted verification must not confirm'); };
    await s.owner.refresh(); await s.owner.flow.begin();
    s.owner.flow.input('email', 'private-draft@example.test'); await s.owner.flow.submit();
    s.owner.flow.input('code', '123456'); const work = s.owner.flow.submit(); await entered.promise;
    if (change === 'account') s.useNewAccount();
    if (change === 'session') s.useNewSession();
    try {
      await s.owner.receive({ kind: 'changed', id: nextId });
      if (change === 'unchanged') {
        assert.equal(s.owner.flow.state.session?.id, id);
        assert.equal(s.owner.flow.state.attempt?.id, attempt.id);
        assert.equal(s.owner.flow.state.step, 'code');
        assert.equal(s.owner.flow.state.email, 'private-draft@example.test');
        assert.equal(s.owner.flow.state.attemptEmail, 'private-draft@example.test');
        assert.equal(s.owner.flow.state.code, '123456');
      } else {
        assert.equal(s.owner.flow.state.session?.id, nextId);
        assert.equal(s.owner.flow.state.attempt, null, 'a still-live attempt from the previous account/session must not cross contexts');
        assert.equal(s.owner.flow.state.step, 'account');
        assert.equal(s.owner.flow.state.email, change === 'account' ? 'b@example.org' : 'a@example.org');
        assert.equal(s.owner.flow.state.attemptEmail, '');
        assert.equal(s.owner.flow.state.code, '');
        assert.equal(s.owner.flow.state.verificationPending, false);
        assert.equal(s.owner.flow.snapshot, null);
      }
    } finally { release.resolve(); await work; }
    assert.equal(s.owner.flow.state.issue, null);
    assert.equal(s.owner.flow.state.session?.id, change === 'unchanged' ? id : nextId);
    assert.equal(s.owner.flow.state.attempt?.id ?? null, change === 'unchanged' ? attempt.id : null);
    assert.equal(s.owner.flow.state.code, change === 'unchanged' ? '123456' : '');
  });
}

test('session observers keep A to B to A boundaries but ignore login field and busy updates', async () => {
  const s=setup(), seen:(string|null)[]=[];
  const stop=s.owner.subscribeSession(access=>seen.push(access?access.accountId+':'+access.sessionId:null));
  await s.owner.refresh();
  s.owner.flow.input('email','changed@example.org');s.owner.flow.input('code','123');
  await s.owner.refresh();
  assert.deepEqual(seen,[null,account.id+':'+id]);
  s.useNewAccount();await s.owner.refresh();
  s.client.current=async()=>confirmed();await s.owner.refresh();
  assert.deepEqual(seen,[null,account.id+':'+id,'account-two:'+nextId,account.id+':'+id]);
  stop();await s.owner.flow.logout();assert.equal(seen.length,4);
  s.owner.destroy();
});
