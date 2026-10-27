import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../server/storage/database.ts';
import { createAccountLimits } from '../server/services/account-limits.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const key = Buffer.alloc(32, 17);

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'forma-account-limits-'));
  const filename = path.join(dir, 'forma.sqlite');
  let db = openDatabase(filename);
  let limits = createAccountLimits(db, key);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    get db() { return db; }, get limits() { return limits; }, filename,
    restart() { db.close(); db = openDatabase(filename); limits = createAccountLimits(db, key); },
  };
}

test('the shared email cooldown survives restart and has no hourly email cap', t => {
  const f = fixture(t);
  assert.equal(f.limits.reserveEmail('person@example.test', '192.0.2.1', 0), null);
  f.restart();
  assert.deepEqual(f.limits.reserveEmail('person@example.test', '192.0.2.2', 1), { retryAt: MINUTE });
  for (let i = 1; i < 8; i++) {
    assert.equal(f.limits.reserveEmail('person@example.test', `192.0.2.${i + 2}`, i * MINUTE), null);
  }
  assert.equal(f.limits.reserveEmail('person@example.test', '192.0.2.8', HOUR), null);
});

test('the IP limit is shared across addresses and rejected reservations consume nothing', t => {
  const f = fixture(t);
  for (let i = 0; i < 100; i++) {
    assert.equal(f.limits.reserveEmail(`person${i}@example.test`, '192.0.2.1', 0), null);
  }
  assert.deepEqual(f.limits.reserveEmail('unused@example.test', '192.0.2.1', 1), { retryAt: HOUR });
  assert.equal(f.limits.reserveEmail('unused@example.test', '192.0.2.2', 1), null);
  assert.equal(f.limits.reserveEmail('another@example.test', '192.0.2.1', HOUR), null);
});

test('five wrong codes in fifteen minutes pause that email for fifteen minutes', t => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) assert.equal(f.limits.recordWrongCode('person@example.test', i * MINUTE), null);
  assert.equal(f.limits.verificationPause('person@example.test', 14 * MINUTE), null);
  assert.deepEqual(f.limits.recordWrongCode('person@example.test', 14 * MINUTE), { retryAt: 29 * MINUTE });
  f.restart();
  assert.deepEqual(f.limits.verificationPause('person@example.test', 20 * MINUTE), { retryAt: 29 * MINUTE });
  assert.equal(f.limits.reserveEmail('person@example.test', '192.0.2.1', 20 * MINUTE), null);
  assert.deepEqual(f.limits.verificationPause('person@example.test', 20 * MINUTE), { retryAt: 29 * MINUTE });
  assert.deepEqual(f.limits.recordWrongCode('person@example.test', 28 * MINUTE), { retryAt: 29 * MINUTE });
  assert.equal(f.limits.verificationPause('person@example.test', 29 * MINUTE), null);
  assert.equal(f.limits.recordWrongCode('person@example.test', 29 * MINUTE), null);
  assert.equal(f.limits.verificationPause('another@example.test', 20 * MINUTE), null);
});

test('wrong codes outside the fifteen-minute window do not join a previous count', t => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) assert.equal(f.limits.recordWrongCode('person@example.test', i), null);
  assert.equal(f.limits.recordWrongCode('person@example.test', 15 * MINUTE), null);
});

test('expired counters are removed and the database does not retain raw email or IP', t => {
  const f = fixture(t);
  f.limits.reserveEmail('private-email@example.test', '198.51.100.222', 0);
  f.limits.recordWrongCode('private-email@example.test', 0);
  f.db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const raw = readFileSync(f.filename).toString('latin1');
  assert.equal(raw.includes('private-email@example.test'), false);
  assert.equal(raw.includes('198.51.100.222'), false);
  f.limits.cleanup(HOUR);
  assert.equal(f.db.connection.prepare('SELECT count(*) AS total FROM auth_counters').get()?.total, 0);
});

test('database transactions roll back partial changes', t => {
  const f = fixture(t);
  assert.throws(() => f.db.transaction(() => {
    f.db.connection.exec("INSERT INTO auth_counters VALUES ('test', 1, 0, 60000, 0)");
    throw new Error('abort');
  }), /abort/);
  assert.equal(f.db.connection.prepare('SELECT count(*) AS total FROM auth_counters').get()?.total, 0);
});
