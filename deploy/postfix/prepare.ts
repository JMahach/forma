import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { userInfo, homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { MAIL_POLICY } from '../../server/mail/policy.ts';

interface Instance {
  platform: 'darwin' | 'linux'; appUser: string; appUid: number; appGid: number;
  database: string; smtpPort: number; localMailboxPort?: number; dkimPort?: number; journalSocketPath?: string; daemonDirectory: string; mailOwner: string; setgidGroup: string;
}
const configuration = '/etc/forma-postfix', service = '/var/lib/forma-postfix';
const socket = '/var/lib/forma-postfix/run/control.sock';
const unixName = /^[a-z_][a-z0-9_-]{0,63}$/i;
const absolute = (value: string) => path.isAbsolute(value) && !/[\r\n\0]/.test(value);

/** Prepare data for the reviewed privileged installer; never start or change a system service. */
export function postfixConfiguration(options: Instance): Record<string, string> {
  if (!['darwin', 'linux'].includes(options.platform) || !unixName.test(options.appUser) || options.appUser === 'root'
    || !Number.isInteger(options.appUid) || options.appUid <= 0 || !Number.isInteger(options.appGid) || options.appGid < 0
    || !Number.isInteger(options.smtpPort) || options.smtpPort < 1024 || options.smtpPort > 65535
    || !absolute(options.database) || !absolute(options.daemonDirectory) || /\s/.test(options.daemonDirectory)
    || !unixName.test(options.mailOwner) || !unixName.test(options.setgidGroup)) throw new TypeError('Invalid Postfix instance');
  if (options.localMailboxPort !== undefined && (!Number.isInteger(options.localMailboxPort)
    || options.localMailboxPort < 1024 || options.localMailboxPort > 65535 || options.localMailboxPort === options.smtpPort))
    throw new TypeError('Invalid local mailbox port');
  if (options.dkimPort !== undefined && (!Number.isInteger(options.dkimPort) || options.dkimPort < 1024
    || options.dkimPort > 65535 || options.dkimPort === options.smtpPort || options.dkimPort === options.localMailboxPort))
    throw new TypeError('Invalid DKIM port');
  if(options.journalSocketPath!==undefined && !absolute(options.journalSocketPath))throw new TypeError('Invalid journal socket');
  const main: Record<string, string | number> = {
    compatibility_level: 2, queue_directory: '/var/spool/forma-postfix', data_directory: `${service}/data`,
    daemon_directory: options.daemonDirectory, command_directory: '/usr/sbin',
    mail_owner: options.mailOwner, setgid_group: options.setgidGroup,
    myhostname: 'mail.juxtaposition.ru', myorigin: 'juxtaposition.ru', mydestination: '', relay_domains: '',
    inet_interfaces: 'loopback-only', inet_protocols: 'all', mynetworks: '127.0.0.1/32 [::1]/128',
    smtpd_relay_restrictions: 'permit_mynetworks, reject',
    smtpd_recipient_restrictions: `check_recipient_access regexp:${configuration}/recipient-access, permit_mynetworks, reject`,
    smtpd_end_of_data_restrictions: 'check_client_access static:HOLD',
    smtpd_discard_ehlo_keywords: '', smtp_discard_ehlo_keywords: 'dsn',
    transport_maps: `regexp:${configuration}/transports`,
    local_transport: 'error:5.1.1 This service has no mailboxes',
    defer_transports: 'smtp', maximal_queue_lifetime: `${MAIL_POLICY.lifetimeMs / 1000}s`,
    bounce_queue_lifetime: `${MAIL_POLICY.lifetimeMs / 1000}s`,
    minimal_backoff_time: `${MAIL_POLICY.retryMs / 1000}s`, maximal_backoff_time: `${MAIL_POLICY.retryMs / 1000}s`,
    queue_run_delay: `${MAIL_POLICY.retryMs / 1000}s`, transport_retry_time: `${MAIL_POLICY.retryMs / 1000}s`,
    smtp_tls_security_level: 'encrypt', smtp_tls_mandatory_ciphers: 'high',
    smtp_tls_mandatory_protocols: '!SSLv2, !SSLv3, !TLSv1, !TLSv1.1', smtp_tls_loglevel: 0,
    smtp_connect_timeout: '10s', smtp_helo_timeout: '10s', smtp_starttls_timeout: '10s',
    smtp_mail_timeout: '10s', smtp_rcpt_timeout: '10s', smtp_data_init_timeout: '10s',
    smtp_data_xfer_timeout: '30s', smtp_data_done_timeout: '30s',
    smtputf8_enable: 'yes', message_size_limit: 65536, bounce_size_limit: 65536,
    smtpd_recipient_limit: 1, default_process_limit: 20, forma_receipt_destination_recipient_limit: 1,
    disable_vrfy_command: 'yes', biff: 'no', append_dot_mydomain: 'no',
    syslog_name: 'forma-postfix', syslog_facility: 'local7',
  };
  // Explicit development destination: a stopped receiver defers mail locally,
  // never falls back to delivery through the recipient domain. Native receipts
  // retain their more-specific local transport.
  if (options.localMailboxPort !== undefined) main.relayhost = `[127.0.0.1]:${options.localMailboxPort}`;
  // Sign the application's SMTP submissions before HOLD; native local receipts
  // do not leave the server and must not depend on the signing service.
  if (options.dkimPort !== undefined) {
    main.smtpd_milters = `inet:127.0.0.1:${options.dkimPort}`;
    main.milter_protocol = 6;
    main.milter_default_action = 'tempfail';
    main.milter_connect_timeout = '2s';
    main.milter_command_timeout = '3s';
    main.milter_content_timeout = '3s';
  }
  if (options.platform === 'darwin') {
    main.import_environment = 'MAIL_CONFIG MAIL_DEBUG MAIL_LOGTAG TZ XAUTHORITY DISPLAY LANG=C OS_ACTIVITY_MODE';
    main.export_environment = 'TZ MAIL_CONFIG LANG OS_ACTIVITY_MODE';
  }
  const master = `127.0.0.1:${options.smtpPort} inet n - n - - smtpd
pickup unix n - n 60 1 pickup
cleanup unix n - n - 0 cleanup
qmgr unix n - n 60 1 qmgr
tlsmgr unix - - n 1000? 1 tlsmgr
rewrite unix - - n - - trivial-rewrite
bounce unix - - n - 0 bounce
defer unix - - n - 0 bounce
trace unix - - n - 0 bounce
verify unix - - n - 1 verify
flush unix n - n 1000? 0 flush
smtp unix - - n - - smtp
  -o daemon_timeout=30s
showq unix n - n - - showq
error unix - - n - - error
retry unix - - n - - error
discard unix - - n - - discard
scache unix - - n - 1 scache
anvil unix - - n - 1 anvil
proxymap unix - - n - - proxymap
proxywrite unix - - n - 1 proxymap
forma_receipt unix - n n - 1 pipe
  flags=X user=${options.appUser} null_sender=<> argv=/usr/bin/python3 ${service}/libexec/receipt.py --config ${configuration}/control.json --sender ${'$'}{sender}
`;
  const control = { postfixConfig: configuration, socketPath: socket, clientUid: options.appUid, clientGid: options.appGid,
    database: options.database, mailLifetimeMs: MAIL_POLICY.lifetimeMs, cleanupIntervalMs: MAIL_POLICY.cleanupMs / 4,
    startPostfix: true, ...(options.journalSocketPath===undefined?{}:{journalSocketPath:options.journalSocketPath}) };
  const files: Record<string, string> = {
    'main.cf': Object.entries(main).map(([key, value]) => `${key} = ${value}\n`).join(''), 'master.cf': master,
    'transports': '/^forma@juxtaposition\\.ru$/ forma_receipt:\n',
    'recipient-access': '/^forma@juxtaposition\\.ru$/ REJECT This address accepts native local receipts only\n',
    'control.json': JSON.stringify(control, null, 2) + '\n',
    'environment': `FORMA_POSTFIX_SOCKET=${socket}\nFORMA_POSTFIX_PORT=${options.smtpPort}\n`,
  };
  if (options.platform === 'darwin') {
    files['asl-rule'] = '? [= Facility local7] [A= Sender forma-postfix/] ignore\n';
    files['ru.juxtaposition.forma-postfix.plist'] = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>ru.juxtaposition.forma-postfix</string>
<key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>${service}/libexec/control.py</string><string>--config</string><string>${configuration}/control.json</string></array>
<key>EnvironmentVariables</key><dict><key>OS_ACTIVITY_MODE</key><string>disable</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n`;
  } else {
    files['forma-postfix.service'] = `[Unit]
Description=Forma private Postfix queue
After=network.target
[Service]
Type=simple
ExecStart=/usr/bin/python3 ${service}/libexec/control.py --config ${configuration}/control.json
Restart=always
RestartSec=5
TimeoutStopSec=30
LogFilterPatterns=~.*
StandardOutput=null
StandardError=null
[Install]
WantedBy=multi-user.target
`;
  }
  return files;
}

async function prepare() {
  const { values } = parseArgs({ options: { output: { type: 'string' }, database: { type: 'string' }, port: { type: 'string', default: '2525' }, 'local-mailbox-port': { type: 'string' }, 'dkim-port': { type: 'string' }, 'journal-socket': {type:'string'} } });
  if (!values.output || !path.isAbsolute(values.output)) throw new Error('Provide an absolute --output directory');
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('Unsupported platform');
  const user = userInfo();
  const native = (key: string) => execFileSync('/usr/sbin/postconf', ['-d', '-h', key], { encoding: 'utf8' }).trim();
  const files = postfixConfiguration({ platform: process.platform, appUser: user.username, appUid: user.uid, appGid: user.gid,
    database: values.database ?? path.join(process.env.FORMA_STATE_DIR ?? path.join(homedir(), '.local/share/forma'), 'forma.sqlite'),
    smtpPort: Number(values.port),
    ...(values['journal-socket']===undefined?{}:{journalSocketPath:values['journal-socket']}),
    ...(values['dkim-port'] === undefined ? {} : {dkimPort:Number(values['dkim-port'])}),
    ...(values['local-mailbox-port'] === undefined ? {} : {localMailboxPort:Number(values['local-mailbox-port'])}), daemonDirectory: native('daemon_directory'), mailOwner: native('mail_owner'), setgidGroup: native('setgid_group') });
  await mkdir(values.output, { mode: 0o700 });
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(values.output, name), content, { mode: 0o600, flag: 'wx' });
  // macOS can deny the privileged installer access to a checkout in Documents.
  // Stage only this service's three programs beside its reviewed configuration.
  for (const name of ['install.py', 'control.py', 'receipt.py']) {
    await writeFile(path.join(values.output, name), await readFile(new URL(name, import.meta.url)), { mode: 0o600, flag: 'wx' });
  }
  for (const flag of ['-n', '-M']) execFileSync('/usr/sbin/postconf', ['-c', values.output, flag], { stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`Prepared Postfix settings in ${values.output}. No system files or running services changed.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await prepare();
