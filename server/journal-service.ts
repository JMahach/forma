import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createJournalWriter} from './journal/writer.ts';
import {createServiceInput,SERVICE_INPUT_RESERVED_BYTES} from './journal/service-input.ts';
import {JOURNAL_CLIENT_RESERVED_BYTES} from './journal/writer-client.ts';
import {createServerReporter} from './journal/report.ts';
import {MAIL_BUFFER_LIMITS} from './journal/mail-buffer.ts';
import {DIAGNOSTIC_HTTP_RESERVED_BYTES} from './http/diagnostics.ts';
import {journalEnvironment,journalWriterMode} from './runtime/journal-environment.ts';

// One archive budget includes every existing producer's reserved data, including
// the application's separate terminal-mail buffer. This is not process RSS.
export const JOURNAL_EXTERNAL_RESERVED_BYTES=MAIL_BUFFER_LIMITS.reservedBytes+DIAGNOSTIC_HTTP_RESERVED_BYTES
 +SERVICE_INPUT_RESERVED_BYTES+JOURNAL_CLIENT_RESERVED_BYTES;

export function createJournalService({directory,environment,now=Date.now}:{
 directory:string;environment:'stand'|'production';now?:()=>number;
}) {
 const writer=createJournalWriter({directory:path.join(directory,'archive'),now,externalReservedBytes:JOURNAL_EXTERNAL_RESERVED_BYTES});
 let input:ReturnType<typeof createServiceInput>|undefined,closing:Promise<void>|undefined,stopping=false;
 let finish!:(status:0|1)=>void;
 const stopped=new Promise<0|1>(resolve=>{finish=resolve;});
 function close(failed=false):Promise<void> {
  if(closing)return closing;stopping=true;
  closing=(async()=>{
   await input?.close();
   let deadline:NodeJS.Timeout|undefined;
   try{await Promise.race([writer.drain(),new Promise<void>(resolve=>{deadline=setTimeout(resolve,5000);})]);}
   finally{if(deadline)clearTimeout(deadline);await writer.close();finish(failed?1:0);}
  })();return closing;
 }
 const ready=(async()=>{
  if(!await writer.ready || stopping){void close(true);return false;}
  input=createServiceInput({directory,writer,report:createServerReporter({environment,now,write:writer.write})});
  if(!await input.ready || stopping){void close(true);return false;}
  return true;
 })();
 void writer.failed.then(()=>close(true));
 return {ready,stopped,close:()=>close(),usage:writer.usage};
}

if(import.meta.main) {
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 try{process.loadEnvFile(path.join(root,'.env'));}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(journalWriterMode(process.env)!=='external')throw new TypeError('Journal service requires external writer mode');
 const service=createJournalService(journalEnvironment(process.env,process.env.FORMA_STATE_DIR??path.join(root,'.state')));
 const stop=()=>{void service.close();};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
 if(!await service.ready)await service.close();
 process.exitCode=await service.stopped;
 process.off('SIGTERM',stop);process.off('SIGINT',stop);
}
