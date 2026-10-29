import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { collectImports } from '../scripts/architecture/collect-imports.mjs';
import { checkContour, externalImportAllowed } from '../scripts/architecture/check-boundaries.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_FILES } from '../server/http/public-files.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const files = (directory: string, pattern = /\.ts$/) => fs.readdirSync(path.join(root, directory), { recursive: true })
  .filter(file => pattern.test(file)).map(file => `${directory}/${file.split(path.sep).join('/')}`);
const policy = JSON.parse(source('scripts/architecture/architecture-boundaries.json'));
const loadingGenerator = 'src/scene/loading-placeholder.ts';
const sourceFiles = [...files('src'), ...files('shared')];
const hasRuntime = (file: string) => stripTypeScriptTypes(source(file), { mode: 'strip' }).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').trim();
const browserFiles = sourceFiles.filter(file => file !== loadingGenerator && hasRuntime(file));
const graphDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'forma-test-architecture-'));
let importEvidence;
try { importEvidence = (await collectImports(root, graphDirectory)).report; }
finally { fs.rmSync(graphDirectory, { recursive: true, force: true }); }
const graph = new Map([...sourceFiles, ...files('server')].map(file => [file, [] as string[]]));
for (const edge of importEvidence.imports) {
  if (edge.runtime) graph.get(edge.from)?.push(edge.to);
}
for (const file of files('shared', /\.json$/)) { JSON.parse(source(file)); graph.set(file, []); }
const pure = (file: string) => assert.doesNotMatch(source(file), /\b(?:document|window|localStorage|sessionStorage|indexedDB)\s*\.|\bfetch\s*\(/, `${file} must stay pure`);
const only = (file: string, roots: string[], exact = []) => {
  for (const dependency of graph.get(file)!) {
    const imported = importEvidence.imports.find(edge => edge.from === file && edge.to === dependency && edge.resolution === 'external');
    const owner = policy.modules.find((module: { files: string[] }) => module.files.includes(file))?.id;
    const declaredExternal = imported && externalImportAllowed(imported, owner, policy.externalPolicy);
    assert.ok(exact.includes(dependency) || roots.some((prefix: string) => dependency.startsWith(prefix)) || declaredExternal,
      `${file} must not import ${dependency}`);
  }
};

// Tests inspect the public pages, not a hand-maintained list of module entry points.
test('product literal imports resolve and runtime/type file graphs have no cycles', () => {
  assert.deepEqual(importEvidence.missingAst, [], 'all product files must be parsed');
  assert.deepEqual(importEvidence.syntaxDiagnostics, []);
  assert.deepEqual(importEvidence.changedDuringRead, [], 'checks must use a consistent source snapshot');
  assert.deepEqual(importEvidence.unresolved, []);
  assert.deepEqual(importEvidence.outOfScope, []);
  assert.deepEqual(importEvidence.graphs.runtime.cyclicScc, [], 'runtime cycles');
  assert.deepEqual(importEvidence.graphs.full.cyclicScc, [], 'cycles including type imports');
  for (const [file, dependencies] of graph) for (const dependency of dependencies) {
    if (graph.has(dependency)) continue;
    const imported = importEvidence.imports.find(edge => edge.from === file && edge.to === dependency && edge.resolution === 'external');
    const owner = policy.modules.find((module: { files: string[] }) => module.files.includes(file))?.id;
    assert.ok(imported && externalImportAllowed(imported, owner, policy.externalPolicy),
      `${file} imports missing or forbidden external module ${dependency}`);
  }
});

test('browser modules belong to real page entries or the generated worker, with separate publication boundaries', () => {
  const entries = ['public/index.html', 'public/love.html'].flatMap(file =>
    [...source(file).matchAll(/<script\b[^>]*src="\/(src\/[^"?]+)[^"]*"/g)].map(([, entry]) => entry));
  assert.deepEqual(entries.sort(), ['src/entry.ts', 'src/stories/vessel-of-love.ts']);
  assert.doesNotMatch(source('public/index.html'), /data-development/);
  const reachable = new Set();
  function visit(file: string) {
    if (reachable.has(file)) return;
    assert.ok(file.startsWith('src/') || file.startsWith('shared/'), `browser imports private code: ${file}`);
    reachable.add(file);
    for (const dependency of graph.get(file) || []) visit(dependency);
  }
  entries.forEach(visit);
  const pageReachable = new Set(reachable);
  const workers = [...source('scripts/offline-manifest.ts').matchAll(/new URL\(['"]\.\.\/(src\/[^'"]+)['"]\s*,\s*import\.meta\.url\)/g)].map(([,entry]) => entry);
  assert.deepEqual(workers, ['src/offline/service-worker.ts'], 'the compiled worker has a real build entry');
  workers.forEach(visit);
  assert.ok(!reachable.has(loadingGenerator), 'the loading illustration is prepared before browser execution');
  assert.deepEqual([...reachable].sort(), [...browserFiles].sort(), 'orphaned browser files need an owner or removal');
  for (const file of pageReachable) assert.equal(PUBLIC_FILES.get(file), file, `${file} must be served to source pages`);
  for (const file of reachable) if (!pageReachable.has(file)) assert.ok(!PUBLIC_FILES.has(file), `${file} belongs only in the compiled worker`);
  for (const file of PUBLIC_FILES.values()) {
    assert.ok(file.startsWith('src/') || file.startsWith('public/') || file.startsWith('shared/'), `private path exposed: ${file}`);
    assert.ok(fs.existsSync(path.join(root, file)), `stale public path: ${file}`);
    if (!file.startsWith('public/')) assert.ok(pageReachable.has(file), `unneeded public module: ${file}`);
  }
});

