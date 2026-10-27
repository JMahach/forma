import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('preparing an account directory creates private state once without contacting configured mail', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forma-prepare-accounts-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const env = {...process.env, FORMA_STATE_DIR:directory, FORMA_POSTFIX_SOCKET:'/not-a-mail-service.sock', FORMA_POSTFIX_PORT:'2525'};
  const run = () => execFileSync(process.execPath, ['deploy/prepare-accounts.ts'], {env, encoding:'utf8', timeout:10000, stdio:['ignore','pipe','pipe']});
  assert.match(run(), /Account storage prepared/);
  const key = path.join(directory,'keys/account-hmac.bin'), before = await readFile(key);
  assert.equal((await stat(path.join(directory,'forma.sqlite'))).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  run();
  assert.deepEqual(await readFile(key), before, 'Preparing an existing installation preserves its account key');
});
