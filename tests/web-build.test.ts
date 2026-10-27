import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { buildWeb } from '../scripts/build-web.ts';
import { LOVE_GATES, renderLoveDiagram } from '../src/stories/vessel-of-love.ts';
import type { BinaryLike } from 'crypto';

const project = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes: NonSharedBuffer|BinaryLike) => createHash('sha256').update(bytes).digest('hex');

async function fileDigests(root: string) {
  const entries: string[][] = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else entries.push([path.relative(root, filename), digest(await fs.readFile(filename))]);
    }
  }
  await walk(root);
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

function moduleReferences(source: string) {
  assert.doesNotMatch(source, /\bimport\s*\(\s*[^"'\s]/, 'emitted dynamic imports have literal release dependencies');
  return [
    ...source.matchAll(/\b(?:from|import)\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map(match => match[1]);
}

function stylesheetReferences(source: string) {
  return [
    ...source.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g),
    ...source.matchAll(/@import\s*["']([^"']+)["']/g),
  ].map(match => match[1]);
}

async function syntheticBuildRoot(t: test.TestContext) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-web-build-fixture-'));
  t.after(() => fs.rm(temporary, {recursive: true, force: true}));
  const root = path.join(temporary, 'fixture');
  const files = {
    'package.json': '{"type":"module"}',
    'src/entry.ts': `if (typeof __FORMA_RELEASE__ === 'undefined' || !__FORMA_RELEASE__) {
      await import('./dev/control-colors.ts');
    }
    await import('./startup.ts');`,
    'src/startup.ts': 'globalThis.syntheticStartup = "ready";',
    'src/dev/control-colors.ts': 'import "./transitive.ts"; globalThis.syntheticDev = true;',
    'src/dev/transitive.ts': 'import "stand-only-unavailable-module";',
    'src/stories/vessel-of-love.ts': 'export const story = "synthetic story";',
    'src/scene/loading-placeholder.ts': `export function prepareLoadingPage(html) {
      return html.replace('<!-- chart-loading-placeholder -->', '<svg id="chartLoadingArt" class="synthetic-loading-art"></svg>');
    }`,
    'public/index.html': '<html><head><title>Stand title</title>\r\n  <link rel="icon" href="/favicon.svg">\r\n  <link rel="stylesheet" href="/styles.css">\r\n</head><body>\r\n<!-- chart-loading-placeholder -->\r\n  <button data-development id="syntheticDevButton">Stand</button>\r\n  <script type="module" data-development src="/src/dev/control-colors.ts"></script>\r\n  <script type="module" src="/src/entry.ts"></script>\r\n</body></html>',
    'public/love.html': '<html><head><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/love.css"></head><body>\r\n  <script type="module" src="/src/stories/vessel-of-love.ts"></script>\r\n</body></html>',
    'public/styles.css': 'body {color: #123456}',
    'public/love.css': 'body {color: #654321}',
    'public/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  };
  for (const [name, source] of Object.entries(files)) {
    const filename = path.join(root, name);
    await fs.mkdir(path.dirname(filename), {recursive: true});
    await fs.writeFile(filename, source);
  }
  return {root, temporary};
}

test('release compilation removes the entire stand graph before resolving its dependencies', async t => {
  const {root, temporary} = await syntheticBuildRoot(t);
  const before = await fileDigests(root), outdir = path.join(temporary, 'first'), repeat = path.join(temporary, 'repeat');
  const manifest = await buildWeb({root, outdir});
  const html = await fs.readFile(path.join(outdir, 'index.html'), 'utf8');
  assert.match(html, /class="synthetic-loading-art"/, 'loading art belongs to the requested root');
  assert.match(html, /<title>Stand title<\/title>/, 'building a release preserves the shell; runtime metadata names the environment');
  assert.doesNotMatch(html, /data-development|syntheticDevButton|control-colors/, 'CRLF pages remove stand elements');
  for (const entry of Object.values(manifest)) {
    if (!entry.file.endsWith('.js')) continue;
    const output = await fs.readFile(path.join(outdir, entry.file), 'utf8');
    assert.doesNotMatch(output, /__FORMA_RELEASE__|syntheticDev|stand-only-unavailable-module|control-colors|transitive/);
    moduleReferences(output);
  }
  assert.deepEqual(await fileDigests(root), before, 'the build never rewrites its source root');
  await buildWeb({root, outdir: repeat});
  assert.deepEqual(await fileDigests(repeat), await fileDigests(outdir), 'same sources produce identical compressed artifacts and manifests');
  assert.deepEqual(await fileDigests(root), before);
});

test('release compilation rejects a development module reached outside the conditional stand entry', async t => {
  const {root, temporary} = await syntheticBuildRoot(t);
  await fs.writeFile(path.join(root, 'src/startup.ts'), 'import "./dev/stand-connection.ts"; globalThis.syntheticStartup = "ready";');
  await fs.writeFile(path.join(root, 'src/dev/stand-connection.ts'), 'globalThis.syntheticDev = true;');
  await assert.rejects(buildWeb({root, outdir: path.join(temporary, 'release')}), /Development module in release: src\/dev\/stand-connection\.ts/);
});

test('release compilation includes the accepted random generator without a stand entry', async t => {
  const {root, temporary} = await syntheticBuildRoot(t), outdir = path.join(temporary, 'release');
  await fs.mkdir(path.join(root, 'src/views'));
  await fs.writeFile(path.join(root, 'src/views/random-chart.ts'), 'globalThis.syntheticRandomChart = true;');
  await fs.writeFile(path.join(root, 'src/startup.ts'), 'import "./views/random-chart.ts"; globalThis.syntheticStartup = "ready";');
  const manifest = await buildWeb({root, outdir});
  const modules = await Promise.all(Object.values(manifest).filter(entry => entry.file.endsWith('.js')).map(entry => fs.readFile(path.join(outdir,entry.file),'utf8')));
  assert.ok(modules.some(source => source.includes('syntheticRandomChart')), 'the regular startup reaches its random generator');
});

test('real release build produces complete compressed browser entries without development imports', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-web-build-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  // Read the canonical sources directly; only generated artifacts leave this root.
  const root = project, outdir = path.join(temporary, 'release');
  const manifest = await buildWeb({ root, outdir });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(outdir, 'manifest.json'), 'utf8')), manifest);
  assert.deepEqual(manifest.love, manifest['love.html'], 'the friendly story route resolves to its real HTML');

  const contents = new Map();
  for (const [route, entry] of Object.entries(manifest)) {
    assert.ok(!path.isAbsolute(entry.file) && !entry.file.split(/[\\/]/).includes('..'), route);
    const bytes = await fs.readFile(path.join(outdir, entry.file));
    contents.set(entry.file, bytes.toString());
    if (entry.file.endsWith('.js')) {
      moduleReferences(bytes.toString());
      assert.doesNotMatch(bytes.toString(), /__FORMA_RELEASE__|data-development|stand-connection-options|forma\.account-preview|calculationPreviewMode|shared-copy-options/);
    }
    assert.deepEqual(gunzipSync(await fs.readFile(path.join(outdir, entry.gzip))), bytes, `${route}: gzip bytes`);
    assert.deepEqual(brotliDecompressSync(await fs.readFile(path.join(outdir, entry.br))), bytes, `${route}: Brotli bytes`);
    assert.equal(entry.immutable, entry.file.startsWith('assets/'), `${route}: only versioned assets have immutable caching`);
  }

  assert.deepEqual([...contents.get('index.html').matchAll(/<title>([^<]+)<\/title>/g)].map(match => match[1]), ['Форма'], 'release title excludes the local version label');
  assert.doesNotMatch(contents.get('index.html'), /data-development|control-colors|account-preview|shared-chart-preview/, 'stand studies stay out of the release');
  assert.match(contents.get('index.html'), /id="toggleLoadingPreview"/);
  const compiled = [...contents].filter(([name]) => name.endsWith('.js')).map(([,text]) => text).join('\n');
  for (const token of ['toggleControlColors', 'chart-highlight-switch', 'forma.chart-highlight.v1', 'forma.loading-preview.v1']) {
    assert.ok(compiled.includes(token), `release includes the shared control: ${token}`);
  }
  assert.doesNotMatch(compiled, /forma\.account-preview|calculationPreviewMode|shared-copy-options|standConnection/);
  assert.match(contents.get('index.html'), /<button\b[^>]*id="randomChartButton"/, 'the regular random-card action survives release compilation');
  assert.match(contents.get('index.html'), /<svg id="chartLoadingArt"/, 'release contains the silhouette before JavaScript starts');
  assert.doesNotMatch(contents.get('index.html'), /<!-- chart-loading-placeholder -->/, 'the build resolves the loading illustration');
  const lifetimeChunk = [...contents].find(([name, source]) => name.endsWith('.js') && source.includes('/api/lifetime/meta'))?.[0];
  assert.ok(lifetimeChunk, 'the optional century view can be loaded on demand');
  assert.ok(!contents.get('index.html').includes(`href="/${lifetimeChunk}"`), 'ordinary startup never preloads the optional century view');
  const returnsChunk = [...contents].find(([name, source]) => name.endsWith('.js') && source.includes('returns-timeline-now'))?.[0];
  assert.ok(returnsChunk, 'the return event list remains available as a browser module');
  assert.ok(!contents.get('index.html').includes(`href="/${returnsChunk}"`), 'the return drawer is not downloaded before it opens');

  const knowledgeChunk = [...contents].find(([name, source]) => name.endsWith('.js') && source.includes('knowledge-connections'))?.[0];
  assert.ok(knowledgeChunk, 'the full knowledge dialog remains available on demand');
  assert.ok(!contents.get('index.html').includes(`href="/${knowledgeChunk}"`), 'startup never preloads the knowledge dialog or its articles');
  const articleChunks = [...contents].filter(([name, source]) => name.endsWith('.js') && source.includes('concept.personality-design'));
  assert.ok(articleChunks.length, 'all descriptions remain in the release');
  for (const [name] of articleChunks) assert.ok(!contents.get('index.html').includes(`/${name}`), 'no article-bearing chunk loads with the page');

  const resolve = (reference: string|URL, parent: string|undefined) => {
    const url = new URL(reference, `https://forma.test/${parent}`);
    assert.equal(url.origin, 'https://forma.test', `${parent} contains no external release dependency`);
    const filename = url.pathname.slice(1);
    assert.ok(manifest[filename], `${parent} → ${reference} must resolve through the public manifest`);
    assert.equal(manifest[filename].file, filename);
    return filename;
  };
  const entries = new Map(), reached = new Set();
  for (const page of ['index.html', 'love.html'] as const) {
    const html = contents.get(page);
    assert.ok(html, `${page} exists`);
    assert.equal(manifest[page].immutable, false, 'entry HTML must pick up future asset versions');
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(match => resolve(match[1], page));
    const links = [...html.matchAll(/<link\b[^>]*\bhref="([^"]+)"[^>]*>/g)].map(match => resolve(match[1], page));
    assert.equal(scripts.length, 1, `${page} has one executable browser entry`);
    assert.equal(links.filter(filename => filename.endsWith('.css')).length, 1, `${page} preserves its stylesheet`);
    assert.equal(links.filter(filename => filename.endsWith('.svg')).length, 1, `${page} preserves its icon`);
    entries.set(page, scripts[0]);
    const imported = new Set();
    function visitImports(filename: string) {
      for (const reference of moduleReferences(contents.get(filename))) {
        const dependency = resolve(reference, filename);
        if (imported.has(dependency)) continue;
        imported.add(dependency); visitImports(dependency);
      }
    }
    visitImports(scripts[0]);
    for (const filename of links.filter(filename => filename.endsWith('.js'))) {
      assert.ok(imported.has(filename), `${page} must not preload another page's UI`);
    }
    const queue = [...scripts, ...links];
    while (queue.length) {
      const filename = queue.pop();
      if (reached.has(filename)) continue;
      reached.add(filename);
      assert.match(filename, /^assets\/.+-[A-Za-z0-9]+\.(?:js|css|svg)$/, 'every fetched dependency is content-versioned');
      const source = contents.get(filename);
      assert.equal(typeof source, 'string', filename);
      const references = filename!.endsWith('.js') ? moduleReferences(source)
        : filename!.endsWith('.css') ? stylesheetReferences(source) : [];
      for (const reference of references) {
        if (reference.startsWith('data:') || reference.startsWith('#')) continue;
        queue.push(resolve(reference, filename));
      }
    }
  }
  for (const filename of contents.keys()) {
    if (filename.startsWith('assets/')) assert.ok(reached.has(filename), `${filename} is used by a release page`);
  }
  const recoveryEntry = contents.get(entries.get('index.html'));
  assert.doesNotMatch(recoveryEntry, /\bimport\s*(?:['"]|\{|\*)/, 'the release recovery entry has no fallible static dependencies');
  // Execute the real minified boundary with its startup chunk deliberately
  // absent. Static imports here would reject before recovery could run.
  const recoveryFile = path.join(temporary, 'recovery.mjs');
  await fs.writeFile(recoveryFile, recoveryEntry);
  const recovered = { shell: { dataset: {} as DOMStringMap, hidden: false, setAttribute() {} },
    chartLoadingMessage: {}, chartLoadingStatus: {}, chartLoadingRetry: { addEventListener(type, action) { this[type] = action; } } };
  const recoveryBody = { dataset: {}, append(node) { node.parentElement = this; } };
  const previousDocument = globalThis.document, previousLocation = globalThis.location;
  let recoveryReloads = 0;
  globalThis.document = { querySelector: () => recovered.shell, body: recoveryBody, getElementById: id => recovered[id] };
  globalThis.location = { reload() { recoveryReloads++; } };
  try {
    await import(pathToFileURL(recoveryFile).href);
    assert.equal(recovered.shell.hidden, true);
    assert.equal(recovered.chartLoadingMessage.parentElement, recoveryBody);
    assert.equal(recovered.chartLoadingStatus.textContent, 'Не удалось загрузить приложение');
    assert.equal(recovered.chartLoadingRetry.hidden, false);
    assert.equal(recoveryReloads, 0);
    recovered.chartLoadingRetry.click();
    assert.equal(recoveryReloads, 1);
  } finally {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    if (previousLocation === undefined) delete globalThis.location; else globalThis.location = previousLocation;
  }
  const startupChunk = moduleReferences(recoveryEntry).map(reference => resolve(reference, entries.get('index.html')))
    .find(filename => /\bconnectJournal\b/.test(contents.get(filename)));
  assert.ok(contents.get('index.html').includes(`href="/${startupChunk}"`), 'the new boundary does not defer downloading startup');
  const iconFile = [...reached].find(filename => filename.endsWith('.svg'));
  assert.deepEqual(await fs.readFile(path.join(outdir, iconFile)), await fs.readFile(path.join(root, 'public/favicon.svg')));

  // Execute an actual entry and its extracted shared module, rather than merely
  // checking that minified text parses or that a synthetic function survived.
  await fs.writeFile(path.join(outdir, 'package.json'), '{"type":"module"}\n');
  const story = await import(pathToFileURL(path.join(outdir, entries.get('love.html'))));
  assert.deepEqual(story.LOVE_GATES, LOVE_GATES);
  assert.equal(story.renderLoveDiagram(), renderLoveDiagram(), 'the compiled chart renderer retains exact SVG geometry, gate labels, paint and selections');
});


test('release builds a root worker containing the exact public file hashes and no source URLs', async t => {
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'forma-offline-build-'));
 t.after(()=>fs.rm(temporary,{recursive:true,force:true}));
 const manifest=await buildWeb({root:project,outdir:temporary});
 assert.ok(manifest['service-worker.js'],'worker is an explicit public artifact');
 assert.equal(manifest['service-worker.js'].immutable,false);
 const source=await fs.readFile(path.join(temporary,'service-worker.js'),'utf8');
 assert.doesNotMatch(source,/__FORMA_OFFLINE_MANIFEST__|\.ts["']/);
 const html=await fs.readFile(path.join(temporary,'index.html'),'utf8');
 const version=/<body\b[^>]* data-offline-version="([a-f0-9]{64})"/.exec(html)?.[1];
 assert.ok(version,'HTML identifies its actual built files, not the currently active worker');
 assert.ok(source.includes(version),'HTML and offline manifest have the same version');
 for(const entry of new Map(Object.values(manifest).map(entry=>[entry.file,entry])).values()){
  if(entry.file==='service-worker.js')continue;
  const bytes=await fs.readFile(path.join(temporary,entry.file));
  assert.ok(source.includes(digest(bytes)),entry.file+' content is checked by the worker');
 }
});


test('offline identity is deterministic and its stamped HTML stays inside integrity verification',async()=>{
 const {buildOfflineWorker}=await import('../scripts/offline-manifest.ts');
 const {normalizeAppMetadata}=await import('../shared/app-metadata.ts');
 const outputs=new Map([['index.html',Buffer.from('<html><body><main>Forma</main></body></html>')]]);
 const first=await buildOfflineWorker(outputs),again=await buildOfflineWorker(outputs);
 const html=Buffer.from(first.html).toString();
 assert.equal(first.manifest.version,again.manifest.version);
 assert.deepEqual(first.html,again.html);
 assert.equal(outputs.get('index.html')!.toString().includes('data-offline-version'),false);
 assert.match(html,new RegExp('data-offline-version="'+first.manifest.version+'"'));
 const shell=first.manifest.files.find(file=>file.url==='/index.html')!;
 assert.equal(shell.sha256,digest(first.html));assert.equal(shell.bytes,first.html.byteLength);
 assert.equal(normalizeAppMetadata(html),html,'Build identity cannot be stripped as runtime HTTP metadata');
 const changed=new Map(outputs);changed.set('index.html',Buffer.from('<html><body><main>Other</main></body></html>'));
 assert.notEqual((await buildOfflineWorker(changed)).manifest.version,first.manifest.version);
});
