#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectImports } from './collect-imports.mjs';
import { main as checkBoundaries } from './check-boundaries.mjs';
import { pythonExecutable } from '../../server/runtime/python.ts';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scripts, '../..');
const out = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'forma-architecture-'));
fs.mkdirSync(out, { recursive: true });
const { summary } = await collectImports(root, out);
console.log(JSON.stringify({ typescript: summary, outputDirectory: out }, null, 2));
const python = spawnSync(process.env.FORMA_ARCHITECTURE_PYTHON || pythonExecutable(root), [
  path.join(scripts, 'python-import-graph.py'), '--root', root,
  '--output', path.join(out, 'python-import-graph.json'),
], { cwd: root, encoding: 'utf8' });
if (python.error || python.status !== 0) {
  console.error(python.error?.message || python.stderr || python.stdout || 'Python graph collection failed');
  process.exitCode = 2;
} else {
  process.exitCode = checkBoundaries([
    path.join(scripts, 'architecture-boundaries.json'),
    path.join(out, 'typescript-import-graph.json'),
    path.join(out, 'boundary-check-result.json'),
    path.join(out, 'python-import-graph.json'),
  ]);
}
