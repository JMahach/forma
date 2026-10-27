import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createAccountLogoutStore } from '../src/data/account-logout-store.ts';

test('offline revocation IDs survive another tab and closing the original store', async () => {
  const indexedDB = new IDBFactory(), old = 'a'.repeat(32), newer = 'b'.repeat(32);
  const first = createAccountLogoutStore({ indexedDB });
  await first.add([old]); first.close();
  const second = createAccountLogoutStore({ indexedDB }), third = createAccountLogoutStore({ indexedDB });
  try {
    assert.deepEqual(await second.list(), [old]);
    await third.add([newer]); await second.remove(old);
    assert.deepEqual(await third.list(), [newer], 'acknowledging the old logout cannot discard another context');
  } finally { second.close(); third.close(); }
});

test('unavailable durable storage is an explicit failure rather than an empty logout list', async () => {
  const store = createAccountLogoutStore({ indexedDB: null });
  try { await assert.rejects(store.list(), error => (error as { code: string }).code === 'account_storage_unavailable'); }
  finally { store.close(); }
});
