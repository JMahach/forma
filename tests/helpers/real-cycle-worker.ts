import type { TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pythonExecutable, pythonEnvironment } from '../../server/runtime/python.ts';
import { generateCycles } from '../../server/services/cycles.ts';

// Real bounded ephemeris fixture, independent of an ignored workstation-wide
// 600-year index. No expected events, winding numbers or validation are mocked.
export async function realCycleWorker(t: TestContext) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forma-cycle-worker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const index = path.join(directory, 'returns.bin');
  await promisify(execFile)(pythonExecutable(root), ['-c',
    'import sys; from server.python import return_index as r, astronomy as a, cycles as c; r.prepare_index(sys.argv[1],start=a.julian_tt(c.parse_utc("1999-01-01T00:00:00Z")),end=a.julian_tt(c.parse_utc("2031-01-01T00:00:00Z")),bodies=("saturn",))', index],
    { cwd: root, env: pythonEnvironment() });
  const spawnWorker: typeof spawn = (command, args, options) => spawn(command, ['-c',
    'import sys,runpy,pathlib; sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent)); import return_index; return_index.DEFAULT_FILE=pathlib.Path(sys.argv[2]); runpy.run_path(sys.argv[1],run_name="__main__")', args![0], index], options!);
  const generate = (input: Parameters<typeof generateCycles>[0]['input'], options: { signal?: AbortSignal } = {}) =>
    generateCycles({ root, input, ...options, spawnWorker });
  return { root, spawnWorker, generate };
}
