import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

test('mail-only Linux package carries the project README and verifies each private artifact',async t=>{
 const temporary=await mkdtemp(path.join(tmpdir(),'forma-mail-package-'));
 t.after(()=>rm(temporary,{recursive:true,force:true}));
 const root=fileURLToPath(new URL('../',import.meta.url)),output=path.join(temporary,'bundle');
 const run=spawnSync(process.execPath,['deploy/postfix/package-linux.ts','--output',output],{cwd:root,encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);
 const expected=['README.md','deploy/postfix/control.py','deploy/postfix/install.py','deploy/postfix/prepare.mjs',
  'deploy/postfix/receipt.py','deploy/prepare-accounts.mjs'];
 const sums=(await readFile(path.join(output,'SHA256SUMS'),'utf8')).trim().split('\n');
 assert.deepEqual(sums.map(line=>line.slice(66)).sort(),expected);
 for(const line of sums){
  const [digest,name]=[line.slice(0,64),line.slice(66)],file=path.join(output,name);
  assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),digest,name);
  assert.equal((await stat(file)).mode&0o077,0,name);
 }
 assert.deepEqual(await readFile(path.join(output,'README.md')),await readFile(path.join(root,'README.md')));
 const files=await readdir(output,{recursive:true});
 assert.ok(files.every(file=>!/(?:\.env|node_modules|forma\.sqlite|account-hmac|linux\.md)/.test(String(file))));
 assert.equal((await stat(output)).mode&0o077,0);
 const again=spawnSync(process.execPath,['deploy/postfix/package-linux.ts','--output',output],{cwd:root,encoding:'utf8'});
 assert.notEqual(again.status,0,'an existing output directory must not be overwritten');
});
