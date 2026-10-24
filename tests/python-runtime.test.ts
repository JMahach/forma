import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pythonExecutable } from '../server/runtime/python.ts';

test('the project virtual environment has the native executable layout on each platform', () => {
  const root = path.resolve('project with spaces');
  assert.equal(pythonExecutable(root, 'win32'), path.join(root, '.venv', 'Scripts', 'python.exe'));
  for (const platform of ['darwin', 'linux'] as const) {
    assert.equal(pythonExecutable(root, platform), path.join(root, '.venv', 'bin', 'python'));
  }
  assert.equal(pythonExecutable(root), pythonExecutable(root, process.platform));
});

const root = fileURLToPath(new URL('../', import.meta.url));
test('the maintenance launcher preserves Unicode arguments, UTF-8 output and Python exit status', {
  skip: !existsSync(pythonExecutable(root)) && 'Project Python environment is not installed',
}, async () => {
  const run = promisify(execFile), launcher = path.join(root, 'scripts/python.ts');
  const values = ['Москва', 'path with spaces', 'a"b'];
  const { stdout } = await run(process.execPath, [launcher, '-c',
    'import json,sys; print(json.dumps(sys.argv[1:],ensure_ascii=False))', ...values], { cwd: root });
  assert.deepEqual(JSON.parse(stdout), values);
  await assert.rejects(run(process.execPath, [launcher, '-c', 'raise SystemExit(7)'], { cwd: root }),
    (error: unknown) => (error as { code?: number }).code === 7);
});
