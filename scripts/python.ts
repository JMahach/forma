import { spawn } from 'node:child_process';
import path from 'node:path';
import { accountEnvironment } from '../server/runtime/account-environment.ts';
import { journalEnvironment } from '../server/runtime/journal-environment.ts';
import { reportServiceFailure, serviceSocketPath } from '../server/journal/service-input.ts';
import { fileURLToPath } from 'node:url';
import { pythonExecutable, pythonEnvironment } from '../server/runtime/python.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
try { process.loadEnvFile(path.join(root,'.env')); }
catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
const args=process.argv.slice(2);
const component=args[0]==='-m' && args[1]==='server.python.lifetime_file' ? 'lifetime_prepare'
  :args[0]==='-m' && args[1]==='server.python.return_index' ? 'return_index_prepare':null;
let reported=false;
async function report(reason:'spawn'|'process') {
  if(!component || reported)return;reported=true;
  try {
    const state=accountEnvironment(process.env,3636).stateDir;
    await reportServiceFailure(serviceSocketPath(journalEnvironment(process.env,state).directory),{component,reason});
  } catch { /* A diagnostic failure must preserve the preparation exit status. */ }
}
const child = spawn(pythonExecutable(root), args, { cwd: root, stdio: 'inherit', env: pythonEnvironment() });
child.on('error', error => {
  console.error(`Не удалось запустить Python из .venv: ${error.message}`);
  process.exitCode = 1;void report('spawn');
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
  if(process.exitCode && !['SIGINT','SIGTERM'].includes(signal??'') && code!==130 && code!==143)void report('process');
});
