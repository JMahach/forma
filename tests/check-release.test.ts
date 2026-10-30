import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {checkRelease} from '../deploy/check-release.ts';

const revision='a'.repeat(40);
async function fixture(t: test.TestContext) {
  const root=await mkdtemp(path.join(tmpdir(),'forma-release-check-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const release=path.join(root,'release'),state=path.join(root,'state'),journal=path.join(root,'journal'),mail=path.join(root,'mail');
  for(const folder of ['server/python','dist','.venv/bin'])await mkdir(path.join(release,folder),{recursive:true});
  await mkdir(path.join(state,'keys'),{recursive:true,mode:0o700});await chmod(state,0o700);
  await mkdir(journal,{mode:0o700});await mkdir(mail,{mode:0o700});
  for(const file of ['server/server.ts','server/journal-service.ts','server/python/system_journal.py'])
    await writeFile(path.join(release,file),'// fixture');
  await writeFile(path.join(release,'package.json'),JSON.stringify({engines:{node:'24.x'}}));
  await writeFile(path.join(release,'.venv/bin/python'),'#!/bin/sh\n',{mode:0o700});
  await writeFile(path.join(state,'forma.sqlite'),'synthetic database',{mode:0o600});
  await writeFile(path.join(state,'keys/account-hmac.bin'),Buffer.alloc(32,1),{mode:0o600});
  const manifest: Record<string,unknown>={};
  for(const file of ['index.html','love.html','service-worker.js']) {
    manifest[file]={file,gzip:file+'.gz',br:file+'.br',immutable:false};
    for(const suffix of ['', '.gz', '.br'])await writeFile(path.join(release,'dist',file+suffix),'fixture');
  }
  manifest.love=manifest['love.html'];await writeFile(path.join(release,'dist/manifest.json'),JSON.stringify(manifest));
  const environmentFile=path.join(root,'environment'),mailEnvironmentFile=path.join(mail,'environment'),mailControlFile=path.join(mail,'control.json');
  await writeFile(environmentFile,`FORMA_APP_VERSION=${revision}\nFORMA_STATE_DIR=${state}\nFORMA_JOURNAL_DIR=${journal}\nFORMA_JOURNAL_WRITER=external\nFORMA_ENVIRONMENT=production\nFORMA_ACCOUNT_ORIGINS=https://juxtaposition.ru\nFORMA_TRUST_PROXY=loopback\n`,{mode:0o600});
  const socket=path.join(mail,'control.sock');
  await writeFile(mailEnvironmentFile,`FORMA_POSTFIX_SOCKET=${socket}\nFORMA_POSTFIX_PORT=2525\n`);
  const control={database:path.join(state,'forma.sqlite'),socketPath:socket,clientUid:process.getuid!(),journalSocketPath:path.join(journal,'run/services.sock')};
  await writeFile(mailControlFile,JSON.stringify(control));
  await writeFile(path.join(mail,'master.cf'),'127.0.0.1:2525 inet n - n - - smtpd\n');
  const options={release,environmentFile,mailEnvironmentFile,mailControlFile,revision,systemUid:process.getuid!(),accountUid:process.getuid!()};
  return {root,state,journal,control,options,async controlChange(change:object){await writeFile(mailControlFile,JSON.stringify({...control,...change}));},
    async envChange(text:string){await writeFile(environmentFile,(await readFile(environmentFile,'utf8'))+text+'\n');}};
}
test('release preflight joins existing owners without writing state, sending mail or changing the release',async t=>{
  const f=await fixture(t),before=await readFile(path.join(f.state,'forma.sqlite'));
  const result=await checkRelease(f.options);
  assert.equal(result.appVersion,revision);assert.equal(result.database,f.control.database);
  assert.equal(result.journal,f.journal);assert.equal(result.smtpPort,2525);
  assert.deepEqual(await readFile(path.join(f.state,'forma.sqlite')),before);
});
for(const field of ['database','socketPath','clientUid','journalSocketPath'])test(`release preflight rejects mismatched Postfix ${field}`,async t=>{
  const f=await fixture(t);await f.controlChange({[field]:field==='clientUid'?process.getuid!()+1:'/another/instance'});
  await assert.rejects(checkRelease(f.options),/Postfix/);
});
test('release preflight checks ownership against the service account, not just against Postfix',async t=>{
  const f=await fixture(t);
  await assert.rejects(checkRelease({...f.options,accountUid:f.options.accountUid+1}),/service account/);
  await assert.rejects(checkRelease({...f.options,accountUid:0}),/unprivileged/);
});
test('release preflight refuses hidden .env and an incorrectly labelled revision',async t=>{
  const f=await fixture(t);await f.envChange('FORMA_APP_VERSION=another');
  await assert.rejects(checkRelease(f.options),/revision/);
  await f.envChange('FORMA_APP_VERSION='+revision);await writeFile(path.join(f.options.release,'.env'),'FORMA_POSTFIX_PORT=9999');
  await assert.rejects(checkRelease(f.options),/\.env/);
});
test('release preflight refuses public state permissions and malformed private key',async t=>{
  const f=await fixture(t);await chmod(f.state,0o755);await assert.rejects(checkRelease(f.options),/private/);
  await chmod(f.state,0o700);await writeFile(path.join(f.state,'keys/account-hmac.bin'),'bad');
  await assert.rejects(checkRelease(f.options),/32-byte/);
});
test('release preflight refuses missing compressed assets and missing update worker',async t=>{
  const f=await fixture(t),file=path.join(f.options.release,'dist/index.html.br');
  await rm(file);await assert.rejects(checkRelease(f.options));await writeFile(file,'fixture');
  const manifest=path.join(f.options.release,'dist/manifest.json'),data=JSON.parse(await readFile(manifest,'utf8'));
  delete data['service-worker.js'];await writeFile(manifest,JSON.stringify(data));
  await assert.rejects(checkRelease(f.options),/worker/);
});
test('release preflight refuses insecure origins, dev mailbox and conflicting mail environment',async t=>{
  const f=await fixture(t);await f.envChange('FORMA_ACCOUNT_ORIGINS=http://juxtaposition.ru');
  await assert.rejects(checkRelease(f.options),/HTTPS/);
  await f.envChange('FORMA_ACCOUNT_ORIGINS=https://juxtaposition.ru\nFORMA_LOCAL_MAILBOX=1');
  await assert.rejects(checkRelease(f.options),/mailbox/);
  await f.envChange('FORMA_LOCAL_MAILBOX=0');await writeFile(f.options.mailEnvironmentFile,'FORMA_STATE_DIR=/other\n');
  await assert.rejects(checkRelease(f.options),/mail environment/);
});
test('release preflight checks the actual SMTP listener in the installed instance',async t=>{
  const f=await fixture(t);await writeFile(path.join(path.dirname(f.options.mailControlFile),'master.cf'),'127.0.0.1:2526 inet n - n - - smtpd\n');
  await assert.rejects(checkRelease(f.options),/SMTP/);
});

test('release preflight requires the independently owned journal writer',async t=>{
 const f=await fixture(t);await f.envChange('FORMA_JOURNAL_WRITER=embedded');
 await assert.rejects(checkRelease(f.options),/external writer/);
});

test('release preflight rejects a journal source path that disagrees with nginx',async t=>{
 const f=await fixture(t);await f.envChange('FORMA_JOURNAL_NGINX_SOCKET=/other/nginx.sock');
 await assert.rejects(checkRelease(f.options),/match the nginx template/);
});

test('release preflight requires the sole writer and its fixed system source',async t=>{
 const f=await fixture(t);await rm(path.join(f.options.release,'server/python/system_journal.py'));
 await assert.rejects(checkRelease(f.options),{code:'ENOENT'});
});
