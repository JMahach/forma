import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonExecutable, pythonEnvironment } from '../server/runtime/python.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const child = spawn(pythonExecutable(root), process.argv.slice(2), { cwd: root, stdio: 'inherit', env: pythonEnvironment() });
child.on('error', error => {
  console.error(`Не удалось запустить Python из .venv: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
