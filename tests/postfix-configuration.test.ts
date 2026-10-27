import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { postfixConfiguration } from '../deploy/postfix/prepare.ts';
import { MAIL_POLICY } from '../server/mail/policy.ts';

const options = { platform: 'darwin' as const, appUser: 'example', appUid: 501, appGid: 20,
  database: '/Users/example/Library/Application Support/forma/forma.sqlite', smtpPort: 2525,
  daemonDirectory: '/usr/libexec/postfix', mailOwner: '_postfix', setgidGroup: '_postdrop' };

test('the instance holds submissions, requires outbound TLS and routes native receipts locally', () => {
  const config = postfixConfiguration(options);
  assert.match(config['main.cf']!, /smtp_tls_security_level = encrypt/);
  assert.match(config['main.cf']!, /defer_transports = smtp/);
  assert.match(config['main.cf']!, /smtp_discard_ehlo_keywords = dsn/);
  assert.match(config['main.cf']!, /maximal_queue_lifetime = 300s/);
  assert.match(config['master.cf']!, /^127\.0\.0\.1:2525 inet/m);
  assert.match(config['master.cf']!, /null_sender=<>/);
  assert.match(config['master.cf']!, /user=example/);
  assert.match(config['recipient-access']!, /REJECT/);
  const control = JSON.parse(config['control.json']!);
  assert.equal(control.database, options.database);
  assert.equal(control.mailLifetimeMs, MAIL_POLICY.lifetimeMs);
  assert.equal(control.cleanupIntervalMs, MAIL_POLICY.cleanupMs / 4);
});

test('unsupported root execution and configuration injection are rejected before writing', () => {
  for (const override of [{ appUid: 0 }, { appUser: 'root' }, { appUser: 'a\nexec' },
    { smtpPort: 25 }, { database: 'relative.sqlite' }, { daemonDirectory: '/tmp/x\nother=y' }]) {
    assert.throws(() => postfixConfiguration({ ...options, ...override }));
  }
});

test('prepared platform rules cover both native log paths without a raw archive', () => {
  const mac = postfixConfiguration(options), linux = postfixConfiguration({ ...options, platform: 'linux' });
  assert.match(mac['main.cf']!, /import_environment = .*OS_ACTIVITY_MODE/);
  assert.match(mac['main.cf']!, /export_environment = .*OS_ACTIVITY_MODE/);
  assert.match(mac['ru.juxtaposition.forma-postfix.plist']!, /<key>OS_ACTIVITY_MODE<\/key><string>disable<\/string>/);
  assert.match(mac['asl-rule']!, /\[A= Sender forma-postfix\/\] ignore/);
  assert.match(linux['forma-postfix.service']!, /^LogFilterPatterns=~\.\*$/m);
  assert.doesNotMatch(linux['forma-postfix.service']!, /StandardOutput=(?:file|append):/);
});

test('the native Postfix parser accepts generated main and master settings', { skip: !existsSync('/usr/sbin/postconf') }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forma-postfix-config-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = postfixConfiguration({...options,dkimPort:8891});
  for (const name of ['main.cf', 'master.cf']) await writeFile(path.join(directory, name), config[name]!);
  for (const flag of ['-n', '-M']) {
    const result = execFileSync('/usr/sbin/postconf', ['-c', directory, flag], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(result.length);
  }
  assert.match(execFileSync('/usr/sbin/postconf', ['-c', directory, '-P', 'smtp/unix/daemon_timeout'], { encoding: 'utf8' }), /daemon_timeout\s*=\s*30s/);
});


test('prepared installer is self-contained outside Documents for the privileged Mac process',
  {skip: !existsSync('/usr/sbin/postconf') || process.getuid?.() === 0}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forma-postfix-installer-test-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const bundle = path.join(directory, 'bundle');
  execFileSync(process.execPath, ['deploy/postfix/prepare.ts', '--output', bundle], {stdio:['ignore','pipe','pipe']});
  for (const name of ['install.py', 'control.py', 'receipt.py']) {
    assert.deepEqual(await readFile(path.join(bundle, name)), await readFile(new URL('../deploy/postfix/' + name, import.meta.url)));
  }
  const help = execFileSync('/usr/bin/python3', [path.join(bundle, 'install.py'), '--help'],
    {cwd: directory, encoding:'utf8', stdio:['ignore','pipe','pipe']});
  assert.match(help, /--bundle/); assert.match(help, /--apply/);
});

test('local mailbox changes only delivery destination, retains TLS, receipts and queue policy',()=>{
 const local=postfixConfiguration({...options,localMailboxPort:1025});
 assert.match(local['main.cf']!,/^relayhost = \[127\.0\.0\.1\]:1025$/m);
 assert.match(local['main.cf']!,/^smtp_tls_security_level = encrypt$/m);
 assert.match(local['main.cf']!,/^defer_transports = smtp$/m);
 assert.equal(local['transports'],postfixConfiguration(options)['transports']);
 assert.doesNotMatch(postfixConfiguration(options)['main.cf']!,/^relayhost = /m);
 for(const localMailboxPort of [25,2525,65536,NaN])assert.throws(()=>postfixConfiguration({...options,localMailboxPort}));
});


test('explicit DKIM signs SMTP submissions and fails closed without changing the local mailbox', () => {
  const signed = postfixConfiguration({...options, platform:'linux', dkimPort:8891});
  assert.match(signed['main.cf']!, /^smtpd_milters = inet:127\.0\.0\.1:8891$/m);
  assert.match(signed['main.cf']!, /^milter_default_action = tempfail$/m);
  assert.match(signed['main.cf']!, /^milter_protocol = 6$/m);
  assert.match(signed['main.cf']!, /^smtpd_end_of_data_restrictions = check_client_access static:HOLD$/m);
  assert.doesNotMatch(signed['main.cf']!, /^non_smtpd_milters = /m);
  assert.doesNotMatch(postfixConfiguration({...options,localMailboxPort:1025})['main.cf']!, /smtpd_milters = /);
  for (const dkimPort of [25,2525,65536,NaN]) assert.throws(()=>postfixConfiguration({...options,dkimPort}));
  assert.throws(()=>postfixConfiguration({...options,localMailboxPort:1025,dkimPort:1025}));
});


test('service diagnostics receive only an explicit absolute private socket path',()=>{
 const signed=postfixConfiguration({...options,journalSocketPath:'/var/log/forma/run/services.sock'});
 assert.equal(JSON.parse(signed['control.json']!).journalSocketPath,'/var/log/forma/run/services.sock');
 assert.equal(JSON.parse(postfixConfiguration(options)['control.json']!).journalSocketPath,undefined);
 for(const journalSocketPath of ['relative.sock','/private\nvalue'])assert.throws(()=>postfixConfiguration({...options,journalSocketPath}));
});
