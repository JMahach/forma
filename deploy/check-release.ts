/** Read-only release preflight. Never opens an account runtime, migrates a DB,
 * connects to SMTP, changes current, or installs services. */
import {access, lstat, readFile, realpath, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs,parseEnv} from 'node:util';
import {accountEnvironment} from '../server/runtime/account-environment.ts';
import {journalEnvironment,journalWriterMode} from '../server/runtime/journal-environment.ts';
import {pythonExecutable} from '../server/runtime/python.ts';
import {parseAccountOrigins} from '../server/http/account-security.ts';
import {readReleaseManifest} from '../server/http/public-files.ts';

interface Options {
  release:string; revision:string; environmentFile:string; mailEnvironmentFile:string; mailControlFile:string; accountUid:number;
  /** Tests use their own UID; the Linux CLI always requires root-owned configuration. */
  systemUid?:number;
}
async function protectedFile(filename:string,uid:number,privateFile=false) {
  const info=await lstat(filename);
  if(!info.isFile() || info.uid!==uid || info.mode & (privateFile?0o077:0o022))
    throw new Error('Expected protected regular file: '+filename);
  return info;
}
export async function checkRelease({release,revision,environmentFile,mailEnvironmentFile,mailControlFile,accountUid,systemUid=0}:Options) {
  if(!Number.isSafeInteger(accountUid) || accountUid<=0)throw new Error('Application account must have an unprivileged UID');
  if(!/^[a-f0-9]{40}$/.test(revision))throw new Error('Provide the full expected Git revision');
  release=await realpath(release);
  // server.ts loads this implicitly; production settings must come from the
  // reviewed system files, never an overlooked development checkout override.
  if(await lstat(path.join(release,'.env')).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))
    throw new Error('Release must not contain .env');
  for(const filename of [environmentFile,mailEnvironmentFile,mailControlFile])await protectedFile(filename,systemUid);
  const appEnv=parseEnv(await readFile(environmentFile,'utf8')),mailEnv=parseEnv(await readFile(mailEnvironmentFile,'utf8'));
  if(Object.keys(mailEnv).some(key=>!['FORMA_POSTFIX_SOCKET','FORMA_POSTFIX_PORT'].includes(key)))
    throw new Error('Unexpected settings in mail environment');
  const env:NodeJS.ProcessEnv={FORMA_STATE_DIR:'/var/lib/forma',FORMA_JOURNAL_DIR:'/var/log/forma',FORMA_ENVIRONMENT:'production',
    FORMA_TRUST_PROXY:'loopback',...appEnv,...mailEnv};
  if(env.FORMA_APP_VERSION!==revision)throw new Error('Application revision does not match the expected release');
  if(env.FORMA_LOCAL_MAILBOX && env.FORMA_LOCAL_MAILBOX!=='0')throw new Error('Development mailbox must be disabled');
  if(env.HOST && env.HOST!=='127.0.0.1' || env.PORT && env.PORT!=='4173')throw new Error('Release listener must match the nginx upstream');
  const accounts=accountEnvironment(env,4173),journal=journalEnvironment(env,accounts.stateDir);
  if(journalWriterMode(env)!=='external')throw new Error('Production requires an external writer for the journal');
  if(journal.environment!=='production' || !accounts.trustLoopbackProxy)throw new Error('Expected production environment behind loopback proxy');
  parseAccountOrigins(accounts.origins);
  if(!accounts.origins.length || accounts.origins.some(origin=>new URL(origin).protocol!=='https:'))throw new Error('Public account origins must use HTTPS');
  if(!accounts.postfix)throw new Error('Postfix must be configured explicitly');
  const control=JSON.parse(await readFile(mailControlFile,'utf8'));
  const database=path.join(accounts.stateDir,'forma.sqlite');
  // Reject mismatches before opening/migrating state or letting either owner
  // reconcile the native queue against the wrong account database.
  if(typeof control.database!=='string' || await realpath(control.database).catch(()=>null)!==await realpath(database)
    || control.socketPath!==accounts.postfix.controlSocket
    || control.journalSocketPath!==path.join(journal.directory,'run/services.sock'))
    throw new Error('Postfix database/socket/journal does not match the application');
  const dbInfo=await stat(database),uid=dbInfo.uid;
  if(uid!==accountUid || control.clientUid!==accountUid)throw new Error('Postfix client UID and database owner must match the forma service account');
  await protectedFile(database,uid,true);
  for(const directory of [accounts.stateDir,path.join(accounts.stateDir,'keys'),journal.directory]) {
    const info=await lstat(directory);
    if(!info.isDirectory() || info.uid!==uid || info.mode & 0o077)throw new Error('Expected private application directory: '+directory);
  }
  const key=await protectedFile(path.join(accounts.stateDir,'keys/account-hmac.bin'),uid,true);
  if(key.size!==32)throw new Error('Expected existing private 32-byte account key');
  const master=await readFile(path.join(path.dirname(mailControlFile),'master.cf'),'utf8');
  const listener=new RegExp('^127\\.0\\.0\\.1:'+accounts.postfix.smtpPort+'\\s+inet\\s+[^\\n]*\\bsmtpd\\s*$','m');
  if(!listener.test(master))throw new Error('Installed Postfix SMTP listener does not match application port');
  const pkg=JSON.parse(await readFile(path.join(release,'package.json'),'utf8'));
  if(pkg.engines?.node!=='24.x' || process.versions.node.split('.')[0]!=='24')throw new Error('Release requires Node 24');
  await access(path.join(release,'server/server.ts'),constants.R_OK);
  await access(pythonExecutable(release,'linux'),constants.X_OK);
  const manifest=await readReleaseManifest(path.join(release,'dist'));
  if(!manifest.has('service-worker.js'))throw new Error('Missing release update worker');
  return {release,appVersion:revision,database,accountUid:uid,journal:journal.directory,
    controlSocket:accounts.postfix.controlSocket,smtpPort:accounts.postfix.smtpPort,origins:accounts.origins,publicFiles:manifest.size};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {values}=parseArgs({options:{release:{type:'string'},revision:{type:'string'},environment:{type:'string',default:'/etc/forma/environment'},
    'mail-environment':{type:'string',default:'/etc/forma-postfix/environment'},'mail-control':{type:'string',default:'/etc/forma-postfix/control.json'}}});
  if(!values.release || !values.revision)throw new Error('Provide --release and --revision');
  if(process.platform!=='linux')throw new Error('This system preflight is for Linux');
  const accountUid=Number(execFileSync('id',['-u','forma'],{encoding:'utf8'}).trim());
  console.log(JSON.stringify(await checkRelease({release:values.release,revision:values.revision,environmentFile:values.environment,
    mailEnvironmentFile:values['mail-environment'],mailControlFile:values['mail-control'],accountUid}),null,2));
}
