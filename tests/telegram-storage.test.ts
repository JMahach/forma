import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/storage/database.ts';
import { createAccountStorage } from '../server/storage/accounts.ts';

test('existing email accounts, pending codes and sessions survive Telegram schema migration', () => {
  const database = openDatabase(':memory:');
  try {
    database.connection.exec(`
      CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, telegramHandle TEXT) STRICT;
      CREATE TABLE account_attempts (id TEXT PRIMARY KEY, email TEXT NOT NULL, bindingHash TEXT NOT NULL,
        createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, previousSessionId TEXT,
        codeId TEXT UNIQUE, codeHash TEXT, codeExpiresAt INTEGER NOT NULL,
        resendAt INTEGER NOT NULL, mailExpiresAt INTEGER NOT NULL, sessionHash TEXT) STRICT;
      CREATE TABLE account_sessions (id TEXT PRIMARY KEY, accountId INTEGER NOT NULL REFERENCES accounts(id),
        secretHash TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
        bindingHash TEXT, bindingExpiresAt INTEGER NOT NULL) STRICT;
      INSERT INTO accounts VALUES(1,'owner@example.test',NULL);
      INSERT INTO account_attempts VALUES('attempt','owner@example.test','binding',1,100,NULL,'code','hash',50,10,40,NULL);
      INSERT INTO account_sessions VALUES('session',1,'secret',1,1000,'binding',100);
    `);
    const storage = createAccountStorage(database);
    assert.equal(storage.account(1).email, 'owner@example.test');
    assert.equal(storage.account(1).telegramId, null);
    assert.equal(storage.attempt('attempt')!.codeHash, 'hash');
    assert.equal(storage.session('session')!.secretHash, 'secret');
    const row = {...storage.attempt('attempt')!, id: 'telegram', email: null, codeId: null,
      codeHash: null, telegramNonce: 'n'.repeat(43), telegramId: null, telegramHandle: null, targetAccountId: null};
    storage.saveAttempt(row);
    assert.equal(storage.attempt('telegram')!.email, null);
    assert.equal(storage.attempt('telegram')!.telegramNonce, row.telegramNonce);
    createAccountStorage(database);
    assert.equal(storage.attempt('attempt')!.codeHash, 'hash');
    assert.equal(storage.attempt('telegram')!.telegramNonce, row.telegramNonce);
  } finally {database.close();}
});

test('one Telegram cannot belong to two accounts and a different Telegram cannot overwrite a link', () => {
  const database = openDatabase(':memory:');
  try {
    const storage = createAccountStorage(database);
    const first = storage.ensureAccount('first@example.test'), second = storage.ensureAccount('second@example.test');
    assert.equal(storage.linkTelegram(first.id, '100', null), true);
    assert.throws(() => storage.linkTelegram(second.id, '100', 'other'));
    assert.equal(storage.linkTelegram(first.id, '101', 'replacement'), false);
    assert.equal(storage.accountByTelegram('100')?.id, first.id);
    assert.equal(storage.account(first.id).telegramId, '100');
    assert.equal(storage.account(second.id).telegramId, null);
    assert.equal(storage.linkTelegram(first.id, '100', 'updated'), true);
    assert.equal(storage.account(first.id).telegramHandle, 'updated');
  } finally {database.close();}
});
