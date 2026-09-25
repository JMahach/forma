import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_FILES } from '../server/public-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const files = directory => fs.readdirSync(path.join(root, directory), { recursive: true })
  .filter(file => /\.(?:js|mjs)$/.test(file)).map(file => `${directory}/${file}`);
const browserFiles = files('src');
const dependencies = file => [...source(file).matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)]
  .map(([, specifier]) => specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)) : specifier);
const graph = new Map([...browserFiles, ...files('server')].map(file => [file, dependencies(file)]));

test('production imports resolve and contain no dependency cycles', () => {
  const visited = new Set();
  function visit(file, ancestors = []) {
    assert.ok(!ancestors.includes(file), `Dependency cycle: ${[...ancestors, file].join(' → ')}`);
    if (visited.has(file)) return;
    visited.add(file);
    for (const dependency of graph.get(file)) {
      if (dependency.startsWith('node:')) {
        assert.ok(file.startsWith('server/'), `${file} must run in a browser`);
      } else {
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
  assert.deepEqual(entries.sort(), ['src/app.js', 'src/stories/vessel-of-love.js']);
  const reachable = new Set();
  function visit(file) {
    if (reachable.has(file)) return;
    reachable.add(file);
    for (const dependency of graph.get(file) || []) visit(dependency);
  }
  entries.forEach(visit);
  assert.deepEqual([...reachable].sort(), [...browserFiles].sort(), 'orphaned browser files need an owner or removal');
  for (const file of browserFiles) assert.equal(PUBLIC_FILES.get(file), file, `${file} must be served`);
  for (const file of PUBLIC_FILES.values()) {
    assert.ok(file.startsWith('src/') || file.startsWith('public/'), `private path exposed: ${file}`);
    assert.ok(fs.existsSync(path.join(root, file)), `stale public path: ${file}`);
  }
});

test('domain and packet math stay below presentation; day services share transport, not each other', () => {
  for (const file of [...files('src/domain'), 'src/transit/day-packet.js', 'src/transit/chart-day-packet.js', 'src/bodygraph/mandala-cross.js']) {
    for (const dependency of graph.get(file)) assert.ok(dependency.startsWith('src/domain/'), `${file} imports presentation: ${dependency}`);
    assert.doesNotMatch(source(file), /\b(?:document|window|localStorage)\s*\.|\bfetch\s*\(/, `${file} must stay pure`);
  }
  assert.ok(!graph.get('server/chart-days.mjs').includes('server/transit-days.mjs'));
  assert.ok(!graph.get('server/transit-days.mjs').includes('server/chart-days.mjs'));
  for (const file of ['server/day-worker.mjs', 'server/day-compression.mjs', 'server/content-encoding.mjs']) {
    assert.ok(graph.get(file).every(dependency => dependency.startsWith('node:')), `${file} must not import a feature service`);
  }
});

test('production cache is the only writable service directory and API timeout covers batch execution', () => {
  const service = source('deploy/forma.service'), proxy = source('deploy/forma.nginx');
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(service, /^CacheDirectory=forma$/m);
  assert.match(service, /^CacheDirectoryMode=0700$/m);
  assert.match(service, /^Environment=TRANSIT_CACHE_DIR=\/var\/cache\/forma\/transit\/v1$/m);
  assert.match(source('server/server.mjs'), /cacheDir:\s*process\.env\.TRANSIT_CACHE_DIR/);
  assert.match(proxy, /location \/api\/\s*\{[^}]*proxy_read_timeout 65s;/);
});
