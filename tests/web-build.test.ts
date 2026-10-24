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

test('real release build preserves sources and produces complete deterministic compressed browser entries', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-web-build-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'source');
  await fs.mkdir(root);
  // Use the real browser graph while isolating this test from concurrent work
  // and ensuring the build never edits or publishes the working project.
  for (const directory of ['src', 'shared', 'public'] as const) {
    await fs.cp(path.join(project, directory), path.join(root, directory), { recursive: true });
  }
  await fs.copyFile(path.join(project, 'package.json'), path.join(root, 'package.json'));
  // A Windows checkout must produce the same public routes and exclude dev entries.
  for (const page of ['index.html', 'love.html']) {
    const file = path.join(root, 'public', page);
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(/\r?\n/g, '\r\n'));
  }
  // An independent snapshot must provide both its chart and its loading art.
  const placeholder = path.join(root, 'src/scene/loading-placeholder.ts');
  await fs.writeFile(placeholder, (await fs.readFile(placeholder, 'utf8')).replace('loading-centers', 'loading-centers-from-root'));
  const before = await fileDigests(root);
  const outdir = path.join(temporary, 'first'), repeat = path.join(temporary, 'repeat');
  const manifest = await buildWeb({ root, outdir });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(outdir, 'manifest.json'), 'utf8')), manifest);
  assert.deepEqual(await fileDigests(root), before, 'building preserves every source, stylesheet, icon and source HTML byte');
  assert.deepEqual(manifest.love, manifest['love.html'], 'the friendly story route resolves to its real HTML');

  const contents = new Map();
  for (const [route, entry] of Object.entries(manifest)) {
    assert.ok(!path.isAbsolute(entry.file) && !entry.file.split(/[\\/]/).includes('..'), route);
    const bytes = await fs.readFile(path.join(outdir, entry.file));
    contents.set(entry.file, bytes.toString());
    assert.deepEqual(gunzipSync(await fs.readFile(path.join(outdir, entry.gzip))), bytes, `${route}: gzip bytes`);
    assert.deepEqual(brotliDecompressSync(await fs.readFile(path.join(outdir, entry.br))), bytes, `${route}: Brotli bytes`);
    assert.equal(entry.immutable, entry.file.startsWith('assets/'), `${route}: only versioned assets have immutable caching`);
  }

  assert.deepEqual([...contents.get('index.html').matchAll(/<title>([^<]+)<\/title>/g)].map(match => match[1]), ['Форма'], 'release title excludes the local version label');
  assert.doesNotMatch(contents.get('index.html'), /data-development|randomChartButton|control-colors|account-preview|shared-chart-preview/, 'stand studies stay out of the release');
  assert.match(contents.get('index.html'), /<svg id="chartLoadingArt"/, 'release contains the silhouette before JavaScript starts');
  assert.match(contents.get('index.html'), /class="loading-centers-from-root"/, 'loading art comes from the requested source root');
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
  const recoveryBody = { append(node) { node.parentElement = this; } };
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
  const startupChunk = moduleReferences(recoveryEntry).map(reference => resolve(reference, entries.get('index.html')))[0];
  assert.ok(contents.get('index.html').includes(`href="/${startupChunk}"`), 'the new boundary does not defer downloading startup');
  const iconFile = [...reached].find(filename => filename.endsWith('.svg'));
  assert.deepEqual(await fs.readFile(path.join(outdir, iconFile)), await fs.readFile(path.join(root, 'public/favicon.svg')));

  await buildWeb({ root, outdir: repeat });
  assert.deepEqual(await fileDigests(repeat), await fileDigests(outdir), 'a second build in another directory has identical names, imports, manifest and compressed bytes');
  assert.deepEqual(await fileDigests(root), before);

  // Execute an actual entry and its extracted shared module, rather than merely
  // checking that minified text parses or that a synthetic function survived.
  await fs.writeFile(path.join(outdir, 'package.json'), '{"type":"module"}\n');
  const story = await import(pathToFileURL(path.join(outdir, entries.get('love.html'))));
  assert.deepEqual(story.LOVE_GATES, LOVE_GATES);
  assert.equal(story.renderLoveDiagram(), renderLoveDiagram(), 'the compiled chart renderer retains exact SVG geometry, gate labels, paint and selections');
});
