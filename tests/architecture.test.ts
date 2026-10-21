import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_FILES } from '../server/http/public-files.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const files = (directory: string, pattern = /\.ts$/) => fs.readdirSync(path.join(root, directory), { recursive: true })
  .filter(file => pattern.test(file)).map(file => `${directory}/${file}`);
const loadingGenerator = 'src/scene/loading-placeholder.ts';
const sourceFiles = [...files('src'), ...files('shared')];
const hasRuntime = (file: string) => stripTypeScriptTypes(source(file), { mode: 'strip' }).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').trim();
const browserFiles = sourceFiles.filter(file => file !== loadingGenerator && hasRuntime(file));
const dependencies = (file: string) => [...stripTypeScriptTypes(source(file), { mode: 'strip' }).matchAll(/(?:from\s+|import\s*(?:\(\s*)?)['"]([^'"]+)['"]/g)]
  .map(([, specifier]) => specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)) : specifier);
const graph = new Map([...sourceFiles, ...files('server')].map(file => [file, dependencies(file)]));
for (const file of files('shared', /\.json$/)) { JSON.parse(source(file)); graph.set(file, []); }
const pure = (file: string) => assert.doesNotMatch(source(file), /\b(?:document|window|localStorage|sessionStorage|indexedDB)\s*\.|\bfetch\s*\(/, `${file} must stay pure`);
const only = (file: string, roots: string[], exact = []) => {
  for (const dependency of graph.get(file)!) assert.ok(exact.includes(dependency) || roots.some((prefix: string) => dependency.startsWith(prefix)), `${file} must not import ${dependency}`);
};

// Tests inspect both pages, not a hand-maintained list of module entry points.
test('production imports resolve and contain no dependency cycles', () => {
  const visited = new Set();
  function visit(file: unknown, ancestors = []) {
    assert.ok(!ancestors.includes(file), `Dependency cycle: ${[...ancestors, file].join(' → ')}`);
    if (visited.has(file)) return;
    visited.add(file);
    for (const dependency of graph.get(file)!) {
      if (dependency.startsWith('node:')) assert.ok(file.startsWith('server/'), `${file} must run in a browser`);
      else {
        assert.ok(graph.has(dependency), `${file} imports missing or non-production module ${dependency}`);
        visit(dependency, [...ancestors, file]);
      }
    }
  }
  for (const file of graph.keys()) visit(file);
});

test('all browser modules are reachable from real page entries and explicitly public', () => {
  const entries = ['public/index.html', 'public/love.html'].flatMap(file =>
    [...source(file).matchAll(/<script\b[^>]*src="\/(src\/[^"?]+)[^"]*"/g)].map(([, entry]) => entry));
  assert.deepEqual(entries.sort(), ['src/dev/account-preview.ts', 'src/dev/control-colors.ts', 'src/entry.ts', 'src/stories/vessel-of-love.ts']);
  assert.match(source('public/index.html'), /<script[^>]*data-development[^>]*src="\/src\/dev\/control-colors\.ts"/,
    'the temporary colour preview is an explicitly development-only page entry');
  assert.match(source('public/index.html'), /<script[^>]*data-development[^>]*src="\/src\/dev\/account-preview\.ts"/,
    'the account mockup is an explicitly development-only page entry');
  const reachable = new Set();
  function visit(file: unknown) {
    if (reachable.has(file)) return;
    assert.ok(file.startsWith('src/') || file.startsWith('shared/'), `browser imports private code: ${file}`);
    reachable.add(file);
    for (const dependency of graph.get(file) || []) visit(dependency);
  }
  entries.forEach(visit);
  assert.ok(!reachable.has(loadingGenerator), 'the loading illustration is prepared before browser execution');
  assert.deepEqual([...reachable].sort(), [...browserFiles].sort(), 'orphaned browser files need an owner or removal');
  for (const file of browserFiles) assert.equal(PUBLIC_FILES.get(file), file, `${file} must be served`);
  for (const file of PUBLIC_FILES.values()) {
    assert.ok(file.startsWith('src/') || file.startsWith('public/') || file.startsWith('shared/'), `private path exposed: ${file}`);
    assert.ok(fs.existsSync(path.join(root, file)), `stale public path: ${file}`);
    if (!file.startsWith('public/')) assert.ok(reachable.has(file), `unneeded public module: ${file}`);
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
  for (const file of files('src/diagnostics')) { only(file, ['src/diagnostics/']); pure(file); }
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
  for (const file of files('server/services')) only(file, ['node:', 'shared/', 'server/services/', 'server/runtime/', 'server/packets/']);
  for (const file of files('server/runtime')) only(file, ['node:', 'server/runtime/']);
  for (const file of files('server/packets')) only(file, ['node:', 'shared/day-packets/', 'server/packets/']);
  for (const file of files('server/http')) only(file, ['node:', 'shared/day-packets/', 'server/http/', 'server/services/'],
    file === 'server/http/public-files.ts' ? [loadingGenerator] : file === 'server/http/lifetime.ts' ? ['shared/lifetime-exact-format.ts'] : []);
  assert.ok(!graph.get('server/services/natal-days.ts')!.includes('server/services/transit-days.ts'));
  assert.ok(!graph.get('server/services/transit-days.ts')!.includes('server/services/natal-days.ts'));
  for (const file of [...files('server/services'), ...files('server/runtime'), ...files('server/packets')] as const) {
    assert.doesNotMatch(source(file), /\b(?:req|res)\s*\.|\bwriteHead\s*\(/, `${file} must not own an HTTP request`);
    assert.ok(![...PUBLIC_FILES.values()].includes(file), `${file} must remain private`);
  }
});

test('production cache is the only writable service directory and API timeout covers batch execution', () => {
  const service = source('deploy/forma.service'), proxy = source('deploy/forma.nginx');
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(service, /^CacheDirectory=forma$/m);
  assert.match(service, /^CacheDirectoryMode=0700$/m);
  assert.match(service, /^Environment=TRANSIT_CACHE_DIR=\/var\/cache\/forma\/transit$/m);
  assert.match(source('server/server.ts'), /cacheDir:\s*process\.env\.TRANSIT_CACHE_DIR/);
  assert.match(proxy, /location \/api\/\s*\{[^}]*proxy_read_timeout 65s;/);
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
  for (const file of files('src/state')) only(file, ['src/state/', 'src/data/', 'src/domain/', 'shared/']);
  for (const file of files('src/data')) only(file, ['src/data/', 'src/domain/', 'shared/']);
  only('src/ui/studio-presentation.ts', []);
  pure('src/ui/studio-presentation.ts');
});
