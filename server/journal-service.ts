import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createJournalWriter} from './journal/writer.ts';
import {createServiceInput,serviceSocketPath,SERVICE_INPUT_RESERVED_BYTES} from './journal/service-input.ts';
import {createSystemSource,SYSTEM_SOURCE_RESERVED_BYTES,type SystemSourceOptions} from './journal/system-source.ts';
import {JOURNAL_CLIENT_RESERVED_BYTES} from './journal/writer-client.ts';
import {createServerReporter} from './journal/report.ts';
import {MAIL_BUFFER_LIMITS} from './journal/mail-buffer.ts';
import {DIAGNOSTIC_HTTP_RESERVED_BYTES} from './http/diagnostics.ts';
import {journalEnvironment,journalWriterMode} from './runtime/journal-environment.ts';
import {pythonExecutable} from './runtime/python.ts';

// One archive budget includes every existing producer's reserved data, including
// the application's separate terminal-mail buffer. This is not process RSS.
export const JOURNAL_EXTERNAL_RESERVED_BYTES=MAIL_BUFFER_LIMITS.reservedBytes+DIAGNOSTIC_HTTP_RESERVED_BYTES
 +SERVICE_INPUT_RESERVED_BYTES+JOURNAL_CLIENT_RESERVED_BYTES+SYSTEM_SOURCE_RESERVED_BYTES;

interface JournalServiceOptions {
 directory:string;environment:'stand'|'production';now?:()=>number;source?:SystemSourceOptions;
}
class JournalServiceOwner {
 private options:JournalServiceOptions;
 private writer:ReturnType<typeof createJournalWriter>;
 private input:ReturnType<typeof createServiceInput>|undefined;
 private adapter:ReturnType<typeof createSystemSource>|undefined;
 private closing:Promise<void>|undefined;
 private finish!:(status:0|1)=>void;
 readonly stopped=new Promise<0|1>(resolve=>{this.finish=resolve;});
 readonly ready:Promise<boolean>;
 constructor(options:JournalServiceOptions) {
  this.options=options;
  this.writer=createJournalWriter({directory:path.join(options.directory,'archive'),now:options.now,
   externalReservedBytes:JOURNAL_EXTERNAL_RESERVED_BYTES});
  this.ready=this.start();void this.writer.failed.then(()=>this.stop(true));
 }
 private failedStart() {void this.stop(true);return false;}
 private async startSource(source:SystemSourceOptions) {
  this.adapter=createSystemSource({...source,writerPath:serviceSocketPath(this.options.directory)});
  void this.adapter.stopped.then(()=>this.stop(true));
  return !await this.adapter.ready || this.closing?this.failedStart():true;
 }
 private async start() {
  if(!await this.writer.ready || this.closing)return this.failedStart();
  const {directory,environment,now,source}=this.options;
  this.input=createServiceInput({directory,writer:this.writer,
   report:createServerReporter({environment,now,write:this.writer.write})});
  if(!await this.input.ready || this.closing)return this.failedStart();
  return source?this.startSource(source):true;
 }
 private async dispose() {
  let deadline:NodeJS.Timeout|undefined;
  try {
   await this.adapter?.close();await this.input?.close();
   await Promise.race([this.writer.drain(),new Promise<void>(resolve=>{deadline=setTimeout(resolve,5000);})]);
  }finally{if(deadline)clearTimeout(deadline);await this.writer.close();}
 }
 private stop(failed=false):Promise<void> {
  if(!this.closing)this.closing=this.dispose().then(()=>this.finish(failed?1:0),()=>this.finish(1));
  return this.closing;
 }
 close(){return this.stop();}
 usage(){return this.writer.usage();}
}
export function createJournalService(options:JournalServiceOptions) {
 const owner=new JournalServiceOwner(options);
 return {ready:owner.ready,stopped:owner.stopped,close:owner.close.bind(owner),usage:owner.usage.bind(owner)};
}

if(import.meta.main) {
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 try{process.loadEnvFile(path.join(root,'.env'));}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(journalWriterMode(process.env)!=='external')throw new TypeError('Journal service requires external writer mode');
 const configuration=journalEnvironment(process.env,process.env.FORMA_STATE_DIR??path.join(root,'.state'));
 const socketPath=process.env.FORMA_JOURNAL_NGINX_SOCKET;
 if(configuration.environment==='production' && !socketPath)throw new TypeError('Production journal requires FORMA_JOURNAL_NGINX_SOCKET');
 const service=createJournalService({...configuration,...(socketPath?{source:{python:pythonExecutable(root),
  script:path.join(root,'server/python/system_journal.py'),socketPath}}:{})});
 const stop=()=>{void service.close();};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
 if(!await service.ready)await service.close();
 process.exitCode=await service.stopped;
 process.off('SIGTERM',stop);process.off('SIGINT',stop);
}