test('the loading illustration has explicit server and build owners and only pure geometry dependencies', () => {
  const owners = [...graph].filter(([, imports]) => imports.includes(loadingGenerator)).map(([file]) => file);
  assert.deepEqual(owners, ['server/http/public-files.ts']);
  assert.match(source('scripts/build-web.ts'), /await import\(pathToFileURL\(path\.join\(root, 'src\/scene\/loading-placeholder\.ts'\)\)\.href\)/,
    'the release build imports its requested source root, not browser execution');
  assert.ok(!PUBLIC_FILES.has(loadingGenerator));
  assert.ok(![...PUBLIC_FILES.values()].includes(loadingGenerator), 'no public alias exposes the generator');
  only(loadingGenerator, ['src/scene/geometry/', 'src/domain/']);
  const visited = new Set();
  function visit(file: unknown) {
    if (visited.has(file)) return;
    visited.add(file);
    pure(file);
    for (const dependency of graph.get(file)!) {
      assert.ok(['src/scene/geometry/', 'src/domain/', 'src/reference/'].some(prefix => dependency.startsWith(prefix)),
        `${file} must not bring browser or server state into loading geometry: ${dependency}`);
      visit(dependency);
    }
  }
  visit(loadingGenerator);
});

test('domain rules and packet contracts are pure and do not import presentation, storage or Node', () => {
  for (const file of files('src/domain')) { only(file, ['src/domain/', 'shared/']); pure(file); }
  for (const file of files('src/diagnostics')) { only(file, ['src/diagnostics/'], ['shared/client-report-contract.ts']); pure(file); }
  for (const file of files('shared')) { only(file, ['shared/']); pure(file); }
  const decoderDependencies = new Set();
  function visit(file: unknown) {
    if (decoderDependencies.has(file)) return;
    decoderDependencies.add(file);
    for (const dependency of graph.get(file)!) visit(dependency);
  }
  visit('shared/day-packets/decode.ts');
  assert.ok([...decoderDependencies].every(file => file.startsWith('shared/day-packets/') || file === 'shared/date-limits.ts'));
  assert.doesNotMatch(source('shared/day-packets/decode.ts'), /\b(?:encodeTransitDay|encodeNatalDay|encodeNumericColumn|compressDayPacket)\b/);
});

