import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectImports } from '../scripts/architecture/collect-imports.mjs';
import { main as checkBoundaries } from '../scripts/architecture/check-boundaries.mjs';
import { pythonExecutable } from '../server/runtime/python.ts';

const productRoot = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(productRoot, 'scripts/architecture/python-import-graph.py');
const policy = JSON.parse(fs.readFileSync(path.join(productRoot, 'scripts/architecture/architecture-boundaries.json'), 'utf8'));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forma-deployment-graph-fixture-'));
  for (const name of ['src', 'shared', 'server', 'deploy/postfix']) fs.mkdirSync(path.join(root, name), { recursive: true });
  return root;
}

test('the compiler sees deployment code and its type cycles without executing it', async () => {
  const root = fixture();
  try {
    fs.symlinkSync(path.join(productRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      allowImportingTsExtensions: true, noEmit: true, verbatimModuleSyntax: true,
    }}));
    fs.writeFileSync(path.join(root, 'server/a.ts'), "import type { B } from '../deploy/postfix/b.ts'; export interface A { b: B }");
    fs.writeFileSync(path.join(root, 'deploy/postfix/b.ts'), "import type { A } from '../../server/a.ts'; export interface B { a: A }; throw new Error('do not execute');");
    const { report } = await collectImports(root, path.join(root, 'evidence'));
    assert.deepEqual(report.nodes.map((node: {file: string}) => node.file).sort(), ['deploy/postfix/b.ts', 'server/a.ts']);
    assert.deepEqual(report.outOfScope, []);
    assert.deepEqual(report.graphs.runtime.cyclicScc, []);
    assert.deepEqual(report.graphs.full.cyclicScc, [['deploy/postfix/b.ts', 'server/a.ts']]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Python deployment files and live files missing from an old report cannot escape the boundary check', () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'server/a.py'), 'from deploy.postfix import control\nraise RuntimeError("do not execute")\n');
    fs.writeFileSync(path.join(root, 'deploy/postfix/control.py'), 'from server import a\nraise RuntimeError("do not execute")\n');
    const pythonPath = path.join(root, 'python.json');
    const run = spawnSync(pythonExecutable(productRoot), [script, '--root', root, '--output', pythonPath], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const python = JSON.parse(fs.readFileSync(pythonPath, 'utf8'));
    assert.deepEqual(python.files.map((file: {path: string}) => file.path), ['deploy/postfix/control.py', 'server/a.py']);
    assert.deepEqual(python.stronglyConnectedComponents.cyclicComponents, [['deploy/postfix/control.py', 'server/a.py']]);

    // An older report can omit a newly added runtime file: compare with live disk,
    // not merely with the files that the collector happened to report.
    python.files = python.files.filter((file: {path: string}) => file.path !== 'deploy/postfix/control.py');
    python.imports = []; python.edges = [];
    fs.writeFileSync(pythonPath, JSON.stringify(python));
    const tsPath = path.join(root, 'typescript.json'), resultPath = path.join(root, 'result.json');
    fs.writeFileSync(tsPath, JSON.stringify({root, nodes: [], imports: []}));
    const localPolicy = {...policy, modules: [], python: {...policy.python, modules: []}};
    const policyPath = path.join(root, 'policy.json'); fs.writeFileSync(policyPath, JSON.stringify(localPolicy));
    assert.equal(checkBoundaries([policyPath, tsPath, resultPath, pythonPath]), 1);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.ok(result.integrity.some((issue: {code: string; file: string}) =>
      issue.code === 'python_graph_missing_live_file' && issue.file === 'deploy/postfix/control.py'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the Python collector reads the shared declaration under a non-UTF-8 process locale', () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'deploy/postfix/control.py'), 'import json\n');
    const output = path.join(root, 'python.json');
    const run = spawnSync(pythonExecutable(productRoot), ['-X', 'utf8=0', script, '--root', root, '--output', output], {
      encoding: 'utf8', env: {...process.env, LC_ALL: 'C', PYTHONCOERCECLOCALE: '0'},
    });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(report.summary.files, 1);
    assert.equal(report.files[0].path, 'deploy/postfix/control.py');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
