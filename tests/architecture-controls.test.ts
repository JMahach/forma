import test from 'node:test';
import assert from 'node:assert/strict';
import { checkContour, tarjan } from '../scripts/architecture/check-boundaries.mjs';

const moduleOwner = (files: string[]) => ({
  id: 'owner', files, publicEntries: files, allowRuntime: ['owner'], allowTypes: ['owner'],
});
const edge = (from: string, to: string, typeOnly = false) => ({
  from, to, line: 1, kind: 'import-declaration', typeOnly, runtime: !typeOnly, resolution: 'internal',
});

test('file cycles remain violations when Python files share one owner', () => {
  const files = ['server/python/a.py', 'server/python/b.py'];
  const result = checkContour({ contour: 'python', files, modules: [moduleOwner(files)],
    imports: [edge(files[0], files[1]), edge(files[1], files[0])] });
  assert.deepEqual(result.graphs.full.cyclicScc, []);
  assert.ok(result.violations.some((v: {code: string; contour: string; files?: string[]}) =>
    v.code === 'file_cycle' && v.contour === 'python' && v.files?.length === 2),
  'Grouping files under one owner must not hide a Python file cycle');
});

test('file cycles through types remain violations inside a TypeScript owner', () => {
  const files = ['src/scene/a.ts', 'src/scene/b.ts'];
  const result = checkContour({ files, modules: [moduleOwner(files)],
    imports: [edge(files[0], files[1]), edge(files[1], files[0], true)] });
  assert.ok(result.violations.some((v: {code: string; scope?: string}) => v.code === 'file_cycle' && v.scope === 'full'));
  assert.ok(!result.violations.some((v: {code: string; scope?: string}) => v.code === 'file_cycle' && v.scope === 'runtime'));
});

test('self imports are file cycles even with one allowed owner', () => {
  const files = ['src/a.ts'];
  const result = checkContour({ files, modules: [moduleOwner(files)], imports: [edge(files[0], files[0])] });
  assert.ok(result.violations.some((v: {code: string}) => v.code === 'file_cycle'));
});

test('a one-way internal dependency remains valid', () => {
  const files = ['src/a.ts', 'src/b.ts'];
  const result = checkContour({ files, modules: [moduleOwner(files)], imports: [edge(files[0], files[1])] });
  assert.deepEqual(result.violations, []);
});

test('the shared Tarjan implementation retains isolated nodes and self loops', () => {
  assert.deepEqual(tarjan(['a', 'b', 'c'], [['a', 'b'], ['b', 'a'], ['c', 'c']]).cyclicScc,
    [['a', 'b'], ['c']]);
  assert.deepEqual(tarjan(['a', 'b'], []).scc, [['a'], ['b']]);
});


test('an approved package is restricted to its exact adapter and owner', () => {
  const files = ['server/mail/message.ts', 'server/mail/other.ts', 'src/view.ts'];
  const modules = [
    { id: 'mail', files: files.slice(0, 2), publicEntries: [], allowRuntime: ['mail'], allowTypes: ['mail'] },
    { id: 'view', files: files.slice(2), publicEntries: [], allowRuntime: ['view'], allowTypes: ['view'] },
  ];
  const externalPolicy = { nodeBuiltinsAllowedFrom: ['mail'], packages: [
    { owner: 'mail', from: files[0], specifier: 'mailer', reason: 'MIME encoding at the mail boundary' },
  ] };
  function rejected(from: string, specifier: string, owners = modules) {
    const imports = [{ from, to: specifier, specifier, resolution: 'external', runtime: true, typeOnly: false }];
    return checkContour({ files, modules: owners, imports, externalPolicy }).violations
      .some((v: { code: string }) => v.code === 'unclassified_external_dependency');
  }
  assert.equal(rejected(files[0], 'mailer'), false, 'the declared adapter may use the approved package');
  assert.equal(rejected(files[1], 'mailer'), true, 'a sibling file receives no implicit package access');
  assert.equal(rejected(files[2], 'mailer'), true, 'the browser receives no package access');
  assert.equal(rejected(files[0], 'mailer/private'), true, 'subpaths are not a wildcard');
  assert.equal(rejected(files[0], 'unknown-package'), true);
  assert.equal(rejected(files[0], 'node:fs'), false);
  assert.equal(rejected(files[2], 'node:fs'), true);
  const moved = [
    { ...modules[0], files: [files[1]] },
    { ...modules[1], files: [files[0], files[2]] },
  ];
  assert.equal(rejected(files[0], 'mailer', moved), true, 'moving a file to another owner does not preserve the grant');
});

test('product composition can report through the journal facade but cannot reach its queue or sender',async()=>{
 const {readFile}=await import('node:fs/promises');
 const policy=JSON.parse(await readFile(new URL('../scripts/architecture/architecture-boundaries.json',import.meta.url),'utf8'));
 const files=policy.modules.flatMap((owner:{files:string[]})=>owner.files);
 const check=(to:string)=>checkContour({files,modules:policy.modules,imports:[edge('src/app.ts',to)],exceptions:policy.exactExceptions});
 assert.deepEqual(check('src/journal.ts').violations,[]);
 for(const file of ['src/data/diagnostic-queue.ts','src/data/diagnostic-delivery.ts','src/data/diagnostic-client.ts','src/diagnostics/client-reports.ts'])
  assert.ok(check(file).violations.some((violation:{code:string})=>violation.code==='private_entry'),file+' must stay behind the journal facade');
});

test('server sources report through the facade without importing journal runtime or storage',async()=>{
 const {readFile}=await import('node:fs/promises');
 const policy=JSON.parse(await readFile(new URL('../scripts/architecture/architecture-boundaries.json',import.meta.url),'utf8'));
 const files=policy.modules.flatMap((owner:{files:string[]})=>owner.files);
 for(const from of ['server/http/app.ts','server/http/accounts.ts','server/services/lifetime.ts']) {
  const check=(to:string,typeOnly=false)=>checkContour({files,modules:policy.modules,imports:[edge(from,to,typeOnly)],exceptions:policy.exactExceptions});
  for(const typeOnly of [false,true]) {
   assert.deepEqual(check('server/journal/report.ts',typeOnly).violations,[]);
   for(const to of ['server/journal/runtime.ts','server/journal/writer.ts','server/journal/store.ts','server/journal/mail-buffer.ts'])
    assert.ok(check(to,typeOnly).violations.some((v:{code:string})=>['private_entry','forbidden_import'].includes(v.code)),from+' must not own '+to);
  }
 }
});

test('chart records may share a pending job without owning physical workers or the queue',async()=>{
 const {readFile}=await import('node:fs/promises');
 const policy=JSON.parse(await readFile(new URL('../scripts/architecture/architecture-boundaries.json',import.meta.url),'utf8'));
 const files=policy.modules.flatMap((owner:{files:string[]})=>owner.files);
 for(const typeOnly of [false,true]) {
  const check=(to:string)=>checkContour({files,modules:policy.modules,imports:[edge('server/services/chart-records.ts',to,typeOnly)],exceptions:policy.exactExceptions});
  assert.deepEqual(check('server/runtime/job-consumers.ts').violations,[]);
  for(const to of ['server/runtime/calculator-workers.ts','server/runtime/compute-queue.ts','server/runtime/json-worker.ts'])
   assert.ok(check(to).violations.some((v:{code:string})=>v.code==='forbidden_import'));
 }
});