test('server separates HTTP, service policies, process adapters and private encoders', () => {
  // One declaration owns permitted edges, including narrow shared-value and package contracts.
  const boundary = checkContour({modules:policy.modules,files:importEvidence.nodes.map(node=>node.file),
    imports:importEvidence.imports,exceptions:policy.exactExceptions,valueContracts:policy.stableValueContracts,
    assets:policy.assets,externalPolicy:policy.externalPolicy});
  assert.deepEqual(boundary.violations, [], 'the live graph must obey declared owners and public boundaries');
  assert.ok(!graph.get('server/services/natal-days.ts')!.includes('server/services/transit-days.ts'));
  assert.ok(!graph.get('server/services/transit-days.ts')!.includes('server/services/natal-days.ts'));
  for (const file of [...files('server/services'), ...files('server/runtime'), ...files('server/packets'), ...files('server/storage'), ...files('server/mail')] as const) {
    assert.doesNotMatch(source(file), /\b(?:req|res)\s*\.|\bwriteHead\s*\(/, `${file} must not own an HTTP request`);
    assert.ok(![...PUBLIC_FILES.values()].includes(file), `${file} must remain private`);
  }
});

test('production isolates account, journal and cache storage and keeps enough time for API calculations', () => {
  const service = source('deploy/forma.service'), proxy = source('deploy/forma.nginx');
  assert.match(service, /^ProtectSystem=strict$/m);
  for (const owner of ['StateDirectory', 'LogsDirectory', 'CacheDirectory']) {
    assert.match(service, new RegExp('^' + owner + '=forma$', 'm'));
    assert.match(service, new RegExp('^' + owner + 'Mode=0700$', 'm'));
  }
  assert.match(service, /^CacheDirectoryMode=0700$/m);
  assert.match(service, /^Environment=TRANSIT_CACHE_DIR=\/var\/cache\/forma\/transit$/m);
  const server = source('server/server.ts');
  assert.match(server, /env\s*=\s*process\.env/);
  assert.match(server, /cacheDir:\s*env\.TRANSIT_CACHE_DIR/);
  const https = proxy.slice(proxy.indexOf('listen 443 ssl;'));
  const defaults = https.split(/\n    location /)[0]!;
  assert.match(defaults, /proxy_read_timeout 65s;/);
  for (const [, seconds] of https.matchAll(/proxy_read_timeout\s+(\d+)s;/g)) {
    assert.ok(Number(seconds) >= 65, 'A location must not shorten the inherited calculation timeout');
  }
});

test('layout and camera use measured inputs; geometry never imports rendering or gestures', () => {
  for (const file of ['src/scene/camera-fit.ts', 'src/scene/camera.ts'] as const) {
    only(file, ['src/scene/geometry/']);
    pure(file);
    assert.doesNotMatch(source(file), /\b(?:getBoundingClientRect|getScreenCTM|DOMPoint)\b/, `${file} must not measure the DOM`);
  }
  for (const file of files('src/scene/geometry')) {
    only(file, ['src/scene/geometry/', 'src/domain/', 'src/reference/']);
    pure(file);
  }
});


test('page layout owns placement without importing scene, feature state or views', () => {
  for (const file of files('src/ui/layout')) only(file, ['src/ui/layout/']);
  for (const file of ['src/ui/layout/studio.ts', 'src/ui/layout/metrics.ts'] as const) {
    pure(file);
    assert.doesNotMatch(source(file), /\b(?:getBoundingClientRect|getScreenCTM|DOMPoint)\b/);
  }
  for (const file of files('src/scene')) {
    assert.ok(!graph.get(file)!.some(dependency => dependency.startsWith('src/ui/layout/')), `${file} must not depend on page layout`);
  }
  for (const file of ['src/views/date-picker.ts', 'src/views/activation-popover.ts'] as const) {
    assert.doesNotMatch(source(file), /\bvisualViewport\b/, `${file} must receive the shared viewport port`);
  }
});

test('state and data do not depend on feature views, page layout or drawing', () => {
  for (const file of files('src/state')) only(file, ['src/state/', 'src/data/', 'src/domain/', 'src/runtime/shared-request.ts', 'shared/']);
  for (const file of files('src/data')) only(file, ['src/data/', 'src/domain/', 'src/runtime/shared-request.ts', 'shared/']);
  only('src/ui/studio-presentation.ts', []);
  pure('src/ui/studio-presentation.ts');
});
