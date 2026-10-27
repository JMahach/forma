import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectImports } from '../scripts/architecture/collect-imports.mjs';

const productRoot = fileURLToPath(new URL('../', import.meta.url));

test('the compiler graph includes types, re-exports and literal dynamic imports without executing code', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'forma-graph-fixture-'));
  const root = path.join(temporary, 'project');
  try {
    for (const name of ['src', 'shared', 'server']) fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.symlinkSync(path.join(productRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      allowImportingTsExtensions: true, noEmit: true, verbatimModuleSyntax: true,
    }}));
    fs.writeFileSync(path.join(root, 'src/a.ts'), `
      import type { B } from './b.ts';
      export interface A { b: B }
      export { value } from './c.ts';
      const message = "import './not-a-module.ts'";
      // import './also-not-a-module.ts';
      void import('./c.ts');
    `);
    fs.writeFileSync(path.join(root, 'src/b.ts'), `
      import type { A } from './a.ts';
      export interface B { a: A }
    `);
    fs.writeFileSync(path.join(root, 'src/c.ts'), 'throw new Error("product code must not execute"); export const value = 1;');
    const { report } = await collectImports(root, path.join(temporary, 'report'));
    assert.deepEqual(report.missingAst, []);
    assert.deepEqual(report.unresolved, []);
    assert.deepEqual(report.syntaxDiagnostics, []);
    assert.deepEqual(report.graphs.runtime.cyclicScc, []);
    assert.deepEqual(report.graphs.full.cyclicScc, [['src/a.ts', 'src/b.ts']]);
    assert.ok(report.imports.some((edge: { kind: string; to: string; specifier: string }) => edge.kind === 're-export' && edge.to === 'src/c.ts'));
    assert.ok(report.imports.some((edge: { kind: string; to: string; specifier: string }) => edge.kind === 'dynamic-import' && edge.to === 'src/c.ts'));
    assert.ok(!report.imports.some((edge: { kind: string; to: string; specifier: string }) => edge.specifier.includes('not-a-module')));
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'declare const destination: string; void import(destination);');
    const unknown = await collectImports(root, path.join(temporary, 'unknown'));
    assert.equal(unknown.report.untraceableDynamicImports.length, 1);
    assert.equal(unknown.report.untraceableDynamicImports[0].expression, 'destination');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
